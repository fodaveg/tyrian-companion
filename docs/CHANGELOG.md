# Changelog

Todos los cambios notables del proyecto se documentan aquí.

## [0.1.0] - Unreleased

### Added

- Scaffold de plugin Obsidian TypeScript/esbuild con ESLint, Vitest y CI.
- Vista **Tyrian Companion** y comando **Open companion**.
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
- Módulos `core`, `account`, `advisor`, `sessions` y `objectives`.
- Fixtures anonimizadas y tests de migración, seguridad, parsers, agregados, cobertura, concurrencia y consistencia.
