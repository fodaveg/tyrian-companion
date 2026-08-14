# Changelog

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
