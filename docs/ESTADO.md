# Estado

## Vertical activa

**Foundation, conexión GW2, H1.4 coordinación, H3.1 máquina de estados, H3.2 inicio manual, H3.3 cierre manual, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta` y H2.7 contaminación: implementados.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 define el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`. H3.2 conecta su primer tramo a una acción explícita: un modal pide personaje y Magic Find manual, adquiere el lease, mantiene heartbeat, captura un baseline A/B/C estable y lee el build activo con la misma clave efímera; solo entonces confirma `active`. Un fallo libera el lease, conserva un mensaje saneado y vuelve a `idle`, sin sesión de producto fantasma. H3.3 añade **Stop session**: fija `stopping`, captura otro snapshot estable, calcula el delta H2.6, comprueba de nuevo el fence y solo entonces confirma `provisional`. Los fallos de captura/delta ofrecen reintento conservando baseline y frontera; perder autoridad conserva el estado fallido para H3.4. El servicio de snapshot captura y normaliza almacenamiento con consistencia A/B/C. `PublicCatalog` resuelve después metadatos públicos localizados con cobertura/avisos por id, detalles útiles para Advisor y caché local persistente en IndexedDB con fallback a memoria. H2.6 compara snapshots cualificados mediante álgebra pura, verifica exactamente sus índices agregados y separa netos, disponibilidad y composición. H2.7 proyecta evidencia de frontera y clasifica el neto como exacto, estimado, contaminado o inválido con razones, revisión y permisos conservadores. No hay precios, revisión/aceptación/persistencia de sesiones ni recomendaciones. Sigue sin haber red al cargar o abrir la vista; solo **Check connection**, **Start session** y **Stop session** llaman a la API.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 20 ficheros y 354 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar persistencia explícita de sesiones y objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
4. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
5. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
6. Implementar en H3.9 las preguntas, aceptación y persistencia que consumirán la clasificación H2.7.
7. Hacer QA manual de H3.2–H3.3 en dos ventanas y, si Obsidian comparte el origin, dos procesos reales: doble clic, stop/retry, reload, cierre forzado y pérdida/recovery del lease.
