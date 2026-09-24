# Censo pendiente del lote de sesiones H18.4/H18.7/H18.8/H18.9: propuesta sin aplicar

Árbol: `tyrian-companion`, rama `worktree-agent-aa63ece7f81ce22c3`, base `a2584af` con `main`
(`f0b32bc`) integrada. El baseline `scripts/action-observability-baseline.json` está **exactamente**
como en `a2584af`. Por eso `node scripts/action-observability-census.mjs` sale en rojo: 42 entradas en
total. De ellas, **23 son de este lote** y se recogen aquí. Las otras 19 vienen de `main`:

- `censo-pendiente-puente-h18-22-23.md` cubre las 6 de `ensureAlertIngameServer` en `src/main.ts`,
  las de `alert-ingame-*` y la de `settings-tab.ts`.
- `censo-pendiente-festivales-h18-5-20.md` cubre `src/economy/models/halloween-festival-anchors.ts`.
- **Ningún documento** cubre los tres ficheros nuevos de H18.21:
  - `src/economy/sell-timing-experiment.ts`;
  - `src/economy/__fixtures__/sell-timing-history-36038.ts`;
  - `src/economy/__fixtures__/sell-timing-history-47909.ts`.

  Queda pendiente fuera de este lote.

**No se ha aplicado nada.**

Cómo leer la tabla:

- Las líneas de las fronteras añadidas son las del árbol actual. Las quitadas llevan la línea que
  tenían en el baseline de `a2584af`.
- El `id` es el hash AST que calcula el censo (ruta, tipo, registro, ancestros y texto del nodo).
  Si cambia el texto de una frontera, cambia su `id`, y el censo la cuenta como una quitada más una
  añadida aunque sea la misma frontera. Eso explica las 6 quitadas.
- Para asignar cada entrada a este lote o a `main`, comparé los `id` del árbol de esta rama con los
  de una copia limpia de `main`.
- Cada justificación va tal como iría en el JSON, con las comillas escapadas (`\"`).
- Todas cumplen `isSpecificAllowlistJustification`:
  - miden entre 48 y 480 caracteres;
  - no tienen saltos de línea;
  - contienen `"<scope>"` y `"<discriminador>"`.
- La `reason` no se escribe a mano: `decisionReason()` la deriva de la evidencia.

## Las 23 entradas

| # | Fichero | Hallazgo del censo | Frontera (kind, scope, línea) | `id` | Clasificación propuesta | Justificación literal propuesta |
|---|---|---|---|---|---|---|
| 1 | `src/main.ts` | `callback_registration (added)` | `registerDomEvent` (`online`), `onload`, 507 | `255e5d937563da91f21a022e173b0d7b9778eefe` | `observed`, callee `this.localDebugActions.runSync` (decisión de la fila 18, sin cambios; el AST sigue viendo esa llamada) | — (una decisión `observed` no lleva justificación) |
| 2 | `src/main.ts` | `callback_registration (added)` | `registerDomEvent` (`visibilitychange`), `onload`, 535 | `efd5c3da640d5e59695b05cc90be4c831a1aa133` | `allowlisted`, `reviewed_registered_callback`, registration `registerDomEvent` (decisión de la fila 19, sin cambios) | The \"onload\" owner registers \"registerDomEvent\" as a framework callback; its invoked action or state transition owns diagnostics. |
| 3 | `src/main.ts` | `void_expression (added)` | `void`, `performStopManualSession`, 3195 | `7ba009549e11301d841969fc84fa66c64b18922d` | `allowlisted`, `reviewed_detached_execution`, target `this.pilotMetrics.proposalDecided` (decisión de la fila 20, sin cambios) | The \"performStopManualSession\" owner deliberately detaches \"this.pilotMetrics.proposalDecided\"; that named operation owns rejection and terminal diagnostics. |
| 4 | `src/sessions/manual-session-start-service.ts` | `void_expression (added)` | `void`, `notifyWake`, 361 | `5652a96c5b1d1d031a9d99672e92877abc5b7ca3` | `allowlisted`, `reviewed_detached_execution`, target `this.runHeartbeat` | The \"notifyWake\" owner deliberately detaches \"this.runHeartbeat\" when the machine wakes; that named operation catches every renewal failure, records it through logAuthorityFailure and fails the session closed, so nothing it throws is lost. |
| 5 | `src/sessions/manual-session-start-service.ts` | `callback_registration (added)` | `finally`, `runStop`, 442 | `b50cbbf5fee6d847c900c0d7947646cc547d6b25` | `allowlisted`, `reviewed_registered_callback`, registration `finally` (decisión de la fila 21, sin cambios) | The \"runStop\" owner registers \"finally\" as a framework callback; its invoked action or state transition owns diagnostics. |
| 6 | `src/sessions/manual-session-start-service.ts` | `callback_registration (added)` | `finally`, `finalizeStoppedSession`, 481 | `cc7bd25234879018f8fb89045ee882df9ab46914` | `allowlisted`, `reviewed_registered_callback`, registration `finally` (decisión de la fila 22, sin cambios) | The \"finalizeStoppedSession\" owner explicitly handles \"finally\": as the in-flight guard release of the single finalize flight; it only clears a field and cannot reject. |
| 7 | `src/sessions/manual-session-start-service.ts` | `callback_registration (added)` | `finally`, `runRecovery`, 666 | `ed98ff87dacffeb1e44809b46b2f45acf8007ada` | `allowlisted`, `reviewed_registered_callback`, registration `finally` (decisión de la fila 23, sin cambios) | The \"runRecovery\" owner registers \"finally\" as a framework callback; its invoked action or state transition owns diagnostics. |
| 8 | `src/sessions/manual-session-start-service.ts` | `void_expression (added)` | `void`, `checkSettlement` (reintento automático de `error`), 1366 | `78f9239f90f88fba32a29b81c28defa35fc2049d` | `allowlisted`, `reviewed_detached_execution`, target `this.runAutoRetry` | The \"checkSettlement\" owner deliberately detaches \"this.runAutoRetry\" from its synchronous timer tick; that named operation catches every failure, records it through this.diagnostics.event and schedules the next attempt, so a failed retry is never lost. |
| 9 | `src/sessions/manual-session-start-service.ts` | `void_expression (added)` | `void`, `checkSettlement` (recuperación automática en `idle`), 1373 | `8399a5db85d063a8137735acffba8231ca6fc607` | `allowlisted`, `reviewed_detached_execution`, target `this.runAutoRetry` | Igual que la fila 8 (misma justificación, literal). |
| 10 | `src/sessions/manual-session-start-service.ts` | `catch_clause (added)` | `catch_clause`, `runAutoRetry`, 1425 | `e0a297fa5960cf4908a3d4c2fd7927fcf200a644` | `observed`, callee `this.diagnostics.event` | — (una decisión `observed` no lleva justificación) |
| 11 | `src/sessions/manual-session-start-service.ts` | `callback_registration (added)` | `finally`, `reclaim`, 1444 | `a74b8a10cc69291ef1cc618abd071674d703c6c7` | `allowlisted`, `reviewed_registered_callback`, registration `finally` | The \"reclaim\" owner registers \"finally\" only to release its single in-flight reclaim slot; it clears one field, performs no I/O and cannot reject. |
| 12 | `src/sessions/manual-session-start-service.ts` | `catch_clause (added)` | `catch_clause`, `safeNowOr`, 1692 | `f7d959371b5c71afafb84bdbea0ee390f819089c` | `allowlisted`, `reviewed_recovery`, behavior `fallback_return` | The \"safeNowOr\" owner applies \"fallback_return\" when the injected clock is invalid: it returns the caller's fallback instant so a timer tick schedules its next attempt instead of throwing; every write still goes through safeNow, which rejects that clock. |
| 13 | `src/sessions/session-history.ts` | `catch_clause (added)` | `catch_clause`, `readSessionAt`, 280 | `f99fc2d7cb2b844e8cd234475f4b69156753f6a4` | `allowlisted`, `reviewed_recovery`, behavior `fallback_return` | The \"readSessionAt\" owner applies \"fallback_return\" when reading the one saved session note fails: it records the error through logFailure as a vault_read failure and returns unavailable, which keeps the summary marked saved and only hides its stored loot. |
| 14 | `src/sessions/session-runtime-store.ts` | `catch_clause (added)` | `catch_clause`, `loadSummaryReceipt`, 260 | `d5a3e83e03a8fc55feaaa9df53e5f5b785b0120b` | `allowlisted`, `reviewed_recovery`, behavior `fallback_return` | The \"loadSummaryReceipt\" owner applies \"fallback_return\" when the summary receipt cannot be read: it returns null, so the completed session is kept whole and the host falls back to the legacy note lookup; nothing is released on a failed read. |
| 15 | `src/sessions/session-runtime-store.ts` | `catch_clause (added)` | `catch_clause`, `saveSummaryReceipt`, 274 | `bbdd764f7d485361100ece9bddc72d4a37c0c728` | `allowlisted`, `reviewed_recovery`, behavior `fallback_return` | The \"saveSummaryReceipt\" owner applies \"fallback_return\" when the receipt write fails: it returns false to markCompletedSummarySaved, which keeps the proof in memory for this window; after a restart the legacy note lookup rebuilds it, so no result is lost. |
| 16 | `src/ui/companion-view.ts` | `void_expression (added)` | `void`, `onClick` (botón «Reintentar» de la tarjeta `stopping`), 612 | `6243ae2d061ad4b212fe789de00dc7697e672674` | `allowlisted`, `reviewed_detached_execution`, target `this.actions.stopManualSession().catch` | The \"onClick\" owner deliberately detaches \"this.actions.stopManualSession().catch\": the stopping-card retry button (H18.7) detaches stopManualSession exactly like the Terminar button; the `.catch()` only keeps this detached call from ever surfacing as an unhandled rejection. |
| 17 | `src/ui/companion-view.ts` | `promise_catch (added)` | `catch`, `onClick` (el mismo botón), 612 | `dcf31d370744298866eb3a77ab954d3df23b804c` | `allowlisted`, `reviewed_recovery`, behavior `intentional_noop` | The \"onClick\" owner explicitly handles \"intentional_noop\" as local recovery (H18.7): stopManualSession's rejection is already recorded, structured, by the diagnostics span wrapping it in main.ts, exactly as the Terminar button's own catch already does. |
| 18 | `src/main.ts` | `callback_registration (removed)` | `registerDomEvent` (`online`), `onload`, 484 en `a2584af` | `122ab6d07abecb785e0737dc931d16eed84ee471` | Se elimina del baseline: su nodo ya no existe; la sustituye la fila 1 (su decisión era `observed`, callee `this.localDebugActions.runSync`) | — |
| 19 | `src/main.ts` | `callback_registration (removed)` | `registerDomEvent` (`visibilitychange`), `onload`, 510 en `a2584af` | `06b19a66169f7f7be50a39bfdfb36211f5e8a0c1` | Se elimina; la sustituye la fila 2 | — |
| 20 | `src/main.ts` | `void_expression (removed)` | `void`, `performStopManualSession`, 3050 en `a2584af` | `1a588a40e30dc58333f0e568fcbf704c7ea0edb1` | Se elimina; la sustituye la fila 3 | — |
| 21 | `src/sessions/manual-session-start-service.ts` | `callback_registration (removed)` | `finally`, `runStop`, 361 en `a2584af` | `ab7458faba989804a7934dbdcbb546d8c7f135c7` | Se elimina; la sustituye la fila 5 | — |
| 22 | `src/sessions/manual-session-start-service.ts` | `callback_registration (removed)` | `finally`, `finalizeStoppedSession`, 377 en `a2584af` | `f57cd004227700ddfec7b2d4452b8edf0d2a6592` | Se elimina; la sustituye la fila 6 | — |
| 23 | `src/sessions/manual-session-start-service.ts` | `callback_registration (removed)` | `finally`, `runRecovery`, 535 en `a2584af` | `91c2355d361c271d60f42ecbf7a71ce118dc0f33` | Se elimina; la sustituye la fila 7 | — |

## Por qué cambian las que ya existían (filas 1 a 3, 5 a 7 y 18 a 23)

- **Filas 1 y 2.** Los manejadores `online` y `visibilitychange` de `onload` llaman ahora a
  `this.sessions.notifyWake()` (H18.7). Esa llamada forma parte del texto del nodo, así que le cambia
  el `id` a la frontera; no cambia su comportamiento de observabilidad.
- **Fila 3.** El `proposalDecided` detached de `performStopManualSession` recibe ahora `workflow`
  (`succeeded` o `failed`, H18.4) en lugar del literal `'succeeded'`.
- **Filas 5 a 7.** `runStop`, `finalizeStoppedSession` y `runRecovery` encadenan ahora
  `stopAndScheduleRetry`, `finalizeAndScheduleRetry` y `recoveryInternal(action, mode)`. El
  `finally` es el mismo liberador del slot en vuelo, pero sobre otro texto de nodo.

## Nuevas de verdad (filas 4 y 8 a 17)

- **Filas 4 y 8 a 12.** Son la vigilancia automática del ciclo de vida (H18.7): reintentos con
  espera creciente y retoma del lease.
- **Filas 13 a 15.** Son la prueba durable de resumen guardado (H18.8).
- **Filas 16 y 17.** Son el botón visible de reintento en la tarjeta `stopping` (H18.7).

Ninguna se traga un fallo sin rastro. Las que no llaman a un canal de diagnóstico directo (12, 14 y
15) devuelven un valor conservador: ninguna libera ni borra un resultado.
