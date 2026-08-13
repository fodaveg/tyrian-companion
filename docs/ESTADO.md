# Estado

## Vertical activa

**Foundation y primera conexión GW2: implementadas con gate local verde.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. No hay red al cargar ni al abrir la vista.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 7 ficheros y 60 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar persistencia explícita de sesiones y objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Implementar inventario solo en una vertical posterior con su permiso y contrato.
4. Probar la carga y conexión manual en una bóveda de desarrollo; no forma parte de este worktree.
