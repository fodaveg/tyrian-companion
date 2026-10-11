# Estado

## Canal 0.6.40 publicado: nota de sesión y transiciones del servicio de inicio fuera de sus clases (11 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.40` = `3ac3dbdd` (atestación; candidato `2f1410a4`,
árbol `7d6ed7cf`). Gate local verde (check 9/9 con 7191 tests, guardrails 25/25, BRAT PASS); CI 38103326498 y Release
38104003663 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.40` sobre el canal
0.6.39 publicado (`fcefcecf`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.40 se ha visto en un Obsidian ni en un Hebra reales.
- Contenido:
  - DE-01: `SessionNoteRuntime` (`src/runtime/session-note-runtime.ts`, dentro de la guarda de persistencia) con 12
    métodos de nota y resumen; el núcleo pasa de 5.788 a 5.660 líneas. El congelado que fijaba la búsqueda de la nota
    se redirige (0 llamadas a `readSession` en el núcleo, 1 en la fachada) y se añade un test de comportamiento.
  - DE-07, segunda mitad: `ManualSessionTransitions` (`src/sessions/manual-session-runtime-transitions.ts`, dentro de la
    guarda) con arranque, parada, recuperación, finalización al arrancar y reclamación; el servicio pasa de 1.839 a
    1.152 líneas. Los traductores de error HTTP llegan por el puerto (sin ciclo de imports). 51 mutaciones del puerto
    en rojo, 10 cubiertas con tests nuevos.
  - Revisiones independientes de los dos lotes: cuerpos idénticos y bundles de Hebra y Obsidian construidos.
- Pendiente: DE-01 (vista en vivo, lifecycleCore restante, farming, piloto, historial); un lease concedido tras cerrar
  no se libera (arreglo propuesto en `safeAcquire`). Verla en hosts reales.

## Canal 0.6.39 publicado: latido que no se rearma tras cerrar y núcleo y servicio de inicio partidos (11 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.39` = `0edf0754` (atestación; candidato `1435ce0a`,
árbol `caf5af73`). Gate local verde (check 9/9 con 7165 tests, guardrails 25/25, BRAT PASS); CI 38100300290 y Release
38101016324 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.39` sobre el canal
0.6.38 publicado (`9a667d06`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.39 se ha visto en un Obsidian ni en un Hebra reales.
- Contenido:
  - DE-01 paso 3, tercera parte: propuestas y detección asistida (18 métodos) a `LiveSessionRuntime`; comandos de sesión
    (11) a `SessionCommandRuntime` (`src/runtime/session-command-runtime.ts`). El núcleo pasa de 6.166 a 5.788 líneas.
    Las aserciones de texto congeladas de propuestas pasan a tests de comportamiento
    (`src/main-assisted-proposal-semantics.test.ts`), incluida la revisión aceptada que no presenta.
  - DE-07, primera mitad del servicio: `src/sessions/manual-session-start-service.ts` pasa de 2.244 a unas 1.840 líneas;
    salen el modelo, los errores, la evidencia, `ManualSessionWatch` y `ManualSessionHeartbeat`
    (`manual-session-runtime-heartbeat.ts`, dentro de la guarda de persistencia de security-scan).
  - Arreglo: `startHeartbeat` no arma el latido si el servicio ya está cerrado (cuatro caminos que lo hacían tras un
    `await` que sobrevivía al cierre). Tests nuevos del reinicio de la espera de reintento y de `disposed` en vivo.
  - Revisiones independientes: código movido idéntico por AST en los dos lotes; mutaciones del puerto en rojo.
- Límite conocido: un lease concedido después del cierre no se libera y caduca por su TTL, como en la base.
- Pendiente: DE-01 (lifecycleCore restante, nota y resumen, vista en vivo, farming, piloto, historial); DE-07 (arranque,
  parada, recuperación y reclamación del servicio). Verla en hosts reales.

## Canal 0.6.38 publicado: diario de sesión en una lectura y ciclo de la sesión en vivo fuera del núcleo (11 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.38` = `123c766b` (atestación; candidato `52a6eb3a`,
árbol `bced5eae`). Gate local verde (check 9/9 con 7123 tests, guardrails 25/25, BRAT PASS); CI 38095554382 y Release
38096215471 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.38` sobre el canal
0.6.37 publicado (`e40e2494`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.38 se ha visto en un Obsidian ni en un Hebra reales.
  WebKit (Hebra en macOS e iOS) no se ha medido: Playwright WebKit no arranca en este Fedora.
- Medido (M4, `docs/audit/m4-profile/2026-10-11-perfil.md`): los 2,1 s del audit del 8 oct ya no aparecen; `initialize()`
  con una sesión de 3 h tarda 41 ms (formato 1) y 5 ms (formato 2) con el almacén en memoria. Con `getAll`, una lectura
  del diario en Chromium pasa de 166 a 93 ms (formato 1) y de 8,4 a 2,4 ms (formato 2); con fake-indexeddb el arranque
  en formato 1 pasa de 219,5 s a 0,8 s (fake-indexeddb es cuadrático con el cursor, no el plugin).
- Contenido:
  - M4: `readLiveJournal` (`src/sessions/live-session-persistence.ts`) lee con `index('session').getAll`; 4 tests nuevos
    (rechazo de entrada inválida, orden, igual al cursor en formato 1 y 2).
  - DE-01 paso 3, segunda parte: `LiveSessionRuntime` (`src/runtime/live-session-runtime.ts`) con 28 métodos y 2 clases
    del ciclo de la sesión en vivo; el núcleo pasa de 6.580 a 6.165 líneas. Los tests congelados de texto que lo
    impedían pasan a tests de comportamiento (congelados 17 → 16). Revisión independiente: cuerpos idénticos por AST y
    28 de 30 mutaciones en rojo (una equivalente; la otra cerrada después).
- Pendiente de DE-01: 74 métodos de sesión (propuestas, comandos, nota y resumen, vista en vivo, farming) y algunas
  aserciones congeladas que fijan `loadSessionHistory` e `inspectCompletedSessionSummary`. Pendiente también: verla
  en hosts reales.

## Canal 0.6.37 publicado: orden interno del núcleo y copia de preferencias al descargar (11 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.37` = `18425f9c` (atestación; candidato `2cb68d07`,
árbol `93f69fb7`). Gate local verde (check 9/9 con 7072 tests, guardrails 25/25, BRAT PASS); CI 38089606480 y Release
38090381717 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.37` sobre el canal
0.6.36 publicado (`a252cbfa`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.37 se ha visto en un Obsidian ni en un Hebra reales.
  La copia de preferencias al descargar está probada con IndexedDB y ajustes simulados.
- Contenido:
  - DE-01 paso 3, parcial: `src/runtime/session-facade.ts` (`SessionRuntime`) con 35 métodos de sesión (métricas piloto,
    exportación y borrado del historial, preferencias de farming, sesiones en vivo guardadas); el núcleo deja 33
    delegados y baja de 6.778 a 6.580 líneas. Revisión independiente: 285 líneas movidas literalmente, sin cambio de
    comportamiento.
  - DE-08: 280 `export` quitados en `src/sessions` y `src/economy` (solo la palabra `export`, comprobado por script).
  - Lote K: `dispose()` de la copia de preferencias encadena una escritura final si hay una en curso; `setImmediate`
    en `EXACT_TIMERS` del test del bundle del asesor.
- Riesgo aceptado: `pilot-metrics-architecture.test.ts:78` solo lee el texto del núcleo y ya no ve los métodos del
  piloto movidos a la fachada.
- Pendiente de DE-01: unos 99 métodos de sesión (ciclo de la sesión en vivo, propuestas, nota y resumen, comandos)
  siguen en el núcleo porque tests congelados del contrato de texto fuente los fijan allí; moverlos exige pasar esos
  tests a comportamiento. Pendiente también: verla en hosts reales.

## Canal 0.6.36 publicado: Hebra arranca antes, copia de las preferencias y ajustes por equipo (11 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.36` = `c594d47e` (atestación; candidato `e17643b5`,
árbol `d8c9ab89`). Gate local verde (check 9/9 con 7015 tests, guardrails 25/25, BRAT PASS); CI 38084154301 y Release
38084940883 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.36` sobre el canal
0.6.35 publicado (`52fa782c`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.36 se ha visto en un Obsidian ni en un Hebra reales.
  Única medición real: `npm run hebra:verify-install` da PASS contra el Hebra real de Fedora (0.6.35, `release-bytes=match`),
  y en un Obsidian 1.14.4 flatpak desechable la 0.6.35 carga, `navigator.locks` existe y el plugin toma su candado al
  cargar sin clave. NO se midió: que la herramienta compruebe la carga, su ruta por defecto en macOS (supuesto), la
  reapertura ni que el candado muera con el proceso.
- Contenido por lote:
  - A: arranque de Hebra con almacén mudo (test HP-13) y guardado del índice de rutas en segundo plano (10 s en vez de 20).
  - B: comprobación de almacenes e índices al abrir (`schema_incomplete`), uso y tramo de cuota en el diagnóstico, y
    copia de las preferencias de inventario en los ajustes del host (esquema 16).
  - C: veredictos del candado a nivel warn, `verify-beta-runtime` con digests, `smoke:live` por versión,
    `hebra:verify-install` e informe JSON de vitest en CI.
  - D: vigilancia de «Tyrian» sin «Tyrian Old», «espacio desconocido», tests de comportamiento del asesor y fichero sin
    consumidor borrado.
  - E: avisos `prefer-create-el` de 61 a 5, `CoinFigure` sin `createElementNS`, `sha256` sin aserciones `!` y seis
    modales fuera de `companion-view.ts`.
  - F: `docs/QA-HEBRA.md` nuevo y matriz 0.6.x de `docs/QA-MVP.md`.
  - G: seis ajustes de Hebra (alerta en el juego, registro, última pasada) por equipo en `storage.device`.
  - H: evidencia de la carga en el Obsidian desechable.
- Riesgos aceptados:
  - Esquema 16: de la 0.6.29 a la 0.6.35 los ajustes quedan en solo lectura al recibir un `data.json` v16, y antes de la
    0.6.29 se borraría la copia.
  - Adopción única por equipo en Hebra: cada equipo toma una vez los valores compartidos que hubiera.
  - Esas claves quedan congeladas en los ajustes compartidos para que un equipo anterior vea valores coherentes.
  - Una biblioteca nueva no tiene copias de esas claves.
  - La copia de preferencias lleva el `accountId` de GW2 en `data.json` (excepción documentada en THREAT-MODEL).
  - La última escritura de la copia al descargar el plugin relee y guarda los ajustes: si en esos milisegundos la instancia
    siguiente guarda otro ajuste, ese se pierde; y una escritura normal ya en curso al descargar se pierde.
- Incidente: la segunda instancia flatpak reemplazó el socket del CLI de Obsidian de David (CLI y MCP de obsidian sin
  llegar a su instancia desde las 21:28 hasta que lo reactive); evidencia en
  [2026-10-10-obsidian-desechable](evidencia/2026-10-10-obsidian-desechable.md).
- Pendiente: verla en un Obsidian y un Hebra reales, Z19 (b) (darse por activado sin recorrer toda la
  carpeta), la parte de `manual-session-start-service.ts` de DE-07, y la reapertura de RT-03 y RT-15.

## Canal 0.6.35 publicado: Logros que leen el progreso, iconos de recompensas y carpeta de salida que se crea (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.35` = `7178ab40` (atestación; candidato `58950aaf`,
árbol `93bddfd2`). Gate local verde (check 9/9 con 6868 tests, guardrails 24/24, BRAT PASS); CI 38071948026 y Release
38072777859 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.35` sobre el canal
0.6.34 publicado (`c9ec5674`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.35 se ha visto en un Obsidian ni en un Hebra reales.
  No se sabe por qué la API rechazó la lectura de logros de David con una clave con todos los permisos: el plugin no
  guardaba el motivo; desde esta versión lo guarda como código cerrado. Las redacciones exactas de los rechazos de
  ArenaNet no están medidas con una clave real; si no coinciden, decide `tokeninfo`. Que Hebra entregue
  `folder_name_taken` al plugin está leído en su código, no medido.
- Contenido: confirmación de `progression` con `tokeninfo`, reintento único de 401/403 y `apiReason` en el
  diagnóstico; elementos sin leer contados y explicados; iconos de todas las recompensas; creación de la carpeta de
  salida en Hebra solo en las pulsaciones de Aplicar, Reparar y Reemplazar.
- Riesgo aceptado: dos dispositivos que pulsan «Aplicar» antes de que el sync converja pueden dejar dos carpetas de
  salida hermanas, sin pérdida de datos.
- Pendiente: verla en un Obsidian y un Hebra reales. Guion corto, con la lista de candados `life_lock_*` y `taken`: [QA-HEBRA](QA-HEBRA.md).

## Canal 0.6.34 publicado: Terminar sesión, Descartar sesión, token del addon, Assets en Hebra, Logros y Venta (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.34` = `b6ec025a` (atestación; candidato `96c28614`,
árbol `9a1d12a5`). Gate local verde (check 9/9 con 6799 tests, guardrails 24/24, BRAT PASS); CI 38066638296 y Release
38067293180 en verde; `release:brat-verify` PASS con 8 assets, release normal. Rama `integracion/0.6.34` sobre el canal
0.6.33 publicado (`d1d39c0`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.34 se ha visto en un Obsidian ni en un Hebra reales.
  Todo está medido en tests con relojes y candados inyectados y con el fake de la librería de Hebra. No está medido que
  el webview de Hebra dé `navigator.locks` a los plugins; sin candados, la reserva huérfana tarda hasta 5 min. Tampoco
  está confirmado con un log real que el bloqueo de «Terminar sesión» visto en la 0.6.33 fuera el reloj atrasado.
- Contenido: Terminar sesión con reloj atrasado (sello que no retrocede, reserva por delante vigilada con reloj
  monótono, `+1` al renovar) y «Descartar sesión»; token del addon con «Crear token»; Assets en Hebra (puntero viejo
  fuera del vault, mover según la ruta, motivos en la fila); Logros (108 conjuntos de la wiki generados por
  `scripts/generate-known-achievement-sets.mjs`, duplicados por nombre, textos para listas vacías, casillas por CSS);
  Venta (animación, plazo de 60 s, «Actualizar» en la cabecera).
- Cada lote pasó revisión independiente (de dos a cuatro vueltas) con pruebas negativas; el censo de observabilidad se
  declaró por script en cada fusión.
- Límite conocido: durante una actualización con dos ventanas de builds distintos y el reloj parado, la nueva puede
  quitar la reserva a la vieja a los 5 min (sin corrupción, por el fence).
- Pendiente: verla en un Obsidian y un Hebra reales.

## Canal 0.6.33 publicado: el icono de Logros se ve en Hebra (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Etiqueta `0.6.33` = `d1d39c0`. Cambia el icono de la sección
Logros de `trophy` a `circle-check`, que Hebra pinta. Publicada sin el gate local completo, a petición de David; CI y
Release de GitHub en verde y `release:brat-verify` PASS con 8 assets.

## Canal 0.6.32 publicado: Logros con elementos, nombres e iconos, iconos en el resumen de sesión y Venta fuera del núcleo (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Rama `integracion/0.6.32` sobre el canal 0.6.31 publicado
(`ed1d596`, docs `5b8ff66`); añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de
`package-lock.json` y `versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en
[ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.32 se ha visto en un Obsidian ni en un Hebra reales.
  Todo está medido en tests. No está medido que Hebra deje cargar imágenes remotas en el DOM de la vista del plugin;
  el historial de precios y el inventario ya lo hacen, y si se bloquease quedaría el nombre sin icono.
- Contenido: Logros L3 (nombres de recompensas y objetivos desde las listas públicas, caché de 7 días con negativos,
  texto reescrito en su sitio para conservar el foco) y L4 (elementos de cada seguido con casilla, enlace y progreso;
  maestrías de mapa por categoría; iconos de objetos, minimascotas y aspectos); iconos en la tabla de objetos del
  resumen de sesión (N5); `hebra-main.mjs` minificado (HP-07); diagnóstico sin falsos avisos y plazo al abrir
  almacenes (HP-12); DE-01 paso 2 (`SaleRuntime` fuera del núcleo); GR-04 y GR-13 (tests de comportamiento de vuelta
  en `check`).
- Publicación (medida el 10 oct 2026). Tag `0.6.32` sobre `f50b922` (commit de atestación; candidato `1a67eaa`;
  árbol `843f05d65f6fd6724b9538993071b89bd038e040`). CI de GitHub: run `38052588883`, success. Workflow de release: run
  `38053241181`, success. «BRAT release contract: PASS (version=0.6.32; assets=8)» sobre la salida real de
  `gh release view 0.6.32 --json tagName,name,isDraft,isPrerelease,assets`, con `isDraft` false e `isPrerelease` false.
  SHA-256 del zip `tyrian-companion-0.6.32.zip`: `47eff2fadc46d2f4daff5a66e8a54ec9c58284a9364c17b604e88687d7bb4c95`.
- Pendiente: verificar la instalación y la carga de la 0.6.32 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Canal 0.6.31 publicado: Halloween sin esperas, reserva de sesión con reloj monótono y almacenamiento persistente (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Parte de `61f8ab7` (rama `integracion/0.6.31` sobre el canal
0.6.30 publicado, `395d1e0`) y añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de
`package-lock.json` y `versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.31 se ha visto en un Obsidian ni en un Hebra reales.
  Todo está medido en tests.
- Contenido: «Comprobar conexión» no espera al recorrido de notas de sesión de Halloween, el primer botín sí, y la
  conexión caída durante el recorrido sigue mostrándose como «sin conexión»; la reserva propia de la sesión en vivo se
  ordena con el reloj monótono, de modo que un reloj de sistema retrasado ya no la deja en error (DU-09); petición única
  de almacenamiento persistente al cargar, con su respuesta en el diagnóstico (DU-13); división del núcleo en módulos de
  funciones de venta y de resultados de acciones, y del modelo de vista del Asesor, con el censo y la guarda de i18n al
  día; `noImplicitOverride` activado con los métodos sobrescritos marcados.
- Publicación (medida el 10 oct 2026). Tag `0.6.31` sobre `ed1d596` (commit de atestación; candidato `8ea78e4`;
  árbol `c075fdede32829e07d5217239af134856c25b3b8`). CI de GitHub: run `38048257013`, success. Workflow de release: run
  `38048701653`, success. «BRAT release contract: PASS (version=0.6.31; assets=8)» sobre la salida real de
  `gh release view 0.6.31 --json tagName,name,isDraft,isPrerelease,assets`, con `isDraft` false e `isPrerelease` false.
  SHA-256 del zip `tyrian-companion-0.6.31.zip`: `4b15027e96c6689ba76f818a6b73a99c76c424558ed80e269e5264f297a38e20`.
- Pendiente: verificar la instalación y la carga de la 0.6.31 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Canal 0.6.30 publicado: sección Logros, historial acotado a las notas de Tyrian y almacenes locales que se recuperan solos (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Parte de `fe32b78` (rama `integracion/0.6.30` sobre el canal
0.6.29, `810b411`) y añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.30 se ha visto en un Obsidian ni en un Hebra reales.
  Todo está medido en tests. En particular, la sección Logros (buscador, seguimiento, contador en Hebra y el botón
  «Actualizar»), la lectura del historial acotada a las notas de Tyrian y la recuperación de los almacenes secundarios
  tras un cierre de conexión del motor no se han visto en un cliente.
- Contenido: cuarta sección Logros en Obsidian y Hebra, con ajustes en la versión 15; historial y comparador que solo
  leen las notas de sesión de Tyrian y panel que sale de «arrancando» (Z20, Z24); ocho almacenes secundarios que reabren
  su conexión, calidad de detección por vault con tope de 2000 eventos y aviso de Halloween que no se pierde (DU-05,
  DU-08); `dev:install` y `smoke:live` sin bóveda por defecto (RT-08); verificador de runtime en el artifact de CI
  (RT-12); lint del gate sin caché (DE-18); tests de arranque de punta a punta (GR-05) y sin plazos de reloj (GR-07,
  GR-10); plan medido para dividir el núcleo (DE-01).
- Publicación (medida el 10 oct 2026). Tag `0.6.30` sobre `e9ea2be` (commit de atestación; candidato `f355ee2`;
  árbol `57972100b2c9387a19d5913f7bb398ff6ee98dab`). CI de GitHub: run `38046278903`, success. Workflow de release: run
  `38046819038`, success. «BRAT release contract: PASS (version=0.6.30; assets=8)» sobre la salida real de
  `gh release view 0.6.30 --json tagName,name,isDraft,isPrerelease,assets`, con `isDraft` false e `isPrerelease` false.
  SHA-256 del zip `tyrian-companion-0.6.30.zip`: `39deb682a78f01c25786c80da9ee1b00ec19bf4eb86a3864e0003759bc7edcb0`.
- Pendiente: verificar la instalación y la carga de la 0.6.30 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Canal 0.6.29 publicado: historial con nota abrible, ajustes de versión más nueva respetados y cola de confirmaciones por vault (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Parte de `15c9363` (rama `integracion/0.6.29` sobre el canal
0.6.28, `3ee0c30`) y añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.29 se ha visto en un Obsidian ni en un Hebra reales.
  Todo está medido en tests. En particular, la fecha del historial que abre la nota (y el aviso de nota desaparecida), el
  arranque con ajustes de una versión más nueva (DU-04) y la copia inicial de la cola común a la de cada vault (DU-03) no
  se han visto en un cliente.
- Contenido: la fecha de cada sesión del historial abre su nota de resumen, con aviso si ya no existe; ajustes guardados
  por una versión más nueva se usan sin escribirlos, con aviso y explicación al guardar (DU-04); una cola de
  confirmaciones por vault, con copia única de las propuestas pendientes de la cola común antigua (DU-03). Interno:
  exports sin uso (DE-09), fixtures movidas (DE-14), ARCHITECTURE con la matriz de imports generada desde el código
  (DE-15), plazos de los tests de arranque (GR-09) y ESTADO de la 0.6.24 (RT-11).
- Fuera de esta versión: la sección Logros va en la 0.6.30.
- Publicación (medida el 10 oct 2026). Tag `0.6.29` sobre `1b3ee6b` (commit de atestación; árbol
  `842deb08019458b67e8ce6786b693ad998099d63`). CI de GitHub: run `38041097149`, success. Workflow de release: run
  `38041768008`, success. «BRAT release contract: PASS (version=0.6.29; assets=8)» sobre la salida real de
  `gh release view 0.6.29 --json tagName,name,isDraft,isPrerelease,assets`, con `isDraft` false e `isPrerelease` false.
  SHA-256 del zip `tyrian-companion-0.6.29.zip`: `82f7c998a85c9421703b805513a5e809f7021693bc3a02ec98da3c80b031a257`.
- Pendiente: verificar la instalación y la carga de la 0.6.29 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Canal 0.6.28 publicado: aviso de vault movido, cursor de gráfica estable y aviso de puerto ocupado (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Parte de `952a393` (rama `integracion/0.6.28` sobre el canal
0.6.27) y añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.28 se ha ejecutado en un Hebra ni en un Obsidian
  reales. Todo está medido en tests. En particular, la pregunta de vault movido (DU-02) no se ha visto con un vault
  renombrado de verdad, y el cursor de la gráfica en ventana emergente (N8) y el aviso de puerto ocupado (HP-05) no se han
  visto en un cliente.
- Contenido: aviso y pregunta al renombrar o mover el vault, con «Aplicando…» y botones desactivados (DU-02), cursor de la
  gráfica de sesión sin saltos y en ventana emergente (N8), aviso de puerto del juego ocupado (HP-05) y poda del historial
  de precios que retira filas ilegibles (DU-07). Interno: THREAT-MODEL con las nueve bases (DU-10), regla de dirección de
  capas con test (DE-02), retirada del panel de alertas sin montar y de un script huérfano (DE-05, GR-12).
- Publicación (medida el 10 oct 2026). Tag `0.6.28` sobre `55abc0c` (commit de atestación; árbol
  `433f4d8cfd2438c34481a849291c187c0f99d754`). CI de GitHub: run `38037523960`, success. Workflow de release: run
  `38038673325`, success. «BRAT release contract: PASS (version=0.6.28; assets=8)» sobre la salida real de
  `gh release view 0.6.28 --json tagName,name,isDraft,isPrerelease,assets`, con `isDraft` false e `isPrerelease` false.
  SHA-256 del zip `tyrian-companion-0.6.28.zip`: `a957d9c48beee7522b2310862ac65c14a1483ca7e689871f62bcf2cb72a2fba0`.
- Pendiente: verificar la instalación y la carga de la 0.6.28 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Canal 0.6.27 publicado: logros de Leyspring, notas de sesión legibles, gráfica con burbuja y Hebra en dos idiomas (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Parte de `ae78f66` (rama de integración de la 0.6.27 sobre el canal 0.6.26
publicado) y añade los metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y
`versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.27 se ha ejecutado en un Hebra ni en un Obsidian
  reales. Todo está medido en tests. En particular, el comando de logros de Leyspring no se ha probado con una clave
  real con el permiso `progression`, y la gráfica con burbuja (ratón, táctil, teclado) no se ha visto en un cliente.
- Contenido: comando de logros de Leyspring (también en modo Consulta, excepción explícita), tramos de mapa y nota
  completa legible en las sesiones en vivo (N7), gráfica de sesión con línea y burbuja (N8), Hebra en castellano e inglés
  (HP-04, HP-08), una valoración por objeto y una reconstrucción al restaurar (Z34, M4) y reparación de bases de sesión
  en versión 1 (DU-01). Interno: `hebra-plugin-api` 1.4.0 y guardarraíles de CI y release.
- Fuera de esta versión: DU-02 (vault renombrado o movido) queda para la 0.6.28 (decisión de David del 10 oct 2026).
- Publicación (medida el 10 oct 2026). Tag `0.6.27` sobre `bbad01f` (commit vacío de atestación; árbol
  `d421f44862e125fe47115cef07b2b6409c6e2b0c`). CI de GitHub sobre `bbad01f`: run `38034885252`, success; `check`
  «VEREDICTO: VERDE (9/9)», `check-guardrails` «VEREDICTO: VERDE (24/24)» y `release-package` en success; `rust-*` y
  `h8-spike` saltados. Workflow de release: run `38035547602`, success. «BRAT release contract: PASS (version=0.6.27;
  assets=8)» sobre la salida real de `gh release view 0.6.27 --json tagName,name,isDraft,isPrerelease,assets`, con
  `isDraft` false e `isPrerelease` false; assets subidos (bytes): `hebra-main.mjs` 2740011, `hebra-styles.css` 124527,
  `hebra.json` 29593, `main.js` 2008374, `manifest.json` 237, `styles.css` 98545, `tyrian-companion-0.6.27.zip` 2107466
  y su `.sha256` 94. Quien verifique una publicación debe pedir `isPrerelease` a GitHub: sin ese campo el contrato
  da `release-prerelease`.
- Pendiente: verificar la instalación y la carga de la 0.6.27 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Cinco audits de solo lectura: evidencia en hosts reales, guardarraíles, almacenamiento local, paridad de hosts y deuda estructural (10 oct 2026)

**Nada implementado; solo informes, notas y tareas.** Encargo de David del 10 oct 2026: un metaaudit recomendó cinco
audits y después pidió «lanzalos todos y después crea notas en hebra y proyectos en lumbre». Cinco agentes de solo
lectura auditaron `main` en `6fbe77e` (0.6.24 publicada) desde el Mac. Mientras corrían, `origin/main` avanzó 74 commits
hasta `670ead57` (candidata 0.6.26, integrada desde Fedora). Cada tarea de Lumbre empieza por la lista de ficheros
citados que cambiaron en ese tramo, y cada hallazgo hay que contrastarlo con el `main` vigente antes de implementarlo.
Los ficheros clave de los hallazgos graves (`src/sessions/session-storage-scope.ts`, `src/core/settings.ts`,
`scripts/gate-steps.mjs`, los workflows de `.github/workflows/`, `src/host/hebra/entry.ts`, `docs/QA-MVP.md`) no
cambiaron entre `6fbe77e` y `670ead57`.

Hallazgos por severidad: Alto / Medio / Bajo / Sin medir. Cada proyecto de Lumbre está anidado en «21.15 Tyrian
Companion»; cada nota de Hebra está en la carpeta «21.15 tyrian companion» y vinculada a su proyecto con `link_list_note`.

| Audit | Informe | Hallazgos (A / M / B / S) | Decisiones | Proyecto de Lumbre | Nota de Hebra |
| --- | --- | --- | --- | --- | --- |
| Evidencia de ejecución en hosts reales | `docs/audit/2026-10-10-evidencia-runtime.md` | RT-01 a RT-18: 5 / 5 / 2 / 6 | 4 | «Tyrian Companion · evidencia de ejecución en hosts reales (audit 10 oct 2026)» (22 tareas) | «Tyrian Companion - Audit de evidencia en hosts reales (2026-10-10)» |
| Red de guardarraíles y tests | `docs/audit/2026-10-10-guardarrailes-y-tests.md` | GR-01 a GR-18: 3 / 5 / 8 / 2 | 5 | «Tyrian Companion · red de guardarraíles y tests (audit 10 oct 2026)» (23 tareas) | «Tyrian Companion - Audit de guardarraíles y tests (2026-10-10)» |
| Durabilidad del almacenamiento local | `docs/audit/2026-10-10-durabilidad-almacen.md` | DU-01 a DU-15: 2 / 3 / 6 / 4 | 4 | «Tyrian Companion · durabilidad del almacenamiento local (audit 10 oct 2026)» (19 tareas) | «Tyrian Companion - Audit de durabilidad del almacenamiento local (2026-10-10)» |
| Paridad entre Obsidian y Hebra | `docs/audit/2026-10-10-paridad-hosts.md` | HP-01 a HP-16: 2 / 3 / 7 / 4 | 6 | «Tyrian Companion · paridad entre Obsidian y Hebra (audit 10 oct 2026)» (22 tareas) | «Tyrian Companion - Audit de paridad entre Obsidian y Hebra (2026-10-10)» |
| Deuda estructural y tipado | `docs/audit/2026-10-10-deuda-estructural.md` | DE-01 a DE-21: 2 / 7 / 8 / 4 | 6 | «Tyrian Companion · deuda estructural y tipado (audit 10 oct 2026)» (27 tareas) | «Tyrian Companion - Audit de deuda estructural y tipado (2026-10-10)» |

En total son 88 hallazgos, todos como tareas `@acked` en su sección de severidad (Alto p1, Medio p2, Bajo p3, Sin medir
p4), y 25 decisiones de David en secciones «Decisiones de David» (p1, sin estado de agente).

Lo más grave:

- RT-01: la 0.6.24 YA está instalada en los dos hosts del Mac y nadie lo había anotado. Hebra 0.2.0 (149) la instaló a
  las 04:38Z del 10 oct sustituyendo a la 0.6.22 (que también estuvo instalada, cosa que la entrada de la 0.6.24 niega),
  y BRAT la instaló en la bóveda canónica de Obsidian a las 07:40 hora local. Los ficheros coinciden byte a byte con los
  assets de la release. Lo que sigue sin comprobar es que CARGUE. La frase «nada de la 0.6.24 se ha ejecutado en un
  Hebra ni en un Obsidian reales» de la entrada de abajo queda matizada así (esa entrada no se reescribe).
- RT-02 y GR-01 (el mismo hecho desde dos audits): `src/host/hebra/bundle.test.ts` es el único test que importa el
  `hebra-main.mjs` publicado y se salta en CI y en la release (`describe.runIf(existsSync(BUNDLE))`, el paso `unit` va
  antes que `host-esm` en `scripts/gate-steps.mjs` y el fichero está en `.gitignore`). Es el «1 skipped» de GitHub. En
  local pasa porque queda un bundle de builds anteriores.
- GR-02: `release.yml` publica tras `npm run check` solo, sin `check:guardrails` y sin depender del CI del mismo commit.
- GR-03: quedan esperas de tiempo fijo de la familia que tumbó la 0.6.23 (50 ms reales en tres tests del host de
  Hebra; `settle()` de 5 macrotareas en `main-collector-mode.test.ts`, usado 22 veces) y `TYRIAN_TEST_ENGINE_LATENCY_MS`
  no la fija ningún gate.
- DU-01: `resolveSessionStorageNames` (`src/sessions/session-storage-scope.ts`) abre la base de sesión antigua sin
  sufijo de vault en versión 2 con solo el almacén antiguo, así que esa subida de v1 a v2 nunca crea
  `live-inventory-journal-v1`. En el vault que adoptó esa base toda transacción del diario en vivo da `NotFoundError` y
  `saveLive` contesta `unavailable` para siempre. Reproducido con `fake-indexeddb`; ningún test siembra una base en v1.
  Comprobación en los equipos reales (DU-15), solo lectura desde la consola:
  `(await indexedDB.databases()).map(d => [d.name, d.version])` y mirar `objectStoreNames` de
  `tyrian-companion-session-runtime`.
- DU-02: `vaultId` es el SHA-256 de la ruta absoluta del vault. Mover o renombrar la carpeta deja huérfano en silencio
  todo lo local (preferencias de inventario, historial de precios, Halloween, sesión y reserva) y puede devolver un
  equipo en `consult` a `collector`.
- HP-01 y HP-02: en Hebra los avisos del sistema van sin `urgency: 'critical'` ni `silent: true` (la API no lo admite),
  y el candado de vida está activo en Hebra sobre Linux (`src/host/hebra/entry.ts`) sin sonda, donde el propio código
  dice que con dos procesos vivos resuelve peor que sin candados.
- DE-01 y DE-02: `src/runtime/tyrian-companion-core.ts` es una clase de 6.694 líneas con 159 imports de 13 carpetas y
  unos 309 miembros. 14 de las 16 carpetas de `src/` forman un solo ciclo de imports, con `core` importando dominio
  desde `core/settings.ts`.
- DE-03, que corrige una premisa del metaaudit: la cifra de lint de la entrada de la 0.6.24 (117 avisos) es correcta.
  Los 1.639 errores que da `eslint` en el Mac salen de que su `node_modules` es del 18 ago y le faltan
  `hebra-plugin-api` y `happy-dom` (360 paquetes frente a 442 del lockfile): sin ellos, `src/host/hebra/` se tipa como
  `any`. En el Mac, `check` saldría rojo hasta pasar `npm ci`. Tampoco hay ningún `innerHTML` en la fuente: los 84
  `prefer-create-el` señalan `document.createElement`, y el arreglo que sugiere la regla (`document.win.createEl`)
  rompería la vista en Hebra, cuyo polyfill no define `win`.

Qué no se hizo: ningún gate, suite completa ni build en esta sesión (el `node_modules` del Mac no sirve para medirlos);
ningún test en Obsidian ni Hebra reales; no se tocó código. El CI de GitHub sobre el commit de documentación
  (`6500b843`, run `38029515920`) salió en ROJO por `bench:h6-live-session` («end-of-session p95 113.92ms > 100ms»), el
  mismo paso y la misma cifra que el CI de `670ead57` (run `38028453458`, «p95 114.43ms»); el último verde es `6fbe77e`.
  Un commit solo de docs no cambia el bench: el exceso viene de la 0.6.25/0.6.26 o del runner. Tarea `e2e3923b` en el
  proyecto de guardarraíles. **Resuelto el 10 oct 2026:** `b6e8656` evita valorar dos veces un objeto del que no ha
  salido nada del inventario, y el CI de `af030b0` (run `38030787443`) está en verde, con `bench:h6-live-session`
  incluido (p95 al final 70,7 ms, máximo 100). Desde `af030b0` el CI de `main` ya no está rojo.

Dónde seguir: las 25 decisiones están en las secciones «Decisiones de David» de los cinco proyectos de Lumbre. El guion
humano de 30 minutos para comprobar la carga de la 0.6.24 en el Mac está en el apartado 3 de la nota «Tyrian Companion -
Audit de evidencia en hosts reales (2026-10-10)».

## Canal 0.6.26 publicado: hallazgo mágico con repeticiones, notas de inventario que respetan comentarios y catálogo por lotes (10 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Es la única que se publicó y contiene la 0.6.25, que no se publica ni se etiqueta
nunca: quien actualice pasa de la 0.6.24 publicada a la 0.6.26. Parte de
`80719eb` (rama de integración que ya contiene la 0.6.25 y estos lotes) y añade los metadatos de versión (`manifest.json`,
`package.json`, la raíz de `package-lock.json` y `versions.json`, mínimo de Obsidian 1.11.4). Detalle en
[CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.26 se ha ejecutado en un Hebra ni en un Obsidian
  reales. Todo está medido en tests.
- Medido con una cuenta real el 10 oct 2026: el hallazgo mágico por logros sumaba 19 986 puntos (11 %), el juego
  muestra 21 369 (13 %) y ahora suma 21 376 (13 %). Los puntos mensuales no se suman porque en esa cuenta valen 0 y no
  se pudieron validar.
- Medido solo con IndexedDB simulado: guardar un lote de 200 objetos del catálogo en una transacción en vez de 200
  (mediana de 10,2 ms a 5,0 ms). No hay medida en un cliente real.
- Notas de inventario: los comentarios YAML de la cabecera se conservan, la fila se valora solo por las pilas que se
  pueden vender y un objeto que el catálogo devuelve mal conserva en su nota nombre, tipo, rareza e icono. Cierra el
  límite conocido de la 0.6.25 sobre el nombre de reserva. Límites que quedan: un `#` suelto, las líneas en blanco
  dentro de un bloque de comentarios se pierden, y un comentario en línea al final de una clave gestionada pasa a una
  línea propia.
- Sesión en vivo, gráfico: cada cambio de precios revalora el gráfico entero y, en formato 2, cada valoración calcula la
  comisión del bazar. `b6e8656` evita valorar dos veces un objeto del que no ha salido nada del inventario (p95 al final
  de una sesión larga de 85 a 66-72 ms en las pruebas; formato 1, 48 ms). El resto queda como tarea (Z34). El CI de
  `670ead5` salió rojo por `bench:h6-live-session` y por eso no se etiquetó.
- Publicación (medida el 10 oct 2026). Tag `0.6.26` sobre `af030b0` (commit de atestación). CI de GitHub sobre `af030b0`:
  run `38030787443`, success, con `bench:h6-live-session` (p95 al final 70,7 ms en el CI, máximo 100). Workflow de
  release: run `38031373642`, success. «BRAT release contract: PASS (version=0.6.26; assets=8)» sobre la salida real de
  `gh release view 0.6.26`; assets subidos (bytes): `hebra-main.mjs` 2698729, `hebra-styles.css` 122387, `hebra.json`
  29593, `main.js` 1977888, `manifest.json` 237, `styles.css` 96405, `tyrian-companion-0.6.26.zip` 2074840 y su
  `.sha256` 94. La 0.6.25 nunca se publicó.
- Pendiente: verificar la instalación y la carga de la 0.6.26 en un Obsidian y un Hebra reales. Nada de eso se ha
  comprobado.

## Candidato 0.6.25: sesiones en formato 2, resumen de sesiones, ajustes que no se pisan y arranque más ligero (10 oct 2026)

**Nunca publicada ni etiquetada: su contenido sale en la 0.6.26, que es la única candidata.** Se conserva como
historial de lo que reunió. Parte de `6fbe77e` (`main` con el canal 0.6.24 publicado) y reúne nueve lotes
integrados en `f14b3a6`, más el renombrado de la marca `painted` de la traza de arranque a `renderRequested` y los
metadatos de versión (`manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json`, mínimo de
Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md), en [SPEC-live-loot](SPEC-live-loot.md) §4 y §6.0 y en
[ARCHITECTURE](ARCHITECTURE.md).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.25 se ha ejecutado en un Hebra ni en un Obsidian
  reales. La 0.6.24 publicada sí se vio en un Hebra real (cierre brusco incluido), pero esta candidata no.
- Gate local sobre `f14b3a6`: «VEREDICTO: VERDE (8/8)» (5957 tests) y guardarraíles «VEREDICTO: VERDE (25/25)». El
  commit final de la candidata (renombrado, metadatos y documentación) lo pasa de nuevo el integrador antes de etiquetar.
- Sesiones en formato 2: las sesiones que empiezan con esta versión guardan el precio bruto y ninguna entrada para las
  muestras que no cambian nada. Después de una de ellas no se puede volver a la 0.6.24 ni a una anterior (límite
  aceptado, [SPEC-live-loot](SPEC-live-loot.md) §6.0, límite 1).
- Límites conocidos de la 0.6.25: el tamaño del registro de depuración que muestran los ajustes sale como «al menos»
  hasta la primera rotación o exportación. El del nombre de reserva en notas de inventario lo cierra la 0.6.26.
- La marca `renderRequested` de la traza de arranque (antes `painted`) no mide el primer pintado visible: el repintado
  es diferido, y la marca dice que la inicialización terminó y que se pidió.
- Pendiente: el de la 0.6.26 (el gate sobre el commit definitivo, su publicación y verla en un cliente real). La 0.6.25
  no tiene pendientes propios porque no se publica.

## Canal 0.6.24 publicado: el arranque con el almacenamiento mudo y la sesión en vivo tras un cierre brusco (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** Es la 0.6.23 que no llegó a publicarse, con los tests del arranque arreglados (ver abajo). Parte de `efe671f` (`main` con el canal 0.6.22 publicado). Trae dos lotes
de robustez, sin cambios de interfaz, y los metadatos de versión (`bc41145` para la 0.6.23 y, para la 0.6.24, el commit de metadatos que la sigue: `manifest.json`, `package.json`, la raíz
de `package-lock.json` y `versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md), en
[SPEC-live-loot](SPEC-live-loot.md) §4 y en [ARCHITECTURE](ARCHITECTURE.md) («Coordinación de sesión activa»).

- Sin verificar, y es lo primero que hay que saber: nada de la 0.6.24 se ha ejecutado en un Hebra ni en un Obsidian
  reales. Todas las cifras de abajo salen de tests sobre un IndexedDB falso, un gestor de candados en memoria y un reloj
  simulado. Ningún almacén se ha quedado mudo de verdad, ninguna aplicación se ha cerrado de golpe de verdad, y no se ha
  comprobado en ningún host que `navigator.locks` exista, que su candado muera con el proceso ni qué procesos lo
  comparten.
- Por qué 0.6.24 y no 0.6.23. La etiqueta `0.6.23` se empujó sobre `969d874` y su release no se publicó: el gate del
  workflow de release (run `37979072442`) y el CI (run `37979062119`) fallaron siempre en los mismos 2 tests del
  arranque («Tests 2 failed | 5879 passed | 1 skipped (5882)»). La etiqueta se queda sin release y sin mover. Entre la
  0.6.23 etiquetada y la 0.6.24 no hay cambio de producto: solo tests (`a734137`) y metadatos.
- Un gate local verde no acredita el de GitHub para tests con temporizadores. El gate local sobre `dd2bbce` dio
  «VEREDICTO: VERDE (8/8)», «VEREDICTO: VERDE (25/25)» y «Tests 5882 passed (5882)», y GitHub dio rojo. Los tests
  medían con un número fijo de turnos y dependían de la velocidad. Reproducción local antes del arreglo: con 48 bucles
  de CPU en 24 hilos, 4 de 5 corridas rojas; con un motor simulado que contesta cada apertura con 30 ms de retraso, 5 de
  15 tests rojos con el instrumento viejo. Tras el arreglo: 10 de 10 sin lentitud; 10 de 10 con carga y latencia (antes
  del último retoque) y 3 de 3 después.
- Publicación (medida el 9 oct 2026). Gate local sobre `32b5a43e51ecd2d4e1c0d687b51b6ff620a41c00` (árbol
  `f2469083d7bb1b878fc086e4d34bd0337ee253ec`), Fedora, Node v22.23.1: `check` «VEREDICTO: VERDE (8/8)», «Test Files 346
  passed (346)», «Tests 5882 passed (5882)»; `check:guardrails` «VEREDICTO: VERDE (25/25)»; `release:preflight` pass;
  `changelog-entry.mjs 0.6.24` exit 0; «host ESM bundle: PASS (397 inputs, 2681494 bytes -> hebra-main.mjs; exports:
  activate; npm packages: yaml)»; «release package: PASS (tyrian-companion-0.6.24.zip
  sha256=0e839ef2138ff9e813c99df4ce2b7940193ccd884a695a7a413b35708ff0b147)». Antes de etiquetar, CI de GitHub en verde
  sobre `a734137` (run `37981097811`) y sobre `32b5a43` (run `37981443983`). Atestación: commit vacío `91f27a2`; tag
  ligero `0.6.24` sobre él. Release publicada 2026-10-09T19:51:54Z, ni borrador ni prerelease, run del workflow
  `37982769514` en success. «BRAT release contract: PASS (version=0.6.24; assets=8)» sobre la salida real de
  `gh release view`; assets subidos: `hebra-main.mjs` 2681500, `hebra-styles.css` 122387, `hebra.json` 29593, `main.js`
  1966440, `manifest.json` 237, `styles.css` 96405, `tyrian-companion-0.6.24.zip` 2063392 y su `.sha256` 94 bytes. El zip
  descargado da el mismo sha256 que el del gate. CI de `main` sobre `91f27a2`: run `37982761464`, success. La etiqueta
  `0.6.23` (sobre `969d874`) sigue existiendo sin release.
- La 0.6.22 sigue sin verse pintada: no hay noticia nueva de David desde la captura de la 0.6.21.
- Lote 1, arranque con el almacenamiento mudo (tarea Z3: `39caa31`, `b202e6a`, `593bff9`, `c3d3d5b`, `5e9f966`,
  `d137e8f`). Si el motor de almacenamiento del navegador no contesta, el plugin arranca igualmente: peor caso medido
  hasta `runtimeReady`, 20 s (10 s del modo de colector y 10 s de la sesión guardada), con las sesiones en error, y se
  recupera solo cuando el almacén vuelve. Cada apertura (`openIndexedDb`) y cada operación de los almacenes que pasan
  por `withIndexedDbReopen` vencen a los 10 s (`STORAGE_ANSWER_TIMEOUT_MS`).
- Límites del lote 1: una operación legítima de más de 10 s contesta fallo aunque la escritura termine después; tras un
  silencio, el almacén de la sesión rechaza durante 2 s aunque el motor haya vuelto; los almacenes secundarios
  (catálogo, historial de precios, Halloween, cola de confirmaciones, calidad de detección, métricas, semillas, puntero
  de recursos) no acotan sus transacciones una vez abiertos; un equipo en `consult` cuyo modo tarda más de 10 s en
  leerse arranca como `collector` hasta que la lectura contesta; el arranque de Hebra con el motor mudo no se probó.
- Lote 2, cierre brusco con una sesión en vivo (tarea F7: `d8de3b1`, `55a19fe`, `3044c12`, `bf9efcd`, `b4a5863`,
  `6f560b1`, `77a5c18`, `79e0d56`, `8a54901`, `2cd794a`, `3f0053f`, `ed3aae9`, `6810905`, `e9cb55b`). El plugin vivo
  mantiene un candado Web Locks con nombre derivado de su `instanceId` y lleva en él la marca `wl1:`. Quien vuelve toma
  la reserva de sesión sin esperar a que caduque si el propietario lleva marca, su candado está libre y lleva al menos
  15 s sin renovar. Medido: vuelta a los 75 s, sesión recuperada en `initialize()` y `ready` al primer `live_open`
  (antes, `ready` a los 305 s). No se acorta la reserva ni cambia el latido; `renew`, `assertOwned` y `release` no se
  tocan. Ventana oculta: 600 de 600 muestras y 11 escrituras de la reserva en diez minutos, con candados y sin ellos.
- Cuándo rige lo de antes (5 minutos): host sin `navigator.locks`; instancia cuya autocomprobación falla (candado no
  concedido en 1 s, gestor que no contesta, que lanza, que contesta `null` a todo o que da por libre el candado propio);
  propietario de un build anterior, sin marca.
- Límites del lote 2. Reinicio a menos de 15 s del cierre: `source_conflict` al primer `live_open` y, como el addon
  espera 30 s tras un conflicto, hasta unos 30 s sin medir. Los 15 s comparan el reloj de pared con el `renewedAt` del
  propietario: un salto de 20 s adelante o una suspensión pueden hacer pasar por callado a un propietario vivo. La
  sesión manual renueva cada 100 s y los 15 s no la cubren. Host sin temporizador con candado nunca concedido: la
  primera adquisición y la cola quedan colgadas. Ventana del almacén: acotada para la sesión activa (el primer guardado
  de un recobro dice qué leyó y, si se le rechaza, el host suelta el handle), abierta para la sesión encontrada ya
  `complete`.
- Dónde es peor que sin candados: dos procesos vivos sobre los mismos datos que no se ven los candados. Garantía de
  proceso único solo en macOS; en Hebra sobre Linux puede fallar (sin bus de sesión D-Bus, o una Hebra colgada al
  salir); Windows, sin verificar. Con los dos procesos latiendo cada 5 s, 120 de 120 (igual que sin candados; sin la
  regla de los 15 s, 40 de 120 y valla 18). Con un propietario que late cada 15 s o más, 14 de 120; con el propietario
  oculto (latido de 60 s) frente a otro a 5 s, 14 de 600, frente a 600 de 600 sin candados (las tres últimas cifras son
  de la revisión independiente, con su propio montaje). Hebra está activado por decisión del integrador, leyendo su
  código y sin sonda en cliente real; se apaga con `locks: null` en `src/host/hebra/entry.ts`.
- Diagnóstico: el registro local (`session` / `session_lease`, almacén `coordination`) apunta una vez qué es cada
  instancia (`life_lock_proven`, `life_lock_unmarked`, `life_lock_absent`) y cada toma (`taken`) o rechazo (`refused`)
  por candado no visto tomado, sin identificadores.
- Revisión: independiente, dos pasadas por lote («integrar con correcciones» las cuatro veces; correcciones aplicadas).
  El último delta de Z3 (`5e9f966..d137e8f`) y el de las últimas correcciones de F7 (`3f0053f`, `ed3aae9`, `6810905`,
  `e9cb55b`) los lee solo el integrador.
- Medido sobre `bc41145` más los cambios de documentación sin commitear al medir (Fedora, Node v22.23.1, 9 oct 2026),
  un solo worker y ficheros sueltos: `tsc --noEmit` sin errores; `lint` con 0 errores y 117 avisos; censo de
  observabilidad PASS (totales 574, 59, 125 y 229); contrato de texto fuente PASS (`frozen=17; scanned=375`);
  `i18n-unused` e `i18n-copy-length` sin hallazgos; `build:host-esm`: «host ESM bundle: PASS (397 inputs, 2681494 bytes
  -> hebra-main.mjs; exports: activate; npm packages: yaml)»; y 103 ficheros de test con 1887 tests en verde (todo
  `src/sessions`, `src/host`, `src/test`, los de diagnóstico y `indexed-db-open`, y nueve `main-*`). No es el gate.
- Cómo se comprobará el lote 2 en un cliente: matar la aplicación con una sesión en vivo, reabrirla y leer en el
  registro de diagnóstico local los eventos `life_lock_*` y `taken`.

## Canal 0.6.22 publicado: Sesión a una columna en la pantalla principal de Hebra y «Valor estimado» en grande con los iconos de oro, plata y cobre (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.22](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.22)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T16:35:10Z; nombre, tag y `manifest.version`
son `0.6.22`. El tag (ligero) apunta a `67cbac6` (`67cbac693e463d24e16bc59221febcedb78dde27`, commit vacío de
atestación); el candidato fuente es `6676408` (`6676408b141da4965423d261e04c2221859d7ba8`, árbol
`038ceb46a3b11b7185b78ab135cf4284348b9bc6`). Parte de `b516be4` (`main` con el canal 0.6.21 publicado). Trae dos
cambios de interfaz sobre la captura de la 0.6.21 en el Hebra real de David (`02a29c1`, `ae9054e`, y `6676408`, que
limita el ancho de las cifras) y los metadatos de versión (`57e1448`: `manifest.json`, `package.json`, la raíz de
`package-lock.json` y `versions.json`, mínimo de Obsidian 1.11.4). Detalle en [CHANGELOG](CHANGELOG.md) y en
[ARCHITECTURE](ARCHITECTURE.md) («Capas»).

- Origen: petición de David del 9 oct 2026, con la captura de la 0.6.21 en su Hebra: «puedes dejarlo a 1 columna? y
  que el valor de valor estimado se vea en grande y si puede ser con los iconos oficiales de oro plata y cobre?». Deshace
  su petición anterior de dos columnas («sesión se debería ver a 2 columnas, no?»): al verlo prefiere una.
- Sin verificar, y es lo primero que hay que saber: nada de esto se ha visto pintado. No hay captura de la 0.6.22 ni se
  ha abierto en ningún navegador, en Hebra ni en Obsidian; las cifras de ancho de abajo salen de leer el CSS, no de
  medir una interfaz. Los tests de DOM corren en happy-dom, que no calcula consultas de contenedor ni carga imágenes: lo
  que prueban es la estructura, el texto, el nombre accesible y que cada letra solo se esconde con su `load` (el evento
  se lanza a mano); las reglas de CSS se comprueban como texto.
- Una columna: en la pantalla principal de Hebra el panel de Sesión va en columna a cualquier ancho. Se quita la regla
  de 560 px de `5d647c4` y, como la regla de dos columnas desde 600 px de `styles.css` también llegaba a la pantalla
  principal (el hueco es su contenedor más cercano), `tyrian-host.css` devuelve la columna bajo
  `.hebra-module-view-main` desde esos 600 px. Obsidian conserva sus dos columnas desde 600 px; Inventario y Venta no se
  tocan. Las dos columnas de las filas de la Cronología siguen igual. `6676408` añade `max-width: 24rem` a las cifras
  («Valor estimado» y «Por hora») en ese bloque de 600 px, para que la fila «Por hora» no reparta etiqueta y valor a
  los dos extremos de la pantalla.
- Revisión: leída solo por el integrador, sin pasada independiente; el último commit (`6676408`) lo escribió el
  integrador.
- Valor estimado: etiqueta pequeña encima y cifra debajo, a la izquierda, con cifras tabulares. Tamaño
  `clamp(1.25rem, 8cqi, 2rem)` sobre el contenedor: 22 px (1.4rem) con 280 px, 2rem desde 400 px; dentro de las dos
  columnas de Obsidian, 1.25rem. Cada moneda es número, icono y letra; las tres pasan a otra línea en vez de desbordar.
  Cálculo por escrito (no medido): a 280 px de contenedor (unos 248 de contenido) `1234g 56s 78c` ocupa unos 190 px
  (8 cifras de 0,6 em, tres iconos de 0,8 em y los huecos, a 22 px); a 593, 852 y 1300 px el tamaño es 2rem y la cifra
  cabe en una línea de unos 270 px.
- Iconos: `ui_coin_gold`, `ui_coin_silver` y `ui_coin_copper` de `GET https://api.guildwars2.com/v2/files?ids=all`
  (`render.guildwars2.com/file/090A980A.../156904.png`, `.../E5A2197D.../156907.png` y `.../6CF8F96A.../156902.png`),
  respondieron 200 `image/png` de 32 × 32 el 9 oct 2026 y se miraron a mano: moneda de oro, de plata y de cobre. Son
  constantes del código (los demás iconos llegan del catálogo, cacheado, y el catálogo de monedas no trae estos tres:
  `/v2/currencies/1` da una sola moneda) en el mismo origen de siempre, sin host nuevo, sin pedir `/v2/files` desde el
  plugin y sin empaquetar ninguna imagen. Cada `<img>` es decorativa (`alt=""`, `aria-hidden`) y la carga la hace el
  navegador, con su caché. Sin red o con la imagen rota la letra no se esconde y queda `0g 37s 1c`; el valor entero es
  un `role="img"` con «0 de oro, 37 de plata, 1 de cobre» (`0 gold, 37 silver, 1 copper`; con signo, «menos …») en
  claves `moneySpoken` y `moneySpokenLoss` de `live-session-copy.ts`.
- Sin sesión no hay panel de cifras (la fila se oculta como antes); con la sesión sin lecturas vale 0 y se pinta
  `0g 0s 0c`; negativo, `-12g 34s 56c` con el signo delante de la primera moneda.
- No cambia: la etiqueta de la gráfica, la cronología, las notas Markdown, Inventario y Venta siguen con letras.
- Medido sobre `57e1448` más los cambios de documentación sin commitear al medir (Fedora, 9 oct 2026), un solo worker y
  ficheros sueltos: `tsc --noEmit` sin errores, `lint` con 0 errores, censo de observabilidad PASS (la baseline gana el
  fichero nuevo y sus dos `addEventListener` de imagen, revisados, y el total de 222 a 224), `i18n-unused` e
  `i18n-copy-length` sin hallazgos, contrato de texto fuente PASS, y `build:host-esm`: «host ESM bundle: PASS (397
  inputs, 2673225 bytes -> hebra-main.mjs; exports: activate; npm packages: yaml)». No es el gate.
- Gate local sobre el candidato `6676408` (`6676408b141da4965423d261e04c2221859d7ba8`, árbol
  `038ceb46a3b11b7185b78ab135cf4284348b9bc6`; Fedora, Node v22.23.1, 9 oct 2026), con las dependencias existentes y a
  la primera: `npm run check` «VEREDICTO: VERDE (8/8)», «Test Files 344 passed (344)», «Tests 5812 passed (5812)»;
  `npm run check:guardrails` «VEREDICTO: VERDE (25/25)»; `release:preflight` pass y
  `node scripts/changelog-entry.mjs 0.6.22` con salida 0; «host ESM bundle: PASS (397 inputs, 2673225 bytes ->
  hebra-main.mjs; exports: activate; npm packages: yaml)»; «release package: PASS (tyrian-companion-0.6.22.zip
  sha256=dc0776590239f5a84c52429806bb94f20ed8115c8ed16babf2144630936b7e99)»; y «BRAT release contract: PASS
  (version=0.6.22; assets=8)» sobre la release planeada. El zip descargado de la release da el mismo sha256 que el del
  gate.
- Publicación: el workflow de release (run 37959786333) terminó en `success`. `release:brat-verify` sobre la salida
  real de `gh release view`: «BRAT release contract: PASS (version=0.6.22; assets=8)». Los ocho assets están
  `uploaded`: `hebra-main.mjs` 2673231, `hebra-styles.css` 122387, `hebra.json` 29593, `main.js` 1959915,
  `manifest.json` 237, `styles.css` 96405, `tyrian-companion-0.6.22.zip` 2056867 y
  `tyrian-companion-0.6.22.zip.sha256` 94 (bytes).
- CI de `main` sobre `67cbac6` (run 37959777928): `completed` / `success` (2026-10-09T16:40:17Z).
- No verificado: nada de la 0.6.22 se ha visto pintado en ningún host, ni instalado ni ejecutado en un Hebra o un
  Obsidian reales, ni por BRAT ni desde Hebra; que los iconos carguen en el Hebra y el Obsidian reales; el aspecto a
  280, 593, 852 y 1300 px; una lectura con un lector de pantalla; Windows.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Canal 0.6.21 publicado: Tyrian Companion en la pantalla principal de Hebra, con sus tres secciones (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.21](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.21)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T15:16:10Z; nombre, tag y `manifest.version`
son `0.6.21`. El tag (ligero) apunta a `b92ea06` (`b92ea06aeba73197a7495472723be92286cb126a`, commit vacío de
atestación, árbol `4c07ea33bc0d3a4061b962ad112bceb16d46d934`); el candidato fuente es `1bedc91`, con el mismo árbol.
Parte de `0eacbe0` (`main` con el canal 0.6.20 publicado). Trae un solo
lote, de la vista principal de Hebra (`18845a5`, `70fc7f1`, `7a9ad41`, `c855785`, `2987258`, `1708c6e`, `1f176df`,
`44b4018`, `edda5da`, `4d6f6cf`, `5d647c4`, `aa57e00`, `b25525d`, `d683599`, `a1ed477`, `6cc19d0`): en un Hebra con la
API de plugins 1.3.0 el plugin registra UNA vista en la pantalla principal con las secciones Sesión, Inventario y
Venta, en vez de sus tres vistas; una opción nueva de Ajustes, por dispositivo y no sincronizada, elige entre eso y la
barra lateral, y cambiarla se aplica sin recargar; en un Hebra anterior y en Obsidian nada cambia. `hebra-plugin-api`
pasa de 1.0.0 a 1.3.0 como dependencia de tipos. `hebra.json` sigue declarando `apiVersion ^1.0.0` y las mismas
capacidades. Detalle y límites en [CHANGELOG](CHANGELOG.md) y en [ARCHITECTURE](ARCHITECTURE.md) («Capas»). Metadatos
de versión alineados en `manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de
Obsidian 1.11.4).

- Origen: petición de David del 9 oct 2026 en la sesión de Hebra («quiero que en las opciones del plugin haya una
  opción para verlo en la sidebar o en la pantalla principal. por defecto se verá en la principal.»); contrato de la
  API 1.3.0 acordado ese día con esa sesión; etiqueta `v1.3.0` de `fodaveg/hebra-plugin-api` en
  `685f2c02bec9106469c3ea83c3cc8e4e90f0d33f`.
- Revisión: independiente. Primera pasada sobre `436f2eb..33cf9ea` (los commits de antes de rebasar el lote sobre
  `0eacbe0`): «integrar con correcciones», un obligatorio de test y dos recomendados, aplicados. Segunda pasada, sobre
  `33cf9ea..535e389` (rangos también de antes de rebasar): «integrar con correcciones», una sola corrección (las
  coordenadas del baseline del censo, que no cambia ninguna decisión revisada; `6cc19d0`) y una mejora de redacción
  (la frase de la fila de Ajustes; `a1ed477`), aplicadas; 27 mutaciones sobre el código, todas cazadas menos una
  equivalente.
- Medido sobre `d683599` (árbol `585002994a01ce03a0bd2f83ac758563eacb9a53`, el lote ya rebasado sobre `0eacbe0`;
  Fedora, 9 oct 2026), antes del gate: `tsc --noEmit` sin errores, `lint` con 0 errores, censo de observabilidad PASS,
  contrato de texto fuente PASS, `i18n-unused` e `i18n-copy-length` sin hallazgos y 1350 tests de 79 ficheros
  (`src/host/hebra`, `src/ui`, el núcleo, `view-placement` y `live-session-summary-note`; uno más se salta,
  `bundle.test.ts`), con un solo worker.
- Medido sobre `6cc19d0` (árbol `ccff6521de816b0fec928ef95a442e21c3acb98f`, con las dos correcciones de la segunda
  pasada; Fedora, 9 oct 2026), antes del gate: las mismas comprobaciones estáticas con el mismo resultado y 326 tests
  de 24 ficheros (`src/host/hebra`, el núcleo, `settings-page` e `i18n`; uno más se salta, `bundle.test.ts`), con un
  solo worker. El reindexado del baseline del censo movió 436 coordenadas en once ficheros censados que toca el lote, y
  ningún id, clasificación, evidencia ni total; en siete de ellos las coordenadas ya iban atrasadas en `0eacbe0` (394
  valores), así que el reindexado corrige también ese atraso.
- Gate local sobre el candidato `1bedc91` (`1bedc9135ed45442acea92c31085dd7cf9f91e8b`; Fedora, Node v22.23.1, 9 oct
  2026), tras `npm ci` con `hebra-plugin-api` 1.3.0 y a la primera: `npm run check` «VEREDICTO: VERDE (8/8)», 5794
  tests (342 ficheros); `npm run check:guardrails` «VEREDICTO: VERDE (25/25)»; `release:preflight` pass y
  `node scripts/changelog-entry.mjs 0.6.21` con salida 0; «host ESM bundle: PASS (396 inputs, 2670538 bytes ->
  hebra-main.mjs; exports: activate; npm packages: yaml)»; «release package: PASS (tyrian-companion-0.6.21.zip
  sha256=c8926c7a4eb75f974791cdeb53a64c83f960064bcfb3808cbbe9cfe1773ac953)»; y «BRAT release contract: PASS
  (version=0.6.21; assets=8)» sobre la release planeada. El zip descargado de la release da el mismo sha256 que el del
  gate.
- Publicación: el workflow de release (run 37949980129) terminó en `success`. `release:brat-verify` sobre la salida
  real de `gh release view`: «BRAT release contract: PASS (version=0.6.21; assets=8)». Los ocho assets están
  `uploaded`: `hebra-main.mjs` 2670544, `hebra-styles.css` 121333, `hebra.json` 29593, `main.js` 1957755,
  `manifest.json` 237, `styles.css` 95002, `tyrian-companion-0.6.21.zip` 2053304 y
  `tyrian-companion-0.6.21.zip.sha256` 94 (bytes). El asset `hebra-main.mjs` descargado ocupa 6 bytes más que la cifra
  del gate y su texto mide los 2670538 de esa cifra: `scripts/build-host-esm.mjs` informa de la longitud del texto
  (`text.length`), no de los bytes del fichero.
- CI de `main` sobre `b92ea06` (run 37949973239): terminó en `success` (2026-10-09T15:23:30Z).
- Comprobado fuera de los tests: el `hebra.json` que genera `scripts/release-package.mjs` con el pin nuevo se comparó
  con el de la release 0.6.20 y solo difieren la versión y los hashes de los ficheros; `build:host-esm` informa de un
  solo paquete de npm en el bundle (`yaml`). Esa comparación se hizo antes de rebasar el lote.
- Límites: los tests del lote corren contra el host falso de `hebra-plugin-api` 1.3.0, con una capa propia
  (`src/test/hebra-real-host.ts`) para el montaje diferido, las vistas de columna y de diálogo abiertas, el rechazo de
  un id repetido y los fallos del plugin que ese falso se traga. Los tests del camino de las tres vistas corren sobre
  un Hebra 1.2.0 simulado. Inventario y Venta usan en la columna de Hebra sus disposiciones estrechas por debajo de
  760 px. El botón de la barra de Hebra abre el menú del plugin, no la vista. El censo de observabilidad gana dos
  `catch` (la lectura de la preferencia en `getViewPlacement`, observada; `hebraHasMainView`, en lista blanca).
- Visto por David en su Hebra real (9 oct 2026, Fedora, rpm de Hebra `0.2.0-15`): la captura de las 18:17 muestra la
  vista del plugin en la pantalla principal, con Sesión, Inventario y Venta en la lista de secciones, la sección Sesión
  pintada a dos columnas con una sesión terminada, y el botón de Ajustes arriba a la derecha. Solo eso: no se han visto
  Inventario ni Venta, ni el cambio de la opción «Dónde se muestra», ni Obsidian, ni Windows. Sobre esa captura David
  pidió una columna y el valor estimado en grande con los iconos de oro, plata y cobre (candidato 0.6.22, abajo).
- No verificado: nada de la 0.6.21 instalado, ejecutado ni visto en un Hebra ni en un Obsidian reales, ni por BRAT ni
  desde Hebra, salvo lo que recoge el punto anterior; el CSS nuevo no se ha visto en ningún navegador salvo esa captura
  de la Sesión; la sesión de Hebra declara sin probar a mano la vista principal, el motor WebKit y la vista de solo
  editor. Ningún test graba una sesión en vivo con su sección oculta.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Canal 0.6.20 publicado: el mapa en curso tras un reinicio del host y el resumen de sesión por mapa (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.20](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.20)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T14:15:33Z; nombre, tag y `manifest.version`
son `0.6.20`. El tag (ligero) apunta a `2be1736` (`2be1736eb154fddcfd6c7aab42828d18cec4c008`, commit vacío de
atestación, árbol `d63294db9d543c945bd38c9896dabdafda798f82`); el candidato fuente es `2974358`, con el mismo árbol.
Parte de `b0c07cd` (`main` con el canal 0.6.19 publicado). Trae un solo
lote, de mapas en las notas de sesión (`52ffeb3`, `49ebf59`, `8065aa6`, `72fdce8`, `fcf3e7d`, `6e1658e`, `1e736ba`,
`2375f1c`): al recuperar una sesión en vivo tras un reinicio del host, el mapa en curso se cierra en la última muestra
en vez de descartarse; la sección «Mapas» de la nota resumen pasa a tabla (tiempo observado, valor neto de objetos y
por hora observada de cada mapa, fila «Sin mapa identificado» y recorrido con la hora local de cada entrada); y el
bloque «Resumen» de la nota completa lista cada tramo en un mapa con su hora de entrada y de salida. No cambian las
claves `tyrian_summary_*`, `tyrian_summary_version` (3), los nombres de fichero ni la forma del bloque de datos; la
única excepción en los valores es el mapa cuyo nombre llega vacío, que se escribe «Mapa <id>». Un cambio de mapa no
parte la sesión (decisión de David del 9 oct 2026). Detalle y límites en [CHANGELOG](CHANGELOG.md) y en
[SPEC-live-loot](SPEC-live-loot.md) §6. Metadatos de versión alineados en `manifest.json`, `package.json`, la raíz de
`package-lock.json` y `versions.json` (mínimo de Obsidian 1.11.4).

- Origen: pregunta de David del 9 oct 2026 sobre cómo se ve un cambio de mapa; diagnóstico sobre los datos de la
  sesión real y el registro de Nexus de ese día.
- Revisión: independiente, dos pasadas. La primera, sobre `b0c07cd..fcf3e7d`: «integrar con correcciones», una
  obligatoria (el último cambio de una sesión caía en «Sin mapa identificado»), aplicada en `6e1658e`. La segunda,
  sobre `fcf3e7d..2375f1c`: «integrar»; 23 de 25 mutaciones mueren y las 2 que sobreviven son equivalentes o
  inobservables en la nota. Los metadatos, el changelog y el test abaratado (`2974358`) los leyó solo el integrador.
- Medido sobre `2375f1c` (árbol `2e3fc5538a35182dd1f0ac53bb007d743bdf0a9e`; Fedora, 9 oct 2026), antes del gate:
  `tsc --noEmit` sin errores, `lint` con 0 errores, censo de observabilidad PASS, contrato de texto fuente PASS y 724
  tests de los 30 ficheros afectados, con un solo worker.
- Primer intento del gate, sobre `455020e`: ROJO por un solo test. El que jugaba 260 reinicios para llegar al tope de
  256 intervalos agotó sus 5 s dentro de la suite completa (9 s con la máquina cargada). `2974358` lo abarata sin
  subir ningún plazo; el gate verde es el segundo intento, sobre el árbol nuevo.
- Gate local sobre el candidato `2974358` (Fedora, Node v22.23.1, 9 oct 2026): `npm run check` «VEREDICTO: VERDE
  (8/8)», 5681 tests (339 ficheros); `npm run check:guardrails` «VEREDICTO: VERDE (25/25)»; `release preflight: pass`
  y `release package: PASS` (`tyrian-companion-0.6.20.zip` construido en local). El zip descargado de la release da el
  mismo sha256 que el del paquete local: `d8f067c56b82f9d42176cfa1b742e434977c655b64aa4f2b18decbc4a1505058`.
- Publicación: el workflow de release (run 37942397254) terminó en `success`. `release:brat-verify` sobre la release
  real: «BRAT release contract: PASS (version=0.6.20; assets=8)». Los ocho assets están `uploaded`: `hebra-main.mjs`
  2660601, `hebra-styles.css` 118003, `hebra.json` 29593, `main.js` 1951744, `manifest.json` 237, `styles.css` 94537,
  `tyrian-companion-0.6.20.zip` 2046828 y `tyrian-companion-0.6.20.zip.sha256` 94 (bytes).
- CI de `main` sobre `2be1736` (run 37942387681): conclusión `success`.
- Comprobado con datos reales: se renderizó con el código nuevo el resumen de la sesión real del 9 oct 2026 (96 min,
  84 % observado): Hondonadas del Manantial de Ley 24 min 55 s y 0g 47s 82c, Resplandor del Fuego 58 s y 0g 37s 40c,
  Litoral del Naufragio 12 min 52 s y 0g 0s 0c, sin mapa identificado 42 min 27 s y 0g 6s 44c. Suman los 81 min 12 s
  observados y los 0g 91s 66c del balance. Esa sesión se grabó con el fallo del reinicio. Su frontmatter y el resto
  del cuerpo salen byte a byte como los escribe `b0c07cd`.
- Límites: las sesiones ya guardadas no se reparan y los resúmenes ya escritos no se reescriben. Lo que llega durante
  la carga de un mapa o se abre en el mapa siguiente cuenta donde se observó; un hueco con menos de un segundo
  observado se queda en el mapa de al lado; la tabla y el recorrido no tienen tope de filas ni de pasos;
  `mapCoveragePartial` sigue sin volver a `false`; `src/sessions/ingame-session-marker.ts` conserva el mismo patrón de
  descarte al recargar, sin tocar.
- No verificado: nada de la 0.6.20 visto pintado en Obsidian ni en Hebra, ni instalada por BRAT o en Hebra; ninguna
  sesión real grabada con el arreglo del reinicio. El resumen de la sesión real se renderizó fuera de cualquier
  cliente.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Canal 0.6.19 publicado: la presentación de la nota resumen de sesión y los títulos con fecha (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.19](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.19)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T12:46:11Z; nombre, tag y `manifest.version`
son `0.6.19`. El tag (ligero) apunta a `436f2eb` (`436f2eb8cede369b8a97f4ae8f5d1e6a67384f68`, commit vacío de
atestación, árbol `363a98282fb5b80db416bdbf57380403e5717052`); el candidato fuente es `616ca1c`, con el mismo árbol.
Parte de `446844d` (`main` con el canal 0.6.18 publicado). Trae un solo lote, de presentación (`c6ba44b`, `ffc177b`, `716363d`): los rótulos de la nota resumen dicen qué cuenta cada cifra
(«Balance observado», «Valor neto de objetos observados», «Objetos por hora observada», «Cambio de oro observado»,
«Objetos observados de más valor», «Cambios de otras monedas»), lo que salió del inventario se cuenta en unidades y
tipos, los títulos de las dos notas llevan la fecha y la hora local del inicio, la cobertura por debajo del 90 %
agrupa los tramos, los ligados a cuenta pasan a recuento con más de 5 tipos y el enlace se llama «Sesión completa».
No cambia ninguna cifra, el frontmatter, el payload, los nombres de fichero ni `tyrian_summary_version` (3). Detalle y
límites en [CHANGELOG](CHANGELOG.md) y en [SPEC-live-loot](SPEC-live-loot.md) §6. Metadatos de versión alineados en
`manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian 1.11.4).

- Origen: revisión independiente de dos notas reales del 9 oct 2026; aprobado por David ese día.
- Revisión: independiente sobre `446844d..ffc177b` («integrar con correcciones», una obligatoria de texto, aplicada en
  `716363d`); `716363d` lo leyó solo el integrador.
- Gate local sobre `ffc177b` (árbol `97ef3808d67dc6b0c87147ac58cf2ee78fcb4538`): `check` 8/8 (5648 tests) y
  guardrails 25/25.
- Gate local sobre el candidato `616ca1c` (Fedora, Node v22.23.1, 9 oct 2026): `npm run check` «VEREDICTO: VERDE
  (8/8)», 5651 tests (339 ficheros); `npm run check:guardrails` «VEREDICTO: VERDE (25/25)»; `release preflight: pass`
  y `release package: PASS` (`tyrian-companion-0.6.19.zip` construido en local). El zip descargado de la release da el
  mismo sha256 que el del paquete local: `7ee8ec736c5d075d0f584b9ec9ba61a056f76b1285ae4fcb61696a2f55655f3e`.
- Publicación: el workflow de release (run 37931703547) terminó en `success`. `release:brat-verify` sobre la release
  real: «BRAT release contract: PASS (version=0.6.19; assets=8)». Los ocho assets están `uploaded`: `hebra-main.mjs`
  2655335, `hebra-styles.css` 118003, `hebra.json` 29593, `main.js` 1947937, `manifest.json` 237, `styles.css` 94537,
  `tyrian-companion-0.6.19.zip` 2043021 y `tyrian-companion-0.6.19.zip.sha256` 94 (bytes).
- CI de `main` sobre `436f2eb` (run 37931696575): conclusión `success`.
- Comprobado con datos reales: se renderizó con el código nuevo el resumen de una sesión real del 9 oct 2026 (96 min,
  84 % observado): 14 tramos sin observar, 3 listados y 11 cortes de menos de 30 s.
- Límites: los resúmenes ya escritos no se reescriben y las notas ya escritas conservan su título. Las columnas de la
  Base de resúmenes siguen llamándose «Neto» y «Por hora» y ya no coinciden con los rótulos de la nota.
- No verificado: nada de la 0.6.19 visto pintado en Obsidian ni en Hebra, ni instalada por BRAT o en Hebra; el título
  usa la zona horaria del equipo en el momento de escribir. El resumen de una sesión real se renderizó con el código
  nuevo fuera de cualquier cliente.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Canal 0.6.18 publicado: el resumen de sesión sin excluir NoSell, su enlace en Hebra y los plazos del almacén en vivo (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.18](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.18)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T11:29:04Z; nombre, tag y `manifest.version`
son `0.6.18`. El tag (ligero) apunta a `06dd070` (commit vacío de atestación, árbol
`1fe91ad729b6e416ccc0d680ee8ab9ea50fa2801`); el candidato fuente es `c0c6cfc`, con el mismo árbol. Parte de `ab9d57c`
(`main` con el canal 0.6.17 publicado). Trae tres cosas.
Una cifra visible: la nota resumen de una sesión ya no deja fuera del valor los objetos con la marca `NoSell`
(`662ae71`, `ab9d57c`), que solo prohíbe la venta a un comerciante; siguen fuera `AccountBound` y `SoulbindOnAcquire`.
El enlace «Nota completa» del resumen en Hebra, que va por id (`a500ba8`). Y los plazos del almacén de la sesión en
vivo (los 13 commits de `claude/ciclo-vida-almacen-20261009`, `fdd0a28`…`a750f79`): cada llamada al almacén de la
sesión en vivo, al coordinador de la reserva y al escritor de notas tiene un plazo de 10 s, y al vencer se responde
como cuando el almacén no está disponible en vez de dejar la cola bloqueada; una carga inicial que falla se reintenta
con el latido; un `initialize()` que falla ya no tumba el plugin; un inicio que el almacén no confirmó se vuelve a
buscar y se recobra; una nota que tarda más que el plazo se espera en vez de escribirse otra vez; y una reclamación
de aviso contestada como rechazada se relee antes de reintentar. La reserva de la sesión en vivo sigue en 5 minutos
(la de 30 s se descartó porque, con la ventana oculta y un latido por minuto, guardaba 150 de 600 muestras, y no es un
cambio de esta versión). Detalle y límites en [CHANGELOG](CHANGELOG.md). Metadatos de versión alineados en
`manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian 1.11.4).

- Revisión de los plazos del almacén: independiente, en tres pasadas («integrar con correcciones» dos veces, con tres
  obligatorias en total, y después «integrar»). El último commit, solo de tests, lo leyó el integrador.
- Gates ya pasados sobre `main` (Fedora, 9 oct 2026), todos de commits anteriores al candidato:
  - `a750f79` (árbol `f8889c69b8269e1dae30c712257f9550f64838e5`): `npm run check` 8/8 (5626 tests, 339 ficheros) y
    guardrails 25/25.
  - `a500ba8`: `check` 8/8 (5630 tests) y guardrails 25/25.
  - `ab9d57c` (árbol `250e7c3b2202a070d048e07af3ef19a0e65a91d4`): `check` 8/8 (5632 tests) y guardrails 25/25.
- Gate local sobre el candidato `c0c6cfc` (Fedora, Node v22.23.1, 9 oct 2026): `npm run check` 8/8 (5632 tests, 339
  ficheros), `npm run check:guardrails` 25/25, `release preflight: pass` y `release package: PASS`
  (`tyrian-companion-0.6.18.zip` construido en local, sha256
  `393e962ff0e5ac7a64a5d5a44d2d8a82f64f024ecac654e3ac6893647d25a0ba`). Sobre la release planeada, `BRAT release
  contract: PASS` con 8 assets.
- Publicación: el workflow de release (run 37923642523) terminó en `success`. `release:brat-verify` sobre la release
  real: «BRAT release contract: PASS (version=0.6.18; assets=8)». Los ocho assets están `uploaded`: `hebra-main.mjs`
  2650387, `hebra-styles.css` 118003, `hebra.json` 29593, `main.js` 1944601, `manifest.json` 237, `styles.css` 94537,
  `tyrian-companion-0.6.18.zip` 2039685 y `tyrian-companion-0.6.18.zip.sha256` 94 (bytes).
- CI de `main` sobre `06dd070` (run 37923631982): `completed` con conclusión `success` (leído con
  `gh run view --json jobs` el 9 oct 2026). Jobs `detect-native-changes`, `check-guardrails`, `check` y
  `release-package` en `success`; `rust-portable` y `rust-windows-helper` omitidos (`skipped`).
- Límites conocidos de los plazos, en [SPEC-live-loot](SPEC-live-loot.md): un motor de almacén que no contesta al
  arrancar sigue impidiendo arrancar el plugin; un escritor de nota que no termina nunca bloquea las notas siguientes;
  tras un cierre brusco de la app de notas siguen pudiendo pasar hasta 5 minutos sin medir; una renovación de reserva
  que llega a disco después de su plazo cuesta un hueco y una época nueva.
- Límites del resumen: los resúmenes ya escritos no se recalculan ni se reescriben; «tu media» compara con netos
  antiguos sesgados a la baja hasta que se renueve el historial; `tyrian_summary_version` sigue en 3.
- No verificado: nadie ha visto la 0.6.18 en Obsidian ni en Hebra reales, ni su instalación por BRAT o en Hebra. El
  enlace por id está comprobado a mano en una biblioteca real de Hebra (9 oct 2026) sobre tres resúmenes existentes
  editados; el resumen que escribe la 0.6.18 con esa forma no se ha visto. Los plazos del almacén están medidos solo
  con `fake-indexeddb`.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Canal 0.6.17 publicado: el valor de un botín sobre el total de la venta y fallos que ya no rompen lo demás (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.17](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.17)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T10:23:01Z; nombre, tag y `manifest.version`
son `0.6.17`. El tag (ligero) apunta a `3bf01ee` (commit vacío de atestación, árbol
`dc4bf8cd730919a502c9bf3fac3b2dbf5de3d587`); el candidato fuente es `d48f630`, con el mismo árbol. Parte de `c520c2c` (main con el canal 0.6.16 publicado). Trae el valor de
la tarjeta de botín de una sesión de cuenta calculado con la comisión sobre el total de cada venta, la lectura de la
versión 2 de la nota de sesión (el escritor v2 sigue apagado), el reintento de un aviso cuya reserva se rechazó, el
cierre del `AudioContext` y el reintento de `resume()`, los dos motivos de «sin semilla» en los precios, la base de
datos de Halloween en la versión 9, el paquete de soporte como nota de Hebra con el almacén local listando por
prefijo, el icono nuevo de Hebra, la guía de instalación en Windows y tres textos corregidos. El detalle y los
límites conocidos están en [CHANGELOG](CHANGELOG.md). Metadatos de versión alineados en `manifest.json`,
`package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian 1.11.4, como la 0.6.16).

No entra en esta versión la rama `claude/ciclo-vida-almacen-20261009` (plazo de 10 s por llamada al almacén de la
sesión en vivo, reintento de la carga inicial y un `initialize()` fallido que no tumba el plugin). Su revisión
independiente del 9 oct 2026 pidió dos correcciones obligatorias, las dos sobre un almacén lento que sí contesta: una
nota de sesión que tarda más de 10 s en escribirse no llega a sellarse y bloquea el inicio siguiente, y un guardado
del inicio que vence y aterriza después deja una sesión activa que el usuario no vio empezar. Se corrigió después y
está en `main` sin publicar (sección anterior).

- Gate local sobre el candidato (Fedora, Node v22.23.1, 9 oct 2026): `npm run check` 8/8 (5572 tests, 339
  ficheros), `npm run check:guardrails` 25/25, `release preflight: pass` y `release package: PASS`
  (`tyrian-companion-0.6.17.zip` construido en local, sha256
  `e60c99ff3669534f26b6747ed36e3f997a491b32b9d2d1eca933742dbc057fe3`). Sobre la release planeada, `BRAT release
  contract: PASS` con 8 assets.
- Publicación: el workflow de release (run 37916791102) terminó `completed`/`success`, con todos los pasos del job
  `publish` en `success`. `release:brat-verify` (`node scripts/brat-release-contract.mjs --release-json <salida de
  gh release view>`) sobre la release real: «BRAT release contract: PASS (version=0.6.17; assets=8)». Los ocho
  assets están `uploaded`: `hebra-main.mjs` 2642047, `hebra-styles.css` 118003, `hebra.json` 29593, `main.js`
  1938798, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.17.zip` 2033882 y
  `tyrian-companion-0.6.17.zip.sha256` 94 (bytes).
- Revisión: los lotes del audit se pasaron juntos por el gate en `e800a54`; el lote del precio bruto tuvo revisor
  independiente en dos pasadas. Los metadatos, el changelog y los tres textos corregidos los leyó solo el integrador.
- CI de `main` sobre `3bf01ee` (run 37916781466): `completed` con conclusión `success` (leído con
  `gh run view --json jobs` el 9 oct 2026). Jobs `detect-native-changes`, `check-guardrails`, `check` y
  `release-package` en `success`; `rust-portable` y `rust-windows-helper` omitidos (`skipped`). Dentro de `check`, en
  `success`: `npm run check`, `npm run bench:h6-performance`, `npm run test:bench:h6-performance-red`,
  `npm run bench:h6-live-session` y `npm run bench:h6-live-session-red`.
- Corrección del texto publicado: el cuerpo de la release 0.6.17 llevaba una frase errónea («no guarda muestras
  vacías»); con el escritor de la versión 1, el vigente, cada muestra deja su entrada, y solo la versión 2 omite la
  que no cambia nada. El changelog queda corregido y el cuerpo de la release se editó con esa frase corregida el
  9 oct 2026; `release:brat-verify` volvió a dar PASS con los ocho assets tras la edición.
- No verificado: nadie ha visto la 0.6.17 instalada ni cargada en Obsidian/BRAT ni en Hebra.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).
- Addon de Nexus 0.8.4, publicado el 9 oct 2026:
  [release 0.8.4](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.4), tag anotado sobre `37a73a2`.
  Asset `tyrian_companion_nexus.dll` de 4 447 744 bytes, sha256
  `bb8f6e1a9dd33de1914e7e37a07330a0e159a4f56adf19d01e970e52579a8415`. Trae los topes del recorrido de hilos y los
  iconos nuevos de los dos botones de acceso rápido. Está instalado en la carpeta del juego en Fedora; nada visto en
  el juego ni en Windows.

## Canal 0.6.16 publicado: las Bases se mantienen solas al cargar y el icono del objeto principal en los resúmenes (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.16](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.16)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T07:07:24Z; nombre, tag y `manifest.version`
son `0.6.16`. El tag (ligero) apunta a `c6a10f5` (commit vacío de atestación, árbol
`226d534605f49a76e4684fc3ebc9ab2afe35004f`); el candidato fuente es `25bd731`, con el mismo árbol. Parte de `a8cf5cc` (main con el canal 0.6.15 publicado y la documentación
de las Bases ya integrada). Trae el icono del objeto principal en la nota resumen de sesión y la columna «Icono» de
su Base, la creación, actualización y retirada de Bases al cargar el plugin (`MANAGED_ASSETS_BUNDLE_VERSION` de 7 a
8; retira `Sessions.base`, `Halloween.base` y `Materials.base` si no se editaron, según el ajuste de archivos
eliminados de la aplicación) y tres ajustes de rendimiento de la auditoría del 8 oct 2026. El detalle y los límites
conocidos están en [CHANGELOG](CHANGELOG.md) y en `docs/ARCHITECTURE.md`. Metadatos de versión alineados en
`manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian 1.11.4, como la
0.6.15). No entran los iconos de objetos dentro del texto de las notas de sesión: Hebra no pinta imágenes Markdown
remotas dentro de una nota.

- Medido en la preparación (no es el gate de release): sobre `a8cf5cc` (árbol
  `6c9bf6971045c0ca412be738cd96fb23ba4e9781`), antes de los metadatos, `npm run check` dio «VEREDICTO: VERDE (8/8)»
  con 5422 tests en 334 ficheros, y `npm run check:guardrails` «VEREDICTO: VERDE (25/25)» (Fedora, 9 oct 2026).
- Gate local sobre el árbol del tag (Fedora, Node v22.23.1, 9 oct 2026): `npm run check` «VEREDICTO: VERDE (8/8)»
  (5422 tests, 334 ficheros), `npm run check:guardrails` «VEREDICTO: VERDE (25/25)», `release preflight: pass`,
  `node scripts/changelog-entry.mjs 0.6.16` con salida 0 y `release package: PASS`
  (`tyrian-companion-0.6.16.zip` construido en local, sha256
  `dcc05c42ca5ea3ef775816eca04632dcf9432f715f1c35c7287dc66431c982fc`). Sobre la release planeada, `BRAT release
  contract: PASS (version=0.6.16; assets=8)`.
- Publicación: el workflow de release (run 37896818717) terminó con todos los pasos en `success`. Contrato sobre la
  release real (salida de `gh api repos/fodaveg/tyrian-companion/releases/tags/0.6.16` normalizada con
  `brat-release-plan.mjs --from-github`): «BRAT release contract: PASS (version=0.6.16; assets=8)». Los ocho assets
  están `uploaded` y no vacíos: `hebra-main.mjs` 2626291, `hebra-styles.css` 118003, `hebra.json` 32733, `main.js`
  1928725, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.16.zip` 2023809 y
  `tyrian-companion-0.6.16.zip.sha256` 94 (bytes).
- Revisión: el lote de las Bases tuvo un revisor independiente en tres pasadas («integrar con correcciones» dos veces
  y después «integrar»). Los metadatos de versión y la entrada de changelog los leyó solo el integrador.
- CI de `main` sobre `c6a10f5` (run 37896808682): `completed` con conclusión
  `success` (leído con `gh run view --json status,conclusion,jobs` el 9 oct 2026). Jobs `detect-native-changes`,
  `check-guardrails`, `check` y `release-package` en `success`; `rust-portable` y `rust-windows-helper` omitidos
  (`skipped`). Dentro de `check`, en `success`: `npm run check`, `npm run bench:h6-performance`,
  `npm run test:bench:h6-performance-red`, `npm run bench:h6-live-session` y `npm run bench:h6-live-session-red`.
- Addon de Nexus: 0.8.3 publicado el mismo día (sección siguiente); no cambia el protocolo con el plugin.
- No verificado: nadie ha visto la 0.6.16 instalada ni cargada en Obsidian/BRAT ni en Hebra: ni la creación,
  actualización y retirada de Bases al cargar, ni la columna «Icono» pintada, ni el ajuste de archivos eliminados.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Addon de Nexus 0.8.3 publicado (9 oct 2026)

[Addon de Nexus 0.8.3](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.3), publicado el
2026-10-09T06:22:17Z, con el tag sobre `9c94dba`. DLL de 4448256 bytes, sha256
`c0e6880223aa6e0185b11b8dc8d12ba28a197504718ba89fe8d49133ef28ad8b`. Requiere Tyrian Companion 0.6.10 o posterior; el
protocolo con el plugin no cambia. Es la segunda ronda de rendimiento de la auditoría del 8 oct 2026: tramas escritas
desde estructuras, ajustes guardados en un hilo propio, caché del hallazgo mágico y hilo del juego guardado.
Verificación del addon: 398 tests, las mismas 257 importaciones que la 0.8.2, una exportación (`GetAddonDef`) y dos
builds limpios con el mismo SHA-256.

- Instalado en el equipo de David el 9 oct 2026. Visto por David en el juego (captura, 9 oct 2026): `Status:
  connected`; el panel «Tyrian · Laberinto» muestra 102 huecos libres y MF 333 %, iguales a la pantalla de opciones
  del addon (`102 free`, `333% = luck 300 + server 13 + effects 20`, `Currencies covered: 55`, `Reader: last pass 0 s
  ago`).
- Sin ver: el número de versión 0.8.3 en pantalla, un cambio de mapa, un cambio de personaje, un cambio de mejora de
  hallazgo mágico, el panel del plugin en Hebra recibiendo esos datos, y Windows.

## Canal 0.6.15 publicado: el monstruo en color con un solo contorno como icono en Hebra (9 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.15](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.15)
es una release normal, sin draft ni prerelease, publicada el 2026-10-09T05:32:22Z; nombre, tag y `manifest.version`
son `0.6.15`. El tag (ligero) apunta a `d6fbd424613d05b5dd9663198d441676ddce0695` (commit vacío de atestación, árbol
`38d3d73d75ac0374162cc92d7e38debd85bf3ccd`, padre `4fdf359`). Parte de `f4f5496` (main con el canal 0.6.14 publicado
y el icono «C1» ya integrado). Lleva un solo cambio: `assets/hebra-icon.png` pasa de la variante «B» (borde negro y filo claro, de
la 0.6.12) a la variante «C1», que eligió David el 9 oct 2026 («creo que la versión con doble borde no funciona»)
de una lámina con el icono vigente y ocho variantes a tamaño real en tema oscuro y claro. Motivo: la barra de
pestañas de Hebra pinta el icono a unos 18 px (estimado de una captura, no medido) y a ese tamaño el borde y el
filo de «B» quedaban en unos 0,7 px y 0,4 px. El detalle está en [CHANGELOG](CHANGELOG.md). Metadatos de versión
alineados en `manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian
1.11.4, como la 0.6.14).

- El PNG nuevo: 23803 bytes, sha256 `6a478bd5cd4e1b894c590ecd6f27bf6826476a938ec632c0c1da03fe032fb84e`, el dibujo a
  color del monstruo con un contorno ciruela `#3a1430` de unos 3,5 px a 128 px, recorte de 120 de 128 px, un 45 %
  más de saturación y contraste sigmoidal; el origen y los comandos están en `assets/README.md`. El fichero del
  repo es copia byte a byte de la variante elegida. `icon: "sword"` sigue de respaldo, el validador de `iconImage`
  y sus límites no cambian, y Obsidian sigue con la espada.
- Medido en la preparación (no es el gate): `npm run check` sobre `f4f5496`, antes de los metadatos, dio
  «VEREDICTO: VERDE (8/8)» (Fedora, 9 oct 2026); `node scripts/tests/probar-release-package.mjs` en PASS con el icono
  real.
- Publicación: el workflow `release.yml` (run 37888702711) terminó con todos los pasos en `success`, incluidos el gate
  dentro del job, el contrato BRAT previo a publicar y «Confirm the published release against the contract». La
  release tiene ocho assets, todos `uploaded` y no vacíos: `hebra-main.mjs` 2623298, `hebra-styles.css` 118003,
  `hebra.json` 32733, `main.js` 1927454, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.15.zip`
  2022538 y `tyrian-companion-0.6.15.zip.sha256` 94 (bytes). `release:brat-verify` en local, sobre la salida real de
  `gh release view 0.6.15 --json tagName,name,isDraft,isPrerelease,publishedAt,url,assets`: «BRAT release contract:
  PASS (version=0.6.15; assets=8)».
- Contenido descargado de la release: `hebra.json` con `version` 0.6.15, `icon` `sword` e `iconImage` de 23803 bytes
  descodificados, sha256 `6a478bd5cd4e1b894c590ecd6f27bf6826476a938ec632c0c1da03fe032fb84e`, idéntico byte a byte a
  `assets/hebra-icon.png` del repo; `manifest.json` con `version` 0.6.15.
- Gate local sobre el candidato `4fdf359` (mismo árbol que el tag; Node v22.23.1, árbol limpio antes y después, todo
  con exit 0): `check` «VEREDICTO: VERDE (8/8)» (5376 tests, 334 ficheros), `check:guardrails` «VEREDICTO: VERDE
  (25/25)», `release preflight: pass`, `node scripts/changelog-entry.mjs 0.6.15` y `release package: PASS` con
  `tyrian-companion-0.6.15.zip` construido en local, sha256
  `f8e545a8a5c53ab9d2aea9e6bfb7ead8e3124945065614bab6aef7cb13e7b069`; no se ha comparado con el sha256 del zip
  publicado. El benchmark H6 no se corrió en local; lo corre la CI de `main`.
- CI de `main` sobre `d6fbd42` (run 37888694302): `completed` con conclusión
  `success` (leído con `gh run view` el 9 oct 2026, 05:35 UTC). Jobs `detect-native-changes`, `check-guardrails`,
  `check` (con los pasos `bench:h6-performance`, `bench:h6-live-session` y sus pruebas en rojo) y `release-package`
  en `success`; `rust-portable` y `rust-windows-helper` omitidos (`skipped`).
- Addon de Nexus: sin cambios (0.8.2).
- No verificado: nadie ha visto el icono «C1» pintado en Hebra real, y los 18 px son una estimación. Tampoco la
  instalación ni la carga de la 0.6.15 en Hebra ni en Obsidian/BRAT.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Canal 0.6.14 publicado: cinco arreglos de la nota resumen de sesión (8 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.14](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.14)
es una release normal, sin draft, publicada el 2026-10-08T14:06:29Z; nombre, tag y `manifest.version` son `0.6.14`. El
tag (ligero) apunta a `f65066313d16d0998e6d1b290e0874f635a9b6ef` (commit vacío de atestación, árbol
`6f21c0d8b1a3a2a39254643dfb8231b6d1648f0c`; candidato `7e488bb`). Parte de `8692853` (main con el canal 0.6.13
publicado). La 0.6.13 se vio
cargar en Hebra y escribir una nota resumen real: la de una sesión cerrada bajo la 0.6.12, escrita al cargar la
0.6.13 por primera vez, cinco horas y media después del cierre. De esa nota salen los cinco arreglos, descritos en
[CHANGELOG](CHANGELOG.md): los objetos y las monedas salían como número a secas (ahora nombre desde la caché del
catálogo, o `Objeto <id>` / `Moneda <id>`), «por hora sin» el objeto dominante enseñaba un ritmo negativo, «La lista
puede estar incompleta.» quedaba dentro de la última viñeta de «Mapas», la cabecera decía «100 % observado» con 8
tramos sin observar y, con una sola unidad, «Salieron del inventario 1 objetos». Metadatos de versión alineados en
`manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian 1.11.4, como
la 0.6.13); `release-identity-contract` y `release-preflight` en verde sobre el commit de metadatos.

- Medido en la preparación, sobre el código de los arreglos (verificación dirigida, no es el gate):
  `src/sessions/live-session-summary-note.test.ts` (71 tests) y `src/runtime/live-session-summary-names.test.ts` (5
  tests, sobre el cableado real del núcleo con una sesión restaurada) en verde, dentro de una pasada de 13 ficheros y
  252 tests; `tsc --noEmit --skipLibCheck` sin errores; `action-observability-census` en PASS sin tocar su línea
  base; `probar-h8-helper-decision-contract` en PASS. Cada arreglo tiene un test que se vio fallar con el
  comportamiento anterior.
- Publicación: el workflow `release.yml` (run 37789402116) terminó con conclusión `success`, sin ningún paso distinto
  de `success`. La release tiene ocho assets, todos `uploaded`: `hebra-main.mjs` 2623298, `hebra-styles.css` 118003,
  `hebra.json` 27745, `main.js` 1927454, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.14.zip`
  2022538 y `tyrian-companion-0.6.14.zip.sha256` 94 (bytes). `release:brat-verify` contra la salida real de
  `gh release view 0.6.14 --json tagName,name,isDraft,assets`: «BRAT release contract: PASS (version=0.6.14; assets=8)».
- Gate local sobre el árbol del tag (`6f21c0d8…`, commit `7e488bb`): `check` VERDE 8/8 (5376 tests, 334 ficheros),
  `check:guardrails` VERDE 25/25 (326 tests), `release preflight: pass` y `release package: PASS` con
  `tyrian-companion-0.6.14.zip` construido en local, sha256
  `299a4119c968ed3749d18f52d996cbebe4d35d40f07fe1e36040f9e374006821`; no se ha comparado con el sha256 del zip
  publicado. El benchmark `bench:h6-live-session` no se corrió en local para la 0.6.14.
- CI de `main` sobre `f650663` (run 37789392571): `success`. Jobs `detect-native-changes`, `check-guardrails`,
  `check` (con los pasos `bench:h6-performance`, `bench:h6-live-session` y sus pruebas en rojo) y `release-package`
  en `success`; `rust-portable` y `rust-windows-helper` omitidos (`skipped`).
- Lo que no cambia: una nota resumen ya escrita no se reescribe (la de la 0.6.13 se queda como está); ninguna clave
  nueva, `tyrian_summary_version` sigue en 3 y la Base «Sesiones» es la misma; ningún host, endpoint ni uso de red
  nuevo (`docs/PLATFORM_POLICY.md` no cambia) y ninguna petición durante la carga del plugin. Los nombres de objetos
  y monedas salen de memoria y de la caché del catálogo, nunca de la red; la única petición de la nota resumen sigue
  siendo `maps`, tras cerrar la sesión.
- Visto de la 0.6.13 desde su publicación: cargó en Hebra y escribió esa nota resumen (la sesión del 8 oct,
  09:46–11:42 hora local). Esa nota se corrigió a mano en Hebra el 8 oct con los nombres de la API pública y el texto
  que escribe la 0.6.14; no la reescribió el plugin.
- No verificado: ninguno de los cinco arreglos se ha visto en un cliente real. Nadie ha visto todavía una nota
  resumen de una sesión cerrada ya con la 0.6.13 o posterior, ni la Base «Sesiones» pintada, en Obsidian o en Hebra.
- Sigue sin verse de versiones anteriores (listado en las secciones de abajo, que se conservan): de la 0.6.13, la
  nota resumen en Obsidian, el sonido de los avisos en Hebra, un cambio de personaje a mitad de sesión en el juego y
  su instalación en Obsidian/BRAT; el icono con borde de la 0.6.12 pintado en Hebra y la instalación de la 0.6.12 en
  Obsidian/BRAT; en el addon de Nexus 0.8.0, 0.8.1 y 0.8.2, una bajada de hallazgo mágico con su aviso, los tooltips,
  plegar y cerrar, el diagnóstico de Opciones, una sesión larga sin parpadeos, el icono nuevo del botón de fondo del
  addon y Windows.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT); la instalación y la carga de la
  0.6.14 no se han comprobado en ninguno. Tampoco se ha visto nada del addon 0.8.2 dentro del juego (el DLL 0.8.2
  está instalado).

## Canal 0.6.13 publicado: nota resumen de sesión, Base «Sesiones» y arreglos de la auditoría (8 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.13](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.13)
es una release normal, sin draft, publicada el 2026-10-08T13:10:29Z; nombre, tag y `manifest.version` son `0.6.13`. El
tag (ligero) apunta a `e078ea5dea53abf7c959c4a164205db37d5d36cb` (commit vacío de atestación, árbol
`cb830554fed990be8406effb855ec3cc38ef959f`). Parte de `9eb8b3e` (0.6.12 publicada) y recoge la auditoría de
integración (`8001213`, unos 90 commits). Lo que trae, agrupado por lo que nota el usuario, está en
[CHANGELOG](CHANGELOG.md): la nota resumen al cerrar una sesión en vivo (frontmatter `tyrian_summary_*` versión 3,
media propia por mapa principal desde 3 sesiones comparables, nombres de mapa por `/v2/maps`), la Base «Sesiones»
(`bundleVersion` 7), el personaje actual en el panel en vivo, «por hora» solo desde 15 minutos observados, y los
arreglos de sesión en vivo, rendimiento, Venta, avisos, semillas de precio y host de Hebra. Metadatos de versión
alineados en `manifest.json`, `package.json`, la raíz de `package-lock.json` y `versions.json` (mínimo de Obsidian
1.11.4, como la 0.6.12); `release-identity-contract` y `release-preflight` en verde sobre el commit de metadatos.

- Gate medido por el orquestador sobre `8001213` (es de ese commit, no de los dos commits de esta preparación, que
  solo tocan metadatos y documentación): `check` VEREDICTO: VERDE (8/8), 5351 tests en 333 ficheros;
  `check:guardrails` VEREDICTO: VERDE (25/25); el benchmark `bench:h6-live-session` dentro de presupuesto (fin p95
  44,09 ms de 100; razón fin/inicio 1,052 de 6; cierre 1218,5 ms de 6000; nota 13 059 235 B de 20 MiB).
- Publicación: el workflow `release.yml` (run 37781724040) terminó con todos los pasos en success, incluidos «Gate»,
  «BRAT contract as a pre-publication gate» y «Confirm the published release against the contract». La release tiene
  ocho assets, todos `uploaded`: `hebra-main.mjs` 2620309, `hebra-styles.css` 118003, `hebra.json` 27745, `main.js`
  1925284, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.13.zip` 2020368 y
  `tyrian-companion-0.6.13.zip.sha256` 94 (bytes). `release:brat-verify` contra la salida real de
  `gh release view 0.6.13 --json tagName,name,isDraft,assets`: «BRAT release contract: PASS (version=0.6.13; assets=8)».
- Gate local sobre el árbol del tag (`cb830554…`, commit `5ffb22d`): `check` VERDE 8/8 (5351 tests, 333 ficheros),
  `check:guardrails` VERDE 25/25 (326 tests), `release preflight: pass` y `release package: PASS` con
  `tyrian-companion-0.6.13.zip` construido en local, sha256
  `4b18ec13475603430dccd30e9f91a6b011983d54fa6a6a62ab1dc0654a0d6da6`; no se ha comparado con el sha256 del zip
  publicado.
- CI de `main` sobre `e078ea5` (run 37781711863): `success`. Jobs `check`, `check-guardrails`, `detect-native-changes`
  y `release-package` en `success`; `rust-portable` y `rust-windows-helper` omitidos (`skipped`).
- No verificado: nada de la 0.6.13 se ha visto en un cliente real. Ni la nota resumen ni la Base «Sesiones» en
  Obsidian o en Hebra, ni el sonido de los avisos en Hebra, ni un cambio de personaje a mitad de sesión en el juego;
  tampoco la instalación de la 0.6.13 en Hebra ni en Obsidian/BRAT.
- Límites conocidos: los journals de sesiones cerradas antes de la 0.6.13 no se podan; con dos hosts sobre el mismo
  almacén y sin sesión activa, uno puede podar journals que el otro retiene. Volver a la 0.6.12 deja los activos
  gestionados en conflicto hasta repararlos (el paquete pasa de 6 a 7).
- Sigue sin verse de versiones anteriores (listado en las secciones de abajo): el icono con borde de la 0.6.12
  pintado en Hebra y la instalación de la 0.6.12 en Obsidian/BRAT; en el addon de Nexus 0.8.0, 0.8.1 y 0.8.2, una bajada de
  hallazgo mágico con su aviso, los tooltips, plegar y cerrar, el diagnóstico de Opciones, una sesión larga sin
  parpadeos, el icono nuevo del botón de fondo del addon y Windows.
- Pendiente: la verificación en clientes reales (Hebra instalada y Obsidian/BRAT).

## Addon de Nexus 0.8.2 publicado (8 oct 2026)

[Addon de Nexus 0.8.2](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.2): tag anotado sobre
`85f5b54c2bea945b3b34e02140f4fb324c911132`, con dos ficheros: `tyrian_companion_nexus.dll` (4384256 bytes, sha256
`53053578f6353c70171ebbfca603352df1d12a5f480ef3135106b26697bfab3c`) y `tyrian_companion_nexus.dll.sha256`; la
descarga de la release se comprobó con `sha256sum -c`. Medido sobre `85f5b54`: 383 tests, `check-dead-thread-code: OK`,
257 importaciones (la misma lista que el 0.8.1), una exportación (`GetAddonDef`) y dos builds limpios con el mismo
SHA-256. Requiere Tyrian Companion 0.6.10 o posterior; el protocolo con el plugin no cambia. David lo instaló él
mismo el 8 oct 2026 con el juego cerrado: `~/.local/share/Steam/steamapps/common/Guild Wars 2/addons/TyrianCompanion.dll`
tiene el sha256 de la release 0.8.2 y la copia del 0.8.1 quedó como `TyrianCompanion.dll.0.8.1.bak`. Instalado no es
visto funcionando: no verificado, nada del 0.8.2 se ha visto dentro del juego.

## Canal 0.6.12 publicado: el monstruo con borde como icono en Hebra (8 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.12](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.12)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.12`. El tag apunta a
`44fe782` (commit vacío de atestación del candidato `e940769`, árbol `a7218823ca381a0f0128060b4f316d1d2b27f2a6`).
Parte de `20ec61d` (main tras el addon 0.8.0). Lleva un cambio:
`assets/hebra-icon.png` pasa a la variante con borde que eligió David («también quiero que cambies el icono del
monstruo en hebra para poner la versión con borde»; de cuatro variantes sobre tema oscuro y claro eligió «B: negro +
filo claro»). Motivo medido: la línea negra del dibujo de la 0.6.11 mide alrededor de 1 px a 128 px, no se aprecia a
tamaño de icono y en tema oscuro se funde con el fondo; David usa tema oscuro en Fedora. El detalle está en
[CHANGELOG](CHANGELOG.md).

- El PNG nuevo: 128×128 RGBA, 20063 bytes, sha256 `3aaba42b76f92086f7948518ade50b7fc5cd52fe14aa8d7f4845737f8c28669b`,
  hecho a partir de `monstruo-recorte-limpio.png` (el recorte sin línea) con un borde negro `#141414` de 5 px y un
  filo claro `#f4f1ea` de 3 px; el comando está en `assets/README.md`. `icon: "sword"` sigue de respaldo y el
  validador de `iconImage` y sus límites no cambian.
- Publicación: el workflow `release.yml` (run 37745407456) terminó en success y la CI de `main` (run 37745405121)
  también. La release tiene ocho assets, todos `uploaded`: `hebra-main.mjs` 3327783, `hebra-styles.css` 118003,
  `hebra.json` 27745, `main.js` 1887738, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.12.zip`
  1982822 y `tyrian-companion-0.6.12.zip.sha256` 94 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.12; assets=8)».
- `hebra.json` descargado de la release: `version` 0.6.12, `icon` `sword`, `iconImage` de 20063 bytes
  descodificados, 128×128, sha256 `3aaba42b…`, idéntico byte a byte a `assets/hebra-icon.png` del repo.
- Gate local previo, sobre el árbol del tag (Fedora, Node v22.23.1, 8 oct 2026), en una sola pasada sin rojos:
  `check` 8/8 (5136 tests, 324 ficheros, ninguno saltado), guardrails 25/25, `release:preflight` en verde y
  `node scripts/changelog-entry.mjs 0.6.12` con exit 0. El benchmark H6 y su sabotaje no se corrieron en local; los
  corre la CI de `main`.
- No verificado: el icono con borde pintado en Hebra (David aún no ha actualizado a la 0.6.12); la instalación de la
  0.6.12 en Obsidian/BRAT; la web `app.hebra.pro`, TestFlight y Windows.
- Pendiente: la verificación en Hebra instalada y en Obsidian/BRAT.

## Addon de Nexus 0.8.1 publicado (8 oct 2026)

[Addon de Nexus 0.8.1](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.1): tag anotado sobre
`37e48df` (dos commits sobre el 0.8.0), con dos ficheros: `tyrian_companion_nexus.dll` (4324864 bytes, sha256
`61b3d5781c3abb1bd5ad272ed7f068a04cf83a9b435f5f2d452c20a4b6b3e0a1`) y `tyrian_companion_nexus.dll.sha256` (93 bytes);
descargados y suma comprobada. Único cambio: el botón de la barra de título que quita o pone el fondo se dibuja como
el signo de contraste (círculo con la mitad izquierda rellena) en vez de un cuadrado, a petición de David («el icono
del fondo parece un botón de stop»). 301 tests y las mismas 257 importaciones que el 0.8.0. David lo instaló él
mismo con el juego cerrado (el DLL de su carpeta de addons tiene ese sha256). No verificado: el icono nuevo visto
dentro del juego. El plugin no cambia con este addon.

## Addon de Nexus 0.8.0 publicado (8 oct 2026)

[Addon de Nexus 0.8.0](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.0): release normal, tag
anotado `0.8.0` sobre `ff9702b` (14 commits sobre el 0.7.2, `c3a7763`), con dos ficheros: `tyrian_companion_nexus.dll`
(4325376 bytes, sha256 `7651c12f0c3a6bcad78c50ee282dd7f900d14d6ced55a368f650247d6b453a8b`) y
`tyrian_companion_nexus.dll.sha256` (93 bytes); descargados de GitHub y suma comprobada. Pide Tyrian Companion 0.6.10
o posterior. El plugin no cambia con este addon.

- Contenido: el panel de Laberinto rediseñado según el boceto de David (dos columnas: bolsas y ritmo / stack con
  pedido y oferta brutos; tres líneas: Huecos, MF y Estado con punto de color; barra de título propia con botón
  para quitar el fondo; altura fija), y dos lecturas pasivas nuevas dentro del addon: huecos libres reales
  (capacidad de las bolsas puestas menos posiciones ocupadas) y hallazgo mágico total con desglose (suerte,
  servidor, efectos) y aviso cuando baja respecto al máximo de la sesión. Retención de 5 s para que un ciclo
  fallido no haga parpadear cifras ni el punto de estado.
- Esas dos lecturas NO llegan al plugin en esta versión: `live_begin.slots` sigue en `null` y ninguna trama lleva
  hallazgo mágico. Lo que el panel del juego muestra de huecos y MF es solo del addon; el plugin sigue tratándolos
  como desconocidos.
- Verificación del addon (informada desde su repo): 301 tests (`cargo test --locked`), build Windows x64
  reproducible con las mismas 257 importaciones que la 0.7.2 y una exportación, y tres revisiones independientes
  del código, la última sin caminos a pánico ni a bloqueo.
- Evidencia previa: las sondas externas de solo lectura `docs/audit/loot-mf-probe` y
  `docs/audit/loot-bag-capacity-probe` (capacidad 414, igual que el inventario; hallazgo mágico 333 % y, tras un
  cambio, 363 %, iguales que el panel de héroe). El perfil auditado de bolsas ganó la guarda del getter de libres
  (`1620b39`) DESPUÉS de las ejecuciones en vivo, que fueron con 11 guardas.
- Instalado en la máquina de David (Fedora) con el juego cerrado: el DLL de la carpeta de addons tiene ese sha256.
- Visto por David en el juego (8 oct 2026, Fedora con Proton, en un arranque nuevo del juego): el panel se pinta
  como el boceto con el fondo quitado; «MF: 363%» sin «parcial» (igual que su panel de héroe esa mañana); «Estado:
  ● Midiendo»; precios 8g 32s 50c y 10g 40s 0c; y «Huecos: 99 libres», que David contrastó con su inventario («los
  huecos están correctos, son esos numeros»). Con eso quedan verificados en el juego el recuento de ocupados y que
  la regla de alineación aguanta otro arranque.
- Sigue sin verse: una bajada de hallazgo mágico con su aviso, los tooltips, plegar y cerrar, el diagnóstico de
  Opciones, una sesión larga sin parpadeos, y Windows.

## Canal 0.6.11 publicado: el monstruo como icono propio en Hebra (8 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.11](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.11)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.11`. El tag apunta a
`6ce6bb3` (commit vacío de atestación del candidato `bba18ae`, árbol `2199a566541f05a82d3fc88121e98a7a0c966afb`).
Parte de `0dfc1b6` (main tras la 0.6.10) y lleva un cambio: `hebra.json` declara `iconImage` (PNG de 128 px
versionado en `assets/hebra-icon.png`) con `icon: "sword"` de respaldo. El detalle está en [CHANGELOG](CHANGELOG.md).

- Publicación: el workflow Release (run 37738916548) terminó en success y la CI de `main` (run 37738914422)
  también. La release tiene ocho assets, todos `uploaded`: `hebra-main.mjs` 3327783, `hebra-styles.css` 118003,
  `hebra.json` 30793, `main.js` 1887738, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.11.zip`
  1982822 y `tyrian-companion-0.6.11.zip.sha256` 94 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.11; assets=8)».
- `hebra.json` descargado de la release: `version` 0.6.11, `icon` `sword`, `iconImage` con prefijo
  `data:image/png;base64,`, 22350 bytes descodificados, 128×128, firma PNG, IHDR e IEND correctos, e idéntico byte
  a byte a `assets/hebra-icon.png` del repo.
- Gate local previo, sobre el árbol del tag (Fedora, Node v22.23.1, 8 oct 2026): `check` 8/8 (5136 tests, 324
  ficheros, ninguno saltado), guardrails 25/25, `release:preflight` en verde y `node scripts/changelog-entry.mjs
  0.6.11` con exit 0. El benchmark H6 y su sabotaje no se corrieron en local; los corre la CI de `main`.
- Rojo intermedio: una primera pasada sobre `95e0eb8` dio guardrails 24/25 (`beta-channel`): el fixture de esa
  suite no llevaba `assets/hebra-icon.png`. Se arregló en `3b6cadb` dándole el icono real a la raíz de prueba,
  sin relajar el empaquetado (que falte el icono sigue siendo un error).

- Verificado en el candidato: `scripts/tests/probar-release-package.mjs` (incluye 9 casos negativos de `iconImage` y el positivo),
  las suites de contrato BRAT, plan BRAT, escáner de seguridad e identidad de release, `src/host/hebra` (209
  tests) y `security-scan`. El paquete de Hebra se armó una vez: `hebra.json` pesa 30793 bytes y su `iconImage`
  empieza por `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAA`.
- Sitios donde el plugin pide su icono con el nombre `sword` (el mismo que `icon`): ribbon
  (`src/runtime/tyrian-companion-core.ts:5201`), vista y pestaña (`src/ui/companion-view.ts:175`), entrada «abrir»
  del menú (`src/ui/session-command-adapter.ts:16,70`). No hay barra de estado. Con otro nombre a propósito, y
  sin tocar: las vistas del asesor (`package-search`) y de venta (`candy`), el icono `inbox` de una entrada de
  menú y los iconos de acción internos.
- Visto por David (8 oct 2026, Fedora): instaló el rpm de Hebra 0.2.0-6 y la 0.6.11 del plugin (medido en su
  máquina: `rpm -q hebra` da `hebra-0.2.0-6.x86_64` y existe `~/.local/share/net.fodaveg.hebra/plugins/tyrian-companion/0.6.11/`)
  y vio el monstruo pintado, lo bastante para pedir que se le viera el borde (ver la 0.6.12). Es evidencia parcial en
  Hebra sobre Linux; no cambia el estado del canal.
- No verificado: la instalación de la 0.6.11 en Obsidian/BRAT; el icono en la web `app.hebra.pro`, en TestFlight y en
  Windows. Antes de esa instalación, el Hebra con rpm 0.2.0-5 ignoraba el campo y pintaba la espada. Ningún plugin
  real había publicado `iconImage` antes. En tema oscuro la línea negra del dibujo se funde con el fondo (motivo
  de la 0.6.12).
- Pendiente: la verificación en Obsidian/BRAT.

## Canal 0.6.10 publicado: «Por hora» con oro y precio bruto `price2` (8 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.10](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.10)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.10`. El tag apunta a
`6ab0e0b` (árbol `8da538d3ba2a0b1a06c845b2b787887c92c99380`); la atestación del candidato `1566554` es
`e6c2b3e` (árbol `977a0452fe6525c5f7346339de1a4ddacc32aee0`) y `6ab0e0b`, encima, es solo documentación.
Parte de `c550bbd` (canal 0.6.9 publicado) y lleva cuatro cambios:
«Por hora» de la pestaña «Sesión» pasa a ser la tasa del mismo valor que «Valor estimado» (objetos más oro
observado), el puente manda al addon el precio bruto del bazar en una trama `price2` que sustituye a `price1`,
el icono de Tyrian pasa de la brújula a la espada en Hebra y en Obsidian, y la gráfica de la pestaña «Sesión»
va antes que los objetos.
El detalle está en [CHANGELOG](CHANGELOG.md).

- Publicación: el workflow `release.yml` (run 37732446768) terminó en success y la CI del tag (run 37732422933)
  también. La release tiene ocho assets, todos `uploaded`: `hebra-main.mjs` 3327783, `hebra-styles.css` 118003,
  `hebra.json` 953, `main.js` 1887738, `manifest.json` 237, `styles.css` 94537, `tyrian-companion-0.6.10.zip`
  1982822 y `tyrian-companion-0.6.10.zip.sha256` 94 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.10; assets=8)».
- Gate local previo, sobre el árbol del tag (Fedora, Node v22.23.1, 8 oct 2026): `check` 8/8 (5136 tests, 324
  ficheros, ninguno saltado), guardrails 25/25, `release:preflight` en verde y `node scripts/changelog-entry.mjs
  0.6.10` con exit 0. El gate se corrió cinco veces a lo largo del día, una por árbol candidato, todas verdes.
  El benchmark H6 y su sabotaje no se corrieron en local porque el juego estaba abierto; los corre la CI de `main`.
- Incidente de publicación: el primer tag `0.6.10` se empujó sobre `e6c2b3e` y el workflow Release 37731908556
  falló en Publish con `changelog-entry: version-not-found for version 0.6.10`, porque la entrada estaba
  encabezada «Candidato 0.6.10» y el extractor solo lee «Release beta <versión>». No se creó ninguna release.
  Se corrigió el encabezado (`6ab0e0b`), se repitió el gate, se borró el tag remoto y se recreó sobre
  `6ab0e0b`. La CI de `e6c2b3e` (37731898689) sí fue success. Es la misma trampa que la 0.6.0 (`bffb6fa`).
- Addon de Nexus 0.7.2 publicado (8 oct 2026): [release 0.7.2](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.7.2),
  tag anotado `0.7.2` sobre `c3a7763`, con dos ficheros: `tyrian_companion_nexus.dll` (4234240 bytes, sha256
  `55b041f5893416455da41fc3961c7a70190009d7f10b8500a4981f991ff9fff3`) y `tyrian_companion_nexus.dll.sha256`
  (93 bytes); descargados de GitHub y suma comprobada.
- Evidencia parcial en Hebra (David, 8 oct 2026, Fedora con Proton): Tyrian Companion 0.6.10 cargado en Hebra y
  addon 0.7.2 en el juego. `price2` de punta a punta: el panel mostró «Pedido» 8g 32s 50c y «Oferta» 10g 45s 0c,
  las mismas cifras que la API pública del bazar para el objeto 36038 (pedido 333 y oferta 418 por unidad)
  multiplicadas por 250. Con el plugin 0.6.9 y el addon 0.7.2 el bloque de precio no se pintaba (lo vio David antes
  de actualizar). Esto no cambia el estado del canal: sigue siendo «canal publicado; instalación/runtime pendiente»
  mientras no se verifique en el cliente BRAT/Obsidian real.
- No verificado: la 0.6.10 en Obsidian/BRAT (en el vault de David hay una 0.2.20 antigua); el aspecto real de la
  pestaña «Sesión» reordenada y del icono de espada (David no ha dicho nada de ellos); Windows.
- Límite de compatibilidad: hace falta el addon de Nexus 0.7.2 como mínimo (el 0.8.0 es posterior y también vale); con el 0.7.1 el panel del juego deja de pintar el
  bloque de precio hasta actualizar.
- Límite: el denominador de «Por hora» es el tiempo de objetos observado; un hueco de monedas no lo acorta.

## Canal 0.6.9 publicado: las monedas observadas como teselas (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.9](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.9)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.9`. El tag apunta
a `de2555a` (atestación del candidato `5e121fe`, árbol `62520ba6dfdccd7b578b8d4ef153910345110d3e`). Parte de
`9a8824c` (canal 0.6.8 publicado); el detalle está en [CHANGELOG](CHANGELOG.md).

- Publicación: el workflow `release.yml` (run 37663104383) terminó en success. La release tiene ocho assets,
  todos `uploaded`: `hebra-main.mjs` 3327855, `hebra-styles.css` 118275, `hebra.json` 954, `main.js`
  1887848, `manifest.json` 236, `styles.css` 94809, `tyrian-companion-0.6.9.zip` 1983203 y
  `tyrian-companion-0.6.9.zip.sha256` 93 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.9; assets=8)». La CI de `main` para
  `de2555a` (run 37663101900) terminó en success (`check`, `check-guardrails`, `detect-native-changes` y
  `release-package`; los dos jobs de Rust se saltaron por no haber cambio nativo); corre el benchmark H6 y su
  sabotaje, que no se corrieron en local.
- Gate local previo, sobre el árbol atestado (Fedora, Node v22.23.1, 7 oct 2026), verde a la primera: `check`
  8/8 (5134 tests, 324 ficheros, ninguno saltado), guardrails 25/25 y `release:preflight` en verde. El
  benchmark H6 y su sabotaje no se corrieron en local porque el juego estaba abierto en la máquina.

- Contenido: en la pestaña «Sesión», las monedas observadas se pintan como teselas con icono en una sección
  «Monedas» con su contador, en la sesión en curso y en «Sesiones anteriores». Nombre e icono salen del
  catálogo público `/v2/currencies`, sin clave ni datos de cuenta. El oro se muestra en una sola unidad para
  que quepa en la tesela. La nota de sesión guardada lleva el nombre resuelto cuando ya está en memoria.
- Motivo: el 7 oct 2026, en la máquina del jugador (Fedora, GE-Proton), las monedas llegaron a la pestaña
  «Sesión» de Hebra como lista de texto con «?».
- Verificado hoy en esa máquina: el precio del saco (`price1`) se vio pintado en el panel del juego con el
  addon de Nexus 0.7.1 contra el plugin en Hebra (no se anotó si era la 0.6.7 o la 0.6.8). El addon 0.7.1 está
  integrado en el `main` de su repo, publicado como release `0.7.1` (DLL y su `.sha256`) e instalado ahí.
- No verificado: la 0.6.9 instalada en Hebra u Obsidian; el aspecto real de las teselas de moneda en Hebra
  (solo medido en un montaje de navegador con iconos reales); una respuesta real del catálogo de monedas
  dentro del plugin (la forma de la respuesta sí se comprobó a mano contra la API pública); la nota guardada
  con nombres de moneda; las líneas de antigüedad ocultas del panel del addon (el jugador no lo ha confirmado).

## Canal 0.6.8 publicado: recuperación ante la caída del almacén local (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.8](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.8)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.8`. El tag apunta
a `ca90259` (atestación del candidato `543312e`, árbol `d92bb690e4197ecde3b4ed466fcdc20b5e554e2b`). Parte de
`f11872d` (canal 0.6.7 publicado) y suma la recuperación ante la caída de IndexedDB (incidente del 7 oct 2026
en Hebra, WebKitGTK 2.54.1) y la línea base del censo de observabilidad reconciliada con las fronteras de esos
cambios; el detalle está en [CHANGELOG](CHANGELOG.md).

- Publicación: el workflow `release.yml` (run 37656040866) terminó en success. La release tiene ocho assets,
  todos `uploaded`: `hebra-main.mjs` 3320361, `hebra-styles.css` 118737, `hebra.json` 954, `main.js`
  1883945, `manifest.json` 236, `styles.css` 95271, `tyrian-companion-0.6.8.zip` 1979762 y
  `tyrian-companion-0.6.8.zip.sha256` 93 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.8; assets=8)». La CI de `main` para
  `ca90259` (run 37656036881) terminó en success (`check`, `check-guardrails`, `detect-native-changes` y
  `release-package`; los dos jobs de Rust se saltaron por no haber cambio nativo); corre el benchmark H6 y su
  sabotaje, que no se corrieron en local.
- Gate local previo, sobre el árbol atestado (Fedora, Node v22.23.1, 7 oct 2026), verde a la primera: `check`
  8/8 (5093 tests, 321 ficheros, ninguno saltado), guardrails 25/25 y `release:preflight` en verde. El
  benchmark H6 y su sabotaje no se corrieron en local porque el juego estaba abierto en la máquina.
- Addon de Nexus: el 0.7.1 está integrado en el `main` de su repo, publicado como release `0.7.1` (DLL y su
  `.sha256`) e instalado en la máquina de David (corregido el 7 oct 2026; antes decía que la 0.7.0 estaba
  instalada a mano y la 0.7.1 sin publicar). Reintenta `live_open` cada 30 s tras un `source_conflict`.

- Contenido: reapertura de conexiones muertas en los almacenes de sesión, coordinación y preferencias;
  `onabort` y reapertura en el backend de ficheros de Hebra; límite de 10 s en las escrituras de diagnóstico; la
  sesión live sale del error con hueco `storage_unavailable` y sin deltas a través de él (`docs/SPEC-live-loot.md`
  §4); relevo de un productor desconectado según el host, nunca con una conexión abierta; el asesor de inventario
  quita su bloqueo de preferencias.
- Revisión independiente hecha antes de publicar: un defecto condicional y tres menores, arreglados con test.
- No verificado: la instalación y carga de la 0.6.8 en Hebra y en Obsidian/BRAT, ni ninguna de las
  recuperaciones en el runtime real. El precio del saco sí se ha visto pintado en el panel del juego (7 oct
  2026, Fedora con GE-Proton, addon 0.7.1 contra el plugin en Hebra; no se anotó si el plugin era la 0.6.7 o
  la 0.6.8). No está demostrado que WebKitGTK acepte una conexión nueva tras ese fallo; si no la acepta, el
  plugin sigue en error, sin bucle.
- Límites conocidos: los de la entrada 0.6.8 del CHANGELOG (almacenes sin reapertura, cola del ciclo de vida
  bloqueable, `replaceLiveJournal` sin reproducir, `live_open` en `source_conflict` durante la caída).

## Canal 0.6.7 publicado: precio del saco de Halloween para el addon del juego (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.7](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.7)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.7`. El tag apunta
a `d82bc09` (atestación del candidato `3b72983`, árbol `618bdbda63699bf9266967ed86cb1aa9e603fe57`). El
plugin sirve al addon el precio público neto del saco de Halloween por la extensión `price1` del puente.

- Publicación: el workflow `release.yml` (run 37654267741) terminó en success. La release tiene ocho assets,
  todos `uploaded`: `hebra-main.mjs` 3299713, `hebra-styles.css` 118737, `hebra.json` 954, `main.js`
  1875841, `manifest.json` 236, `styles.css` 95271, `tyrian-companion-0.6.7.zip` 1971658 y
  `tyrian-companion-0.6.7.zip.sha256` 93 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.7; assets=8)». La CI de `main` para
  `d82bc09` (run 37654263770) terminó en success; corre el benchmark H6 y su sabotaje, que no se corrieron
  en local. La CI de `main` para `f11872d` (run 37655246212, el commit de documentación de la 0.6.7) figura
  como `failure` sin ningún job fallido: `check`, `check-guardrails` y `detect-native-changes` terminaron en
  success y el job `release-package` no llegó a crearse; GitHub no permite relanzar ese run. El commit
  siguiente de `main` (`ca90259`), que lo contiene, tiene la CI completa en success.
- Gate local previo, sobre el árbol atestado (Fedora, Node v22.23.1, 7 oct 2026): `check` 8/8 (5044 tests,
  319 ficheros, ninguno saltado), guardrails 25/25 y `release:preflight` en verde. Una primera corrida sobre
  `c32f941` salió en rojo (7/8): el censo de observabilidad listó 12 fronteras sin revisar del commit del
  precio; `3b72983` las revisó en `scripts/action-observability-baseline.json` sin cambiar decisiones
  previas ni tocar `src/`, y el gate se repitió entero. El benchmark H6 y su sabotaje no se corrieron en
  local porque el juego estaba abierto en la máquina.
- Cambio de producto: `dc1034a` (precio `price1`). Metadatos alineados a 0.6.7.
- No verificado: la instalación y carga de la 0.6.7 en Hebra y en Obsidian/BRAT. El precio necesita el addon
  de Nexus 0.7.x (precio, líneas de antigüedad ocultas y dos iconos de acceso rápido); la 0.7.0 estaba
  instalada a mano en la máquina de David, donde se vieron en el juego los dos iconos y que cada uno abre su
  panel. Corregido el 7 oct 2026: el precio ya se ha visto pintado en el juego (addon 0.7.1, publicado e
  integrado en el `main` de su repo, contra el plugin en Hebra), sin anotar la versión del plugin.
- Fuera de esta versión: la recuperación ante la caída del almacén local (la incidencia abierta de la 0.6.6,
  IndexedDB en Hebra) está implementada en una rama y en revisión.

## Canal 0.6.6 publicado: monedas en las sesiones anteriores y oro observado en el valor (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.6](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.6)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.6`. El tag apunta
a `89f4532` (atestación del candidato `e02372d`, árbol `40cca5cf2f733a5f0db25bd3b8170af3aebd9e8b`), empujado
a las 15:23Z. Las sesiones anteriores muestran sus monedas observadas bajo las teselas de objetos, y «Valor
estimado» y su gráfica incluyen el oro observado si la sesión tuvo el oro cubierto. Las monedas llegan del
addon de Nexus 0.6.0 (lectura de la cartera del juego); con un addon anterior quedan «sin cobertura».

- Publicación: el workflow `release.yml` (run 37643557499) terminó en success. La release tiene ocho assets,
  todos `uploaded`: `hebra-main.mjs` 3292173, `hebra-styles.css` 118737, `hebra.json` 954, `main.js`
  1872131, `manifest.json` 236, `styles.css` 95271, `tyrian-companion-0.6.6.zip` 1967948 y
  `tyrian-companion-0.6.6.zip.sha256` 93 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.6; assets=8)». La CI de `main` para
  `89f4532` (run 37643552543) terminó en success; corre el benchmark H6 y su sabotaje, que no se corrieron
  en local.
- Gate local previo, sobre el árbol atestado: `check` 8/8 (5004 tests pasados y 1 saltado,
  `src/host/hebra/bundle.test.ts`, que solo corre con el bundle de Hebra construido), guardrails 25/25 y
  `release:preflight` en verde. El benchmark H6 y su sabotaje no se corrieron en local porque el juego
  estaba abierto en la máquina.
- Cambios de producto: commits `4674478` y `d920bf8`. Documentación y recibo: `7d34cec`. Fixture de wire y
  test de costura: `43778e5`. Metadatos alineados a 0.6.6.
- Verificado: ruta de cartera validada el 7 oct 2026 con una sonda externa de solo lectura: 55 monedas, mismos
  IDs que la API, 54 saldos idénticos (recibo en `docs/audit/loot-wallet-probe/`). Verificado en la máquina de
  David (Fedora, GE-Proton11-7), con el plugin 0.6.5 en Hebra y el addon de Nexus 0.6.0 (DLL de la rama
  `claude/wallet-reader-20261007` del repo `tyrian-companion-nexus`, sin integrar ni publicar): las opciones
  del addon dentro del juego muestran «Currencies covered: 55» e «Inventory: observations stored».
- No verificado: la instalación y carga de la 0.6.6 en Hebra y en Obsidian/BRAT, un cambio de moneda pintado
  en Hebra durante una sesión real, las monedas de una sesión anterior con datos reales, el oro dentro de
  «Valor estimado» con datos reales y el addon en Windows.
- Incidencia abierta, no causada por la 0.6.6: el 7 oct a las 14:54Z, con el plugin 0.6.5 en Hebra, la
  IndexedDB del plugin dejó de responder tras un error interno de WebKitGTK 2.54.1 y la sesión en vivo quedó
  en «No se pudo guardar» hasta reiniciar Hebra; se perdieron unos 20 minutos de sesión. El endurecimiento
  del plugin (reabrir la conexión y salir del error) está en curso y no va en la 0.6.6.
- Límites: una moneda que la cuenta nunca ha tenido no tiene clave en el juego, y su primera ganancia no se
  cuenta (línea base). El lector solo sirve con el binario del juego del perfil vigente; tras un parche de
  GW2, objetos y monedas quedan sin lectura hasta revalidar.

## Canal 0.6.5 publicado: las sesiones anteriores muestran también sus objetos (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.5](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.5)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.5`. El tag
anotado apunta a `80cac14` (atestación). En la pestaña Sesión, cada sesión anterior del bloque «Sesiones
anteriores» muestra ahora sus objetos con las mismas teselas que la rejilla «Objetos» de la sesión actual.
Salen de la caché local del catálogo, sin peticiones de red nuevas.

- Publicación: el workflow `release.yml` (run 37604343164) terminó en success. La CI del push
  (run 37604327802) seguía en curso al medir, así que no se da por pasada. La release tiene ocho assets,
  todos `uploaded`: `hebra-main.mjs` 3290285, `hebra-styles.css` 118651, `hebra.json` 954, `main.js`
  1871050, `manifest.json` 236, `styles.css` 95185, `tyrian-companion-0.6.5.zip` 1966781 y
  `tyrian-companion-0.6.5.zip.sha256` 93 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.5; assets=8)». El `hebra-main.mjs`
  descargado contiene la clase `tyrian-live-session__tile-more` y el texto «more objects»; `hebra.json`
  dice `0.6.5`.
- Gate previo a publicar, sobre el árbol `e60599d46b0f1b8ad6ce8be110f4909271c645b0` (HEAD `9c04581`,
  Node 22.23.1), verde a la primera: `check` 8/8 (4978 tests, 315 archivos), guardrails 25/25 (320 tests,
  29 archivos), benchmark H6 y su sabotaje en rojo PASS, `release:preflight` PASS y
  `changelog-entry.mjs 0.6.5` con exit 0.
- Cambios: `src/ui/live-session-panel.ts`, `src/sessions/live-session-history.ts`,
  `src/ui/live-session-copy.ts` y `styles.css`. Metadatos alineados a 0.6.5.
- Verificado: el gate local, la publicación y los ocho assets descritos arriba.
- Verificado por David hoy en su instalación de Hebra (Fedora): la 0.6.4 está instalada y cargada
  (existe `plugins/tyrian-companion/0.6.4` y confirmó «si que veo la gráfica»). El bloque «Sesiones
  anteriores» muestra datos reales (su captura: «6 oct 17:05–17:25 · 20:22 · 0g 4s 13c · 11 objetos») y la
  sesión mostrada arriba no se repite en la lista. Con la 0.6.2 la sesión arrancó sola con el juego abierto
  (su captura: «En curso · 00:13»).
- No verificado: la instalación y carga de la 0.6.5 en Hebra y en Obsidian/BRAT, las teselas dentro de
  Hebra real con iconos reales (se midieron en Firefox sin cabeza a 280 px con iconos de prueba) y los
  avisos de drop en una sesión real con el umbral vacío.

## Canal 0.6.4 publicado: histórico de precio de venta en los detalles del asesor de inventario (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.4](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.4)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.4`. El tag
anotado apunta a `322440a` (atestación). Añade, dentro de «Detalles» de cada fila del asesor de inventario,
el bloque «Histórico de precio de venta» con la gráfica de la oferta de venta más baja de cada día (3 meses,
1 año y Todo). Sigue siendo opt-in: con el histórico apagado no hay ninguna petición.

- Publicación: el workflow `release.yml` (run 37597747813) terminó en success y la CI del push
  (run 37597730183) también. La release tiene ocho assets, todos `uploaded`: `hebra-main.mjs` 3287416,
  `hebra-styles.css` 118364, `hebra.json` 954, `main.js` 1869503, `manifest.json` 236, `styles.css` 94898,
  `tyrian-companion-0.6.4.zip` 1964947 y `tyrian-companion-0.6.4.zip.sha256` 93 (bytes).
  `release:brat-verify` contra la salida real de `gh release view`: «BRAT release contract: PASS
  (version=0.6.4; assets=8)». El `hebra-main.mjs` descargado contiene `ensurePriceHistorySeed` y el texto
  «Lowest sell offer of each day»; `hebra-styles.css` contiene las clases `tyrian-inventory__price-history`;
  `hebra.json` dice `0.6.4`.
- Gate previo a publicar, sobre el árbol `b8c884c6bec0f4b8f9812d319e988af9dc999b69` (HEAD `8afdd49`,
  Node 22.23.1): `check` 8/8 (4966 tests, 314 archivos), guardrails 25/25 (320 tests, 29 archivos),
  benchmark H6 y su sabotaje en rojo PASS, `release:preflight` PASS y `changelog-entry.mjs 0.6.4` con
  exit 0. Una primera pasada sobre el árbol `a0e98953` salió en rojo por 2 tests de
  `src/advisor/inventory-advisor-presentation-architecture.test.ts` (el censo revisado de la pantalla del
  asesor no tenía el fichero nuevo, su import ni la acción nueva) y se corrigió en `8afdd49`.
- Cambios: `src/ui/inventory-advisor-price-history-block.ts` (nuevo), `src/ui/inventory-advisor-view.ts`,
  `src/ui/inventory-advisor-item-view.ts`, `styles.css` y `src/core/i18n-runtime-catalog.ts`. La gráfica
  compartida (`src/ui/price-history-chart-model.ts` y `src/ui/price-history-chart-view.ts`) deja de repetir
  etiquetas en el eje de fechas. El test `src/advisor/inventory-advisor-presentation-architecture.test.ts`
  registra el bloque nuevo en el censo. Metadatos alineados a 0.6.4.
- Verificado: el gate local, la publicación y los ocho assets descritos arriba.
- No verificado: la instalación y carga de la 0.6.4 en Hebra y en BRAT/Obsidian, la gráfica dentro de Hebra
  real con datos reales de datawars2 (se midió en Firefox sin cabeza a 900, 390 y 280 px con una serie de
  prueba y colores sustitutos) y qué responde datawars2 para un objeto ligado a cuenta. De la 0.6.3 siguen
  sin verificar una sesión real de juego y el bloque «Sesiones anteriores» con la paleta real de Hebra.

## Canal 0.6.3 publicado: sesiones anteriores en la pestaña Sesión y avisos de drop sin cotización (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.3](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.3)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.3`. El tag
anotado apunta a `fe4ee83` (atestación). Añade el bloque plegado «Sesiones anteriores» al final de la
pestaña Sesión, hace que un umbral de drop vacío valga 0 y evita que un objeto sin cotización en el bazar
deje sin decidir los avisos de su lectura.

- Publicación: el workflow `release.yml` (run 37593735963) terminó en success. La release tiene ocho assets,
  todos `uploaded`: `hebra-main.mjs` 3274225, `hebra-styles.css` 115937, `hebra.json` 954, `main.js` 1861900,
  `manifest.json` 236, `styles.css` 92471, `tyrian-companion-0.6.3.zip` 1954917 y
  `tyrian-companion-0.6.3.zip.sha256` 93 (bytes). `release:brat-verify` contra la salida real de
  `gh release view`: «BRAT release contract: PASS (version=0.6.3; assets=8)». El `hebra-main.mjs`
  descargado contiene los textos «Sesiones anteriores» y «Empty or 0» y la función
  `isPublicCatalogNotFound`; `hebra.json` dice `0.6.3`.
- Gate previo a publicar, sobre el árbol `8d2fea7beb0d0e6b1fb2086b73a421d9a9559c50` (Node 22.23.1): `check`
  8/8 (4925 tests, 312 archivos), guardrails 25/25 (320 tests, 29 archivos), benchmark H6 y su sabotaje en
  rojo PASS, `release:preflight` PASS y `changelog-entry.mjs 0.6.3` con exit 0. Una primera pasada sobre el
  árbol anterior salió en rojo por `src/security-boundary.test.ts` y se corrigió en `7383585`.
- Cambios: `src/ui/live-session-panel.ts` y `src/sessions/live-session-history.ts` (lista de sesiones
  anteriores, de 10 en 10 y solo lectura), `src/ui/settings-tab.ts` (umbral vacío leído como 0),
  `src/sessions/live-session-economy.ts` y `src/catalog/public-catalog-client.ts` (objeto sin cotización
  como «sin precio»). Metadatos alineados a 0.6.3.
- Verificado: el gate local, la publicación y los ocho assets descritos arriba.
- No verificado: la instalación y carga de la 0.6.3 en Hebra y en BRAT/Obsidian, una sesión real de juego
  con la 0.6.3, el aspecto del bloque «Sesiones anteriores» dentro de Hebra con su paleta real (se midió a
  280 px con colores sustitutos) y si el jugador que reportó el aviso escribió 0 o vació el campo (escribir 0
  pasa en test). La CI del push (run 37593712382) seguía en curso al medir: no consta que pasara.

## Canal 0.6.2 publicado: la sesión en vivo real guarda su nota (7 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.2](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.2)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.2`. El tag
anotado apunta a `0e922079a0e73f8ce1904af7f4a9f5ad5d0cb1cd` (atestación), árbol verificado
`c3ce64fe4faa9e473c5fddc0d2ebcf1db5758888`, candidato fuente `51df40c`. Corrige que, desde
la 0.6.1 instalada en Hebra, con el juego abierto y el addon de Nexus conectado, «Iniciar sesión» siguiera
deshabilitado y el addon mostrara `Inventory: another source owns the session`: la nota de la sesión real se
rechazaba como `invalid_live_evidence` por 1 ms de diferencia entre el reloj del addon y los sellos del plugin.

- Publicación: el [workflow de release](https://github.com/fodaveg/tyrian-companion/actions/runs/37582252535)
  y la [CI de main](https://github.com/fodaveg/tyrian-companion/actions/runs/37582236342) terminaron en
  SUCCESS sobre `0e92207`. `release:brat-verify` contra la salida real de `gh release view 0.6.2`: PASS
  (`version=0.6.2; assets=8`), exactamente ocho assets subidos y no vacíos. En los assets de Hebra
  descargados, `hebra.json` dice `0.6.2` y el SHA-256 de `hebra-main.mjs` y `hebra-styles.css` coincide con
  el declarado. El `hebra-main.mjs` publicado contiene el arreglo (`observedWithin`, `publishedEnd` y el
  evento `live_note_write`); el de la 0.6.1 instalada no contiene ninguno.
- Gate local de ese árbol (Fedora, Node 22.23.1): `check` 8/8 (4909 tests, 311 archivos), guardrails 25/25
  (319 tests, 29 archivos), benchmark H6 y su sabotaje determinista, `release:preflight` y
  `changelog-entry.mjs 0.6.2`, todo con exit 0.

- Cambios: `src/sessions/live-session-note-model.ts` (tiempo observado y fin publicados acotados a la ventana),
  `src/runtime/tyrian-companion-core.ts` (repintado al cambiar la presencia y diagnóstico del escritor) y
  `src/host/hebra/hebra-host.ts` (manifiesto de assets ilegible reportado). Metadatos alineados a 0.6.2.
- Verificado: el gate local, la publicación y los ocho assets descritos arriba; los cinco commits de arreglo
  traen sus tests, que pasan dentro de ese `check`.
- No verificado: la instalación y carga en Hebra y en BRAT/Obsidian, que el registro atascado de la
  instalación que lo reportó fuera exactamente este caso (su estado guardado no se pudo leer) y una sesión
  real de juego con Nexus.

## Canal 0.6.1 publicado: nombres e iconos de sesiones restauradas (6 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.1](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.1)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.1`. El tag
apunta a `7353b6ce4a3811b36bbfce1410d607b312a31b82`, árbol `e24684ef72141cd7282afb3d8c0b2d083934562e`.
Corrige que, tras recargar el plugin, los objetos de una sesión restaurada salieran como «Objeto <id>»
con marcador «?».

- Publicación: el [workflow de release](https://github.com/fodaveg/tyrian-companion/actions/runs/37510024143)
  y la [CI de main](https://github.com/fodaveg/tyrian-companion/actions/runs/37510020140) terminaron en
  SUCCESS sobre `7353b6c`. `release:brat-verify` contra la salida real de `gh release view 0.6.1`: PASS,
  exactamente ocho assets subidos y no vacíos. En los assets de Hebra descargados, `hebra.json` dice `0.6.1`
  y el SHA-256 de `hebra-main.mjs` y `hebra-styles.css` coincide con el declarado.
- Gate local de ese árbol: `check` 8/8 (4900 tests pasados, 1 omitido, 310 archivos), guardrails 25/25,
  benchmark H6 y su sabotaje rojo, `release:preflight` y `changelog-entry.mjs 0.6.1`, todo con exit 0.
- Verificado: `src/runtime/live-session-entities-restored.test.ts` (5 tests, núcleo real más vista real) con un
  espía de transporte que registra cualquier petición HTTP: caché con los tres objetos (sesión terminada y en
  curso), caché vacía, caché parcial y modo consulta dan cero peticiones al cargar, restaurar y pintar. Un test
  del servicio cubre `readCachedItems`. Vitest acotado de los ficheros afectados 109/109, `tsc` limpio,
  eslint sin avisos en lo tocado, censo de observabilidad PASS, `i18n:unused` y contrato de texto fuente PASS.
- No verificado: la instalación y carga en Hebra y en BRAT/Obsidian, que la caché de catálogo persista
  dentro de Hebra (solo se ha probado con dobles) y una sesión real con Nexus.

## Canal 0.6.0 publicado: pestaña Sesión y ajustes simplificados (6 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.6.0](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.0)
es una release normal, sin draft ni prerelease; nombre, tag y `manifest.version` son `0.6.0`. El
tag apunta a `bffb6fa9ecac20451d1adaa4cd3f9d0b2b847473`, árbol
`bd7bc4a0b2cda6cd633ade916347c023a51e2f4c`. El
[workflow de release](https://github.com/fodaveg/tyrian-companion/actions/runs/37501092628)
terminó en SUCCESS sobre `bffb6fa`. Un primer tag `0.6.0` sobre `02f769b` falló en el paso Publish
(`changelog-entry: version-not-found`: el encabezado decía «Candidato 0.6.0») sin crear release ni
subir assets (run 37500003591); `bffb6fa` corrige el encabezado de `docs/CHANGELOG.md` y el tag se
recolocó ahí. La CI de main sobre `02f769b` (run 37500000850) terminó en SUCCESS; la de `bffb6fa`
([run 37501082514](https://github.com/fodaveg/tyrian-companion/actions/runs/37501082514)) también.

Gate local: árbol `7e6802e` (`02f769b`): `check` 8/8 con 4894 tests pasados y 1 omitido,
guardrails 25/25, benchmark H6 y su sabotaje rojo, `release:preflight`, todo exit 0. Árbol
`bd7bc4a` (`bffb6fa`): `check` 8/8 con 4895 tests, 309 archivos; guardrails y benchmark no se
repitieron sobre ese árbol (solo cambió `docs/CHANGELOG.md`). `release:brat-verify` pasó contra la
salida real de `gh release view 0.6.0`: exactamente ocho assets subidos y no vacíos. En los assets
de Hebra descargados, `hebra.json` dice versión `0.6.0` y el SHA-256 de `hebra-main.mjs` y de
`hebra-styles.css` coincide con el que declara. No hay releases nuevas de Nexus ni de Blish HUD en
este lote.

Cambios: pestaña Sesión simplificada y ajustes en una página (ver [CHANGELOG](CHANGELOG.md)).
Verificado además en el árbol de trabajo, con tests acotados y `--maxWorkers=1`:

- `tsc --noEmit --skipLibCheck`: 0 errores.
- vitest de `src/ui`, `src/runtime`, `src/host/hebra`, `src/core`, `main.test.ts` y el marker de
  sesión: 1584 pasados, 1 omitido; guardrails (ajustes, arquitectura, núcleo, main): 73 pasados. Test de `markStoppedByPlayer` en el marker de sesión.
- `i18n:unused`, contrato de texto fuente, censo de observabilidad de acciones (reindexado por `id`),
  `probar-build-host-esm.mjs` y `release:identity-contract`: PASS.
- Capturas del CÓDIGO real (`CompanionView` en su rama live, tokens y CSS de Hebra, claro/oscuro, 320,
  390 y 900 px) contra la maqueta `design/tyrian-panel-2026-10-06` del repo de Hebra: coinciden en
  bloques, cabecera de una línea, rejilla, gráfica con huecos, cronología y «Ver 50 más»; 25 marcos
  sin desborde horizontal. Diferencias: sin fila «Por hora» sin tasa, y los avisos sin icono.

No verificado: la instalación y carga en Hebra, BRAT/Obsidian, y una sesión real con el addon de
Nexus. La exportación de la sesión activa y
de la sesión antigua guardada pasa a dos comandos (probados con dobles de host, no en un cliente real).

## Canal 0.5.0 publicado: captura propia Nexus (6 oct 2026)

**Canal publicado; instalación/runtime pendiente.** [Tyrian Companion 0.5.0](https://github.com/fodaveg/tyrian-companion/releases/tag/0.5.0)
es una release normal, sin draft ni prerelease. El tag apunta a
`d5acce0a9d2c9d34f537b20df4380a1a2ee85b61`, árbol
`79381f36eb42e1eb644e409abe9f19765bf4952a`. La
[CI de main](https://github.com/fodaveg/tyrian-companion/actions/runs/37447940061) y el
[workflow de release](https://github.com/fodaveg/tyrian-companion/actions/runs/37449142919)
terminaron en SUCCESS para ese SHA.

El gate local de ese mismo árbol pasó `check` 8/8 (4863 tests, 307 archivos), guardrails 25/25,
benchmark H6 y su sabotaje rojo controlado, paquete, identidad y escaneo de secretos. Nombre de
release, tag y manifest son exactamente `0.5.0`. `release:brat-verify` pasó contra la salida real de
GitHub: exactamente ocho assets subidos y no vacíos. Se descargaron y comprobaron ZIP/checksum,
los tres archivos Obsidian extraídos y la integridad del manifiesto Hebra. El ESM Hebra servido
solo difiere del local en 69 comentarios de rutas de dependencias; tras normalizarlos es idéntico.
Su SHA-256 es `7fe9cd2650ff2a6eb88adf7a7ef71430c6ab8f9bab30c9e946057e4f6ef78298`; el manifiesto
servido contiene ese hash y el correcto de estilos, sin otros cambios respecto al local.

También están publicados [Nexus 0.5.0](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.5.0)
y [Blish HUD 0.5.0](https://github.com/fodaveg/tyrian-companion-blish/releases/tag/0.5.0), cada uno con
paquete y checksum descargados y verificados. Ninguna publicación demuestra instalación ni una
sesión real. Los recibos locales `/tmp/tyrian-050-integrated-release-receipt.json` y
`/tmp/tyrian-050-served-assets-receipt.json` registran el detalle y pueden no existir en otra máquina;
el commit acreditativo y los workflows enlazados conservan la referencia durable al candidato.
Esta actualización documental posterior al tag no hereda la ejecución de tests de ese árbol:
requiere su propia CI y no modifica ni retaggea el código publicado.

La raíz ha revisado/integrado localmente Nexus/Blish, notas/UI y el cierre de composición de
sesiones. Su evidencia previa incluye `d37606c3cd81099c7cc94cedae83e0f86827bb9a`, árbol
`54e04e45bde033bd4609d7ad238ed0eaaab075ac`, integrado como `8f2cce3` junto con `6e95cfc` y
`2368894`. Esos checks con dobles de host/IndexedDB y loopback IPC acreditan sus árboles y alcance,
no el árbol conjunto posterior ni ejecución real en juego.

El lote de plantilla declarada/comparación está integrado en `d2a6149`: parser `57416b8`, dominio
`cefb606`, captura al solicitar el inicio `8b2f3bc`, notas `76eb16b` y editor/comparador `d2a6149`.
Las revisiones independientes de parser, dominio/captura, notas y los once archivos de consumidores
han sido aprobadas sin hallazgos abiertos. Los commits originales `d8f252c`, `d124a586`, `d54222f`,
`b9c8477` y `8796a8b` referencian sus árboles, comandos y recibos: parser con seis fixtures de origen
identificado; conservación de raw inválido/v4; captura antes de suspensión con regresión roja/verde;
155 tests de notas/compatibilidad; y 23 tests de consumidores más 21 de fronteras y cinco previews
ES/EN aisladas. Cada resultado pertenece a su candidato; no se suma como un gate global. Las vistas
usan componentes reales con datos sintéticos y red abortada, no Hebra/Obsidian ni GW2 reales.

El gate conjunto del árbol publicado queda acreditado arriba, separado de estos checks por lote.
Las tareas y recibos permanecen en Lumbre y en las referencias de cada candidato.

El [contrato live1](SPEC-live-loot.md) se refleja en el código candidato: fuente Nexus sin clave
API, sesión por conexión y gracia de diez minutos, ledger durable, timeline/resumen/gráfica,
exportación activa separada de historial y notas schema 7. Las intenciones y recibos de avisos se
guardan, pero la entrega externa sigue siendo no transaccional y puede quedar no confirmada.
Los registros API anteriores conservan origen/identidad y pueden archivarse en solo lectura sin
inventar cierre ni recapturar la cuenta. La API autenticada se reserva a inventario/cartera manuales
y conexión explícita; catálogo/precios públicos siguen separados.

La preparación permite declarar una plantilla GW2 y etiqueta opcional. Se valida y congela al
solicitar una sesión nueva; editar después no altera su evidencia. Una entrada inválida se conserva
con error visible y captura desconocida, sin bloquear sesiones ni usar otra válida antigua. Notas
schema 7 y exportaciones conservan el campo opcional, sin reescribir ausencias históricas. El
comparador consume esas notas, separa API/live, exige dos completas por grupo y mantiene la activa
provisional. Las tasas usan cobertura de objetos y no dependen de tener precio; no acreditan oro/h
completo ni causalidad de la build. La declaración no demuestra configuración equipada o equipo/stats.

El addon de Nexus 0.6.0 lee la cartera del juego (pendiente de QA dentro del juego, ver la entrada 0.6.6);
con un addon anterior las monedas siguen sin cobertura. El lector no cubre MF verificado ni huecos de
bolsas. Esos datos permanecen desconocidos; una preparación MF manual declara su origen y no completa la
cobertura.
La investigación y el objetivo de esas señales no quedan cerrados por mostrar un placeholder.

La [matriz 0.5.0](QA-MVP.md) sigue pendiente: Fedora/GE-Proton con Nexus, Windows con productor
Nexus local y Blish HUD consumidor, carga/reapertura del Hebra canónico y BRAT/Obsidian. La
[sonda externa histórica](audit/live-loot-evidence-provenance.md) no acredita el runtime del addon.
La actualización del Hebra canónico usa el plugin externo de la misma release normal; las
prereleases quedan fuera de su instalador. Nexus no tuvo fuente de actualización hasta el addon 0.8.5
(publicado el 10 oct 2026), que declara GitHub como fuente: desde entonces Nexus lo actualiza (visto el 10 oct
2026 en Fedora con Proton, de la 0.8.5 a la 0.8.6, recargando el addon en la misma sesión de juego; sin ver en
Windows nativo). Quien tenga la 0.8.4 o anterior tiene que poner la 0.8.5 o posterior a mano una vez. Nexus guarda
30 minutos la lista de versiones de GitHub. Para la 0.5.0 de esta sección valía la sustitución manual de la DLL
y verificar la versión cargada, sin prometer autoactualización. En la comprobación
previa a este despliegue figuraban Tyrian 0.3.4 en Hebra y Nexus 0.3.1; esas versiones no prueban que
el candidato 0.5.0 esté instalado.

La release normal 0.5.0 cumple nombre/tag/manifest y los ocho assets de [BETA](BETA.md). Hasta
verificar carga real, el estado permanece «canal publicado; instalación/runtime pendiente». H8 e
historia API conservan sus límites y evidencia, sin ser la fuente de las nuevas sesiones.

## Historia conservada de candidatos anteriores

Los apartados siguientes mantienen fechas, evidencia y deuda de sus candidatos. Sus afirmaciones
de API-only, gates verdes o estado de publicación no certifican ni gobiernan el candidato live 0.5.0.

## Farmeo del laberinto de Halloween: candidato 0.4.0 (6 oct 2026)

El [audit funcional](audit/2026-10-06-laberinto-halloween.md) originó el proyecto de Lumbre
«Tyrian Companion · Farmeo del laberinto Halloween». El candidato de integración incorpora
correcciones de espacio y métricas, objetivos, preparación y el panel común de Nexus y Blish HUD.
Las tareas y su verificación se mantienen en Lumbre. El audit conserva la evidencia de los
checkouts anteriores; no certifica por sí mismo esta implementación.

El panel usa la extensión optativa `farm1` del protocolo v3; los addons anteriores siguen
recibiendo avisos y los nuevos pueden conectarse a un host anterior sin capacidad de panel.
Los datos proceden de instantáneas API, con edad explícita. Observado, neto al cierre y total
obtenido no son intercambiables; este último permanece sin observar.

QA pendiente: carga y recorrido de una sesión completa con Hebra/Nexus en Fedora y Blish HUD
en Windows, instalación y ejecución de BRAT/Obsidian, comprobación visual y compatibilidad real
de MagicFinder. Las pruebas de código, builds y publicación tienen evidencia separada y no
se presentan como esa aceptación de cliente. Blish HUD requiere el host ya disponible;
el lanzamiento automático desde Nexus conserva el selector Obsidian/Hebra existente.

## Tyrian dentro de Hebra (en curso desde el 28 sep 2026)

El estado, los checkpoints y cómo retomar viven en el repo de Hebra:
`~/code/hebra/docs/RELEVO-TYRIAN-EN-HEBRA.md` (sección «7. Lado Tyrian»). El contrato es
`docs/SPEC-TYRIAN-EN-HEBRA.md` del mismo repo. Aquí, el contrato de host está en
`src/host/tyrian-host.ts`.

## Corrección de Venta e Inventario del 26 sep 2026

El candidato 0.2.5 continúa el relevo de la 0.2.4: histórico desde Actualizar, ventanas coherentes,
netos con profundidad, Inventario completo y bolsas del personaje con actividad reciente.
El [informe del candidato](audit/2026-09-26-venta-inventario.md) distingue las verificaciones
del código y las capturas de la instalación y carga en Obsidian. Hebra sigue fuera de este lote.

## Vertical activa

**Estado a 24 sep 2026.** La 0.1.35 incorpora H17.1 (magic find derivado de la API de Guild Wars 2). La auditoría final consolidada del 24 de septiembre está **cerrada pero sin implementación**: decisiones de producto tomadas (sesiones, inventario, entrega en el juego) quedan en plan H18 en Lumbre en curso. Cambios de documentación, rearmado de detección y ajustes a lifecycle están **pendientes de implementar**. La 0.1.31 publicó los once lotes del audit del 8 sep; la 0.1.32 y la 0.1.33 llevan el H15
(causa del fallo de sesión en el log, audit de funcionamiento con 22 arreglos hijos, tests
ejecutables): la regla firmada de qué degrada una sesión, la tarjeta de sesión como componente único,
un solo aviso por umbral, la captura en una pasada, el barrido de Halloween acotado, las notas de
inventario con hash estable, el log sin ruido, el bucle `dev:install` + `smoke:live`, el gate partido,
el censo por hash AST, y la observabilidad de fallos por comando de sesión. Verificado: `check` 7/7 y
`check:guardrails` 24/24 en verde. Pendientes abiertos: H15.4 (18 ficheros congelados restantes),
la mitad de H15.24 (traducir `connection.message` en el callout) y H15.27 (`dev:install` no recarga los manifests), QA humana de `docs/QA-MVP.md` sin ejecutarse.

**La versión vigente es la que declara `manifest.json` (y `package.json`), que es también la última
release publicada en GitHub.** No se repite esa cifra aquí porque queda obsoleta con cada release y
nadie la actualiza en tres ficheros a la vez: se lee de `manifest.json` o de
`gh release view --json tagName`. El detalle y la motivación de cada entrega están en el
[changelog](CHANGELOG.md); el relato completo, release a release, de todo lo ya cerrado e integrado
antes de la más reciente se movió íntegro a
[`docs/historico/ESTADO-lotes-cerrados.md`](historico/ESTADO-lotes-cerrados.md).

**Foundation, conexión GW2, H1.4 coordinación, H3.1–H3.10 lifecycle/detección/revisión/calidad local, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta`, H2.7 contaminación, economía H4.1–H4.19, UI/assets H5.1–H5.12 y contratos H8.1/H8.4: implementados. H8.2 aporta el spike, con su QA humana ya ejecutada y completa en Linux/Steam/Proton, H8.3 la decisión, H8.5 el helper/servidor Rust aislado, H8.6 el cliente core TS, H8.7 una frontera safe-launch sin executor y H8.8 una política shadow pura de presencia/ausencia; launcher real, composición del plugin, firma, publicación y QA real siguen pendientes. H8.8 queda `@done` dentro de su alcance aislado; H8.7 permanece `@wip`.**

**H8 (Mumble v2) queda congelada por decisión de producto del 2026-08-18** hasta que cierre
H8.2, que tiene dos pasos: compilar el PE del spike y leer MumbleLink dentro de la botella
durante una sesión real. El paso 1 cerró el 2026-08-18: el PE compila con `zig` como driver de
C y su tabla de importación censada con `llvm-readobj` no trae ni `OpenProcess` ni
`ReadProcessMemory`. El paso 2, ejecutarlo dentro de la botella con GW2 corriendo, sigue
pendiente y es exclusivamente humano. Congelar no cuesta nada al MVP: cero consumidores de
`src/platform/` fuera de sí mismo, y `esbuild.config.mjs` mantiene `treeShaking: true` al
entrar por `src/main.ts`, así que nada de H8 viaja en el ZIP.

**Arranque del plugin diferido a `onLayoutReady`.** `onload()` esperaba el bundle de assets
gestionados, el hash del vaultId, varias aperturas de IndexedDB, `sessions.initialize()` y
`refreshLootPresentation()` antes de registrar las vistas; un leaf `tyrian-companion-*`
guardado podía restaurarse contra un view type todavía sin registrar y bloquear el arranque de
Obsidian. Ahora `onload()` registra las dos vistas, el setting tab, los cinco comandos, los
comandos de sesión y los listeners de DOM antes de cualquier otro `await`, y termina con
`workspace.onLayoutReady`; el resto se movió sin cambiar el orden a `initializeRuntime()`. Entre
ambas fases una guarda `runtimeReady` da valores neutros y el aviso `notices.pluginStarting`
(ES/EN); `onunload()` marca `unloaded` antes que nada. Test de la propiedad de orden,
verificado en rojo con sabotaje.

**Gate del repo aislado de los worktrees de agente.** Un worktree de agente bajo `.claude/`
es una segunda copia entera de `src/`: medido con uno presente, `vitest list --filesOnly`
devolvía 226 ficheros de test (113 bajo `.claude/`) y `scripts/h8-native-decision-contract.mjs`
ponía `npm run check` en rojo con 20 hallazgos `forbidden-product-artifact`, todos dentro de
`.claude/worktrees/`. Excluido en `vitest.config.mts`, `eslint.config.mts`,
`scripts/h8-native-decision-contract.mjs`, `scripts/security-scan.mjs` y `.gitignore`;
verificado que el contrato sigue mordiendo con una copia no revisada real. `tsconfig.json`
pasa `moduleResolution` de `node` (modo node10 retirado) a `bundler`, el modo que corresponde
al build vía esbuild.

**H7.4 está implementado técnicamente y H7.5 distribuye la release vigente mediante GitHub Release y BRAT.** El
release package parte de un build nuevo, contiene únicamente `manifest.json`, `main.js` y
`styles.css`, valida versiones y tag, escanea los bytes staged y genera ZIP reproducible + SHA-256
con prueba causal. CI conserva permisos de solo lectura, recrea un staging enumerado y sube
exactamente ZIP, checksum e instalador tras el gate.
El instalador verifica de nuevo paquete e identidad, serializa instalaciones, revalida directorios y
estado antes de operar, escribe solo los tres ficheros gestionados y revierte fallos bajo la misma
autoridad desde los bytes originales capturados; backups alterados y fallos de cierre del lock quedan
en rojo sin dejar aplicada la versión nueva. El staging relee y compara los tres bytes antes del upload
y el censo impide otra acción de artifact. Una sustitución de directorio se bloquea sin tocar el destino
ajeno. El tag y la GitHub Release de cada versión publican los tres assets individuales requeridos por BRAT;
la instalación/actualización real en Obsidian sigue pendiente de QA humana en las plataformas
soportadas.

**H7.2, H7.3 y H7.6 están implementados técnicamente, sin afirmar QA humana.** El README conduce desde
un artifact verificado hasta la primera sesión, explica que **Open companion** abre la vista y que
**Finish farming session** solo aparece tras un inicio realmente activo, separa modo manual/asistido y
expone límites de exactitud e Inventory Advisor. La guía de clave distingue conexión-only, mínimo real
`account + characters + inventories + builds` y permisos opcionales de cobertura. Soporte aporta un
issue form cerrado con versión, plataforma, origen, detección, fase y reproducción; prohíbe secretos,
identidad, rutas, inventario/snapshots, IndexedDB y salida sin redactar. El contrato ejecutable y sus
sabotajes impiden relajar esos campos o habilitar issues en blanco en silencio.

**H7.1 fija la identidad de la release publicada.** El ID `tyrian-companion`, el nombre
**Tyrian Companion**, el autor público **David**, el repositorio `fodaveg/tyrian-companion` y la
licencia MIT quedan ligados por un contrato ejecutable. La comprobación oficial fijada del
2026-08-16 no encontró colisiones de ID o nombre en registros activos ni retirados de Obsidian.
El repositorio es público desde el 2026-08-29. La release actual es la que declaran `manifest.json`
y `package.json`; su fecha de publicación no está registrada aquí.

H5.10 añade exportación manual y fail-closed del historial durable: solo consume notas H5.4/H5.7 íntegras, ordena resultados de forma determinista y crea JSON/CSV sin contenido humano ni identificadores crudos. Ajustes ofrece además un scrub warning explícito con preview y confirmación ES/EN: un token efímero ligado a bytes/path/ref, consumido o revocado en toda salida, usa `Vault.process` CAS para quitar solo `tc_*` y los seis bloques intactos, sin papelera ni borrado físico. Una autoridad compartida excluye transiciones de sesión, recovery y detector durante el scrub y relee el runtime antes de cada escritura.

**H0.4, H0.6, H8.1 y H8.4: política y contrato v2 documentados; H8.5/H8.6 implementan ambos extremos, H8.7 prepara el lanzamiento sin executor y H8.8 añade la política shadow aislada, pero integración, validación multiplataforma y piloto siguen pendientes.** El MVP es
API-only con Linux + Steam/Proton como plataforma primaria, macOS + CrossOver como secundaria y
Windows en beta. H8.1 fija Mumble Link para v2 como helper IPC opt-in de mapa/actividad: defaults
revisables deshabilitado/shadow/on-when-armed, API v1 autoritativa,
confirmación humana, raw no persistente, payload mínimo, `initialSequence:0` y transporte loopback
fail-closed. Las tasas de falso inicio/parada, recovery y precisión
temporal tienen definición, muestra mínima y umbrales verificables en
[Política de plataformas e integraciones](PLATFORM_POLICY.md).

El contrato H8.1 permanece declarativo bajo allowlist AST recursiva. El censo productivo permite
exactamente ese contrato, los módulos TS puros H8.6/H8.7/H8.8 y los seis módulos Rust H8.5; el scanner
y sabotajes mantienen en rojo cualquier módulo/helper adicional o capacidad de sesión, store, red,
filesystem, logging o timer global. La API oficial confirmó el mapa `866` como **Mad King's
Labyrinth / Laberinto del Rey Loco**. No existe executor host, composición, setting ni conexión
con H3.8/H5.3; el adapter H8.7 sigue siendo una frontera pura e inyectada.

H8.2 aporta bajo `spikes/h8-mumble-crossover/` un decoder C portable, un wrapper PE de lectura
`FILE_MAP_READ`, muestreo best-effort de pares completos idénticos con ocho intentos, fixtures
adversariales tick-igual/map-híbrido y tearing, guard de censo/capacidades, ASan/UBSan y sabotajes
causales de offset/5.460/512/ocho pares/entero seguro. El guard fija una sola apertura y un solo map
read-only, censa llamadas/sumideros del core, wrapper, stub y script, y mantiene `npm run check` sin
Wine/CrossOver ni copias fuera del temporal. El extractor léxico no acepta llamadas buenas fingidas
en comentarios/literales y detecta el permiso decimal `2u`; el host usa un contrato positivo byte a
byte de todos sus comandos y destinos temporales, no una blacklist. El preprocesador del wrapper
está igualmente cerrado a un define inocuo y cinco includes exactos:
no puede redefinir permisos, nombre del mapping, bytes del view ni introducir aliases contractuales.
Además, la lane usa el mismo `cc` y stub para generar el wrapper preprocesado y valida allí los
argumentos expandidos `0x0004u`, `MumbleLink` y `5460u`; hashes exactos cubren wrapper, core header,
stub y validador. Redefiniciones desde headers, `%:` o continuaciones de línea quedan rojas por el
resultado efectivo, no por una blacklist de grafías.
No se presenta como seqlock ni como snapshot coherente: dos
lecturas híbridas idénticas siguen siendo un riesgo residual y la señal permanece shadow. El primer host inspeccionado fue macOS 26.6.1 ARM,
con CrossOver 26.3.0 y botella win64 `Guild Wars 2`, sin MinGW/LLVM Windows cross-compiler: allí el
test portable quedó verde pero no se instaló nada, no se copió nada a la botella ni se ejecutó un PE.
Esa sigue siendo la situación de macOS/CrossOver.

**QA humana ejecutada el 2026-08-19 en Linux/Steam/Proton.** Host Fedora Linux 44, kernel
`7.1.8-200.fc44`, `mingw64-gcc` 16.1.1 y `protontricks` 1.14.0; PE x86-64 compilado fuera del prefijo
en `/tmp` y lanzado con `protontricks-launch --appid 1284210` y `STEAM_COMPAT_DATA_PATH` sobre el
prefijo `compatdata/1284210`, que corre **GE-Proton11-5**, no Proton estable de Valve. No se instaló
ni copió nada dentro del prefijo. Resultados:

- **Muestras repetidas:** dos tandas de diez ejecuciones con el juego abierto y el personaje quieto.
  Las veinte devolvieron una única línea JSON con `sequence:0` y `activity:"link_advancing"`, cada una
  con su nonce de 128 bits distinto y correctamente devuelto, y con `uiTick` estrictamente creciente
  (13.625→16.962 y 572→4.131, saltos de 353-405). No se observó ninguna pareja de lecturas idéntica.
- **Transición de mapa:** `mapId` pasó de `1442` a `1595` al cambiar de zona, contrastados contra
  `api.guildwars2.com/v2/maps` como Seitung Province y Shipwreck Strand.
- **Reinicio del juego:** tras cerrar y reabrir GW2 el `uiTick` se reinició de 16.962 a 572 en el
  mismo mapa, lo que ata la señal al proceso vivo y descarta que se estuviera leyendo un mapping
  rancio superviviente.
- **Contrato de payload:** ningún frame contuvo identidad, personaje, coordenadas, identificadores de
  proceso ni contexto crudo.
- **Control negativo:** con GW2 cerrado, diez ejecuciones consecutivas no emitieron frame. El wrapper
  no imprime nada cuando falla y solo señala por código de salida, así que se repitió una corrida sin
  tubería y sin silenciar stderr: devolvió `exit=2`, o sea `TC_MUMBLE_PROBE_VIEW_TOO_SMALL`, que es lo
  que retorna el wrapper cuando `OpenFileMappingW` da `NULL`. El stderr de esa corrida trae
  `ntsync: up and running` y los `loader_init` de wine-staging 11.0, de modo que el proceso Windows sí
  arrancó y la salida vacía no se explica por un lanzamiento fallido.
- **Propagación del código de salida:** para descartar que ese `2` lo produjera `protontricks-launch`
  y no la sonda, se lanzó el mismo PE sin argumentos, que por su propio `main` debe devolver
  `TC_MUMBLE_PROBE_INVALID_ARGUMENT`. Devolvió `exit=1`. El canal transmite el código del PE sin
  alterarlo, así que el `2` del control negativo significa lo que dice.

Por tanto la lectura estable durante una sesión real, las transiciones, el reinicio y la ausencia de
mapping con el juego cerrado dejan de ser QA pendiente **en Linux/Steam/Proton bajo GE-Proton**;
quedan abiertos Proton estable de Valve, macOS/CrossOver y Windows nativo. El riesgo residual de dos lecturas
híbridas idénticas no queda refutado por estas veinte muestras: no se observó, que no es lo mismo que
no poder ocurrir. La señal permanece shadow y la API sigue siendo autoritativa.

**H8.5: helper/servidor Rust implementado, sin integración del plugin ni publicación.** El crate
`native/mumble-helper` implementa framing/JSON estricto, auth constant-time + zeroize, nonce y
secuencia compartida, proyección de cadence y adapter Win32 read-only de cuatro campos/ocho pares.
Un watchdog stdin y event loop acotado prueban EOF, slowloris, cliente extra, reconnect con token del
mismo proceso y nonce/secuencia nuevos. Cargo host está verde; CI Windows debe confirmar PE x64,
CRT estático y reproducibilidad y solo puede conservar un marker `UNSIGNED-NOT-FOR-RELEASE` por un
día. Windows, Proton y CrossOver siguen `QA=pending`; Authenticode, package productivo, launcher,
settings y UI siguen pendientes. Por tanto H8.5 está implementado, pero no cerrado para release.

La cadencia servidor consume raw tick/map/status: primer slot a 500 ms, warm-up sin historia,
segundo válido abre época advancing, stalled exacto a 1.500 ms, lateness reprogramada desde now y
`heartbeat_timeout` exacto a 2.000 ms sin emitir ni recuperar slots perdidos.

**H8.6: núcleo aislado del cliente TypeScript implementado, sin launcher ni wiring.** Cuatro módulos
puros aportan codec incremental cerrado, lifecycle por puertos inyectados de proceso/TCP/reloj/CSPRNG,
salud en tres ejes y observación shadow memory-only de `mapId + activity` bajo `enabled && armed`.
Token por proceso, nonce por conexión, secuencia `0,+1`, deadlines y generaciones fallan cerrados;
callbacks externos quedan aislados ante throw/reentrada. Restart y reconnect comparten el backoff
`[250,500,1000,2000,5000]`, que solo se resetea tras `healthy`. No hay imports Node, I/O ambiente,
timers globales, sesiones, stores, captura, persistencia ni logging. Las 42 pruebas H8.6 cubren
fragmentación/coalescing/huge, replay/gap/wrap, primer sample, helper exit/backoff, callbacks stale,
salud unavailable vs stalled y sabotajes arquitectónicos. Launcher real, composición en `main`,
settings/UI, packaging y QA de plataforma siguen pendientes.

**H8.7: frontera safe-launch aislada implementada, todavía `@wip`.** Tres módulos puros fijan
config/route/diagnostic cerrados y planes exactos para Windows, CrossOver `wine` y Proton
`protontricks-launch`. AppID `1284210`, `MumbleLink` y launchers son constantes; no hay
args/env/shell/command/mapping libres. Package/bottle/compat-data son estrictos y efímeros; el plan
usa `shell:false` y tres pipes. El adapter abre el paquete H8.5 canónico de cinco ficheros antes de
cada intento, valida manifest + cuatro checksums y delega solo una capability opaca ligada a
bytes/digests, nunca un helper path re-resoluble. Drena stderr, aplaza un stdout inline de máximo 516
bytes y revalida antes de abrir la entrega; overflow, segundo evento, exit o un aplazamiento inline
cierran el handle una vez, publican diagnóstico saneado y notifican exit a H8.6. Stop es idempotente. El resultado se etiqueta
solo `integrity_checked` / `unsigned_qa_only`: no autentica
origen. No hay Node, spawn real, settings/UI/main/onload, persistencia, composición ni QA. Un executor
futuro debe exigir trust anchor de release o Authenticode y revalidar cada arranque/restart.
Las 25 pruebas H8.7 —16 funcionales y nueve arquitectónicas— cubren planes/plataformas/paths,
paquete compartido H8.5, artefactos corruptos, capability/TOCTOU, stderr/stop, callbacks acotados y sabotajes
de capacidades, incluido un único call-site de capability dentro del método hasheado y hash del adaptador completo; scanner v13 y
guard v17 mantienen el censo exacto.

**H8.8: política shadow de presencia/ausencia implementada y cerrada en su alcance aislado.** El
reducer puro solo acepta el mapa objetivo `866`: fija presencia tras 5.000 ms de crédito y ausencia
tras 60.000 ms de crédito. La primera solo acumula en idle y la segunda durante una sesión
ligada; cada record aporta como máximo 500 ms. Gaps, heartbeat/source degradation, `link_stalled`, caída de canal y
recovery reinician o degradan la ventana y nunca se interpretan como ausencia. Cada latch produce
como máximo un DTO efímero con evidencia `limited` y review `human_required`; muestras posteriores
del mismo estado no lo reemiten. La señal liga `accountId` dentro de su contexto efímero en idle y
sesión; un cambio de cuenta reinicia ventana y latch. El DTO no entra en la cola H5.3, no persiste,
no llega a UI y no invoca captura ni lifecycle. La API sigue siendo autoritativa. La composición,
las métricas comparativas y la QA humana en Windows, Linux/Steam/Proton y macOS/CrossOver pertenecen
a la salida posterior de shadow —H8.9–H8.15— y no reabren el criterio aislado de H8.8. La congelación
de H8 hasta completar H8.2 permanece intacta.

**H8.3: ADR de lenguaje/artefacto que autorizó la implementación.** Se elige Rust
provisionalmente, target único `x86_64-pc-windows-msvc` con CRT estático, fuente futura
`native/mumble-helper` y un único `tyrian-mumble-helper.exe`. El ZIP será separado del plugin y
llevará manifest, checksums y licencias. Linux/Steam/Proton primaria, macOS/CrossOver secundaria y
Windows x64 beta siguen `QA=pending`; ejecución nativa Linux/macOS, Windows x86/ARM64, móvil y Wine
fuera de Steam/Proton/CrossOver quedan unsupported. Authenticode sigue pendiente y bloquea release.
El guard v17 y sus sabotajes mantienen un censo positivo, incluido el orden causal que publica
shutdown antes de desconectar stdin para que EOF previo al bootstrap sea limpio también en Windows. Fuera de
docs/examples/fixtures/tests, fuente Rust/C#, configuración Cargo/toolchain exacta y señales de
prefijo Mumble Link por path o contenido quedan censadas globalmente; outputs
EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA tracked/no ignorados y symlinks relevantes siempre fallan. Un PDB
efímero de MSVC se permite únicamente bajo `target`; staging, paquete y artefacto CI lo rechazan.
Un `bridge` genérico continúa permitido. El bloque JSON, el ADR y `PLATFORM_POLICY.md` completo tienen
parsing/hash canónicos, de modo que `QA completada` tampoco puede añadirse al final del documento.
H8.5/H8.6 aportan servidor y cliente core y H8.7 el plan/adapter inyectado, pero no wiring del plugin ni artefacto publicable.

**H8.4: protocolo IPC local cerrado; H8.5/H8.6 lo implementan aún sin composición.** Helper servidor y
plugin cliente quedan fijados a TCP IPv4 `127.0.0.1`, bind port `0`, bootstrap/ready por
stdin/stdout y hello/welcome TCP. Todos los records usan `uint32` big-endian + JSON UTF-8 1..512 y
buffer incremental máximo 516 incluso con chunks enormes; los seis schemas, credenciales base64url,
binding bootstrap→hello y comparación constant-time, secuencia
conjunta heartbeat+sample, un único record por llamada debida de 500 ms —sample derivado de tick/map
raw sustituye heartbeat y satisface liveness—, calentamiento sin retener tick, segunda lectura como
nueva época advancing, borrado de tick/startedAt en source-status y primer record limitado a
heartbeat, stalled exacto 1.499/1.500 ms, lateness sin catch-up y fallo `heartbeat_timeout`, deadlines
2.000/5.000 ms, lifecycle,
backoff y errores están cerrados en el modelo y ADR parseable con igualdad/orden/hashes completos.
Los tests cubren framing fragmentado/coalescido/truncado, parser estricto, token/nonce y superficies,
host/puerto/versión, replay/gap/regresión/overflow/stale nonce, tick rollover, fake clock/sleep,
records fuera de fase, routing total de helper-exit —incluido reconnect—, token/puerto/nonce nuevos,
samples que renuevan salud, reset solo healthy, reconnect/EOF, high-water simultáneo sin copia,
cadencia con fake clock, recovery con tick stale, salto de 60 s y sabotajes de catch-up,
doble/ningún record, warm-up infinito, sample prematuro, heartbeat `healthy`, source status y datos
prohibidos. El censo conserva el contrato y los módulos H8.5/H8.6/H8.7/H8.8 exactos, sin importadores desde
`main`. No existen executor host, composición, settings/UI o packaging productivo; API
v1 sigue autoritativa, shadow, human-confirmed y sin persistencia.

H5.1 sustituye la portada de tarjetas por una bitácora compacta con fase y reloj de sesión, rail de detector/polling/calidad/cuenta, incidencia priorizada y detalles plegables; no añade red ni acciones automáticas.

H5.2 añade paleta y un único ribbon contextual para start, finish/retry, review, recover, discard confirmado y clear confirmado, siempre mediante los workflows existentes y con revalidación ante estado stale.

H5.3 añade una cola local durable para propuestas asistidas: enqueue previo al rearmado, intención exacta, claims renovables cercados por operación/ventana, receipts tras resolución, reconcile de identidad y una única propuesta visible con contador. El fondo solo actualiza indicadores existentes in-place: no reconstruye la vista, muestra notices/modales/notificaciones, enfoca, revela vistas ni ejecuta transiciones de sesión.

H5.4 genera mediante Vault una nota de sesión completa antes de permitir limpiar el runtime. Usa referencias SHA-256, ruta UTC, frontmatter `tc_*` estable y managed blocks hasheados; conserva tags/frontmatter/cuerpo humano y falla cerrado ante identidad, colisión o edición ambigua.

H5.5 deriva desde la evidencia H5.4 una única presentación de botín para nota y Companion: cambios netos, destino reservado/retenido/libre, subtotal económico y recomendación manual. Respeta permisos H2.7 y falla cerrado ante incoherencias H4 sin ocultar las filas físicas observadas.

H5.6 añade el motor genérico de assets administrados y una Base neutral. Preview no escribe; install/upgrade/repair usan manifiesto v1, CAS exacto y journal durable reanudable. Rutas inseguras, assets ajenos/modificados y formatos futuros fallan cerrados. Move instala destino antes de cambiar el puntero y Remove manda solo bytes propios exactos a la papelera de Obsidian, conservando manifiesto detached.

H5.7 sube las notas a schema v2 con evento, fuente manual/asistida correlacionada y recomendación histórica validados, y registra `Halloween.base` ES/EN en el bundle v2 sin un segundo writer. Sus cinco vistas filtran el evento explícito, separan cero de ausencia y reservan g/h a sesiones exactas, de confianza alta y cobertura completa. Falta QA manual en una bóveda desechable compatible con Bases; no se ha tocado la bóveda canónica.

H5.8 centraliza el contrato de rutas Vault para settings, notas y assets: solo NFC relativo con `/`, sin segmentos de navegación/configuración, controles/surrogates inválidos, nombres reservados de Windows ni longitudes que comprometan Sync. Settings v4 se reescribe de forma canónica al normalizar: elimina propiedades desconocidas y solo conserva las rutas pre-H5.8 autorizadas en `legacyOutputFolder`/`legacyManagedAssetsRoot`, read-only y sin alterar el puntero de assets. Move/Remove inspeccionan siempre la raíz heredada y rechazan un puntero divergente o manifiesto no exacto. Move exige estado ready incluso si el puntero ya la nombraba. Un Remove reintentado reconoce ese manifiesto exacto ya detached sin escribir ni volver a adoptarlo solo con puntero inicialmente vacío e idéntico tras la inspección, para terminar la limpieza de settings tras perder una respuesta. Una reubicación explícita instala primero el destino seguro y después elimina solo bytes propios de esa raíz. Manifiesto y journal ligan id/kind/locale/path y hashes previos permitidos; ready/detached exigen el conjunto exacto del bundle actual sin romper manifiestos compatibles previos. Las notas de sesión usan UTC y hashes; las de inventario usan item, fuente y hash. Ningún nombre incorpora cuenta, nombre de personaje, evento o ruta local.

H5.9 centraliza el texto visible ES/EN en un catálogo tipado con paridad de claves/placeholders: ajustes, Companion, incidencias, acciones, menús, modales, notas, botín y Bases cambian sin alterar IDs, enums, `tc_*`, hashes, rutas o consultas de Bases. La interfaz abierta se repinta y el bundle gestionado cambia con el idioma; los comandos ya registrados por Obsidian adoptan el nuevo nombre tras recargar el plugin.

H6.1 fija por regresión las seis direcciones entre personaje, banco y materiales —incluido split/merge— y comprueba holdings y composición exactos sin generar loot ni disponibilidad falsos. H6.2 recorre el workflow durable completo para apertura, reciclaje, compra en bazar y compra a mercader: persiste la revisión, reinicia una segunda instancia y conserva clasificación contaminada y permisos; la actividad del bazar sigue siendo una declaración explícita, no observación automática.

H6.3 fija que jackpots excluidos no alteran el EV ni la decisión y que un precio TP cero permanece `null/partial`. H6.4 recupera `stopping` y `provisional` sin recapturar evidencia, y prueba la cancelación real del modal sin backend ni mutación; no existe una acción inventada de cancelar sesión activa. H6.5 cubre 500/502/503/504 reintentables, 401/403/501 fatales y agotamiento 5xx con error saneado.

H6.6 añade un benchmark reproducible de cuenta grande, aislado de I/O: fuerza una primera pasada divergente y dos convergentes mediante la ruta pura productiva, finaliza snapshots estables, los compara, clasifica la frontera y valora 4.840 ganancias. Sus 21 muestras fijan mediana/p95 y la retención acumulada contra un baseline único post-warmup; CI prueba verde y sabotaje de heap explícito en Node 22 y 24, sin usar la duración de Vitest como evidencia.

H6.13 (`abea4e1`) corrige la sesión cuando un personaje devuelve `404` entre la pasada base y la de cierre. El diagnóstico inicial era al revés: la clasificación salía `invalid` y se perdía el delta entero de la cuenta, y `manual-session-start-service.ts` exigía una referencia de snapshot estable antes de calcular el delta, así que el 404 dejaba el `stop()` colgado en `stopping`. Ahora una pasada cuyo único hueco es `missing_character` no se descalifica, el personaje ilegible se excluye de las dos proyecciones con el delta en `limited` y el aviso nuevo `character_unobserved`, que degrada la clasificación a `estimated` en vez de `contaminated`. Un `500` (`unavailable`) sigue invalidando el delta entero por decisión de producto asumida, pendiente de ratificar por David si el 404 excusable entra en el gate de v1 (H7.8) o se aparta a post-MVP.

H6.16 sustituye cuatro suites de test de `src/advisor/` y `src/economy/` que leían el texto fuente con expresiones regulares por tests de comportamiento ejecutados, y añade `src/test/module-boundary.ts` y `src/test/ambient-capabilities.ts`. El sabotaje S14 (meter `this.ports.invalidate?.()` dentro de `current()` del controller del Inventory Advisor) probó que la regex conservada no se ponía roja y el test de comportamiento nuevo sí: los guardarraíles léxicos declaraban más cobertura de la que tenían.

H4.13 define la frontera pura del Inventory Advisor para `supported_storage_v1`. Liga snapshot, catálogo, precios, objetivos, excepciones de conservación, señales de cuenta y rule pack hasheado; valida particiones exactas de toda la propiedad por posición y devuelve un envelope manual separado del envelope de sesión. No existe acción `destroy`: `discard_candidate` requiere regla curada y permanece revisión irreversible. H4.14 captura la evidencia, H4.15 clasifica y H4.16 aplica la allowlist pura. H4.18 aporta un bundle built-in v2 inmutable y source-backed para 36038. H4.19 extrae el kernel económico H4.10 independiente de sesión, captura en Refresh el saco y sus ocho outcomes líquidos y liga modelo/regla/knowledge/TTL/cobertura/binding/reservas/excepciones. David aprobó regla y economía el 2026-08-16: evidencia completa y fresca puede recomendar manualmente `open|sell|vendor` para 36038 con margen fijo del 10%; evidencia parcial o incoherente sigue en revisión y descarte continúa deshabilitado. Los demás items pueden mostrar la mejor salida líquida manual respaldada sin habilitar uso/abrir/reciclar. H5.11 conecta una vista separada ES/EN: Open no captura; Refresh es el único trigger y compone las capas con single-flight/latest-wins. Desde H6.26 la vista usa como máximo dos observaciones acotadas de bolsas de personaje+compartido como núcleo; solo su equivalencia completa produce `stable`. Banco, materiales y delivery siguen como ámbitos opcionales desmarcados por defecto. Cada control muestra cobertura saneada y se deshabilita si su fuente no fue leída; un 403 opcional no bloquea el núcleo y un 401 conserva el fallo global de credencial. Añade icono oficial, progreso real y conserva el último resultado solo ante `capture_unavailable`. H5.12 añade el editor plegable local de objetivos y excepciones. H6.11 está cerrado por auditoría automatizada; sigue pendiente la QA visual/manual ES/EN de la ruta activada.

El inventario durable está integrado en el Inventory Advisor como flujo manual independiente:
Preview captura las cuatro fuentes físicas completas y prepara un plan Vault-only; Apply relee y usa
CAS. El writer genera una nota por objeto, ubicación y personaje, suma pilas del mismo personaje y
marca stale como inactivo/cero sin borrar archivos. No persiste cuenta, snapshot, token ni payload
raw. El bundle gestionado v5 conserva `Inventory.base` y `Materials.base` ES/EN con orden numérico por
valor y corrige sus nombres visibles mediante `properties.note.tc_*`. Falta QA visual/manual dentro de Obsidian y comparación contra los scripts legacy antes de que
David los retire.

H4.19 añade el kernel económico independiente de sesión, el adapter/pack de economía del Advisor, captura hermana de precios, integración contextual y guards causales. Gate completo verificado: lint, 94 ficheros/1315 tests, release-preflight, scanner de seguridad y build en verde.

El hotfix de datos reales del Inventory Advisor alinea el catálogo JSON, respuestas parciales 206,
la captura hermana H4.19 y la allowlist contextual. Una lectura real de solo lectura produjo snapshot
estable con las seis fuentes completas y una presentación `limited` de 1.206 objetos/1.701 posiciones,
todas en revisión manual; la clave y los endpoints requeridos respondieron correctamente.
Cada Refresh reemplaza un recibo diagnóstico local saneado con estado, duración y cobertura por
pasada/fuente; excluye secreto, identidad, personajes, objetos, URLs y cuerpos, y nunca se sube.
**Estado histórico anterior a H6.26.** La QA visual real aisló `snapshot_invalid`: el Advisor heredaba
el contrato account-wide y exigía banco y materiales estables aunque estuvieran desmarcados. En aquella
versión, el flujo capturaba únicamente personaje + inventario compartido, validaba ese scope de forma
independiente y conservaba fail-closed las fuentes básicas; banco/materiales/delivery no se consultaban
ni podían bloquearlo. Una única pasada completa se conservaba como `unstable/limited`, mostraba rutas
líquidas manuales y retenía usar/abrir/reciclar. Cada intento consultaba una vez roster, inventario
compartido y personajes serializados con timeout de 30 segundos; solo una pasada parcial transitoria
repetía el conjunto. Los personajes ya no van serializados: el asesor lee hasta cuatro inventarios a
la vez, el mismo límite que la captura de sesión (entrada «Release beta 0.2.14» de `docs/CHANGELOG.md`, con
su medición: un Mac, 10 personajes, dos corridas). El clasificador evalúa catálogo/precio por objeto: un batch TP parcial no oculta las filas
con precio presente ni las rutas de mercader con omisión demostrada; en esa QA, el pack todavía pendiente
retenía sus capacidades curadas. La vista prioriza ahora una cola directa «Qué hacer ahora» y relega
`keep|review|discard_review` a controles de contexto. Gate: 106 ficheros/1481 tests en
verde; queda pendiente repetir
la QA manual del plugin instalado y confirmar filas reales visibles.

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 define el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`. H3.2–H3.10 cubren captura manual, recovery durable, detección asistida explícita, revisión de contaminación y medición local de calidad. H4.1–H4.12 añaden valoración, reservas, intenciones y recomendaciones manuales puras; no operan sobre la cuenta. H5.12 persiste objetivos y excepciones locales con CAS explícito. No hay persistencia de recomendaciones, operación sobre la cuenta ni escritura libre en el vault: H5.4 solo genera notas completas con bloques gestionados, H5.6 solo modifica assets tras una operación explícita y H5.10 exporta o scrubbea únicamente mediante acciones explícitas. H9.7 agrega ese historial en Companion después de una carga manual, sin leer el vault al abrir la vista.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 115 ficheros y 1.579 tests verdes (la sesión empezó en 1.562: sube con H6.13 y
  con la poda de guardarraíles léxicos de H6.16), incluidas las 2 pruebas nuevas del orden de
  arranque diferido, las 13 del cooldown 429 compartido H6.12, 42 pruebas H8.6 —33 funcionales y nueve
  de arquitectura—, 25 H8.7 —16 funcionales y nueve de arquitectura— y 25 H8.8 —17 funcionales y
  ocho de arquitectura—, los contratos H8.1/H8.4 y el
  verifier de supply-chain/staging H8.5, más la lane C H8.2 normal/ASan/UBSan, syntax-check del
  wrapper y cinco sabotajes causales. Rust añade 14 unitarios y ocho lifecycle verdes.
- `npm run check` (gate completo): vitest, eslint, `scripts/h8-native-decision-contract.mjs` y
  `scripts/security-scan.mjs` excluyen los worktrees de agente bajo `.claude/`; exit code 0 en 42
  segundos sobre el árbol final (`69dc795`), 115 ficheros/1.579 tests más las ocho suites de scripts, el
  scanner de seguridad y el build. `src/eslint-default-project-config.test.ts` y
  `src/platform/mumble-v2-shadow-architecture.test.ts` dejan de caer al azar por presupuesto de
  tiempo: presupuesto explícito de 30 s y lectura del árbol de `src/` memoizada con copia por
  llamada. Ninguna aserción cambia y sus controles negativos siguen poniéndose en rojo.
- `npm run test:security-scan` y `npm run security:scan`: scanner v14 y sabotajes verdes.
- `npm run test:release-identity-contract`: identidad H7.1 y veinticuatro sabotajes causales verdes.
- `npm run test:beta-channel`: instalación, actualización, exclusión mutua, rollback y matrices
  causales de ZIP, rutas, symlinks, TOCTOU, CLI, staging y artifact CI verdes; no sustituye la QA
  dentro de Obsidian.
- `npm run build`: TypeScript y bundle de producción verdes; H8.7 no entra en `main` ni ejecuta proceso alguno.
- `npm run release:package`: paquete de tres archivos, checksum y segunda ejecución byte a byte reproducible en verde; debe regenerarse tras integrar cualquier otro lote.
- `npm run bench:h6-performance` y su sabotaje de heap: verdes en Node 24.19.0.
- H7.2/H7.3/H7.6 añade `test:support-contract`: formulario, docs y dieciocho sabotajes causales verdes;
  `npm run check`, benchmark, sabotaje de heap y `git diff --check` pasan en este worktree. No existe
  todavía evidencia de instalación, primera sesión o soporte real en dispositivo.

## Deuda conocida

### H13.1 — Primera ejecución humana, y el veredicto económico que salió suprimido

**La primera ejecución humana ocurrió el 2026-09-03**, en Linux y en la bóveda real (no en la
desechable que pedía el protocolo), y completó el ciclo entero: inicio, captura, fin, revisión y
nota escrita. Detalle completo, con SHAs y el estado exacto de cada campo, movido a
[`docs/historico/ESTADO-lotes-cerrados.md`](historico/ESTADO-lotes-cerrados.md) § H13.1.

**El defecto que compró aquella ejecución sigue sin cerrar aquí: el veredicto económico puede salir
suprimido en una sesión de farmeo normal** cuando dos monedas del monedero bajan una unidad cada
una (el coste de abrir un cofre con su llave), porque eso se leía como actividad contaminante. El
arreglo previsto es H13.6; hasta que aterrice y se confirme en el changelog, el producto puede no
dar su número en una sesión limpia.

### QA manual: una sola sesión ejecutada, en una sola plataforma

Salvo esa sesión, los once pendientes de abajo son la misma deuda repetida: **QA manual que no se ha
ejecutado en ninguna plataforma**, ni en el resto de Linux, ni en macOS/CrossOver, ni en Windows. Los
contratos ejecutables en verde, las guías escritas (`docs/QA-MVP.md`) y las releases publicadas no
acreditan ninguna de estas líneas;
por eso los lotes anteriores repiten que su publicación no acredita la QA. La única excepción de la
lista es el punto 5, cuya parte abierta es una decisión de producto de David y no una prueba; los
puntos 6 y 8 están cerrados en implementación y solo conservan QA residual.

1. Repetir el spike H8.2 en macOS/CrossOver, Windows nativo y Proton estable de Valve, donde todavía no se ha ejecutado ningún PE; después implementar executor con trust anchor y composición de H8.5/H8.6/H8.7/H8.8, ejecutar QA separada —incluidos los latches 5 s/60 s, gaps, stalled, heartbeat y recovery— en Linux/Steam/Proton, macOS/CrossOver y Windows x64 antes de salir de shadow, y resolver firma/licencias antes de release.
2. Ejecutar la matriz H0.4 por plataforma y reunir la muestra del piloto H0.6. H7.13 ya agrega y
   exporta localmente la evidencia desde hace varias releases; todavía faltan el dry run instrumentado en
   Linux/Steam/Proton, macOS/CrossOver y Windows beta y la ejecución real de H7.7.
3. Ejecutar QA visual de H9.7 en Obsidian con temas claro/oscuro, anchos 1280/900/600/420/280,
   textos largos y listas grandes; la implementación automatizada ya está publicada.
4. Ejecutar QA manual ES/EN de la recomendación activada para 36038 con evidencia real completa y parcial.
5. Cerrado por H6.13 (`abea4e1`): un personaje que devuelve `404` (`missing_character`) entre pasada base y de cierre se excluye de las dos proyecciones y el delta pasa a `limited` con el aviso `character_unobserved`, en vez de invalidar el delta entero de la cuenta. Un `500` (`unavailable`) sigue invalidando el delta entero. Decisión de producto pendiente de ratificar por David: si ese criterio del 404 excusable entra en el gate de v1 (H7.8) o se aparta a post-MVP; hoy queda etiquetado `#v1` sin que él lo haya decidido.
6. ~~Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.~~ Cerrado por H6.12 (`7f97d44` y `61a20dc`): `RateLimitCoordinator` comparte un único enfriamiento entre captura de sesión, detección asistida e Inventory Advisor, y lo arma también con el 429 de una fuente opcional que `captureSource()` convierte en cobertura parcial de una captura que resuelve. Los reintentos por petición siguen siendo del transporte. H6.21 añade el copy específico para cada fallo de inicio y fin; quedan pendientes su QA visual ES/EN y un `429` real en Obsidian.
7. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
8. ~~Consultar el historial TP para complementar la declaración manual H3.9.~~ Cerrado por H9.8
   (`3e84514`, `ed7f8b8` y `f825621`): el modal puede proponer compras y ventas desde un historial
   completo de hasta 90 días, pero solo la confirmación humana modifica la revisión.
9. Hacer QA manual de H3.2–H3.4 en dos ventanas y, si Obsidian comparte el origin, dos procesos reales: doble clic, stop/retry, reload, cierre forzado, recuperación/descarte y pérdida del lease.
10. Instalar/actualizar la release publicada desde BRAT en una bóveda desechable por plataforma, verificar que los
    tres assets corresponden a la release publicada y registrar el resultado; la publicación y el canal
    BRAT ya están activos, pero no acreditan esta QA.
11. Ejecutar el protocolo de QA manual que piden H6.8 y H6.9: instalación en una bóveda desechable, sesión real y matriz de plataforma documentadas en `docs/QA-MVP.md`; una guía preparada no acredita una prueba superada. El 2026-09-03 se ejecutó por primera vez una sesión real, pero en la bóveda real y en una sola plataforma: cubre la sesión y nada más, así que siguen sin ejecutarse la bóveda desechable, la matriz por plataforma, las dos ventanas simultáneas, el cierre forzado y el recovery.

### Deuda de implementación medida

No es sospecha ni estilo: cada línea trae cómo se vuelve a contar. Ninguna bloquea la release, pero
todas encarecen cada cambio posterior.

- `src/ui/wallet-vault-sync-controller.ts` y `src/ui/inventory-vault-sync-controller.ts` son dos
  copias: 131 líneas cada uno, y sustituir «Wallet» por «Inventory» en el primero deja un `diff` de
  cero líneas contra el segundo. Cualquier arreglo hay que hacerlo dos veces o se hace en uno solo.
- La función `canonical()` está reimplementada en cada dominio en vez de compartirse. El censo del
  2026-09-01 contó 24 ficheros; recontando hoy sobre `src/`, `function canonical(` aparece en 16
  ficheros y el patrón ampliado `function canonical|const canonical =` en 22. La cifra depende del
  criterio de recuento; lo que no depende del criterio es que no existe una implementación única.
- El idiom de apertura de IndexedDB está copiado en 10 almacenes:
  `sessions/session-runtime-store`, `sessions/session-detection-quality-store`,
  `sessions/pending-proposal-store`, `sessions/pilot-metrics-store`, `sessions/coordination-store`,
  `halloween/halloween-store`, `economy/price-history-store`, `catalog/persistent-catalog-cache`,
  `assets/managed-assets-pointer` y `advisor/inventory-preferences-store`. Se recuentan buscando
  `onupgradeneeded` fuera de los `.test.ts`.
- 34 ficheros de test aseveran texto fuente, no comportamiento: leen un fichero del repositorio y
  comprueban que contiene una cadena. Un renombrado los rompe sin que nada esté roto, y un cambio de
  comportamiento con el mismo texto los deja verdes. Se localizan por `readFileSync` dentro de
  `src/**/*.test.ts`, donde hoy aparece en 40 ficheros contando también los que leen `docs/` y
  `scripts/`.
