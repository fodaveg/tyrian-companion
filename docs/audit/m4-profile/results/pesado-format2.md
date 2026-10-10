## Formato 2: 10800 muestras (3.0 h), 5417 con cambio (50.16 %), 5418 entradas en el diario (18.5 MiB de JSON), Node v22.23.1, carga de la máquina al empezar 4.31 2.67 1.46

A. arrancar (LiveSessionLifecycle.initialize): mediana 1294 ms (mín 522, máx 1505, n=7); 1.ª repetición 522 ms
B. cerrar y guardar la nota (stop + SessionNoteWriter.writeLive): mediana 13757 ms (mín 6227, máx 14479, n=7); 1.ª repetición 6227 ms; nota de 21.33 MiB

### Perfil A, formato 2 (5 repeticiones perfiladas, 543 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 58.9 % | 60.4 % |
| 2 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 10.8 % | 36.7 % |
| 3 | `valueLiveTotals` | src/sessions/live-session-reducer.ts:253 | 10.8 % | 10.8 % |
| 4 | `(garbage collector)` | (native) | 9.6 % | 9.6 % |
| 5 | `accumulateLiveTotals` | src/sessions/live-session-reducer.ts:99 | 2.2 % | 2.2 % |
| 6 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 1.8 % | 15.7 % |
| 7 | `push` | src/sessions/live-session-reducer.ts:159 | 1.6 % | 12.9 % |
| 8 | `structuredClone` | (native) | 1.4 % | 1.4 % |
| 9 | `settleLiveAlertRestart` | src/sessions/live-session-outbox.ts:27 | 0.5 % | 9.4 % |
| 10 | `liveChartPoint` | src/sessions/live-session-reducer.ts:127 | 0.3 % | 11.1 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 58.9 % | 60.4 % |
| 2 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 10.8 % | 36.7 % |
| 3 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.0 % | 35.2 % |
| 4 | `readLiveJournal` | src/sessions/session-runtime-store.ts:213 | 0.0 % | 34.3 % |
| 5 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 34.3 % |
| 6 | `readLiveJournal` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 34.3 % |
| 7 | `refreshRecovery` | src/sessions/live-session-lifecycle.ts:660 | 0.3 % | 26.4 % |
| 8 | `initializeRecord` | src/sessions/live-session-lifecycle.ts:180 | 0.3 % | 26.1 % |
| 9 | `rebuildChart` | src/sessions/live-session-lifecycle.ts:905 | 0.1 % | 15.8 % |
| 10 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 1.8 % | 15.7 % |

### Perfil B, formato 2 (5 repeticiones perfiladas, 6411 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `keys2` | src/sessions/live-session-reducer.ts:306 | 34.2 % | 34.2 % |
| 2 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 12.0 % | 16.8 % |
| 3 | `(garbage collector)` | (native) | 9.9 % | 9.9 % |
| 4 | `date` | src/sessions/live-session-reducer.ts:309 | 6.4 % | 6.4 % |
| 5 | `isLiveSessionRuntimeRecord` | src/sessions/live-session-validation.ts:10 | 5.2 % | 33.2 % |
| 6 | `structuredClone` | node:internal/worker/js_transferable | 3.6 % | 3.7 % |
| 7 | `sha256Utf8` | src/core/canonical-sha256.ts:34 | 3.6 % | 4.6 % |
| 8 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 3.2 % | 15.9 % |
| 9 | `replaceLiveJournal` | src/sessions/session-runtime-store.ts:223 | 2.6 % | 51.5 % |
| 10 | `encode` | node:internal/encoding | 1.4 % | 2.2 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `stopInternal` | src/sessions/live-session-lifecycle.ts:429 | 1.2 % | 53.6 % |
| 2 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.0 % | 52.4 % |
| 3 | `replaceLiveJournal` | src/sessions/live-session-lifecycle.ts:947 | 0.0 % | 52.3 % |
| 4 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:947 | 0.1 % | 51.6 % |
| 5 | `replaceLiveJournal` | src/sessions/session-runtime-store.ts:223 | 2.6 % | 51.5 % |
| 6 | `keys2` | src/sessions/live-session-reducer.ts:306 | 34.2 % | 34.2 % |
| 7 | `isLiveSessionRuntimeRecord` | src/sessions/live-session-validation.ts:10 | 5.2 % | 33.2 % |
| 8 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 12.0 % | 16.8 % |
| 9 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 3.2 % | 15.9 % |
| 10 | `isLiveJournalEntry` | src/sessions/live-session-validation.ts:80 | 0.3 % | 12.7 % |
