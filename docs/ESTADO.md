# Estado

## Vertical activa

**Foundation, primera conexión GW2 y núcleo `storage_snapshot`: implementados.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. El servicio de snapshot captura y normaliza almacenamiento con consistencia A/B/C, cobertura por fuente y concurrencia acotada. Sigue sin haber red al cargar o abrir la vista, y el snapshot aún no tiene acción de UI.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 9 ficheros y 86 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar persistencia explícita de sesiones y objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Diseñar catálogo/cache y enriquecimiento sin confundir snapshot con patrimonio total.
4. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
5. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
6. Conectar el snapshot a una acción explícita solo cuando exista contrato de UI/persistencia.
7. Probar la carga y conexión manual en una bóveda de desarrollo; no forma parte de este worktree.
