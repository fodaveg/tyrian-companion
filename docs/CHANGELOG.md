# Changelog

## H4.18/H4.19 — Activación humana de la recomendación para 36038

- David aprobó el `2026-08-16T05:22:24.000Z` la regla source-backed de apertura y el pack económico de **Trick-or-Treat Bag**. RulePack V2 pasa a `human_reviewed`, la capability `open` queda habilitada y el pack H4.19 usa activación `enabled` ligada al nuevo SHA-256.
- Con el batch completo y fresco del saco y sus ocho outcomes, el kernel puede recomendar manualmente `open`, `sell` o `vendor` aplicando el margen mínimo fijo del 10%. Evidencia parcial, stale, incoherente, revocada o fuera de la ventana temporal sigue devolviendo revisión.
- El instante de aprobación es el límite inferior inclusivo del provider y de la evaluación económica; `validUntil` sigue siendo exclusivo. No se añadió executor, background, listing automático ni descarte.

## Inventory Advisor — alcance por personaje y lectura honesta del valor

- Un 403 específico de banco, materiales o delivery ya no derriba la captura del Advisor: conserva
  bolsas y compartido y marca únicamente esa fuente como parcial. Un 401 sigue fallando globalmente.
  La cobertura saneada llega al recibo y a la vista; cada checkbox opcional indica «Leído», permiso
  ausente, restricción, lectura parcial o indisponibilidad, y no confunde una fuente inaccesible con
  una fuente leída sin objetos.
- Un mismo objeto con una ruta valorada y otra sin precio conserva el subtotal conocido, pero cuenta
  como no valorado; el resumen ya no puede afirmar que todos sus objetos tienen precio.
- La captura del Advisor vuelve a leer banco, materiales y entrega del bazar, pero como fuentes
  **opcionales**: su permiso ausente, URL restringida o fallo degrada solo su propia cobertura y nunca
  invalida bolsas ni inventario compartido. La cartera sigue fuera del Advisor. Los tres controles
  «Incluir además» dejan de estar deshabilitados y muestran datos reales.
- Nuevo filtro de **Personaje**: acota la vista a las bolsas de un personaje concreto, con la lista
  derivada de lo observado en la captura. Mientras hay un personaje seleccionado, banco, materiales y
  entrega quedan fuera del alcance y sus casillas se deshabilitan; un personaje que ya no aparece en la
  captura vuelve automáticamente a «Todas las bolsas y compartido». La vista declara ese alcance en
  texto en lugar de dejarlo implícito.
- Nuevo control de **Orden** (valor, cantidad o nombre) aplicado *después* de acotar, para que el orden
  visible corresponda a las cantidades y valores visibles y no al ranking previo al filtro.
- El resumen «Qué hacer ahora» separa unidades y pilas de los objetos distintos, y declara cuántos
  objetos **no tienen precio demostrado** en lugar de sumarlos como cero al valor conocido. Cada botón
  de acción arrastra su propio recuento sin precio.
- La tabla añade **Pilas** y **Valor por unidad**, cierra cada grupo con un subtotal exacto de sus
  filas y colorea la acción y el nivel de evidencia. La evidencia deja de resumirse en una palabra:
  nombra los ejes concretos que no están completos, por ejemplo «Limitada (precios, reglas)».

## Hotfix — Inventory Advisor con datos reales

- La clasificación deja de usar la completitud global de catálogo/precios como interruptor para todas
  las filas. Con un batch 206 parcial, cada objeto con catálogo resuelto y precio presente u omisión
  demostrada puede mostrar su ruta manual de listing, venta o mercader. El pack curado pendiente solo
  retiene sus propias capacidades; ya no convierte en `rule_stale` las rutas líquidas independientes.
- Añadido un recibo diagnóstico local reemplazable por Refresh con resultado, duración y cobertura
  por pasada/fuente. Permite diagnosticar el fallo real sin capturas de pantalla ni consola y excluye
  secretos, identidad, personajes, objetos, URLs y cuerpos de respuesta. Las fuentes no disponibles
  conservan únicamente clase de transporte, código HTTP y espera acotada para distinguir 429/5xx,
  timeout y red.
- El Advisor deja de intentar estabilizar el inventario mediante tres lecturas completas. Cada intento
  realiza una sola pasada acotada y una pasada completamente cubierta se conserva como evidencia
  `unstable/limited`: puede mostrar rutas manuales líquidas, pero no autoriza uso, apertura, reciclaje
  ni acciones irreversibles. Solo una pasada parcial transitoria provoca un segundo intento completo.
- Refresh usa un transporte separado con timeout de 30 segundos por petición; las capturas completas de
  sesión conservan el transporte y la estabilización de dos/tres pasadas originales.
- Las lecturas de inventario de personajes del Advisor se serializan para evitar que varios personajes
  compitan por el transporte de Obsidian y agoten simultáneamente el timeout. Las capturas completas de
  sesión conservan su límite de concurrencia independiente.
- Refresh deja de depender del snapshot account-wide: captura y estabiliza exclusivamente inventarios
  de personaje + compartido. Banco, materiales, wallet y delivery quedan `not_requested`, no pueden
  invalidar el inventario básico y sus controles permanecen deshabilitados hasta una captura separada.
- La vista deja de ser un volcado account-wide de filas sin acción: por defecto enseña bolsas de
	personaje e inventario compartido y prioriza una cola «Qué hacer ahora» con verbos directos,
	cantidades y valor en oro/plata/cobre. Las filas `keep|review|discard_review` quedan como contexto
	opt-in; banco, materiales y delivery siguen como ámbitos futuros deshabilitados. Cada fila puede
	mostrar el icono oficial del catálogo.
- Los items sin conocimiento curado pueden comparar de forma manual venta instantánea, listing y
  mercader con evidencia completa; uso, apertura y reciclaje siguen retenidos hasta tener regla
  curada. La explicación declara que no se ejecuta ni compara esas rutas.
- La cobertura del Advisor ya se calcula sobre sus fuentes reales —personajes + inventario compartido—,
  no sobre los ámbitos opcionales. Si una lectura completa cambia entre pasadas, conserva el estado
  `limited` pero puede mostrar rutas manuales de venta/mercader sobre la última pasada; usar, abrir y
  reciclar continúan en revisión hasta obtener una lectura estable.
- Refresh muestra progreso indeterminado honesto, reintenta una vez una captura parcial transitoria
  y conserva el último resultado válido con aviso saneado solo si un Refresh devuelve
  `capture_unavailable`; identidad, preferencias y reclassify fallan cerrados.
- La captura `unavailable|invalid` deja de alcanzar composición o preferencias y devuelve un
  motivo bloqueado cerrado. El controlador conserva ese enum hasta la vista, que distingue de forma
  segura clave ausente, captura no disponible/no válida, almacenamiento local, reglas y fallo inesperado
  sin mostrar token, identidad de cuenta, bóveda ni excepciones internas.
- El catálogo omite propiedades opcionales ausentes, invalida nombres que no pueden entrar en el
  contrato de presentación y sube su versión de normalización para no reutilizar caché antigua.
- La captura de precios acepta la respuesta parcial HTTP 206 de la API oficial y conserva los
  precios presentes, marcando únicamente los IDs omitidos como no disponibles.
- El runtime transmite al capture los nueve IDs económicos pedidos por el bundle H4.19 y la capa
  de allowlist acepta y valida ese contexto económico opcional en vez de invalidar el informe.
- Verificación de solo lectura contra la cuenta real: snapshot estable, seis fuentes de almacenamiento
  completas, 1.206 objetos/1.701 posiciones y presentación `limited` con 1.701 filas de revisión;
  ninguna acción automática, económica o irreversible queda habilitada.
- La QA visual en Obsidian sigue siendo obligatoria: el diagnóstico externo no sustituye la ejecución
  con SecretStorage e IndexedDB reales de la aplicación.

## H8.6 — Núcleo aislado del cliente Mumble

- Añadidos `mumble-v2-codec.ts`, `mumble-v2-client.ts`, `mumble-v2-health.ts` y
  `mumble-v2-observation.ts` como módulos TS puros, sin imports Node ni I/O ambiente.
- El codec incremental aplica `uint32` big-endian + UTF-8 fatal + JSON cerrado 1..512, high-water
  máximo 516, schemas exactos, duplicados escapados, BOM/trailing y secretos base64url canónicos.
- El cliente usa puertos fakeables de proceso, TCP, reloj y CSPRNG; rota token por proceso y nonce
  por conexión, exige secuencia `0,+1`, deadlines y generaciones, y aísla throws/reentrada de
  callbacks externos. Restart y reconnect comparten `[250,500,1000,2000,5000]`, con reset solo al
  alcanzar `healthy`.
- Salud mantiene canal, fuente y actividad como tres ejes; la observación shadow retiene solo
  `mapId + activity` en memoria bajo `enabled && armed`, sin callbacks de sesión, propuesta, captura
  o persistencia.
- Añadidas 42 pruebas H8.6 —33 funcionales y nueve de arquitectura— y guardas dinámicos con allowlist exacta y sabotajes de módulo,
  helper, imports `fs`/`net`, sesión, captura, store, logger, timers globales y scanner always-green.
  No hay launcher, adapters reales, wiring en `main`, settings/UI, packaging ni QA de plataforma.

## H8.4 — Protocolo IPC local cerrado

- Fijados helper servidor/plugin cliente sobre TCP IPv4 `127.0.0.1`, bind port `0`, bootstrap por
  stdin, discovery `ready` por stdout y handshake TCP `hello → welcome`; todos los records comparten
  longitud `uint32` big-endian y JSON UTF-8 de 1–512 bytes.
- Cerrados seis schemas exactos: bootstrap, ready, hello, welcome, heartbeat de control y el sample
  H8.1 sin cambios. Longitud cero/513+, truncado, UTF-8 inválido, BOM, JSON inválido/no objeto,
  duplicados, trailing y claves extra/missing fallan cerrados.
- Fijados token CSPRNG por proceso de 32 bytes/43 caracteres solo stdin+hello, comparación en tiempo
  constante y prohibición en argv/env/fichero/log/stdout/stderr/discovery/settings/IndexedDB/Vault/
  telemetría; nonce CSPRNG por conexión de 16 bytes/22 caracteres desde welcome. Solo se admiten una
  conexión autenticada y una pendiente.
- Heartbeat y sample comparten secuencia `0,+1` sin gaps, replay, regresión, overflow ni wrap. Tick
  conserva rollover `uint32`; cada llamada debida de 500 ms emite un record y el sample derivado de
  tick/map raw sustituye heartbeat y satisface liveness. El primer válido tras
  start/recovery/discontinuidad emite `warming_up` sin historia; el segundo abre época advancing y
  cualquier source-status borra tick/startedAt. 1.499/1.500 ms fijan advancing/stalled sin tick stale.
  Lateness emite como máximo uno, agenda desde now y no hace catch-up; 2 s sin record válido fallan
  `heartbeat_timeout`. Stalled 1.500 ms, discovery 5.000 ms y
  connect/hello/primer-secuenciado/heartbeat 2.000 ms quedan fijados junto al backoff
  `[250,500,1000,2000,5000]`.
- Añadidos los cinco `sourceStatus` y catorce errores de canal exactos, separando lifecycle del canal,
  salud de fuente y `link_stalled`. API v1 permanece autoritativa, rollout shadow, confirmación
  humana y retención `none`.
- Añadido ADR 0002 con bloque JSON de igualdad completa, orden y hashes cerrados; lifecycle de fases,
  deadlines, EOF y reconnect determinista; y tests causales para framing, validators, secuencia,
  fake clock, reset healthy, token constant-time y vectores. H8.5/H8.6 implementan después los dos
  lados en aislamiento; launcher, adapters del cliente, composición y packaging siguen ausentes.
- Endurecido el contrato tras revisión: hello queda ligado al token capturado de bootstrap; reconnect
  del mismo proceso lo conserva, mientras fallo pre-ready, `helper_exited`, restart y EOF lo invalidan.
  Solo post-ready permite volver a conectar; cada conexión rota nonce y reinicia secuencia en cero.
  El framer test-only drena chunks coalesced arbitrarios con high-water máximo de 516 bytes y solo un
  record completamente válido renueva el deadline.
- Cerrada la ruta `helper_exited` para todos los estados no terminales, incluido `reconnect_wait`:
  invalida token/puerto/nonce/secuencia y bloquea `reconnect_due`. El framer mide memoria simultánea
  real y transfiere el payload tras liberar su referencia, sin duplicarlo durante el callback.
- Añadida referencia de cadencia con fake clock, raw tick/map/status, recovery con tick stale,
  umbral 1.499/1.500 ms y salto de 60 s; sabotajes causales cubren catch-up, dos records o ninguno,
  `warming_up` infinito, sample sin calentamiento previo y heartbeat `healthy` inventado.

## H8.2 — Spike read-only dentro de CrossOver

- Añadido bajo `spikes/` un decoder C portable del layout oficial y un wrapper Windows que abre
  únicamente el mapping `MumbleLink` con `FILE_MAP_READ`; no enumera procesos, inyecta, automatiza,
  abre red ni persiste datos.
- La proyección queda cerrada a versión/tick/context_len/mapId y a un único frame H8.1 por stdout;
  hasta ocho intentos exigen dos candidatos completos idénticos antes de aceptar. Es best-effort,
  no un seqlock ni garantía de coherencia del writer; el activity solo deriva avance/stall.
- Añadidos fixtures adversariales de tick igual con map híbrido/word tearing, versión, tamaño,
  contexto, map id, nonce, secuencia y frame. Cinco sabotajes causales fijan offset, 5.460 bytes,
  512 bytes, ocho pares y el máximo JSON seguro `9007199254740991`; la lane ejecuta además
  ASan/UBSan.
- Añadido guard de censo exacto del spike: exige una sola llamada a `OpenFileMappingW` y otra a
  `MapViewOfFile`, ambas con argumentos `FILE_MAP_READ`; cierra las llamadas y sumideros permitidos,
  incluye el stub y el script host, rechaza `0x0002`, write/all, Toolhelp/proceso/memoria,
  identidad/coordenadas, red, persistencia/logs y ejecución de Wine/CrossOver o copias fuera del
  temporal durante `npm run check`. Las llamadas C se extraen léxicamente ignorando comentarios y
  literales —incluido el permiso decimal `2u`—, y el script host queda bajo un contrato positivo
  byte a byte con destinos temporales exactos; sabotajes con código malo y decoys buenos, `open`,
  `/bin/cp`, `command cp`, `eval`, `rsync` e `install` demuestran la vía roja. El scanner productivo
  no amplía su allowlist.
- Cerrado también el preprocesador del wrapper: su censo positivo permite solo
  `WIN32_LEAN_AND_MEAN` y los cinco includes esperados. `#undef`/redefiniciones de
  `FILE_MAP_READ`, `MUMBLE_MAPPING_NAME`, `TC_MUMBLE_LINK_VIEW_BYTES` o aliases nuevos fallan;
  sabotajes cubren permisos `2u` y `(1u << 1)`, nombre y tamaño.
- La lane preprocesa ahora el wrapper real con el mismo compilador y stub (`-E -P`) y valida el
  resultado expandido: acceso `0x0004u`, nombre `MumbleLink` y view `5460u`. Hashes contractuales
  cierran wrapper, core header, stub y validador. Sabotajes en `windows.h`, `core.h`, directivas
  digraph `%:` y line-splicing preprocesan correctamente pero son rechazados por su semántica.
- Inventario read-only confirmado en macOS ARM: CrossOver 26.3.0 y botella win64 `Guild Wars 2`
  existen; Apple Clang está disponible, pero no un cross-compiler Windows. No se instaló toolchain,
  no se modificó la botella y no se abrió ni ejecutó CrossOver/GW2.
- Quedan pendientes compilar el PE y demostrar lectura estable en una sesión real. El spike no se
  importa desde `src`, no entra en el release y no relaja el scanner productivo.

## H8.5 — Helper/servidor Mumble nativo

- El verifier de supply-chain lee `Cargo.toml`/`Cargo.lock` directamente y ya no invoca Cargo ni
  instala toolchains desde jobs Node. El target MSVC añade `/Brepro` para eliminar metadata variable
  del linker entre los dos builds de reproducibilidad, conservando CRT estático.
- CI permite el PDB efímero que MSVC deja bajo `target`, pero construye un stage de artifact cerrado
  que admite solo el marker durante un día; tests causales rechazan PDB/DLL/LIB/OBJ/RLIB en el stage
  futuro del helper y cualquier output nativo en el artifact CI.
- Añadido el crate Rust único `native/mumble-helper`, toolchain 1.85.1, target
  `x86_64-pc-windows-msvc` y CRT estático, sin Tokio ni `build.rs` propio.
- Implementados framing big-endian 1..512, JSON exacto con duplicados escapados, token bootstrap
  comparado constant-time y zeroized, nonce por conexión y secuencia heartbeat/sample conjunta.
- Portado el reader H8.2: exactamente cuatro words, ocho pares estables y adapter Win32
  `OpenFileMappingW`/`MapViewOfFile` solo `FILE_MAP_READ`.
- El servidor inicia el primer slot a 500 ms y emite exactamente un record por slot: primera lectura
  válida `warming_up` sin historia, la siguiente abre época/sample advancing; ausencia/layout/
  tearing/invalidez producen heartbeat y reinician la actividad. Tick igual cambia en 1.499/1.500
  ms, una llamada tardía agenda desde `now+500` y 2 s sin record cierran sin catch-up.
- Añadidos lifecycle tests de EOF, slowloris, cliente extra, auth y reconnect, guard positivo,
  supply-chain/staging sintético y CI Windows para PE x64/static CRT/reproducibilidad.
- CI solo conserva el marker corto `UNSIGNED-NOT-FOR-RELEASE`; el ZIP del plugin sigue con tres
  ficheros. H8.6 añade el cliente core aislado, pero Authenticode, publicación, launcher/wiring del
  plugin, firma y QA real siguen pendientes.

## H8.3 — ADR del helper nativo Mumble

- Comparados Rust y C# NativeAOT; ambos pueden producir una aplicación nativa self-contained y
  single-file sin runtime instalado. Rust se acepta provisionalmente por su frontera pequeña sin GC
  administrado y su zona `unsafe` Win32 explícita; C# conserva tradeoffs reales de trimming/AOT,
  runtime mínimo embebido, tamaño, toolchain y símbolos/PDB, y sigue como opción de reapertura.
- Fijados la raíz futura `native/mumble-helper`, target único `x86_64-pc-windows-msvc`, flag
  `-C target-feature=+crt-static` y salida única `tyrian-mumble-helper.exe`.
- Definido un ZIP separado, fuera del paquete del plugin, con EXE, manifest, `SHA256SUMS`, licencia y
  avisos de terceros. Authenticode y la firma siguen pendientes; un helper sin firma no sale a release.
- Registrada la matriz Linux/Steam/Proton primaria, macOS/CrossOver secundaria y Windows x64 beta,
  toda `qa=pending`, junto a los seis entornos exactos fuera de soporte.
- Añadidos riesgos/reopen triggers y un guard documental de schema exacto con sabotajes causales. El
  censo positivo global cubre fuente Rust/C#, configuración Cargo/toolchain exacta, paths helper y
  cualquier señal de prefijo `mumble-link`/`mumble_link`/`MumbleLink`, además de
  EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA y symlinks fuera de las superficies no productivas exactas;
  `bridge` genérico queda permitido. Parsing y hashes gobiernan bloque JSON, ADR y la política de
  plataforma completa. No se crea runtime.

## H8.1 — Contrato Mumble Link v2

- Añadido el contrato declarativo previo al helper: opt-in, defaults revisables `shadow` y
  `on_when_armed`, API v1 autoritativa, confirmación humana y retención raw/frame `none`.
- Fijada la allowlist de lectura a `uiVersion`, `uiTick`, `context_len` y `context.mapId`; el payload
  IPC mínimo conserva solo versión/nonce/secuencia/tick/mapId/actividad derivada, sin identidad,
  coordenadas ni PID.
- Verificado el id oficial `866` para **Mad King's Labyrinth / Laberinto del Rey Loco** y fijadas las
  fuentes de layout Mumble/GW2 Wiki/ArenaNet por revisión/commit, incluido `uiVersion=2`.
- Definido transporte futuro solo loopback `127.0.0.1`, puerto efímero, nonce mínimo de 128 bits,
  `initialSequence:0`, frame JSON UTF-8 de 512 bytes máximo y rechazo fail-closed de
  versión/campos/orden/layout.
- Scanner v4 reabre únicamente el fichero contractual exacto; su allowlist AST recursiva y
  sabotajes mantienen en rojo helpers fuera de censo, exports alternativos, sintaxis ejecutable,
  inyección, proceso, memoria, logs, tráfico, entrada, automatización, red, persistencia y timers.
- No se ha implementado helper productivo, IPC runtime ni composición. QA real Linux/Steam/Proton,
  macOS/CrossOver y Windows queda explícitamente pendiente.

## H4.19 — Economía manual fail-closed para 36038

- Extraído de H4.10 un kernel económico puro e independiente de sesión que compara apertura conservadora con el mejor suelo inmediato entre bid y mercader usando margen exacto del 10%.
- Refresh captura como evidencia hermana fresca el saco y los ocho outcomes líquidos H4.7 (`36041`, `36059`, `36060`, `36061`, `79673`, `79677`, `79679`, `89002`), ligados a cuenta, snapshot, schema y TTL.
- Añadido un pack hasheado que liga modelo, regla, knowledge pack, cobertura, binding, reservas y excepciones. Solo evidencia completa permite recomendar manualmente `open`, `sell` o `vendor`; parcial, revocada, vencida o incoherente termina en `review`.
- El built-in permanece `pending_human_review`: no se ha fingido aprobación ni activado ninguna recomendación. No existen listing, executor, background ni descarte en esta ruta.
- Añadidos tests causales y guard arquitectónico. Siguen pendientes la aprobación humana del pack/economía y la QA manual ES/EN en Obsidian.

## H7.2/H7.3/H7.6 — Onboarding, clave API y soporte seguro

- Añadido onboarding desde cero al README: artifact manual verificado, Secret Storage, conexión,
  apertura real de Companion y lifecycle state-dependent de start → finish → review → save/clear.
- Documentados modo asistido y límites de exactitud, valoración e Inventory Advisor sin convertir una
  observación, propuesta o revisión irreversible en una acción automática.
- Añadida guía de clave con scopes reales: `account` solo conecta; sesiones completas requieren
  `account`, `characters`, `inventories` y `builds`; wallet/TP/progression/unlocks amplían cobertura.
- Añadidos revocación/rotación, errores saneados y soporte con lista cerrada de diagnóstico permitido y
  prohibición explícita de secretos, identidad, rutas, inventario/snapshots, IndexedDB y salida cruda.
- Añadido issue form obligatorio y un contrato ejecutable fail-closed: esquema top-level exacto,
  allowlist exacta de IDs/tipos y SHA-256 semántico canónico de todo el formulario —incluidos
  nombre, descripción, título, prompts y atributos visibles—, un único Markdown seguro,
  diagnóstico opcional y sabotajes causales de campos hostiles o benignos,
  redacción, permisos, acción de finalización e issues en blanco. BRAT/publicación y QA humana no se
  activan ni se declaran completados.

## H7.4/H7.5 — Paquete reproducible y preparación del canal beta

- Añadido build causal y stage cerrado a `manifest.json`, `main.js` y `styles.css`, con validación cruzada de manifest/package/versions y tag exacto.
- Añadidos ZIP determinista, SHA-256 y revalidación interna de cabeceras, orden, CRC y contenido; los sabotajes de build, secreto y bytes alterados prueban la vía roja.
- El scanner v4 cubre también los bytes finales de release, incluido `main.js`, sin exponer valores encontrados.
- CI genera un artifact temporal para pushes de rama o tag después del gate; mantiene permisos read-only y no publica releases.
- Documentado el procedimiento manual y la preparación BRAT fail-closed. Publicación, instalación y actualización reales quedan explícitamente pendientes de QA humana.

## H4.18 — Curación segura inicial del Inventory Advisor

- Añadida la capability source-backed de abrir el item 36038; `use` y `salvage` permanecen explícitamente `not_applicable`.
- RulePack V2 queda en `pending_human_review` con `reviewedAt: null`; la recomendación permanece retenida por comparación económica ausente.
- Se preserva el hash legacy de V1 y V2 usa SHA-256 estándar; las ventanas `publishedAt`/`validUntil` fallan cerradas.
- No existen acciones automáticas ni descarte. QA y revisión humana siguen pendientes.

## H5.12 — Preferencias locales del Inventory Advisor

- Añade objetivos de reserva y excepciones de conservación locales, editables dentro del Advisor tras una acción explícita.
- Las claves persistidas combinan hash de vault y cuenta probada por la evidencia; el ItemView no expone identificadores ni generación CAS.
- Las escrituras usan CAS entre ventanas, preservan el borrador ante conflicto y reclasifican sólo evidencia aún fresca, sin segunda captura.
- Corrupción, schema futuro, indisponibilidad y evidencia obsoleta fallan cerrados; no se crean recomendaciones con defaults.
- QA visual real en Obsidian permanece pendiente.

## H5.11 — Vista manual del Inventory Advisor

- Añadida una vista Obsidian independiente, responsive y bilingüe con filtros, agrupación, cantidad,
  ubicación, acción, valor neto H4.2, cobertura y explicación por fila; abrirla solo lee memoria local.
- Añadidos workflow y comandos separados Open/Refresh: el refresh explícito compone H4.14 → H4.15 →
  H4.16 una sola vez, comparte vuelo, usa generación latest-wins y se invalida al cambiar clave o locale.
- `discard_candidate` cruza la frontera de presentación únicamente como `discard_review`, con proof H4.16
  exacto y aviso irreversible; no existe CTA, executor, operación de juego ni filtro de descarte.
- El puerto H5.12 de objetivos/excepciones queda reemplazable y vacío. H4.17 aporta un bundle built-in
  inmutable, solo revisión y sin rutas curadas: antes de su expiración todos los resultados permanecen
  `review`; desde el límite exclusivo 2026-11-12 falla como `blocked/missing_rules` antes de capturar.
- Gate automatizado completo en verde; la QA visual de la vista dentro de Obsidian queda pendiente.

## H0.4/H0.6 — Plataformas, integraciones y piloto

- Fijada la matriz de soporte: Linux con Steam/Proton como primaria, macOS con CrossOver como secundaria y Windows en beta.
- Cerrado el MVP a la API oficial de Guild Wars 2; Mumble Link queda para v2 como helper IPC opcional, separado y limitado a mapa/actividad.
- Prohibidas la inyección, inspección del proceso o de su memoria, interceptación, simulación de entrada y cualquier operación desatendida.
- Definidas tasas medibles de falso inicio/parada, recuperación y precisión temporal, con cobertura, muestras mínimas y umbrales de salida del piloto.

## H6.6 — Rendimiento reproducible de cuenta grande

- Añadido benchmark Node con GC explícito para parser → construcción y estabilización productivas de tres pasadas → delta → clasificación → valoración sobre 48 personajes, 5.132 holdings y 4.840 ganancias.
- Fijados warmup, 21 muestras, mediana/p95 nearest-rank y heap acumulado post-GC contra un baseline único. Los presupuestos fail-closed detectan colapsos y CI prueba la vía roja con retención explícita posterior al baseline en Node 22 y 24.
- El benchmark excluye explícitamente HTTP, caches, persistencia, Vault y UI: no simula I/O ni usa tiempo de Vitest como métrica.

## H5.10 — Exportación de historial durable

- Añadido escaneo manual vault-wide de notas `gw2_farming_session` schema 1/2, con integridad de referencias y seis bloques gestionados. Corrupción, schema futuro o `tc_session_ref` duplicada bloquean la exportación completa.
- Export JSON v1 determinista y CSV fijo CRLF create-only bajo `exports/`, sin IDs crudos, rutas, campos personales ni Markdown humano; el CSV cita todos los campos y neutraliza fórmulas.
- `Sessions.base` exige ahora `tc_schema` y `tc_kind`; el bundle gestionado sube a v3 para actualizar de forma CAS el asset v2 y una instalación más nueva queda read-only para un plugin antiguo. Ajustes ES/EN ofrece la acción explícita sin I/O al cargar.
- Añadido scrub warning en Ajustes con preview previa y confirmación ES/EN. El token opaco se consume o revoca en toda salida; una autoridad compartida excluye transiciones de sesión/recovery/detector y relee el gate antes de cada `Vault.process`. Solo elimina metadata `tc_*` y seis bloques verificados, conserva el fichero, frontmatter humano y cuerpo exterior, y trata borrado/renombrado como conflicto.
- Endurecido el codec del historial con YAML Core real, tipos/estilos escalares y claves únicas; el CSV serializa también su cabecera y cero sesiones no añade una fila vacía.

## H6.1/H6.2 — Movimientos y contaminación

- Añadida una matriz parser → snapshot → delta para los seis movimientos entre personaje, banco y materiales, con holdings/composición exactos y cero loot o disponibilidad falsos.
- Verificada la revisión durable de apertura, reciclaje, compra en bazar y compra a mercader mediante una segunda instancia del servicio; la clasificación y sus permisos sobreviven al reinicio.
- Fijado que la actividad del bazar de este flujo procede de declaración explícita: no se inventan eventos TP observados.

## H6.3–H6.5 — Economía, recuperación y red

- Fijado que los jackpots excluidos no cambian EV ni recomendación, y que un precio TP cero degrada a evidencia parcial sin convertirse en cobre cero.
- Añadida recuperación tras reinicio desde `stopping` y `provisional` sin recapturar baseline, final, delta ni precios; cancelar el modal no llama al backend ni muta runtime.
- Completada la matriz HTTP: 500/502/503/504 reintentan; 401/403/501 fallan; un 5xx persistente agota reintentos con error saneado.

## H5.9 — Internacionalización ES/EN

- Añadido catálogo pequeño, tipado y exhaustivo para ajustes, Companion, estados, acciones, notices, confirmaciones y modales; las claves y placeholders ES/EN se comprueban estructuralmente y la interpolación permanece en texto plano.
- Localizadas las notas de sesión, la presentación de botín, los Markdown y las Bases sin cambiar IDs de comandos, enums, `tc_*`, marcadores/hash, rutas ni las propiedades/fórmulas con las que Bases filtra y ordena.
- El cambio de idioma redibuja las superficies abiertas y actualiza el bundle de assets gestionados. Los nombres de comandos ya registrados en la paleta se actualizan al recargar el plugin, por una limitación de registro de Obsidian.

## H5.8 — Portabilidad de rutas Vault

- Centralizada la validación fail-closed de las rutas generadas o aceptadas para settings, notas de sesión y assets gestionados.
- Rechazados rutas absolutas/UNC, separadores de Windows, segmentos vacíos o de navegación, controles y surrogates sin emparejar, caracteres ilegales, nombres de dispositivo Windows —incluidos `COM/LPT` con superíndices—, variantes no NFC y longitudes no portables.
- Subido settings a v4: una carpeta pre-H5.8 que ahora no sea portable se retiene read-only en los únicos campos legacy autorizados; la reescritura canónica elimina propiedades desconocidas y no altera el puntero durable. Move/Remove inspeccionan siempre esa raíz y solo aceptan manifiesto owned exacto; un puntero divergente falla en conflicto. Move exige `ready` incluso si el puntero ya la nombraba. Un Remove reintentado reconoce el manifiesto exacto ya detached con puntero vacío sin volver a escribir y permite terminar la limpieza legacy.
- Ligados manifiesto y journal a la identidad empaquetada `id/kind/locale/path` y a hashes previos permitidos. Los manifiestos ready/detached exigen el locale y conjunto exacto del bundle actual —sin impedir bundles anteriores compatibles—; un trasplante de ruta o `beforeHash` arbitrario queda en conflicto.
- Las rutas de sesión conservan el diseño UTC + hash estable, sin incorporar cuenta, personaje, evento ni ruta personal.

## H5.7 — Halloween Base

- Migrado el frontmatter de notas a schema v2 con `tc_event`/`tc_event_source` y campos estables de recomendación `ready`; la procedencia manual o asistida es cerrada, durable y correlacionada, sin aceptar prefijos ni inferencias por fecha, nombre, texto o loot.
- Añadido `Halloween.base` ES/EN al bundle gestionado v2, conservando la Base genérica y el mismo manifiesto, hash, CAS y protección de modificaciones humanas.
- Añadidas cinco tablas para sesiones Halloween: recientes, por build, mejor rendimiento cualificado, contaminadas y abrir/vender histórico manual; `null` permanece vacío y cero permanece cero.
- Añadidas pruebas con parser YAML real para estructura, referencias, filtros, fórmulas, locales, hashes, upgrade y ausencia de I/O en el asset.

## H5.6 — Managed assets foundation

- Añadido motor Vault-only para inspección y plan puro de assets `.base`/`.md`, con rutas NFC seguras, colisiones case-insensitive y una Base genérica neutral.
- Añadidos manifiesto v1, generación CAS y journal durable reanudable para instalación, upgrade y repair explícitos entre ventanas.
- Añadidos uninstall mediante tombstone verificado + papelera de Obsidian y relocate cercado, siempre preservando bytes modificados o ajenos.
- Añadida autoridad IndexedDB lazy con root/generación/estado para serializar Apply/Move/Remove entre ventanas; settings v3 refleja el último root completo sin ser la autoridad CAS.
- Migrados settings a v3 con `managedAssetsRoot:null` sin escaneo/escritura y añadida UI compacta de Preview/Apply/Repair/Move/Remove.

Todos los cambios notables del proyecto se documentan aquí.

## [0.1.0] - Unreleased

### Added

- Scaffold de plugin Obsidian TypeScript/esbuild con ESLint, Vitest y CI.
- Vista **Tyrian Companion** y comando **Open companion**.
- Bitácora H5.1 status-first con fase/duración, detector, polling, calidad, cuenta e incidencia priorizada; detalles secundarios plegables, layout responsive, foco visible y controles táctiles de 44 px.
- Comandos H5.2 de sesión con disponibilidad revalidada y un único ribbon de compás contextual; start, finish/retry, review, recovery, discard y clear reutilizan H3 y las dos acciones destructivas requieren confirmación.
- Cola H5.3 durable de confirmaciones asistidas en IndexedDB dedicada, con proposals/receipts v1, dedupe/coalescing, TTL, límites, reconcile e intención/claim exactos y renovables entre ventanas.
- Entrega H5.3 sin interrupciones: el fondo actualiza indicadores in-place sin reconstruir UI ni robar foco; vista, paleta y ribbon proyectan un contador y la siguiente propuesta, y solo un Start/Stop iniciado desde esa propuesta puede aceptarla tras el éxito del workflow existente.
- Notas H5.4 de sesión completa con ruta UTC e identidades SHA-256, frontmatter `tc_*` estable, seis bloques gestionados verificables y merge que preserva contenido humano.
- Barrera H5.4 write-before-clear mediante Obsidian Vault: conflictos, colisiones no resolubles o fallo de escritura conservan el runtime completo para reintento.
- Presentación H5.5 data-only de botín compartida por nota y Companion, bilingüe, responsive y accesible, con destino exclusivo, valoración total/subtotal y recomendaciones ocultas cuando la evidencia no las permite.
- Selección de clave con `SecretComponent` y resolución mediante `SecretStorage`.
- Cliente mínimo de Guild Wars 2 inactivo hasta una petición explícita.
- Verificación de referencias borradas en `SecretStorage` y validación del perfil de cuenta.
- Migración idempotente a settings v2 con idioma, carpeta segura, personaje, intervalo y modo de detección.
- Comprobación explícita `tokeninfo → account`, permisos requeridos/recomendados y estados de conexión accesibles.
- Transporte resiliente con errores saneados, timeout y reintentos acotados con `Retry-After` o backoff.
- Operaciones que fijan un único secreto efímero, reset A→B y concurrencia deduplicada/latest-wins.
- Cooldown real de rate limit con último estado bueno, countdown y limpieza de timers.
- Validación estricta de carpetas y soporte seguro de subtokens limitados a los endpoints de conexión.
- Modelo `storage_snapshot` discriminado con identidad temporal, ubicaciones, bindings abiertos, metadatos, contenedores equipados, hijos engastados y entregas pendientes.
- Captura GW2 con secreto, identidad y schema fijados, allowlist de subtoken por ruta, fuentes obligatorias/opcionales, cobertura por pasada y límites de concurrencia globales al servicio.
- Consistencia A/B/C con fingerprints canónicos, calidad estable, movimiento de colocación, parcial o inestable.
- Totales separados de objetos disponibles, objetos propios y divisas agregadas con desglose wallet/delivery, sin catálogo, precios ni valoración patrimonial.
- `PublicCatalog` separado del snapshot con cliente sin credenciales para items, currencies y materials, schema/locale fijados, enums abiertos y details útiles para Advisor.
- Batching deduplicado y ordenado de hasta 200 ids, máximo tres peticiones simultáneas, single-flight, parsing aislado y cobertura/avisos semánticos `200/206/404` por id.
- Categorías deduplicadas y warning trazable cuando su membership contradice un holding observado, sin mutar snapshot ni quality.
- Contrato de cache versionado por schema/normalizer y adapter en memoria con TTL por recurso, negativos de una hora y fallback positivo stale de hasta 30 días ante fallos transitorios.
- Clonado estructural de records de cache para impedir que una resolución mutada envenene hits posteriores.
- Fidelidad de suffixes del catálogo: `suffix_item_id` numérico y `secondary_suffix_item_id` string con vacío ausente.
- Persistencia local JSON en IndexedDB versionado, con claves completas, transacciones por operación, limpieza de corrupción, `dispose()` y fallback explícito a memoria.
- Validators normalizados completos para impedir hits con entidades truncadas o tipos/anidados corruptos, y pruebas reales del store con `fake-indexeddb`.
- Comparador puro H2.6 con salida v1, validación runtime e invariantes exactos entre holdings/divisas y sus tres índices agregados.
- Validación relacional de holdings para roster/cobertura, cantidades unitarias y raíces de hijos engastados en la misma ubicación.
- Superficies independientes para items y divisas (`wallet_and_delivery|wallet_only|unavailable`), conservando el delta de items cuando wallet no es comparable.
- Cambios separados de items, currencies, disponibilidad y composición; claims de delivery neutrales y razones/warnings deterministas de cobertura, roster, colocación y límites semánticos.
- Evidencia de frontera H2.7 con proyecciones canónicas de delivery/wallet, cobertura explícita y validación de identidad, ventana y aritmética.
- Clasificador puro de sesión `exact|estimated|contaminated|invalid`, evidencia TP/declarada, prioridad conservadora y permisos de uso del neto.
- Actividad de delivery/wallet condicionada a cobertura completa, compra/venta TP diferenciadas y aumento de wallet resoluble mediante confirmación limpia manual.
- Frontera runtime H2.7 defensiva sobre argumentos `unknown`, variantes estrictas y rechazo del namespace delivery con currency id distinto de `1`.
- Invariantes completas de composición H2.6 en el guard: lados no vacíos/distintos/ordenados, suma conservada segura y estados compatibles con ubicación.
- Coordinador H1.4 de sesión activa con machine id durable, lease cercado, adquisición atómica, recuperación expirada confirmada y CAS exacto en IndexedDB dedicada.
- Fallo cerrado de coordinación sin fallback a memoria ante corrupción, reloj regresivo, overflow, abort, apertura o `versionchange`.
- Idempotencia H1.4 por instancia aunque cambie la intención de sesión, y reloj muestreado dentro de cada operación IndexedDB tras cualquier espera.
- Validación temprana de `instanceId` antes de cualquier apertura/escritura y creación simétrica de identidades de lease.
- Máquina de estados H3.1 pura y versionada para `idle → starting → active → stopping → provisional → complete|error`, con redelivery idempotente y reset terminal.
- Fencing estable en cada transición, referencias comparables a snapshots de frontera, invariantes temporales y preservación del último estado válido en errores recuperables.
- Guards runtime estrictos para estados/eventos de sesión: datos corruptos, captura parcial/inestable, autoridad antigua o transición ilegal fallan sin mutación ni excepción.
- Inicio manual H3.2 desde la vista con personaje, Magic Find declarado, baseline estable y build activo capturados bajo una única clave efímera.
- Heartbeat cercado durante el inicio y la sesión activa, comprobación final del fence y rollback a `idle` con liberación del lease ante cualquier fallo de arranque.
- Estado accesible de sesión en la vista, formulario nativo de Obsidian, mensajes saneados y recomendación del permiso `builds`.
- Cierre manual H3.3 desde la vista con snapshot final estable, delta H2.6, comprobación cercada y transición a `provisional`.
- Reintento seguro de parada tras fallos de captura o delta, conservando baseline y frontera inicial; pérdida de autoridad preservada como error recuperable.
- Recovery H3.4 tras reinicio con record runtime JSON cercado en IndexedDB dedicada, snapshots completos y delta canónico verificable.
- Vista de sesión recuperable con estados busy/error accesibles, acción explícita de recuperación y descarte destructivo confirmado.
- CAS de persistencia por machine/session/fence/instance y `assertOwned` previo a save/clear, sin fallback a memoria en producción.
- Scheduler H3.5 explícito y single-flight para polling API futuro, con intervalo configurable, pausa offline/sleep, `Retry-After`, backoff acotado y descarte de ticks perdidos.
- Adaptación conservadora de errores HTTP saneados a política de scheduler; errores de programación o autenticación fallan cerrados y no generan bucles infinitos.
- Detector H3.6 puro de inicio por items relevantes: dos deltas positivos contiguos producen una propuesta idempotente con intervalo temporal, evidencia completa/limitada y reglas de IDs versionadas.
- Detector H3.7 puro de inactividad: mide silencio contiguo por tiempo, reinicia ante ganancias y solo propone una ventana de fin con incertidumbre y calidad de evidencia.
- Controlador H3.8 de detección asistida: armado/desarmado explícitos, baseline estable previo al polling, estado visible y propuestas de inicio/fin que pausan la captura y requieren acción humana.
- Regla Halloween v1 por id público oficial `36038` (**Trick-or-Treat Bag**), sin depender de nombres localizados ni metadatos de catálogo.
- Integración segura de H3.5–H3.8 con pausa offline/wake, deduplicación de armado, invalidación de capturas tardías y reinicio desarmado al recargar.
- Rebase automático al entrar o salir de una sesión y desarmado al cambiar la credencial, evitando mezclar evidencia anterior al inicio o snapshots de cuentas distintas.
- Contigüidad corregida en H3.6/H3.7: los deltas comparten snapshot fronterizo y admiten el tiempo real no solapado que tarda la captura A/B/C, en lugar de exigir timestamps imposiblemente idénticos.
- Revisión H3.9 de contaminación con preguntas explícitas para aperturas, reciclaje, consumo, fabricación/conversión, bazar, mercader, transferencias y otra actividad.
- Clasificación H2.7 conectada al cierre: limpio confirmado, estimado pendiente o contaminado, sin inferir actividad TP que todavía no se consulta.
- Runtime de sesión v2 con revisión derivada y terminal completo persistentes; migración segura de v1 a `review:null` y rechazo de clasificaciones manipuladas.
- Recarga local de la última sesión completa y borrado explícito antes de empezar otra, sin prometer todavía historial multiparte ni notas.
- Medición H3.10 local e idempotente de fronteras manuales/asistidas con incertidumbre, evidencia y causa en IndexedDB dedicada.
- Corrección explícita de falsos positivos mediante causas cerradas; los descartes de inicio sin sesión también se conservan localmente.
- Resumen visible por sesión con modo manual/asistido/mixto, incertidumbre y correcciones, sin bloquear el motor si la telemetría local falla.
- Contrato H4.1 puro y versionado en cobre para bruto, venta inmediata, listado, mercader y no líquido, con fuente y liquidez explícitas.
- Aritmética monetaria de enteros seguros con rechazo de overflow, tasas inválidas o mayores que el bruto; no líquido usa `null` y no falsos ceros.
- Política H4.2 versionada del bazar: 5% de publicación y 10% de intercambio calculados por separado sobre el total de la pila, con redondeo y mínimo de un cobre por tasa.
- Valor de mercader H4.2 solo para `CatalogItem` válido, `vendorValue` positivo y sin `NoSell`; el binding aislado no se interpreta como prohibición.
- Clasificador H4.3 por pila con rutas TP/mercader separadas, binding observado o derivado, estado de precio explícito y ausencia de valor líquido representada con `null`.
- Pilas account/character-bound, binding desconocido, precio ausente y objetos engastados/equipados nunca reciben valor TP; el mercader solo conserva su suelo probado.
- Captura H4.4 de bid/ask al cierre para cada item ganado mediante `/v2/commerce/prices`, sin credencial, en lotes ordenados de hasta 200 ids.
- Snapshot de precios durable con timestamp, fuente, cantidad ganada y cobertura `complete|partial|unavailable`; errores u omisiones nunca se convierten en precio cero ni bloquean el cierre.
- Runtime de sesión v3 con migración segura de v1/v2 y validación cruzada entre sesión, delta físico e ids/cantidades del snapshot de precios.
- Valoración H4.5 por item con rutas separadas de venta inmediata, listado y mercader, eligiendo el mejor suelo demostrado sin convertir ausencias en cero.
- Totales de sesión reproducibles con moneda neta observada, cantidad no líquida, sacos/h en milésimas y cobre/h; pérdidas, catálogo, binding o precios incompletos quedan como warnings explícitos.
- Esquema H4.6 versionado para modelos de contenedor con fuente, muestra, fechas, resultados, incertidumbre y política de valoración obligatorias.
- Unidades muestrales y esperadas por saco en millonésimas enteras, con orden canónico, claves separadas por namespace y validación reproducible sin floats.
- Modelo H4.7 conservador de Bolsa de truco o trato, fijado a 106.264 aperturas de la revisión wiki `3161313`, con 18 resultados identificados por item id.
- Exclusión explícita de todos los superraros y de la cola rara no respaldada para que ningún jackpot observado infle el valor esperado.
- EV H4.8 conservador por saco en microcobre, separando venta inmediata y listado tras tasas separadas de 5% y 10% con redondeo a cobre, con cobertura independiente por ruta.
- Resultados ligados o excluidos aportan exactamente cero oro líquido; una cotización ausente deja EV total `null` y conserva solo el subtotal conocido.
- Plan de reservas H4.9 puro y versionado sobre objetivos activos y balance final, con asignación exclusiva/determinista, bases `owned|available` revalidables, shortfall y cobertura por namespace explícitos.
- Recomendación H4.10 pura para contenedores: reserva primero, exige clasificación H2.7 v2 exacta/alta, modelo atestado y precios frescos, recompone EV/fees desde evidencia cruda y decide abrir/vender con umbral `BigInt` explicado sin ejecutar ninguna operación.
- Endurecimiento H4.10 contra evidencia trasplantada: recompone review y overlay desde los mismos snapshots/delta, valida identidad antes de `reserved_only` y liga la aprobación al SHA-256 canónico completo del modelo; reviews H2.7 v1 históricos siguen cargables pero no autorizan recomendar.
- Recomputación integral H4.10 de balance y plan desde objetivos + snapshot final, cronología cerrada y coherencia semántica de severidades/solicitudes en clasificaciones H2.7 v2.
- Intenciones H4.11 puras y versionadas: asignación exclusiva por deadline/id sobre la cantidad libre posterior a reservas, liberación por objetivo/cancelación/expiración, protección explícita sin precio y proyección neta H4.2.
- Integración H4.10 de planes H4.11 recomputados contra el mismo overlay y batch: las unidades retenidas conservan procedencia y se excluyen de la economía sin ejecutar ninguna operación.
- Frescura H4.10 validada antes de interpretar intenciones cuando H4.9 deja unidades libres; un batch stale/futuro bloquea y no puede ocultarse como `reserved_only`.
- Envelope H4.12 JSON-only para todos los estados H4.10, marcado siempre manual, sin efectos laterales y con refs internas a reserva, retención, economía o revisión; no existe executor público.
- Guard arquitectónico H4.12 sobre todos los módulos productivos de recomendación, probado en rojo mediante sabotaje con un import de `GuildWars2Client` y restaurado después con contenido/modo exactos.
- Matriz action/route H4.12 cerrada por acción y guard ampliado a imports side-effect, `import()` y `require()` literales, con regresiones de las cuatro sintaxis.
- Contrato H4.13 del Inventory Advisor limitado a `supported_storage_v1`, con inputs identity-bound, catálogo/precios/señales/reglas estrictos, partición cuantitativa por posición y resultado fail-closed.
- Envelope H4.13 específico de inventario, siempre manual y sin efectos laterales; expone `discard_candidate` solo como revisión irreversible ligada a regla curada y no contiene `destroy` ni executor.
- Guard arquitectónico causal sobre la frontera H4.13 contra clientes, red, secretos, stores, Obsidian, capacidades de operación e imports estáticos/dinámicos prohibidos.
- H4.14 captura explícita de evidencia del Inventory Advisor: catálogo para todos los `ownedByItem`,
  cotizaciones públicas H4.4 para todos los `availableByItem`, señales account-wide y wrapper con
  identidad, cobertura y TTL independientes; no añade UI, persistencia ni decisiones.
- Endurecida H4.14: fingerprint SHA-256 sensible al orden físico, TTL de snapshot y timestamps
  canónicos, endpoints privados `requestDetailed`/HTTP 200, `cache_stale` y delivery limitado
  degradados, y guard dinámico contra persistencia, UI, temporizadores u operaciones irreversibles.
- Extraído el parser público de precios H4.4 para que sesiones y evidencia account-wide compartan
  tratamiento de lotes, duplicados, omisiones y bid/ask nulos.
- H4.15 añade el clasificador puro del Inventory Advisor: particiona todas las posiciones propias,
  respeta reservas/excepciones, revisa evidencia desconocida o contradictoria y limita TP a bid depth
  demostrada con tasas H4.2. Knowledge packs V1 hasheados distinguen afirmación positiva de
  `not_applicable`; no se emite `discard_candidate` ni se realizan efectos laterales.
- El contrato H4.13 ahora exige que las decisiones y cantidades de una línea particionen propiedad,
  no solo disponibilidad; sus reglas expresan `applicable|not_applicable`.
- Nuevo guard dinámico H4.15 contra red, UI, Vault, persistencia, temporizadores y operaciones
	irreversibles en todos los módulos productivos del clasificador.
- H4.16 añade una allowlist de descarte pura y separada: reproduce H4.15 de forma canónica, enlaza
	reglas y assertions a fuentes no vacías, y solo emite `discard_candidate` review-only con proof SHA.
- Allowances por intención para items y divisas: una reserva solo habilita de nuevo su uso declarado; evidencia desconocida permanece `null` y nunca se interpreta como cantidad utilizable.
- Builder desde snapshots H2.6 comparables y overlay cuantitativo sobre evidencia H4.5 validada contra delta, política de fees, binding y procedencia de sack IDs, sin mutar ni prorratear valoración, importes, tasas o cobertura.
- Módulos `core`, `account`, `advisor`, `sessions` y `objectives`.
- Fixtures anonimizadas y tests de migración, seguridad, parsers, agregados, cobertura, concurrencia y consistencia.
