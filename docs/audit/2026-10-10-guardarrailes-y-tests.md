# Audit 2 de 5: red de guardarraíles y tests de Tyrian Companion

- Fecha: 2026-10-10
- SHA: `6fbe77e` (`main`, árbol limpio al empezar y al terminar; no se ha modificado nada del repo)
- Máquina: Mac (Darwin), Node del sistema; las cifras del gate citadas son de Fedora, sacadas de `docs/ESTADO.md` y de los logs de `docs/audit/2026-10-02-h18-29-fix-evidence/`.
- Alcance: `scripts/run-gate.mjs`, `scripts/gate-steps.mjs`, `vitest.config.mts`, `vitest.guardrails.config.mts`, `eslint.config.mts` (solo lo que toca a tests), `.github/workflows/ci.yml` y `release.yml`, `package.json`, `scripts/tests/probar-*`, `src/test/`, los `src/main*.test.ts`, y un barrido de patrones de tiempo sobre los 375 `*.test.ts`.
- Fuera de alcance: código de producto salvo lo necesario para entender un test; el stack H8/Mumble de `src/platform` y la detección asistida se quedan (premisa cerrada) y aquí solo se habla de cómo se prueban.

## Comandos ejecutados

- Lectura: `cat -n`/`sed -n` de los ficheros citados, `git show a734137`, `git log -S'happy-dom' -- package.json`.
- Búsqueda: `rg` sobre `src/**/*.test.ts` y `scripts/` (patrones de `setTimeout`, `Date.now`, `performance.now`, `vi.useFakeTimers`, bucles de turnos, `await Promise.resolve()` encadenados, `vi.waitFor`, `readFileSync`, `readModuleSource`, `.skipIf/.runIf`).
- Conteo con dos scripts de `node` en el scratchpad (`scan.mjs`: patrones de tiempo por fichero; `cov.mjs`: qué fuentes importa algún test, directa y transitivamente).
- `node -e 'import("./scripts/gate-steps.mjs")…'` para listar los pasos de cada grupo.
- Vitest, uno a uno y con `--maxWorkers=1` (4 ficheros, 5 corridas):
  - `src/main-deferred-runtime-startup.test.ts`: «Tests 15 passed (15)», «Duration 2.09s».
  - el mismo con `TYRIAN_TEST_ENGINE_LATENCY_MS=30`: «Tests 15 passed (15)», «Duration 3.03s».
  - `src/main-collector-mode.test.ts`: «Tests 17 passed (17)», «Duration 2.05s».
  - `src/host/hebra/hebra-main-view-runtime.test.ts` (dos veces): «Error: Cannot find package 'happy-dom'», «Tests no tests». Es el `node_modules` local del Mac, no el repo (ver GR-16).
- No se ha corrido `npm run check`, `check:guardrails`, la suite completa, `tsc` ni ningún build.

## 1. Qué corre cada entrada

`scripts/gate-steps.mjs` define 30 pasos y tres grupos. Medido con `stepsForGroup`:

- `check` (8): `lint`, `typecheck`, `unit`, `security-scan`, `action-observability-census`, `i18n-unused`, `bundle`, `host-esm`. En ese orden: `unit` va tercero y `host-esm` (que genera `hebra-main.mjs`) va octavo.
- `check:guardrails` (25): `unit-guardrails` (vitest con `vitest.guardrails.config.mts`: `src/platform/**` y los 17 ficheros congelados de `scripts/source-text-assertion-allowlist.json`), `h8-crossover-spike`, y 23 pasos de `scripts/tests/probar-*` o contratos sobre el árbol.
- `test` (28): `unit`, `unit-guardrails` y todas las suites `probar-*`, sin `lint`, `typecheck`, `bundle` ni `host-esm`. Ningún workflow lo usa.
- `probar-run-gate.mjs:161-175` comprueba que `check` y `check:guardrails` cubren entre los dos cada paso de `test` sin solaparse. Los dos `vitest.*.mts` leen el mismo JSON, así que el reparto de ficheros de test es consistente por construcción.

CI (`.github/workflows/ci.yml`, Node `24.12.0`): job `check` (`npm run check` y, solo en `main`, los cuatro `bench:h6-*`), job `check-guardrails` (`npm run check:guardrails`), Rust solo si cambia `native/mumble-helper`, y `release-package` (`release:package` y `beta:artifact`) si los dos anteriores salen bien.

Release (`.github/workflows/release.yml`, Node `22.20.0`, en push de etiqueta): `npm run check`, `release:package`, `brat-release-plan.mjs --from-staging`, `brat-release-contract.mjs` sobre el plan, comparación etiqueta/manifest, `changelog-entry.mjs`, `gh release create` y otra vez el contrato contra lo publicado. No corre `check:guardrails` ni espera al CI del mismo commit.

### Tabla de scripts de `package.json`

| script | gate `check` | guardrails | CI | release | nadie (manual) |
|---|---|---|---|---|---|
| `test` (grupo `test`) | | | | | sí |
| `test:host-esm` | | sí (`host-esm-suite`) | sí | | |
| `test:h8-crossover-spike` | | sí | sí | | |
| `test:bench:h6-performance-red` | | | solo `main` | | |
| `bench:h6-performance`, `bench:h6-live-session`, `bench:h6-live-session-red` | | | solo `main` | | |
| `test:release-preflight` | | sí | sí | | |
| `test:brat-release-contract` | | sí | sí | | |
| `test:security-scan` | | sí | sí | | |
| `test:action-observability` | censo sí | suite sí | sí | censo sí | |
| `test:release-package` | | sí | sí | | |
| `test:release-identity-contract` | | sí | sí | vía `release:package` | |
| `test:beta-channel` | | sí | sí | | |
| `test:beta-runtime` | | sí (`.sh`, que lanza `probar-beta-runtime.mjs`) | sí | | |
| `test:support-contract` | | sí | sí | | |
| `test:h8-helper-decision-contract` | | sí | sí | | |
| `test:source-text-assertion-contract` | | sí | sí | | |
| `test:run-gate` | | sí | sí | | |
| `test:brat-release-plan` | | sí | sí | | |
| `test:release-workflow` | | sí | sí | | |
| `test:dev-install`, `test:smoke-live`, `test:record-api-fixtures`, `test:i18n-unused`, `test:changelog-entry` | | sí | sí | | |
| `security:scan` | sí | | sí | sí | |
| `source-text:assertion-contract` | | sí | sí | | |
| `h8:helper-decision-contract` | | contenido en su suite | sí | | |
| `i18n:unused` | sí | | sí | sí | |
| `release:preflight` | | solo su suite | | | sí (sobre el árbol real) |
| `release:workflow-contract` | | contenido en `probar-release-workflow` | sí | | |
| `release:identity-contract` | | | `release-package` | sí | |
| `release:package` | | | sí (push) | sí | |
| `release:brat-plan`, `release:brat-verify` | | | | el workflow llama a los `.mjs` directamente | `brat-verify`, tras publicar |
| `beta:artifact` | | | sí | | |
| `beta:install`, `beta:verify-runtime`, `dev:install`, `smoke:live`, `record:api-fixtures` | | | | | sí (necesitan Obsidian o red) |

Sin script en `package.json` y sin nadie que los llame (`rg` sin referencias fuera de docs o de su propio test): `scripts/benchmark-inventory-vault-sync.ts`, `scripts/refresh-sell-timing-fixture.ts`, `scripts/reindex-action-observability-baseline.mjs`, `scripts/generate-published-base-hashes.ts`, `scripts/recompute-bundle-hashes.ts`. El paso `i18n-copy-length` existe en el gate pero no tiene script `npm`. Ver GR-12.

## 2. Hallazgos

### Alto

#### GR-01. El único test que arranca el `hebra-main.mjs` publicado no corre nunca en CI ni en release, y en local prueba un bundle viejo
- Evidencia:
  - `src/host/hebra/bundle.test.ts:12-19`: «the gate builds it before the tests … Skipped when not built» y `describe.runIf(existsSync(BUNDLE))`.
  - `scripts/gate-steps.mjs:37` (`unit`, paso 3 de `check`) frente a `:68` (`host-esm`, paso 8). El gate no construye el bundle antes de los tests: el comentario es falso.
  - `.gitignore`: `/hebra-main.mjs`. En un checkout limpio de GitHub el fichero no existe.
  - `docs/ESTADO.md:15`: el CI de la 0.6.23 dio «Tests 2 failed | 5879 passed | 1 skipped (5882)»; el gate local dio «Tests 5882 passed (5882)». El test saltado en GitHub es este: es el único `runIf`/`skipIf` de `src` (`rg "\.skipIf|\.runIf|it\.skip"`).
  - En local se ejecuta contra el `hebra-main.mjs` que dejó el build anterior, no contra el árbol que se está midiendo.
- Por qué importa: es la única prueba que carga el artefacto que descarga Hebra y arranca el core real dentro (`activate`, vistas, comandos, ajustes, cero escrituras en consulta). `src/host/hebra/entry.ts` no lo importa ningún otro test (ver GR-05).
- Acción: sacar `bundle.test.ts` del paso `unit` y correrlo en un paso propio después de `host-esm` (por ejemplo, `vitest run src/host/hebra/bundle.test.ts` como paso 9 de `check`), y que falle en vez de saltarse cuando falta el bundle. Arreglar el comentario. Coste: 1 a 2 h.

#### GR-02. La release publica habiendo pasado solo `check`: sin guardarraíles y sin depender del CI del mismo commit
- Evidencia:
  - `.github/workflows/release.yml:41-42`: único gate, `npm run check`. No aparece `check:guardrails` en ese fichero.
  - `release.yml:12-14`: se dispara por etiqueta, sin `needs` sobre `ci.yml`; `ci.yml:3-7` explica que el push de etiqueta ya no lanza el CI.
  - Lo que queda fuera de la release: los 17 ficheros congelados (entre ellos 39 tests de comportamiento de `src/ui/settings-tab.test.ts` y 19 de `src/ui/companion-status-model.test.ts`, ver GR-04), todo `src/platform`, y los contratos de release, BRAT, soporte, identidad e i18n de longitud.
  - `docs/ESTADO.md:23-24`: para la 0.6.24 el integrador comprobó a mano el CI verde de `a734137` y `32b5a43` antes de etiquetar. La garantía es de procedimiento, no del workflow.
- Acción: añadir `npm run check:guardrails` al job `publish` de `release.yml` antes de `release:package` (la última cifra anotada, 2 oct, da unos 14 s de suma de pasos en `guardrails-final.log:179-203`). `probar-release-workflow.mjs` ya exige que el gate preceda a la publicación; habría que ampliar ese contrato para que exija también los guardarraíles. Coste: 1 h.

#### GR-03. Quedan esperas de tiempo fijo de la misma familia que tumbó la 0.6.23, y la palanca del «motor lento a propósito» no la usa nadie
- Evidencia, esperas reales de duración fija tras las que se afirma algo positivo:
  - `src/host/hebra/hebra-main-view-runtime.test.ts:84-85`: «The boot's fire-and-forget work (IndexedDB, the first reads) settles first.» y `window.setTimeout(resolve, 50)`.
  - `src/host/hebra/hebra-live-session-note.test.ts:273` (50 ms tras `whenRuntimeReady`, y después `expect(live.runtimeReady).toBe(true)`), `:111` (50 ms antes de afirmar que no se recrea la nota).
  - `src/host/hebra/hebra-consult-manual-actions.test.ts:110` (50 ms).
  - `src/main-collector-mode.test.ts:529-531`: `settle()` son 5 vueltas de `setTimeout(0)` «Drains the fire-and-forget work the boot leaves behind (IndexedDB and the first heartbeat)». El propio fichero, en `:520-522`, dice «A fixed number of `settle` rounds is not enough under load: the job can land after them». Se usa 22 veces; por ejemplo `:184-186` afirma `compactAndPrune` llamado justo después.
  - `src/runtime/live-session-entities-restored.test.ts:129`: `settle` = 20 microtareas y un `setTimeout(0)`.
  - `src/main-deferred-runtime-startup.test.ts:445-448`: «a macrotask boundary is enough to drain them».
- Evidencia, la palanca de latencia:
  - `src/test/indexed-db-connections.ts:33`: `TYRIAN_TEST_ENGINE_LATENCY_MS`. `rg` en todo el repo (sin `node_modules`): solo aparece ahí. Ni el gate, ni el CI, ni ningún script lo fijan.
  - Solo afecta a `trackedIndexedDb()`. Hay 61 ficheros de test que importan `fake-indexeddb` y muchos crean `new IDBFactory()` directamente (por ejemplo `main-collector-mode`, `hebra-main-view-runtime.test.ts:77`), a los que la latencia no llega.
  - Medido: `main-deferred-runtime-startup.test.ts` pasa 15 de 15 con y sin `TYRIAN_TEST_ENGINE_LATENCY_MS=30` (2.09 s y 3.03 s). El arreglo de `a734137` aguanta; lo que no cubre son los ficheros de arriba.
- Riesgo en máquina lenta: alto para las esperas de 50 ms y para `settle()` de `main-collector-mode` (afirman algo que ocurre después de la espera); bajo para las que solo afirman que algo no ha pasado (ver GR-07).
- Acción: cambiar cada espera fija por `vi.waitFor` sobre la condición observable o por `engineIdle` cuando el motor sea `trackedIndexedDb`; añadir un paso del gate o del CI que corra la suite de arranque y almacenamiento con `TYRIAN_TEST_ENGINE_LATENCY_MS` fijado. Coste: 4 a 6 h. Si David quiere un guardarraíl que impida volver a meter esperas por turnos, eso es otro lote (ver decisiones).

### Medio

#### GR-04. Tests de comportamiento desterrados del gate rápido junto con los de texto fuente
- Evidencia: `vitest.config.mts:21` excluye del paso `unit` los 17 ficheros de la lista congelada. Entre ellos:
  - `src/ui/settings-tab.test.ts`: 849 líneas, 39 `it`, solo 3 llamadas a `readModuleSource`.
  - `src/ui/companion-status-model.test.ts`: 385 líneas, 19 `it`, 3 lecturas.
  - `src/ui/runtime-i18n-architecture.test.ts`: 339 líneas, 5 `it`, 4 lecturas.
- Efecto: unos 50 tests que ejecutan código real del panel de ajustes y del modelo de estado no corren en `check` ni en la release (GR-02); solo en el job `check-guardrails` del CI.
- Acción: separar los `it` que leen texto fuente en un `*-source-text.test.ts` congelado y devolver el resto a `check`. La lista congelada sigue en 17 por fichero, o se sube a 18; decide el contrato. Coste: 2 h.

#### GR-05. No hay un arranque de punta a punta del plugin de Obsidian; los 27 `main*` prueban piezas del core por casts privados
- Evidencia:
  - Hay 27 ficheros `src/main*.test.ts` (el encargo hablaba de 28): 26 `main-*` y `main.test.ts`. Suman 11.108 líneas, 312 `it` y 225 `as unknown as`. Todos prueban `src/runtime/tyrian-companion-core.ts` (6.694 líneas); el nombre `main-` es histórico.
  - Solo 3 importan `./main`: `main.test.ts`, `main-ingame-secret-copy.test.ts` y `main-deferred-runtime-startup.test.ts`. `main.ts` tiene 36 líneas y queda cubierto.
  - Hay 3 llamadas a `onload()`: `main.test.ts:2034` y `:2097` comprueban el registro de vistas y comandos, pero no disparan `onLayoutReady`; `main-deferred-runtime-startup.test.ts:442` lo dispara con `initializeRuntime` simulado para que falle. El resto, 85 llamadas, invoca `initializeRuntime()` directamente.
  - En Hebra, 5 ficheros arrancan por `activateTyrian` con la API falsa. `src/host/hebra/entry.ts` no lo alcanza ningún test por import (`cov.mjs`: «UNREACHED: 25 src/host/hebra/entry.ts»); solo el `bundle.test.ts` de GR-01, que no corre en CI.
- Temas y solapes: arranque y ciclo de vida (`main`, `deferred-runtime-startup`, `shutdown-disposal`, `session-error-copy`, `collector-mode`, `assembled-runtime-wiring`); alertas (`alert-wiring` con 29 tests, `live-alert-threshold`, `ingame-session-start`, `ingame-secret-copy`, `sell-signal-wiring`); semillas de precio (`price-seed-phases` con 26, `-serial-wiring`, `-two-in-flight`, `price-history-row-seed`); inventario (`inventory-preferences-lost-write`, `-reclassify`, `inventory-sync-progress-render`); venta (`sale-hero-timing` con 24, `sale-refresh`); sesiones (`session-9sep-fixture`, `-life-lock`, `-note-economy`, `-recovery-migration`, `-vault-isolation`, `halloween-backfill-wiring`); UI (`render-coalescing`). Por títulos de `it` repetidos el solape es casi nulo (15 títulos duplicados en 4.592 `it`), pero el arnés se repite: `runtimeBootPlugin`, `collectorModePlugin` y similares viven dentro de cada fichero y no en `src/test/runtime-harness.ts`, que solo usan 6.
- Acción: un test de `onload()` seguido de `onLayoutReady()` real hasta `runtimeReady === true` sobre `runtime-harness`, y otro de `entry.ts` contra `createTyrianTestApi` sin pasar por el bundle. Coste: 2 a 3 h.

#### GR-06. Cada entrada corre en un Node distinto
- Evidencia: `ci.yml:28,54,167` `24.12.0`; `release.yml:34` `22.20.0`; las medidas locales de `docs/ESTADO.md:22,74` son «Fedora, Node v22.23.1»; el comentario de `ci.yml:18-19` dice que Obsidian lleva «Node 24.18.1»; `docs/ESTADO.md:78` dice «No se ha probado bajo Node 24», aunque el CI corre siempre en 24. `package.json` `engines`: `^22.20.0 || >=24.12.0`.
- Efecto: el gate que decide la publicación (22.20.0) no es el que corre el CI en cada push (24.12.0), y ninguno es el local. Un rojo que dependa de la versión puede colarse por la release o bloquearla sin haberse visto antes.
- Acción: fijar la misma versión en los dos workflows (`.nvmrc` o `node-version-file`) y anotar en ESTADO con cuál se midió. Coste: 0,5 h.

#### GR-07. Tests unitarios sobre TCP real de loopback con plazos de milisegundos
- Evidencia: `src/alerts/alert-ingame-server.test.ts:558` `server.listen(0, '127.0.0.1')`; `:57` `helloTimeoutMs: 80`; `:62`, `:214`, `:383` `delay(20)`/`delay(30)` seguidos de afirmaciones; `:466-468` y `:570-574` esperas de sondeo con plazo de 2 s. `src/main-alert-wiring.test.ts` también abre sockets.
- Riesgo: los `delay` van seguidos de afirmaciones negativas («no llegó nada», «solo un started»), así que en una máquina lenta tienden a dar falso verde más que falso rojo. Los plazos de 2 s y los 80 ms del saludo sí pueden dar rojo con un runner muy cargado.
- Acción: subir los plazos de sondeo a 5 s y, donde se afirme ausencia, esperar primero un evento positivo posterior (por ejemplo un eco) en vez de un `delay`. Coste: 1 a 2 h.

#### GR-08. Toda la evidencia de almacenamiento y candados sale de dobles; no hay prueba automática en un host real
- Evidencia: `docs/ESTADO.md:9-12` («Todas las cifras de abajo salen de tests sobre un IndexedDB falso, un gestor de candados en memoria y un reloj simulado»). `src/test/indexed-db-connections.ts:173` documenta una diferencia conocida: «fake-indexeddb always pairs its aborts with an error». `src/test/fake-lock-manager.ts:11`: «Node 22 has no `navigator.locks`». `smoke:live` y `beta:verify-runtime` existen pero son manuales y piden el CLI de Obsidian.
- Lo que los dobles no reproducen: el auto-commit y el reparto de turnos de WebKitGTK o Chromium (el incidente del 7 oct en WebKitGTK está citado en `indexed-db-connections.ts:6`), cuotas, `versionchange` entre procesos y si el candado muere con el proceso. Los dobles están bien hechos para lo que modelan; el hueco es que nada contrasta el modelo con un motor real.
- Acción: es una decisión de David (ver abajo). La opción barata es una lista corta por release en Obsidian y en Hebra que lea los eventos `life_lock_*` y `taken` del registro local, como ya propone `docs/ESTADO.md:79-80`. Coste: 1 h para escribirla; la ejecución es de David.

### Bajo

#### GR-09. Los tests de arranque viven bajo el plazo por defecto de vitest (5 s) con topes internos de 3 y 4 s
- Evidencia: no hay `testTimeout` en `vitest.config.mts`. `src/test/indexed-db-connections.ts:275` `capMs = 3_000`; `src/main-deferred-runtime-startup.test.ts:141` `STALL_MS = 4_000`; `:360` `{ timeout: 4_000 }`. Medido en el Mac: 182 ms de tests sin latencia y 1,28 s con 30 ms por apertura.
- Riesgo: en un runner muy lento el mensaje útil («The boot is stuck…») puede perder frente al «Test timed out in 5000ms» de vitest.
- Acción: un plazo explícito de 15 s en esos `it` o en el `describe`. Coste: 0,25 h.

#### GR-10. Esperas por número de microtareas: deterministas, pero frágiles y con riesgo de falso verde sobre `fake-indexeddb`
- Evidencia: `src/test/indexed-db-connections.ts:198-207` `settlement` (64 vueltas de `Promise.resolve()`, «The fakes here settle on microtasks»); se usa en 6 ficheros, 15 veces con `.toBe('pending')`. `src/sessions/live-session-storage-outage.test.ts:121` (64), `src/main-live-alert-threshold.test.ts:52` (50), `src/ui/settings-tab.test.ts:78,83,103,811` (20), `src/alerts/live-loot-server.test.ts:32` (12), `src/ui/inventory-advisor-item-view.test.ts:138,163,331,342`, `src/ui/companion-view-surfaces.test.ts:523,543`.
- Riesgo: no dependen de la velocidad, porque las microtareas no compiten con el reloj. Sí dependen de cuántos `await` tenga el código: un `await` de más rompe el test sin cambiar el comportamiento. `fake-indexeddb` contesta en `setImmediate`, así que 64 microtareas nunca cruzan una respuesta del motor: «pending» puede ser falso verde si el código rechazara tras una vuelta del motor.
- Acción: en los 15 `toBe('pending')`, llamar antes a `engineIdle(tracked)` (ya se hace en `src/runtime/collector-instance.test.ts:55-59`). Coste: 1 h.

#### GR-11. Un presupuesto de rendimiento con reloj de pared
- Evidencia: `src/advisor/inventory-advisor-result-scaling.test.ts:24-31`, `performance.now()` y `expect(elapsedMs).toBeLessThan(4_000)`. El comentario de `:15-19` explica que el margen es deliberadamente holgado (de 10-20 s a menos de 1 s).
- Acción: ninguna por ahora; vigilar si aparece en un rojo del CI. Coste: 0 h.

#### GR-12. Scripts huérfanos y entradas sin uso
- Evidencia: los cinco scripts sin llamador de la sección 1; `i18n-copy-length` sin script `npm`; `npm test` no lo usa ningún workflow. Los `bench:h6-*` corren en cada push a `main`, y el propio `ci.yml:32-34` dice que nadie lee el resultado hasta cerrar una sesión.
- Acción: dar script `npm` a los que se usan (por ejemplo `reindex-action-observability-baseline`, citado en dos SPEC) y borrar o archivar los que no; en el README de scripts, una línea por script. Coste: 1 h.

#### GR-13. Aserciones sobre nombres del AST fuera del contrato de texto fuente
- Evidencia: `src/test/module-boundary.ts:54-56` («This function does that read here instead, inside test infrastructure the contract does not scan»). 11 ficheros de `check` usan `moduleBoundaryFacts`, y de ellos 6 afirman sobre `referencedNames`, `classMemberNames` o `propertyCallChains` (por ejemplo `src/advisor/inventory-advisor-presentation-architecture.test.ts`, `src/advisor/inventory-container-economy-architecture.test.ts`).
- Valoración: para fronteras de import (`moduleSpecifiers`) es legítimo y no hay otra forma de verlo. Afirmar que un nombre aparece o no en un módulo se parece mucho a afirmar sobre su texto: un renombrado lo pone en rojo y una función muerta lo deja en verde. El contrato (`scripts/source-text-assertion-contract.mjs:34-37`) solo cuenta las lecturas directas.
- Acción: inventariar esos 6 y pasar a comportamiento lo que se pueda (por ejemplo con `ambientCapabilityUse` de `src/test/ambient-capabilities.ts`). Coste: 2 a 3 h.

#### GR-14. Un módulo de UI sin consumidor en producción
- Evidencia: `src/ui/inventory-sync-timing-summary.ts` (36 líneas). `rg` solo lo encuentra en su propio fichero y en `src/security-boundary.test.ts:40`, que lo nombra por ruta. Su comentario (`:15-17`) dice «It is also wired into Settings»; ningún fichero de `src` lo importa.
- Acción: borrarlo o cablearlo; lo decide el auditor de código muerto o David. Coste: 0,25 h.

#### GR-15. El spike en C de H8 se compila con ASan en cada push
- Evidencia: `scripts/tests/probar-h8-crossover-spike.sh` lanza `spikes/h8-mumble-crossover/test-host.sh`, que exige `cc` y compila con `-fsanitize=address,undefined`. Costó 567 ms el 2 oct (`guardrails-final.log:180`).
- Valoración: barato y H8 se queda por premisa. Solo se anota que es un spike y no `src/platform`, y que hace falta un compilador de C para que los guardarraíles salgan verdes.
- Acción: ninguna salvo que David quiera sacarlo a un job condicionado a cambios en `spikes/`, como ya se hace con `native/mumble-helper`. Coste: 0,5 h.

#### GR-16. El `node_modules` del Mac está desfasado y no sirve para medir el gate aquí
- Evidencia: `ls node_modules/happy-dom` → «No such file or directory»; `node_modules/.package-lock.json` es del 18 ago y `happy-dom` entró en `package.json` el 3 oct (`6ab0c52`). Los 10 ficheros con `@vitest-environment happy-dom` fallan aquí con «Cannot find package 'happy-dom'». Sale rojo, no falso verde.
- Acción: `npm ci` en el Mac antes de medir nada en él (instala; no se ha hecho en este audit). Coste: 0,1 h.

### Sin medir

#### GR-17. Duración actual del gate y de los tests más lentos
- Lo anotado: 8 sep, `check` antiguo único: 74,7 s de pared, 322 % de CPU, 2,4 GB de RSS (`scripts/gate-steps.mjs:16-17`). El 2 oct, `check`: `lint` 3,3 s, `typecheck` 7,8 s, `unit` 13,6 s, resto unos 4 s (`check-final.log:388-395`); vitest «Duration 13.27s (… collect 102.60s, tests 112.59s …)» con 264 ficheros y 4.275 tests. `check:guardrails` sumaba unos 14 s.
- Más lentos el 2 oct (`check-final.log`): `inventory-advisor-verified-analysis` 9,7 s, `commerce-listings-capture` 8,6 s, `src/test/module-boundary.test.ts` 7,9 s, `inventory-advisor-view-list-reuse` 7,3 s, `inventory-advisor-bid-depth` 6,3 s, `eslint-default-project-config` 6,1 s (lanza `node` tres veces), `main-session-9sep-fixture` 6,0 s.
- Hoy hay 346 ficheros y 5.882 tests. No hay cifra por fichero posterior al 2 oct. Con `--maxWorkers=1`, que es la norma de David para agentes, la parte de vitest serían unos 2 min (112 s de tests y 102 s de recogida sumados el 2 oct), sin contar el crecimiento.
- Acción: que el paso `unit` del CI escriba `--reporter=json` como artefacto, para tener la duración por fichero de cada push sin correr nada a mano. Coste: 0,5 h.

#### GR-18. Solape de comportamiento entre los `main-*` y los tests de cada módulo
- Solo se ha medido por títulos (casi nulo). No se ha medido si, por ejemplo, `main-price-seed-*` y `src/economy/price-seed-bulk-refresh.test.ts` prueban la misma serialización por dos caminos. Haría falta una cobertura por líneas (`vitest --coverage`), que este audit no podía correr.

## 3. Guardarraíles: qué protege cada uno

| paso | invariante | tipo |
|---|---|---|
| `unit-guardrails` | `src/platform` (H8) y los 17 congelados | producto; los 17 congelados leen texto fuente (14 con `readModuleSource`, 3 de `src/platform` con `readFileSync`) |
| `source-text-assertion-contract` | que no crezcan los tests que leen texto fuente (`frozen=17; scanned=375`) | trinquete sobre el árbol, por AST |
| `security-scan` + suite | patrones de seguridad del árbol | árbol real; la suite prueba el escáner |
| `action-observability-census` + suite | cada `catch`/`void`/callback revisado frente a una línea base | árbol real; la línea base se reescribe en cada cambio (`a734137` tocó 63 líneas de ella para un fake de test) |
| `i18n-unused`, `i18n-copy-length` + suites | claves sin uso y longitud de copy | árbol real |
| `host-esm` + suite | el bundle de Hebra sin `obsidian`/`electron`/`net`/builtins | build real; la suite prueba el detector |
| `release-workflow-contract` | gate antes de publicar, permisos de escritura solo en release | lee `release.yml` real y además se autoprueba |
| `support-contract`, `release-identity-contract`, `h8-helper-decision-contract` | plantillas de issues, docs, identidad, decisión H8 en docs | leen el árbol real (texto de docs) y se autoprueban |
| `brat-release-contract`, `brat-release-plan`, `release-package`, `release-preflight`, `beta-channel`, `beta-runtime`, `dev-install`, `smoke-live`, `record-api-fixtures`, `changelog-entry`, `run-gate` | el comportamiento de cada herramienta | solo prueban el script sobre repos o directorios temporales; no el producto |
| `h8-crossover-spike` | el spike C compila y pasa ASan/UBSan | spike, no producto |

De los 25 pasos de `check:guardrails`: 17 prueban herramientas (las 11 de la penúltima fila y las 6 suites de escáneres cuyo escáner corre sobre el árbol en otro paso); 4 son contratos sobre texto de docs o YAML (`release-workflow`, `support`, `release-identity`, `h8-helper-decision`), frágiles a reescrituras de prosa, que es justo lo que pretenden vigilar; 3 tocan producto o árbol (`unit-guardrails`, `source-text-assertion-contract`, `i18n-copy-length`); y 1 es el spike C. Ninguno es trivial en el sentido de no probar nada: cada suite sabotea su script y espera rojo. Algunas de las 11 (`release-package`, `beta-channel`, `brat-release-plan`) también leen ficheros reales del repo, según `rg`.

Los 17 congelados son la deuda de «source-text assertions»: comprueban cómo está escrito el código, no qué hace. Siguen verdes con una función muerta y se ponen rojos al renombrar un miembro privado. Están aislados y con trinquete, que es lo correcto; el problema es GR-04 (arrastran tests buenos con ellos).

## 4. Arneses de `src/test/` (2.914 líneas con `module-boundary.test.ts`)

- `indexed-db-connections.ts` (292): `trackedIndexedDb` sobre `fake-indexeddb` con caída, cuelgue total o solo de transacciones, commits retenidos, aperturas retenidas, cierre por debajo y `engineIdle`. Es el mejor instrumento del repo para el arranque; ver GR-03 (no se usa en todos los arranques) y GR-10.
- `fake-lock-manager.ts` (115): Web Locks en memoria, con modos deshonestos (`always free`, `unanswered`, `throws`…). Bien para la lógica; no dice nada de un host real (GR-08).
- `obsidian-mock.ts` (109): `Plugin`, `ItemView` y compañía vacíos; `requestUrl` simulado. El typecheck usa los tipos reales de `obsidian`, así que la deriva de firma la ve `tsc`; la de comportamiento no la ve nadie.
- `hebra-plugin-fakes.ts` (539) y `hebra-real-host.ts` (210): la API falsa de `hebra-plugin-api/testing` más lo que el host real hace y el fake no (montaje diferido, rechazo de vistas duplicadas, fallos del plugin). `hebra-plugin-fakes.ts:11-13` documenta que el almacenamiento imita el de Hebra leído en `130c34d6` (3 oct); si Hebra cambia, nada lo avisa.
- `runtime-harness.ts` (208) y `obsidian-host-harness.ts` (48): componen el core real sobre un `ObsidianHost` real con fakes debajo. Solo 6 `main-*` usan `runtime-harness`.
- `ambient-capabilities.ts` (34): trampas sobre `fetch`, temporizadores, `indexedDB`… para probar por ejecución que un módulo no las toca. Buena alternativa a GR-13.
- `module-boundary.ts` (483): ver GR-13.
- Ningún fichero de test espía un prototipo sin restaurarlo (13 ficheros con `spyOn(X.prototype…)`, los 13 con `restoreAllMocks` o `mockRestore`). Los 15 ficheros con `vi.useFakeTimers` tienen `vi.useRealTimers`.

## 5. Cobertura por import

Calculada con `cov.mjs`: para cada `.ts` de `src` (sin `src/test/`, 363 ficheros), si algún `*.test.ts` lo importa directamente y si lo alcanza alguno por la cadena de imports.

| carpeta | ficheros | líneas | sin test directo | no alcanzados |
|---|---|---|---|---|
| `src/account` | 20 | 5.203 | 1 (106 l.) | 0 |
| `src/advisor` | 24 | 8.799 | 2 (144 l.) | 0 |
| `src/alerts` | 20 | 3.461 | 1 (270 l., `live-loot-channel.ts`) | 0 |
| `src/assets` | 12 | 2.275 | 0 | 0 |
| `src/catalog` | 8 | 1.831 | 1 (201 l., `public-catalog-validators.ts`) | 0 |
| `src/core` | 24 | 6.512 | 1 (23 l.) | 0 |
| `src/economy` | 50 | 13.445 | 0 | 0 |
| `src/halloween` | 11 | 2.988 | 0 | 0 |
| `src/host/hebra` | 19 | 3.970 | 1 (25 l., `entry.ts`) | 1 (`entry.ts`) |
| `src/host/obsidian` | 5 | 658 | 2 (139 l.) | 0 |
| `src/host` (sueltos) | 4 | 878 | 0 | 0 |
| `src/inventory` | 4 | 2.428 | 0 | 0 |
| `src/performance` | 2 | 227 | 0 | 0 |
| `src/platform` | 10 | 2.808 | 0 | 0 |
| `src/runtime` | 14 | 8.293 | 3 (420 l., entre ellos `assemble-sessions.ts` 164) | 0 |
| `src/sessions` | 69 | 20.315 | 0 | 0 |
| `src/ui` | 65 | 16.773 | 9 (639 l., entre ellos `price-history-svg.ts` 191) | 1 (`inventory-sync-timing-summary.ts`) |
| `src/wallet` | 1 | 489 | 0 | 0 |
| `src/main.ts` | 1 | 37 | 0 | 0 |
| total | 363 | | 21 (1.967 l.) | 2 |

Importar no es cubrir: esto dice que casi todo tiene un test que lo carga, no qué ramas se ejecutan. La cobertura por líneas está sin medir (GR-18).

## 6. Decisiones de David

1. ¿La release debe correr también `check:guardrails` (unos 14 s el 2 oct) o basta con que el integrador mire el CI del commit antes de etiquetar? (GR-02.) Recomendación: que la corra.
2. ¿Qué Node manda: el `24.12.0` del CI, el `22.20.0` de la release o el del Electron de Obsidian (`24.18.1` según `ci.yml`)? (GR-06.) Recomendación: uno solo en los dos workflows.
3. ¿Se quiere un paso de CI que corra la suite de arranque y almacenamiento con el motor lento (`TYRIAN_TEST_ENGINE_LATENCY_MS`), y un guardarraíl que avise de nuevas esperas por número de turnos o de milisegundos fijos? (GR-03.) Lo primero es barato; lo segundo es infraestructura nueva y merece su propio encargo.
4. ¿Se acepta una comprobación manual corta por release en Obsidian y en Hebra reales (eventos `life_lock_*`, `taken`, arranque con almacén lento), dado que todo lo de almacenamiento y candados sale de dobles? (GR-08.)
5. ¿El spike C de H8 sigue en cada push o pasa a un job condicionado a `spikes/`? H8 se queda en cualquier caso. (GR-15.)

## 7. Límites de este audit

- No se ha corrido el gate, ni los guardarraíles, ni la suite completa, ni ningún build: las duraciones del gate son las anotadas (8 sep, 2 oct, 9 oct) y pueden estar desfasadas.
- Solo se han ejecutado 4 ficheros de test, en el Mac y con `node_modules` desfasado (GR-16). No se ha reproducido carga de CPU ni el runner de GitHub; el riesgo de rojo en máquina lenta de GR-03 y GR-07 es una lectura del código, no una medida.
- La cobertura es por import, no por línea ni por rama.
- El barrido de patrones es por expresión regular sobre el texto de los tests: puede dejarse esperas escritas de otra forma (por ejemplo, helpers con otro nombre).
- No se ha leído el contenido de las suites `probar-*` más allá de su estructura y de si leen el árbol real; tampoco el código de producto salvo `main.ts`, `entry.ts` e `inventory-sync-timing-summary.ts`.
- No se ha consultado el historial de runs de GitHub Actions: las cifras de CI son las de `docs/ESTADO.md`.
