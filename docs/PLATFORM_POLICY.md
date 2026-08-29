# Política de plataformas e integraciones

Este documento fija las decisiones H0.4 y H0.6 vigentes desde el 14 de agosto de 2026. El
MVP sigue siendo un plugin de Obsidian para escritorio y obtiene la evidencia de juego
exclusivamente de la API oficial de Guild Wars 2.

## Matriz de plataformas

| Prioridad | Entorno de juego | Alcance del MVP | Criterio de release |
| --- | --- | --- | --- |
| Primaria | Linux con Steam/Proton | Conexión, sesiones manuales, detección asistida por API, recovery y artefactos Vault | La matriz funcional completa es bloqueante. No se publica con pérdida de datos, credenciales expuestas o un flujo obligatorio roto. |
| Secundaria | macOS con CrossOver | El mismo contrato API-only, sin integración con el proceso de CrossOver | Son bloqueantes los fallos de datos, privacidad, conexión, lifecycle o recovery. Una limitación exclusiva de presentación puede documentarse sin prometer paridad visual inmediata. |
| Beta | Windows | El mismo contrato API-only, distribuido como soporte experimental | Debe pasar instalación, conexión, sesión manual, recovery y escritura segura. Un defecto exclusivamente Windows puede quedar conocido durante la beta; nunca se relajan privacidad, integridad ni la prohibición de operar sobre la cuenta. |

Las métricas se publican separadas por plataforma y versión de Steam/Proton, CrossOver,
Windows, Obsidian y Tyrian Companion. Un agregado global no puede ocultar una regresión de la
plataforma primaria. La compatibilidad móvil sigue fuera de alcance.

## Límite del MVP: solo API

El MVP puede consultar exclusivamente endpoints oficiales de Guild Wars 2. La carga del plugin y
la apertura de la vista permanecen sin red; una conexión, una captura manual o el armado explícito
de la detección asistida y la activación explícita del histórico público de precios son las únicas
puertas de entrada a las consultas ya descritas en
[Arquitectura](ARCHITECTURE.md).

El MVP no integra Mumble Link, no inspecciona el cliente de juego y no depende de Steam, Proton o
CrossOver para obtener evidencia. Inicio y parada asistidos siguen siendo propuestas: una persona
debe aceptarlas o descartarlas. Vender, listar, abrir, consumir, mover, fabricar, canjear o ejecutar
cualquier otra operación dentro del juego o sobre la cuenta queda siempre fuera del companion.

## Histórico público de precios H9.1

H9.1 conserva el mismo contrato portable: únicamente consulta la API oficial pública
`/v2/commerce/prices`, sin clave, GW2Efficiency, proceso del juego ni adapter específico de Steam,
Proton, CrossOver o Windows. Parte desactivado. Construcción, carga y apertura del panel no abren su
IndexedDB ni hacen red; el polling empieza solo tras opt-in y runtime ready. Linux, macOS y Windows
comparten intervalos 5/15/30/60, retenciones 2/7/14/30 raw y 42/90/180/365 diarias, lotes secuenciales
de hasta 200 ids y el cooldown global.

Offline pausa el scheduler; volver online, recuperar visibilidad o despertar programa una captura
fresca del slot actual, nunca una ráfaga de catch-up. El almacenamiento es IndexedDB local por
identidad hash de vault y no crea notas ni depende de Obsidian Sync. Un fallo futuro/corrupto,
bloqueo o cuota se muestra y detiene la captura, sin fallback a memoria. La QA de presentación debe
revisar 320/480/760 px en temas claro y oscuro: controles apilados, SVG fluido, tabla con overflow,
targets de 44 px, foco visible y estados disabled/loading/empty/partial/offline/backoff/error. La
estructura accesible está automatizada; el contraste AA no se afirma sin medir los temas reales.

## Alertas de Halloween H11-A

Desactivadas no abren su IndexedDB, no consultan catálogo/precios/unlocks y no crean timers. Offline
no recupera intervalos. El store y los ids observados son locales al dispositivo y Obsidian Sync no
sincroniza la bandeja. La UI contempla 320/480/760 px, controles de 44 px y variables semánticas del
tema; el contraste real queda para QA en temas de Obsidian y no se afirma desde tests de fuente.
Tras el opt-in, cada activación lee automáticamente las notas de sesión canónicas explícitamente
marcadas Halloween para reconstruir seen antes del vivo; v2 mantiene aprendizaje parcial y no
habilita `first_seen`. Cambios create/modify/delete/rename bajo la carpeta de sesiones vigente
disparan un refresh coalescido, y el vivo espera ese backfill, sin timers ni tormentas. No pide
confirmación porque solo lee Vault y escribe IndexedDB local. Una nota v3 corrupta falla cerrada. El
polling solo ingresa después de aceptar la sesión Halloween y el cierre serializado sella y reemplaza
el episodio provisional incluso con cero ganancias. El sello usa el delta final estable y el primer
writer multiwindow gana. Un final sin provisional emite exactamente un aviso; contenido nuevo tras
un reconocimiento vuelve a unread y solo entonces puede emitir uno nuevo.

## Mumble Link en v2

H8.1 cumple el prerrequisito documental y de modelos. H8.2 mantiene un spike no productivo para
validar la lectura en CrossOver; H8.3 elige la forma, H8.4 fija el protocolo y H8.5 implementa solo
el helper/servidor Rust. H8.6 implementa un cliente TypeScript puro, salud y observación shadow como
núcleo aislado con puertos inyectados. H8.7 añade contratos/planes cerrados y un adapter de proceso
inyectado, pero ningún executor host. El plugin aún no tiene launcher real, composición,
settings ni UI. H8.8 añade únicamente la política pura de presencia/ausencia y un DTO shadow
efímero, sin cablearlos al producto. Mumble Link solo
puede entrar en una v2 como componente local opcional, separado del
proceso de Obsidian. Su única entrada será la interfaz documentada; no podrá inyectar código,
enumerar o controlar procesos del juego, leer su memoria privada ni usar técnicas alternativas si
el enlace no está disponible.

La instalación y la activación requieren opt-in. Los defaults recomendados para la primera fase son
`enabled:false`; una vez habilitado, rollout `shadow`, observación `on_when_armed`, proyección
`mapId + actividad derivada` y retención `none`. Están marcados `recommended_revisable`: no se
cambiarán silenciosamente y salir de shadow exige decisión humana, revisión del threat model y QA
real. Shadow puede crear un DTO comparativo interno H8.8, pero no una propuesta H5.3: no lo encola,
persiste, muestra ni deja que altere una sesión.

La API-only v1 sigue siendo autoritativa. El dato local no puede corregir por sí solo un snapshot,
declarar un evento, iniciar/parar una sesión ni resolver una discrepancia. Como máximo, después de
salir de shadow, podrá acotar una ventana o generar una propuesta que H3.8/H5.3 presenta a una
persona. Aceptar o descartar sigue siendo obligatorio. Deshabilitar, no instalar o perder el helper
mantiene funcional el recorrido API-only y degrada la señal local de forma explícita.

### Fuente mínima y semántica

La allowlist de lectura futura se limita a `LinkedMem.uiVersion`, `LinkedMem.uiTick`,
`LinkedMem.context_len` y `MumbleContext.mapId`. Los dos primeros enteros y `mapId` son `uint32`;
`uiVersion` se acepta solo con valor `2`. `context_len` se documenta actualmente como 48, debe ser al menos 32 para cubrir `mapId` tras los
28 bytes de `serverAddress` y no puede superar el buffer de 256 bytes. Un tamaño o versión no
soportado se descarta. `uiTick` se expone como `tick`; `activity` se deriva únicamente como
`link_advancing` cuando avanza o `link_stalled` tras 1.500 ms sin avance. Ese umbral es recomendado
y revisable. Ningún estado significa movimiento, combate o farmeo.

No se lee ni publica `identity`, nombre de personaje, profesión, coordenadas de avatar/cámara/mapa,
`uiState`, servidor, shard, instance, build, `processId`, mount ni campos futuros. La API oficial
`/v2/maps/866?lang=en|es` confirmó el 2026-08-14 el mapa inicial: id `866`, **Mad King's Labyrinth /
Laberinto del Rey Loco**, tipo `Public`. El layout se fija a la revisión `3086433` de
`API:MumbleLink`, el layout oficial Mumble al commit
`088209c5a14650a04f6c88991374b44655ead34c` y el bloque de contexto ArenaNet al commit
`06c4175ad55e4338c7e824c01fdeb6978d1b33d3`.

### Transporte, retención y fallo

H8.4 fija TCP IPv4 con helper servidor y plugin cliente. El helper hará bind solo a
`127.0.0.1:0`. El plugin entregará `bootstrap` por stdin, leerá `ready` por stdout, conectará al
puerto efectivo, enviará `hello` y exigirá `welcome`. Todas esas superficies y TCP usan records con
longitud `uint32` big-endian de cuatro bytes seguida por 1–512 bytes de JSON UTF-8; el parser
incremental retiene como máximo 516 bytes simultáneos incluso ante chunks coalesced arbitrariamente
grandes; libera su referencia y transfiere el buffer antes del callback, sin copiar el payload. Se rechazan
longitud cero/513+, truncado, UTF-8 inválido, BOM, JSON inválido/no objeto/con trailing, duplicados y
claves extra o ausentes. Host distinto de `127.0.0.1`, puerto fuera de `1..65535` y versión distinta
de `1` fallan cerrados.

Los mensajes exactos son `bootstrap(kind,version,token)`, `ready(kind,version,host,port)`,
`hello(kind,version,token)`, `welcome(kind,version,nonce,heartbeatIntervalMs)`,
`heartbeat(kind,version,nonce,sequence,sourceStatus)` y el sample H8.1 sin cambios
`(version,nonce,sequence,tick,mapId,activity)`. El token CSPRNG por proceso tiene 32 bytes y 43
caracteres base64url sin padding. El helper captura el token de bootstrap y exige exactamente ese
valor en hello mediante comparación en tiempo constante sobre sus 32 bytes; bootstrap solo valida
forma y no se compara con una expectativa externa. El token solo
entra por stdin/bootstrap y TCP/hello, y nunca argv, entorno, fichero, log, stdout, stderr, discovery,
settings, IndexedDB, Vault o telemetría. El nonce CSPRNG del helper es por conexión, 16 bytes/22 caracteres, y solo aparece en
welcome/heartbeat/sample. Solo se admiten una conexión autenticada y una pendiente.

Heartbeat y sample comparten secuencia: `initialSequence:0`, incremento exacto `+1`, entero seguro
y cero gaps, replay, regresiones o wrap. Un nonce stale también cierra el canal; el rollover
`uint32` del tick sí es válido. Cada invocación debida del slot activo de 500 ms emite exactamente un
record secuenciado mientras la salud siga vigente. Después del warm-up, el helper deriva activity de
tick/map raw y de su reloj; el sample sustituye al heartbeat y satisface liveness. Sin lectura válida,
sale un heartbeat con el estado de fuente exacto. `welcome.heartbeatIntervalMs=500` significa el
máximo intervalo entre records secuenciados, no una cadencia adicional de heartbeat. La primera
lectura válida tras start, recovery o discontinuidad emite un solo `warming_up` sin guardar
tick/startedAt; la segunda establece una época nueva y emite advancing. Toda discontinuidad borra
esa historia: el mismo tick stale no puede reaparecer stalled. `healthy` no es un estado de
heartbeat; `awaiting_first_sequenced` admite solo heartbeat. `sourceStatus` es exactamente
`warming_up|mapping_unavailable|layout_unsupported|sample_unstable|sample_invalid`; `link_stalled`
pertenece solo a `sample.activity` tras 1.500 ms con tick estable. Canal, fuente y stalled no se
colapsan en un único estado.

Discovery vence en 5.000 ms; connect, hello, primer record secuenciado y salud del canal, en 2.000 ms
cada uno. El estado declarativo cierra qué record acepta cada fase; un record válido en la fase
incorrecta falla con `frame_schema`. Heartbeat y sample secuenciados válidos renuevan el deadline de
salud. El backoff es `[250,500,1000,2000,5000]` ms, satura en 5.000 y solo se resetea al alcanzar
`healthy` con uno de esos records, no al conectar ni durante hello/welcome. Antes de ready, cualquier
fallo exige reiniciar proceso/bootstrap/discovery y nunca conecta sin puerto válido. Tras ready, un
fallo de canal puede reconectar al mismo helper reteniendo token, pero invalida nonce/secuencia y
exige nonce nuevo desde secuencia cero. `helper_exited` desde cualquier estado no terminal —también
`reconnect_wait`— invalida token, puerto, nonce y secuencia, fuerza proceso nuevo e impide que
`reconnect_due` conecte al helper muerto. Una invocación tardía emite como máximo un record actual,
programa el próximo slot desde now y no hace catch-up/replay. Si la ausencia alcanza los 2.000 ms,
falla exactamente con `heartbeat_timeout`; un sleep de 60 s no reproduce una ráfaga. EOF de stdin invalida credenciales, apaga el helper y cierra
listener, conexión pendiente y autenticada. Los errores de canal cerrados viven en el modelo y en
[ADR 0002](adr/0002-h8-4-local-ipc-protocol.md).

H8.5 implementa el servidor con un watchdog stdin y un event loop acotado, sin thread por conexión.
Cada slot de 500 ms reintenta el mapping read-only y emite exactamente un record: fuente válida tras
warm-up produce sample; ausencia, layout incompatible, muestra inestable o inválida produce el
heartbeat exacto; la primera lectura válida tras inicio/recuperación produce `warming_up`. Cualquier
discontinuidad reinicia el historial de actividad y sleep no hace catch-up. El adapter usa solo
`FILE_MAP_READ`, cuatro campos y ocho pares. No hay launcher/plugin/settings/UI, red externa, logs ni
persistencia.

H8.6 implementa el cliente como cuatro módulos TS puros sin imports Node ni capacidades ambiente.
Proceso, TCP, reloj y CSPRNG son puertos inyectados; el token cambia por proceso, el nonce por
conexión y los callbacks stale quedan cercados por generación. El codec aplica la frontera H8.4
incremental y cerrada. `restart_wait` y `reconnect_wait` usan el mismo backoff saturado
`[250,500,1000,2000,5000]`, que solo vuelve a 250 tras `healthy`, nunca por ready/connect/hello/
welcome. Salud conserva por separado canal, fuente y actividad. La observación shadow guarda solo
`mapId + activity` en memoria bajo `enabled && armed`, sin callbacks de sesión, propuesta, captura o
persistencia. No hay launcher, adapters de proceso/TCP, wiring, settings, UI ni QA real.

H8.8 aplica una política cerrada solo al mapa objetivo `866`. En idle, 5.000 ms de crédito aceptado
en el objetivo pueden fijar presencia; durante una sesión ligada, 60.000 ms de crédito aceptado
fuera del objetivo pueden fijar ausencia. Cada record aporta como máximo los 500 ms nominales y no permite
rellenar slots: gaps, heartbeat/source unavailable, `link_stalled`, pérdida de canal o recovery
reinician o degradan la evidencia y nunca cuentan como ausencia. Cada latch produce como máximo un
DTO efímero con calidad `limited` y review `human_required`; nuevas muestras del mismo estado no
lo reemiten. El contexto de la señal incluye `accountId`; cambiar de cuenta reinicia ventana y latch
en lugar de atribuir a la cuenta nueva evidencia observada para la anterior.

Ese DTO no entra en `tyrian-companion-confirmation-queue`, no se persiste en settings/IndexedDB/Vault,
no llega a UI y no invoca captura ni transiciones de sesión. El `accountId` efímero tampoco crea
retención durable. La API v1 sigue siendo autoritativa y una discrepancia local solo degrada el
contraste shadow. H8.8 no habilita composición, autoarranque
ni influencia sobre H3.8/H5.3. La QA humana del comportamiento real —incluidos gaps, stalled,
heartbeats, recovery y falsos positivos/negativos— está pendiente en las tres plataformas.

H8.7 valida package/bottle/compat-data efímeros y construye planes exactos para Windows nativo,
CrossOver `wine` y Steam/Proton `/usr/bin/protontricks-launch --appid 1284210`. AppID y mapping
`MumbleLink` son fijos, no existen args/env/shell/command/mapping libres; Proton recibe únicamente
`STEAM_COMPAT_DATA_PATH` explícito, `shell:false` y stdin/stdout/stderr quedan como pipes. Antes de
cada delegación se abre el paquete H8.5 exacto de cinco ficheros, se validan manifest canónico y
cuatro checksums no circulares, y el proceso recibe solo una capability opaca ligada a bytes/digests,
nunca el package/helper path. Stderr se drena, stop es idempotente y solo un stdout prematuro de 516
bytes puede aplazarse. Antes de abrir delivery se revalida la carrera de microtasks; overflow,
segundo evento, exit temprano o aplazamiento inline cierran una vez y notifican exit a H8.6. El resultado solo puede
nombrarse `integrity_checked` y `unsigned_qa_only`: no
autentica el origen. Sigue prohibido ejecutar hasta que un executor separado exija digest aprobado
por release o Authenticode, revalide justo antes de cada spawn/restart y pase QA real. No hay Node,
spawn real, persistencia de paths, settings/UI, `main` ni autoarranque.

Ni raw Mumble ni frames se persisten en settings, IndexedDB, Vault, logs o telemetría. La proyección
válida vive solo en memoria el tiempo necesario para la comparación shadow o la propuesta futura.
El cierre, caída o reinicio del helper invalida nonce, secuencia y estado derivado; el runtime de
sesión API permanece independiente.

La QA del helper/runtime real está explícitamente pendiente en Linux con Steam/Proton, macOS con
CrossOver y Windows. Debe probar lectura, ausencia del juego, enlace stale, rollover de tick,
replay/reorder, frames corruptos/sobredimensionados, reinicio, coexistencia con Obsidian y
degradación API-only antes de habilitar influencia alguna fuera de shadow.

El spike H8.2 vive en `spikes/h8-mumble-crossover/` y no entra en `src/` ni en el paquete. Su wrapper
Windows abre solo el mapping existente con permiso de lectura y emite una línea; no busca procesos
ni ofrece una vía alternativa si el mapping falta. Lee words alineadas y exige dos candidatos
completos idénticos con un máximo de ocho intentos; esto reduce carreras visibles, pero no es un
seqlock ni demuestra coherencia frente a un writer no cooperativo. Los tests de host validan
interleavings, layout, límites, guard de capacidades, sanitizers y sabotajes, pero no cuentan como prueba de CrossOver. El procedimiento humano exige compilar fuera de
la botella, usar la misma botella que GW2, no actualizarla durante la prueba, nonce efímero y aceptar
solo las seis claves del contrato. Esa QA sigue pendiente hasta observar `mapId=866` en el Laberinto
y estabilidad durante cambios/reinicio sin datos adicionales.

### Decisión de implementación H8.3

<!-- h8.3-platform-authority:start -->
H8.3 queda `accepted_for_implementation` de forma provisional con Rust y un target único
`x86_64-pc-windows-msvc` + CRT estático + linker MSVC `/Brepro`. La misma salida
`tyrian-mumble-helper.exe` se validará como
Windows PE bajo la siguiente matriz independiente de la matriz API-only del MVP:

| Prioridad | Entorno del helper | Artefacto | Estado |
| --- | --- | --- | --- |
| Primaria | Linux con Steam/Proton | PE Windows x64 bajo Proton | `qa=pending` |
| Secundaria | macOS con CrossOver | El mismo PE Windows x64 bajo CrossOver | `qa=pending` |
| Beta | Windows x64 | El mismo PE Windows x64 nativo | `qa=pending` |

Soporte significa superar la QA específica del mismo artefacto; arrancar en otra capa o arquitectura
no crea soporte implícito. Quedan fuera de soporte exactamente `linux_native`, `macos_native`,
`windows_x86`, `windows_arm64`, `mobile` y `wine_outside_steam_proton_or_crossover`. La matriz se reabre si necesita más
de un binario, si el PE + CRT estático no es reproducible o si Windows ARM64 pasa a ser requisito de
release.

La distribución futura será un ZIP separado del plugin con EXE, helper manifest, `SHA256SUMS`,
licencia y avisos de terceros. La firma Authenticode está pendiente y ningún helper unsigned está
autorizado para release. H8.5 añade build y CI de verificación, pero no package productivo: CI solo
puede subir durante un día el marker `UNSIGNED-NOT-FOR-RELEASE`, nunca el EXE ni un ZIP release. La
generación efímera de un PDB por MSVC bajo `target` está permitida; staging, paquete y artifact CI
lo rechazan junto con DLL/LIB/OBJ/RLIB/RMETA. La
matriz completa continúa `qa=pending`; el contrato exacto H8.3 está en
[ADR 0001](adr/0001-h8-3-native-mumble-helper.md).
<!-- h8.3-platform-authority:end -->

## Política de terceros y operaciones

Para observar el estado o la actividad del jugador en runtime solo se admiten:

1. La API oficial de Guild Wars 2.
2. La interfaz oficial Mumble Link, exclusivamente mediante el helper opcional de v2 anterior.

No se admiten scraping de estado personal, lectura de logs o memoria del cliente, inyección,
hooks, interceptación de tráfico, simulación de entrada, macros, bots ni automatización mediante
herramientas de Steam, Proton, CrossOver o Windows. Las fuentes editoriales usadas para modelos
estáticos deben seguir siendo citadas, fechadas y revisadas como evidencia offline; no se convierten
en una integración runtime ni en autoridad sobre la cuenta.

Ningún componente puede ejecutar operaciones desatendidas. Una recomendación solo explica una
acción que la persona realiza manualmente dentro del juego. El polling armado, el cálculo local y
la persistencia de evidencia no son autorización para cambiar el estado del juego, de la cuenta o
de una sesión sin la confirmación prevista por su lifecycle.

## Métricas del piloto

Antes del piloto se exige un dry run de instrumentación por plataforma: debe registrar cada
propuesta presentada, reconciliarla con la cola y el lifecycle y producir el esquema siguiente sin
usar aún sus resultados como muestra del piloto. Cada fila se identifica de forma estable por
`proposalId` y contiene `review_presented` y su timestamp, tipo `start|stop`, estado terminal
`decided|expired`, ventana y intervalo de polling, y las versiones de plataforma, Obsidian, Tyrian
Companion y Steam/Proton, CrossOver o Windows que correspondan. En `expired`, decisión, resultado
efectivo, causa H3.10 y frontera humana son `null`, salvo un dato ya observado antes de expirar que
se conserva sin inferir otro. En `decided`, la decisión es `dismissed|accepted`: un descarte tiene
resultado efectivo `dismissed` y su causa H3.10; una aceptación tiene
`accepted_workflow_succeeded|accepted_workflow_failed`. La frontera humana corregida permanece
`null` si no existe adjudicación humana, independientemente del terminal.

Al cierre de una evaluación, las propuestas que no llegaron a revisión quedan fuera. Para un tipo
`t`, el denominador de falso positivo `n_t` es el número de propuestas con `review_presented`,
estado `decided` y resultado efectivo `dismissed` o `accepted_workflow_succeeded`. El numerador
`k_t` es el subconjunto de `n_t` cuyo resultado efectivo es `dismissed`: todo descarte es un falso
positivo del tipo correspondiente. La causa H3.10 se publica como desglose de `k_t`, nunca como
filtro. Por tanto, `tasa_t = k_t / n_t`. Una
aceptación cuyo workflow falla se conserva y publica por separado, pero no entra en `k_t` ni `n_t`:
no adjudica la calidad de la detección. Una propuesta expirada tras llegar a revisión tampoco entra
en esas tasas, pero sí en la cobertura: `cobertura = decisiones / revisiones`, donde `decisiones`
son las revisiones con estado `decided` y `revisiones` las presentadas que cierran como
`decided|expired`. Así una tasa no mejora ocultando casos sin revisar. El umbral del 10 % se aplica
a la estimación puntual; el intervalo Wilson al 95 % se publica como su incertidumbre, no como un
umbral alternativo.

| Métrica | Definición | Publicación | Criterio de éxito |
| --- | --- | --- | --- |
| Falso inicio | `k_start / n_start`: `k_start` son inicios con resultado `dismissed`; `n_start` son inicios `decided` con resultado `dismissed|accepted_workflow_succeeded` | Recuento, `n_start`, estimación puntual, desglose H3.10 e intervalo Wilson al 95 % por plataforma | Estimación puntual menor o igual al 10 %, `n_start >= 20` y cobertura de decisión mayor o igual al 90 % |
| Falsa parada | `k_stop / n_stop`: `k_stop` son paradas con resultado `dismissed`; `n_stop` son paradas `decided` con resultado `dismissed|accepted_workflow_succeeded` | Recuento, `n_stop`, estimación puntual, desglose H3.10 e intervalo Wilson al 95 % por plataforma | Estimación puntual menor o igual al 10 %, `n_stop >= 20` y cobertura de decisión mayor o igual al 90 % |
| Sesiones recuperadas | Recoveries que restauran una sesión utilizable / sesiones recuperables presentadas | Éxitos, fallos, descartes voluntarios y tasa; los descartes no cuentan como éxito | 100 % en 20 reinicios forzados de la plataforma primaria y al menos 95 % en el piloto, sin pérdida silenciosa |
| Precisión temporal | Error absoluto en segundos entre el punto medio de la ventana propuesta y la frontera corregida por la persona | Mediana, p90 y máximo, en segundos y en múltiplos del intervalo de polling | Mediana menor o igual a 1 intervalo y p90 menor o igual a 2 intervalos |

La frontera corregida es una adjudicación humana, no una inferencia posterior del mismo detector. Si
no existe corrección temporal, el caso aporta decisión de falso positivo, pero no precisión. H3.10
ya conserva observaciones locales, pero `0.1.0` todavía no agrega ni sincroniza estas métricas ni
captura todas las adjudicaciones necesarias para calcularlas.

## Entrada y salida del piloto

El piloto puede comenzar cuando el mismo candidato cumple la matriz funcional completa en Linux,
los smoke tests obligatorios en macOS y Windows, y una revisión confirma que la medición no contiene
credenciales, snapshots crudos ni payloads crudos de inventario. El conjunto mínimo permitido es
la identidad del evento/sesión/propuesta, fase, resultado, modo, causa, ventana, incertidumbre,
calidad de evidencia y timestamps necesarios para las métricas. Cuando deba preservarse la
procedencia de un inicio asistido, se admite la `RelevantStartProposal` completa y nada más:
`version`, `proposalId`, `accountId`, `ruleSet.id|version`, `firstSignal` y
`confirmationSignal` —cada una con refs de snapshots, intervalo/ventana, ganancias `itemId` y
`quantity`, y `deltaStatus`—, `possibleStart`, `evidenceQuality` y `confirmedAt`. Nunca contiene
snapshots crudos, payloads crudos de inventario, texto libre ni API key. La beta de Windows debe
identificarse como tal en cualquier entrega.

El piloto se considera satisfactorio con un mínimo de 50 sesiones completadas, los denominadores
mínimos de ambas tasas, los 20 reinicios forzados de Linux y todos los umbrales anteriores. Además,
debe registrar cero operaciones ejecutadas por el companion y cero pérdidas silenciosas de runtime
o notas. Los mínimos —50 sesiones, `n_start >= 20`, `n_stop >= 20` y los reinicios exigidos— se
aplican por plataforma, no por cada combinación de versiones. Las versiones se publican como
estratos para permitir reproducir y acotar una regresión; cualquier regresión por versión se
investiga y no puede quedar oculta en un agregado. Los umbrales y muestras son obligatorios para
Linux; macOS o Windows que alcancen la misma muestra deben cumplirlos también. Un resultado
secundario o beta con una muestra menor se publica como inconcluso, no como verde; no se extrapolan
ni se mezclan plataformas para declarar éxito.
