# Arquitectura

## Capas

`src/main.ts` es la composición del plugin. Registra la vista, el comando y los ajustes, y conecta adaptadores de Obsidian con servicios independientes.

- `core`: transporte HTTP resiliente, configuración versionada, acceso diferido a secretos y limitación FIFO de concurrencia.
- `account`: cliente de Guild Wars 2, validación runtime, conexión, estado efímero y snapshots de almacenamiento.
- `catalog`: cliente público, parsers de metadatos, resolución por snapshot y contrato de caché.
- `economy`: contrato monetario puro en cobre, tasas GW2 versionadas, binding, rutas líquidas por pila, snapshot de precios al cierre, valoración de sesión, modelos versionados de contenedores y reservas por objetivo.
- `advisor`: preparación y contratos puros del Inventory Advisor; captura, clasificación y UI siguen separadas.
- `inventory`: proyección sin identidad y persistencia Vault-only del inventario durable mediante Preview/CAS.
- `sessions`: coordinación cercada, máquina de estados pura y persistencia local de runtime recuperable.
- `objectives`: modelo y contrato de persistencia de objetivos.
- `platform`: contrato H8.1/H8.4, núcleo H8.6, frontera H8.7 y política shadow H8.8 puras con puertos inyectados; no contiene I/O ambiente ni executor host.
- `spikes/h8-mumble-crossover`: prototipo C no productivo y no empaquetado para validar H8.2.
- `ui`: vista y pestaña de ajustes de Obsidian.

## Frontera de release H7.4/H7.5

`scripts/release-package.mjs` es la única composición del paquete distribuible. Antes de leer el
bundle elimina el `main.js` ignorado y exige que el build de producción lo vuelva a crear, evitando
empaquetar una salida stale. La entrada queda cerrada a `manifest.json`, `main.js` y `styles.css`;
`package.json`, manifest y `versions.json` deben compartir identidad, versión y mínimo de Obsidian.

El stage se recrea bajo `.release/`, rechaza symlinks, archivos vacíos o entradas extra y pasa los tres
bytes finales por el scanner de secretos v4. El ZIP usa almacenamiento sin compresión, orden fijo,
timestamp DOS 1980-01-01, modo `0644`, UTF-8 y cabeceras ZIP32 canónicas. Una segunda lectura interna
valida directorio central, offsets contiguos, nombres, CRC y bytes contra el stage antes de emitir el
SHA-256. La reproducibilidad no depende de mtime, permisos locales, locale ni implementación externa de
`zip`.

CI ejecuta el paquete una sola vez después de que toda la matriz `check` quede verde y sube un artifact
temporal tanto para ramas como para tags. En tags, `GITHUB_REF_NAME` debe ser idéntico a
`manifest.version`. El job conserva `contents: read`: preparar un artifact no concede autoridad para
crear una release o activar BRAT. Esos actos y la QA de instalación/actualización son fronteras humanas
separadas descritas en [Canal beta y paquete de release](BETA.md).

`scripts/install-beta.mjs` es la única frontera técnica H7.5 de instalación manual. Recibe una bóveda,
un ZIP y la confirmación humana de que Obsidian está cerrado; no descubre bóvedas ni procesos. Relee
ZIP y checksum como ficheros regulares no enlazados, reproduce el contrato ZIP cerrado, valida la
identidad del manifest y exige una versión estrictamente mayor. Solo puede crear o sustituir los tres
ficheros gestionados bajo `<config>/plugins/tyrian-companion`; `data.json`, ficheros desconocidos y el
resto de la bóveda quedan fuera. El swap usa temporales exclusivos y backups por operación, pero la
fuente de rollback son los bytes originales capturados e inmutables; un backup truncado, sustituido o
enlazado no se restaura. Cualquier fallo anterior a retirar el lock revierte el conjunto completo
mientras conserva la autoridad de ruta y no imprime la ruta de la bóveda. Si
la identidad de un directorio cambia, se detiene sin operar sobre el sustituto. Un lock exclusivo cubre inspección,
staging, swap y rollback; antes de cada operación se revalida `dev+ino` de la cadena de directorios y
antes de cada rename se revalidan versión y hashes de origen/temporal. El checksum aporta integridad,
no autenticidad: el artifact de un run/SHA identificado es el ancla humana. CI recrea
`.beta-artifact`, copia allí exactamente ZIP/checksum/instalador, fija la identidad del directorio y
relee los bytes persistidos antes de validar otra vez checksum→ZIP. El censo rechaza cualquier upload
adicional o referencia distinta de la acción aprobada; nunca publica el stage interno de build.
La aceptación manual de carga o actualización tiene otro preflight separado:
`scripts/verify-beta-runtime.mjs` compara el `manifest.json` instalado con el manifest registrado y
el objeto de plugin realmente cargado que devuelve `obsidian eval`, y además exige que la evidencia
proceda de la misma ruta de bóveda. Un proceso vivo con una versión anterior falla aunque los tres
ficheros en disco ya pertenezcan al candidato nuevo. La comprobación requiere Obsidian y su CLI vivos;
no intenta inferir el runtime desde procesos ni desde el disco.

## Flujo de dependencias

```text
main -> ui -> connection service -> account gateway -> GW2 client
                                                   |
                                                   +-> core (HTTP + SecretStorage)

main -> advisor

storage snapshot service -> GW2 operation fijada -> core concurrency

storage delta comparator -> dos StorageSnapshot (puro, sin I/O)

H6.6 benchmark -> payloads GW2 deterministas -> snapshot normalizado -> delta -> clasificación -> valoración (puro, sin I/O)

public catalog service -> public GW2 client -> core HTTP
	                  -> cache adapter

economy monetary contract -> valores unitarios, cantidades y CatalogItem validado (puro, sin I/O)

reservation engine -> objetivos + balance final -> plan + overlay H4.5 (puro, sin I/O)

hold-intent engine -> libre tras reservas + intenciones de usuario + batch de mercado (puro, sin I/O)

recommendation envelope -> decisiones H4.10 + refs internas (JSON, manual, sin capacidades)

sessions ----> coordinación local + contratos puros
         \---> scheduler API explícito (sin red/timers al construir)
objectives --> contratos puros

H8.1/H8.4 contract -> H8.5 helper + H8.6 client core + H8.7 safe launch + H8.8 shadow policy aislados -/-> main, plugin o release
```

Los módulos de dominio no dependen de la UI. `ObsidianRequestTransport` es el adaptador que conecta `requestUrl` con `ResilientHttpTransport`; la política pura aplica timeout lógico, reintentos acotados para `429/500/502/503/504` —no `501`—, `Retry-After`, backoff y jitter inyectables. Los errores transportan solo tipo, estado y espera: nunca URL, cabeceras, cuerpo ni autorización.

## Benchmark H6.6 de cuenta grande

`npm run bench:h6-performance` ejecuta bajo Node con `--expose-gc` un fixture determinista de 48 personajes, 5.132 holdings normalizados y 4.840 cambios positivos valorables. Recorre parsers reales de payload y la misma ruta pura de producción que construye cada pasada. Cada snapshot fuerza de manera acotada el peor caso de tres pasadas: la primera difiere en una pila y las dos siguientes convergen; después calcula delta, evidencia de frontera, clasificación y valoración. La entrega se mantiene estable para que la declaración limpia sea coherente con H2.7. No simula ni mide HTTP, concurrencia de captura, catálogo/precios remotos, IndexedDB, Vault o UI: no son trabajo productivo determinista y no se inventa su latencia.

Hay tres warmups y 21 muestras medidas: p95 nearest-rank es la vigésima muestra ordenada, no el máximo. El heap retenido de cada muestra se compara después de GC explícito contra un único baseline post-warmup, por lo que el máximo representa retención acumulada durante el proceso; no afirma medir el pico transitorio. Los límites fail-closed —500 ms de mediana, 1.200 ms de p95 y exactamente 16 MiB acumulados— son detectores deliberadamente holgados de colapso entre runners compartidos, no una alarma de micro-regresiones. CI ejecuta la vía verde y un sabotaje E2E determinista en Node 22 y 24 contra ese mismo presupuesto productivo: inyecta al menos 32 MiB de heap JS retenido después del baseline —como mínimo el doble del límite—, exige que el error informe `cumulative retained heap observedB > budgetB`, comprueba que `budgetB` sea exactamente 16 MiB y que `observedB` lo supere. La causalidad depende así de la retención inyectada con margen suficiente frente al ruido natural del GC: si la inyección deja de retener heap, el benchmark pasa el límite productivo y el control negativo falla.

## Scheduler de polling API

H3.5 añade `ApiPollScheduler` como una primitiva independiente de snapshots y de la máquina de sesión. Construirla no registra listeners, no crea timers y no llama a la red. `AssistedDetectionService` la arranca únicamente después de que el usuario arme H3.8 y de capturar un baseline estable, usando el intervalo normalizado de settings.

El scheduler usa un único `setTimeout` por deadline y mantiene una sola promesa de polling en vuelo. El siguiente intervalo empieza después de resolver la consulta, por lo que una API lenta no acumula trabajo. Cambiar intervalo, pasar offline, despertar, detener o disponer incrementa una generación: timers y completions antiguos no pueden rearmar el ciclo. Volver online o despertar introduce un retraso de reanudación y nunca reproduce ticks perdidos.

Los resultados forman una unión cerrada: éxito, offline, rate limit, fallo transitorio o fatal. `apiPollOutcomeFromError` traduce únicamente `HttpTransportError` saneado: network/timeout y `500|502|503|504` son transitorios, `429` conserva `retryAfterMs`, y autenticación, respuestas no recuperables o errores desconocidos fallan cerrados. Los fallos transitorios usan backoff exponencial acotado con jitter; un éxito reinicia el contador. La detección de sleep contrasta deadline de reloj de pared y monotónico, descarta la ejecución tardía y programa una sola reanudación fresca.

## Frontera de plataforma e integración

El MVP comparte el mismo núcleo API-only en Linux con Steam/Proton, macOS con CrossOver y Windows;
ningún adapter conoce ni inspecciona el proceso del juego. Linux es la plataforma primaria, macOS
la secundaria y Windows permanece en beta. La matriz de validación y los umbrales del piloto viven
en [Política de plataformas e integraciones](PLATFORM_POLICY.md).

Mumble Link no forma parte del grafo de dependencias de v1. H8.1 añade el modelo declarativo
`src/platform/mumble-v2-contract.ts`. H8.5 implementa el helper nativo y H8.6 el codec, cliente,
salud y observación shadow como dos islas no compuestas. H8.7 añade contrato/plan/adapter de proceso
inyectado, todavía sin executor host. H8.8 añade un reducer puro de presencia/ausencia y un builder
de DTO shadow efímero, también sin composición. El censo de arquitectura permite solo el contrato,
los módulos TS puros H8.6/H8.7/H8.8 y los seis módulos Rust del helper; censos positivos
rechazan cualquier otro archivo, helper o importador bajo `src` y exigen un único call-site de la
capability dentro del método hasheado, además del hash canónico del adaptador completo. H8.2
permanece fuera de `src`.
No hay scheduler global, launcher, adapter nativo ni wiring desde `main`: la frontera está
implementada en aislamiento, no activada.

El contrato futuro es opt-in. Sus defaults iniciales recomendados —y marcados explícitamente como
revisables— son `enabled:false`, `shadow`, `on_when_armed` y retención `none`. Incluso tras habilitarlo,
shadow solo compara señales en memoria. H8.8 puede materializar un DTO interno `limited` y
`human_required`, pero no una propuesta H5.3: no lo encola, persiste, muestra ni alimenta el lifecycle.
La v1 API-only sigue siendo la autoridad; una discrepancia local degrada o se presenta para revisión,
nunca sustituye un snapshot. Todo inicio/parada sigue requiriendo la confirmación humana H3.8/H5.3.

La lectura futura tiene una allowlist positiva de cuatro campos: `uiVersion`, `uiTick`, `context_len`
y `context.mapId`. `uiVersion` debe ser exactamente `2`; junto con `context_len` solo valida el
layout. `context_len` debe cubrir los
32 bytes hasta el `uint32 mapId` situado tras los 28 bytes de `serverAddress`, no superar el buffer
documentado de 256 bytes y hoy se documenta como 48. `uiTick` y `mapId` son `uint32`. La actividad
proyectada significa exclusivamente `link_advancing|link_stalled`, derivada de que `uiTick` avance o
permanezca estable durante el default revisable de 1.500 ms; no afirma movimiento, combate ni farmeo.
No se lee `identity`, nombre, coordenadas, cámara, `uiState`, shard, instance, build, `processId` ni
mount. El mapa objetivo fijado por la API oficial es `866`, **Mad King's Labyrinth / Laberinto del
Rey Loco**, tipo `Public`.

Cada frame IPC v1 futuro tendrá exactamente `version`, nonce, `sequence`, `tick`, `mapId` y
`activity`. El transporte recomendado queda limitado a `127.0.0.1`, puerto efímero, JSON UTF-8 de
como máximo 512 bytes y nonce impredecible de al menos 128 bits. Versiones, campos o tamaños
desconocidos, nonce incorrecto, secuencia repetida/regresiva, tick inválido, mapa no positivo,
secuencia fuera del entero seguro, desconexión o source layout incompatible se descartan
fail-closed. `initialSequence:0` fija que un nonce/canal nuevo reinicia la secuencia desde cero. El helper no persiste raw ni
frames; el plugin tampoco los guarda en settings, IndexedDB, Vault, logs o telemetría. La ausencia o
caída conserva intacto el recorrido API-only.

Las fuentes de layout quedan fijadas al commit oficial Mumble
`088209c5a14650a04f6c88991374b44655ead34c`, la revisión `3086433` de `API:MumbleLink` y el commit
ArenaNet `06c4175ad55e4338c7e824c01fdeb6978d1b33d3`; los nombres EN/ES e id se verificaron el
2026-08-14 contra `/v2/maps/866?lang=en|es`. Antes de escribir runtime deben aprobarse el protocolo
concreto de lifecycle/discovery del helper y QA real separada en Linux/Steam/Proton,
macOS/CrossOver y Windows. Ninguna de esas pruebas se declara realizada por H8.1.

H8.2 añade únicamente un spike no productivo bajo `spikes/h8-mumble-crossover/`. El ejecutable
Windows abre el objeto nombrado `MumbleLink` con `FILE_MAP_READ` dentro de la misma botella y mapea
los 5.460 bytes documentados. Su decoder accede solo a los offsets de `uiVersion`, `uiTick`,
`context_len` y `context.mapId` mediante words `uint32` naturalmente alineadas —carga única en el
target Windows x86-64—. Cada intento lee los cuatro words dos veces y solo acepta si ambos candidatos
completos son idénticos; una diferencia reintenta hasta ocho pares. Es un filtro best-effort, **no un
seqlock ni una garantía de snapshot coherente del writer**: el mismo híbrido publicado dos veces aún
podría aceptarse y debe tratarse como señal shadow no autoritativa. Dos muestras aceptadas separadas
por 1.500 ms producen solo `link_advancing|link_stalled`, y stdout recibe un único frame H8.1 con
secuencia inicial cero. No enumera procesos, no inspecciona memoria privada, no inyecta, no abre
sockets, no persiste y no contiene fallback alternativo.

El núcleo portable y sus fixtures se compilan con el C del host bajo la lane normal y ASan/UBSan.
Sabotajes independientes alteran el offset de `mapId`, el tamaño 5.460, el frame máximo 512, los
ocho pares y el entero seguro `9007199254740991`; cada uno exige su rojo causal. Un guard dedicado
censusa el árbol exacto, las llamadas y sumideros del core/wrapper, el stub Windows y el script host;
exige exactamente un `OpenFileMappingW` y un `MapViewOfFile` con sus argumentos `FILE_MAP_READ`,
rechaza `0x0002`, write/all, Toolhelp/proceso/memoria, datos privados, red, persistencia y logs, y
demuestra que el gate no puede ejecutar Wine/CrossOver ni copiar fuera de su temporal. La allowlist
productiva permanece cerrada. Los argumentos y sumideros se extraen de tokens C reales, con
comentarios y literales fuera del flujo; un permiso decimal `2u` no puede quedar oculto tras una
llamada buena comentada. El host gate completo tiene un contrato positivo byte a byte y destinos de
escritura fijados bajo `test_dir`: cualquier comando nuevo —incluidos `open`, `/bin/cp`, `command cp`,
`eval`, `rsync` o `install`— exige reabrir deliberadamente el censo.
El wrapper tiene además un censo positivo separado de preprocesador. Solo admite
`#define WIN32_LEAN_AND_MEAN`, los cuatro headers de sistema previstos y `mumble_probe_core.h`;
cualquier `#undef`, macro adicional o redefinición —directa o mediante alias— de `FILE_MAP_READ`,
`MUMBLE_MAPPING_NAME` o `TC_MUMBLE_LINK_VIEW_BYTES` vuelve rojo el gate. Los controles negativos
incluyen tanto `2u` como `(1u << 1)`, para no confundir texto nominalmente read-only con permisos
efectivos de escritura.
Como autoridad final, la lane invoca el mismo compilador C del harness con `-E -P` y los mismos
includes (`test-support/windows.h` y `mumble_probe_core.h`). Un validador tokeniza el `main`
preprocesado y exige exactamente `OpenFileMappingW(0x0004u, 0, MUMBLE_MAPPING_NAME)`,
`MapViewOfFile(mapping, 0x0004u, 0u, 0u, 5460u)` y la declaración wide `MumbleLink`. Wrapper,
headers de runtime, stub y validador tienen hashes contractuales exactos. Los sabotajes modifican
el stub, el core header, usan `%:undef/%:define` y line-splicing; todos llegan a preprocesar y fallan
por la expansión observada. Esto cubre equivalencias del preprocesador sin perseguir variantes
textuales.
El Mac inspeccionado dispone de CrossOver 26.3.0 y una botella win64
`Guild Wars 2`, pero no de un cross-compiler Windows existente. Por ello no se instaló toolchain, no
se copió un binario a la botella, no se abrió CrossOver/GW2 y no se afirma lectura real. El comando
humano exacto y los criterios de aceptación viven junto al spike. Este árbol queda fuera de `src/`,
del bundle y de la allowlist productiva del scanner.

H8.3 acepta de forma provisional Rust para el lote posterior de implementación. La única raíz futura
es `native/mumble-helper`, el único target `x86_64-pc-windows-msvc` con
`-C target-feature=+crt-static` y `-C link-arg=/Brepro`, y la única salida PE
`tyrian-mumble-helper.exe`. La intención es
conservar una frontera revisable pequeña y un único binario Windows x64 para las tres plataformas,
sin runtime del lenguaje ni DLL de aplicación distribuidos aparte. C# se conserva como alternativa:
NativeAOT también puede producir una aplicación nativa self-contained y single-file sin runtime .NET
instalado. Sus tradeoffs reales son el soporte mínimo de runtime/GC embebido, tamaño medido,
restricciones de trimming/AOT y código dinámico, compatibilidad de librerías, toolchain MSVC y
configuración de símbolos/PDB. Rust concentra el riesgo en la frontera `unsafe` Win32, layout,
linker y dependencias. El ADR se reabre si Rust no puede respetar H8.1, producir el PE único
reproducible o cubrir la matriz con menos riesgo que C# NativeAOT.

El helper tendrá un ZIP separado, nunca el ZIP BRAT del plugin. El paquete futuro contendrá
exactamente `tyrian-mumble-helper.exe`, `helper-manifest.json`, `SHA256SUMS`, `LICENSE` y
`THIRD-PARTY-LICENSES.txt`; manifest y checksums deberán ligar el mismo build/target. La firma
Authenticode y todo el empaquetado productivo siguen pendientes. H8.5 transforma el guard H8.3 en
un censo positivo de la raíz Rust, toolchain, dependencias, única isla `unsafe`, APIs Win32 y tests;
continúa rechazando outputs nativos tracked/no ignorados y cualquier raíz nativa alternativa. Un
PDB efímero generado por MSVC puede vivir solo bajo el `target` ignorado de compilación; nunca entra
en staging, paquete ni artefacto CI.
La decisión completa y sus triggers viven en
[ADR 0001](adr/0001-h8-3-native-mumble-helper.md).

H8.4 cierra el protocolo local sin crear su runtime. Helper y plugin tendrán roles fijos de servidor
y cliente TCP IPv4, respectivamente. El servidor solo hará bind a `127.0.0.1:0`; el plugin entregará
un `bootstrap` framed por stdin, leerá un `ready` framed por stdout, conectará al puerto efectivo,
enviará `hello` y exigirá `welcome`. Stdin, stdout y TCP comparten el mismo record: cuatro bytes
`uint32` big-endian de longitud y 1–512 bytes de JSON UTF-8, con buffer completo máximo de 516 bytes. UTF-8 inválido, BOM, longitud cero o
mayor que 512, truncado, JSON inválido/no objeto/con trailing, claves duplicadas, extra o ausentes
cierran el canal. No hay downgrade: `version` es exactamente `1`.

Los seis mensajes tienen esquemas cerrados: `bootstrap(kind,version,token)`,
`ready(kind,version,host,port)`, `hello(kind,version,token)`,
`welcome(kind,version,nonce,heartbeatIntervalMs)`,
`heartbeat(kind,version,nonce,sequence,sourceStatus)` y el sample H8.1 sin cambios
`(version,nonce,sequence,tick,mapId,activity)`. El plugin genera con CSPRNG un token de 32 bytes,
base64url sin padding de 43 caracteres, por proceso futuro del helper; se compara en tiempo constante
sobre sus 32 bytes exactos: el helper captura bootstrap y exige exactamente ese token en hello.
Bootstrap no se compara con una expectativa externa. Solo stdin/bootstrap y TCP/hello pueden transportarlo, nunca argv,
entorno, fichero, log, stdout, stderr, discovery, settings, IndexedDB, Vault o telemetría. El helper genera por conexión
un nonce CSPRNG de 16 bytes/22 caracteres y lo expone solo en welcome, heartbeat y sample. Se admite
como máximo una conexión autenticada y otra pendiente.

Heartbeat y sample comparten una única secuencia desde cero y cada record aumenta exactamente uno.
Gap, replay, regresión, entero inseguro y wrap son `sequence_mismatch`; un nonce anterior es
`nonce_mismatch`. El rollover `uint32` de tick sí es válido. Cada invocación debida del slot activo
de 500 ms emite exactamente un record secuenciado mientras el deadline siga vigente: tras warm-up,
un sample derivado de tick/map raw sustituye al heartbeat y satisface liveness; sin lectura válida se
emite heartbeat con el `sourceStatus` exacto. `activity` se deriva dentro de la referencia usando
historia de tick y reloj, nunca llega precalculada. Por ello, `welcome.heartbeatIntervalMs=500` es el
intervalo máximo entre records secuenciados, no una segunda emisión obligatoria. El heartbeat no es
un sample vacío: su `sourceStatus` cerrado es
`warming_up|mapping_unavailable|layout_unsupported|sample_unstable|sample_invalid`. La actividad
`link_stalled` sigue perteneciendo al sample y aparece tras 1.500 ms sin avance de tick; lifecycle
del canal, salud de fuente y stalled son ejes distintos. La primera lectura válida después de
start, recovery o discontinuidad emite un único `warming_up` sin guardar tick/startedAt; la segunda
establece una época nueva y emite `link_advancing`. Solo el mismo tick de esa época pasa de advancing
a stalled exactamente en 1.500 ms. Cualquier heartbeat de source status borra ambos valores, por lo
que un tick stale anterior nunca reaparece como stalled. `awaiting_first_sequenced` admite solo
heartbeat y `healthy` no es un source status válido.

Discovery vence a 5.000 ms. Connect, hello, primer record secuenciado y salud del canal vencen cada
uno a 2.000 ms. El framer incremental retiene como máximo 516 bytes simultáneos aunque el chunk
recibido contenga miles de records; transfiere el buffer después de liberar su referencia interna,
sin copiar el payload durante el callback. Cada fase admite solo sus records exactos; un record correcto fuera de fase es
`frame_schema`. Heartbeat y sample secuenciados válidos renuevan la salud y son los únicos eventos
que resetean el backoff al dejar el canal `healthy`. Tras cierre se reconecta con
`[250,500,1000,2000,5000]` ms, saturando en 5.000. Antes de ready, cualquier fallo reinicia proceso,
bootstrap y discovery; tras ready, el mismo helper conserva token pero rota nonce y reinicia secuencia.
`helper_exited` desde cualquier estado no terminal, incluido `reconnect_wait`, invalida también el
puerto e impide que `reconnect_due` use el helper muerto. Una llamada tardía emite como máximo un
record actual y fija el siguiente deadline en `now+500`, sin catch-up ni replay. Si han pasado 2.000
ms desde el último record válido, falla una vez con `heartbeat_timeout`; un sleep de 60 s no genera
una ráfaga. EOF de stdin apaga el helper, invalida credenciales y cierra listener y conexiones. Los errores exactos
son `discovery_timeout|discovery_invalid|connect_timeout|auth_rejected|version_unsupported|frame_length|frame_utf8|frame_json|frame_schema|nonce_mismatch|sequence_mismatch|heartbeat_timeout|peer_closed|helper_exited`.
El contrato completo parseable vive en [ADR 0002](adr/0002-h8-4-local-ipc-protocol.md).

H8.5 implementa solo el lado helper/servidor. Un watchdog bloqueante observa stdin y el event loop acotado no crea threads por conexión:
rechaza clientes adicionales, limita slowloris de hello a 2.000 ms y termina al recibir EOF. Cada slot
de 500 ms reabre el mapping `MumbleLink` con `FILE_MAP_READ` y emite exactamente un record secuenciado.
Fuente ausente/incompatible/inestable/inválida produce su heartbeat exacto; la primera lectura válida
tras inicio o discontinuidad produce `warming_up`, y solo la siguiente produce sample. La discontinuidad
reinicia la historia de actividad; no hay catch-up tras sleep. El núcleo portable conserva framing,
JSON estricto con duplicados escapados, auth constant-time + zeroize, nonce/secuencia y los cuatro
words/ocho pares de H8.2. H8.5 no contiene launcher, settings, UI, persistencia ni red externa.

H8.6 implementa el lado cliente como núcleo TypeScript puro y aislado en
`mumble-v2-codec.ts`, `mumble-v2-client.ts`, `mumble-v2-health.ts` y
`mumble-v2-observation.ts`. El codec incremental aplica framing `uint32` big-endian, UTF-8 fatal,
JSON cerrado y high-water máximo 516. El cliente solo conoce puertos inyectados de proceso, TCP,
reloj y CSPRNG: token nuevo por proceso, nonce nuevo por conexión, secuencia `0,+1`, deadlines y
generaciones descartan callbacks stale. `restart_wait` y `reconnect_wait` comparten el backoff
saturado `[250,500,1000,2000,5000]`; ready/connect/hello/welcome no lo reinician y solo `healthy`
vuelve a 250. La entrega de `onState`/`onError` aísla throws y reentrada para que `shutdown` no pueda
revivir una generación ni quede un estado running sin proceso.

La salud conserva tres ejes independientes —canal, fuente y actividad— y no colapsa
`link_stalled` en indisponibilidad de fuente. La observación shadow retiene únicamente `mapId` y
actividad en memoria cuando `enabled && armed`; no expone callbacks de sesión, propuesta, captura o
persistencia. Ninguno de los cuatro módulos importa Node, sesiones, stores, red, filesystem,
logging ni timers globales. Aún no existen launcher real, composición en `main`, settings/UI,
packaging ni QA de plataforma.

H8.8 añade `mumble-v2-presence-policy.ts` como reducer puro sobre observaciones ya aceptadas. Solo
el mapa objetivo fijo `866` puede acumular 5.000 ms de crédito de presencia mientras la autoridad
está idle; la ausencia acumula 60.000 ms fuera del objetivo solo para una sesión ligada. Cada record
aporta como máximo 500 ms y no autoriza catch-up: gaps, heartbeat/source unavailable,
`link_stalled`, pérdida de canal o recovery rompen o
degradan la ventana en curso. Esos eventos no cuentan como ausencia. Cada latch puede producir como
máximo un DTO mediante `mumble-v2-shadow-proposal.ts`; repetir el mismo estado no lo reemite. El
contexto de entrada liga la señal a `accountId` tanto en idle como durante una sesión; un cambio de
cuenta resetea ventana y latch antes de aceptar nueva evidencia.

El DTO es efímero, de evidencia `limited` y review `human_required`. No contiene una capability
ni activa callbacks de cola, captura, persistencia, UI o sesión. `accountId` permanece solo en ese
contexto/DTO efímero y no crea retención durable. La API continúa siendo autoritativa y este grafo
sigue cortado de `main`, `AssistedDetectionService` y H5.3. La composición futura, las métricas
comparativas y la QA humana en las tres plataformas permanecen pendientes;
[ADR 0005](adr/0005-h8-8-shadow-presence-policy.md) fija el límite de esta fase.

H8.7 fija configuración, rutas y diagnósticos cerrados para Windows nativo, CrossOver `wine` y
Steam/Proton `protontricks-launch`. AppID `1284210`, `MumbleLink` y ambos launchers son constantes;
package/bottle/compat-data son efímeros y estrictos. El plan usa argv/env exactos, `shell:false` y
tres pipes. El adapter abre en cada intento el paquete H8.5 exacto de cinco ficheros, valida manifest
canónico y cuatro checksums no circulares, y entrega al puerto de proceso solo una capability opaca
ligada al snapshot y sus digests: nunca el package path ni un helper path re-resoluble. Drena stderr,
aplaza un único stdout prematuro de máximo 516 bytes y revalida el estado antes de abrir delivery,
incluida la carrera de microtasks tras retornar el host. Overflow, segundo evento, exit temprano o
un scheduler que invoque inline cierran una vez y notifican exit a H8.6. Stop es idempotente. Esta comprobación significa `integrity_checked` y
`unsigned_qa_only`, no autenticidad. No hay import Node ni proceso real; un executor futuro deberá
exigir digest de release o Authenticode como trust anchor y revalidar en cada arranque/restart.

`RelevantItemStartDetector` es el consumidor puro H3.6. Recibe deltas H2.6 como datos no confiables y una regla inmutable `{id, version, itemIds}` ordenada; la relevancia nunca se deduce del nombre localizado, rareza o descripción. Un delta inválido o sin ganancias relevantes corta la racha. Dos señales positivas deben compartir cuenta y el mismo snapshot fronterizo; sus ventanas pueden contener el tiempo real de captura, pero no solaparse ni invertirse. Solo entonces publica una propuesta estable con ambas evidencias, calidad `complete|limited` y `possibleStart.from|to|uncertaintyMs` derivados del primer intervalo. Redelivery exacto es idempotente; evidencia distinta que reutiliza IDs de snapshot no se considera duplicada. La propuesta no transiciona H3.1 ni llama a red: H3.8 controla armado y confirmación, y los knowledge packs aportarán más listas relevantes.

`InactivityStopDetector` cubre H3.7 sin acoplarse al scheduler ni a la máquina de sesión. Recibe muestras normalizadas con cuenta, snapshots fronterizos, ventana, cantidad de ganancia relevante y calidad. Solo acumula silencio cuando las muestras comparten frontera y sus ventanas no se solapan; una ganancia reinicia el umbral y una discontinuidad descarta evidencia anterior. Al alcanzar el tiempo configurado publica una propuesta idempotente, nunca un evento `request_stop`: conserva primera muestra quieta, confirmación, última ganancia conocida, duración y una ventana de fin honesta desde el último intervalo positivo —o el inicio de sesión— hasta la primera observación quieta.

`AssistedDetectionService` compone H3.5–H3.8 sin automatizar H3.1. Nace desarmado y no persiste el armado: cada recarga exige una acción nueva. `arm()` deduplica el doble clic, captura primero un snapshot estable y solo después programa polling. Cada tick captura otro snapshot, calcula H2.6 y entrega la evidencia al detector de inicio cuando la sesión está `idle` o al detector de inactividad cuando está `active`. Cambiar entre `idle` y una sesión concreta fuerza una nueva frontera antes de interpretar deltas, por lo que nunca se arrastra evidencia previa al inicio. Una propuesta pausa el scheduler y queda permanentemente visible en la vista hasta que el usuario inicia/detiene o descarta. Desarmar invalida capturas en vuelo, borra evidencia temporal y detiene timers; cambiar la referencia de credencial también desarma para impedir mezclar cuentas. Offline y wake se delegan al scheduler. La regla inicial de Halloween es versionada y usa el id público oficial `36038` para **Trick-or-Treat Bag**; nunca compara nombres localizados.

H3.9 añade `SessionContaminationReview` como dato derivado y verificable, no como texto libre. Las respuestas distinguen confirmación limpia, duda y diez acciones concretas que se reducen a las categorías H2.7 `open|salvage|consume|craft|tp|vendor|transfer|other`. `createSessionContaminationReview` reconstruye `BoundaryEvidence` desde los snapshots completos, llama al clasificador H2.7 con fronteras manuales y TP explícitamente `unavailable`, y rechaza cualquier resultado inválido. Una actividad declarada domina siempre; una duda queda estimada sin permiso de finalizar. La revisión puede editarse mientras la sesión siga provisional y no puede falsificar la clasificación porque el store vuelve a derivarla al validar.

El runtime de sesión sube a versión 2 y añade `review`. Los records v1 válidos migran en lectura a `review:null`; corrupción o una clasificación manipulada siguen fallando cerrados. Una revisión provisional se persiste antes de cambiar el estado. Si H2.7 permite finalizar, el record `complete` con snapshots, delta y revisión se guarda atómicamente antes de publicar el estado y liberar el lease. Al recargar, una sesión completa se restaura localmente sin presentarla como recovery de una sesión activa; **Clear completed session** borra explícitamente ese terminal. Las notas H5.4 y el historial exportable H5.10 pertenecen a sus fronteras Vault, no a este store de una sola sesión.

H3.10 mide la detección sin acoplarla al runtime crítico. `DetectionQualityRecorder` guarda en una tercera IndexedDB local eventos estrictos e idempotentes por frontera o propuesta: fase, decisión, modo manual/asistido, causa, ventana, incertidumbre, calidad y vínculo opcional a sesión. Confirmar una propuesta conserva su evidencia; iniciar o parar sin propuesta conserva la ventana real entre la petición manual y el fin de la captura estable. Descartar exige una causa cerrada y conserva el falso positivo, incluidos los inicios que no llegaron a crear sesión. El resumen por `sessionId` deriva modo manual, asistido, mixto o incompleto y suma incertidumbre sin inventar datos históricos. La carga y cada escritura son auxiliares y asíncronas: corrupción, conflicto o indisponibilidad desactivan solo la medición y quedan visibles, pero nunca retrasan H3.1 ni escriben en el vault.

H4.1 fija una única unidad monetaria de dominio: cobre entero, seguro y no negativo; cantidades de línea enteras y positivas. El bruto es `precio unitario × cantidad`. Venta inmediata usa la mejor orden de compra observada y el neto es `bruto − listing fee − exchange fee`; listado usa el precio de listado elegido y la misma resta, pero queda marcado como liquidez condicional porque aún debe venderse. Mercader es `vendor value × cantidad`, sin tasas del bazar. No líquido conserva ambos importes como `null`, nunca como cero: significa que no hay valor realizable probado, no que el objeto no valga nada. H4.1 valida toda la aritmética y rechaza overflow o tasas mayores que el bruto.

H4.2 añade una política GW2 v1 separada del contrato monetario. Tanto venta inmediata como listado descuentan por separado un 5% de publicación y un 10% de intercambio sobre el precio total de la pila. Cada componente se redondea al cobre más cercano —mitades hacia arriba— y tiene un mínimo de un cobre; la fábrica rechaza una cotización si esos mínimos superan el bruto. La elegibilidad de mercader se deriva únicamente de un `CatalogItem` normalizado: exige `vendorValue > 0` y ausencia del flag exacto `NoSell`. Un binding por sí solo no demuestra que el mercader esté prohibido. El módulo es puro, no consulta precios ni hace red, y conserva la versión de la política junto a la cotización.

H4.3 clasifica cada `ItemHolding` contra un `CatalogItem` y un estado explícito de precio TP. El binding observado en la pila domina; si falta, `AccountBound` y `SoulbindOnAcquire` del catálogo se aplican de forma conservadora, mientras que `SoulBindOnUse` no se trata como ya ligado. Account-bound, character-bound y binding futuro desconocido excluyen el bazar, pero no el mercader cuando H4.2 demuestra un valor válido: un objeto ligado sí puede venderse a NPC. Precio TP ausente, inválido o no disponible nunca habilita esa ruta. Objetos engastados y bolsas equipadas quedan fuera en su estado actual; delivery se marca como pendiente de recoger sin inventar pérdida de propiedad. La salida separa rutas probadas y conserva `null` cuando ninguna es realizable, con guard runtime que vuelve a comprobar rutas, cantidades y aritmética.

H4.4 toma únicamente los cambios positivos de `StorageDelta` al cerrar una sesión y consulta `/v2/commerce/prices` con un cliente público sin `Authorization`. Deduplica y ordena ids, usa lotes máximos de 200 y conserva por item la cantidad ganada, mejor compra (bid), mejor venta (ask), cantidades disponibles y `whitelisted`. Una pareja API `quantity=0, unit_price=0` representa ausencia de esa cara del mercado mediante `null`; combinaciones mixtas, duplicados, omisiones o payloads corruptos se marcan como cobertura ausente, nunca como cero realizable.

El snapshot H4.4 fija schema, timestamp y fuente `gw2-commerce-prices`, con estado `complete|partial|unavailable`. Los fallos de red no bloquean **Stop session**: se persiste un snapshot `unavailable` con los ids pendientes. El runtime sube a v3, migra v1/v2 sin inventar cotizaciones y valida que sesión, ids y cantidades ganadas coincidan con el delta canónico antes de aceptar el record. Este lote no aplica tasas ni agrega oro: H4.5 consumirá la evidencia temporal conservada.

H4.5 es un cálculo puro sobre `StorageDelta`, el snapshot H4.4, catálogo normalizado, binding explícito, duración e ids de sacos. Cada línea reutiliza H4.3 y H4.2 para obtener rutas válidas: el valor inmediato elige el mayor entre bid neto y mercader; el valor de listado elige el mayor entre ask neto y mercader. Una ruta ausente sigue siendo `null`; no líquido conserva cantidad y motivo. Los totales suman moneda id `1` observada por H2.6 y separan valor de items, moneda y cantidad no líquida. Sacos/h se expresa en milésimas y cobre/h en enteros, ambos con redondeo al más cercano y guardas de overflow. Pérdidas de items no se valoran sin una atribución de coste y generan warning; precio, catálogo o binding incompletos degradan cobertura a `partial`.

H4.6 define `ContainerModelV1` como contrato puro y no como datos implícitos en código. Cada modelo tiene id y versión propios, item contenedor, fuente pública con fecha de publicación y consulta, tamaño y ventana de muestra, resultados ordenados por namespace e id numérico, y un bloque explícito de incertidumbre. Cada resultado conserva etiqueta, unidades totales observadas y unidades esperadas por saco en millonésimas; el constructor deriva estas últimas mediante división y redondeo `BigInt` exactos, por lo que admite promedios superiores a una unidad sin convertirlos en falsas probabilidades. Cada resultado declara además una política compatible con su namespace: bazar o mercader para items, moneda directa para currencies, exclusión o aplazamiento explícitos.

H4.7 aporta `halloweenTrickOrTreatBagModel()`, fijado a la revisión `3161313` de la investigación comunitaria de GW2 Wiki. La muestra declara 106.264 sacos y 892.130 unidades observadas entre 2024 y 2026; el modelo contiene los 17 resultados comunes/no comunes y Soul Pastry con sus totales exactos e ids oficiales. Solo ocho items con ruta de mercado declarada pueden contribuir al EV posterior. Un ledger estructurado registra aparte 1.121 unidades de cola rara y 50 superraras; el validator exige que resultados y exclusiones sumen exactamente las 892.130 observaciones. El modelo no extrapola jackpots observados ni asigna valor a luck, materiales ligados, finishers o juguetes sin una ruta económica respaldada. La fábrica devuelve una copia aislada por consumidor para evitar contaminación global. H4.8 consume este contrato sin modificar su muestra.

H4.8 calcula un EV de apertura puro sobre un modelo validado y cotizaciones tipadas. Reutiliza exactamente H4.2 sobre la pila muestral completa de cada resultado —5% y 10% separados, mínimos y redondeo a cobre— y solo entonces amortiza el neto entre los sacos con precisión de microcobre mediante `BigInt`; la salida conserva `feePolicyVersion`. Bid y ask producen rutas separadas de venta inmediata y listado. Cada ruta declara cobertura `complete|partial`, subtotal conocido y total `null` si falta un precio o, para acceso F2P/no confirmado, la API marca el item como no habilitado; una cuenta con acceso completo no queda restringida por `whitelisted=false`. Una ausencia nunca se transforma en cero y un overflow invalida el cálculo. Las líneas preservan `key`, namespace e id para que item y currency no colisionen. `excluded` contribuye exactamente cero oro líquido y queda cuantificado aparte; solo currency id `1` puede contribuir como cobre directo, mientras otra moneda deja cobertura parcial. El cálculo no compara todavía abrir con vender el saco ni emite recomendaciones: eso pertenece a H4.10.

H4.9 introduce `createReservationPlan`, un motor puro sobre objetivos y un balance final validado. Solo participan objetivos `active`; el remanente `targetQuantity - creditedQuantity` se asigna de forma aditiva, exclusiva y determinista por prioridad descendente, `goalId` y clave del requisito. Un requisito `owned` consume primero propiedad no disponible y después protege disponibilidad; uno `available` solo usa disponibilidad. Cada allocation conserva esa base y el validator reproduce el consumo de ambos pools, impidiendo que un plan manipulado atribuya propiedad no disponible a un requisito `available`. El plan separa items y divisas, shortfall y cobertura, y calcula allowances por acción: lo no reservado puede liquidarse/abrirse/consumirse/canjearse, mientras lo protegido solo vuelve a estar permitido para su `intendedUse`. Evidencia desconocida produce allowances `null`, no falsos ceros.

`buildReservationBalance` deriva los pools únicamente de un `StorageSnapshot` comparable según H2.6 y conserva cobertura `complete|limited|unknown` para cada namespace. Así, un ID ausente en una superficie completa es un cero demostrado y genera shortfall, no evidencia desconocida; delivery o wallet incompletos degradan solo la superficie correspondiente. `partitionSessionValuation` reutiliza el validator autoritativo H2.7 de `StorageDelta` y `isSessionValuation(value, delta, sackItemIds)` de H4.5: este último recompone las tasas H4.2 desde cada precio unitario, impide rutas TP con binding incompatible y recalcula mejores vías, totales, moneda y rates con la procedencia exacta de los IDs de saco. Solo entonces añade una partición por cantidad ganada y conserva por referencia y sin mutar la valoración, sus importes, cobertura y política de fees. Cada allocation conserva también la razón del objetivo, además de base e intención. El validator standalone del overlay prueba sus invariantes H4.5 y cuantitativas mediante los `sackItemIds` conservados; H4.10 vuelve a ligarlo al plan para reconstruir la procedencia. Esta capa no persiste objetivos o planes, no consulta red/precios ni prorratea dinero.

H4.10 añade `recommendContainerDisposition`, una frontera pura y defensiva sobre `unknown`. La entrada lleva snapshots before/after completos, delta y review H3.9: recompone el delta desde ambos snapshots, `isSessionContaminationReview` vuelve a derivar frontera y clasificación desde esas respuestas, `buildReservationBalance(after)` reconstruye el balance final, `createReservationPlan` reconstruye el plan desde los objetivos aportados y `partitionSessionValuation` recompone el overlay usando exactamente ese delta, plan y lista de sacos. Así una clasificación, plan u overlay standalone no se puede trasplantar. Captura/cobertura/assets base del plan deben coincidir byte-semánticamente con el balance derivado. La identidad y cronología `after.completedAt <= review.reviewedAt <= asOf` se comprueban antes incluso de `reserved_only`. Después, la reserva se aplica antes de la economía: la cantidad libre es la intersección del gain observado con los allowances de liquidar y abrir; el resto conserva `goalId`, razón e intención. Cero unidades libres produce `reserved_only` sin ejecutar el modelo. Para una decisión económica se exige clasificación H2.7 v2 `exact/high` con `recommend:true`; el validator v2 comprueba además que razones y solicitudes de revisión pertenezcan a la severidad/estado que puede producir H2.7. Un review v1 histórico sigue siendo cargable en runtime pero permanece read-only e ineligible, y los resultados estimados, contaminados o inválidos quedan bloqueados.

La evidencia económica conserva un único batch crudo de precios públicos y una atestación versionada del modelo. Un SHA-256 síncrono puro sobre JSON canónico liga la aprobación al contenido completo, no solo a id/versión; el review debe ser posterior a creación, publicación y recuperación del modelo. Fechas futuras, caducidad, review revocada, identidad divergente, binding desconocido, acceso TP no demostrado o cobertura instantánea parcial fallan cerrados. Con evidencia válida, H4.10 recalcula H4.8 desde esas cotizaciones, vuelve a aplicar H4.2 sobre la pila libre completa y elige como suelo de venta inmediata el mayor neto entre bid y mercader permitido. El umbral `openEV × 10000 >= sellNow × (10000 + margen)` se evalúa con `BigInt`; la igualdad abre y la explicación conserva cifras decimales exactas, fees, muestra, exclusiones, tratamiento de raros y frescura. `blocked` nunca contiene acción y `invalid` distingue evidencia malformada/incoherente de una limitación conocida. El módulo no consulta red, persiste, escribe el vault, muestra UI ni opera sobre objetos o bazar.

H4.19 extrae esa última comparación a `calculateContainerDispositionKernel`, sin tipos ni dependencias de sesión. H4.10 conserva la recomposición histórica de sesión y delega únicamente la economía ya validada. El adapter del Advisor recibe una asignación explícita y liga un pack SHA-256 con activación humana, rule pack, knowledge pack, fingerprint de modelo, política fija del 10% y los nueve IDs de precio esperados. Reproduce reservas y excepciones antes del kernel; evidencia parcial, stale/futura, revocada, expirada o incoherente devuelve revisión. La salida económica cerrada es solo manual `open|sell|vendor`; no admite listing, executor, background ni discard. David aprobó la regla y la activación built-in de 36038 el `2026-08-16T05:22:24.000Z`; el provider usa ese instante como límite inferior inclusivo y la expiración como límite superior exclusivo.

H4.11 añade `evaluateHoldIntents`, otro límite puro y defensivo situado después de H4.9 y antes de la economía H4.10. Recibe la cantidad libre final por item, intenciones versionadas creadas únicamente por el usuario y el mismo batch de mercado. Ordena por deadline e id y asigna un pool exclusivo: mientras el precio actual esté por debajo del objetivo conserva unidades; alcanzar el objetivo, cancelar o llegar exactamente al deadline las libera; si falta el precio conserva hasta el deadline y lo declara explícitamente. La salida mantiene requested, allocated, shortfall, precio actual/objetivo, tiempo restante, razón y neto objetivo recalculado con H4.2. H4.10 solo omite evidencia temporal si H4.9 ya reservó toda la ganancia; cuando queda cantidad libre valida frescura y skew del batch antes de evaluar intenciones, por lo que un precio stale/futuro nunca puede producir el atajo `reserved_only`. Después recompone el plan contra el overlay y batch aportados, resta solo `holding|price_unavailable` y conserva la procedencia en la recomendación. Ninguna de las dos capas persiste la intención, consulta red o ejecuta una operación.

H4.12 envuelve cualquier resultado H4.10 en `RecommendationEnvelopeV1`, un contrato exacto y solo de datos. Declara siempre `execution: manual_in_game`, `sideEffects: none` y `requiresUserAction: true`; sus decisiones cerradas `open|sell|reserve|hold|review|none` solo contienen item, cantidad, ruta económica compatible y una referencia JSON interna a la explicación. La matriz v1 exige `instant_sell|vendor` para sell y `instant_sell|listing` para hold; open, reserve, review y none prohíben route. `ready` particiona reserva, retención y acción económica sin duplicar cantidades; `reserved_only` nunca añade economía; `blocked` conserva lo ya protegido y puede pedir review; `invalid` usa un envelope vacío. El validator rechaza propiedades extra, refs externas, callbacks, secretos, ids de orden, flags de ejecución, objetos no JSON y aritmética insegura. El límite no exporta executor.

El guard arquitectónico Vitest censa todos los módulos productivos `*recommendation*.ts` y falla ante imports de cliente/operación/HTTP/transporte/request/store/secret/Obsidian —incluidos side-effect imports, `import()` y `require()` con literal—, campos de capacidad, símbolos públicos de ejecución y llamadas ordinarias a fetch/request/requestUrl/execute o métodos de orden. Se saboteó con un import real de `GuildWars2Client`: el primer censo incompleto quedó verde, se amplió para incluir `recommendation-envelope.ts`, el mismo sabotaje pasó a rojo y después se restauró con hash y modo idénticos. Las cuatro sintaxis de módulo tienen regresión contra el mismo parser/clasificador exportado por el guard. Su límite explícito es el análisis estático textual: no pretende resolver specifiers computados, acceso dinámico ofuscado ni código fuera de la frontera nominal.

H4.13 define un contrato hermano para el Inventory Advisor sin ampliar H4.12 ni prometer una vista total de la cuenta. Su scope durable `supported_storage_v1` abarca exclusivamente las ubicaciones que ya normaliza `StorageSnapshot`; equipo, armería legendaria, correo y bancos de guild quedan fuera. `InventoryAdvisorInputV1` liga por cuenta, snapshot y schema catálogo, batch público de precios, objetivos H4.9, excepciones explícitas de conservación, señales de desbloqueos/progreso, policy y un rule pack fechado cuyo SHA-256 cubre todo el contenido. Los validators públicos aceptan `unknown`, exigen claves exactas, orden canónico, aritmética segura, particiones completas y relaciones internas entre posiciones, decisiones y explicaciones.

La salida H4.13 usa `InventoryRecommendationEnvelopeV1`, discriminado como `inventory_recommendation` y siempre `manual_in_game`, `sideEffects: none`, `requiresUserAction: true`. Las acciones cerradas son vender, listar, mercader, reciclar, usar, abrir, conservar, revisar y `discard_candidate`; nunca existe `destroy`. Reservas H4.9 y excepciones del usuario tienen prioridad sobre cualquier regla, las posiciones no accionables no pueden venderse/reciclarse/usarse, y una línea solo puede emitir acciones económicas con toda su evidencia completa. `discard_candidate` exige regla curada id/version/hash y queda marcado `irreversible_review_only`: el contrato no ejecuta ni autoriza borrado. Un guard causal independiente prohíbe capacidades de red, secretos, stores, Obsidian y operaciones en los módulos de esta frontera. H4.14 captura la evidencia, H4.15 clasifica y H4.16 aplica la allowlist excepcional pura.

H4.14 implementa esa captura en `InventoryAdvisorEvidenceService`, una frontera explícita y sin UI, Vault ni persistencia. Conserva `supported_storage_v1`: pide a `PublicCatalogService` cobertura para todo `ownedByItem > 0`, consulta por lotes de 200 el precio público para todo `availableByItem > 0` y reutiliza el parser H4.4 para conservar bid/ask `null`. En H4.19, solo el mismo Refresh explícito puede pedir además un batch hermano con los IDs exactos `36038,36041,36059,36060,36061,79673,79677,79679,89002`; la captura conserva identidad, schema, timestamp, fuente y missing IDs, y nunca se inicia en background. Una sola `GuildWars2Operation` valida `tokeninfo → account` contra el snapshot y después lee recetas, skins, minis y bits de logros solo cuando permisos y URL restrictions lo permiten; los endpoints privados usan únicamente respuestas detalladas HTTP 200. Errores, 403 y payloads inválidos quedan `unavailable|partial`, nunca arrays vacíos. El envelope incluye snapshot, timestamps de captura/finalización, TTL de snapshot/catálogo/precio/señales y SHA-256 canónico que preserva el orden de holdings; `cache_stale` y delivery limitado degradan a parcial. El builder lo compone al input H4.13 solo si política y evidencia siguen dentro de esos TTL.

H4.15 añade `classifyInventoryAdvisor`, motor puro y sin capacidades. Su knowledge pack V1 hasheado asocia cada capacidad `use|open|salvage` a una afirmación positiva ligada a regla o a `not_applicable` con fuentes explícitas. La capacidad y el permiso de recomendación son contratos distintos: una regla puede demostrar una ruta y mantenerla `review_only` por `economic_comparison_missing`; ausencia, contradicción o permiso retenido se revisan. El motor particiona toda posición propia exactamente una vez: reservas, excepciones, no-suelta a revisión, rutas curadas y, por último, mercader/TP o conservar. Las rutas manuales de mercado exigen inventario, catálogo, precios, reservas y señales completos/frescos; una captura completamente cubierta pero cambiante y un rule pack pendiente pueden mantener el informe `limited` sin ocultar esas rutas independientes. Usar, abrir, reciclar y la economía curada exigen además snapshot estable y autoridad de regla exacta. TP usa tasas H4.2 y no vende más que la profundidad top-bid demostrada, dividiendo la posición para clasificar el exceso conservadoramente. H4.15 no emite `discard_candidate`.

H4.16 añade `applyInventoryDiscardAllowlist`, resultado hermano puro. Reproduce y compara canónicamente H4.15 antes de transformar exclusivamente un `keep/no_supported_route` ready. El candidato requiere fuentes canónicas para las tres afirmaciones `not_applicable` y para exactamente una regla de descarte curada, sin reserva/excepción, con posiciones sueltas, evidencia completa/fresca, catálogo `network|cache_fresh`, flags `NoSell|NoSalvage`, sin `DeleteWarning`, binding resuelto y precio bid/ask nulo. Su proof enlaza SHA del productor, regla y fuentes; el envelope sigue siendo estrictamente manual sin efectos. El guard censa sus módulos y bloquea I/O, UI, timers, executor y destroy.

H5.11 añade `InventoryAdvisorWorkflow` como composición explícita y `InventoryAdvisorPresentationController` como caché solo en memoria. El workflow consulta primero el provider de policy/rule/knowledge/economy con un único `asOf`: si el bundle falta, es inválido, precede a su revisión humana o ha alcanzado su expiración exclusiva, devuelve `blocked/missing_rules` antes de crear cache de catálogo, resolver secreto o capturar la cuenta. H4.18 conecta el bundle built-in v2 source-backed para 36038 y H4.19 incorpora su pack económico ya aprobado: solo el batch completo y fresco puede producir `open|sell|vendor`, siempre manual; ausencia/parcialidad sigue en revisión. Para items sin una entrada de conocimiento curada y sin capacidad aplicable en el rule pack, H4.15 retiene uso/abrir/reciclar pero permite reproducir la mejor salida líquida manual entre bid, listing y mercader con catálogo, binding, acceso y precios completos; una capacidad aplicable sin knowledge se revisa como `rule_missing`. Con el bundle disponible, un único Refresh ejecuta `InventoryAdvisorEvidenceService.capture(locale, expectedPriceItemIds)`, compone input con goals/keep-exceptions, clasifica H4.15, aplica H4.16 y proyecta la presentación. El Advisor usa un transporte separado con timeout de 30 segundos y una sola pasada de personaje+compartido por intento; una pasada completa es evidencia `unstable/limited`, y solo una parcial transitoria se reintenta una vez antes de catálogo/precios. Así no encadena dos estabilizaciones completas. El controlador comparte el vuelo de una generación, impide que A sobrescriba B y conserva el último resultado válido únicamente si un Refresh devuelve `capture_unavailable`; identidad inválida, preferencias, reclassify o rechazo reemplazan la proyección. Se invalida por clave o locale, y cambiar locale no recaptura implícitamente porque el catálogo es locale-specific.

Cada Refresh reemplaza además un único recibo diagnóstico JSON dentro de la carpeta del plugin. La frontera H4.14 construye únicamente códigos cerrados de resultado/cobertura, duración, calidad y resúmenes de las pasadas; registra por separado roster, compartido, banco, materiales, delivery y las coberturas únicas de personajes en el resultado final y en cada intento. Una fuente no disponible añade solo clase de transporte, estado HTTP y espera acotada. `main` posee el único puerto de escritura local. El recibo excluye clave, identificadores de cuenta/snapshot, nombres de personaje, objetos, URLs y cuerpos HTTP, nunca se sube y su fallo de escritura no puede cambiar el resultado del Advisor.

`InventoryAdvisorItemView` es un adapter Obsidian separado del Companion. Open y render no capturan la cuenta; solo el botón/comando Refresh llama al workflow. La presentación recalcula importes únicamente mediante H4.2, conserva allocations y explanations y traduce `discard_candidate` a `discard_review` solo después de validar el resultado contextual H4.16 completo. Cada fila irreversible exige su proof exacto; la UI no ofrece filtro, CTA, modal, executor ni acción de destrucción. Dos hojas comparten el controlador de captura pero mantienen DOM, filtros y foco propios; las actualizaciones de modelo/locale conservan los controles montados y los refrescos genéricos de sesión no repintan el Advisor. La tabla se reserva para 760 px o más; hasta 759 px las cards conservan ubicación completa —incluidos personaje/bolsa/ranura o categoría—, valor, cobertura y explicación. Refresh captura bolsas de personaje y compartido como núcleo requerido, y banco, materiales y delivery como fuentes opcionales. La presentación propaga únicamente su cobertura saneada: los controles opt-in se habilitan cuando la fuente fue leída y se deshabilitan con motivo visible si faltó permiso, quedó restringida, fue parcial o no estuvo disponible. Un 403 de una fuente opcional no descarta el núcleo; un 401 sí invalida la credencial fijada. La superficie primaria resume las rutas ejecutables en una cola «Qué hacer ahora», usa verbos imperativos y valores oro/plata/cobre, mantiene cualquier item con rutas mixtas dentro del recuento sin precio y deja `keep|review|discard_review` como contexto opt-in. Cada objeto muestra el icono oficial únicamente desde el origen exacto `https://render.guildwars2.com`, sin credenciales ni puerto alternativo, con nombre textual adyacente y fallback sin imagen; la vista declara que el navegador puede solicitar esos iconos públicos al CDN. El feedback de Refresh es indeterminado —sin inventar porcentaje—.

H5.12 sustituye el puerto vacío por `InventoryPreferencesRuntime`: conserva internamente el hash ya calculado del vault, una cuenta sólo aceptada cuando las identidades top-level, snapshot, precios y `accountSignals` concuerdan, y la generación CAS; la vista sólo recibe objetivos/excepciones y un estado redactado. Refresh hace estrictamente captura → derivación de scope → carga local → input → H4.15/H4.16. El editor plegable sólo reintenta IndexedDB por acción explícita, nunca al abrir. CRUD usa `InventoryPreferencesService` y CAS atómico; un conflicto no mezcla ni borra el borrador. Tras guardar, `reclassify()` vuelve a proyectar la evidencia cacheada si cumple su TTL exacto; si no, descarta memoria y exige Refresh. Corrupción, versión futura o almacenamiento indisponible bloquean tanto recomendaciones como edición.

`GuildWars2AccountGateway` ejecuta la comprobación atómica `tokeninfo → account` y valida ambos payloads antes de publicarlos. Un `401` se reintenta una vez; `403` en `tokeninfo` también se reintenta y no destruye el último estado bueno, mientras que `403` en `account` representa falta de permiso. Errores offline, timeout y `5xx` conservan el último estado conectado como aviso.

`ConnectionService` nace en `idle`; ni su construcción ni leer el estado ejecutan red. Solo `check()` cambia a `checking` y llama al gateway. Las llamadas simultáneas de una misma generación comparten promesa. `reset()` incrementa el run-id, borra `lastGood` e invalida resultados pendientes; por eso una comprobación antigua no puede sobrescribir una nueva aunque termine después. Los estados de UI son `idle`, `checking`, `connected`, `warning` y `error`.

H5.1 concentra la vista en una bitácora continua e independiente de la nota activa. `companion-status-model` es una proyección pura, sin Obsidian, red, timers ni storage: prioriza review/clasificación sobre delta, propuesta y telemetría, traduce todos los estados de detector/scheduler y ordena incidencias desde recovery hasta capacidades futuras. Recovery gobierna fase y acción para que una sesión guardada nunca quede oculta detrás de **Start**; apagar la detección suprime errores residuales de detector/scheduler. La vista posee un único timer de refresco visual para duración y countdown: actualiza nodos de texto, estado del botón e incidencia in-place, sin reconstruir controles ni robar foco; se limpia al expirar y al cerrar. La sesión activa usa `now - baseline.completedAt`; provisional y completa congelan en `finalSnapshot.completedAt`; una ventana inválida muestra `—` y eleva una incidencia. La rail responsive tiene exactamente Detector, Polling, Quality y Account, hereda únicamente tokens semánticos de Obsidian y deja cuenta, sesión y detector detallados en disclosures nativos.

H5.2 proyecta de forma pura los comandos desde estado de sesión, recovery, conexión y fallo de stop. Cada descriptor fija además la identidad del target —session id, machine/instance/fence y snapshots disponibles— para rechazar A→B aunque el status aparente no cambie. La paleta usa un adapter `checkCallback` testeable y el controlador valida dentro del microtask de ejecución y otra vez después de cualquier intención/confirmación, de modo que una entrada stale no muta el dominio. El vuelo abarca modal y backend; Cancel/Esc resuelve sin acción, los errores producen solo feedback fijo y unload invalida intenciones tardías. Toda recuperación de la vista y la paleta pasa por el mismo dispatcher; recover y discard comparten mutex para que dos decisiones sobre el mismo record nunca se solapen. Los adapters de backend solo aceptan `recovered`, `discarded` y `true` respectivamente. No existe cancelación de una sesión activa: Start y Review conservan Cancel/Esc en sus modales; discard de recovery y clear de sesión completa exigen confirmación explícita. Una sola acción de ribbon con icono de compás abre un menú proyectado por un adapter puro, conserva **Open companion** siempre y separa las acciones destructivas. Doble invocación comparte vuelo y cada tipo de modal tiene una sola instancia.

H5.3 intercala una cola durable entre el detector asistido y los workflows H3. `PendingProposalService` guarda propuestas y receipts v1 estrictos en la IndexedDB dedicada `tyrian-companion-confirmation-queue`; una transacción `readwrite` serializa revisión, dedupe/coalescing y claims entre ventanas. El detector pausa primero: si el enqueue falla conserva su propuesta; solo tras confirmarse la escritura transfiere la propiedad a la cola y vuelve a armado. Las propuestas se vuelven stale a las 6 h, expiran a las 24 h, los receipts duran 30 días y los límites son 32/256. Cada intención de UI conserva `proposalId`, cuenta y binding de sesión/baseline o ruleset; tras una barrera de reconcile, un claim de dos minutos liga exactamente `operationId` e `instanceId` y se renueva durante todo el workflow. Solo esa pareja recibe `already_claimed`: cualquier otra operación, incluso en la misma ventana, recibe `busy`. El registro de renovaciones pertenece al lifecycle del plugin y `onunload` cancela todos sus timers. Start/Stop manuales ordinarios no consumen la cola; solo la acción explícita sobre esa intención puede emitir `accepted`, y lo hace tras éxito del workflow. Reconcile invalida evidencia que ya no coincide con cuenta, sesión/baseline o recovery, excepto una operación reclamada en curso. El fondo es una frontera data-only con guard mecánico contra Obsidian UI, `Notice`, `Notification`, foco, reveal y red; actualiza ribbon e indicadores existentes in-place y difiere el render completo hasta volver al primer plano.

H5.4 separa validación, render y escritura de la nota final. `SessionNoteWriter` recibe un runtime H3 completo y capas H4 opcionales; una identidad cruzada bloquea toda escritura, mientras una capa económica malformada degrada solo su bloque. La reserva se reproduce con `partitionSessionValuation` y la recomendación se valida con el guard autoritativo H4.10, incluida su relación exacta con el envelope manual. La ruta usa UTC y SHA-256 de sesión/cuenta; una colisión del prefijo de 16 caracteres cae al hash completo sin sobrescribir. El adapter de producción usa únicamente `Vault`, nunca filesystem directo. Seis bloques `summary|evidence|results|economy|decision|provenance` llevan hash de su contenido: update exige pares únicos, ordenados e intactos, reemplaza solo esos bloques y las claves `tc_*`, y conserva frontmatter humano, tags y todo el cuerpo exterior byte a byte. El update hace CAS mediante `Vault.process` y reintenta sobre una edición humana concurrente, sin sobrescribir una lectura obsoleta. La barrera `writeSessionNoteBeforeClear` ejecuta esta escritura antes de borrar el runtime completo; conflicto o fallo de Vault conserva la sesión para reintento.

H5.5 añade `LootPresentationV1` como frontera data-only entre la evidencia preparada y sus superficies. El builder no consulta red, reloj, Vault ni Obsidian y no recalcula H2/H4: cruza cantidades ya validadas, permisos de clasificación, overlay, holds y recomendación, conservando filas físicas aunque una capa económica falle. `renderLootMarkdown` alimenta exactamente los managed blocks `results|economy|decision`; el adapter DOM consume el mismo VM y cambia por container query entre tabla completa, agrupación compacta y ledger móvil. Importes y recomendaciones se ocultan por permiso, los subtotales nunca se rotulan como totales y currency distinta de coin no se convierte a oro.

Un `429` se convierte en `retryAt` usando `Retry-After` o el backoff calculado. Mientras no venza, `ConnectionService.check()` devuelve el estado actual sin tocar red. Vista y ajustes muestran un countdown y deshabilitan la acción; sus intervalos se limpian al cerrar u ocultar cada superficie.

## Secretos

`TyrianSettings.apiKeySecret` guarda únicamente el nombre seleccionado por `SecretComponent`. `ObsidianApiKeyProvider` comprueba con `listSecrets` que la referencia siga existiendo, por lo que borrar el secreto impide la conexión. `GuildWars2Client.beginOperation()` lee el valor una única vez y devuelve una operación que reutiliza esa copia efímera en `tokeninfo`, `account` y sus reintentos. Nunca se persiste. Cambiar o quitar la referencia llama inmediatamente a `ConnectionService.reset()` antes del guardado.

La clave exige `account`. Los permisos `characters`, `inventories`, `builds`, `wallet`, `tradingpost`, `progression` y `unlocks` forman una matriz de capacidades: su ausencia genera aviso, no una clave inválida. Una clave expirada bloquea la conexión. Si un subtoken declara `urls`, se aceptan las restricciones que incluyan exactamente `/v2/tokeninfo` y `/v2/account`; se avisa de la limitación para módulos futuros. Omitir cualquiera de ambos endpoints bloquea.

Los warnings tienen causa explícita: `future_capabilities` describe una conexión actual válida con capacidades incompletas; `stale_connection` dice que se muestra la última cuenta verificada porque la comprobación actual falló.

## Snapshot de almacenamiento

`StorageSnapshotService` es un servicio de dominio puro que H3.2 invoca únicamente desde la acción explícita **Start session**; cargar el plugin o abrir la vista no lo ejecuta. Cada captura abre una `GuildWars2Operation` o reutiliza la operación ya fijada por un workflow mayor, conserva el valor efímero del secreto y verifica `tokeninfo → account` antes de capturar. Cuenta, permisos y restricciones quedan copiados en un contexto inmutable; identidad y capacidades nunca proceden del caller. La operación elegida se reutiliza para todos los endpoints y reintentos del snapshot. Todas las rutas de almacenamiento incluyen `?v=2024-07-20T01:00:00.000Z` mediante `PINNED_SCHEMA`; fijar el esquema evita que un cambio de forma de la API altere silenciosamente una captura.

Las fuentes obligatorias son roster de personajes, inventario codificado de cada personaje, inventario compartido, banco y materiales. `wallet` y `commerce/delivery` se consultan solo con `wallet` y `tradingpost`; sin permiso o sin la URL opcional autorizada quedan como `skipped`, no como error. La falta de capacidades obligatorias o de cualquiera de sus URLs exactas —incluidas las rutas dinámicas resueltas después del roster— produce `SnapshotCapabilityError` antes de lanzar el lote. Una respuesta `206`, fuente inaccesible o personaje ausente marca cobertura `partial` y nunca puede producir calidad estable. Payloads inválidos, fallos desconocidos y respuestas `401/403` se propagan: no se disfrazan como un snapshot parcial vacío.

Los parsers aceptan campos futuros desconocidos, incluidos nuevos valores textuales de binding, pero exigen ids enteros seguros positivos y cantidades enteras seguras no negativas. Las cantidades cero se validan y omiten del modelo normalizado. Cada objeto distingue `loose`, `equipped_container`, `embedded_upgrade`, `embedded_infusion` y `pending_claim`. Las bolsas equipadas cuentan como propiedad pero no como disponibilidad; las mejoras e infusiones engastadas también cuentan en `ownedByItem` y se excluyen de `availableByItem`. Skin, stats, atributos, charges y binding quedan como metadatos de colocación.

Cada resultado conserva holdings y divisas con desglose, además de `availableByItem`, `ownedByItem` y `currencyById`. Esta última agrega wallet y delivery por id de divisa y conserva ambos subtotales, sin colisionar con ids de objeto. El snapshot incluye id propio, id estable de cuenta, marcas de inicio y fin y cobertura de cada pasada. La cobertura final fusiona conservadoramente cualquier parcial histórico para que la calidad siempre tenga evidencia visible. No es una valoración de patrimonio total: no consulta catálogo, precios, equipamiento fuera de estas superficies ni otras fuentes de cuenta.

La consistencia usa dos pasadas y una tercera como máximo. Los fingerprints canónicos son independientes del orden de respuesta. Dos pasadas con la misma propiedad dan `stable` si también coinciden colocación y detalles o `stable_owned_placement_changed` si cambian ubicación, binding, cargas o configuración; si cambia la propiedad, B y C deben ser consecutivamente iguales o el resultado es `unstable`. Mover moneda entre delivery y wallet conserva propiedad y cambia colocación. Los límites compartidos por el servicio son seis peticiones globales y cuatro inventarios de personaje, también entre cuentas o claves distintas. Tras verificar por separado sus secretos, capturas simultáneas con el mismo token, cuenta, permisos y restricciones comparten el mismo lote; contextos diferentes nunca se coalescen. Todos los trabajos hermanos se drenan antes de liberar un lote fallido, evitando solapar un reintento con peticiones huérfanas.

## Catálogo público

`PublicCatalogService` recibe un `StorageSnapshot` y devuelve una `CatalogResolution` separada, correlacionada por `snapshotId`; no modifica el snapshot ni mezcla metadatos públicos con la observación de cuenta. Deduplica y ordena ids de objetos, divisas y categorías de materiales, consulta `/v2/items`, `/v2/currencies` y `/v2/materials` en lotes de hasta 200 e incluye `lang=es|en` y el mismo `PINNED_SCHEMA`. `GuildWars2PublicCatalogClient` carece deliberadamente de proveedor de secretos y nunca añade `Authorization`.

El modelo normaliza campos mínimos y conserva enums como strings abiertos. Los items retienen tipo/subtipo y un resumen de `details`: bolsas, consumibles, cargas, mini, sufijos, elecciones de stats y datos desconocidos validados para evolución. `suffix_item_id` conserva su id numérico; el campo legacy `secondary_suffix_item_id` conserva su representación string y `""` significa ausente. Las categorías deduplican sus `itemIds`. Wallet y delivery pueden resolver el mismo id público, pero la salida mantiene claves separadas como `wallet:1` y `delivery:1`.

La cobertura se publica por id como `resolved`, `missing`, `invalid`, `malformed` o `unavailable`, con causa y origen de red/cache. El parsing es por entrada: un válido no se descarta por otro malformado o extra. Duplicados idénticos se toleran; un conflicto invalida solo ese id. Una omisión en `200` es `missing_response`; `206` conserva válidos y registra omitidos como `partial_response`; `404` registra el lote como `not_found`. Warnings estructurados identifican extras, duplicados, malformados y categorías que no incluyen un item observado en material storage; estos avisos no modifican snapshot ni quality.

`CatalogCacheAdapter` separa la política de resolución del almacenamiento. Tanto la clave como el record contienen `schemaVersion` y `normalizerVersion`, evitando mezclar payloads incompatibles. `PersistentCatalogCache` guarda únicamente envelopes JSON en `IndexedDbCatalogRecordStore`; la base `tyrian-companion-public-catalog`, su versión y el store `catalog-records-v1` son explícitos. IndexedDB pertenece al almacenamiento local de la aplicación, fuera de notas/vault y sin secretos. Cada `get`/`set` usa su propia transacción. Antes de devolver un hit, los validators normalizados comprueban de forma completa key, envelope, record, timestamps, causa negativa y cada entidad por kind —campos obligatorios/opcionales, arrays, detalles anidados y `unknownDetails` JSON—; cualquier truncado, tipo corrupto o formato incompatible se trata como miss y se elimina sin romper la resolución. El adapter expone `dispose()` para cerrar la base, acepta un store inyectable y la factory cae explícitamente a `MemoryCatalogCache` si IndexedDB no está disponible o falla al abrir. No se abre ninguna base durante import, carga del plugin o construcción del servicio.

Ambos adapters clonan estructuralmente en sus fronteras: una resolución mutable nunca comparte arrays u objetos con el estado cacheado. Objetos y divisas tienen TTL de siete días, categorías de 24 horas y negativos de una hora. Ante `429/500/502/503/504`, timeout o red, un positivo de hasta 30 días puede responder como `cache_stale`; payloads inválidos y fallos no transitorios no usan stale. Resoluciones idénticas comparten promesa y el límite de tres peticiones simultáneas es global a la instancia del servicio.

Las pruebas del store usan `fake-indexeddb` sobre la implementación real para upgrade/store, commits, delete, reapertura, persistencia, blocked/late-success, versionchange y errores de apertura. Solo el callback `transaction.onabort` usa un harness mínimo de eventos: `fake-indexeddb` no expone una vía pública determinista para abortar el `put` interno entre su creación y el commit.

## Delta de almacenamiento

`compareStorageSnapshots(before, after)` es una función pura con contrato de salida v1. Valida que `ownedByItem`, `availableByItem` y `currencyById` coincidan exactamente con una recomputación completa desde holdings y currencies: ids positivos canónicos, enteros seguros, sin ceros ni campos extra y `total = wallet + delivery`. Una segunda pasada comprueba relaciones que un holding aislado no puede demostrar: toda ubicación de personaje pertenece al roster con cobertura completa, bolsas equipadas e hijos engastados tienen cantidad uno, y cada hijo tiene un root no embebido con el `parentItemId` esperado en la misma ubicación canónica. Delivery admite hijos porque el normalizador vivo los produce bajo su root `pending_claim`; una bolsa equipada no es root apto. Una divergencia de índices produce `aggregate_invariant_failed`; el álgebra del delta se vuelve a calcular desde las entidades normalizadas, no desde los índices. Antes de comparar exige ids distintos, misma cuenta y schema fijado, ventanas válidas no solapadas, quality `stable|stable_owned_placement_changed` y core/personajes completos. Un incumplimiento estructural produce `status: invalid` con razones estructuradas y sin cambios parciales.

Items y divisas se cualifican por separado. La superficie de items suma core y delivery solo cuando `commerce_delivery` está completa en ambos snapshots; si no, excluye delivery simétricamente como `core_only`. La divisa usa `wallet_and_delivery` solo cuando wallet y delivery están completas a ambos lados, `wallet_only` cuando wallet es comparable pero delivery no, y `unavailable` cuando wallet falta, es parcial o asimétrica. En este último caso `currencyChanges` y la composición de divisas quedan vacíos, pero el delta de items se conserva. Solo ambas superficies completas producen `status: comparable`; cualquier dimensión limitada o no disponible produce `limited`. Así, reclamar un item o mover monedas de delivery a wallet permanece neutral cuando existe evidencia suficiente, sin extrapolar datos ausentes.

`itemChanges` y `currencyChanges` contienen únicamente netos no nulos. `availabilityChanges` explica cambios de disponibilidad con propiedad neta cero. `compositionChanges` conserva, en orden canónico, movimientos, estado, binding, charges, skin, stats y split/merge sin convertirlos en loot. Warnings deterministas hacen visibles cobertura asimétrica, wallet no observada, cambio de roster, colocación inestable durante captura, límites de superficie y que el neto no revela turnover bruto. El comparador no aplica heurísticas de sesión/contaminación, catálogo, precios ni recomendaciones; esas decisiones pertenecen a H2.7 o verticales posteriores. El delta no se persiste ni está conectado a UI.

## Evidencia y contaminación de sesión

H2.7 añade dos funciones puras sin I/O. `buildBoundaryEvidence(before, after)` valida identidad, cuenta y ventana, y proyecta totales de items/monedas en delivery y divisas de wallet. Cada superficie conserva cobertura `complete_both|missing_both|asymmetric`, ids de snapshot, cuenta y ventana. Los totales se ordenan y llevan `before`, `after` y `delta` comprobable con enteros seguros.

`classifySessionDelta(delta, context)` acepta ambos argumentos como datos no confiables y aplica guards estructurales estrictos antes de acceder a ellos: identidad, ventanas, superficies, razones, warnings, cambios, composición, evidencia TP, frontera y cada variante de declaración. `null`, campos anidados ausentes, variantes desconocidas, propiedades extra incoherentes o aritmética corrupta devuelven `invalid` sin lanzar. Una composición solo es válida si ambos lados son no vacíos, distintos y canónicamente ordenados, conservan suma por id dentro de enteros seguros y respetan estado/ubicación: bolsa equipada solo en `equipped_bag`, root pending solo en delivery e hijos unitarios con relación embebida válida fuera de una bolsa equipada. Las composiciones de divisa conservan igualmente el total. Después valida que la frontera coincida con ids, cuenta, ventana y superficies del delta. El contexto aporta evidencia TP `complete|partial|unavailable` con eventos normalizados dentro de ventana, declaración explícita del usuario y certeza de fronteras. La prioridad es `invalid > contaminated > estimated > exact`: cambios de delivery con cobertura completa, compra/venta TP, descenso de wallet observado completamente, roster cambiado o actividades declaradas contaminan. Datos residuales bajo cobertura ausente/asimétrica no se interpretan como actividad. Un aumento de wallet es ambiguo mientras falte confirmación, pero una declaración limpia con fronteras manuales puede resolverlo dejando razón informativa. La evidencia observada siempre domina una declaración limpia en conflicto.

La evidencia representa monedas de delivery explícitamente como currency id `1`, el namespace de monedas de GW2. Tanto el parser de snapshots de frontera como el guard de `BoundaryEvidence` rechazan cualquier otro id bajo namespace `delivery`; los ids de wallet permanecen abiertos.

## Coordinación de sesión activa

H1.4 introduce `ActiveSessionLeaseCoordinator`, una primitiva sin UI ni acciones de producto. Abre de forma lazy una IndexedDB dedicada `tyrian-companion-coordination`; no usa settings, `data.json`, notas del vault ni `SecretStorage`, y nunca cae a memoria. Un único estado versionado conserva `machineId` durable, contador de fence y lease activa. La creación de identidad, incremento de contador y adquisición se confirman en la misma transacción `readwrite`.

Cada proceso/ventana recibe un `instanceId` efímero. Su formato se valida antes de abrir IndexedDB; un id vacío o excesivo falla como corrupto sin I/O, y la creación del lease valida simétricamente machine/instance/session. `acquire(sessionId)` es single-flight e idempotente por instancia: si esa instancia ya posee un lease vigente, cualquier intención posterior devuelve `already_owned` con el mismo lease/fence/session efectivo, sin sustituirlo. Otros propietarios reciben `busy`. Un lease vencido exige doble observación separada por `expiryConfirmDelayMs`; la segunda transacción compara exactamente el lease observado antes de incrementar fence, por lo que un heartbeat concurrente evita el robo. `renew`, `assertOwned` y `release` exigen CAS exacto de todos los campos: un handle antiguo nunca renueva ni borra al nuevo owner.

Los timestamps persistidos proceden de `Date.now` inyectable y se muestrean dentro de la operación, después de abrir/esperar/leer IndexedDB; una cola lenta nunca crea ni devuelve un lease ya caducado con una hora antigua. Reloj hacia atrás, enteros inseguros, corrupción, schema desconocido, overflow del fence, abort, fallo de apertura o `versionchange` fallan cerrados y las APIs públicas devuelven resultados tipados sin lanzar. Un mutex por coordinador serializa operaciones locales; IndexedDB serializa conexiones/procesos. `dispose()` cierra también una apertura tardía. No existe timer automático de heartbeat: el lifecycle futuro deberá llamar `renew` explícitamente y poseer su limpieza.

## Máquina de estados de sesión

H3.1 define `transitionSession(state, event)` como frontera pura, versionada y defensiva. Su recorrido nominal es `idle → starting → active → stopping → provisional → complete`; cualquier estado en curso puede terminar en `error`, y solo `complete|error` pueden volver a `idle` mediante `reset`. Las entregas repetidas del mismo evento son idempotentes, mientras que saltos de fase, eventos contradictorios o datos con propiedades desconocidas se rechazan sin mutar el estado previo ni lanzar hacia el caller.

`starting` conserva la identidad estable de autoridad derivada del lease: máquina, instancia, sesión, fence y momento de adquisición. Renovación y expiración siguen perteneciendo al coordinador; cada workflow futuro deberá ejecutar `assertOwned` antes de confirmar una transición. Todas las transiciones posteriores exigen la misma autoridad, por lo que un owner con fence antiguo no puede avanzar, finalizar ni marcar como fallida una sesión recuperada por otra instancia.

`active` solo acepta como baseline una captura `stable|stable_owned_placement_changed`. `provisional` exige otra captura comparable, distinta, de la misma cuenta y schema, con ventanas ordenadas y no solapadas. El estado conserva referencias mínimas a ambas capturas, no sus holdings. `complete` registra únicamente `exact|estimated|contaminated`; una clasificación inválida debe conducir a `error` o permanecer provisional. `error` guarda el último estado válido completo para que H3.4 recupere sin reconstruir evidencia perdida.

H3.1 permanece puro: no adquiere ni renueva leases, no captura snapshots, no llama a H2.7, no temporiza, no pregunta ni persiste. H3.2 usa esa frontera desde `ManualSessionStartService`: valida la entrada antes de coordinar, adquiere un lease, aplica `request_start`, mantiene un heartbeat sin solapes y captura el baseline con `StorageSnapshotService.captureWithOperation`. La misma `GuildWars2Operation` —y por tanto la misma copia efímera de la clave— obtiene después `/v2/characters/:id/buildtabs/active` con schema fijado. La sesión guarda personaje, build normalizado, Magic Find manual y timestamp; el total efectivo de Magic Find no se inventa a partir de `/account/luck`.

Justo antes de `confirm_start`, el workflow ejecuta `assertOwned` con el handle renovado. Un snapshot parcial/inestable, personaje ausente, payload de build inválido, permiso `builds` ausente, pérdida del fence o fallo inesperado pasa por `fail → reset`, detiene el timer y libera el lease best-effort. El estado de producto queda `idle` y el error saneado vive fuera de la máquina para mostrarse en UI. Una pérdida posterior del heartbeat mueve una sesión activa a `error` conservando su evidencia para H3.4.

H3.3 amplía el mismo orquestador con una acción explícita de parada. `request_stop` fija una sola frontera temporal y mantiene el heartbeat; después una nueva operación con clave efímera captura el snapshot final A/B/C. El workflow exige calidad estable, calcula `compareStorageSnapshots(baseline, final)` y rechaza resultados `invalid`. Justo antes de `confirm_stop` vuelve a ejecutar `assertOwned` con el handle renovado. Solo entonces publica `provisional` y conserva el delta físico en memoria para la UI y la revisión H3.9. Un fallo transitorio de captura o delta deja `stopping`, el baseline original y la misma frontera intactos, por lo que **Retry stop** no recaptura ni pierde el inicio. Una pérdida de fence o coordinación pasa a `error` con el estado `stopping` completo. H3.9 sigue siendo dueño de revisión, clasificación aceptada, finalización y persistencia; H3.3 no llama todavía al clasificador H2.7.

H3.4 añade una segunda IndexedDB dedicada, `tyrian-companion-session-runtime`, separada de coordinación, catálogo, settings y vault. Cada commit recuperable guarda un record JSON versionado con el estado cercado, el snapshot inicial completo y, para `provisional`, el snapshot final completo, el delta H2.6 recomputado y la captura H4.4 de precios de los items ganados. El validator vuelve a comprobar estado, referencias, snapshots comparables, envelope de pasadas, equivalencia exacta del delta y correlación de precios; corrupción o versión incompatible permanecen intactas y bloquean un inicio nuevo. No existe fallback a memoria en producción.

La carga del plugin solo lee ese record local: no adquiere lease, no inicia heartbeat y no llama a GW2. **Recover session** adquiere explícitamente el mismo `sessionId`, exige una autoridad de la misma máquina con fence estrictamente superior, persiste esa nueva autoridad mediante CAS antes de exponer el estado y reinicia el heartbeat. **Discard saved session** muestra confirmación destructiva y también debe adquirir el lease antes de borrar; una ventana viva devuelve `busy`. Cada save/clear compara máquina, sesión, fence, instancia y adquisición, y ejecuta `assertOwned` inmediatamente antes del commit, por lo que un owner antiguo no puede pisar ni eliminar la evidencia recuperada. `dispose()` libera el lease best-effort pero nunca borra el record: cierre forzado y reinicio dependen del TTL/fencing, no de que termine una promesa de unload.

`exact` exige delta completo/comparable, fronteras confirmadas manualmente, declaración limpia y ausencia de contaminación. Esa declaración puede suplir TP no disponible dejando una razón informativa. La salida v1 usa scope `observed_storage_net`, razones y solicitudes de revisión deduplicadas/canónicas, confianza y permisos explícitos. Un resultado contaminado puede finalizar y mostrar solo el neto; uno estimado permite valoración provisional pero no rendimiento bruto, y solo finaliza si la aceptación ya está reflejada como frontera manual y declaración limpia; uno inválido bloquea todo. Las recomendaciones permanecen deshabilitadas incluso en exacto hasta que existan motores económicos. H3.9 conserva ownership de preguntas, aceptación y persistencia.

## Ajustes y migración

El esquema actual es `4`. `migrateSettings` convierte de forma idempotente los datos anteriores, descarta propiedades desconocidas y valida enums e intervalos. La migración v2→v3 añadió `managedAssetsRoot:null`; v4 separa los destinos portables de `legacyOutputFolder`/`legacyManagedAssetsRoot`. La reescritura canónica de ajustes conserva solo esos campos legacy autorizados y elimina cualquier propiedad desconocida. Si un valor relativo antes aceptado deja de ser portable —nombre reservado o longitud— queda retenido read-only como legacy, no puede producir notas ni assets nuevos ni alterar el puntero durable. Move/Remove siempre inspeccionan la raíz esperada aunque el puntero ya la nombre: el manifiesto debe ser owned y exacto, y Move exige además `ready` antes de aplicar destino; un puntero que nombra otra raíz es conflicto. Si Remove ya dejó ese manifiesto exacto detached y se perdió su respuesta, el retry solo confirma ese terminal con puntero inicial vacío, sin adoptar ni tocar Vault, y vuelve a leer el puntero para exigir estado, generación y raíz idénticos tras la inspección. Con un puntero aún en la raíz esperada, Remove retoma su transición normal y solo entonces lo libera. La autoridad para carreras continúa exclusivamente en el puntero IndexedDB: la migración nunca lo modifica. La carpeta de salida solo acepta segmentos relativos separados por `/`: normaliza a NFC en vez de rechazar NFD, y sigue rechazando navegación, controles y surrogates sin emparejar, barras inversas, `:*?"<>|`, punto o espacio final, nombres Windows reservados, rutas absolutas y el directorio de configuración real del vault. `resolveVaultFolderInput` valida un valor tecleado en Ajustes con el mismo contrato pero sin el fallback de `normalizeVaultFolder`: un rechazo legítimo se muestra junto al campo y nunca sustituye en silencio el valor guardado por el default.

`outputFolder` es la única raíz que el usuario elige: también gobierna dónde viven Bases y plantillas, no solo notas. `managedAssetsRoot` dejó de poder quedar divergido sin que el plugin reaccione. Un cambio explícito de carpeta con assets ya instalados dispara `reconcileManagedAssetsRoot`, que reubica Bases/plantillas al nuevo destino con la misma `ManagedAssetsLifecycle.move` journaled del botón manual "Mover" —nunca una copia paralela—, y dos raíces vuelven a quedar iguales tras un `updateSettings` con `outputFolder` cambiado. La misma reconciliación corre una vez al terminar `initializeRuntime`, sin bloquear el arranque, para curar una instalación que ya empezó divergida (una raíz de assets que nunca siguió un cambio de carpeta posterior a H5.8). Move solo borra los bytes de origen después de instalar en destino y se niega sobre un root modificado/ajeno/en conflicto, así que una reconciliación bloqueada deja ambas raíces exactamente como estaban —nunca a medias— y sigue mostrando la divergencia y el botón "Mover" manual en Ajustes. Un `Notice` avisa del resultado (reubicado o bloqueado) porque mover ficheros del vault sin que el usuario lo vea al abrir Obsidian se consideró peor que avisar después del hecho. Una raíz legacy queda deliberadamente fuera de esta reconciliación automática: solo se adopta mediante el Move explícito ya documentado, nunca por sí sola al arrancar.

## Assets gestionados H5.6

`ManagedAssetsManager` recibe un port mínimo de Vault y un bundle inmutable durante cada operación. Construirlo o cargar el plugin no consulta el vault. `inspect` clasifica cada ruta estable como create/unchanged/update/missing/recoverable/modified/occupied/future/conflict; `planManagedAssets` es puro y Preview nunca escribe. El manifiesto `Tyrian Companion Assets.json` es la autoridad y conserva root, locale, bundle, generación, hashes instalados y journal completo. Su esquema v2 añade a cada Base una huella SHA-256 del valor YAML canónico: comentarios, comillas y formato no cambian ownership, pero YAML inválido o un cambio de valor siguen bloqueando. Los templates `.md` conservan la exigencia de bytes y marcador exactos. Un manifiesto v1 solo puede inferir la huella cuando el bundle aún contiene la misma versión registrada; Apply la persiste por CAS antes de futuros upgrades. Si la versión registrada ya es anterior y perdió marcador/bytes sin huella, falla cerrado.

Una operación explícita hace primero CAS de `ready` a `applying`, reanuda solo el mismo operationId determinista y verifica hash anterior/posterior en cada paso. La identidad cubre únicamente los campos inmutables de cada step; `pending`/`done` es progreso CAS y no cambia la operación. Los journals anteriores ya avanzados se aceptan solo cuando su identidad legacy coincide con los estados iniciales inferibles por ownership y versión. Un asset registrado ausente usa `beforeHash:null`, por lo que Repair puede recrearlo sin confundir el hash histórico con el estado actual. Create resuelve carreras por relectura; update usa `Vault.process`; ningún modified/unowned/future se sobrescribe. Repair recrea registrados ausentes y reanuda journals. `ManagedAssetsLifecycle` abre perezosamente `tyrian-companion-managed-assets`; cada record se separa mediante el SHA-256 de la identidad canónica local del vault, sin persistir su ruta. Root, generación y estado durable cercan install/remove/move. Un fallo de Apply solo libera el claim si una inspección prueba que no llegó a existir manifiesto; cualquier journal conserva `installing` para reintento. Move reclama origen, activa destino, revalida el mismo record antes de desinstalar origen y converge si otra ventana ya activó ese destino. Remove reanuda incluso si la respuesta al CAS final se perdió. Uninstall exige ownership exacto para `.md` y equivalencia YAML registrada para `.base`, escribe un tombstone por CAS, lo relee y usa `FileManager.trashFile`; no borra carpetas y deja el manifiesto detached. El motor no usa filesystem, red, secretos ni locks de sesión; la adaptación de entrada deriva y hashea la ruta base únicamente para namespace local.

## Base de Halloween H5.7

El esquema de nota de sesión sube a v2 y añade `tc_event`, `tc_event_source` y la acción/cantidad/ruta de recomendación como claves estables. `tc_event` solo acepta una declaración manual explícita fechada dentro de la sesión o una frontera de inicio asistida aceptada que conserve durablemente el `RelevantStartProposal` completo, corresponda a la misma sesión/cuenta y use exactamente el ruleset Halloween id/version y su proposalId canónico. Los records H3.10 antiguos siguen siendo legibles, pero al no conservar esa procedencia no etiquetan el evento. Nunca se deduce de prefijos, fechas, nombres, texto ni sacos. Los campos de recomendación solo se materializan para un resultado H4.10 `ready` cuyo envelope H4.12 coincida; evidencia opcional inválida conserva la nota pero deja esos campos en `null`.

El bundle gestionado conserva `Sessions.base` y registra variantes ES/EN del mismo asset/path `Halloween.base`; H5.6 selecciona neutral + locale activo y aplica ES↔EN con el mismo manifiesto, hash y CAS. El YAML define cinco tablas sobre notas `tc_schema >= 2`, `tc_event: halloween`: últimas, por build, rendimiento exacto/alto/completo, contaminadas y decisiones históricas manuales. Fórmulas y filtros distinguen `null` de cero y no recalculan frescura ni economía. El módulo empaquetado no conoce Vault, red ni writer. La QA visual en una bóveda desechable sigue pendiente; la bóveda canónica no se toca.

## Inventario durable en Vault

`InventoryVaultCaptureService` reutiliza una `GuildWars2Operation` obtenida de `GuildWars2Client`, la
captura estable completa de `StorageSnapshotService`, `PublicCatalogService` y el batch público de
precios del Inventory Advisor. Solo se construye y ejecuta tras **Previsualizar sincronización**. Exige
calidad `stable` y cobertura completa de personajes, inventario compartido, banco y materiales antes
de permitir que una ausencia convierta una fila previa en inactiva.

`prepareInventoryVaultSyncInput` elimina `accountId`, `snapshotId`, token y payloads antes de cruzar la
frontera del writer. Conserva únicamente una fila por `itemId + source + character`; agrega pilas del
mismo personaje, excluye bolsas equipadas y objetos embebidos, y calcula por fila
`bid.unitCopper * quantity` con aritmética segura. Los IDs y filenames usan item, código de fuente y
un prefijo SHA-256 del personaje, nunca su nombre ni la cuenta.

`InventoryVaultSyncService` recibe solo un port de Vault. Preview enumera las notas dinámicas bajo la
raíz portable derivada de `outputFolder` —la única raíz de notas, nunca `managedAssetsRoot`—, verifica
marker, schema, relación de ruta y hash de bytes, y produce pasos create/update/unchanged/deactivate/conflict sin escribir. Apply
relee todos los bytes esperados antes de la primera mutación y usa `Vault.process` como CAS por nota.
Una nota ajena, modificada, duplicada o futura dentro de la carpeta técnica bloquea el plan completo.
Una posición ausente se conserva con `tc_active:false`, cantidad cero y valor total cero. Estas notas
no forman parte del manifiesto de assets y por tanto no se borran al desinstalar Bases.

`InventoryVaultSyncController` conserva plan y estado solo en memoria. Expone idle, disabled, loading,
preview, applying, success, error y conflict en el Inventory Advisor y en dos comandos estables. Abrir
la vista no invoca puertos. El bundle gestionado v5 instala variantes ES/EN de `Inventory.base` y
`Materials.base`; ambas filtran marker/schema, no carpeta, ordenan por una fórmula numérica en oro y
registran los nombres visibles del frontmatter con claves `properties.note.tc_*`, que es la forma
canónica que Obsidian serializa. Las referencias operativas de filtros, fórmulas, orden y sort siguen
usando los campos `tc_*`; las propiedades `formula.*` y `file.*` conservan su namespace propio.

## Rutas Vault H5.8

`normalizeVaultRelativePath` es la frontera única para toda ruta creada o aceptada por el plugin. Normaliza a NFC en vez de exigirlo del caller —un NFD como el que produce macOS se acepta y se recompone, no se rechaza—, exige ruta relativa con `/`, segmentos no vacíos ni de navegación, sin controles ni surrogates sin emparejar, sin punto/espacio final, sin nombres reservados de Windows, incluidos COM/LPT con superíndices, y con límites conservadores de 120 caracteres por segmento y 240 por ruta. Settings y notas reservan además el directorio de configuración real del vault y limitan su raíz a 128 caracteres para que las rutas UTC + hash de las sesiones permanezcan portables. Assets reutiliza el mismo contrato antes de aceptar root, manifiesto, journal o ruta empaquetada: cada entrada ready/detached debe usar `neutral|manifest.locale` y, con el bundle actual, coincidir como conjunto exacto por id/kind/locale/path; un bundle anterior compatible se conserva para upgrade o retirada. Un journal solo admite su hash previo registrado, su hash actual o ausencia demostrada. Una raíz legacy queda limitada a Move/Remove explícito, se adopta solo tras manifiesto owned exacto y valida marker y hash antes de tocarla. Las rutas de sesión contienen solo UTC y referencias SHA-256; las de inventario usan item, fuente y hash de personaje. Ninguna incorpora cuenta, nombre de personaje, evento ni ruta local.

## Internacionalización H5.9

`core/i18n.ts` es el único traductor tipado para `es|en`: compone el catálogo base con el fragmento runtime y comprueba en tests la paridad exacta de claves y placeholders. Los textos interpolados se devuelven como texto plano; las incidencias, nombres de cuenta, personajes y otros datos no confiables nunca se convierten en HTML. Los IDs de comandos, enums, marcadores/hash, rutas, frontmatter `tc_*` y propiedades/fórmulas de Bases permanecen neutrales; solo se localizan etiquetas, valores de presentación y contenido Markdown generado. Cambiar idioma repinta ajustes, Companion, menús y assets seleccionados en vivo; Obsidian conserva los nombres de comandos ya registrados, por lo que su paleta adopta el nuevo nombre tras recargar el plugin.

## Historial durable H5.10

`SessionHistoryService` es una frontera Vault-only creada en `onload` sin listar ni leer archivos. Solo la acción explícita de Ajustes invoca el escaneo Markdown vault-wide. Reutiliza el codec de frontmatter y marcadores H5.4/H5.7: exige `tc_kind: gw2_farming_session`, schema 1/2, referencias SHA-256 y los seis bloques en orden con hash válido; una nota sin `tc_*` se ignora, pero cualquier indicio `tc_*` incompleto, duplicado o incompatible bloquea el lote. El frontmatter propiedad del plugin se analiza con YAML Core real, claves únicas y los estilos escalares exactos del productor: strings con comillas dobles, enteros seguros y `null`; comillas rotas, tipos compuestos, coerciones o duplicados fallan cerrados. El decoder valida además enums, opcionales y la igualdad `ended - started = duration`. Los records exportables son una proyección de propiedades `tc_*` seguras, sin IDs originales, ruta Vault, personaje/build o cuerpo humano. JSON v1 y CSV de columnas fijas se ordenan por inicio/fin/ref; tanto cabeceras como datos pasan por el mismo serializador CSV, usan CRLF y apóstrofo ante una fórmula incluso tras espacios o controles; cero sesiones produce solo la cabecera. Ambos ficheros son create-only: se preflightan los dos antes de crear un sibling y una repetición admite únicamente bytes idénticos, permitiendo concluir un par parcial sin sobrescribirlo. `Sessions.base` conserva content v2 dentro del bundle gestionado v4, por lo que un plugin anterior reconoce el manifiesto más nuevo y no lo pisa.

El scrub H5.10 no elimina archivos ni toca exports, settings, assets o stores. Su acción warning en Ajustes hace preview antes de abrir una confirmación ES/EN y mantiene en memoria un token opaco con `path`, `sessionRef`, SHA-256 y bytes esperados; el token no se persiste y se consume o revoca al confirmar, cancelar, reemplazar la preview o descargar el plugin. Al ejecutarlo, `SessionHistoryRuntimeAuthority` adquiere una exclusión compartida que bloquea las entradas de transición de sesión, recovery y detector; además relee que runtime está `idle`, recovery `none` y detector `disarmed` justo antes de cada `Vault.process`. Solo sustituye el contenido si los bytes siguen siendo exactamente los previsualizados. El codec elimina todas las claves frontmatter `tc_*` y únicamente los seis bloques gestionados con hashes válidos, preservando las líneas frontmatter no `tc_*`, tags, `descripcion` y todo texto exterior. Una edición/tamper, borrado o renombrado tras preview devuelve conflicto sin pisar nada; `already_absent` exige que los bytes actuales coincidan exactamente con el resultado scrubbed previsto.

`SecretStorage` está disponible desde Obsidian `1.11.4`, que por ello es también `minAppVersion`.

## Decisiones futuras de producto

Antes de ampliar la vertical actual hay que decidir:

- Cómo persistir objetivos.
- Qué panel o agregación durable adicional tendrá el historial de sesiones finalizadas, más allá de la exportación H5.10; el runtime recuperable H3.4 ya es local y versionado.
- Qué formatos de nota adicionales, fuera del contrato H5.4 de sesión completa, puede escribir el plugin.
- Cómo recuperar automáticamente cambios de roster/`404` durante una captura sin ocultar cobertura parcial.
- Cómo coordinar un cooldown `429` global entre las peticiones paralelas de una captura.
- Cómo complementar la declaración H3.9 con historial personal del Trading Post sin convertirlo en actividad inferida.
