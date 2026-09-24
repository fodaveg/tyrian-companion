# Censo pendiente del lote de sesión automática y atribución H18.11/H18.26: propuesta sin aplicar

Árbol: `tyrian-companion`, rama `worktree-agent-a0d8f368cf66e1c40`, base `d055942` con `main`
(`a41c1d4`) integrada. El baseline `scripts/action-observability-baseline.json` está **exactamente**
como en `a41c1d4`. Por eso `node scripts/action-observability-census.mjs` sale en rojo con 42
entradas. `a41c1d4` ya sale con 31, que son de otros lotes y tienen su propio documento. Las **11 de
diferencia** son de este lote y se recogen aquí.

Actualizado tras la corrección de H18.11 (huecos sin observar restados de la duración): esa
corrección **no añade ni quita fronteras**. `recordUnobservedGap` no tiene `catch` ni `void`; un
guardado rechazado se registra con `this.diagnostics.event` en el camino normal, sin frontera. Solo
cambian las líneas de las 11 entradas, que ya van actualizadas abajo.

**No se ha aplicado nada.**

Cómo leer la tabla:

- Las líneas de las fronteras añadidas son las del árbol actual. La quitada lleva la línea que tenía
  en el baseline de `a41c1d4`.
- El `id` es el hash AST que calcula el censo (ruta, tipo, registro, ancestros y texto del nodo).
  Si cambia el texto de una frontera, cambia su `id`, y el censo la cuenta como una quitada más una
  añadida aunque sea la misma frontera.
- Para asignar cada entrada a este lote comparé los `id` del árbol de esta rama con los de una copia
  limpia de `a41c1d4` (`git archive a41c1d4`), con el mismo script del censo.
- Cada justificación va tal como iría en el JSON, con las comillas escapadas (`\"`).
- Todas cumplen `isSpecificAllowlistJustification`:
  - miden entre 48 y 480 caracteres;
  - no tienen saltos de línea;
  - contienen `"<scope>"` y `"<discriminador>"`.
- La `reason` no se escribe a mano: `decisionReason()` la deriva de la evidencia.
- Un fichero nuevo sin fronteras entra en el baseline con `boundaries: []` y la `reason` fija del
  censo para `production_source`. No lleva justificación.

## Las 11 entradas

| # | Fichero | Hallazgo del censo | Frontera (kind, scope, línea) | `id` | Clasificación propuesta | Justificación literal propuesta |
|---|---|---|---|---|---|---|
| 1 | `src/sessions/ingame-session-marker.ts` | `new_production_file` | `callback_registration`, `then`, `enqueue`, 140 | `5dbc8538fdf571372fd8396118dadc394709c2bc` | `allowlisted`, `reviewed_registered_callback`, registration `then` | The \"enqueue\" owner registers \"then\" only to chain one presence event after the previous one; the chained work runs inside its own try/catch, which hands any failure to the port recordFailure that main.ts records as a structured session failure, so the chain never rejects. |
| 1b | `src/sessions/ingame-session-marker.ts` | (mismo `new_production_file`) | `catch_clause`, `enqueue`, 144 | `cbef43ee1259ced7e57bae406632b6a5dc874b90` | `allowlisted`, `reviewed_recovery`, behavior `local_recovery` | The \"enqueue\" owner applies \"local_recovery\" to a start, stop or link write that threw: it hands the error to the port recordFailure, which main.ts turns into a structured session failure record, and keeps the queue alive for the next presence event. |
| 2 | `src/sessions/session-attribution.ts` | `new_production_file` | — (0 fronteras) | — | Se añade con `classification: production_source`, `boundaries: []` y la `reason` fija «Reviewed production TypeScript file; zero-boundary files remain in scope so additions cannot bypass the census.» | — (un fichero sin fronteras no lleva justificación) |
| 3 | `src/main.ts` | `void_expression (added)` | `void`, `onSessionStateChange`, 1135 | `f210ad400edaf7ee949b637a49491c31f1ffc81b` | `allowlisted`, `reviewed_detached_execution`, target `this.ingameSessionMarker.reconcile` | The \"onSessionStateChange\" owner deliberately detaches \"this.ingameSessionMarker.reconcile\"; that named operation never rejects, because its queue catches every failure and records it through recordIngameSessionFailure. |
| 4 | `src/main.ts` | `void_expression (added)` | `void`, `startIngameSessionMarking` (listener de presencia), 2820 | `b32774ef058c6d27ca64b3a0baab3b72c0f6858f` | `allowlisted`, `reviewed_detached_execution`, target `marker.handle` | The \"startIngameSessionMarking\" owner deliberately detaches \"marker.handle\" from the synchronous presence listener; that named operation never rejects, because its queue catches every failure and records it through recordIngameSessionFailure. |
| 5 | `src/main.ts` | `void_expression (added)` | `void`, `startIngameSessionMarking` (puesta al día inicial), 2821 | `c61cd899430e0b12a09ee25b52cc6422a4f435d8` | `allowlisted`, `reviewed_detached_execution`, target `marker.reconcile` | The \"startIngameSessionMarking\" owner deliberately detaches \"marker.reconcile\" to catch up with a presence that started before the runtime was ready; that named operation never rejects, because its queue catches every failure and records it through recordIngameSessionFailure. |
| 6 | `src/main.ts` | `catch_clause (added)` | `catch_clause`, `readIngameSessionLink`, 2875 | `e76f830431a3ae81a48f7d6fc7106ba9af942db1` | `allowlisted`, `reviewed_recovery`, behavior `fallback_return` | The \"readIngameSessionLink\" owner applies \"fallback_return\" when the per-vault local storage throws: it records the error through recordIngameSessionFailure and returns null, so the marker treats a running session as adopted and never closes it on its own. |
| 7 | `src/main.ts` | `catch_clause (added)` | `catch_clause`, `writeIngameSessionLink`, 2886 | `357227afc86d4bd63c1262d9cd0d7f964a235f27` | `allowlisted`, `reviewed_recovery`, behavior `local_recovery` | The \"writeIngameSessionLink\" owner applies \"local_recovery\" when the per-vault local storage write throws: it records the error through recordIngameSessionFailure; the link stays in memory for this window, and only a reload loses the automatic owner. |
| 8 | `src/main.ts` | `callback_registration (added)` | `finally`, `performStopManualSession`, 3310 | `fe0cd4e6a46811e835d356dd289b32b4d6a5e0d4` | `allowlisted`, `reviewed_registered_callback`, registration `finally` (decisión de la fila 9, sin cambios) | The \"performStopManualSession\" owner registers \"finally\" as a framework callback; its invoked action or state transition owns diagnostics. |
| 9 | `src/main.ts` | `callback_registration (removed)` | `finally`, `performStopManualSession`, 3125 en el baseline de `a41c1d4` | `263a458bd170dc1cdfc1c27167d087894bd14005` | Se elimina del baseline: su nodo ya no existe; la sustituye la fila 8 | — (su decisión era `allowlisted`, registro `finally` en `performStopManualSession`) |
| 10 | `src/sessions/manual-session-start-service.ts` | `callback_registration (added)` | `finally`, `runStop`, 491 | `4b288698335298af4f43c393bea4783172383775` | `allowlisted`, `reviewed_registered_callback`, registration `finally` (misma decisión que la fila 5 de `censo-pendiente-sesiones-h18-4-9.md`) | The \"runStop\" owner registers \"finally\" as a framework callback; its invoked action or state transition owns diagnostics. |
| 11 | `src/sessions/manual-session-start-service.ts` | `void_expression (added)` | `void`, `heartbeat`, 1343 | `2f4c0d725054717cd7c6fd6c0f25b98a3a6ef92b` | `allowlisted`, `reviewed_detached_execution`, target `this.saveActiveEvidence` | The \"heartbeat\" owner deliberately detaches \"this.saveActiveEvidence\" so an IndexedDB write never delays or fails the lease renewal; that named operation catches every failure and records it through this.diagnostics.event, so a lost evidence save is never silent. |
| 12 | `src/sessions/manual-session-start-service.ts` | `catch_clause (added)` | `catch_clause`, `saveActiveEvidence`, 1746 | `7201fea7f3d33010a6cfd569eb5fef4c468191b1` | `observed`, callee `this.diagnostics.event` | — (una decisión `observed` no lleva justificación) |

Las filas 1 y 1b son un solo hallazgo del censo (`new_production_file`); por eso la tabla tiene 12
filas numeradas y 11 hallazgos.

## Cruce con la propuesta pendiente del lote de sesiones (H18.4/H18.7/H18.8/H18.9)

- `runStop` recibe ahora `endAtMs` (H18.26) y su `finally` cuelga de
  `stopAndScheduleRetry(force, endAtMs)`. El `id` que proponía la fila 5 de
  `censo-pendiente-sesiones-h18-4-9.md` (`b50cbbf5fee6d847c900c0d7947646cc547d6b25`) ya no existe en
  este árbol. Si se aplica esa propuesta junto con esta, la fila 10 de aquí sustituye a su fila 5 y
  sigue valiendo su fila 21, que quita `ab7458faba989804a7934dbdcbb546d8c7f135c7` del baseline. Por
  eso ese `id` no cuenta aquí como quitado: en `a41c1d4` sigue siendo un pendiente, no una entrada del
  baseline.

## Por qué cambia la que ya existía (filas 8 y 9)

- **Filas 8 y 9.** `performStopManualSession` llama ahora a `this.sessions.stopAt(observedEndAtMs)`
  cuando la presencia observó el fin (H18.26). El `.finally(() => runtimeLease.release())` es el
  mismo, pero cuelga de otro texto de nodo.

## Nuevas de verdad (filas 1 a 7 y 10 a 12)

- **Filas 1, 1b y 3 a 7.** Son el marcado automático de sesión por la presencia del juego (H18.26):
  - la cola que procesa los eventos de uno en uno;
  - su captura de fallos;
  - los tres `void` que la alimentan desde `main.ts`;
  - la lectura y la escritura del enlace en el almacenamiento local por bóveda.
- **Filas 11 y 12.** Son el guardado de la evidencia de sesión viva desde el latido (H18.11). Esa
  evidencia marca dónde empieza el hueco sin observar que se resta de la duración de una sesión
  retomada; el fin sigue siendo la parada del jugador.
- **Fila 2.** `session-attribution.ts` es un módulo puro (H18.11). No tiene fronteras.

Ninguna se traga un fallo sin rastro:

- Las filas 1b, 6, 7 y 12 registran el error.
- Las demás desvinculan o encadenan una operación que ya lo registra.
- La fila 6 devuelve el valor conservador: sin enlace, la presencia adopta la sesión y nunca la
  cierra.
