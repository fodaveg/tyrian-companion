# Audit 5 de 5: deuda estructural y tipado de Tyrian Companion

- Fecha: 2026-10-10
- SHA: `6fbe77e` (`main`, árbol limpio), máquina: Mac (Darwin), Node del sistema.
- Alcance: solo lectura sobre `/Users/david/code/tyrian-companion`. Lint, tipado, grafo de dependencias entre carpetas de `src/`, tamaño de ficheros, superficie de `src/sessions` y `src/economy`, guías del catálogo comunitario de Obsidian. No se ha corrido la suite, ni `npm run check`, ni `build`. Premisas cerradas respetadas: H8/Mumble (`src/platform`) se queda, la detección asistida se queda, el código no se amputa.
- Comandos ejecutados (salidas guardadas en el scratchpad de esta sesión):
  - `npx eslint . --cache --cache-location node_modules/.cache/eslint -f json -o <scratch>/eslint.json` (una vez; salida 1).
  - `npx tsc --noEmit --skipLibCheck > <scratch>/tsc.txt` (una vez; salida 2, 231 líneas).
  - Scripts `node` propios en el scratchpad: agregado de ESLint por regla y carpeta, matriz de imports entre carpetas (todos los imports y solo imports de valor), componentes fuertemente conexos a nivel de carpeta y de fichero, censo de exports sin consumidor, censo AST (API de `typescript` del repo) de `any`, `as unknown as`, `!`, `@ts-*`.
  - `grep`/`git log`/`git show` puntuales, citados en cada hallazgo.

## Resumen de cifras

| Medida | Valor |
|---|---|
| ESLint hoy en este Mac | 1.639 errores y 117 avisos en 62 ficheros |
| ESLint en ESTADO (Fedora, 9 oct, `bc41145`) | 0 errores y 117 avisos |
| Avisos en fuente / en tests | 81 / 36 |
| `tsc --noEmit` hoy en este Mac | 231 líneas de error, todas en ficheros que importan `hebra-plugin-api` o `happy-dom` |
| `any` explícitos (fuente y tests) | 0 |
| `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` en fuente | 0 / 1 / 0 |
| `as unknown as` fuente / tests | 41 / 675 |
| `!` aserción no nula fuente / tests | 440 / 1.939 |
| `innerHTML`, `outerHTML`, `insertAdjacentHTML` en fuente | 0 |
| Carpetas de `src/` en un mismo ciclo (imports de valor) | 14 de 16 |
| Ciclos de imports de valor entre ficheros | 2 (2 y 4 ficheros) |
| Ficheros de fuente > 800 líneas / de test > 800 | 17 / 26 |

## 1. Reconciliación de la cifra de lint con ESTADO

Las dos cifras son correctas, cada una en su máquina. La de ESTADO es la buena para el código; la de hoy es un artefacto del entorno de este Mac.

- `docs/ESTADO.md:79-80`: «Medido sobre `bc41145` ... (Fedora, Node v22.23.1, 9 oct 2026) ... `lint` con 0 errores y 117 avisos».
- Hoy, en el Mac: los 117 avisos coinciden uno a uno; los 1.639 errores son todos de reglas con tipos (`no-unsafe-*` 1.630, `no-redundant-type-constituents` 8, `no-unnecessary-type-assertion` 1) y están todos en 33 ficheros de `src/host/hebra/` y 2 de `src/test/` (`hebra-plugin-fakes.ts` 141, `hebra-real-host.ts` 88), más 4 en dos tests de `src/ui` que importan `happy-dom`.
- Causa medida: `node_modules/hebra-plugin-api` no existe en este Mac (`ls: node_modules/hebra-plugin-api: No such file or directory`), aunque `package.json:81` lo declara (`github:fodaveg/hebra-plugin-api#v1.3.0`). `node_modules/.package-lock.json` es del 18 ago 2026 y lista 360 paquetes frente a 442 de `package-lock.json`. El tipo importado se resuelve como `error`, que ESLint trata como `any`: `vault-port.ts:100 'PluginNote' is an 'error' type that acts as 'any'`. `tsc` confirma lo mismo: 23 `TS2307 Cannot find module 'hebra-plugin-api'`, 5 de `hebra-plugin-api/testing` y 2 de `happy-dom`; ningún error de `tsc` cae en un fichero que no importe esos módulos.
- No es la caché ni otro comando: ESTADO y el gate usan el mismo (`scripts/gate-steps.mjs:35`, `eslint . --cache --cache-location node_modules/.cache/eslint`), y ESTADO cuenta fuente y tests juntos, igual que hoy.

Censo de avisos (los 117) por regla y carpeta:

| Carpeta | Fuente | Tests | Reglas |
|---|---|---|---|
| `src/ui` | 78 | 7 | `prefer-create-el` 78 + 5; `no-global-this` 2 |
| `src/host` | 1 | 1 | `prefer-create-el` 1 (`dom-polyfill.ts:109`); `prefer-window-timers` 1 |
| `scripts` | 2 | 0 | `no-restricted-globals` (`fetch`) 2 |
| `src/alerts` | 0 | 11 | `prefer-window-timers` |
| `src` raíz (`main-*.test.ts`) | 0 | 5 | timers 3, `no-global-this` 2 |
| `src/core` | 0 | 4 | timers |
| `src/sessions` | 0 | 4 | timers 3, `no-global-this` 1 |
| `src/economy` | 0 | 2 | timers |
| `src/account`, `src/inventory` | 0 | 1 + 1 | timers |
| Resto (`advisor`, `runtime`, `platform`, `catalog`, `halloween`, `assets`, `wallet`, `performance`) | 0 | 0 | |

Directivas `eslint-disable`: 101 (90 `@typescript-eslint/unbound-method`, 45 de ellas en `src/main.test.ts` y 26 en `src/ui/companion-view.test.ts`). Todas tienen motivo escrito y todas están en tests o ayudas de test, salvo una en producto, justificada: `src/alerts/alert-ingame-protocol.ts:320` (`no-control-regex`, «a character name must reject every control character»).

## 2. Los 84 `prefer-create-el` y el catálogo de Obsidian

La premisa del encargo no se sostiene: `obsidianmd/prefer-create-el` no mira `innerHTML`. Señala `document.createElement(tag)` y sugiere `createEl`/`createDiv`/`createSpan` por compatibilidad con ventanas emergentes. El HTML crudo lo vigilan `no-unsanitized/property`, `no-unsanitized/method` y `@microsoft/sdl/no-inner-html`, activas en el `recommended` instalado y con 0 hallazgos. `grep -rnE "innerHTML|outerHTML|insertAdjacentHTML" src` da 4 líneas: un comentario (`src/host/hebra/setting-row.ts:5`, «never `innerHTML`: Trusted Types») y 3 lecturas en un test (`hebra-main-view-runtime.test.ts:522,527,536`).

Por fichero (fuente 79, tests 5):

| Fichero | Avisos | De dónde sale el `document` | Contenido escrito |
|---|---|---|---|
| `src/ui/farming-preparation-panel.ts` | 20 | `container.ownerDocument` (`:38`) | copy i18n y cifras por `textContent` |
| `src/ui/live-session-alerts-panel.ts` | 18 | parámetro del constructor | copy i18n; nombre de objeto de la API de GW2 por `textContent` (`:57-62`) |
| `src/ui/farming-goal-panel.ts` | 17 | `container.ownerDocument` (`:15`) | copy y cifras por `textContent` |
| `src/ui/farming-declared-build-editor.ts` | 10 | parámetro | copy; texto del jugador en `textarea.value` |
| `src/ui/farming-session-panel.ts` | 10 | parámetro (`surface.ownerDocument`, `companion-view.ts:397`) | copy |
| `src/ui/live-session-comparison-panel.ts` | 2 | parámetro | `node(tag, text)` con `textContent` (`:104`) |
| `src/ui/live-session-set-aside-notice.ts` | 1 | parámetro | `textContent` |
| `src/host/dom-polyfill.ts` | 1 | es el propio polyfill de `createEl` para Hebra | |
| tests de `src/ui` (3 ficheros) | 5 | | |

Riesgo de inyección real: ninguno. Todo lo que viene de datos (nombres de objetos de la API, notas, texto del jugador) entra por `textContent`, `.value` o `setAttribute` de atributos fijos. `docs/THREAT-MODEL.md` no tiene una fila de inyección en el DOM (búsqueda de `innerHTML|XSS|Trusted|DOM` sin resultado pertinente); el único punto del DOM que cita es el modal del token del puente (`:139`).

Lo que exige el `recommended` de `eslint-plugin-obsidianmd` 0.4.1 instalado (118 reglas activas) y el estado del repo:

| Requisito | Regla | Estado |
|---|---|---|
| Sin HTML crudo | `no-unsanitized/*`, `sdl/no-inner-html`, `sdl/no-document-write` | 0 |
| Sin `eval` | `no-eval`, `no-implied-eval` | 0 |
| Texto de UI en sentence case | `ui/sentence-case` | 0 |
| Comandos sin id/nombre del plugin, sin atajos por defecto | `commands/*` | 0 |
| Ajustes sin encabezados HTML a mano | `settings-tab/*` | 0 |
| Papelera por `fileManager.trashFile` | `prefer-file-manager-trash-file` | 0 |
| Sin ruta `.obsidian` fija | `hardcoded-config-path` | 0 (usa `vault.configDir`, `settings-tab.ts:385`) |
| Timers de `window`, sin `globalThis` | `prefer-window-timers`, `no-global-this` | 26 y 5, todos en tests |
| Red por `requestUrl` | `no-restricted-globals` | 2 en `scripts/`; fuente usa `requestUrl` (`obsidian-http.ts:15`) |
| `createEl` en vez de `createElement` | `prefer-create-el` | 79 fuente, 5 tests |
| Manifiesto y licencia | `validate-manifest`, `validate-license` | 0; `manifest.json` con `isDesktopOnly: true`, `LICENSE` presente |
| Comentarios de desactivación con motivo | `eslint-comments/*` | 0 errores |
| Módulos de Node, `activeDocument` | `no-nodejs-modules`, `prefer-active-doc` | apagadas en el `recommended` |
| `console.log` en fuente | (no es regla del plugin) | 0 |

## Hallazgos

### Alto

**DE-01. `src/runtime/tyrian-companion-core.ts` es una clase dios de 6.694 líneas.**
- Evidencia: 159 `import`, que tocan 13 carpetas; `export class TyrianCompanionCore` va de `:434` a `:6039`; unos 309 miembros y 81 campos privados (grep sobre esa franja). Por nombre: 82 métodos de sesión, 31 de precio y venta, 31 de avisos, 29 de inventario y asesor, 16 de assets, 15 de vistas, 12 de diagnóstico y soporte, 73 de arranque, modo colector, piloto y otros. Las líneas `:6040-6694` son unas 45 funciones sueltas (venta, avisos, resultados de sync, JSONL de soporte). Es el fichero más tocado: 89 commits desde el 10 sep (`git log --since=2026-09-10`), creado el 28 sep al vaciar `main.ts` (`eeef248`).
- Por qué importa: cualquier cambio de cualquier dominio pasa por aquí; concentra el conflicto entre sesiones paralelas y obliga a cargar 6,7k líneas para razonar sobre un caso.
- Acción: extraer sin cambiar comportamiento, en este orden: (1) las funciones sueltas del final a `src/runtime/core-sale-helpers.ts` y `core-outcomes.ts`, 2 a 3 h; (2) una fachada `SaleRuntime` con los 31 métodos de precio y venta, 1,5 a 2 días; (3) una fachada `SessionRuntime` con los 82 de sesión, 2 a 3 días. La clase queda como composición que delega. Cada paso con el censo de observabilidad recolocado.
- Plan detallado y medido: [2026-10-10-plan-de-01.md](2026-10-10-plan-de-01.md).

**DE-02. 14 de las 16 carpetas de `src/` forman un solo ciclo, y `core` no es una hoja.**
- Evidencia (solo imports de valor, sin `import type`): componente fuertemente conexo `wallet, halloween, ui, runtime, assets, inventory, advisor, economy, catalog, account, sessions, core, alerts, host`. Solo `platform` (0 salidas) y `test` quedan fuera. Pares en ciclo directo: `advisor↔economy` (48/1), `core↔sessions` (3/50), `core↔economy` (2/24), `economy↔sessions` (2/16), `runtime↔sessions` (49/1), `host↔runtime` (2/1), `alerts↔core`, `alerts↔economy`.
- `core` tiene 284 imports entrantes desde 14 carpetas, pero importa dominio: `src/core/settings.ts:1` (`../alerts/alert-contract`), `:8,15,16,21` (`../economy/...`), `:9` (`../halloween/...`), `:23,29` (`../sessions/farming-goal*`); `src/core/indexed-db-open.ts:20` (`../sessions/storage-deadline`); `src/core/http.ts:1` y `secret-provider.ts:1` (tipos de `../host/tyrian-host`).
- Otras aristas hacia arriba: `src/sessions/session-history.ts:8` importa `COLLECTOR_STATUS_NOTE_KIND` de `../runtime/collector-status`; `src/economy/inventory-recommendation-envelope.ts:3,8` importa de `advisor` y solo lo consumen 5 ficheros de `advisor`; `src/runtime/tyrian-companion-core.ts:39` importa `installDomHelpers` de `../host/dom-polyfill`.
- A nivel de fichero solo hay 2 ciclos de valor: `advisor/inventory-advisor-result.ts ↔ inventory-advisor-classifier.ts`, y `sessions/live-session-persistence.ts`, `live-session-legacy-archive.ts`, `session-runtime-store.ts`, `session-note-model.ts`. El problema es de capas, no de orden de inicialización.
- `docs/ARCHITECTURE.md:17` («Capas») y `:135` («Los módulos de dominio no dependen de la UI») no fijan ninguna regla entre carpetas de dominio; la de la UI sí se cumple (ninguna carpeta de dominio importa `ui`; solo `host/obsidian/obsidian-ui.ts:18`).
- Acción: (1) mover `economy/inventory-recommendation-envelope.ts` a `advisor`, 1 h; (2) mover `COLLECTOR_STATUS_NOTE_KIND` a `sessions` o `core`, 0,5 h; (3) mover `sessions/storage-deadline.ts` a `core` y los puertos `TyrianHttpPort`/`TyrianSecretsPort` a `core` con reexport desde `host`, 1,5 h; (4) partir `core/settings.ts` para que la normalización de cada subajuste viva en su dominio y `core` solo componga, 4 a 6 h. Con (1) a (3) caen 5 de los 8 ciclos directos. Un test de arquitectura que congele la dirección queda como decisión de David.

### Medio

**DE-03. Lint y `tsc` no son reproducibles entre máquinas: en este Mac el gate `check` saldría rojo.**
- Evidencia: sección 1. `node_modules` del 18 ago sin `hebra-plugin-api` ni `happy-dom`; `eslint` sale con código 1 y `tsc` con código 2. `package-lock.json:3702` resuelve la dependencia como `git+ssh://git@github.com/fodaveg/hebra-plugin-api.git#685f2c02...`.
- Riesgo: cualquier medición de lint o tipado hecha aquí sin `npm ci` es falsa, como la que motivó este audit. Y las reglas con tipos no han revisado `src/host/hebra` en esta máquina, así que lo que diga de ese árbol solo vale en Fedora.
- Acción: `npm ci` en el Mac antes de medir o pasar el gate, 0,1 h más la descarga (no ejecutado aquí). Opcional: que `run-gate.mjs` compruebe que los módulos declarados resuelven antes de lanzar `lint`; es un control nuevo y lo decide David.

**DE-04. El arreglo que propone la regla, `document.win.createEl(...)`, rompería la UI en Hebra.**
- Evidencia: los mensajes sugieren `document.win.createEl('fieldset')` (p. ej. `farming-declared-build-editor.ts:38`). `src/host/dom-polyfill.ts:1-11` instala solo lo que la UI usa en el webview de Hebra: `Node.createEl`, `createDiv`, `createSpan` (`:122-128`), y `grep "\.win\b"` en el polyfill no encuentra nada.
- Acción: si se bajan los 78 avisos de `ui`, hacerlo con `parent.createEl(tag, { cls, text })` sobre el nodo padre (polyfillado), nunca con `doc.win`, y comprobar que las opciones usadas (`cls`, `text`, `attr`, `type`, `value`) están en `DomHelperElementInfo` (`dom-polyfill.ts:14-29`). 4 a 6 h para los 7 ficheros, con sus tests y una pasada visual en Hebra. Quita 78 avisos.

**DE-05. 18 de los 78 avisos están en un panel que producción no monta.**
- Evidencia: `LiveSessionAlertsPanel` solo lo importa `src/ui/live-session-alerts-panel.test.ts`. Lo desmontó `0ae5d43` (6 oct): «The account-era session, saved-session history, comparison, export and next-session preparation stop being painted; their data and commands stay», y quitó `new LiveSessionAlertsPanel(document, ...)` de `live-session-panel.ts`. El núcleo sigue sirviendo `getLiveSessionAlerts()` (`tyrian-companion-core.ts:3453`).
- Acción: decisión de David. Según la premisa «se cablea y se verifica», cablear el panel en la vista de Sesión o dejar escrito que queda fuera a propósito. Sin esa decisión, no gastar horas en sus 18 avisos.

**DE-06. `src/ui/inventory-advisor-view.ts` (2.928 líneas) mezcla modelo de vista puro y DOM.**
- Evidencia: 158 declaraciones de primer nivel, 122 funciones, 163 llamadas a `createEl`/`createDiv`/`createSpan`. Las 9 funciones puras exportadas (`filterInventoryAdvisorRows`, `inventoryAdvisorScopeSummary`, `sortInventoryAdvisorRows`, `groupInventoryAdvisorRows`, `summarizeInventoryAdvisorRows`…) viven en `:151-~500` y el render empieza en `:508`. Cinco de esos exports solo los usan tests (`createInventoryAdvisorFixturePort`, `filterInventoryAdvisorRows`, `inventoryAdvisorScopeSummary`, `prioritizeInventoryAdvisorRowsBySpace`, `renderInventoryAdvisorViewFromPort`).
- Acción: sacar la franja pura a `inventory-advisor-view-model.ts`, 2 a 3 h.

**DE-07. `src/sessions/manual-session-start-service.ts` (2.244) y `src/ui/companion-view.ts` (2.194) son clases únicas enormes.**
- Evidencia: `ManualSessionStartService` va de `:290` a `:2133` (unas 1.840 líneas en una clase). `companion-view.ts` reúne `TyrianCompanionView` (`:205-1788`, 106 métodos), 5 modales (`:1893-2108`) y 15 funciones de copy y formato, con 46 imports de 6 carpetas.
- Acción: mover los 5 modales a `companion-modals.ts`, 1 a 2 h. En el servicio, separar arranque, parada y recuperación en colaboradores, 1 a 2 días; solo cuando se toque esa zona por producto.

**DE-08. `src/sessions` y `src/economy` no tienen superficie pública: casi todo es importable desde fuera.**
- Evidencia: `sessions`, 69 ficheros, 20.315 líneas; 52 importados desde otras carpetas y 17 internos. Los más consumidos desde fuera son `session-history.ts`, `manual-session-start-service.ts`, `live-session-model.ts` y `loot-presentation.ts`, con 8 imports cada uno, casi todos desde `runtime` y `ui`. Familias por prefijo: `live-session-*` 21, `pilot-metrics-*` 5, `pending-proposal-*` 4, `session-note-*`, `session-detection-*`, `loot-*` 3 cada una, más `coordination-*`, `farming-goal*`, `mumble-v2-*`. `economy`: 50 ficheros, 37 importados desde fuera, 13 internos; `reservation-model.ts` (18, 11 desde `advisor`), `price-history-model.ts` (16), `commerce-listings.ts` (10, 9 desde `advisor`). Solo existe un barrel, `src/runtime/index.ts`.
- Exports: `sessions` declara 638, de los que 143 no se nombran en ningún otro fichero (98 tipos); 140 de esos se usan dentro de su propio fichero, así que les sobra el `export`. `economy` declara 448, con 145 en ese caso y 137 usados localmente. Valores que solo nombran tests: 42 en `sessions` (casi todos constantes de plazo o almacén, como `SESSION_AUTO_RETRY_DELAYS_MS` o `PENDING_PROPOSAL_STALE_MS`) y 34 en `economy` (16 en `__fixtures__`).
- Acción: no hace falta un barrel ya. Quitar el `export` a lo que solo se usa en su fichero, con un codemod sobre una muestra primero: unos 280 símbolos en las dos carpetas, 2 a 3 h con `tsc` como red. Eso deja a la vista la superficie real antes de decidir fronteras.

**DE-09. Valores exportados que ni producción ni su propio fichero usan.**
- Evidencia (el nombre solo aparece en su declaración, en tests o en ninguna parte): `sessions/farming-goal.ts:DEFAULT_FARMING_GOAL`, `economy/sell-signal.ts:SELL_SIGNAL_VERSION` y `economy/sell-timing-experiment.ts:SELL_TIMING_EXPERIMENT_VERSION` (sin ningún uso); `economy/sell-signal.ts:SELL_SIGNAL_MINIMUM_REFERENCE_DAYS`, `economy/container-model.ts:containerOutcomeKey`, `economy/container-recommendation.ts:DEFAULT_CONTAINER_RECOMMENDATION_POLICY`, `sessions/pending-proposal-store.ts:MemoryPendingProposalStore`, `sessions/session-detection-quality-store.ts:MemoryDetectionQualityStore`, `core/settings.ts:hasLegacyPaths`, `advisor/inventory-container-economy.ts:pendingHalloweenContainerEconomyPack`, `ui/wallet-vault-sync-controller.ts:summarizeWalletVaultSyncPlan`, `runtime/tyrian-companion-core.ts:createInventoryAdvisorCommandCallbacks` y 13 de `ui` (descriptores `companionView`, `saleView`, `inventoryAdvisorView`, `LiveSessionAlertsPanel`…), solo en tests. Fuera de este hallazgo quedan los 16 de `src/platform` (H8 se queda) y `sessions/mumble-v2-shadow-proposal.ts`.
- Acción: con la premisa de no amputar, cada uno es «cablear o documentar como semilla de test». Inventario de 1 h para que David marque cuáles. Los dobles en memoria (`Memory*Store`) pueden pasar a `src/test/`, 0,5 h.

### Bajo

**DE-10. Los 79 `prefer-create-el` de fuente no son riesgo, solo forma.**
- Evidencia: sección 2. Todos crean nodos sobre el documento de su contenedor (`ownerDocument`, directo o pasado por parámetro, p. ej. `companion-view.ts:389,397`), que es lo que la regla busca proteger en ventanas emergentes.
- Acción: la de DE-04 si el catálogo lo pide, 4 a 6 h. `dom-polyfill.ts:109` es el propio polyfill: `eslint-disable-next-line` con motivo, 0,1 h.

**DE-11. Los 36 avisos de tests son de entorno, no de producto.**
- Evidencia: 26 `prefer-window-timers`, 5 `no-global-this` y 5 `prefer-create-el` en `*.test.ts` (p. ej. `src/alerts/alert-ingame-server.test.ts:28-29`, `src/sessions/live-session-lifecycle.test.ts:1277`).
- Acción: un bloque en `eslint.config.mts` con `files: ['**/*.test.ts']` que apague esas tres reglas, 0,25 h, 36 avisos menos. Si se prefiere tocar los tests, `window.setTimeout` en el entorno DOM de vitest, 1 a 2 h.

**DE-12. `scripts/` usa `fetch` (2 avisos).**
- Evidencia: `scripts/record-api-fixtures.mjs:73`, `scripts/refresh-sell-timing-fixture.ts:72`. Son scripts de Node, no código del plugin.
- Acción: apagar `no-restricted-globals` para `scripts/**`, 0,1 h.

**DE-13. `CoinFigure` esquiva la regla con `createElementNS(HTML_NS, ...)`.**
- Evidencia: `src/ui/live-session-money.ts:39` (añadido en `02a29c1`, 9 oct). Crea elementos HTML por el espacio de nombres, algo que la regla no ve.
- Acción: alinearlo con la forma que se elija en DE-04, 0,25 h.

**DE-14. Fixtures de test dentro de `src/economy` cuentan como fuente.**
- Evidencia: `src/economy/__fixtures__/*.ts` suma 1.873 líneas (14 % de las 13.395 de `economy`); ningún fichero de producción las importa. Salen como exports «sin consumidor» y entran en `tsc` y en el lint como si fueran producto.
- Acción: dejarlas así y descontarlas en los censos, o moverlas a `src/test/fixtures/economy/`, 0,5 a 1 h.

**DE-15. `docs/ARCHITECTURE.md` describe módulos y flujos que ya no existen.**
- Evidencia: `:45` describe `src/objectives/objective.ts` como «contrato futuro», pero la carpeta no existe (`ls: src/objectives: No such file or directory`; último commit que la toca, `8069d4e` del 9 sep). `:96` dibuja `main -> ui -> connection service`, pero `src/main.ts` solo importa `obsidian`, `./host/obsidian/obsidian-host` y `./runtime/tyrian-companion-core`.
- Acción: corregir las dos entradas y añadir el grafo de carpetas de la sección 3, 0,5 h, por el agente de documentación.

**DE-16. Aserciones no nulas y dobles casts concentrados en pocos ficheros.**
- Evidencia (censo AST, fuente): 440 `!`. Los que más llevan: `core/canonical-sha256.ts` 44, `advisor/inventory-advisor-contract.ts` 42, `ui/price-history-svg.ts` 19, `ui/inventory-advisor-item-view.ts` 18, `assets/managed-assets.ts` 17. Con `noUncheckedIndexedAccess: true` (`tsconfig.json`) muchos son accesos por índice ya acotados. Hay 41 `as unknown as`, la mayoría en lectores de IndexedDB y JSON (`economy/price-history-store.ts:577,597,616,624,639`) y en el adaptador de Obsidian (`host/obsidian/obsidian-host.ts:85,120,129`, `obsidian-vault.ts:21`). Un solo `@ts-expect-error`, justificado (`obsidian-host.ts:2`, Electron externo).
- Acción: en `inventory-advisor-contract.ts` y `canonical-sha256.ts`, sustituir los `!` por guardas o bucles con `entries()`, 2 a 3 h. Los casts de IndexedDB pueden ir detrás de un validador por almacén cuando se toquen.

**DE-17. `allowDefaultProject` está en el límite que el propio config se puso.**
- Evidencia: `eslint.config.mts` lista 48 ficheros, con capacidad 52 y reserva 4 (`assertDefaultProjectCapacity`). El próximo script `.mjs` hace fallar la carga del config.
- Acción: un `tsconfig.scripts.json` con `allowJs` para `scripts/**/*.mjs`, que vacía la lista, 1 a 2 h; o subir la capacidad otra vez, 0,1 h.

### Sin medir

**DE-18. `--cache` de ESLint con reglas de tipos puede dar resultados viejos.**
- Evidencia leída: el gate usa `--cache` (`scripts/gate-steps.mjs:35`) con `recommended-type-checked` activo. La caché de ESLint se invalida por el contenido de cada fichero, no por los tipos que importa: si cambia un tipo en otro fichero, el resultado de uno no tocado puede quedarse viejo. No lo he reproducido.
- Acción: en el gate de cierre, lint sin `--cache` una vez por candidato; medir antes su coste en Fedora.
- Hecho (Fedora, 10 oct 2026): `eslint .` sin caché 68 s de pared; con caché en caliente 1,3 s. El paso `lint` del gate (`scripts/gate-steps.mjs`) ya no lleva `--cache`; `npm run lint` lo conserva para desarrollo. Lo guarda `testClosingLintHasNoCache` en `scripts/tests/probar-run-gate.mjs`.

**DE-19. Impacto de endurecer `tsconfig`.**
- Evidencia: `tsconfig.json` tiene `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnused*`, pero no `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature` ni `verbatimModuleSyntax`. No corrí `tsc` con esas opciones (una sola pasada permitida, y aquí faltan dependencias).
- Acción: medir en Fedora con `npm ci` y cada opción por separado, 0,5 h; `noImplicitOverride` suele ser barato y `exactOptionalPropertyTypes` caro.

**DE-20. Comportamiento del bot de revisión del catálogo.**
- No he podido comprobar si el bot usa el `eslint.config.mts` del repo o su propia config, ni si mira los tests. Si usa su config sobre todo el árbol, los 36 avisos de tests cuentan aunque se apaguen localmente (DE-11), y sin `hebra-plugin-api` instalado vería errores como los de este Mac.
- Acción: leer la guía y el bot actuales del catálogo antes de someter el plugin.

**DE-21. Si `npm ci` resuelve `hebra-plugin-api` en una máquina sin clave SSH de GitHub.**
- Evidencia leída: el lockfile la fija por `git+ssh` (`package-lock.json:3702`) y CI hace `npm ci` (`.github/workflows/ci.yml:30,56`). No consulté el estado de CI ni la visibilidad del repositorio (no estaban entre los comandos permitidos).
- Acción: mirar el último run de CI en `main`; si está verde, cerrar este punto.

## 3. Grafo de dependencias entre carpetas

Matriz de imports entre carpetas, fuente sin tests, todos los imports incluidos los de tipo. Filas: carpeta que importa; columnas: carpeta importada.

```text
            acco advi aler asse cata core econ hall host inve plat runt sess test   ui wall
account        .    .    .    .    .   18    .    .    .    .    .    .    .    .    .    .
advisor       20    .    .    .   11   14   76    .    .    .    .    .    .    .    .    .
alerts         .    .    .    .    .    2    1    1    1    .    .    .    .    .    .    .
assets         .    2    .    .    .    7    .    .    .    .    .    .    .    .    .    .
catalog        3    .    .    .    .    8    .    .    .    .    .    .    .    .    .    .
core           .    .    1    .    .    .    4    1    2    .    .    .    3    .    .    .
economy       14    2    3    .   15   36    .    .    4    .    .    .    2    .    .    .
halloween      6    .    3    .    4   12   10    .    .    .    .    .    2    .    .    .
host           .    .    6    2    .   11    4    1    .    1    .    2    3    .    1    1
inventory      2    7    .    1    1    6   14    .    .    .    .    .    .    .    .    .
platform       .    .    .    .    .    .    .    .    .    .    .    .    .    .    .    .
runtime       14   15   24    7   11   41   22   13    9    5    .    .   72    .   24    2
sessions      32    .   19    .    5   59   20    .    .    1    2    2    .    .    .    1
test           1    3    .    2    .    3    .    .    2    .    .    2    2    .    .    .
ui            14   17    9    5    .   64   31    3   13    5    .    3   63    .    .    1
wallet         2    .    .    1    3    3    .    .    .    .    .    .    .    .    .    .
```

- Concentradoras de entrada: `core` (284 imports desde 14 carpetas), `economy` (182, 9), `sessions` (147, 7), `account` (108, 10).
- Concentradoras de salida: `runtime` (259 hacia 13 carpetas), `ui` (228, 12), `sessions` (141, 9), `advisor` (121, 4).
- Hojas: `platform` (0 salidas; solo la importan `host` y `sessions`) y, casi, `account` (solo importa `core`). `wallet` y `performance` son pequeñas y periféricas.
- Ficheros con más entradas de valor: `core/canonical-sha256.ts` (29), `core/i18n.ts` (21), `account/storage-snapshot-model.ts`, `core/http.ts` y `economy/gw2-fees.ts` (19 cada uno).

## 4. Ficheros más grandes

Fuente: `runtime/tyrian-companion-core.ts` 6.694 · `ui/inventory-advisor-view.ts` 2.928 · `core/i18n-runtime-catalog.ts` 2.330 · `sessions/manual-session-start-service.ts` 2.244 · `ui/companion-view.ts` 2.194 · `inventory/inventory-vault-sync.ts` 1.584 · `ui/settings-tab.ts` 1.073 · `halloween/halloween-store.ts` 1.040 · `sessions/live-session-lifecycle.ts` 1.021 · `account/contamination.ts` 985 · `assets/managed-assets.ts` 958 · `sessions/session-runtime-store.ts` 953 · `sessions/session-history.ts` 927 · `economy/container-recommendation.ts` 926 · `sessions/session-note-renderer.ts` 891. Otros dos pasan de 800: `account/storage-snapshot-service.ts` 875 y `advisor/inventory-advisor-contract.ts` 866.

Tests: `main.test.ts` 2.702 · `ui/inventory-advisor-view.test.ts` 1.943 · `sessions/live-session-storage-outage.test.ts` 1.814 · `sessions/manual-session-start-service.test.ts` 1.696 · `sessions/live-session-summary-note.test.ts` 1.633 · `ui/companion-view.test.ts` 1.574 · `inventory/inventory-vault-sync.test.ts` 1.534 · `account/storage-snapshot-service.test.ts` 1.457 · `sessions/live-session-lifecycle.test.ts` 1.442 · `platform/mumble-v2-protocol-reference.test.ts` 1.389 · `ui/companion-view-surfaces.test.ts` 1.200 · `sessions/coordination-coordinator.test.ts` 1.193 · `assets/managed-assets.test.ts` 1.166 · `sessions/session-history.test.ts` 1.134 · `inventory/inventory-analysis.test.ts` 1.089.

Qué mezclan los de más de 800 que no tienen hallazgo propio: `i18n-runtime-catalog.ts` es un catálogo de datos (`ES` de `:7` a `:1204`, `EN` hasta `:2320`, una función), y su tamaño no es deuda. `inventory-vault-sync.ts` junta el esquema de la nota (`:41-365`), la clasificación de notas propias y el plan de sync (89 declaraciones, 57 funciones, 6 carpetas importadas). `settings-tab.ts` importa de `runtime` (`ViewPlacement`, `:31`). `live-session-lifecycle.ts` es una clase con 51 commits desde el 10 sep y es el segundo punto caliente de fuente tras el núcleo. `account/contamination.ts` y `session-note-renderer.ts` son módulos de funciones puras (74 y 48) y su tamaño se explica por el dominio.

## 5. Tipado por carpeta (fuente / tests)

| Carpeta | `as unknown as` | `!` | `as` (sin `as const`) |
|---|---|---|---|
| sessions | 3 / 42 | 85 / 348 | 199 / 227 |
| economy | 19 / 8 | 50 / 187 | 127 / 32 |
| ui | 1 / 317 | 104 / 540 | 55 / 807 |
| advisor | 8 / 10 | 85 / 256 | 59 / 66 |
| core | 1 / 2 | 44 / 9 | 36 / 66 |
| host | 4 / 30 | 0 / 161 | 33 / 118 |
| account | 2 / 5 | 10 / 37 | 28 / 24 |
| runtime | 0 / 9 | 13 / 24 | 20 / 41 |
| alerts | 1 / 8 | 3 / 11 | 32 / 68 |
| platform | 1 / 0 | 10 / 65 | 13 / 27 |
| resto (assets, catalog, halloween, inventory, wallet, performance, raíz, test) | 1 / 244 | 36 / 301 | 46 / 816 |

`any` explícito: 0 en todo `src`. `@ts-ignore`: 0. `@ts-expect-error`: 1 (`host/obsidian/obsidian-host.ts:2`). La deuda de tipado está en los tests (675 `as unknown as`, 317 de ellos en `src/ui`), no en la fuente.

## 6. Plan de bajada por carpeta

Los tres cambios con mejor relación entre beneficio y horas, sin cambiar comportamiento. «Avisos» son avisos de lint eliminados; la mayor parte de la deuda de fuente no sale en el lint.

| Carpeta | 1 | 2 | 3 |
|---|---|---|---|
| runtime | Funciones del final del núcleo a ficheros propios (DE-01), 2 a 3 h | Fachada `SaleRuntime`, 1,5 a 2 d | Fachada `SessionRuntime`, 2 a 3 d |
| ui | `createEl` sobre el nodo padre en 6 paneles: 60 avisos, 3 a 4 h (DE-04, sin el panel de DE-05) | Modelo puro de `inventory-advisor-view.ts` aparte, 2 a 3 h | Modales fuera de `companion-view.ts`, 1 a 2 h |
| sessions | `COLLECTOR_STATUS_NOTE_KIND` fuera de `runtime`, 0,5 h | Romper el ciclo de 4 ficheros de persistencia, 2 a 4 h | Quitar `export` a 140 símbolos locales, 1,5 h |
| economy | `inventory-recommendation-envelope.ts` a `advisor`, 1 h | Quitar `export` a 137 símbolos locales, 1,5 h | `__fixtures__` a `src/test/`, 0,5 a 1 h |
| core | `storage-deadline.ts` a `core`, 0,5 a 1 h | Puertos HTTP y secretos a `core`, 1 h | Partir `settings.ts` por dominio, 4 a 6 h |
| advisor | Romper `inventory-advisor-result ↔ classifier`, 1 a 2 h | Guardas en lugar de 42 `!` en `inventory-advisor-contract.ts`, 2 h | Recibe el envelope de `economy` (ver economy 1) |
| alerts | Override de tests: 11 avisos, 0,1 h | Nada estructural urgente | |
| host | `eslint-disable` con motivo en `dom-polyfill.ts:109`: 1 aviso, 0,1 h | `installDomHelpers` lo inyecta el host en vez de importarlo `runtime`, 1 h | `npm ci` en el Mac (DE-03) |
| tests (todas) | Override de las 3 reglas en `*.test.ts`: 36 avisos, 0,25 h | Fábricas tipadas para los dobles de `src/ui` (317 `as unknown as`), 1 a 2 d | |
| scripts | Override de `no-restricted-globals`: 2 avisos, 0,1 h | `tsconfig.scripts.json` (DE-17), 1 a 2 h | |
| platform, account, catalog, halloween, inventory, assets, wallet, performance | Sin avisos y sin ciclos propios relevantes; nada que bajar por ahora | | |

Con las filas de 0,1 a 0,25 h (overrides y el `disable` del polyfill) el lint pasa de 117 a 78 avisos en menos de una hora; con la fila 1 de `ui` baja a 18, que son los del panel desmontado (DE-05).

## 7. Decisiones de David

1. `LiveSessionAlertsPanel` (DE-05): ¿se vuelve a montar en Sesión o queda fuera a propósito? Sin respuesta no conviene arreglar sus 18 avisos.
2. Los valores exportados que solo usan tests (DE-09, fuera de `platform`): ¿cuáles se cablean y cuáles se documentan como semilla de test?
3. Avisos de lint en tests (DE-11): ¿se apagan las tres reglas para `*.test.ts` en la config o se reescriben los tests?
4. Dirección de capas (DE-02): ¿se fija por escrito en `ARCHITECTURE.md` y con un test de arquitectura que la congele, o basta con mover los ficheros?
5. Comprobar en el gate que los módulos declarados resuelven (DE-03): es un control nuevo y la regla vigente pide no crear preflights sin encargo.
6. Orden de partición del núcleo (DE-01): venta antes que sesión, porque es menor y tiene menos riesgo.

## 8. Límites de este audit

- Lint y `tsc` medidos en el Mac con `node_modules` desfasado. Las cifras de errores de la sección 1 son del entorno; no he medido el estado con tipos de `src/host/hebra` con la dependencia instalada. Para eso vale ESTADO (Fedora, `bc41145`), no este informe.
- No corrí la suite, ni `check`, ni `build`, ni `tsc` con opciones extra (DE-19).
- El grafo entre carpetas sale de expresiones regulares sobre `import ... from '...'` relativos. Un `import { type X }` en línea cuenta como de valor, así que la matriz de valor puede sobrestimar un poco.
- «Sin consumidor» se mide por aparición del nombre con límites de palabra en otro fichero de `src/` o `scripts/`. Un nombre homónimo en otro módulo esconde un export muerto, y un uso dinámico (por cadena) no se ve.
- La clasificación de los métodos del núcleo por dominio es por nombre, aproximada.
- No consulté la red: ni el estado de CI, ni la visibilidad de `hebra-plugin-api`, ni la guía actual del bot del catálogo (DE-20, DE-21).
- Las horas son estimaciones de implementación sin la verificación de cierre (gate y QA en Hebra y Obsidian).
