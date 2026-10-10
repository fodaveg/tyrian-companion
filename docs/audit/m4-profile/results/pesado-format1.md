## Formato 1: 10800 muestras (3.0 h), 5417 con cambio (50.16 %), 10801 entradas en el diario (19.5 MiB de JSON), Node v22.23.1, carga de la máquina al empezar 2.61 1.82 1.04

A. arrancar (LiveSessionLifecycle.initialize): mediana 528 ms (mín 480, máx 607, n=7); 1.ª repetición 535 ms
B. cerrar y guardar la nota (stop + SessionNoteWriter.writeLive): mediana 5794 ms (mín 5708, máx 6293, n=7); 1.ª repetición 5794 ms; nota de 22.10 MiB

### Perfil A, formato 1 (5 repeticiones perfiladas, 562 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 59.7 % | 61.1 % |
| 2 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 11.3 % | 35.5 % |
| 3 | `valueLiveTotals` | src/sessions/live-session-reducer.ts:253 | 10.0 % | 10.0 % |
| 4 | `(garbage collector)` | (native) | 9.2 % | 9.2 % |
| 5 | `accumulateLiveTotals` | src/sessions/live-session-reducer.ts:99 | 2.1 % | 2.1 % |
| 6 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 1.9 % | 14.9 % |
| 7 | `push` | src/sessions/live-session-reducer.ts:159 | 1.7 % | 12.2 % |
| 8 | `structuredClone` | (native) | 1.4 % | 1.4 % |
| 9 | `settleLiveAlertRestart` | src/sessions/live-session-outbox.ts:27 | 0.4 % | 8.7 % |
| 10 | `liveChartPoint` | src/sessions/live-session-reducer.ts:127 | 0.3 % | 10.3 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 59.7 % | 61.1 % |
| 2 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.0 % | 37.6 % |
| 3 | `readLiveJournal` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 36.7 % |
| 4 | `readLiveJournal` | src/sessions/session-runtime-store.ts:213 | 0.1 % | 36.7 % |
| 5 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 36.7 % |
| 6 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 11.3 % | 35.5 % |
| 7 | `initializeRecord` | src/sessions/live-session-lifecycle.ts:180 | 0.3 % | 27.2 % |
| 8 | `refreshRecovery` | src/sessions/live-session-lifecycle.ts:660 | 0.3 % | 27.1 % |
| 9 | `rebuildChart` | src/sessions/live-session-lifecycle.ts:905 | 0.1 % | 15.0 % |
| 10 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 1.9 % | 14.9 % |

### Perfil B, formato 1 (5 repeticiones perfiladas, 6312 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `keys2` | src/sessions/live-session-reducer.ts:306 | 33.6 % | 33.6 % |
| 2 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 13.8 % | 17.6 % |
| 3 | `(garbage collector)` | (native) | 9.5 % | 9.5 % |
| 4 | `date` | src/sessions/live-session-reducer.ts:309 | 6.2 % | 6.2 % |
| 5 | `isLiveSessionRuntimeRecord` | src/sessions/live-session-validation.ts:10 | 5.2 % | 32.6 % |
| 6 | `structuredClone` | node:internal/worker/js_transferable | 3.7 % | 3.9 % |
| 7 | `sha256Utf8` | src/core/canonical-sha256.ts:34 | 3.5 % | 4.4 % |
| 8 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 3.4 % | 16.7 % |
| 9 | `replaceLiveJournal` | src/sessions/session-runtime-store.ts:223 | 2.6 % | 50.4 % |
| 10 | `encode` | node:internal/encoding | 1.5 % | 2.3 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `stopInternal` | src/sessions/live-session-lifecycle.ts:429 | 1.3 % | 52.4 % |
| 2 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.0 % | 51.1 % |
| 3 | `replaceLiveJournal` | src/sessions/live-session-lifecycle.ts:947 | 0.0 % | 51.0 % |
| 4 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:947 | 0.0 % | 50.4 % |
| 5 | `replaceLiveJournal` | src/sessions/session-runtime-store.ts:223 | 2.6 % | 50.4 % |
| 6 | `keys2` | src/sessions/live-session-reducer.ts:306 | 33.6 % | 33.6 % |
| 7 | `isLiveSessionRuntimeRecord` | src/sessions/live-session-validation.ts:10 | 5.2 % | 32.6 % |
| 8 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 13.8 % | 17.6 % |
| 9 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 3.4 % | 16.7 % |
| 10 | `isLiveJournalEntry` | src/sessions/live-session-validation.ts:80 | 0.2 % | 12.3 % |
