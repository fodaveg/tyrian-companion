# Audit 1 de 5: evidencia de ejecución en hosts reales

- Fecha: 2026-10-10. Repo `~/code/tyrian-companion`, `main` = `6fbe77e`, árbol limpio.
- Máquina del audit: Mac (Darwin), Obsidian 1.12.7 (Electron 39.8.3), Hebra macOS 0.2.0 build 149.
- Alcance: QA manual (`docs/QA-MVP.md`), «sin verificar» de `docs/ESTADO.md` (0.6.21 a 0.6.24 y la deuda), `docs/BETA.md`, `AGENTS.md`, los scripts `verify-beta-runtime`, `install-beta`, `dev-install`, `smoke-live`, `prepare-beta-artifact` y sus tests, `.github/workflows/release.yml`, el arranque de `src/host/` y el estado instalado en los hosts del Mac (solo metadatos y hashes de ficheros).
- Comandos: `grep`/`rg`/`sed`/`git log`/`git tag`; `gh release view 0.6.24 --json assets`; `shasum -a 256` de los ficheros instalados; `defaults read` de los `Info.plist`; `ps -axo pid,lstart,comm`; `node -e` para contar el `debug.jsonl` del vault del Mac y leer tres campos de `data.json` (`schemaVersion`, `debugLoggingEnabled`, `debugLoggingLevel`); `sqlite3 "file:…?immutable=1"` para leer solo el nombre de las bases IndexedDB de Hebra. No corrí ningún test, ni build, ni `obsidian eval`, ni toqué ningún Obsidian o Hebra vivo. Un intento de copiar la base de diagnóstico de Hebra para leer su registro fue denegado por el clasificador de permisos y no lo repetí (ver RT-18).

## Resumen

El bloqueo de la v1 es real, pero es más barato de lo que dice `ESTADO.md`. La 0.6.24 ya está instalada esta mañana en los dos hosts del Mac, idéntica byte a byte a la release, y nadie lo ha anotado. Falta ver que carga. La carga en Obsidian se puede automatizar hoy: un agente ya lo hizo el 2 oct sobre la 0.2.17 y no se ha repetido en 25 releases de canal. Dos herramientas no miden lo que prometen: el único test que ejecuta el `hebra-main.mjs` publicado se salta en CI y en el workflow de release, y el plan para comprobar el candado de la 0.6.24 en un cliente no puede funcionar con los ajustes por defecto.

Hallazgos: Alto 5, Medio 5, Bajo 2, Sin medir 6.

---

## Alto

### RT-01 · Alto · La 0.6.24 ya está instalada en Obsidian y en Hebra del Mac; la carga sigue sin comprobar

Evidencia medida hoy:

- Hebra (macOS 0.2.0, 149): `…/Containers/net.fodaveg.hebra/…/fresh-v1/plugins/installed.json` registra `version: '0.6.24'`, `previous: '0.6.22'`, `installedAt: '2026-10-10T04:38:32.643Z'`. Los tres ficheros de `plugins/tyrian-companion/0.6.24/` dan `785a9780…` (`hebra-main.mjs`), `22ba8b8c…` (`hebra-styles.css`) y `c124c8c9…` (`hebra.json`), los mismos `digest` que `gh release view 0.6.24` para esos assets. El proceso `hebra` arrancó el `10 oct 07:01:44` (hora local, después de la instalación). Las bases IndexedDB de Tyrian en WebKit tienen su WAL tocado a las 07:01 y `hebra-tyrian-local-files` (donde va el registro de diagnóstico en Hebra) a las 07:09. Es un indicio fuerte de que el plugin arrancó en Hebra hoy, no una prueba de qué versión cargó.
- Obsidian (vault `~/Documents/fodaveg`, el canónico): `manifest.json` dice `0.6.24`; `main.js` `e5597ecb…` y `styles.css` `713ec71b…` coinciden con los assets de la release. `manifest.json` difiere en bytes (214 frente a 237; BRAT lo reescribe) pero el contenido es el mismo. BRAT sigue `fodaveg/tyrian-companion` con `version: "latest"`. Ficheros escritos a las 07:40; el proceso de Obsidian arrancó a las 07:39:35, así que la versión en memoria puede ser la anterior hasta recargar.
- La 0.6.22 también estuvo instalada en Hebra del Mac (`plugins/tyrian-companion/0.6.22/`, 9 oct 19:28), cosa que `ESTADO.md:158` da como no instalada.
- `ESTADO.md:10` sigue diciendo «nada de la 0.6.24 se ha ejecutado en un Hebra ni en un Obsidian reales».

Acción: registrar en `ESTADO.md` la instalación medida y cerrar la carga con el paso 1 a 8 del guion (RT-03 para Obsidian, sin David). Coste: 0,25 h de documentación más los 15 minutos de David.

### RT-02 · Alto · El único test que ejecuta el `hebra-main.mjs` publicado se salta en CI y en la release

- `src/host/hebra/bundle.test.ts:19`: `describe.runIf(existsSync(BUNDLE))`, con `BUNDLE = join(process.cwd(), 'hebra-main.mjs')`.
- `.gitignore:18`: `/hebra-main.mjs`. En un checkout limpio no existe.
- `scripts/gate-steps.mjs`: el paso `unit` va tercero y `host-esm` (que genera el fichero) es el último de `check`. `scripts/run-gate.mjs` los ejecuta en orden. El comentario del test (`bundle.test.ts:12-13`, «the gate builds it before the tests») es falso.
- `rg "\.(runIf|skipIf)\(|\.skip\(" src -g '*.test.ts'` da una sola coincidencia: este test. `ESTADO.md:17` recoge la salida de GitHub: «Tests 2 failed | 5879 passed | 1 skipped (5882)». El «1 skipped» es este. En local pasa porque queda un `hebra-main.mjs` de builds anteriores (ESTADO:20 «5882 passed»).
- `release.yml:42-45` corre `npm run check` y después `release:package`, que construye el bundle que se publica. El fichero que Hebra descarga nunca se ha importado ni activado en ninguna máquina de CI.

Acción: mover el paso `host-esm` antes de `unit` en `check`, y que el test falle (no se salte) cuando `CI` está definido. Coste: 0,5 a 1 h.

### RT-03 · Alto · La carga y reapertura en Obsidian es automatizable hoy y ya se hizo una vez

- `docs/audit/2026-10-02-h18-29-runtime.md:49-63`: con una bóveda y un perfil de Obsidian desechables (1.13.7 Flatpak, Fedora), un agente instaló la 0.2.17, pasó `verify-beta-runtime`, leyó `core.runtimeReady=true`, abrió el panel, Inventario y Venta, hizo `obsidian restart` y volvió a pasar. Es la única evidencia de carga en Obsidian por el procedimiento de `BETA.md`.
- Desde entonces hay 25 entradas «Canal … publicado» en `ESTADO.md` (`grep -c '^## Canal .* publicado'` = 25, de la 0.5.0 a la 0.6.24) y todas dicen «instalación/runtime pendiente».
- En el Mac existe el CLI: `/usr/local/bin/obsidian -> /Applications/Obsidian.app/Contents/MacOS/obsidian-cli`.

Acción (clase a): en una bóveda desechable del Mac, `node scripts/install-beta.mjs install --vault <desechable> --archive tyrian-companion-0.6.24.zip --confirm-obsidian-closed` (zip descargado de la release y comprobado con su `.sha256`), abrir, activar, `node scripts/verify-beta-runtime.mjs --vault <desechable>`, `node scripts/smoke-live.mjs --plugin-dir <desechable>/.obsidian/plugins/tyrian-companion`, `obsidian restart` y repetir los dos. Para la actualización desde una versión anterior, instalar antes la 0.6.22 del mismo modo. Coste: 1 a 1,5 h de agente, sin David. Necesita su autorización para operar Obsidian (ver Decisiones).

### RT-04 · Alto · El plan para comprobar el candado de la 0.6.24 no funciona con los ajustes por defecto

`ESTADO.md:86-87` y `SPEC-live-loot.md:219` dicen que se comprobará leyendo en el registro local `life_lock_*` y `taken`. Pero:

- Registro desactivado por defecto: `src/core/settings.ts:234` `debugLoggingEnabled: false`; nivel por defecto `:235` `'warn'`.
- `src/core/local-debug-persistence.ts:159-160`: un `success` o un `skip` con código `skipped` se escribe a nivel `debug`. `life_lock_proven` es `success('ok')` (`coordination-coordinator.ts:455`), `life_lock_absent` es `skip('skipped')` (`:468`) y `taken` es `success('ok')` (`:369`). Solo `life_lock_unmarked` (`skip('unavailable')`) y `refused` llegan a `warn`. El test lo confirma: `local-debug-persistence.test.ts:95,99` esperan `level: 'debug'`.
- En el Obsidian del Mac: `debugLoggingEnabled: true`, `debugLoggingLevel: 'warn'`. Hoy no se escribiría ni `life_lock_proven` ni `taken`.
- El evento de instancia no sale al arrancar: se emite en la primera adquisición de lease (`coordination-coordinator.ts:305-306`), o sea, con una sesión que empieza o se recupera.
- En Hebra el registro va a una base IndexedDB (`src/host/hebra/local-storage.ts`, comentario de cabecera), no a un fichero: solo se lee con la exportación de diagnóstico desde Ajustes.

Acción: subir `taken` y los tres `life_lock_*` a `info` o `warn` (cambio técnico, 1 h con su test), o como mínimo poner en el guion «registro activado, nivel debug, y empezar una sesión». El guion de abajo ya lo hace.

### RT-05 · Alto · `QA-MVP.md` no describe la v1 que se quiere cerrar

- La matriz vigente es «candidata 0.5.0 live1» (`QA-MVP.md:3-12`): 4 filas, las 4 «Pendiente».
- Las 16 pruebas históricas tienen `**Versión probada:** ______________` en blanco (16 de 16, `grep -c`). `QA-MVP.md:48-49`: «Estas pruebas aún no se han ejecutado.»
- No hay ninguna fila para lo que han añadido las 0.6.x: la vista principal de Hebra (0.6.21), su presentación (0.6.22), el arranque con el almacén mudo y el candado (0.6.24), las notas resumen (0.6.13 a 0.6.19).
- El último cambio del fichero es `0756d02` (9 oct), un retoque de Bases; el anterior de contenido QA es del 6 oct.
- `ESTADO.md:1607-1634`: «QA manual: una sola sesión ejecutada, en una sola plataforma»; esa sesión es la del 3 sep (`ESTADO.md:1596`), en la bóveda real.

Acción: reescribir la cabecera de `QA-MVP.md` como matriz 0.6.x de v1, con las filas del inventario de abajo marcadas a/b/c, y dejar lo histórico como anexo. Coste: 2 h. Depende de la decisión de plataformas.

---

## Medio

### RT-06 · Medio · `beta:verify-runtime` solo compara cadenas de versión

Lo que verifica (`scripts/verify-beta-runtime.mjs:12,33-49`): la bóveda efectiva de la instancia viva es la pedida; el plugin está activado; `manifest.json` en disco, `app.plugins.manifests[id].version` y `app.plugins.plugins[id].manifest.version` son iguales.

Lo que no verifica, aunque `BETA.md:162-176` lo presenta como la condición para aceptar carga o actualización:

- que `main.js` y `styles.css` instalados sean los bytes de la release (en el Mac sí lo son, RT-01, pero el script no lo mira);
- que el `onload` terminara: no lee `core.runtimeReady` (sí lo hace `smoke-live.mjs:107`);
- errores del arranque, `minAppVersion` frente a la versión de Obsidian, ni nada de Hebra;
- sus tests (`scripts/tests/probar-beta-runtime.mjs`, 11 aserciones, y el control negativo de `probar-beta-runtime.sh`) usan un CLI falso. Nunca se ha ejecutado en CI contra un Obsidian.

Acción: añadir a la expresión `runtimeReady` y comparar el sha256 de `main.js`/`styles.css` con el `digest` de `gh release view`. Coste: 1,5 h.

### RT-07 · Medio · `smoke:live` daría rojo falso hoy en el Mac

`readErrorsSinceReload` (`scripts/smoke-live.mjs:123-141`) cuenta los `level:"error"` desde la marca `.tyrian-dev-reload-at` que solo escribe `dev:install`. BRAT no la renueva. En el Mac la marca es `2026-09-10T20:15:15.471Z` y el `debug.jsonl` tiene desde entonces 70 errores, todos de versiones viejas (0.2.8: 5, 0.2.9: 9, 0.2.11: 1, 0.2.12: 4, 0.2.13: 11, 0.2.14: 1, 0.2.19: 2, 0.2.20: 37). El último registro del fichero es del 3 oct, de la 0.2.20; ninguna 0.5 o 0.6 ha escrito ahí con el nivel `warn`.

Acción: filtrar por `pluginVersion` igual a la cargada, o tomar como corte el momento del `eval`. Coste: 1 h.

### RT-08 · Medio · `dev:install` y `smoke:live` apuntan por defecto a la bóveda canónica

`scripts/dev-install.mjs:30-33` y `scripts/smoke-live.mjs:42-45`: sin `--plugin-dir`, `~/Documents/fodaveg/.obsidian/plugins/tyrian-companion` (Mac) o `~/Documentos/…` (Linux). `QA-MVP.md:59` y `BETA.md:199-200` exigen bóveda desechable. Un agente que corra `npm run dev:install` sin flag reescribe el `main.js` del vault de uso diario.

Acción: exigir `--plugin-dir` o `TC_PLUGIN_DIR`. Coste: 0,5 h.

### RT-09 · Medio · No hay ninguna herramienta de runtime para Hebra

`rg -l -i hebra scripts/*.mjs` solo da `gate-steps`, `build-host-esm`, `brat-release-contract`, `security-scan` y `release-package`. Hebra es el host donde David usa el plugin y donde ha visto la 0.6.10, la 0.6.11 y la 0.6.21 (`ESTADO.md:797,755,226`).

Acción en dos niveles: (1) instalación, clase a: un script que lea `installed.json` y los hashes de `plugins/tyrian-companion/<versión>/` y los compare con `gh release view` (lo que hice a mano en RT-01), 1 h; (2) carga, clase b: depende de que Hebra exponga el estado del plugin a algo externo (MCP `hebra`, línea de log o ruta de diagnóstico); de 3 a 5 h más coordinar con la sesión de Hebra.

### RT-10 · Medio · Las plataformas de la QA se contradicen

- `QA-MVP.md:10,419-420,455,479-500`: Windows con Blish HUD (pruebas 13 y 14); `:62`: «macOS con CrossOver queda fuera de esta ronda».
- `BETA.md:56-59`: desde el 8 oct Nexus es obligatorio, Blish queda congelado en su 0.5.0 y Windows con Nexus es «una expectativa sin probar».
- Los dos hosts que hoy tienen la 0.6.24 son los del Mac (RT-01).

Acción: decisión de David (abajo) y luego 0,5 h para alinear los dos documentos.

---

## Bajo

### RT-11 · Bajo · La entrada 0.6.24 de `ESTADO.md` se contradice

`ESTADO.md:85` «Sin medir: el gate, los guardarraíles, `release:preflight` y el paquete» y `:88-89` «Pendiente: el gate…, la publicación (tag, release, `release:brat-verify`)» quedaron de antes de publicar; `:25-37` dicen que todo eso pasó. Acción: borrar las dos líneas. Coste: 0,1 h.

### RT-12 · Bajo · El artifact de CI no trae el verificador de runtime

`scripts/prepare-beta-artifact.mjs:36-41` empaqueta solo el zip, su `.sha256` e `install-beta.mjs`. `BETA.md:175-176` pide usar la copia de `verify-beta-runtime.mjs` del mismo commit, que hay que sacar del repo a mano. Acción: añadirlo al artifact. Coste: 0,25 h.

---

## Sin medir

### RT-13 · Sin medir · `navigator.locks` en el Electron de Obsidian

Obsidian 1.12.7 lleva Electron 39.8.3 (`defaults read …/Electron Framework.framework/Resources/Info.plist CFBundleVersion`). No lo comprobé porque el encargo prohíbe tocar un Obsidian real. Cómo medirlo sin David (clase a, 0,5 h): en una bóveda desechable, `obsidian eval code='typeof navigator.locks'` y `obsidian eval code='(async()=>JSON.stringify(await navigator.locks.query()))()'` desde dos ventanas de bóvedas distintas, para ver si comparten gestor.

### RT-14 · Sin medir · Web Locks en Hebra (WKWebView en macOS, WebKitGTK en Linux, WebView2 en Windows)

`src/host/hebra/entry.ts:19` toma `window.navigator.locks ?? null`. `ESTADO.md:71-72`: «activado por decisión del integrador, leyendo su código y sin sonda en cliente real». En el Mac existe un contenedor `net.fodaveg.hebra.sonda-plugins` cuyo contenido no miré. Cómo medirlo (clase b, 2 h): un plugin de sonda de Hebra que escriba `typeof navigator.locks` y el resultado de `request` + `query` en su ajuste o en una nota, cargado en el Hebra de Mac y de Fedora.

### RT-15 · Sin medir · Que el candado muera con el proceso

Medible sin David en Obsidian (clase a, 1 h): en una bóveda desechable, `obsidian eval` con `navigator.locks.request('tc-probe', () => new Promise(() => {}))`, `kill -9` del proceso, reabrir, y `navigator.locks.query()` debe no listar `tc-probe`. Mide la propiedad del motor sin el plugin. En Hebra, lo mismo con el plugin de sonda de RT-14 (clase b).

### RT-16 · Sin medir · Proceso único de Hebra en Linux

`SPEC-live-loot.md:204` cita `tauri-plugin-single-instance-2.4.2/src/platform_impl/linux.rs:66-89`: sin bus D-Bus de sesión el segundo proceso arranca. Cómo medirlo sin David (clase b, 2 h, en Fedora con pantalla): con un `HOME` y una biblioteca desechables, lanzar `hebra` dos veces, una con `env -u DBUS_SESSION_BUS_ADDRESS`, y contar `pgrep -c hebra`. Windows: sin máquina para medirlo.

### RT-17 · Sin medir · El almacén mudo en un motor real

Todas las cifras de `ESTADO.md:39-48` salen de `fake-indexeddb`. Se puede provocar un IndexedDB real que no contesta en Obsidian (clase b, 3 a 4 h): por `obsidian eval`, abrir la base de sesión de Tyrian con una versión mayor y mantener viva la transacción de actualización encadenando peticiones; con eso las aperturas del plugin quedan en cola. Entonces, `disablePlugin` / `enablePlugin` y medir el tiempo hasta `core.runtimeReady` (se espera unos 20 s). El host de Obsidian lee `window.indexedDB` en cada acceso (`src/host/obsidian/obsidian-host.ts:31`), así que un envoltorio instalado antes de recargar también vale. En Hebra no veo forma sin herramientas de su lado: `ESTADO.md:48` «el arranque de Hebra con el motor mudo no se probó» sigue igual.

### RT-18 · Sin medir · Qué versión tienen en memoria los dos hosts del Mac y qué dice el registro de Hebra

La de Obsidian solo se sabe con `obsidian eval` (prohibido aquí). El registro de diagnóstico de Hebra está en `hebra-tyrian-local-files` (WAL de las 07:09); leerlo exigía copiar la base de David y el clasificador de permisos lo denegó. No insistí. Lo cubren los pasos 1 y 6 del guion.

---

## 1. Inventario de pruebas y de «sin verificar»

Clase: (a) automatizable hoy con los scripts del repo; (b) con un arnés nuevo; (c) solo humana. «Ejecutada»: lo que consta en el repo.

### Matriz vigente de `QA-MVP.md` (0.5.0 live1)

| ID | Qué comprueba | Ejecutada | Clase |
| --- | --- | --- | --- |
| L1 (`:9`) | Fedora + GE-Proton + Nexus: cargar, arrancar, reabrir, medir, cerrar, guardar, exportar | No; partes vistas por David en Hebra Fedora (precio `price2` con 0.6.10, `ESTADO:797`; vista principal 0.6.21, `ESTADO:226`) | c (juego); el lado host, b con productor falso |
| L2 (`:10`) | Windows con Nexus productor y Blish consumidor | No | c |
| L3 (`:11`) | Obsidian por BRAT: versión cargada y recorrido | Instalación sí en el Mac hoy (RT-01, bóveda canónica); carga no | a (`verify-beta-runtime`, `smoke-live`) |
| L4 (`:12`) | Hebra: carga, reapertura, persistencia | Instalación sí en el Mac hoy (RT-01); vista en Fedora 0.6.21 | c hoy; b con RT-09 |
| L5 (`:19`) | Sin clave: carga → presencia → inicio → cierre → recovery → render | No | b (productor falso) |
| L6 (`:20`) | Addon Nexus real en Fedora y Windows; fuente ausente sin Nexus | No | c |
| L7 a L10 (`:21-24`) | Fixture 0→2→4, épocas, heartbeat, framing, ACK perdido, dos productores, recuperación por canal | No en cliente; sí en tests | b: productor falso que hable el protocolo por TCP contra el plugin en un Obsidian desechable, de 6 a 10 h |
| L11 (`:25`) | Cerrar, guardar, reabrir, exportar; notas 1 a 6 legibles | No | b (mismo arnés + `obsidian restart`) |
| L12 (`:26`) | Timeline, resumen, gráfica a varios anchos, claro/oscuro, teclado, contraste | No | b para capturas por ancho (2 h), c para juzgarlas |
| L13, L14 (`:27-28`) | Plantilla manual y comparación live | No | b |

### Pruebas históricas 1 a 16 y línea base

| ID | Qué | Ejecutada | Clase |
| --- | --- | --- | --- |
| P1 Reservas | Libre/reservado, solapes, sin tabla | No (`:107` en blanco) | c (cuenta real) |
| P2 Precios | Fechas, serie plana, hundido, día a medias | No | c (días de captura) |
| P3 Cierre | Cuatro fallos, reintento, dos ventanas | No | b para dos ventanas por `eval`; c para cortar red |
| P4 Suspensión | Suspender más de 5 min, reabrir | No | c |
| P5, P6, P7 | Sesión de 60 min, rearme, atribución | No | c |
| P8, P9 | Capacidad de material, resincronizar sin reescribir | No | c con ayuda de script de hashes |
| P10 Fechas | Caducidades del 10 dic 2026 y 1 jun 2027 | No | b (reloj en VM desechable, 4 h) |
| P11, P12 | Saco consumido entre lecturas, Laberinto | No | c |
| P13 Puente | Reinicio, conexión muda, dos addons, red | No | Paso 2 a (`nc` al puerto sin saludo, 0,5 h); resto c |
| P14 Windows/Blish | Sesión y aviso en Blish | No | c (y ver RT-10) |
| P15 Obsidian cerrado | El addon abre el host | No | c |
| P16 Saco 36038 | Recomendación con datos de hoy | No | c |
| B1, B2, B3 (`:581-583`) | Retraso drop→aviso, clics, carga de vistas | No | B3 b (tiempos por `eval`, 2 h); B1, B2 c |

### «Sin verificar» de `ESTADO.md`

| ID | Qué | Línea | Clase |
| --- | --- | --- | --- |
| E1 | Nada de la 0.6.24 ejecutado en Hebra ni Obsidian | `:10` | a para carga (RT-03); c para el cierre brusco con sesión en vivo |
| E2 | Que `navigator.locks` exista | `:13` | a en Obsidian (RT-13); b en Hebra (RT-14) |
| E3 | Que el candado muera con el proceso | `:13` | a en Obsidian (RT-15); b en Hebra |
| E4 | Qué procesos comparten el candado | `:14,66-68` | b (RT-16) |
| E5 | Arranque de Hebra con el motor mudo | `:48` | c hoy (RT-17) |
| E6 | Proceso único en Windows | `:68` | c |
| E7 | Reinicio a menos de 15 s: hasta unos 30 s | `:59-60` | c (o b con productor falso) |
| E8 | 0.6.22 pintada: iconos, anchos 280/593/852/1300, lector de pantalla, Windows | `:106,158-160` | Hebra c; Obsidian b (capturas) |
| E9 | 0.6.21: Inventario, Venta, opción «Dónde se muestra», vista de solo editor, WebKit | `:229-234` | c |
| E10 | Instalación y carga en Obsidian/BRAT de 0.6.0 a 0.6.20 | `:286` … `:1131` (21 entradas) | Superado: basta la vigente (a) |
| E11 | Nota resumen y Base «Sesiones» pintadas; sonido de avisos en Hebra | `:581,624` | c |
| E12 | Monedas y oro con datos reales en Hebra | `:836,938` | c |
| E13 | Que WebKitGTK acepte una conexión nueva tras el fallo del almacén | `:871-874` | b difícil / c |
| E14 | Addon 0.8.3: versión en pantalla, cambio de mapa, de personaje, de MF | `:487-488` | c (fuera de los hosts) |

### Deuda de QA (`ESTADO.md:1617-1634`)

D1 spike H8 (premisa cerrada, fuera de este audit). D2 matriz H0.4 y piloto H0.6: c. D3 QA visual H9.7 a cinco anchos: b. D4 36038 ES/EN: c. D5 decisión del 404 (no es prueba). D6 un `429` real: c. D7 carga e IndexedDB en bóveda de desarrollo: a. D9 dos ventanas y dos procesos: b. D10 BRAT por plataforma: a en Mac, c en el resto. D11 protocolo completo: c. Lo único ejecutado de la deuda es la sesión del 3 sep (`:1596`) y el spike H8 del 19 ago en GE-Proton (`:1374`).

---

## 2. Qué verifica de verdad cada script

| Script | Lo que hace | Lo que no hace |
| --- | --- | --- |
| `verify-beta-runtime` | Igualdad de versión en disco, registrada y cargada; bóveda; activado | Bytes, `runtimeReady`, errores, Hebra (RT-06) |
| `smoke-live` | Lo anterior más `runtimeReady`, estado de conexión, puerto del juego y errores del log | Corte de errores válido tras BRAT (RT-07); por defecto la bóveda canónica (RT-08) |
| `dev-install` | Build de producción, copia con sha256, recarga por `eval` con `loadManifests()` | Prueba el build local, no el asset publicado; bóveda canónica por defecto |
| `install-beta` | Instala el zip con Obsidian cerrado, verifica sha256/CRC/identidad, rechaza versión igual o menor | No toca Hebra; no carga nada |
| `prepare-beta-artifact` | Empaqueta zip, `.sha256` e `install-beta.mjs` | No incluye el verificador (RT-12) |
| `release.yml` | `check`, paquete, contrato BRAT antes y después de subir | Ninguna ejecución del bundle de Hebra (RT-02) ni de Obsidian |

Todos sus tests (`scripts/tests/probar-*.mjs`) usan un CLI o un log falsos. Ninguno ha corrido en CI contra un host real.

---

## 3. Guion humano de 30 minutos para David

Ordenado por lo que más desbloquea. Antes de empezar, en la terminal: `date -u` (anota la hora). En cada paso anota: número de paso, host y versión, hora, sí o no, y el nombre de la captura.

**Mac, Hebra (10 min). Desbloquea la 0.6.22 y la 0.6.24 en el host que usas.**

1. En Hebra, lista de plugins: ¿Tyrian dice 0.6.24 y está activo? Anota lo que diga.
2. Abre Tyrian en la pantalla principal, sección Sesión. ¿Va en una columna? Si hay una sesión con valor, ¿«Valor estimado» sale grande con los iconos de oro, plata y cobre? Sin sesión esa fila no sale, y es normal. Haz una captura con la ventana estrecha (unos 400 px) y otra a pantalla completa.
3. Abre Inventario y Venta. Una captura de cada una. ¿Algún error o pantalla vacía?
4. Ajustes de Tyrian: cambia «Dónde se muestra» a barra lateral y vuelve a pantalla principal. ¿Se aplica sin recargar?
5. Cierra Hebra con Cmd+Q y ábrela otra vez. ¿Vuelve Tyrian sin error? Repite el paso 1.

**Mac, Obsidian (8 min). Desbloquea BRAT y la carga en Obsidian.**

6. Ajustes, Plugins de comunidad: ¿Tyrian 0.6.24 activo? Desactívalo y actívalo. Después, en la terminal, desde el repo: `node scripts/verify-beta-runtime.mjs --vault ~/Documents/fodaveg`. Debe salir `beta runtime v1: PASS (disk=0.6.24; registered=0.6.24; runtime=0.6.24)`. Copia la línea. (Es tu bóveda canónica: ver Decisión 1.)
7. Abre la vista de Tyrian. Con la ventana a más de 600 px, ¿Sesión va a dos columnas? Captura.
8. Cmd+Q, abre Obsidian, repite el paso 6.

**Mac, candado de la 0.6.24 (10 min). Desbloquea la parte más arriesgada de la 0.6.24.** Solo si en el Mac puedes empezar una sesión (el comando «Iniciar sesión de farmeo» necesita tu clave de API). Si no puedes, salta a Fedora.

9. Ajustes de Tyrian, Registro de diagnóstico: actívalo y pon el nivel en «debug». Sin esto el evento no se escribe (RT-04).
10. Empieza una sesión con «Iniciar sesión de farmeo». Espera 30 segundos.
11. En la terminal: `kill -9 $(pgrep -x Obsidian)`. Espera 20 segundos y abre Obsidian.
12. ¿La sesión vuelve sola en unos segundos, sin «sesión ocupada» ni 5 minutos de espera? Anota los segundos hasta que puedas terminarla.
13. En la terminal: `grep -o '"state":"life_lock_[a-z]*"\|"result":"taken"\|"result":"refused"' ~/Documents/fodaveg/.obsidian/plugins/tyrian-companion/logs/debug.jsonl | sort | uniq -c`. Copia la salida. Lo bueno es `life_lock_proven` y `taken`; `life_lock_absent` o `life_lock_unmarked` significan que en este host rige el límite de 5 minutos.
14. Termina la sesión y vuelve a poner el nivel del registro en «warn».

**Fedora (solo si hay tiempo o si algo de arriba falla).**

15. Con el juego y Nexus, una sesión en vivo en Hebra; `pkill -9 hebra`; espera 20 s y ábrela. Anota cuánto tarda en volver a «Midiendo». Exporta el diagnóstico desde Ajustes de Tyrian (en Hebra el registro no es un fichero) y busca las mismas palabras del paso 13. Esto responde si WebKitGTK tiene Web Locks.
16. `echo "$DBUS_SESSION_BUS_ADDRESS"` (anota si sale vacío) y, con Hebra abierta, lánzala otra vez desde la terminal; `pgrep -c hebra`. Si da 2, anótalo: es el caso en que el candado es peor que no tenerlo.

**Windows:** nada, salvo que un compañero lo tenga instalado.

---

## 4. Límites declarados de la 0.6.24 que se pueden medir sin David

| Límite (`ESTADO.md`) | Se mide sin David | Cómo y coste |
| --- | --- | --- |
| `navigator.locks` existe en Obsidian | Sí | RT-13, `obsidian eval` en bóveda desechable, 0,5 h |
| El candado muere con el proceso (Obsidian) | Sí | RT-15, `request` + `kill -9` + `query`, 1 h |
| Ventanas de Obsidian comparten gestor | Sí | RT-13, `query` desde dos ventanas, incluido en 0,5 h |
| Web Locks en Hebra macOS y Linux | Con arnés | RT-14, plugin de sonda, 2 h |
| Proceso único de Hebra en Linux | Con arnés, en Fedora | RT-16, dos lanzamientos sin D-Bus, 2 h |
| Almacén mudo, arranque en 20 s (Obsidian) | Con arnés | RT-17, transacción de actualización retenida o envoltorio de `indexedDB`, 3 a 4 h |
| Almacén mudo en Hebra | No | Sin herramientas en Hebra (RT-17) |
| Reinicio a menos de 15 s, hasta unos 30 s | No sin addon | Productor falso de L7 (b) o David con el juego |
| Proceso único en Windows | No | Sin máquina Windows |

Todo lo de clase a necesita que un agente opere un Obsidian con una bóveda y un perfil desechables, como el 2 oct.

---

## 5. Decisiones de David

1. ¿Vale la bóveda canónica del Mac, donde BRAT ya instaló la 0.6.24, como evidencia de instalación y actualización por BRAT? `QA-MVP.md:59` y `BETA.md:200` piden una bóveda desechable; si dices que no, la instalación de RT-01 cuenta solo como indicio y hay que repetirla en una desechable (RT-03).
2. ¿Autorizas a un agente a operar Obsidian en el Mac (abrir, recargar, `obsidian eval`, `kill -9`) sobre una bóveda y un perfil desechables? Con eso salen sin ti RT-03, RT-13 y RT-15.
3. ¿Qué plataformas entran en la QA de v1? Propuesta a confirmar: hosts en Mac (Obsidian y Hebra), recorrido completo con el juego en Fedora, Windows y Blish fuera de v1 (RT-10).

Condicional, solo si sale mal la medida de RT-16: si en Linux pueden convivir dos procesos de Hebra, ¿se mantiene el candado en Hebra o se apaga en Linux? Hasta tener esa cifra no hace falta decidir.

## 6. Límites de este audit

- No ejecuté ningún test, build, gate ni script contra un host real; los comportamientos de scripts salen de leer su código y sus tests.
- La carga de la 0.6.24 en los hosts del Mac no está medida: solo instalación (hashes) e indicios de arranque (fechas de las bases de Hebra). No leí el registro de diagnóstico de Hebra: el intento de copiar su base fue denegado por permisos de privacidad.
- Leí del vault canónico solo metadatos, hashes, tres campos de `data.json` y recuentos del `debug.jsonl` (versiones, niveles, fechas), sin contenido de registros.
- No miré Fedora ni Windows; lo que digo de ellos sale de `ESTADO.md`, `SPEC-live-loot.md` y `docs/audit/2026-10-02-h18-29-runtime.md`.
- Las horas de arnés son estimaciones de un agente que conoce el repo, sin contar revisión independiente.
- No revisé el repo de Hebra ni el del addon de Nexus.
