## Formato 1: 10800 muestras (3.0 h), 158 con cambio (1.46 %), 10801 entradas en el diario (2.2 MiB de JSON), Node v22.23.1, carga de la máquina al empezar 17.00 10.67 4.75

A. arrancar (LiveSessionLifecycle.initialize): mediana 51 ms (mín 49, máx 61, n=7); 1.ª repetición 55 ms
B. cerrar y guardar la nota (stop + SessionNoteWriter.writeLive): mediana 291 ms (mín 255, máx 324, n=7); 1.ª repetición 324 ms; nota de 1.68 MiB

### Perfil A, formato 1 (5 repeticiones perfiladas, 51 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 60.6 % | 60.9 % |
| 2 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 19.3 % | 21.8 % |
| 3 | `(garbage collector)` | (native) | 11.0 % | 11.0 % |
| 4 | `readLiveJournal` | src/sessions/session-runtime-store.ts:213 | 1.4 % | 58.7 % |
| 5 | `valueLiveTotals` | src/sessions/live-session-reducer.ts:253 | 1.3 % | 1.3 % |
| 6 | `refreshRecovery` | src/sessions/live-session-lifecycle.ts:660 | 1.1 % | 32.6 % |
| 7 | `initializeRecord` | src/sessions/live-session-lifecycle.ts:180 | 0.7 % | 32.3 % |
| 8 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 0.7 % | 2.7 % |
| 9 | `keys2` | src/sessions/live-session-reducer.ts:306 | 0.5 % | 0.5 % |
| 10 | `post` | node:inspector | 0.4 % | 0.5 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 60.6 % | 60.9 % |
| 2 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.1 % | 60.8 % |
| 3 | `readLiveJournal` | src/sessions/session-runtime-store.ts:213 | 1.4 % | 58.7 % |
| 4 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 58.7 % |
| 5 | `readLiveJournal` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 58.7 % |
| 6 | `refreshRecovery` | src/sessions/live-session-lifecycle.ts:660 | 1.1 % | 32.6 % |
| 7 | `initializeRecord` | src/sessions/live-session-lifecycle.ts:180 | 0.7 % | 32.3 % |
| 8 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 19.3 % | 21.8 % |
| 9 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 0.7 % | 2.7 % |
| 10 | `rebuildChart` | src/sessions/live-session-lifecycle.ts:905 | 0.0 % | 2.7 % |

### Perfil B, formato 1 (5 repeticiones perfiladas, 280 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 30.1 % | 38.1 % |
| 2 | `keys2` | src/sessions/live-session-reducer.ts:306 | 9.3 % | 9.3 % |
| 3 | `(garbage collector)` | (native) | 9.0 % | 9.0 % |
| 4 | `date` | src/sessions/live-session-reducer.ts:309 | 8.0 % | 8.0 % |
| 5 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 7.9 % | 36.6 % |
| 6 | `structuredClone` | node:internal/worker/js_transferable | 6.7 % | 6.7 % |
| 7 | `validPublicLiveSession` | src/sessions/live-session-note-model.ts:206 | 4.5 % | 19.3 % |
| 8 | `stopInternal` | src/sessions/live-session-lifecycle.ts:429 | 3.8 % | 11.5 % |
| 9 | `inspectLiveSessionNote` | src/sessions/live-session-note-renderer.ts:128 | 2.8 % | 22.0 % |
| 10 | `onComplete` | src/sessions/live-session-lifecycle.ts:979 | 1.8 % | 2.3 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 30.1 % | 38.1 % |
| 2 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 7.9 % | 36.6 % |
| 3 | `inspectLiveSessionNote` | src/sessions/live-session-note-renderer.ts:128 | 2.8 % | 22.0 % |
| 4 | `isStoredLiveSessionPayload` | src/sessions/live-session-note-model.ts:198 | 0.4 % | 19.7 % |
| 5 | `validPublicLiveSession` | src/sessions/live-session-note-model.ts:206 | 4.5 % | 19.3 % |
| 6 | `renderLiveSessionNote` | src/sessions/live-session-note-renderer.ts:16 | 0.4 % | 12.5 % |
| 7 | `stopInternal` | src/sessions/live-session-lifecycle.ts:429 | 3.8 % | 11.5 % |
| 8 | `(anonymous)` | src/sessions/session-note-writer.ts:63 | 0.6 % | 11.0 % |
| 9 | `prepareLiveSessionPayload` | src/sessions/live-session-note-model.ts:89 | 0.0 % | 10.6 % |
| 10 | `writeLive` | src/sessions/session-note-writer.ts:56 | 0.0 % | 10.5 % |
