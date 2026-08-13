# Estado

## Vertical activa

**Foundation, conexión GW2, `storage_snapshot` y H2.4 `PublicCatalog`: implementados.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. El servicio de snapshot captura y normaliza almacenamiento con consistencia A/B/C. `PublicCatalog` resuelve después metadatos públicos localizados con cobertura/avisos por id, detalles útiles para Advisor y caché local persistente en IndexedDB con fallback a memoria; no hay precios ni mutación del snapshot. Sigue sin haber red al cargar o abrir la vista, y ninguno de ambos servicios tiene acción de UI.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 14 ficheros y 143 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar persistencia explícita de sesiones y objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
4. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
5. Conectar el snapshot a una acción explícita solo cuando exista contrato de UI/persistencia.
6. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
