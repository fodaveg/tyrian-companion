# RT-14 / DU-12: candado de vida con dos procesos de Hebra en macOS, 11 oct 2026

Máquina: Mac (Apple Silicon), macOS 27.0.1 (build 26A434), Safari 27.0.1, WebKit.framework
22625.1.29.11.28, Swift 6.4. Hebra instalada: 0.2.0 build 150 (`net.fodaveg.hebra`, sandbox de Mac App Store),
que es la de David y no se lanzó. Medición del 11 oct, 12:01 a 12:09. Solo medición: no se escribió en ningún
repo salvo este fichero. Lo LEÍDO de Hebra viene de `85f9b384` (`origin/main` local de `~/code/hebra`, el que
prepara macOS 150) y, para la API de plugins 1.5, de `e1975217` (`main` de GitHub, leído con `gh api`); los dos
en solo lectura, sin `fetch`, `checkout` ni build.

**Resultado: los Web Locks de WKWebView NO cruzan procesos en macOS (MEDIDO, sonda propia sobre el WebKit del
sistema). Hebra de macOS SÍ tiene candado de instancia: un `flock` sobre `instancia.lock` en el directorio de
datos del contenedor, cogido por la Hebra viva de David (LEÍDO en el código y MEDIDO en el descriptor abierto), pero
la API lo declara «no garantizado» (`api.has('instance.lock')` es `false` en macOS a propósito). Tras un SIGKILL,
un proceso reabierto tiene libre el candado de la muerta en 0-1 ms de espera (primera concesión a +412-624 ms del
SIGKILL, contando arranque y carga de la página), y el `flock` se libera en ~1 ms (MEDIDO). No se construyó una
Hebra de prueba: el punto 2 sobre Hebra queda LEÍDO/INFERIDO.**

Convención: MEDIDO es lo observado en un proceso real; LEÍDO, lo que dice el código; INFERIDO, lo que se
deduce de ambos.

## 1. ¿Dos procesos sobre el mismo almacén ven el Web Lock del otro?

**No: el candado es de cada proceso de interfaz (MEDIDO).** Sonda propia en Swift (ver «Cómo se aisló la
prueba»): página cargada con `loadHTMLString` y `baseURL` `https://probe.local/` (origen `https://probe.local`,
`isSecureContext` = `true`), `document.visibilityState` = `visible` en todas las medidas.

| Montaje | Resultado |
|---|---|
| Dos procesos, `WKWebsiteDataStore(forIdentifier:)` con el mismo UUID (3 repeticiones) | H toma `tyrian-companion-lease:wl1:prueba-<n>` y lo retiene. W, otro proceso, con `ifAvailable`: `free`; `query().held` = `[]`; la petición bloqueante de W se concede con 0-1 ms de espera mientras H sigue vivo con el candado |
| Mismo montaje, almacenamiento | Es el mismo: W lee en IndexedDB y en `localStorage` la marca aleatoria que acaba de escribir H (`marca-dab003b1`, `marca-7cfe2037`, `marca-46c38ba6`) |
| Dos procesos, `WKWebsiteDataStore.default()` (el que usa Hebra, ver abajo; 2 repeticiones) | Igual: `free`, `query().held` = `[]`, concesión sin espera. IndexedDB compartido (W lee la marca de H); `localStorage` no: W lee `null` |
| Control positivo: dos `WKWebView` en un proceso, mismo almacén (4 repeticiones) | Cada vista en su propio `com.apple.WebKit.WebContent` (PID distintos). A retiene; B con `ifAvailable`: `held`, y `query().held` lo lista. La petición bloqueante de B espera hasta que A muere |

WebKit en macOS comparte los candados entre las vistas de un mismo proceso de interfaz (también entre procesos
WebContent distintos) y no entre procesos de interfaz, igual que WebKitGTK en Linux. Compartir el almacén en disco
(IndexedDB) no hace que se compartan los candados.

## 2. ¿Hebra de macOS deja abrir dos procesos sobre la misma biblioteca?

**Por el código, no, salvo en dos casos estrechos (LEÍDO). No MEDIDO en una Hebra de prueba: no se construyó (ver
«Por qué no se construyó Hebra»).** Rutas y líneas de `fodaveg/hebra` `85f9b384` salvo donde se diga.

### El plugin `tauri-plugin-single-instance` no se registra en macOS (LEÍDO)

- `src-tauri/Cargo.toml:91` lo trae (`=2.4.2`, feature `deep-link`), pero `single_instance_plugin()` está bajo
  `#[cfg(any(target_os = "linux", windows))]` (`src-tauri/src/lib.rs:450-451`) y solo se registra en Windows
  (`lib.rs:509-511`) y en Linux (`lib.rs:516-517`).
- Motivo, en la cabecera de `src-tauri/src/macos_single_instance.rs:1-6` y `lib.rs:479-480`: en macOS el plugin
  usa un socket fijo en `/tmp`, fuera del contenedor del App Sandbox. En su lugar Hebra usa LaunchServices y un
  cerrojo propio.

### Qué hace un segundo arranque en macOS (LEÍDO)

`run()` (`lib.rs:460-505`), antes de crear el `Builder` y de abrir nada:

1. `macos_single_instance::wait_for_exiting_instance` (`lib.rs:466-477`): si una Hebra anterior tiene
   `salida.lock` (está saliendo), espera a que muera, con techo de 15 s (`PREDECESSOR_EXIT_CEILING`,
   `macos_single_instance.rs:143`); pasado el techo, sale sin abrir la biblioteca.
2. `macos_single_instance::forward_to_existing` (`lib.rs:483-495`, `macos_single_instance.rs:725-825`): pide el
   **cerrojo de instancia**, un `flock` exclusivo y sin espera sobre
   `<HOME>/Library/Application Support/<identificador>/instancia.lock` (`INSTANCE_LOCK_FILE`, `:138`;
   `claim_instance_at`, `:370-402`; `startup_role`, `:575-588`). Quien lo consigue lo guarda en un `static` toda la
   vida del proceso (`INSTANCE_LOCK`, `:571`); lo suelta el núcleo al morir. Después mira la lista de
   LaunchServices (`NSRunningApplication::runningApplicationsWithBundleIdentifier`, `:744`) y decide con
   `next_step` (`:445-520`):
   - `Holder` (tiene el cerrojo): abre la biblioteca solo con la lista vacía; a una Hebra ya abierta que no tenga
     el cerrojo le reenvía el arranque y sale;
   - `Behind` (lo tiene otro proceso vivo): **nunca** abre la biblioteca; reenvía a la abierta por
     `NSWorkspace.openApplication` o se retira;
   - `Unknown` (no se pudo abrir el fichero o `flock` dio un error raro): el camino anterior al 7 oct, solo con la
     lista de LaunchServices.

El cerrojo de instancia en macOS es del commit `475f21a1` («fix(macos): dos arranques simultáneos dejan
exactamente una Hebra abierta», 7 oct 2026), antecesor de `85f9b384`.

### `open -n` y el binario lanzado directo (LEÍDO e INFERIDO)

No hay en el código ningún camino propio para `open -n` o para ejecutar `Contents/MacOS/hebra` a mano: los dos
pasan por el mismo `run()`. Con el bundle publicado, `NSBundle.mainBundle().bundleIdentifier()` es
`net.fodaveg.hebra` en los dos casos y coincide con `config.identifier` (`:730-735`), y el sandbox redirige `HOME`
al mismo contenedor (`home_directory`, `:190-193`), así que el segundo proceso pide el MISMO `instancia.lock`, lo
encuentra cogido (`Behind`) y no abre la biblioteca (INFERIDO; no medido para no lanzar la Hebra de David).

Dos procesos vivos sobre la misma biblioteca solo son posibles (LEÍDO):

- **Ejecutable sin bundle** o con un identificador de bundle distinto del de la configuración: `forward_to_existing`
  devuelve `Ok(false)` en el acto (`:730-735`) y arranca sin cerrojo ni lista. Es el caso de `target/debug/hebra`
  de desarrollo, no de la app publicada. La cabecera del módulo lo dice (`:5-6` y «Lo que este cerrojo NO
  cubre», `:95-97`).
- **`Role::Unknown`**: el fichero no se puede abrir o `flock` falla con algo que no es «ocupado». Entonces queda
  solo la lista de LaunchServices, que con dos arranques en frío simultáneos puede no ver al otro a tiempo
  (INFERIDO de `next_step`, `:450-454`).

### La Hebra de David tiene el cerrojo (MEDIDO, sin tocarla)

- `strings` sobre `/Applications/Hebra.app/Contents/MacOS/hebra` (build 150) da `instancia.lock`, `salida.lock` y
  «La instancia anterior de Hebra sigue cerr[ándose]»: el cerrojo está compilado en el binario instalado.
- `lsof -p 63345` (solo lectura del núcleo) enseña el descriptor `3u` abierto sobre
  `~/Library/Containers/net.fodaveg.hebra/Data/Library/Application Support/net.fodaveg.hebra/instancia.lock`, de 5
  bytes: lo que mide escrito el PID `63345` (`claim_instance_at` escribe el PID al conseguirlo). `lsof` de macOS no
  enseña los `flock`, así que que lo tenga COGIDO es INFERIDO (el descriptor solo se conserva tras conseguirlo,
  `:388-396`). Está junto a `library-v1/hebra.sqlite3`: es por biblioteca del contenedor.

### Por qué `api.has('instance.lock')` es `false` fuera de Linux (LEÍDO, `main` de GitHub `e1975217`)

- La función nace en `8abc162a` («feat(plugin-api): 1.5.0, api.has('instance.lock')…», 11 oct 2026), posterior a
  `85f9b384`. `packages/plugin-api/src/index.ts:69-82` la documenta y la añade a `PLUGIN_HOST_FEATURES`.
- La decide `hostFeatureAvailable` en `src/lib/plugins/api/capabilities.ts:113-117`:
  `feature === 'instance.lock' ? platform === 'linux' : true`; `create-plugin-api.ts:347` la usa en `has()`. Es una
  decisión de TypeScript por plataforma, no un reflejo de qué está compilado en Rust.
- El JSDoc de `hostFeatureAvailable` y `docs/SPEC-PLUGINS-EXTERNOS.md` (en ese commit) dan el motivo: macOS tiene
  un cerrojo parecido pero «no es una garantía», porque sin poder abrir el fichero cae a la lista de LaunchServices
  (`Role::Unknown`) y los ejecutables sin bundle no pasan por él. `false` significa «no garantizado», no «hay dos
  procesos».
- El `flock` de Linux (`linux_single_instance.rs`, `#[cfg(target_os = "linux")]`, `lib.rs:74-75`) y el de macOS
  (`macos_single_instance.rs`, `#[cfg(target_os = "macos")]`, `lib.rs:18-20`) son módulos distintos, cada uno
  compilado solo en su sistema, con el mismo nombre de fichero. No es que el de Linux esté solo en Linux y macOS no
  tenga ninguno.

## 3. SIGKILL al proceso que tiene el candado

**El candado de la muerta está libre en cuanto el nuevo proceso puede pedirlo (MEDIDO).** Las marcas son del
reloj del proceso que observa (Swift, `Date()` al recibir el mensaje de la página) y del orquestador al mandar el
SIGKILL, no de temporizadores de la página. El `jsT` de la página (`performance.timeOrigin + now()`) solo tiene
resolución de 1 ms y se usó como contraste.

| Paso tras el SIGKILL del proceso H que tiene el candado | Tiempo |
|---|---|
| Arranca un proceso nuevo R sobre el mismo almacén | +7 a +10 ms (lo lanza el orquestador) |
| R termina de cargar la página | +554 a +586 ms (`forIdentifier`) |
| `navigator.locks.request(<candado de H>)` de R, bloqueante y sin `ifAvailable` | concedido a +560, +575 y +624 ms (`forIdentifier`), +412 y +461 ms (`default()`), con 0-1 ms de espera desde que se pidió; antes, su `ifAvailable` daba `free` y `query().held` = `[]` |
| Dentro de un proceso: SIGKILL al `WebContent` de la vista A que lo tiene; la petición bloqueante que esperaba en B | +2,5, +2,3, +0,8 y +1,0 ms (4 repeticiones); `webViewWebContentProcessDidTerminate` de A llega a la vez |
| `flock(LOCK_EX)` bloqueante sobre un fichero en APFS (mismo volumen de datos), dueño matado con SIGKILL | +0,9, +1,0 y +1,3 ms; antes del SIGKILL el `LOCK_NB` daba ocupado |

Como en Linux, el proceso nuevo empieza con un registro de candados vacío: el candado del muerto no existe en él,
así que nunca está «tomado». Lo que pesa es el arranque del proceso y la carga de la página, no el candado.

Para Hebra en macOS (INFERIDO de lo anterior y del punto 2): tras un SIGKILL, el núcleo suelta `instancia.lock` y
`salida.lock` en ~1 ms, una Hebra reabierta pasa a `Holder` sin esperar, y Tyrian tiene su candado de vida libre
en cuanto su página lo pide. El tiempo total lo marca el arranque de Hebra, no medido aquí.

**No medido:** que Tyrian TOME el arriendo de sesión en Hebra de macOS ni los eventos `life_lock_*`; mismas razones
que en Linux (hace falta una sesión con clave de GW2).

## 4. Obsidian

**No medido, a propósito.** Una segunda instancia de Obsidian puede quitarle el socket del CLI a la Obsidian de
David (incidente conocido en Fedora) y no se arriesga su bóveda.

## ¿Basta el candado de vida en macOS?

**INFERIDO de 1, 2 y 3:** el caso que temía el código (dos Hebras vivas que ven libre el candado de la otra) es real
en la capa WebKit, pero Hebra de macOS publicada no lo deja ocurrir en uso normal: el `flock` de `instancia.lock`
más la lista de LaunchServices mantienen un solo proceso por contenedor, y el segundo arranque reenvía y sale. El
riesgo residual es el mismo que en Linux y estrecho: cerrojo inutilizable (`Unknown`) con dos arranques
simultáneos, o un ejecutable sin bundle (desarrollo). Ahí solo protege la regla de los 15 s de Tyrian. Que la API
diga `false` en macOS es conservador, no la ausencia de candado.

## Cómo se aisló la prueba

- **Sonda propia en Swift** (101 líneas, no se adjunta), compilada con `swiftc` en el directorio temporal de la
  sesión, fuera de cualquier repo, como `tyrian-sonda-candado`. `NSApplication` con política `.accessory` (sin
  icono en el Dock), ventana sin borde en (-4000, -4000) y detección de oclusión de `WKWebView` apagada. Roles:
  `hold` (escribe una marca en IndexedDB y `localStorage` y retiene el candado con una promesa que no se resuelve),
  `peek` (lee la marca, `ifAvailable`, `query()` y luego pide el candado bloqueante) y `both` (dos vistas en un
  proceso; el propio proceso mata con SIGKILL el `WebContent` de A tras comprobar con `proc_pidpath` que es
  `com.apple.WebKit.WebContent` y que no es el de B). La página manda los resultados por
  `WKScriptMessageHandler`; la salida es una línea JSON por evento.
- Almacén: `WKWebsiteDataStore(forIdentifier:)` con un UUID nuevo por tanda, o `WKWebsiteDataStore.default()`.
  Para un ejecutable sin bundle WebKit los pone en `~/Library/WebKit/tyrian-sonda-candado/`: nada cae en
  `~/Library/Containers/net.fodaveg.hebra` ni en `Application Support/net.fodaveg.hebra*`. Hebra no fija
  `data_store_identifier` (LEÍDO: ni en `src-tauri/src` ni en la configuración), así que usa el almacén por
  defecto de su contenedor; de ahí la tanda con `default()`.
- Orquestador en Python (`python3 -I`): lanza los procesos, guarda sus PID y solo mata esos, comprobando antes
  con `ps -o comm=` que el nombre es `tyrian-sonda-candado`. Al acabar, `pgrep` no encuentra ninguno.
- `flock`: dos procesos Python sobre un fichero del directorio temporal.

### Por qué no se construyó Hebra

Las condiciones de partida se cumplían (`pgrep` sin `cargo`, `rustc` ni `xcodebuild`; 95 GiB libres), pero no se
intentó:

- Para recorrer el camino de macOS hace falta un `.app` con bundle, firma con `com.apple.security.app-sandbox` e
  identificador igual al de su configuración: un ejecutable sin bundle se salta el cerrojo (punto 2) y no mediría
  nada.
- Ese `.app`, al lanzarse, se registra en LaunchServices con los esquemas de `deep-link` de la configuración
  (`hebra://`), y podría quedarse con los enlaces de la Hebra de David. No se verificó qué más recursos fuera del
  contenedor toca (llavero, grupos de apps).
- Exige además instalar las dependencias del frontend (`pnpm install`) y una build de Rust en release: una
  instalación y una build pesadas para una sesión de medición.

Faltaría, para MEDIRLO: copia de `git archive` de `hebra` en un directorio temporal con `CARGO_TARGET_DIR`
propio; identificador `net.fodaveg.hebra.sonda-plugins` y sin esquemas de `deep-link` (o con uno propio); firma
ad hoc con sandbox; lanzar una, luego `open -n` y el binario directo, y comprobar que el segundo no abre
`hebra.sqlite3` (`lsof`) y que solo uno tiene `instancia.lock`; SIGKILL al primero y medir cuándo abre la base el
siguiente.

## Constancia: la Hebra de David no se tocó

- Su PID 63345 (`/Applications/Hebra.app/Contents/MacOS/hebra`, arrancado el 11 oct a las 08:19:08) estaba vivo
  al empezar (12:01:40) y al cerrar (12:09:14). Antes y después tenía abierto `instancia.lock` (`lsof`).
- Mtime y tamaño, solo con `stat`, iguales antes y después, bajo
  `~/Library/Containers/net.fodaveg.hebra/Data/Library/Application Support/net.fodaveg.hebra/`:
  - `library-v1/hebra.sqlite3`: 1791708574.409677131, 148721664;
  - `library-v1/hebra.sqlite3-wal`: 1791709175.911845564, 52583592;
  - `library-v1/hebra.sqlite3-shm`: 1791699557.584026392, 131072;
  - `fresh-v1/hebra.sqlite3`, `-wal`, `-shm`: sin cambios (1790480624.419210892 / 61440;
    1790480624.439467760 / 0; 1790830097.497790666 / 32768).
- No se lanzó `/Applications/Hebra.app` de ninguna forma, ni se abrió ningún fichero de su contenedor. Ningún
  proceso de la prueba usó `net.fodaveg.hebra` como identificador. No se tocó Obsidian.

## Limpieza y límites

Se borraron `~/Library/WebKit/tyrian-sonda-candado` (2,2 MB, los almacenes de la sonda),
`~/Library/Caches/tyrian-sonda-candado`, los dos informes de fallo de la sonda (dos arranques del primer intento
murieron con `NSUnknownKeyException` al apagar la oclusión por KVC; se cambió a selector) y el directorio temporal
con la sonda, el orquestador y el fichero del `flock`. No se instaló nada ni se compiló nada salvo la sonda. Espacio
libre (`df`): 95 GiB al empezar y 87 GiB al cerrar; la bajada no es de esta sesión (lo suyo fueron ~2 MB), es de
otros procesos de la máquina.

No medido: Hebra de macOS real con dos procesos (punto 2 queda LEÍDO/INFERIDO), el tiempo de arranque de Hebra tras
un SIGKILL, Tyrian tomando el arriendo de sesión con clave, iOS y Obsidian.
