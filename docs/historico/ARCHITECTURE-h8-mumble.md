# Histórico de `docs/ARCHITECTURE.md` — narrativa H8.1 a H8.7 (Mumble Link)

Movido desde `docs/ARCHITECTURE.md`, sección «Frontera de plataforma e integración», el 2026-09-10,
en H13.13 (recorte de `docs/` sin perder trazabilidad). Es la copia literal del relato completo de
diseño de H8.1 a H8.7: el spike C de validación, el protocolo IPC, el runtime del helper, el cliente
TypeScript y la frontera de lanzamiento seguro. El código que describe sigue en `main`, aislado y sin
wiring desde `main.ts`, con 0 bytes en el bundle publicado; las decisiones formales y sus triggers de
reapertura viven en `docs/adr/0001` a `docs/adr/0005`, que siguen vigentes y no se movieron. El estado
resumido de H8.5 (helper sin firma ni QA real) sigue repetido en una frase viva dentro de
`docs/ARCHITECTURE.md`.

---

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

El helper tendrá un ZIP separado, nunca el ZIP BRAT del plugin; sus cinco entradas exactas y el
requisito de que manifest y checksums liguen el mismo build/target están en [ADR
0001](../adr/0001-h8-3-native-mumble-helper.md), sección `package`. La firma
Authenticode y todo el empaquetado productivo siguen pendientes. H8.5 transforma el guard H8.3 en
un censo positivo de la raíz Rust, toolchain, dependencias, única isla `unsafe`, APIs Win32 y tests;
continúa rechazando outputs nativos tracked/no ignorados y cualquier raíz nativa alternativa. Un
PDB efímero generado por MSVC puede vivir solo bajo el `target` ignorado de compilación; nunca entra
en staging, paquete ni artefacto CI.
La decisión completa y sus triggers viven en
[ADR 0001](../adr/0001-h8-3-native-mumble-helper.md).

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
El contrato completo parseable vive en [ADR 0002](../adr/0002-h8-4-local-ipc-protocol.md).

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
[ADR 0005](../adr/0005-h8-8-shadow-presence-policy.md) fija el límite de esta fase.

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
