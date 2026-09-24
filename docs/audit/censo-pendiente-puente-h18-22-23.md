# Censo pendiente del puente H18.22/H18.23: propuesta sin aplicar

Árbol: `tyrian-companion`, rama `worktree-agent-a2bec5b20187e278a`, base `a2584af`. El baseline
`scripts/action-observability-baseline.json` está **exactamente** como en `a2584af` (la revisión
`449fe57` se revirtió). Por eso `node scripts/action-observability-census.mjs` da rojo con 15
entradas: es lo esperado hasta que David revise esta propuesta. **No se ha aplicado nada.**

Las líneas son las del árbol actual; las «quitadas» llevan la línea que tenían en el baseline de
`a2584af`. El `id` es el hash AST que calcula el censo (ruta, tipo, registro, ancestros, texto del
nodo): por eso una frontera cuyo texto cambia aparece como una quitada y una añadida, aunque sea la
misma frontera.

## Las 15 entradas

| # | Fichero | Hallazgo del censo | Frontera (kind, scope, línea) | `id` | Clasificación propuesta | Justificación literal propuesta |
|---|---|---|---|---|---|---|
| 1 | `src/alerts/alert-ingame-presence.ts` | `new_production_file` | `catch_clause`, `notify`, 382 | `6da8c0796ace3df9d04b610581a383064a8bb9e2` | `allowlisted`, `reviewed_recovery`, behavior `local_recovery` | The \"notify\" owner applies \"local_recovery\" to one presence subscriber that threw: it hands the error to the injected recordObserverFailure, which main.ts turns into a notification_emit failure record, and keeps delivering the same event to the remaining subscribers. |
| 2 | `src/alerts/alert-ingame-protocol.ts` | `new_production_file` | `catch_clause`, `decodeIngameFrame`, 131 | `4d06b4953ae28d69e118bd2f051f7d43d2c84c75` | `allowlisted`, `reviewed_recovery`, behavior `fallback_return` | The \"decodeIngameFrame\" owner turns a JSON.parse failure on an untrusted addon frame into a typed \"fallback_return\" of frame_json; the server answers that code with an error line and closes the connection, so nothing is swallowed. |
| 3 | `src/alerts/alert-ingame-server.ts` | `callback_registration (added)` | `on` (`data`), `attachClient`, 228 | `5a95c8e773423a1695eddfc3d77a18f341b4f45e` | `allowlisted`, `reviewed_registered_callback`, registration `on` | The \"attachClient\" owner registers \"on\" for a sockets own lifecycle: framing and validating its hello and sequenced frames, its close and its error. None of the three can throw past nodes event dispatch; a protocol violation ends in a typed error line and a close, and the error listener stops node raising an unhandled exception on a mid-write disconnect. |
| 4 | `src/alerts/alert-ingame-server.ts` | `callback_registration (added)` | `on` (`close`), `attachClient`, 229 | `0e55d45fd98f03c200a2f82ac2ec5a299e4af597` | `allowlisted`, `reviewed_registered_callback`, registration `on` | Igual que la fila 3 (misma justificación, literal). |
| 5 | `src/alerts/alert-ingame-server.ts` | `callback_registration (added)` | `on` (`error`), `attachClient`, 230 | `386bc241fb74f99e44aac8f54df24057ee5eb2eb` | `allowlisted`, `reviewed_registered_callback`, registration `on` | Igual que la fila 3 (misma justificación, literal). |
| 6 | `src/alerts/alert-ingame-server.ts` | `callback_registration (removed)` | `on` (`data`, lectura de un solo `hello`), `attachClient`, 164 en `a2584af` | `c44b3376d9be82a54db0fc7b88032eb4fe807155` | Se elimina del baseline: su nodo ya no existe; la sustituye la fila 3 | — (la frontera desaparece; su decisión anterior era `allowlisted` con registro `on` en `attachClient`) |
| 7 | `src/alerts/alert-ingame-server.ts` | `callback_registration (removed)` | `on` (`close`), `attachClient`, 178 en `a2584af` | `83ba4e890f4fb84a97a0555e60933d8b14a3c14d` | Se elimina; la sustituye la fila 4 | — |
| 8 | `src/alerts/alert-ingame-server.ts` | `callback_registration (removed)` | `on` (`error`), `attachClient`, 179 en `a2584af` | `b1ff76cdabf6d7a50ff0fd23ae030a98f0f0013c` | Se elimina; la sustituye la fila 5 | — |
| 9 | `src/main.ts` | `callback_registration (added)` | `then`, `ensureAlertIngameServer`, 2587 | `2688de96ed4e8cf423a2433790f863df292dce73` | `allowlisted`, `reviewed_registered_callback`, registration `then` (decisión de la fila 12, sin cambios) | The \"ensureAlertIngameServer\" owner registers \"then\" only to record the newly started server and the port it bound, which cannot itself fail; a failed start is caught by the sibling catch on the same chain. |
| 10 | `src/main.ts` | `promise_catch (added)` | `catch`, `ensureAlertIngameServer`, 2587 | `03f70434e05f1208403e1f883089747e53d312f0` | `observed`, callee `this.localDebugActions.event` (decisión de la fila 13, sin cambios; el AST sigue viendo esa llamada) | — (una decisión `observed` no lleva justificación; su razón generada es: Direct observability call "this.localDebugActions.event" is present inside this promise_catch boundary.) |
| 11 | `src/main.ts` | `callback_registration (added)` | `finally`, `ensureAlertIngameServer`, 2587 | `8a9c3a82bdf3607d13885cc43fd9dc4676e74be1` | `allowlisted`, `reviewed_registered_callback`, registration `finally` (decisión de la fila 14, sin cambios) | The \"ensureAlertIngameServer\" owner registers \"finally\" only to clear its own in-flight slot so a later alert can retry; it performs no I/O and cannot fail on its own. |
| 12 | `src/main.ts` | `callback_registration (removed)` | `then`, `ensureAlertIngameServer`, 2567 en `a2584af` | `2eb9a4c3fdb7bdd53a739176efe0b5bedec05419` | Se elimina; la sustituye la fila 9 | — |
| 13 | `src/main.ts` | `promise_catch (removed)` | `catch`, `ensureAlertIngameServer`, 2567 en `a2584af` | `4759c1778049e9321bddc392b9826827fde695a8` | Se elimina; la sustituye la fila 10 | — |
| 14 | `src/main.ts` | `callback_registration (removed)` | `finally`, `ensureAlertIngameServer`, 2567 en `a2584af` | `67bf5ad1976fb0c4ecf348ca79a9c704a4c45dda` | Se elimina; la sustituye la fila 11 | — |
| 15 | `src/ui/settings-tab.ts` | `catch_clause (added)` | `catch_clause`, `render` (botón «Copiar token»), 908 | `eb533c800eabc8d12da19019e34a0e7c7a30e0ca` | `allowlisted`, `reviewed_recovery`, behavior `local_recovery` | The \"render\" owner applies \"local_recovery\" when copying the in-game bridge secret fails: it shows the failure in the row feedback with role alert, and copyAlertIngameSecret already records the failure through localDebugActions.run. |

Las justificaciones están escritas tal como irían en el JSON, con las comillas escapadas (`\"`).
Cada una cumple `isSpecificAllowlistJustification`: entre 48 y 480 caracteres y contiene
`"<scope>"` y `"<discriminador>"`. La `reason` de cada frontera no se escribe a mano:
`decisionReason()` la deriva de la evidencia y el censo exige que coincida.

Por qué cambian las de `main.ts` (filas 9 a 14): la llamada `startAlertIngameServer(...)` al principio
de la cadena `.then().catch().finally()` recibe ahora un temporizador con `cancel` y las opciones del
puente. Esa llamada forma parte del texto del nodo de las tres fronteras, así que les cambia el `id`,
aunque el cuerpo de los tres callbacks no ha cambiado. Por eso la propuesta arrastra las tres
decisiones tal cual.

Totales si se aplicara: `catch_clause` pasa de 442 a 445 (filas 1, 2 y 15);
`callback_registration` (159), `promise_catch` (36) y `void_expression` (82) no cambian, porque las
altas y bajas se compensan.

## El uso de `--refresh-locations`

En `449fe57` (ya revertido) apliqué estas decisiones así:

1. Edité a mano el JSON: cambié los `id` de las filas 6-8 y 12-14 por los de las filas 3-5 y 9-11,
   reescribí la justificación de las tres `on` del servidor, añadí las entradas de los dos ficheros
   nuevos y la de `settings-tab.ts`, y subí `totals.catch_clause` a 445.
2. Ejecuté `node scripts/action-observability-census.mjs --refresh-locations`.
3. Verifiqué con `node scripts/action-observability-census.mjs`, que dio PASS.

`--refresh-locations` no es `--write-baseline`. Solo reescribe los campos de posición `line`,
`column`, `endLine` y `endColumn` de las fronteras que ya están en el baseline, emparejándolas por
`id`, y reordena cada fichero por posición. No crea fronteras, no borra ninguna y no toca
`classification`, `evidence` ni `reason`. El censo verifica por `id` y por decisión, no por línea, así
que las posiciones solo son informativas. Aun así el comando tocó muchas fronteras de `main.ts` y
`settings-tab.ts` que no son mías, solo porque mis líneas nuevas desplazaron las siguientes. En
`449fe57` eso son unas 300 líneas del JSON con cambios solo de posición. Si David prefiere un diff
mínimo, se puede probar a omitir el paso 2. No lo he medido: `validateBaseline` comprueba además
el orden de las fronteras de cada fichero por su posición guardada, así que las entradas nuevas
tendrían que quedar en un orden coherente con las posiciones antiguas de sus vecinas.
