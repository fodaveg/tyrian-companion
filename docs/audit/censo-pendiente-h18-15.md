# Censo de observabilidad pendiente — H18.15

Propuesta sin aplicar. No se ha editado `scripts/action-observability-baseline.json` de ninguna
forma. `node scripts/action-observability-census.mjs` marca 20 entradas sin revisar sobre el árbol
tras `git merge --ff-only main`, pero **19 de esas 20 son de otros lotes ya fusionados en `main`**
(H18.5/H18.20, H18.22/H18.23 y el experimento de venta de la sección 3.D), cada una con su propio
censo pendiente ya presente en este directorio (`censo-pendiente-festivales-h18-5-20.md`,
`censo-pendiente-puente-h18-22-23.md`) o cubierta por documentación previa a este encargo. Este
encargo (H18.15) no toca ninguno de esos ficheros; se comprobó comparando el `catch` señalado en
`src/ui/settings-tab.ts:943-946` contra `git show 3430e65:src/ui/settings-tab.ts`, donde ya existe
(bloque del secreto del puente, H18.23, mismo texto normalizado — el censo lo identifica por
contenido y ancestro, no por número de línea, así que un desplazamiento de línea nunca lo cuenta
como nuevo por sí solo).

La única entrada nueva que introduce mi propio diff es:

```
- src/inventory/storage-space.ts: new_production_file
```

| Fichero | Clasificación propuesta | Fronteras (`catch`/`void`/callback) | Motivo |
|---|---|---|---|
| `src/inventory/storage-space.ts` | `production_source` | 0 | Módulo puro de H18.15 (huecos libres, capacidad de materiales «al menos N», estado de espacio y prioridad de acciones para liberarlo). Solo funciones puras sobre datos ya capturados: sin `catch`, sin `Promise`/`.then`/`.catch`, sin `void` suelto ni registro de callback (`addEventListener`, `setTimeout`, etc.). No escribe nada, no llama a la red ni a Obsidian. |

No se ha tocado ningún otro fichero de producción nuevo a raíz de este encargo. Los cambios en
`src/account/storage-snapshot-service.ts` (nuevos parámetros `onFreeSlots`/callback de personaje) y
en `src/ui/settings-tab.ts` (nuevo `onChange` del umbral) no añaden fronteras que el censo cuente:
`onChange`/`onFreeSlots` no están en `CALLBACK_REGISTRATIONS` (esa lista solo cubre
`addEventListener`, `addCommand`, `finally`, `on`, `queueMicrotask`, `registerDomEvent`,
`registerEvent`, `requestAnimationFrame`, `setInterval`, `setTimeout`, `then`), y ninguno de los dos
ficheros añade un `catch`, un `void` suelto ni una de esas llamadas registradas.
