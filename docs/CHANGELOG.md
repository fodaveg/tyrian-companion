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
- Módulos `core`, `account`, `advisor`, `sessions` y `objectives`.
- Fixtures anonimizadas y tests de migración, seguridad, parsers, agregados, cobertura, concurrencia y consistencia.
