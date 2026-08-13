# Estado

## Vertical activa

**Foundation, conexión GW2, `storage_snapshot`, H2.4 `PublicCatalog` y H2.6 `storage_delta`: implementados.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. El servicio de snapshot captura y normaliza almacenamiento con consistencia A/B/C. `PublicCatalog` resuelve después metadatos públicos localizados con cobertura/avisos por id, detalles útiles para Advisor y caché local persistente en IndexedDB con fallback a memoria. H2.6 compara snapshots cualificados mediante álgebra pura, verifica exactamente sus índices agregados y separa netos, disponibilidad y composición. Wallet opcional limita solo la superficie de divisas; el delta de items sigue disponible con core/personajes completos. No hay precios, heurísticas de contaminación, persistencia de deltas ni mutación del snapshot. Sigue sin haber red al cargar o abrir la vista, y estos servicios no tienen acción de UI.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 15 ficheros y 198 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar persistencia explícita de sesiones y objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
4. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
5. Conectar el snapshot a una acción explícita solo cuando exista contrato de UI/persistencia.
6. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
7. Diseñar H2.7 para interpretar deltas en contexto de sesión sin contaminar el comparador puro.
