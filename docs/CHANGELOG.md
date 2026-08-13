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
- Módulos `core`, `account`, `advisor`, `sessions` y `objectives`.
- Tests de migración, seguridad del cliente, respuestas inválidas, errores HTTP y estado de conexión.
