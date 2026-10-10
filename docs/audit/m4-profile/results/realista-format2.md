## Formato 2: 10800 muestras (3.0 h), 158 con cambio (1.46 %), 159 entradas en el diario (0.1 MiB de JSON), Node v22.23.1, carga de la máquina al empezar 15.23 10.50 4.76

A. arrancar (LiveSessionLifecycle.initialize): mediana 6 ms (mín 5, máx 8, n=7); 1.ª repetición 8 ms
B. cerrar y guardar la nota (stop + SessionNoteWriter.writeLive): mediana 40 ms (mín 36, máx 64, n=7); 1.ª repetición 64 ms; nota de 0.15 MiB

### Perfil A, formato 2 (5 repeticiones perfiladas, 6 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 48.9 % | 50.5 % |
| 2 | `valueLiveTotals` | src/sessions/live-session-reducer.ts:253 | 11.5 % | 11.5 % |
| 3 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 7.3 % | 26.1 % |
| 4 | `post` | node:inspector | 4.4 % | 5.1 % |
| 5 | `keys2` | src/sessions/live-session-reducer.ts:306 | 4.2 % | 4.2 % |
| 6 | `(garbage collector)` | (native) | 3.8 % | 3.8 % |
| 7 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 2.1 % | 16.8 % |
| 8 | `liveChartPoint` | src/sessions/live-session-reducer.ts:127 | 1.6 % | 13.1 % |
| 9 | `date` | src/sessions/live-session-reducer.ts:309 | 1.6 % | 1.6 % |
| 10 | `structuredClone` | (native) | 1.6 % | 1.6 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `structuredClone` | node:internal/worker/js_transferable | 48.9 % | 50.5 % |
| 2 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.0 % | 37.8 % |
| 3 | `initializeRecord` | src/sessions/live-session-lifecycle.ts:180 | 0.0 % | 27.9 % |
| 4 | `settleRecovery` | src/sessions/live-session-lifecycle.ts:670 | 7.3 % | 26.1 % |
| 5 | `readLiveJournal` | src/sessions/live-session-lifecycle.ts:945 | 0.0 % | 25.2 % |
| 6 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:945 | 0.5 % | 24.6 % |
| 7 | `readLiveJournal` | src/sessions/session-runtime-store.ts:213 | 0.9 % | 24.1 % |
| 8 | `refreshRecovery` | src/sessions/live-session-lifecycle.ts:660 | 1.0 % | 23.5 % |
| 9 | `createLiveChart` | src/sessions/live-session-reducer.ts:207 | 2.1 % | 16.8 % |
| 10 | `rebuildChart` | src/sessions/live-session-lifecycle.ts:905 | 0.0 % | 16.8 % |

### Perfil B, formato 2 (5 repeticiones perfiladas, 42 ms muestreados por repetición con el perfilador encendido)

Top 10 por tiempo propio (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `keys2` | src/sessions/live-session-reducer.ts:306 | 21.1 % | 21.1 % |
| 2 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 13.2 % | 20.3 % |
| 3 | `date` | src/sessions/live-session-reducer.ts:309 | 7.4 % | 7.4 % |
| 4 | `structuredClone` | node:internal/worker/js_transferable | 6.3 % | 7.2 % |
| 5 | `(garbage collector)` | (native) | 4.5 % | 4.5 % |
| 6 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 4.5 % | 18.4 % |
| 7 | `sha256Utf8` | src/core/canonical-sha256.ts:34 | 3.9 % | 5.6 % |
| 8 | `replaceLiveJournal` | src/sessions/session-runtime-store.ts:223 | 2.9 % | 39.9 % |
| 9 | `isLiveSessionRuntimeRecord` | src/sessions/live-session-validation.ts:10 | 2.1 % | 18.2 % |
| 10 | `stopInternal` | src/sessions/live-session-lifecycle.ts:429 | 2.1 % | 45.2 % |

Top 10 por tiempo acumulado (sin la raíz del programa) (porcentaje del tiempo muestreado)
| # | función | fichero:línea | propio | acumulado |
|--:|---|---|--:|--:|
| 1 | `stopInternal` | src/sessions/live-session-lifecycle.ts:429 | 2.1 % | 45.2 % |
| 2 | `bounded` | src/sessions/storage-deadline.ts:66 | 0.1 % | 43.2 % |
| 3 | `replaceLiveJournal` | src/sessions/live-session-lifecycle.ts:947 | 0.2 % | 42.2 % |
| 4 | `(anonymous)` | src/sessions/live-session-lifecycle.ts:947 | 0.1 % | 40.1 % |
| 5 | `replaceLiveJournal` | src/sessions/session-runtime-store.ts:223 | 2.9 % | 39.9 % |
| 6 | `keys2` | src/sessions/live-session-reducer.ts:306 | 21.1 % | 21.1 % |
| 7 | `canonicalJson` | src/core/canonical-sha256.ts:17 | 13.2 % | 20.3 % |
| 8 | `(anonymous)` | src/core/canonical-sha256.ts:20 | 4.5 % | 18.4 % |
| 9 | `isLiveSessionRuntimeRecord` | src/sessions/live-session-validation.ts:10 | 2.1 % | 18.2 % |
| 10 | `inspectLiveSessionNote` | src/sessions/live-session-note-renderer.ts:128 | 1.6 % | 13.9 % |
