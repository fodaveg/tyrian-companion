# Estado

## Vertical activa

**Foundation, conexión GW2, H1.4 coordinación, H3.1 máquina de estados, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta` y H2.7 contaminación: implementados.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 añade el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`, con fencing estable, snapshots de frontera comparables, transiciones idempotentes y error recuperable, todavía sin orquestación ni UI. El servicio de snapshot captura y normaliza almacenamiento con consistencia A/B/C. `PublicCatalog` resuelve después metadatos públicos localizados con cobertura/avisos por id, detalles útiles para Advisor y caché local persistente en IndexedDB con fallback a memoria. H2.6 compara snapshots cualificados mediante álgebra pura, verifica exactamente sus índices agregados y separa netos, disponibilidad y composición. H2.7 proyecta evidencia de frontera y clasifica el neto como exacto, estimado, contaminado o inválido con razones, revisión y permisos conservadores. No hay precios, preguntas, aceptación/persistencia de sesiones ni recomendaciones. Sigue sin haber red al cargar o abrir la vista, y estos servicios no tienen acción de UI.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 18 ficheros y 317 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar persistencia explícita de sesiones y objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
4. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
5. Conectar el snapshot a una acción explícita solo cuando exista contrato de UI/persistencia.
6. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
7. Implementar en H3.9 las preguntas, aceptación y persistencia que consumirán la clasificación H2.7.
8. Hacer QA manual de H1.4 con dos ventanas y dos procesos reales de Obsidian antes de conectar la orquestación H3.2.
