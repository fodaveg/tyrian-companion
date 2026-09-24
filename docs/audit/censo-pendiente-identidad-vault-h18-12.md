# Censo pendiente del lote de identidad de sesión por vault H18.12: propuesta sin aplicar

Árbol: `tyrian-companion`, rama `worktree-agent-ad7ccbd4f1c3a1af5`, base `d055942` (`main`). El
baseline `scripts/action-observability-baseline.json` está **exactamente** como en `d055942`. Por eso
`node scripts/action-observability-census.mjs` sale en rojo: 43 entradas en total. De ellas, **1 es
de este lote** y se recoge aquí. Las otras 42 ya salían en `d055942` sin este lote, y las cubren
`censo-pendiente-sesiones-h18-4-9.md`, `censo-pendiente-puente-h18-22-23.md` y
`censo-pendiente-festivales-h18-5-20.md`, más los tres ficheros de H18.21 que ese primer documento
ya señala sin cubrir.

**No se ha aplicado nada.**

Cómo leer la tabla:

- Para asignar cada entrada a este lote, comparé la salida del censo en este árbol con la de una copia
  limpia de `d055942` (`git archive d055942`, con el mismo `node_modules`). La única línea nueva es
  la de la tabla.
- Ninguna frontera ya existente cambia de `id`. En `src/main.ts`,
  `src/runtime/assemble-sessions.ts`, `src/sessions/coordination-coordinator.ts`,
  `src/sessions/session-runtime-store.ts` y `src/sessions/manual-session-start-service.ts` este lote
  solo toca código fuera de cualquier `catch`, `.catch`, `void` o callback registrado. En
  `session-runtime-store.ts`, el `try/catch` de `open()` conserva su texto: la apertura pasa a
  `openDatabase()`, fuera de él.
- Un fichero nuevo sin fronteras entra en el baseline con `boundaries: []` y la `reason` fija del
  censo para `production_source`. No lleva justificación.

## La entrada

| # | Fichero | Hallazgo del censo | Frontera (kind, scope, línea) | `id` | Clasificación propuesta | Justificación literal propuesta |
|---|---|---|---|---|---|---|
| 1 | `src/sessions/session-storage-scope.ts` | `new_production_file` | — (0 fronteras) | — | Se añade con `classification: production_source`, `boundaries: []` y la `reason` fija «Reviewed production TypeScript file; zero-boundary files remain in scope so additions cannot bypass the census.» | — (un fichero sin fronteras no lleva justificación) |

## Por qué el fichero nuevo no tiene fronteras

- **`SessionStorageScope.names()`** no atrapa nada: usa `try/finally` solo para soltar la promesa en
  vuelo. Si la decisión falla, el rechazo llega al store o al coordinador que preguntó. Allí ya hay
  una frontera revisada: el `catch` de `IndexedDbSessionRuntimeStore.open()`, que registra el fallo
  con `attempt.failure`, y los `catch` del coordinador, que devuelven
  `{ status: 'error', code: 'unavailable' }`.
- **`resolveSessionStorageNames`** cierra la base con `try/finally` y deja pasar el error.
- **`claimLegacyStorage`** crea la transacción dentro del ejecutor de la `Promise`. Si lanza, la
  promesa se rechaza sola, sin `catch`. Los manejadores `onsuccess`, `oncomplete`, `onerror` y
  `onabort` son asignaciones de propiedad. No están en `CALLBACK_REGISTRATIONS` del censo, igual que
  en todos los stores de IndexedDB del repo.

Ninguna ruta se traga un fallo: si la decisión no se puede tomar, la sesión de ese vault no se abre,
y eso se ve como almacenamiento no disponible. Nunca cae a la base de otro vault.
