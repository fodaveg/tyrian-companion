# Estado

## Vertical activa

**Release beta `0.1.21` publicada el 2026-09-01 desde el tag y commit `1514bf3c52e4f71158a7a724b6c227c5930c4bc0`.**
`manifest.json` y `package.json` declaran `0.1.21`. Runs de CI de `main`, del tag y del workflow
`Release`: `33525623408` (CI de `main`), `33525647496` (CI del tag) y `33525647471` (workflow `Release`), los tres en verde.

La release adjunta los cinco assets exactos. El ZIP tiene SHA-256
`8f8ab5f5f48d12584bef417b3e74aa31113b431411c6107cedb96f8ddcdb263d`, que coincide con el fichero
`.sha256` que la propia release adjunta. El `main.js` publicado se descargó y se comparó con el
construido localmente: idénticos byte a byte, SHA-256
`d95d8312e838407c3363ebef9ca22a591d22a279fb4755556631c2c04477349f`. El contrato BRAT, ejecutado
contra la salida real de `gh release view`, da `PASS (version=0.1.21; assets=5)`.

**Canal publicado; runtime pendiente.** Los tres ficheros (`main.js`, `manifest.json`, `styles.css`)
se copiaron a la bóveda real de David y se verificaron por `sha256sum`, no por la salida del `cp`;
`manifest.json` instalado declara `0.1.21` y `data.json` no se tocó. Pero **Obsidian estaba ABIERTO
durante la copia**, así que el plugin cargado en memoria sigue siendo la build anterior hasta que se
recargue. No hay evidencia de carga del plugin, de QA visual ni de una sola llamada real a la API de
Guild Wars 2 desde el cliente con esta versión.

El contenido de esta release y su motivación están en el [changelog](CHANGELOG.md), entrada
`0.1.21`. Absorbe tres lotes integrados en `main` después de `0.1.20`: la Bolsa de truco o trato
deja de estar muda, la nota de sesión da un número económico por primera vez (antes escribía
`valuation: null` a mano en todas las sesiones), y el detector asistido pasa a proponer de verdad
(antes exigía dos consultas consecutivas con ganancia, algo que la caché de 5 a 10 minutos de la
API de cuenta nunca permitía).

El relato de las releases `0.1.13` a `0.1.20` (H5–H12, cada lote con sus commits, gate y QA
pendiente) se movió íntegro a [`docs/historico/ESTADO-lotes-cerrados.md`](historico/ESTADO-lotes-cerrados.md).

**Foundation, conexión GW2, H1.4 coordinación, H3.1–H3.10 lifecycle/detección/revisión/calidad local, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta`, H2.7 contaminación, economía H4.1–H4.19, UI/assets H5.1–H5.12 y contratos H8.1/H8.4: implementados. H8.2 aporta el spike, con su QA humana ya ejecutada y completa en Linux/Steam/Proton, H8.3 la decisión, H8.5 el helper/servidor Rust aislado, H8.6 el cliente core TS, H8.7 una frontera safe-launch sin executor y H8.8 una política shadow pura de presencia/ausencia; launcher real, composición del plugin, firma, publicación y QA real siguen pendientes. H8.8 queda `@done` dentro de su alcance aislado; H8.7 permanece `@wip`.**

**H8 (Mumble v2) queda congelada por decisión de producto del 2026-08-18** hasta que cierre
H8.2, que tiene dos pasos: compilar el PE del spike y leer MumbleLink dentro de la botella
durante una sesión real. El paso 1 cerró el 2026-08-18: el PE compila con `zig` como driver de
C y su tabla de importación censada con `llvm-readobj` no trae ni `OpenProcess` ni
`ReadProcessMemory`. El paso 2, ejecutarlo dentro de la botella con GW2 corriendo, sigue
pendiente y es exclusivamente humano. Congelar no cuesta nada al MVP: cero consumidores de
`src/platform/` fuera de sí mismo, y `esbuild.config.mjs` mantiene `treeShaking: true` al
entrar por `src/main.ts`, así que nada de H8 viaja en el ZIP.

**Arranque del plugin diferido a `onLayoutReady`.** `onload()` esperaba el bundle de assets
gestionados, el hash del vaultId, varias aperturas de IndexedDB, `sessions.initialize()` y
`refreshLootPresentation()` antes de registrar las vistas; un leaf `tyrian-companion-*`
guardado podía restaurarse contra un view type todavía sin registrar y bloquear el arranque de
Obsidian. Ahora `onload()` registra las dos vistas, el setting tab, los cinco comandos, los
comandos de sesión y los listeners de DOM antes de cualquier otro `await`, y termina con
`workspace.onLayoutReady`; el resto se movió sin cambiar el orden a `initializeRuntime()`. Entre
ambas fases una guarda `runtimeReady` da valores neutros y el aviso `notices.pluginStarting`
(ES/EN); `onunload()` marca `unloaded` antes que nada. Test de la propiedad de orden,
verificado en rojo con sabotaje.

**Gate del repo aislado de los worktrees de agente.** Un worktree de agente bajo `.claude/`
es una segunda copia entera de `src/`: medido con uno presente, `vitest list --filesOnly`
devolvía 226 ficheros de test (113 bajo `.claude/`) y `scripts/h8-native-decision-contract.mjs`
ponía `npm run check` en rojo con 20 hallazgos `forbidden-product-artifact`, todos dentro de
`.claude/worktrees/`. Excluido en `vitest.config.mts`, `eslint.config.mts`,
`scripts/h8-native-decision-contract.mjs`, `scripts/security-scan.mjs` y `.gitignore`;
verificado que el contrato sigue mordiendo con una copia no revisada real. `tsconfig.json`
pasa `moduleResolution` de `node` (modo node10 retirado) a `bundler`, el modo que corresponde
al build vía esbuild.

**H7.4 está implementado técnicamente y H7.5 distribuye `0.1.18` mediante GitHub Release y BRAT.** El
release package parte de un build nuevo, contiene únicamente `manifest.json`, `main.js` y
`styles.css`, valida versiones y tag, escanea los bytes staged y genera ZIP reproducible + SHA-256
con prueba causal. CI conserva permisos de solo lectura, recrea un staging enumerado y sube
exactamente ZIP, checksum e instalador tras el gate.
El instalador verifica de nuevo paquete e identidad, serializa instalaciones, revalida directorios y
estado antes de operar, escribe solo los tres ficheros gestionados y revierte fallos bajo la misma
autoridad desde los bytes originales capturados; backups alterados y fallos de cierre del lock quedan
en rojo sin dejar aplicada la versión nueva. El staging relee y compara los tres bytes antes del upload
y el censo impide otra acción de artifact. Una sustitución de directorio se bloquea sin tocar el destino
ajeno. El tag y la GitHub Release `0.1.18` publican los tres assets individuales requeridos por BRAT;
la instalación/actualización real en Obsidian sigue pendiente de QA humana en las plataformas
soportadas.

**H7.2, H7.3 y H7.6 están implementados técnicamente, sin afirmar QA humana.** El README conduce desde
un artifact verificado hasta la primera sesión, explica que **Open companion** abre la vista y que
**Finish farming session** solo aparece tras un inicio realmente activo, separa modo manual/asistido y
expone límites de exactitud e Inventory Advisor. La guía de clave distingue conexión-only, mínimo real
`account + characters + inventories + builds` y permisos opcionales de cobertura. Soporte aporta un
issue form cerrado con versión, plataforma, origen, detección, fase y reproducción; prohíbe secretos,
identidad, rutas, inventario/snapshots, IndexedDB y salida sin redactar. El contrato ejecutable y sus
sabotajes impiden relajar esos campos o habilitar issues en blanco en silencio.

**H7.1 fija la identidad de la release publicada.** El ID `tyrian-companion`, el nombre
**Tyrian Companion**, el autor público **David**, el repositorio `fodaveg/tyrian-companion` y la
licencia MIT quedan ligados por un contrato ejecutable. La comprobación oficial fijada del
2026-08-16 no encontró colisiones de ID o nombre en registros activos ni retirados de Obsidian.
El repositorio es público desde el 2026-08-29. La release actual es `0.1.19`, la versión que declaran
`manifest.json` y `package.json`; su fecha de publicación no está registrada aquí.

H5.10 añade exportación manual y fail-closed del historial durable: solo consume notas H5.4/H5.7 íntegras, ordena resultados de forma determinista y crea JSON/CSV sin contenido humano ni identificadores crudos. Ajustes ofrece además un scrub warning explícito con preview y confirmación ES/EN: un token efímero ligado a bytes/path/ref, consumido o revocado en toda salida, usa `Vault.process` CAS para quitar solo `tc_*` y los seis bloques intactos, sin papelera ni borrado físico. Una autoridad compartida excluye transiciones de sesión, recovery y detector durante el scrub y relee el runtime antes de cada escritura.

**H0.4, H0.6, H8.1 y H8.4: política y contrato v2 documentados; H8.5/H8.6 implementan ambos extremos, H8.7 prepara el lanzamiento sin executor y H8.8 añade la política shadow aislada, pero integración, validación multiplataforma y piloto siguen pendientes.** El MVP es
API-only con Linux + Steam/Proton como plataforma primaria, macOS + CrossOver como secundaria y
Windows en beta. H8.1 fija Mumble Link para v2 como helper IPC opt-in de mapa/actividad: defaults
revisables deshabilitado/shadow/on-when-armed, API v1 autoritativa,
confirmación humana, raw no persistente, payload mínimo, `initialSequence:0` y transporte loopback
fail-closed. Las tasas de falso inicio/parada, recovery y precisión
temporal tienen definición, muestra mínima y umbrales verificables en
[Política de plataformas e integraciones](PLATFORM_POLICY.md).

El contrato H8.1 permanece declarativo bajo allowlist AST recursiva. El censo productivo permite
exactamente ese contrato, los módulos TS puros H8.6/H8.7/H8.8 y los seis módulos Rust H8.5; el scanner
y sabotajes mantienen en rojo cualquier módulo/helper adicional o capacidad de sesión, store, red,
filesystem, logging o timer global. La API oficial confirmó el mapa `866` como **Mad King's
Labyrinth / Laberinto del Rey Loco**. No existe executor host, composición, setting ni conexión
con H3.8/H5.3; el adapter H8.7 sigue siendo una frontera pura e inyectada.

H8.2 aporta bajo `spikes/h8-mumble-crossover/` un decoder C portable, un wrapper PE de lectura
`FILE_MAP_READ`, muestreo best-effort de pares completos idénticos con ocho intentos, fixtures
adversariales tick-igual/map-híbrido y tearing, guard de censo/capacidades, ASan/UBSan y sabotajes
causales de offset/5.460/512/ocho pares/entero seguro. El guard fija una sola apertura y un solo map
read-only, censa llamadas/sumideros del core, wrapper, stub y script, y mantiene `npm run check` sin
Wine/CrossOver ni copias fuera del temporal. El extractor léxico no acepta llamadas buenas fingidas
en comentarios/literales y detecta el permiso decimal `2u`; el host usa un contrato positivo byte a
byte de todos sus comandos y destinos temporales, no una blacklist. El preprocesador del wrapper
está igualmente cerrado a un define inocuo y cinco includes exactos:
no puede redefinir permisos, nombre del mapping, bytes del view ni introducir aliases contractuales.
Además, la lane usa el mismo `cc` y stub para generar el wrapper preprocesado y valida allí los
argumentos expandidos `0x0004u`, `MumbleLink` y `5460u`; hashes exactos cubren wrapper, core header,
stub y validador. Redefiniciones desde headers, `%:` o continuaciones de línea quedan rojas por el
resultado efectivo, no por una blacklist de grafías.
No se presenta como seqlock ni como snapshot coherente: dos
lecturas híbridas idénticas siguen siendo un riesgo residual y la señal permanece shadow. El primer host inspeccionado fue macOS 26.6.1 ARM,
con CrossOver 26.3.0 y botella win64 `Guild Wars 2`, sin MinGW/LLVM Windows cross-compiler: allí el
test portable quedó verde pero no se instaló nada, no se copió nada a la botella ni se ejecutó un PE.
Esa sigue siendo la situación de macOS/CrossOver.

**QA humana ejecutada el 2026-08-19 en Linux/Steam/Proton.** Host Fedora Linux 44, kernel
`7.1.8-200.fc44`, `mingw64-gcc` 16.1.1 y `protontricks` 1.14.0; PE x86-64 compilado fuera del prefijo
en `/tmp` y lanzado con `protontricks-launch --appid 1284210` y `STEAM_COMPAT_DATA_PATH` sobre el
prefijo `compatdata/1284210`, que corre **GE-Proton11-5**, no Proton estable de Valve. No se instaló
ni copió nada dentro del prefijo. Resultados:

- **Muestras repetidas:** dos tandas de diez ejecuciones con el juego abierto y el personaje quieto.
  Las veinte devolvieron una única línea JSON con `sequence:0` y `activity:"link_advancing"`, cada una
  con su nonce de 128 bits distinto y correctamente devuelto, y con `uiTick` estrictamente creciente
  (13.625→16.962 y 572→4.131, saltos de 353-405). No se observó ninguna pareja de lecturas idéntica.
- **Transición de mapa:** `mapId` pasó de `1442` a `1595` al cambiar de zona, contrastados contra
  `api.guildwars2.com/v2/maps` como Seitung Province y Shipwreck Strand.
- **Reinicio del juego:** tras cerrar y reabrir GW2 el `uiTick` se reinició de 16.962 a 572 en el
  mismo mapa, lo que ata la señal al proceso vivo y descarta que se estuviera leyendo un mapping
  rancio superviviente.
- **Contrato de payload:** ningún frame contuvo identidad, personaje, coordenadas, identificadores de
  proceso ni contexto crudo.
- **Control negativo:** con GW2 cerrado, diez ejecuciones consecutivas no emitieron frame. El wrapper
  no imprime nada cuando falla y solo señala por código de salida, así que se repitió una corrida sin
  tubería y sin silenciar stderr: devolvió `exit=2`, o sea `TC_MUMBLE_PROBE_VIEW_TOO_SMALL`, que es lo
  que retorna el wrapper cuando `OpenFileMappingW` da `NULL`. El stderr de esa corrida trae
  `ntsync: up and running` y los `loader_init` de wine-staging 11.0, de modo que el proceso Windows sí
  arrancó y la salida vacía no se explica por un lanzamiento fallido.
- **Propagación del código de salida:** para descartar que ese `2` lo produjera `protontricks-launch`
  y no la sonda, se lanzó el mismo PE sin argumentos, que por su propio `main` debe devolver
  `TC_MUMBLE_PROBE_INVALID_ARGUMENT`. Devolvió `exit=1`. El canal transmite el código del PE sin
  alterarlo, así que el `2` del control negativo significa lo que dice.

Por tanto la lectura estable durante una sesión real, las transiciones, el reinicio y la ausencia de
mapping con el juego cerrado dejan de ser QA pendiente **en Linux/Steam/Proton bajo GE-Proton**;
quedan abiertos Proton estable de Valve, macOS/CrossOver y Windows nativo. El riesgo residual de dos lecturas
híbridas idénticas no queda refutado por estas veinte muestras: no se observó, que no es lo mismo que
no poder ocurrir. La señal permanece shadow y la API sigue siendo autoritativa.

**H8.5: helper/servidor Rust implementado, sin integración del plugin ni publicación.** El crate
`native/mumble-helper` implementa framing/JSON estricto, auth constant-time + zeroize, nonce y
secuencia compartida, proyección de cadence y adapter Win32 read-only de cuatro campos/ocho pares.
Un watchdog stdin y event loop acotado prueban EOF, slowloris, cliente extra, reconnect con token del
mismo proceso y nonce/secuencia nuevos. Cargo host está verde; CI Windows debe confirmar PE x64,
CRT estático y reproducibilidad y solo puede conservar un marker `UNSIGNED-NOT-FOR-RELEASE` por un
día. Windows, Proton y CrossOver siguen `QA=pending`; Authenticode, package productivo, launcher,
settings y UI siguen pendientes. Por tanto H8.5 está implementado, pero no cerrado para release.

La cadencia servidor consume raw tick/map/status: primer slot a 500 ms, warm-up sin historia,
segundo válido abre época advancing, stalled exacto a 1.500 ms, lateness reprogramada desde now y
`heartbeat_timeout` exacto a 2.000 ms sin emitir ni recuperar slots perdidos.

**H8.6: núcleo aislado del cliente TypeScript implementado, sin launcher ni wiring.** Cuatro módulos
puros aportan codec incremental cerrado, lifecycle por puertos inyectados de proceso/TCP/reloj/CSPRNG,
salud en tres ejes y observación shadow memory-only de `mapId + activity` bajo `enabled && armed`.
Token por proceso, nonce por conexión, secuencia `0,+1`, deadlines y generaciones fallan cerrados;
callbacks externos quedan aislados ante throw/reentrada. Restart y reconnect comparten el backoff
`[250,500,1000,2000,5000]`, que solo se resetea tras `healthy`. No hay imports Node, I/O ambiente,
timers globales, sesiones, stores, captura, persistencia ni logging. Las 42 pruebas H8.6 cubren
fragmentación/coalescing/huge, replay/gap/wrap, primer sample, helper exit/backoff, callbacks stale,
salud unavailable vs stalled y sabotajes arquitectónicos. Launcher real, composición en `main`,
settings/UI, packaging y QA de plataforma siguen pendientes.

**H8.7: frontera safe-launch aislada implementada, todavía `@wip`.** Tres módulos puros fijan
config/route/diagnostic cerrados y planes exactos para Windows, CrossOver `wine` y Proton
`protontricks-launch`. AppID `1284210`, `MumbleLink` y launchers son constantes; no hay
args/env/shell/command/mapping libres. Package/bottle/compat-data son estrictos y efímeros; el plan
usa `shell:false` y tres pipes. El adapter abre el paquete H8.5 canónico de cinco ficheros antes de
cada intento, valida manifest + cuatro checksums y delega solo una capability opaca ligada a
bytes/digests, nunca un helper path re-resoluble. Drena stderr, aplaza un stdout inline de máximo 516
bytes y revalida antes de abrir la entrega; overflow, segundo evento, exit o un aplazamiento inline
cierran el handle una vez, publican diagnóstico saneado y notifican exit a H8.6. Stop es idempotente. El resultado se etiqueta
solo `integrity_checked` / `unsigned_qa_only`: no autentica
origen. No hay Node, spawn real, settings/UI/main/onload, persistencia, composición ni QA. Un executor
futuro debe exigir trust anchor de release o Authenticode y revalidar cada arranque/restart.
Las 25 pruebas H8.7 —16 funcionales y nueve arquitectónicas— cubren planes/plataformas/paths,
paquete compartido H8.5, artefactos corruptos, capability/TOCTOU, stderr/stop, callbacks acotados y sabotajes
de capacidades, incluido un único call-site de capability dentro del método hasheado y hash del adaptador completo; scanner v13 y
guard v17 mantienen el censo exacto.

**H8.8: política shadow de presencia/ausencia implementada y cerrada en su alcance aislado.** El
reducer puro solo acepta el mapa objetivo `866`: fija presencia tras 5.000 ms de crédito y ausencia
tras 60.000 ms de crédito. La primera solo acumula en idle y la segunda durante una sesión
ligada; cada record aporta como máximo 500 ms. Gaps, heartbeat/source degradation, `link_stalled`, caída de canal y
recovery reinician o degradan la ventana y nunca se interpretan como ausencia. Cada latch produce
como máximo un DTO efímero con evidencia `limited` y review `human_required`; muestras posteriores
del mismo estado no lo reemiten. La señal liga `accountId` dentro de su contexto efímero en idle y
sesión; un cambio de cuenta reinicia ventana y latch. El DTO no entra en la cola H5.3, no persiste,
no llega a UI y no invoca captura ni lifecycle. La API sigue siendo autoritativa. La composición,
las métricas comparativas y la QA humana en Windows, Linux/Steam/Proton y macOS/CrossOver pertenecen
a la salida posterior de shadow —H8.9–H8.15— y no reabren el criterio aislado de H8.8. La congelación
de H8 hasta completar H8.2 permanece intacta.

**H8.3: ADR de lenguaje/artefacto que autorizó la implementación.** Se elige Rust
provisionalmente, target único `x86_64-pc-windows-msvc` con CRT estático, fuente futura
`native/mumble-helper` y un único `tyrian-mumble-helper.exe`. El ZIP será separado del plugin y
llevará manifest, checksums y licencias. Linux/Steam/Proton primaria, macOS/CrossOver secundaria y
Windows x64 beta siguen `QA=pending`; ejecución nativa Linux/macOS, Windows x86/ARM64, móvil y Wine
fuera de Steam/Proton/CrossOver quedan unsupported. Authenticode sigue pendiente y bloquea release.
El guard v17 y sus sabotajes mantienen un censo positivo, incluido el orden causal que publica
shutdown antes de desconectar stdin para que EOF previo al bootstrap sea limpio también en Windows. Fuera de
docs/examples/fixtures/tests, fuente Rust/C#, configuración Cargo/toolchain exacta y señales de
prefijo Mumble Link por path o contenido quedan censadas globalmente; outputs
EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA tracked/no ignorados y symlinks relevantes siempre fallan. Un PDB
efímero de MSVC se permite únicamente bajo `target`; staging, paquete y artefacto CI lo rechazan.
Un `bridge` genérico continúa permitido. El bloque JSON, el ADR y `PLATFORM_POLICY.md` completo tienen
parsing/hash canónicos, de modo que `QA completada` tampoco puede añadirse al final del documento.
H8.5/H8.6 aportan servidor y cliente core y H8.7 el plan/adapter inyectado, pero no wiring del plugin ni artefacto publicable.

**H8.4: protocolo IPC local cerrado; H8.5/H8.6 lo implementan aún sin composición.** Helper servidor y
plugin cliente quedan fijados a TCP IPv4 `127.0.0.1`, bind port `0`, bootstrap/ready por
stdin/stdout y hello/welcome TCP. Todos los records usan `uint32` big-endian + JSON UTF-8 1..512 y
buffer incremental máximo 516 incluso con chunks enormes; los seis schemas, credenciales base64url,
binding bootstrap→hello y comparación constant-time, secuencia
conjunta heartbeat+sample, un único record por llamada debida de 500 ms —sample derivado de tick/map
raw sustituye heartbeat y satisface liveness—, calentamiento sin retener tick, segunda lectura como
nueva época advancing, borrado de tick/startedAt en source-status y primer record limitado a
heartbeat, stalled exacto 1.499/1.500 ms, lateness sin catch-up y fallo `heartbeat_timeout`, deadlines
2.000/5.000 ms, lifecycle,
backoff y errores están cerrados en el modelo y ADR parseable con igualdad/orden/hashes completos.
Los tests cubren framing fragmentado/coalescido/truncado, parser estricto, token/nonce y superficies,
host/puerto/versión, replay/gap/regresión/overflow/stale nonce, tick rollover, fake clock/sleep,
records fuera de fase, routing total de helper-exit —incluido reconnect—, token/puerto/nonce nuevos,
samples que renuevan salud, reset solo healthy, reconnect/EOF, high-water simultáneo sin copia,
cadencia con fake clock, recovery con tick stale, salto de 60 s y sabotajes de catch-up,
doble/ningún record, warm-up infinito, sample prematuro, heartbeat `healthy`, source status y datos
prohibidos. El censo conserva el contrato y los módulos H8.5/H8.6/H8.7/H8.8 exactos, sin importadores desde
`main`. No existen executor host, composición, settings/UI o packaging productivo; API
v1 sigue autoritativa, shadow, human-confirmed y sin persistencia.

H5.1 sustituye la portada de tarjetas por una bitácora compacta con fase y reloj de sesión, rail de detector/polling/calidad/cuenta, incidencia priorizada y detalles plegables; no añade red ni acciones automáticas.

H5.2 añade paleta y un único ribbon contextual para start, finish/retry, review, recover, discard confirmado y clear confirmado, siempre mediante los workflows existentes y con revalidación ante estado stale.

H5.3 añade una cola local durable para propuestas asistidas: enqueue previo al rearmado, intención exacta, claims renovables cercados por operación/ventana, receipts tras resolución, reconcile de identidad y una única propuesta visible con contador. El fondo solo actualiza indicadores existentes in-place: no reconstruye la vista, muestra notices/modales/notificaciones, enfoca, revela vistas ni ejecuta transiciones de sesión.

H5.4 genera mediante Vault una nota de sesión completa antes de permitir limpiar el runtime. Usa referencias SHA-256, ruta UTC, frontmatter `tc_*` estable y managed blocks hasheados; conserva tags/frontmatter/cuerpo humano y falla cerrado ante identidad, colisión o edición ambigua.

H5.5 deriva desde la evidencia H5.4 una única presentación de botín para nota y Companion: cambios netos, destino reservado/retenido/libre, subtotal económico y recomendación manual. Respeta permisos H2.7 y falla cerrado ante incoherencias H4 sin ocultar las filas físicas observadas.

H5.6 añade el motor genérico de assets administrados y una Base neutral. Preview no escribe; install/upgrade/repair usan manifiesto v1, CAS exacto y journal durable reanudable. Rutas inseguras, assets ajenos/modificados y formatos futuros fallan cerrados. Move instala destino antes de cambiar el puntero y Remove manda solo bytes propios exactos a la papelera de Obsidian, conservando manifiesto detached.

H5.7 sube las notas a schema v2 con evento, fuente manual/asistida correlacionada y recomendación histórica validados, y registra `Halloween.base` ES/EN en el bundle v2 sin un segundo writer. Sus cinco vistas filtran el evento explícito, separan cero de ausencia y reservan g/h a sesiones exactas, de confianza alta y cobertura completa. Falta QA manual en una bóveda desechable compatible con Bases; no se ha tocado la bóveda canónica.

H5.8 centraliza el contrato de rutas Vault para settings, notas y assets: solo NFC relativo con `/`, sin segmentos de navegación/configuración, controles/surrogates inválidos, nombres reservados de Windows ni longitudes que comprometan Sync. Settings v4 se reescribe de forma canónica al normalizar: elimina propiedades desconocidas y solo conserva las rutas pre-H5.8 autorizadas en `legacyOutputFolder`/`legacyManagedAssetsRoot`, read-only y sin alterar el puntero de assets. Move/Remove inspeccionan siempre la raíz heredada y rechazan un puntero divergente o manifiesto no exacto. Move exige estado ready incluso si el puntero ya la nombraba. Un Remove reintentado reconoce ese manifiesto exacto ya detached sin escribir ni volver a adoptarlo solo con puntero inicialmente vacío e idéntico tras la inspección, para terminar la limpieza de settings tras perder una respuesta. Una reubicación explícita instala primero el destino seguro y después elimina solo bytes propios de esa raíz. Manifiesto y journal ligan id/kind/locale/path y hashes previos permitidos; ready/detached exigen el conjunto exacto del bundle actual sin romper manifiestos compatibles previos. Las notas de sesión usan UTC y hashes; las de inventario usan item, fuente y hash. Ningún nombre incorpora cuenta, nombre de personaje, evento o ruta local.

H5.9 centraliza el texto visible ES/EN en un catálogo tipado con paridad de claves/placeholders: ajustes, Companion, incidencias, acciones, menús, modales, notas, botín y Bases cambian sin alterar IDs, enums, `tc_*`, hashes, rutas o consultas de Bases. La interfaz abierta se repinta y el bundle gestionado cambia con el idioma; los comandos ya registrados por Obsidian adoptan el nuevo nombre tras recargar el plugin.

H6.1 fija por regresión las seis direcciones entre personaje, banco y materiales —incluido split/merge— y comprueba holdings y composición exactos sin generar loot ni disponibilidad falsos. H6.2 recorre el workflow durable completo para apertura, reciclaje, compra en bazar y compra a mercader: persiste la revisión, reinicia una segunda instancia y conserva clasificación contaminada y permisos; la actividad del bazar sigue siendo una declaración explícita, no observación automática.

H6.3 fija que jackpots excluidos no alteran el EV ni la decisión y que un precio TP cero permanece `null/partial`. H6.4 recupera `stopping` y `provisional` sin recapturar evidencia, y prueba la cancelación real del modal sin backend ni mutación; no existe una acción inventada de cancelar sesión activa. H6.5 cubre 500/502/503/504 reintentables, 401/403/501 fatales y agotamiento 5xx con error saneado.

H6.6 añade un benchmark reproducible de cuenta grande, aislado de I/O: fuerza una primera pasada divergente y dos convergentes mediante la ruta pura productiva, finaliza snapshots estables, los compara, clasifica la frontera y valora 4.840 ganancias. Sus 21 muestras fijan mediana/p95 y la retención acumulada contra un baseline único post-warmup; CI prueba verde y sabotaje de heap explícito en Node 22 y 24, sin usar la duración de Vitest como evidencia.

H6.13 (`abea4e1`) corrige la sesión cuando un personaje devuelve `404` entre la pasada base y la de cierre. El diagnóstico inicial era al revés: la clasificación salía `invalid` y se perdía el delta entero de la cuenta, y `manual-session-start-service.ts` exigía una referencia de snapshot estable antes de calcular el delta, así que el 404 dejaba el `stop()` colgado en `stopping`. Ahora una pasada cuyo único hueco es `missing_character` no se descalifica, el personaje ilegible se excluye de las dos proyecciones con el delta en `limited` y el aviso nuevo `character_unobserved`, que degrada la clasificación a `estimated` en vez de `contaminated`. Un `500` (`unavailable`) sigue invalidando el delta entero por decisión de producto asumida, pendiente de ratificar por David si el 404 excusable entra en el gate de v1 (H7.8) o se aparta a post-MVP.

H6.16 sustituye cuatro suites de test de `src/advisor/` y `src/economy/` que leían el texto fuente con expresiones regulares por tests de comportamiento ejecutados, y añade `src/test/module-boundary.ts` y `src/test/ambient-capabilities.ts`. El sabotaje S14 (meter `this.ports.invalidate?.()` dentro de `current()` del controller del Inventory Advisor) probó que la regex conservada no se ponía roja y el test de comportamiento nuevo sí: los guardarraíles léxicos declaraban más cobertura de la que tenían.

H4.13 define la frontera pura del Inventory Advisor para `supported_storage_v1`. Liga snapshot, catálogo, precios, objetivos, excepciones de conservación, señales de cuenta y rule pack hasheado; valida particiones exactas de toda la propiedad por posición y devuelve un envelope manual separado del envelope de sesión. No existe acción `destroy`: `discard_candidate` requiere regla curada y permanece revisión irreversible. H4.14 captura la evidencia, H4.15 clasifica y H4.16 aplica la allowlist pura. H4.18 aporta un bundle built-in v2 inmutable y source-backed para 36038. H4.19 extrae el kernel económico H4.10 independiente de sesión, captura en Refresh el saco y sus ocho outcomes líquidos y liga modelo/regla/knowledge/TTL/cobertura/binding/reservas/excepciones. David aprobó regla y economía el 2026-08-16: evidencia completa y fresca puede recomendar manualmente `open|sell|vendor` para 36038 con margen fijo del 10%; evidencia parcial o incoherente sigue en revisión y descarte continúa deshabilitado. Los demás items pueden mostrar la mejor salida líquida manual respaldada sin habilitar uso/abrir/reciclar. H5.11 conecta una vista separada ES/EN: Open no captura; Refresh es el único trigger y compone las capas con single-flight/latest-wins. Desde H6.26 la vista usa como máximo dos observaciones acotadas de bolsas de personaje+compartido como núcleo; solo su equivalencia completa produce `stable`. Banco, materiales y delivery siguen como ámbitos opcionales desmarcados por defecto. Cada control muestra cobertura saneada y se deshabilita si su fuente no fue leída; un 403 opcional no bloquea el núcleo y un 401 conserva el fallo global de credencial. Añade icono oficial, progreso real y conserva el último resultado solo ante `capture_unavailable`. H5.12 añade el editor plegable local de objetivos y excepciones. H6.11 está cerrado por auditoría automatizada; sigue pendiente la QA visual/manual ES/EN de la ruta activada.

El inventario durable está integrado en el Inventory Advisor como flujo manual independiente:
Preview captura las cuatro fuentes físicas completas y prepara un plan Vault-only; Apply relee y usa
CAS. El writer genera una nota por objeto, ubicación y personaje, suma pilas del mismo personaje y
marca stale como inactivo/cero sin borrar archivos. No persiste cuenta, snapshot, token ni payload
raw. El bundle gestionado v5 conserva `Inventory.base` y `Materials.base` ES/EN con orden numérico por
valor y corrige sus nombres visibles mediante `properties.note.tc_*`. Falta QA visual/manual dentro de Obsidian y comparación contra los scripts legacy antes de que
David los retire.

H4.19 añade el kernel económico independiente de sesión, el adapter/pack de economía del Advisor, captura hermana de precios, integración contextual y guards causales. Gate completo verificado: lint, 94 ficheros/1315 tests, release-preflight, scanner de seguridad y build en verde.

El hotfix de datos reales del Inventory Advisor alinea el catálogo JSON, respuestas parciales 206,
la captura hermana H4.19 y la allowlist contextual. Una lectura real de solo lectura produjo snapshot
estable con las seis fuentes completas y una presentación `limited` de 1.206 objetos/1.701 posiciones,
todas en revisión manual; la clave y los endpoints requeridos respondieron correctamente.
Cada Refresh reemplaza un recibo diagnóstico local saneado con estado, duración y cobertura por
pasada/fuente; excluye secreto, identidad, personajes, objetos, URLs y cuerpos, y nunca se sube.
**Estado histórico anterior a H6.26.** La QA visual real aisló `snapshot_invalid`: el Advisor heredaba
el contrato account-wide y exigía banco y materiales estables aunque estuvieran desmarcados. En aquella
versión, el flujo capturaba únicamente personaje + inventario compartido, validaba ese scope de forma
independiente y conservaba fail-closed las fuentes básicas; banco/materiales/delivery no se consultaban
ni podían bloquearlo. Una única pasada completa se conservaba como `unstable/limited`, mostraba rutas
líquidas manuales y retenía usar/abrir/reciclar. Cada intento consultaba una vez roster, inventario
compartido y personajes serializados con timeout de 30 segundos; solo una pasada parcial transitoria
repetía el conjunto. El clasificador evalúa catálogo/precio por objeto: un batch TP parcial no oculta las filas
con precio presente ni las rutas de mercader con omisión demostrada; en esa QA, el pack todavía pendiente
retenía sus capacidades curadas. La vista prioriza ahora una cola directa «Qué hacer ahora» y relega
`keep|review|discard_review` a controles de contexto. Gate: 106 ficheros/1481 tests en
verde; queda pendiente repetir
la QA manual del plugin instalado y confirmar filas reales visibles.

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 define el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`. H3.2–H3.10 cubren captura manual, recovery durable, detección asistida explícita, revisión de contaminación y medición local de calidad. H4.1–H4.12 añaden valoración, reservas, intenciones y recomendaciones manuales puras; no operan sobre la cuenta. H5.12 persiste objetivos y excepciones locales con CAS explícito. No hay persistencia de recomendaciones, operación sobre la cuenta ni escritura libre en el vault: H5.4 solo genera notas completas con bloques gestionados, H5.6 solo modifica assets tras una operación explícita y H5.10 exporta o scrubbea únicamente mediante acciones explícitas. H9.7 agrega ese historial en Companion después de una carga manual, sin leer el vault al abrir la vista.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 115 ficheros y 1.579 tests verdes (la sesión empezó en 1.562: sube con H6.13 y
  con la poda de guardarraíles léxicos de H6.16), incluidas las 2 pruebas nuevas del orden de
  arranque diferido, las 13 del cooldown 429 compartido H6.12, 42 pruebas H8.6 —33 funcionales y nueve
  de arquitectura—, 25 H8.7 —16 funcionales y nueve de arquitectura— y 25 H8.8 —17 funcionales y
  ocho de arquitectura—, los contratos H8.1/H8.4 y el
  verifier de supply-chain/staging H8.5, más la lane C H8.2 normal/ASan/UBSan, syntax-check del
  wrapper y cinco sabotajes causales. Rust añade 14 unitarios y ocho lifecycle verdes.
- `npm run check` (gate completo): vitest, eslint, `scripts/h8-native-decision-contract.mjs` y
  `scripts/security-scan.mjs` excluyen los worktrees de agente bajo `.claude/`; exit code 0 en 42
  segundos sobre el árbol final (`69dc795`), 115 ficheros/1.579 tests más las ocho suites de scripts, el
  scanner de seguridad y el build. `src/eslint-default-project-config.test.ts` y
  `src/platform/mumble-v2-shadow-architecture.test.ts` dejan de caer al azar por presupuesto de
  tiempo: presupuesto explícito de 30 s y lectura del árbol de `src/` memoizada con copia por
  llamada. Ninguna aserción cambia y sus controles negativos siguen poniéndose en rojo.
- `npm run test:security-scan` y `npm run security:scan`: scanner v14 y sabotajes verdes.
- `npm run test:release-identity-contract`: identidad H7.1 y veinticuatro sabotajes causales verdes.
- `npm run test:beta-channel`: instalación, actualización, exclusión mutua, rollback y matrices
  causales de ZIP, rutas, symlinks, TOCTOU, CLI, staging y artifact CI verdes; no sustituye la QA
  dentro de Obsidian.
- `npm run build`: TypeScript y bundle de producción verdes; H8.7 no entra en `main` ni ejecuta proceso alguno.
- `npm run release:package`: paquete de tres archivos, checksum y segunda ejecución byte a byte reproducible en verde; debe regenerarse tras integrar cualquier otro lote.
- `npm run bench:h6-performance` y su sabotaje de heap: verdes en Node 24.19.0.
- H7.2/H7.3/H7.6 añade `test:support-contract`: formulario, docs y dieciocho sabotajes causales verdes;
  `npm run check`, benchmark, sabotaje de heap y `git diff --check` pasan en este worktree. No existe
  todavía evidencia de instalación, primera sesión o soporte real en dispositivo.

## Publicación de la 0.1.22 (2026-09-03)

Publicada desde el tag y commit `5ab35766e6db01dde84cad9607a3a99fb2dfe42c`, que es también
`origin/main`. La creó el workflow `Release` al empujar el tag, con los cinco assets y contrato BRAT
`PASS (version=0.1.22; assets=5)` contra la salida real de `gh release view`. Los tres ficheros
publicados se descargaron y coinciden byte a byte con los construidos aquí (`main.js`
`c1404e00…4e7561`). Tres runs de CI en verde sobre ese SHA: `33732841358`, `33732841344` y
`33732840955`. Gate local antes de etiquetar: `check` 22/22, `test` 18/18, 2.632 tests en 194
ficheros, `tsc --noEmit` exit 0.

Instalada en la bóveda real y verificada por `sha256sum` contra los ficheros publicados, sin tocar
`data.json`. **La copia se hizo con Obsidian abierto**, así que hasta que se recargue el plugin en
memoria sigue corriendo la `0.1.21`: canal publicado, runtime pendiente.

Lo que esto **no** acredita, y sigue siendo lo único que bloquea: que el banner del sistema con
`urgency: critical` cruce por encima de Guild Wars 2 en ventana sin bordes y en pantalla completa
exclusiva bajo GNOME, y que una sesión de farmeo repetida salga ahora `estimated` con banda en vez
de con el veredicto económico suprimido. Las dos son pruebas humanas y no se han ejecutado.

## Deuda conocida

### H13.1 — Primera ejecución humana (2026-09-03)

**La primera ejecución humana en 21 releases ocurrió el 2026-09-03**, sobre la `0.1.21`, en Linux y
en la bóveda real, no en la desechable `~/tyrian-qa-h13-1` que el protocolo pedía. La sesión duró 53
minutos y 51 segundos y completó el ciclo entero: inicio, captura, fin, revisión y nota escrita en su
carpeta y su año, con SHA-256
`c88707937efc11fecef7aaa72b4adf1edd59e64a4d8753d6c0b31d648d74a02a`. La tubería cableada en la
`0.1.21` respondió, incluidas las junturas de reserva y hold (`tc_reservation_status: "complete:met"`,
`tc_hold_status: "released"`).

**El veredicto económico salió suprimido, y ese es el defecto que compra esta ejecución.** Todos los
campos `tc_*_copper` y `tc_*_per_hour` salieron `null`, la recomendación quedó en `not_evaluated` y
las 40 filas de botín dicen «Oculto por fiabilidad», en una sesión que había ganado 46.083 cobre. El
disparador fueron dos monedas del monedero bajando una unidad cada una, la `37` (Exalted Key) y la
`42` (Vial of Chak Acid), que es lo que cuesta abrir un cofre con su llave. El arreglo es H13.6.
Hasta que aterrice, el producto no da su número en una sesión de farmeo normal.

Que no saltara ningún aviso sí es lo esperado: `halloweenEnabled`, `priceHistoryEnabled` y
`halloweenPriceAlertEnabled` existen en la `0.1.21` y vienen en `false` por defecto. El aviso sin
interruptores llegó después, en `6706d47`, y no está en ningún build instalado.

### QA manual: una sola sesión ejecutada, en una sola plataforma

Salvo esa sesión, los once pendientes de abajo son la misma deuda repetida: **QA manual que no se ha
ejecutado en ninguna plataforma**, ni en el resto de Linux, ni en macOS/CrossOver, ni en Windows. Los
contratos ejecutables en verde, las guías escritas (`docs/QA-MVP.md`) y las releases publicadas no
acreditan ninguna de estas líneas;
por eso los lotes anteriores repiten que su publicación no acredita la QA. La única excepción de la
lista es el punto 5, cuya parte abierta es una decisión de producto de David y no una prueba; los
puntos 6 y 8 están cerrados en implementación y solo conservan QA residual.

1. Repetir el spike H8.2 en macOS/CrossOver, Windows nativo y Proton estable de Valve, donde todavía no se ha ejecutado ningún PE; después implementar executor con trust anchor y composición de H8.5/H8.6/H8.7/H8.8, ejecutar QA separada —incluidos los latches 5 s/60 s, gaps, stalled, heartbeat y recovery— en Linux/Steam/Proton, macOS/CrossOver y Windows x64 antes de salir de shadow, y resolver firma/licencias antes de release.
2. Ejecutar la matriz H0.4 por plataforma y reunir la muestra del piloto H0.6. H7.13 ya agrega y
   exporta localmente la evidencia en `0.1.18`; todavía faltan el dry run instrumentado en
   Linux/Steam/Proton, macOS/CrossOver y Windows beta y la ejecución real de H7.7.
3. Ejecutar QA visual de H9.7 en Obsidian con temas claro/oscuro, anchos 1280/900/600/420/280,
   textos largos y listas grandes; la implementación automatizada ya está publicada en `0.1.18`.
4. Ejecutar QA manual ES/EN de la recomendación activada para 36038 con evidencia real completa y parcial.
5. Cerrado por H6.13 (`abea4e1`): un personaje que devuelve `404` (`missing_character`) entre pasada base y de cierre se excluye de las dos proyecciones y el delta pasa a `limited` con el aviso `character_unobserved`, en vez de invalidar el delta entero de la cuenta. Un `500` (`unavailable`) sigue invalidando el delta entero. Decisión de producto pendiente de ratificar por David: si ese criterio del 404 excusable entra en el gate de v1 (H7.8) o se aparta a post-MVP; hoy queda etiquetado `#v1` sin que él lo haya decidido.
6. ~~Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.~~ Cerrado por H6.12 (`7f97d44` y `61a20dc`): `RateLimitCoordinator` comparte un único enfriamiento entre captura de sesión, detección asistida e Inventory Advisor, y lo arma también con el 429 de una fuente opcional que `captureSource()` convierte en cobertura parcial de una captura que resuelve. Los reintentos por petición siguen siendo del transporte. H6.21 añade en `0.1.18` el copy específico para cada fallo de inicio y fin; quedan pendientes su QA visual ES/EN y un `429` real en Obsidian.
7. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
8. ~~Consultar el historial TP para complementar la declaración manual H3.9.~~ Cerrado por H9.8
   (`3e84514`, `ed7f8b8` y `f825621`): el modal puede proponer compras y ventas desde un historial
   completo de hasta 90 días, pero solo la confirmación humana modifica la revisión.
9. Hacer QA manual de H3.2–H3.4 en dos ventanas y, si Obsidian comparte el origin, dos procesos reales: doble clic, stop/retry, reload, cierre forzado, recuperación/descarte y pérdida del lease.
10. Instalar/actualizar `0.1.18` desde BRAT en una bóveda desechable por plataforma, verificar que los
    tres assets corresponden a la release publicada y registrar el resultado; la publicación y el canal
    BRAT ya están activos, pero no acreditan esta QA.
11. Ejecutar el protocolo de QA manual que piden H6.8 y H6.9: instalación en una bóveda desechable, sesión real y matriz de plataforma documentadas en `docs/QA-MVP.md`; una guía preparada no acredita una prueba superada. El 2026-09-03 se ejecutó por primera vez una sesión real, pero en la bóveda real y en una sola plataforma: cubre la sesión y nada más, así que siguen sin ejecutarse la bóveda desechable, la matriz por plataforma, las dos ventanas simultáneas, el cierre forzado y el recovery.

### Deuda de implementación medida

No es sospecha ni estilo: cada línea trae cómo se vuelve a contar. Ninguna bloquea la release, pero
todas encarecen cada cambio posterior.

- `src/ui/wallet-vault-sync-controller.ts` y `src/ui/inventory-vault-sync-controller.ts` son dos
  copias: 131 líneas cada uno, y sustituir «Wallet» por «Inventory» en el primero deja un `diff` de
  cero líneas contra el segundo. Cualquier arreglo hay que hacerlo dos veces o se hace en uno solo.
- La función `canonical()` está reimplementada en cada dominio en vez de compartirse. El censo del
  2026-09-01 contó 24 ficheros; recontando hoy sobre `src/`, `function canonical(` aparece en 16
  ficheros y el patrón ampliado `function canonical|const canonical =` en 22. La cifra depende del
  criterio de recuento; lo que no depende del criterio es que no existe una implementación única.
- El idiom de apertura de IndexedDB está copiado en 10 almacenes:
  `sessions/session-runtime-store`, `sessions/session-detection-quality-store`,
  `sessions/pending-proposal-store`, `sessions/pilot-metrics-store`, `sessions/coordination-store`,
  `halloween/halloween-store`, `economy/price-history-store`, `catalog/persistent-catalog-cache`,
  `assets/managed-assets-pointer` y `advisor/inventory-preferences-store`. Se recuentan buscando
  `onupgradeneeded` fuera de los `.test.ts`.
- 34 ficheros de test aseveran texto fuente, no comportamiento: leen un fichero del repositorio y
  comprueban que contiene una cadena. Un renombrado los rompe sin que nada esté roto, y un cambio de
  comportamiento con el mismo texto los deja verdes. Se localizan por `readFileSync` dentro de
  `src/**/*.test.ts`, donde hoy aparece en 40 ficheros contando también los que leen `docs/` y
  `scripts/`.
