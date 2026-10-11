# Hebra desechable, 11 oct 2026: HP-03, Z19 parte b y HP-15 en Linux

Máquina: Fedora 44 (Linux 7.2.9), Hebra rpm `0.2.0-21`, webkit2gtk4.1 `2.54.1-1.fc44`. Medición del 11 oct 2026,
09:56 a 10:12 (hora local).
Plugin medido: los tres ficheros del build atestado de la 0.6.45 (HEAD `88f1ff4b`). Sus SHA-256 coinciden con los de
`hebra.json`: `hebra-main.mjs` `e72762b2…`, `hebra-styles.css` `ec2279f0…`, `hebra.json` `eb057d52…`.
Código leído en `main` `4f5136c4` (Tyrian) y en `hebra` `6acdd876` (solo lectura).

Marcas: **MEDIDO** (lo observé ejecutándolo), **LEÍDO** (lo dice el código o un fichero), **INFERIDO** (lo deduzco, no
lo vi).

**Resultado.** Tyrian 0.6.45 queda cargado y con el runtime listo en un Hebra real (MEDIDO). Pero la sección Sesión
sale vacía en Linux por Trusted Types (MEDIDO): es un rojo nuevo que el lote no pedía y se arregla aparte. El
arranque con una carpeta de salida grande no pesa si el índice ya está guardado y cuesta alrededor de 1 s la primera
vez (MEDIDO). Las tres comprobaciones de HP-15 salen como se esperaba en Linux. La Hebra de David no se tocó (MEDIDO).

Fue solo medición: no se escribió en ningún repo.

## Cómo se aisló de la Hebra de David

- **MEDIDO.** Todos los Hebra de prueba arrancaron con `XDG_DATA_HOME` propio y un bus D-Bus roto a propósito, para que
  no pudieran hablar con el de David ni con su almacén de secretos. Cada uno era un proceso nuevo, con su carpeta de
  datos y su puerto de inspector.
- **MEDIDO.** El script de parada mata solo el PID que guardó el de lanzamiento, comprueba antes que sea `hebra` y se
  niega a tocar el proceso de David.
- **MEDIDO.** La prueba del portapapeles se hizo en un Xwayland independiente (`GDK_BACKEND=x11`, pantalla `:99`,
  `WAYLAND_DISPLAY` vacío). Los sockets del proceso Hebra solo iban a ese servidor X, al bus del sistema y a sus hijos
  de WebKit.
- **INFERIDO.** Que el compositor no pase al escritorio la selección de un Xwayland que no lanzó él; no se midió el
  portapapeles del escritorio de David.
- **MEDIDO, efecto secundario del aislamiento.** Con el bus roto, `secrets.load` falla («DBus error: Socket name too
  long») y Tyrian lo registra como `global_error`. Es del montaje, no del plugin.
- Lección heredada de la medición de Obsidian del 10 oct: antes de dar por aislado un cliente hay que comparar el
  estado de David antes y después. Aquí se hizo (ver el último apartado).

## HP-03: Tyrian 0.6.45 cargado y con runtime listo

**Veredicto (MEDIDO): cargado, activo y con el runtime listo.** Sin clave API, tres de las cuatro secciones pintan lo
previsto y Sesión sale vacía (siguiente apartado).

Cómo se comprobó que está cargado y no solo instalado:

| Comprobación | Resultado | Marca |
|---|---|---|
| Instalación: `verify-hebra-install` contra `gh release view` | `PASS (version=0.6.45; release-bytes=match; carga: no comprobada)` | MEDIDO |
| Versión cargada: `pluginVersion` en el registro de diagnóstico | 59 de 59 líneas leídas llevan `"pluginVersion":"0.6.45"` | MEDIDO |
| Runtime listo: línea `plugin_load` / `boot_timings`, `phase: success` | presente (línea 34 del volcado), con la marca `ready`; después `plugin_load success runtime_initialize` (línea 37) | MEDIDO |
| Por qué `boot_timings` prueba el runtime | solo se escribe al llegar a `renderRequested`, y `ready` es cuando `runtimeReady` pasa a `true` (`tyrian-companion-core.ts:1484-1490`) | LEÍDO |
| Candado | `tyrian-companion-lease:wl1:<uuid>` tomado, visto con `navigator.locks.query()` | MEDIDO |
| Bases IndexedDB | creadas las `tyrian-companion-*` y `hebra-tyrian-*` | MEDIDO |
| Estilos | `<style data-hebra-plugin="tyrian-companion">` inyectado | MEDIDO |
| Botón | «Acciones de sesión de Tyrian Companion» en la barra | MEDIDO |
| Ajustes | escritos en `localStorage` | MEDIDO |

Paneles abiertos desde el menú «Abrir acompañante», sin clave API (MEDIDO):

| Sección | Lo que pinta | Previsto |
|---|---|---|
| Inventario | «Falta vincular la clave API», el asesor con «Sincronizar inventario» y «Analizar sin escribir», «Aún no hay ningún análisis del inventario» | sí |
| Venta | «Este dispositivo está en modo consulta: actualiza el inventario en el asesor para calcular la venta.» | sí |
| Logros | buscador, categorías cargadas de la API pública, «Seguidos (0)» | sí |
| Sesión | vacía: solo el armazón `<main class="tyrian-product-shell__content">`, sin hijos | no |

### Vía repetible

- **MEDIDO.** Se usó el inspector remoto de WebKitGTK (`WEBKIT_INSPECTOR_HTTP_SERVER`) sobre Hebras desechables que
  arranca quien mide, con un script de Node que habla por WebSocket con la página (el mismo que ya se usó en la
  medición HP-02). Con él, un script lee el registro de Tyrian de la base IndexedDB `hebra-tyrian-local-files`
  (claves `.hebra/plugins/tyrian-companion/logs/debug.jsonl…`) y otro abre las cuatro secciones y devuelve su texto.
- **MEDIDO.** Sirve para Hebras que arrancas tú. **No sirve para la Hebra de David**, que se arranca sin inspector.
- **MEDIDO.** Hace falta el registro de diagnóstico activo. `boot_timings` se escribe en nivel `info`, así que el
  registro debe estar en `info` o `debug` (aquí `debug`). Se activa en `localStorage` con
  `…tyrian-companion.local:<lib>:tyrian-companion:setting:debugLoggingEnabled = true`, y además deben existir los
  ajustes compartidos: con ajustes `null` el registro sigue apagado.
- **Trampa (MEDIDO).** Si `indexedDB.open('hebra-tyrian-local-files')` se ejecuta antes de que la abra Tyrian, crea la
  base en versión 1 sin almacén de objetos, y Tyrian ya no puede escribir su registro. Resultado visto: tres arranques
  seguidos sin `boot_timings` («sin boot_timings en 60 s»). El lector final consulta antes `indexedDB.databases()` y
  aborta en `onupgradeneeded`, de modo que no crea nada.

## HALLAZGO: la sección Sesión sale vacía por Trusted Types

- **Síntoma (MEDIDO).** Al abrir el acompañante, el registro de Tyrian apunta (línea 51 del volcado)
  `global_error … "hebra host (<path-redacted>): This assignment requires a TrustedHTML"`. Sesión queda vacía antes y
  después de `ready` y al cambiar de sección. No salen ni «Sin sesión» ni «Abre Guild Wars 2…».
- **Causa, probada aislada en la misma página (MEDIDO).**

  | Llamada | Resultado |
  |---|---|
  | `document.createRange().createContextualFragment('')` | `TypeError: This assignment requires a TrustedHTML` |
  | `innerHTML = …` | el mismo `TypeError` |

- **Origen del bloqueo (MEDIDO).** La página de Hebra en el escritorio lleva un `<meta>` CSP con
  `require-trusted-types-for 'script'` y `trusted-types svelte-trusted-html hebra-service-worker hebra-sandbox-worker
  hebra-library-worker hebra-pdf-text-worker default dompurify`. WebKitGTK 2.54 lo hace cumplir.
- **El comentario de `hebra/svelte.config.js` no se cumple en Linux (LEÍDO + MEDIDO).** Dice que Trusted Types «solo
  tiene sentido en la build web» y que WKWebView no lo implementa. Ese `kit.csp` llega también a la app de escritorio
  y, en Linux, WebKitGTK sí lo aplica.
- **Sink en Tyrian (LEÍDO).** `src/ui/owned-root.ts`, `emptyFragment` → `createContextualFragment('')`. Lo usan
  `farming-session-panel.ts`, `live-session-money.ts`, `live-session-comparison-panel.ts` y
  `farming-declared-build-editor.ts`, es decir, el panel de Sesión.
- **INFERIDO.** Que el `<path-redacted>` del mensaje sea `section tyrian-companion-main/session`: la `/` del texto que
  construye `hebra-main-view.ts` hace que el saneador lo tome por una ruta.
- **Por qué no se vio antes (INFERIDO).** Las demás secciones no pasan por ese sink, y los tests de Tyrian corren en un
  DOM que no impone Trusted Types.
- **No medido.** macOS y Windows: no se probó si su webview aplica la misma CSP.
- **Destino.** Se arregla en otra rama de la 0.6.46. Este documento solo deja la evidencia.

## Z19 parte b: arranque con una carpeta de salida grande

**Respuesta (MEDIDO): con el índice ya guardado no pesa (unos 20 ms sobre la base). En el primer arranque sin índice
pesa alrededor de 1 s, y ese segundo retrasa la activación entera**, porque `hebraSeed` va antes de `onload`.

Montaje:

- **MEDIDO.** Biblioteca desechable con la carpeta `Tyrian Companion` (la `outputFolder` por defecto), con
  `Inventory/Positions`, `sessions/2026`, `summaries` y `Bases`. Se creó con `library_import_batch` desde la propia
  página de Hebra. El generador informó `{"folders":7,"notes":1426,"bytes":5574203}`.
  - 1.371 posiciones de inventario, de unos 1,2 kB, con el mismo frontmatter y la misma línea de marca que las reales.
    Ids, nombres y personajes son sintéticos y el hash es inventado (para la ruta no se comprueba).
  - 50 sesiones con `tc_kind: "gw2_farming_session"`, `tc_session_ref` de 64 hex y `tc_started_at` ISO, de unos
    82 kB cada una.
  - 5 resúmenes sin marca.
  - En total 1.426 notas y 5,57 MB.
- **MEDIDO.** Es el mismo reparto que la carpeta real de David (1.371 + 50 + 5). De la carpeta real solo se contaron
  ficheros y se miró la forma de una nota; no se copió contenido.
- **Línea base.** La misma carpeta vacía (`{"folders":7,"notes":0}`).
- **Adopción (MEDIDO).** `bootCounts` del arranque frío: `notesRead 1426`, `newlyAdopted 1421`, `pages 9`. Las 1.421
  notas con marca se adoptaron todas.
- **Definiciones.** «Frío» = primer arranque de Tyrian sobre esa biblioteca, sin índice guardado; se restaura una copia
  limpia antes de cada repetición. «Caliente» = el arranque siguiente, con el índice ya guardado: reconcilia y solo
  vuelve a leer las 5 notas sin marca (`notesRead 5`, `newlyAdopted 0`). Cada medida es un proceso de Hebra nuevo.

| Escenario | n | `hebraIndex` a `hebraSeed` (el recorrido) | Del módulo a `ready` | Del lanzamiento a `ready` (mediana) |
|---|---|---|---|---|
| 0 notas, frío | 3 | 3 / 3 / 3 ms | 81 / 82 / 86 ms | 790 ms |
| 0 notas, caliente | 6 | 2–3 ms | 79–92 ms | 771 ms |
| 1.426 notas, frío | 3 | 993 / 984 / 1.139 ms | 1.090 / 1.073 / 1.239 ms | 1.841 ms |
| 1.426 notas, caliente | 6 | 19–22 ms | 100–131 ms | 868 ms |

Sobre las columnas:

- Las marcas `bootMs` cuentan desde que se evalúa el módulo.
- «Del lanzamiento a `ready`» es la hora de lanzamiento hasta la marca `ready`, con módulo = `timestampUtc` de la línea
  menos `bootMs.renderRequested`. Incluye lo que Hebra pone antes de Tyrian: unos 310–335 ms hasta crear la página y
  unos 360–450 ms más hasta evaluar el módulo. Eso no depende de Tyrian.

Lectura:

- **MEDIDO.** El coste está casi entero en el primer recorrido, que lee el cuerpo de cada nota (1.426 lecturas). Con el
  índice guardado el recorrido solo pagina (9 páginas) y añade unos 20 ms frente a la base.
- **Conclusión.** Con índice guardado, la carpeta grande no pesa. Sin índice cuesta ~1 s de más, solo la primera vez.

No se midió o limita la lectura:

- **INFERIDO.** Mis sesiones sintéticas pesan unos 82 kB y las reales unos 122 kB. Con la carpeta real el frío sería algo
  mayor, del orden de 1–1,5 s. No se midió con la carpeta real.
- La biblioteca estaba en tmpfs y la caché del sistema caliente: no es un arranque en frío del disco.
- Solo Linux.
- n = 3 en frío, así que las cifras dan orden de magnitud, no una distribución.

## HP-15 en Linux (WebKitGTK), sin clics

Ejecutado por el inspector en el contexto de la página de Hebra, que tiene la misma CSP que el plugin. No hubo
interacción humana.

| Prueba | Resultado | Marca |
|---|---|---|
| `<img>` de `https://render.guildwars2.com` | carga: evento `load`, `naturalWidth` 64 × 64, en 14–227 ms, en las cuatro pruebas (X aislado y Wayland) | MEDIDO |
| Por qué carga | la CSP real tiene `img-src 'self' data: blob: https:` | LEÍDO |
| `new AudioContext()` sin gesto | nace `suspended`; a los 300 ms está `running` sin hacer nada; `resume()` se resuelve en `running` | MEDIDO |
| `navigator.clipboard.writeText` sin gesto | `NotAllowedError: The request is not allowed by the user agent or the platform in the current context…` (dos veces) | MEDIDO |
| `navigator.clipboard.writeText` con gesto emulado (`isActive: true`) | `accepted` | MEDIDO |
| «Copiar token» (se lanza con un clic) funciona | deducido de lo anterior | INFERIDO |
| Una copia tras un `await` largo, fuera de la activación transitoria | caería en el `NotAllowedError` | INFERIDO |

Salvedades:

- **MEDIDO.** En la página de Hebra recién arrancada, `navigator.userActivation.hasBeenActive` ya vale `true` sin que
  nadie haya tocado nada. No se pudo crear el caso de una página que nunca tuvo activación, así que el resultado del
  audio no demuestra qué pasaría en ese caso.
- El portapapeles se probó solo en el Xwayland aparte, para no tocar el de David. En Wayland solo se probaron imagen y
  audio, con el mismo resultado (imagen en 150 ms; audio `suspended` a `running`).
- Solo WebKitGTK. macOS (WKWebView) y Windows (WebView2) sin medir.

## La Hebra de David: no se tocó

Comparación antes (09:56) y después (10:11), MEDIDO:

| Elemento | Antes | Después |
|---|---|---|
| Proceso `/usr/bin/hebra` | pid 158277, arrancado 07:14:55 | el mismo pid, vivo |
| `hebra.sqlite3` | mtime `2026-10-11 08:45:58.668731349`, 146.673.664 bytes | idéntico |
| `hebra.sqlite3-wal` | 43.161.152 bytes | mismo tamaño; mtime cambió |
| `hebra.sqlite3-shm` | 98.304 bytes | mismo tamaño; mtime cambió |
| Puerto `127.0.0.1:47823` | del pid 158277 | del pid 158277 |
| `~/.config/mimeapps.list` | sin cambios | sin cambios |
| `~/.local/share/applications` | sin cambios | sin cambios |

- **MEDIDO.** Cambiaron de mtime el `-wal`, el `-shm`, `diagnostico.jsonl` y un directorio de `CacheStorage`. Al
  cerrar, solo el pid 158277 tenía abierta su base.
- **INFERIDO.** Esos cambios son de la propia Hebra de David, porque todos los Hebra de prueba usaron `XDG_DATA_HOME`
  propio. No se demostró por atribución directa.
- **MEDIDO.** Procesos de prueba: los 21 `pid-*` y el Xwayland quedaron muertos; no queda ningún scope `hosthebra-*` y en
  `/tmp/.X11-unix` solo están `X0` y `X1`.
- **MEDIDO.** Las ventanas de prueba salieron en el escritorio de David (Wayland) o en la ventana del Xwayland `:99`.
  A su Hebra no se le mandó nada.
- Limpieza: se borraron los datos de las pruebas (149 MB en tmpfs).

## Qué no se midió

- Hebra en macOS, iOS, Android o Windows; Trusted Types fuera de WebKitGTK.
- La carpeta real de David como entrada del arranque (solo su forma y su reparto).
- Un arranque en frío desde disco (todo fue tmpfs con caché caliente).
- Páginas sin activación de usuario previa, para el audio.
- El portapapeles en el escritorio real o con el Wayland de David.
- Paneles con clave API vinculada (todo fue sin clave) y la sección Sesión con una sesión real de Guild Wars 2.
- Reapertura del plugin tras un cierre brusco (no era objeto de esta medición).

## Scripts usados (descritos, sin enlazar)

Viven en el scratchpad de la sesión y no se versionan:

- Un lanzador de Hebra desechable (etiqueta, directorio de datos, puerto del inspector y variables) y su parada por
  PID guardado.
- Un instalador que copia los tres ficheros del plugin y escribe un `installed.json` con la forma del registro de
  instalación de Hebra.
- Un generador de biblioteca sintética, un medidor de un arranque, una serie de arranques frío/caliente, el lector del
  registro, el abridor de secciones y la sonda de HP-15.
