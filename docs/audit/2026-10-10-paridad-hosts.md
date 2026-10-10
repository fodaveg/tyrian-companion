# Audit 4 de 5: paridad entre hosts (Obsidian y Hebra)

- Fecha: 2026-10-10.
- Repo: `/Users/david/code/tyrian-companion`, `main` = `6fbe77e`, árbol limpio. Solo lectura.
- Alcance: la capa `src/host/` (Obsidian y Hebra), el núcleo en lo que pregunta al host
  (`src/runtime/tyrian-companion-core.ts`, `src/ui/settings-tab.ts`, `src/runtime/vault-ports.ts`), los dos bundles
  publicados de la 0.6.24, el CSS de los dos hosts, `hebra-plugin-api` v1.3.0 frente a v1.4.0 y el contrato de release.
- Fuera de alcance: el código de Hebra (otro repo, no leído), clientes reales, la pila H8/Mumble y la detección
  asistida (premisas cerradas).

## Comandos ejecutados

- `git rev-parse --short HEAD`, `git status --short`, `git show 826f945 --stat` y su diff sin tests.
- `rg`/`grep`/`sed -n`/`wc` sobre `src/host/**`, `src/runtime/tyrian-companion-core.ts`, `src/ui/*`, `src/core/i18n*.ts`,
  `styles.css`, `src/host/hebra/tyrian-host.css`, `scripts/build-host-esm.mjs`, `esbuild.config.mjs`,
  `scripts/brat-release-contract.mjs`, `docs/ESTADO.md`, `docs/HEBRA-CSS-VARIABLES.md`, `docs/BETA.md`.
- `node -e` para contar variables CSS, dependencias instaladas frente a `package-lock.json` y, sobre los assets
  publicados leídos por tubería sin guardarlos (`gh release download 0.6.24 -p <asset> -O - | node …` y `| shasum -a 256`),
  tokens, longitud media de identificador, `console.` y hashes.
- `gh release view 0.6.24 --json …`, `gh release list -R fodaveg/hebra-plugin-api`,
  `gh api repos/fodaveg/hebra-plugin-api/tags`, `gh api repos/fodaveg/hebra-plugin-api/compare/v1.3.0...v1.4.0`,
  `gh api "repos/fodaveg/hebra-plugin-api/contents/src/index.ts?ref=v1.3.0|v1.4.0"`.
- `npx vitest run --maxWorkers=1 src/host/hebra/hebra-host-ui.test.ts` (2 intentos, el primero denegado por el hook de
  cwd, el segundo con `pushd`): falla al cargar, ver HP-09.

## Resumen

| Severidad | Hallazgos |
| --- | --- |
| Alto | 2 (HP-01, HP-02) |
| Medio | 3 (HP-03, HP-04, HP-05) |
| Bajo | 7 (HP-06 a HP-12) |
| Sin medir | 4 (HP-13 a HP-16) |

La frontera está bien cerrada: `obsidian` solo se importa en `src/main.ts` y `src/host/obsidian/*`; el bundle de Hebra
no contiene la palabra «hebra» en `main.js` (0) y sí en `hebra-main.mjs` (59), y `build-host-esm.mjs` rechaza
`obsidian`, `electron`, `net`, builtins de Node, `Buffer`, `process` y `require`. Las diferencias de comportamiento
están casi todas declaradas en `TyrianHostCapabilities` o comentadas en el adaptador. Lo que falla es lo que el
contrato no puede expresar (urgencia de avisos), lo que nadie ha probado en un cliente (candados en Linux, arranque
con almacén mudo) y el texto del adaptador de Hebra, escrito solo en castellano.

## 1. Matriz de superficie por host

Fuente: registros del núcleo (`PRODUCT_ACTION_IDS`, `STANDALONE_COMMAND_IDS`, `productViewRegistrars`,
`registerCodeBlock`, `settingsPanel`, `ribbon`), `src/host/obsidian/obsidian-ui.ts` y `src/host/hebra/hebra-host-ui.ts`.

### Comandos de paleta (20)

| Comando | Obsidian | Hebra | Observaciones |
| --- | --- | --- | --- |
| 17 acciones de producto: `open-companion`, `open-inventory-advisor`, `open-sale`, `review-pending-farming-proposal`, `start-/finish-farming-session`, `recover-/discard-saved-session`, `clear-completed-session`, `abandon-farming-session`, `arm-/disarm-assisted-detection`, `refresh-inventory-advisor`, `preview-/apply-inventory-vault-sync`, `preview-/apply-wallet-vault-sync` | `addCommand` con `checkCallback`: oculto si no está disponible | `ui.registerCommand` con prefijo `tyrian-companion:`; siempre listado; si no está disponible, `notice` con `disabledReason` traducido | Divergencia desde `826f945` (`hebra-host-ui.ts:159`). Los `open-*` entran en la sección de la vista principal si la colocación es `main` (`revealSection`, `tyrian-companion-core.ts:6026-6029`) |
| `export-live-session-csv`, `export-preserved-legacy-session` | oculto si no hay sesión | listado; sin `unavailableReason`, cae al texto fijo «`«nombre» no está disponible ahora.`» en castellano | HP-04 |
| `copy-ingame-bridge-token` | `callback` | `callback`; copia con `navigator.clipboard` del webview | Portapapeles en WebKitGTK sin medir (HP-15) |

Los nombres de los 20 se leen al registrar: tras cambiar de idioma siguen en el anterior en los dos hosts
(`ARCHITECTURE.md:720` lo declara para Obsidian). Paridad, no divergencia.

### Vistas, paneles, cinta y bloque de código

| Superficie | Obsidian | Hebra | Observaciones |
| --- | --- | --- | --- |
| `tyrian-companion-view`, `tyrian-inventory-advisor-view`, `tyrian-sale-view` | `ItemView` en hoja; `getDisplayText` relee el título en cada pintado | pestaña `'column'` de 288 px; título leído una vez (`hebra-host-ui.ts:84`) | Solo con colocación `sidebar` en Hebra. Título fijo tras cambiar idioma (HP-08) |
| `tyrian-main-view` (Sesión, Inventario, Venta) | nunca | con `api.has('ui.view.main')` y colocación `main` (por defecto) | Las secciones se re-etiquetan (`relabelListedSections`); el título de la vista no (HP-08) |
| Panel de ajustes | `PluginSettingTab` con búsqueda de ajustes (`getSettingDefinitions`) | `ui.settingsPanel`; `settingDefinitions` se ignora | Degradado: sin búsqueda en Hebra |
| Panel «Notas no adoptadas» | no existe | segundo `settingsPanel` (`hebra-runtime.ts:91`, `unadopted-panel.ts`) | Solo Hebra, texto fijo en castellano (HP-04) |
| Cinta | `addRibbonIcon` + `Menu.showAtMouseEvent` | `ui.ribbonItem`, se rehace al cambiar la vista principal; menú en coordenadas o bajo el botón | Con la vista principal, el botón lleva `viewId` |
| Bloque `tyrian-price-history` | `registerMarkdownCodeBlockProcessor` | `editor.registerCodeBlock` (capacidad requerida `editor`) | Frontmatter pasado en los dos |

### Ajustes que dependen del host

| Fila | Obsidian | Hebra |
| --- | --- | --- |
| «Dónde se muestra» (`viewPlacementDefinitions`) | oculta | visible si `capabilities.mainView` |
| Assets gestionados | visible | visible (`managedAssets: true`, `hebra-host.ts:481`) |
| Abrir carpeta de diagnóstico | abre con `electron.shell.openPath` | desactivada con motivo (`vault.fullPath` es `null`, `settings-tab.ts:750`) |
| Carpeta de salida | sugerencias y texto libre (`AbstractInputSuggest`) | solo carpetas existentes; cambiarla reinicia el plugin (`hebra-host.ts:342-391`) |
| Selector de secretos | `SecretComponent` de Obsidian | control propio con etiquetas fijas en castellano (`setting-row.ts:326,333,359`) |
| Paquete de soporte | `.json` en `<salida>/diagnostics` | nota de la biblioteca abierta con `openNote` (`supportPackageAsNote`) |

### Avisos, modales y acciones de nota

| Superficie | Obsidian | Hebra | Observaciones |
| --- | --- | --- | --- |
| `notice` del núcleo (39 apariciones de `emitNotice(`, no revisadas una a una) | `Notice`, clic en `containerEl` | `ui.notice(text, onClick)` | Paridad |
| Avisos propios del adaptador | no hay | reinicio por carpeta (ok y fallo), «No encuentro…», notas no adoptadas, comando no disponible | Solo castellano (HP-04) |
| 11 modales (`AlertIngameSecretModal`, `ManualSessionStartModal`, 4 confirmaciones de sesión, `DetectionCorrectionModal`, 4 anónimos de `settings-tab.ts`) | `Modal` con `setTitle` | `ui.openModal` con `title`; CSS acotado a `.hebra-module-modal-content` | Paridad funcional |
| `openNote(path)` | `openLinkText`, cualquier ruta | solo notas del índice o guardadas por `saveNote`; si no, aviso | Degradado y declarado |
| Enlaces en notas | ruta | `[[id:<uuid>|…]]` (`vault.ts:134-141`) | Diseño |
| Cambios de la bóveda | `reportsEveryChange: true` | ausente: el historial de sesiones no recibe `mtime` ni `onNoteChange` (`vault-ports.ts:59,75`) | Degradado y declarado |
| Escritura fuera de la carpeta de salida | permitida | rechazada (`vault.ts:79-82`) | Diseño |

### Servicios

| Puerto | Obsidian | Hebra |
| --- | --- | --- |
| `tcpServer` | `net` de Node | `api.tcp` en escritorio; web e iOS rechazan con `EHEBRA_NO_BRIDGE` |
| `notify.system` | `Notification` con `silent` y, en Linux, `urgency: 'critical'` | `api.notify.system({ title, body })` (HP-01) |
| `notify.sound` | WebAudio | WebAudio (autoplay en WebKitGTK sin medir) |
| `http` | `requestUrl` | `api.http`; webhook con `requestUserHost`; sin HTTP en web |
| `secrets` | `SecretStorage` | una entrada del llavero con un JSON de todos; en web, memoria |
| `settings` / `localStorage` | `loadData`/`saveData`, `app.load/saveLocalStorage` | `api.storage.settings`, `api.storage.device` |
| `shell.openPath` | Electron | siempre `false` |
| `background.hold` | no-op | `api.background` (la API dice «efectivo en macOS») |
| `environment.onUncaughtError` | todo error de ventana | solo los de Tyrian (HP-12) |

## 2. API de Obsidian usada y su cobertura en Hebra

Importaciones de `obsidian`: `src/main.ts:1` (`Plugin`) y los cuatro ficheros de `src/host/obsidian/`. Ningún otro
fichero de producción la importa.

| Símbolo de Obsidian | Dónde | Contraparte en Hebra | Cobertura |
| --- | --- | --- | --- |
| `Plugin.loadData/saveData` | `obsidian-host.ts:47-50` | `api.storage.settings` | Cubierta |
| `app.loadLocalStorage/saveLocalStorage` | `obsidian-host.ts:53-62` | `api.storage.device` | Cubierta |
| `app.secretStorage`, `SecretComponent` | `obsidian-host.ts:42-46`, `obsidian-ui.ts:138-144,222-229` | `api.secrets` + control propio | Cubierta; UI propia en castellano |
| `requestUrl` | `obsidian-http.ts` | `api.http.request` | Cubierta; en web, ausente |
| `Platform.isLinux/isMacOS/isWin` | `obsidian-host.ts:139-143` | `api.env.platform` (iOS y web dan `unknown`) | Cubierta |
| `apiVersion`, `getLanguage`, `manifest` | `obsidian-host.ts` | `api.apiVersion`, `api.env.locale()`, `api.plugin.version` | Cubierta |
| `app.vault` (`getMarkdownFiles`, `getFiles`, `getAbstractFileByPath`, `read`, `process`, `create`, `createFolder`, `on`/`offref`, `adapter.*`, `getBasePath`/`getFullPath`), `TFile`, `fileManager.trashFile` | `obsidian-vault.ts` | `api.vault` vía índice ruta→id (`vault-port.ts`, `path-index.ts`) + IndexedDB para `adapter` | Parcial por diseño: solo la carpeta de salida, sin `basePath`/`fullPath`, sin `reportsEveryChange` |
| `ItemView`, `WorkspaceLeaf`, `registerView`, `getLeavesOfType`, `setViewState`, `revealLeaf`, `detachLeavesOfType` | `obsidian-ui.ts:44-58,158-175` | `ui.registerView`/`revealView` (+ `'main'`) | Cubierta; título no se relee (HP-08) |
| `leaf.rebuildView` (privada) | `obsidian-ui.ts:55` | no aplica | Riesgo solo en Obsidian (HP-11) |
| `addCommand`/`removeCommand` | `obsidian-ui.ts:59-69` | `ui.registerCommand` (`run` sin `checkCallback`) | Parcial: no oculta, avisa |
| `addRibbonIcon`, `Menu` | `obsidian-ui.ts:71-80,120-127` | `ui.ribbonItem`, `ui.openMenu` | Cubierta |
| `registerMarkdownCodeBlockProcessor` | `obsidian-ui.ts:81-87` | `editor.registerCodeBlock` | Cubierta |
| `PluginSettingTab`, `getSettingDefinitions`, `Setting` | `obsidian-ui.ts:88-98,199-267` | `ui.settingsPanel` + `setting-row.ts` (360 líneas) | Parcial: sin búsqueda de ajustes |
| `app.setting.open/openTabById` (privada) | `obsidian-ui.ts:99-103` | `ui.openSettings` | Cubierta |
| `workspace.onLayoutReady` | `obsidian-ui.ts:104` | `ui.onReady` | Cubierta |
| `openLinkText` | `obsidian-ui.ts:112` | `workspace.openNote(id)` | Parcial (solo notas indexadas) |
| `Modal` | `obsidian-ui.ts:177-191` | `ui.openModal` | Cubierta |
| `Notice` | `obsidian-ui.ts:129-132` | `ui.notice` | Cubierta |
| `setIcon`, `setTooltip` | `obsidian-ui.ts:118-119` | `ui.setIcon` (+ clase `svg-icon`), `ui.setTooltip` | Cubierta |
| `AbstractInputSuggest`, `vault.getAllFolders` | `obsidian-ui.ts:273-291` | `folder-picker.ts` | Parcial: sin texto libre |
| `registerDomEvent` (`online`, `offline`, `error`, `unhandledrejection`, `visibilitychange`) | `obsidian-host.ts:108-133`, `obsidian-ui.ts:105-111` | `api.env.onOnlineChange`, `api.env.onVisibilityChange`, `window` filtrado | Cubierta (filtro distinto, HP-12) |
| `electron.shell.openPath` | `obsidian-host.ts:83-88` | ninguna | Ausente, declarada |
| `net` (servidor TCP) | `obsidian-tcp-server.ts` | `api.tcp` | Cubierta en escritorio |
| Ayudantes DOM de Obsidian (`createEl`, `createDiv`, `createSpan`, `empty`, `setText`, `addClass`, `removeClass`, `toggleClass`, `setAttr`, `doc`, `win`) | globales de Obsidian | `src/host/dom-polyfill.ts` | Cubierta; no hay usos en el núcleo de `hasClass`, `setCssStyles`, `show/hide`, `createFragment`, `activeWindow` (0 apariciones medidas) |

## 3. `hebra-plugin-api` v1.3.0 frente a v1.4.0

- Fijado: `package.json:81` `github:fodaveg/hebra-plugin-api#v1.3.0`; lockfile `685f2c02…` por `git+ssh`.
- `node_modules/hebra-plugin-api` NO está instalado en este Mac (ver HP-09); el análisis sale de `gh api`.
- Etiquetas: v1.0.0 a v1.4.0. Release de GitHub solo para v1.2.0 («Latest»); v1.3.0 y v1.4.0 son solo etiquetas.
- `compare/v1.3.0...v1.4.0`: 1 commit, `a9b9173e` (2026-10-10T05:25:02Z), «feat: generar API de plugins 1.4.0 con
  imágenes remotas en línea (markdown.image.remote)». Ficheros: `README.md`, `dist/index.js`, `dist/testing.js`,
  `package.json`, `src/index.ts`, `src/testing.ts`.
- Cambios de tipos: `PLUGIN_HOST_FEATURES` pasa de `['ui.view.main']` a `['ui.view.main', 'markdown.image.remote']`;
  `PLUGIN_API_VERSION = '1.4.0'`. Ningún método nuevo ni cambiado; `PluginCapability` igual.
- Cambio del host falso (`testing.ts`): `ui.registerView`, `ui.registerCommand`, `ui.registerStatusBarItem` y
  `editor.registerCodeBlock` LANZAN si el id (o el lenguaje, recortado y en minúsculas) sigue registrado, «como el
  registro de Hebra (`host-ui.ts`)». El README añade que en Hebra los ids son compartidos entre plugins.

Qué puede romper: los tests que reutilizan un falso sin desregistrar. El arnés propio `src/test/hebra-real-host.ts` ya
emula el rechazo de vistas repetidas, pero no el de comandos ni el de bloques de código. El código de producción
registra 20 ids de comando distintos, una vez, y desregistra las vistas antes de cambiar de colocación
(`applyViewPlacement`, `tyrian-companion-core.ts:1606-1611`), así que por lectura no choca. Sin medir sobre los tests.

Qué puede aprovechar: iconos remotos dentro de las notas (`![alt|20](https://render.guildwars2.com/…)`, en tablas con
`\|`), preguntando antes `api.has('markdown.image.remote')`. Hoy el plugin no escribe ninguna imagen en notas
(0 coincidencias de `![` en código de producción); los iconos de oro, plata y cobre de la 0.6.22 son `<img>` de los
paneles (`live-session-money.ts:10-12`). Obsidian pinta esa misma sintaxis, así que sería ganancia en los dos hosts,
pero una nota con iconos sincronizada a un Hebra anterior enseña el texto alternativo con `|20` a la vista. Ver
decisiones.

## 4. CSS

- `styles.css` 96.405 bytes; `tyrian-host.css` 25.980; `hebra-styles.css` publicado 122.387 (= los dos más dos saltos).
- `styles.css` usa 54 variables y define 4. De las 50 externas, `tyrian-host.css` define 43; las 7 restantes son
  propias o con respaldo: `--tyrian-figures` (respaldo 3), `--font-weight-bold` (respaldo 600, sin definir en ningún
  host, ya documentado), `--from`, `--to`, `--at` (atributo `style`), `--x`, `--y` (`live-session-panel.ts:656-657`).
- `tyrian-host.css` lee 46 tokens que debe dar Hebra. Seis no salen en `docs/HEBRA-CSS-VARIABLES.md` y no llevan
  respaldo: `--motion-fade-standard`, `--motion-ease-standard`, `--motion-duration-standard` (l. 583, 595),
  `--hit-touch-dense` (l. 178), `--on-danger` (l. 330), `--radius-pill` (l. 581), `--warning-soft` (l. 499). Que Hebra
  los defina no se ha comprobado (HP-10).
- Tema claro y oscuro: 0 literales de color (`#hex` o `rgb()`) en los dos ficheros y 0 selectores `theme-dark`,
  `theme-light`, `prefers-color-scheme` o `data-mode`. Todo el color pasa por variables: en Obsidian las del tema; en
  Hebra, tokens que cada tema resuelve en `[data-mode]`. Por construcción, paridad de temas; visualmente sin medir.
- Huecos cubiertos por el bloque de variables: `.lv1-context-module-el`, `.hebra-module-view-content`
  (y `.hebra-module-view-main-content`), `.hebra-module-modal-content`, `.lv1-modules-panel[data-module-panel]`,
  `.cm-hebra-module-code-block`. Los menús y avisos son nativos de Hebra.
- El documento está desfasado: dice 49 nombres medidos en `eeef248`; hoy son 54 y no lista `--x` ni `--y`.

## 5. Bundles

Medido por tubería sobre los assets de la release 0.6.24:

| | `main.js` | `hebra-main.mjs` |
| --- | --- | --- |
| Bytes | 1.966.440 | 2.681.500 |
| Líneas | 529 | 13.087 |
| Tokens tipo palabra | 291.137 | 298.443 |
| Longitud media | 4,93 | 7,12 |
| `console.` | 0 | 1 (`console.warn` del paquete `yaml`) |
| Apariciones de «hebra» | 0 | 59 |

Por qué pesa 715 kB más: `esbuild.config.mjs:38` usa `minify: prod` (renombra identificadores) y `drop: ['console']`;
`build-host-esm.mjs:86-90` usa solo `minifyWhitespace` y `minifySyntax`, a propósito («renaming identifiers would hide
esbuild's `__require` shim») y `lineLimit: 200`. Los caracteres de tokens pasan de unos 1,44 MB a 2,13 MB: unos
690 kB de los 715 kB salen de no renombrar (estimación por tokens, incluye palabras dentro de cadenas, que son las mismas
en los dos). El paquete `yaml` NO explica la diferencia: entra en los dos (`YAMLParseError` aparece en ambos; lo
importan `managed-assets.ts`, `wallet-vault-sync.ts`, `inventory-vault-sync.ts`, `session-note-renderer.ts`,
`collector-status.ts`). El adaptador de Hebra (`src/host/hebra`, unas 4.000 líneas sin tests) es el resto.

Coste de arranque: `main-deferred-runtime-startup.test.ts` monta el núcleo con el arnés de Obsidian y mide en reloj
virtual: con almacén mudo, `runtimeReady` y fin a los 20.000 ms (l. 210). No hay prueba equivalente en Hebra
(HP-13). El análisis del módulo (2,68 MB frente a 1,97 MB) no se ha medido en ningún motor.

## 6. Almacenamiento y candados

- Bases de datos del núcleo: 12 nombres fijos `tyrian-companion-*` sobre el `indexedDB` de la página, en los dos
  hosts. Los registros llevan `vaultId` (`hebra-library:<libraryId>` en Hebra; ruta base o nombre en Obsidian).
- Propias de Hebra: `path-index` y `local-files` vía `api.storage.indexedDbName` (con espacio de nombres del plugin).
- Ventanas: el comentario de `hebra-host.ts:116-124` dice que solo la ventana principal carga plugins (leído en Hebra
  `ea14cd06`, no por este audit) y que en web solo la pestaña dueña llega a `ui.onReady`.
- `navigator.locks`: `entry.ts:19` lo pasa; `locks: null` lo apaga. Obsidian lo toma de `window.navigator`
  (`obsidian-host.ts:35`).
- Proceso único: según el mismo comentario, garantizado solo en macOS; en Linux `tauri-plugin-single-instance` falla
  abierto sin bus D-Bus y WebKitGTK guarda los candados por proceso; Windows sin verificar. `ESTADO.md:66-72`: con dos
  procesos y propietario lento, 14 de 120 frente a 120 de 120 sin candados (HP-02).
- Entre hosts: Obsidian y Hebra en la misma máquina no comparten almacén, ni reserva de sesión, ni candados. Solo
  se pelean el puerto 47823 (HP-05).

## 7. Release

- `docs/BETA.md` y `brat-release-contract.mjs:13-24`: 8 assets (`main.js`, `manifest.json`, `styles.css`, zip, `.sha256`,
  `hebra.json`, `hebra-main.mjs`, `hebra-styles.css`). La 0.6.24 los tiene, todos `uploaded`, no vacíos;
  `isDraft:false`, `isPrerelease:false`.
- Qué verifica el contrato: nombre, etiqueta y `manifest.version` iguales; no borrador; conjunto exacto; `uploaded`;
  tamaño > 0.
- Qué no verifica: `isPrerelease`; que `hebra.json` tenga la misma versión; que sus `files.*` casen con los assets
  subidos; nada de instalación ni carga. Hoy casan: `hebra.json` dice `0.6.24`, `apiVersion ^1.0.0` y los sha256 de
  `hebra-main.mjs` (`785a9780…2f60`) y `hebra-styles.css` (`22ba8b8c…3e4c`) coinciden con los descargados (medido).
- `verify-beta-runtime.mjs` solo sabe de Obsidian (CLI de Obsidian, `app.plugins`). Para Hebra no hay verificación
  de carga equivalente (HP-03).

## Alto

### HP-01. En Hebra los avisos del sistema pierden `urgency: 'critical'` y `silent: true`

- Evidencia: `src/alerts/alert-system-notification.ts:11-14` explica que GNOME oculta los avisos normales con una
  ventana a pantalla completa y solo deja pasar los críticos; `:53-55` los pide en Linux y `silent: true` en todos
  para no duplicar el sonido del plugin. En Hebra, `hebra-host.ts:493-494` llama
  `api.notify.system({ title: input.title, body: input.body })`, y la API v1.3.0 y v1.4.0 solo admite
  `system(input: { title: string; body: string })` (`src/index.ts:934-937` de `hebra-plugin-api`).
- Impacto: Linux es la plataforma primaria (`PLATFORM_POLICY.md:17`) y David usa Hebra en Fedora. Con GW2 a pantalla
  completa los avisos pueden no verse y, si el escritorio pone su sonido, sonar dos veces. Lo que hace Hebra por su
  cuenta (urgencia y silencio por defecto) no se ha leído: el efecto real está sin medir; la pérdida en el plugin sí.
- Acción: leer la implementación de `notify.system` de Hebra (0,5 h). Si no fija crítico y silencio, pedir a Hebra un
  campo opcional en la API (2 a 4 h en Hebra) y pasarlo desde `hebra-host.ts` (1 h con tests).

### HP-02. El candado de vida está activo en Hebra sobre Linux sin sonda, donde el propio código dice que puede ser peor

- Evidencia: `src/host/hebra/entry.ts:19` pasa `navigator.locks`; `hebra-host.ts:116-124`: «A second PROCESS is ruled
  out for certain only on macOS… two live Hebras would each see the other's lock free… Handed over by the integrator's
  decision of 9 Oct 2026, from reading the code and with no probe on a real client». `ESTADO.md:66-72`: con dos
  procesos y propietario a 15 s o más, 14 de 120 frente a 120 de 120 sin candados; «Windows, sin verificar».
- Impacto: en la combinación de David (Fedora + Hebra rpm) el caso de dos procesos vivos sobre los mismos datos se
  resuelve peor con candados que sin ellos. La activación no la decidió David.
- Acción: sonda en Fedora (matar Hebra con sesión en vivo y abrir otra, leer `life_lock_*` y `taken` del registro
  local, como dice `ESTADO.md:85`), 1 a 2 h. Mientras tanto, decisión de David: mantener o `locks: null` (0,5 h más
  una release).

## Medio

### HP-03. Ninguna versión con cambios para Hebra se ha verificado instalada y cargada en un Hebra real, y no hay herramienta para hacerlo

- Evidencia: `ESTADO.md:10-14` (0.6.24: «nada… se ha ejecutado en un Hebra ni en un Obsidian reales»), `:48` («el
  arranque de Hebra con el motor mudo no se probó»), `:158-161` (0.6.22) y `:231-235` (0.6.21: solo una captura de la
  Sesión). `scripts/verify-beta-runtime.mjs` solo consulta Obsidian (`app.plugins.manifests`).
- Impacto: lo que diverge en la matriz solo está probado contra falsos.
- Acción: un guion de QA corto para Hebra (instalar desde la release, versión cargada, abrir Sesión, Inventario,
  Venta, ajustes, un comando no disponible) y, si la API lo permite, una evidencia leíble como la de Obsidian. 2 a 3 h.

### HP-04. El adaptador de Hebra escribe su interfaz solo en castellano

- Evidencia: `hebra-host-ui.ts:159` («`«${command.name}» no está disponible ahora.`»); `hebra-host.ts:226`, `:231`,
  `:519`; `unadopted-panel.ts:35,37,42,76-89,108` (con `toLocaleString('es-ES')`); `setting-row.ts:326,333,359`;
  `folder-picker.ts:18,145,151`. El núcleo traduce `es|en` (`i18n.ts:2`, `ARCHITECTURE.md:720`) y el host conoce el
  idioma (`api.env.locale()`, `settings.language`).
- Impacto: un usuario en inglés ve en Hebra avisos, el panel de notas no adoptadas, el selector de carpeta y el diálogo
  de secretos en castellano; las 2 exportaciones de sesión, cuando no hay nada, avisan en castellano.
- Acción: pasar esos textos al catálogo (`i18n-runtime-catalog.ts`) con el traductor del núcleo, y dar
  `unavailableReason` a los dos comandos de exportación. 3 a 4 h.

### HP-05. Obsidian y Hebra en la misma máquina, los dos como recolector, no se coordinan

- Evidencia: almacenes separados por app; la reserva de sesión y el candado viven en el IndexedDB de cada una
  (`coordination-coordinator.ts:66-67`). `INSTALAR-WINDOWS-DETALLE.md:344-357`: los dos usan el 47823, el segundo
  reintenta 5 veces y se rinde; «No se ha probado con las dos abiertas».
- Impacto: dos recolectores pidiendo a la API y escribiendo notas, cada uno en su bóveda; el addon solo habla con el
  que tenga el puerto. No hay pérdida de datos leída, pero sí trabajo doble y sesiones partidas.
- Acción: decisión de David (regla «una app a la vez» o detección). Documentarlo como regla en `BETA.md`: 0,5 h;
  detectarlo (p. ej. por el `EADDRINUSE` del puente con aviso explícito): 2 h.

## Bajo

### HP-06. `hebra-plugin-api` fijado en v1.3.0; v1.4.0 publicada

- Evidencia: `package.json:81`; `compare/v1.3.0...v1.4.0` arriba. Solo añade `markdown.image.remote` y endurece el
  falso.
- Acción: subir a v1.4.0 en una rama y correr los tests de `src/host/hebra` y `src/test` en Fedora (1 a 2 h). Usar la
  función nueva solo con decisión de David.

### HP-07. Bundle de Hebra 715 kB mayor por no renombrar identificadores

- Evidencia: tabla del apartado 5; `build-host-esm.mjs:86-90` frente a `esbuild.config.mjs:38,44`.
- Acción: comprobar las violaciones sobre una salida sin renombrar y publicar otra renombrada (o `keepNames` con
  renombrado y buscar `__require` por AST antes). 2 h, más una medida del tiempo de carga en Hebra.

### HP-08. En Hebra los títulos de vista no cambian con el idioma

- Evidencia: `hebra-host-ui.ts:84` (`title: view.title()` una vez); `tyrian-companion-core.ts:1594-1599`
  (`relabelListedSections` solo toca secciones). La API 1.3 tiene `ui.updateView(id, { title })` para cualquier
  colocación (`src/index.ts` de la API, comentario de `updateView`). En Obsidian `getDisplayText` relee
  (`obsidian-ui.ts:167`).
- Acción: llamar `updateView` para la vista principal y las tres de columna al cambiar idioma, con `api.has('ui.view.main')`.
  1 a 1,5 h.

### HP-09. La copia de trabajo del Mac no puede comprobar nada de Hebra

- Evidencia: `npx vitest run --maxWorkers=1 src/host/hebra/hebra-host-ui.test.ts` → «Cannot find package 'happy-dom'»,
  0 tests. `node` sobre el lockfile: 58 de 381 paquetes de primer nivel ausentes; directos ausentes: `happy-dom`,
  `hebra-plugin-api`. `node_modules/.package-lock.json` del 18 ago.
- Impacto: en este Mac no corren los tests de Hebra, ni `tsc`, ni `build:host-esm`; las medidas de ESTADO salen de
  Fedora.
- Acción: `npm ci` en el Mac cuando haga falta medir aquí (0,5 h; el lockfile pide `git+ssh` para la API).

### HP-10. Tokens de Hebra sin respaldo y documento de variables desfasado

- Evidencia: apartado 4 (7 tokens sin documentar ni respaldo; 54 frente a 49; `--x`, `--y` ausentes del doc).
- Acción: comprobar esos 7 tokens en el `app.css` de Hebra y añadir respaldo o fila al documento. 1 h.

### HP-11. Release: el contrato no mira `isPrerelease` ni la coherencia de `hebra.json`

- Evidencia: `brat-release-contract.mjs:34-43`; `rg isPrerelease scripts .github/workflows` sin resultados. Hoy
  coinciden versión y hashes (medido).
- Acción: añadir `isPrerelease === false` y, con los assets descargados, versión y sha256 de `hebra.json`. 1,5 h.
  Aparte, `obsidian-ui.ts:55,100-102` usa API privada (`rebuildView`, `app.setting`): riesgo solo de Obsidian, ya
  comentado en el código; sin acción.

### HP-12. Texto y diagnóstico que no distinguen host

- Evidencia: `i18n-runtime-catalog.ts:304,1474` («equipo suspendido u Obsidian cerrado») va en notas que también
  escribe Hebra (el test `i18n.test.ts:21-41` excluye `note.*` a propósito). `onUncaughtError`: Obsidian registra todo
  error de ventana (`obsidian-host.ts:114-133`), Hebra solo los de Tyrian (`hebra-host.ts:273-292`), así que el registro
  de Obsidian recoge fallos de otros plugins como `global_error`.
- Acción: texto neutro («la aplicación cerrada»), 0,5 h; filtro equivalente en Obsidian si David lo quiere, 1 h.

## Sin medir

### HP-13. Arranque de Hebra con el almacén mudo

- Evidencia: `hebra-host.ts:394-428` espera, antes de `runtime.start()`, la carga del índice (`TyrianPathIndex.load`,
  `path-index.ts:96-104`), que abre con `openIndexedDb` (10 s, `indexed-db-open.ts:130`) y una reapertura
  (`withIndexedDbReopen`). Si falla, el índice queda vacío y se siembra entero. Por lectura, hasta unos 20 s antes de
  los 20 s del núcleo. Además cada arranque normal pagina toda la carpeta de salida y relee el cuerpo de las notas sin
  marcador (`seed.ts:84-100`).
- Acción: un test con el falso de Hebra y el motor que no contesta, como `main-deferred-runtime-startup.test.ts`.
  2 a 3 h.

### HP-14. Proceso único y candados en Windows

- Evidencia: «Windows, sin verificar» (`ESTADO.md:68`). Sin lectura del código de Hebra para Windows.
- Acción: la misma sonda de HP-02 en Windows, 1 h.

### HP-15. Capacidades del webview en Hebra: imágenes remotas en paneles, portapapeles y audio

- Evidencia: los paneles cargan `<img>` de `render.guildwars2.com` (`live-session-panel.ts:58,721`); `hebra.json`
  declara `network.hosts` solo para `api.guildwars2.com` y `api.datawars2.ie` (correcto para `api.http`, pero la CSP
  del webview no se ha leído). `clipboard.writeText` usa `navigator.clipboard` (`hebra-host.ts:501-505`) y el sonido
  usa WebAudio sin gesto del usuario. `ESTADO.md:159`: «que los iconos carguen en el Hebra… reales» sin verificar.
- Acción: incluirlo en el guion de HP-03 (0,5 h dentro de ese coste).

### HP-16. Tests con el falso v1.4.0

- Evidencia: el falso nuevo lanza con ids repetidos de comando y bloque de código; `hebra-real-host.ts` solo emula las
  vistas. No hay `node_modules` aquí para probarlo.
- Acción: dentro de HP-06.

## Decisiones de David

1. Candado de vida en Hebra sobre Linux: mantenerlo activo hasta que haya sonda, o `locks: null` ya (HP-02).
2. Pedir a Hebra urgencia y silencio en `notify.system` (cambio en otro repo) o aceptar avisos normales en Linux
   (HP-01).
3. Idioma del adaptador de Hebra: traducirlo a `es|en` o declarar Hebra solo en castellano (HP-04).
4. Obsidian y Hebra a la vez: regla de una sola app o detección (HP-05).
5. `hebra-plugin-api` 1.4.0: subir ya; y si el plugin debe escribir iconos remotos en notas, sabiendo que un Hebra
   anterior enseña el texto alternativo con `|20` (HP-06).
6. Tamaño del bundle de Hebra: aceptar 2,68 MB o renombrar identificadores con otra comprobación (HP-07).

## Límites de este audit

- No se leyó el código de Hebra: lo que el adaptador cita de Hebra (ventanas, proceso único, CSP, notificaciones,
  tokens CSS) se toma de sus comentarios o queda sin medir.
- Ningún cliente real, ni Obsidian ni Hebra. Nada visto pintado.
- `node_modules` incompleto en el Mac: no se ejecutó ningún test (2 lanzamientos, los dos sin llegar a cargar: uno
  denegado por el hook de cwd, otro por `happy-dom` ausente), ni `tsc`, ni builds.
- Los bundles se midieron sobre los assets publicados de la 0.6.24 leídos por tubería; la cifra de 690 kB por nombres
  es una estimación por tokens.
- El diff v1.3.0 a v1.4.0 se leyó con `gh api`, no con el paquete instalado.
- No se recorrieron una a una las 39 llamadas de aviso del núcleo, solo su canal común.
