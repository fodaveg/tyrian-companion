# Venta e Inventario: continuación del 26 sep 2026

## Alcance y decisiones

Continuación del relevo de Claude del 26 sep, desde `aaa20fa` (0.2.4), en Fedora.
Venta e Inventario son el alcance de esta corrección; la adaptación a Hebra sigue esperando.
David delegó resolver la descarga del histórico («decide tu»): «Actualizar» en Venta puede
completar las semillas necesarias, con el consentimiento de datawars2 existente. Abrir la vista
no dispara esa nueva siembra.

Inventario debe incluir todas las ubicaciones disponibles y ordenar por neto como la Base.
Las bolsas pertenecen al personaje con actividad reciente identificable, no a toda la cuenta.
`last_modified` se presenta como inferencia de actividad API; una selección ambigua deja el
espacio desconocido. La valoración se separa de la acción de conservar, depositar o esperar.

## Fuentes y límites de las pruebas

- Datos privados: lectura local de 1.371 notas de `Inventory/Positions` de la bóveda de David.
  Sus precios y veredictos son históricos (13 sep); no acreditan el inventario actual de la API.
  Las notas no se modifican ni se incorporan al repositorio público.
- Histórico público: respuestas completas de datawars2 para 36038, 36041, 47909, 43320 y 48805,
  descargadas el 26 sep. Los fixtures conservan los bytes y hashes; se procesan con
  `parseDatawars2History`, como producción. Los fixtures anteriores calculaban siempre el punto
  medio de mínimo/máximo; producción usa la media cuando existe. Su tabla de resultados no se
  reutiliza como certificación.
- Caché vacía: la prueba causal usa una cuenta técnica mínima, el servicio de semillas y su
  almacenamiento reales, respuestas públicas grabadas y el camino del botón de Venta. Demuestra
  el cableado, no una captura autenticada de la cuenta de David.
- Pantallas: renderers reales, `styles.css` del candidato y `app.css`, fuentes y `enhance.js`
  extraídos del Obsidian instalado. Chromium mide DOM y captura a 1320, 620 y 390 px. Los iconos
  de controles tienen un sustituto visual; los iconos de objetos salen de las notas. No se
  inventan huecos ni se presentan las cotizaciones antiguas como recién consultadas.
- El montaje local y sus capturas viven en `/tmp/tyrian-visual-20260926/`; el script es
  `run.mjs`. Son evidencia temporal de esta máquina, no un recurso disponible en otros equipos.
  El informe de medidas registra candidato y hashes de CSS/DOM de Obsidian.

## Verificación del candidato

La revisión independiente cubrió los dos lotes completos y sus junturas, contratos, fixtures,
persistencia y censo, sin bloqueantes o problemas importantes. Sus últimos deltas revisados son
`f8f036c`: la altura mínima de 44 px quedó limitada a móvil, se retiró una traducción huérfana y
se añadió únicamente el formateador puro de cobre a la allowlist del renderer.

El primer `check` hizo los siete pasos: cinco pasaron. La suite encontró el import legítimo aún
ausente de esa allowlist y 26 fallos `listen EPERM` del sandbox; el detector i18n encontró la clave
huérfana. Tras corregirlos, las 24 pruebas de la frontera de presentación pasaron, incluidos los
casos negativos, y las dos suites de sockets pasaron fuera del sandbox (31 pruebas).
El contador de callbacks del censo se reconcilió a 175 tras combinar ambas adiciones revisadas;
no se regeneraron clasificaciones ni se cambió el scanner.

El contrato H8 detectó el cambio de política de siembra porque fija el hash del documento
completo. Se actualizó únicamente ese digest tras comprobar que el bloque de autoridad H8
permanece idéntico; el contrato positivo y sus sabotajes existentes pasaron. No se relajaron
reglas de distribución ni decisiones de runtime.

El recibo del commit que entrega este documento registra el árbol verificado y los resultados
terminales del gate integrado y del paquete. Registros locales temporales:
`/tmp/tyrian-candidate-20260926-check-final.log`,
`/tmp/tyrian-candidate-20260926-guardrails.log` y
`/tmp/tyrian-candidate-20260926-package.log`.
`check` y `check:guardrails` cubren todos los pasos vigentes sin repetir las suites compartidas
que `npm test` volvería a ejecutar. El preflight de limpieza se ejecuta después del commit.

La instalación y carga de este candidato en Obsidian real no se han comprobado. La publicación
del canal BRAT también es una frontera aparte: este documento no acredita ninguna de las dos.

### QA visual con Chromium y CSS real de Obsidian

Se montaron `renderInventoryAdvisorView`, `renderSaleView` y `renderProductShell` reales en Chromium headless, con `styles.css` del candidato y `app.css`, fuentes y `enhance.js` extraídos de la instalación local de Obsidian. Las extensiones `createEl`, `createDiv`, etc. son las de Obsidian sobre DOM real; no se utilizó el DOM falso de los tests unitarios. El adaptador de `setIcon` conserva tamaño SVG pero usa trazos simplificados; sus iconos no quedan certificados. Las acciones externas tienen callbacks sin efectos.

La primera pasada combinada corresponde a las fuentes de `b56ad16`, todavía idénticas en `c15837c` (33 módulos importados comprobados por SHA-256). El cambio entre esos commits solo afecta al censo de observabilidad. Los cambios documentales y de versión presentes durante la captura no cambian los renderers. La evidencia local conserva hashes de cada fuente, bundle, CSS de producto, CSS Obsidian y extensiones DOM.

- Oscuro: 1320, 620 y 390 px; claro: 1320 px; ambas vistas.
- Venta con importes reales guardados y caso independiente sin neto disponible a 1320 px.
- Inventario con 1371 notas activas de Positions; se inspeccionaron cabecera, filas con nombre e importe, y el grupo sin valor abierto mediante su disclosure real.
- Primera pasada: nueve escenarios sin errores JS, desbordamiento horizontal del documento/elementos, solapes entre celdas adyacentes o elementos `hidden` visibles.
- Las capturas de Inventario son de viewport, no una imagen de miles de filas. Las de Venta cubren parte superior e inferior del panel desplazable.

La fuente de cantidades, nombres, iconos e importes es el frontmatter de Positions leído sin escribir. Los personajes están anonimizados en el modelo local. Los datos guardados son históricos, no una lectura actual de la cuenta. Los cinco productos de Venta conservan las cantidades y pujas verificadas contra esas notas; sus netos de presentación suman exclusivamente `tc_total_sell_copper` cuando existe para todas las posiciones del objeto. No se deduce profundidad nueva a partir de la puja.

Las decisiones de Venta proceden del motor probado con el histórico público real, en el escenario controlado fechado el 26 de septiembre; esta captura no certifica la cotización vigente ni la cadena completa de captura/análisis. Las notas no contienen huecos físicos, estado actual de cobertura ni instante exacto de cotización: se renderizaron huecos/espacio desconocidos, cobertura desconocida y fecha de cotización ausente. El escenario sin profundidad pinta neto no disponible. En Inventario se preservan las recomendaciones históricas guardadas: no se afirma que estén vigentes.

Checklist de diseño: tokens y temas **cubiertos** en esta matriz; componentes/estados **parcial** (no todos los estados de carga/error); responsive **cubierto** para estos anchos; accesibilidad **parcial** (sin lector de pantalla ni contraste exhaustivo); contenido real y límites **cubiertos para este replay**, runtime actual pendiente; feedback **parcial** (sin ejecutar captura/escritura); assets **parcial** (iconos de objeto reales, `setIcon` simplificado y carga diferida fuera del viewport).

Reproducción local: `node /tmp/tyrian-visual-20260926/run.mjs <checkout> <etiqueta> /tmp/tyrian-sale-model-20260926.json`. La carpeta `final/` contiene capturas, `measurements.json`, modelos y bundle congelados. El runner del delta del disclosure es `/tmp/tyrian-visual-20260926/expanded.mjs`. Son artefactos temporales de esta máquina y otra máquina puede no conservarlos; no se han añadido al repositorio los datos personales ni los ficheros de Obsidian. Esta evidencia no equivale a instalación ni carga en BRAT/Obsidian real.

El delta de CSS `c71c1eb` se verificó por separado, reutilizando el mismo bundle y comprobando que los 33 módulos conservaban su hash. Se abrió el grupo sin valor y se midieron las 1371 filas de Inventario en oscuro 1320/620/390 y claro 1320: cero desbordamientos, solapes de celdas adyacentes, errores JS y elementos `hidden` visibles. El disclosure desktop mide 35,5 px; `min-height: 0px` confirma que no hereda el mínimo móvil de 44 px. Evidencia: `final/expanded-measurements.json` y `inventory-*-unknown-final.png`. SHA-256 del CSS final: `6b35020e0c196b6abe7e4dc5f9586c505e1a87304932123ac6dea3281a5631c2`. El delta aislado del disclosure no afecta Venta ni las capturas superiores de Inventario ya verificadas.

Espacio: la carpeta QA temporal ocupa 25 MiB. `df` muestra 101 GiB libres en el volumen del repo al terminar, frente a 101 GiB en la primera lectura propia (102 GiB en el arranque global comunicado por la sesión raíz). No se retiraron artefactos porque la sesión raíz sigue revisándolos. El worktree visual no tiene cambios de fuentes/tests ni commits pendientes; sólo reutiliza `node_modules` mediante enlace.

Equivalencia final `f8f036c5239a7e09fcc3d98d926e7cdedb7dc607`: tras eliminar exclusivamente la clave de traducción huérfana `sale.view.hero.unknown`, se compiló de nuevo el bundle renderer y se comparó su DOM completo con el bundle congelado usando los mismos modelos a 1320 px. Inventario (38 305 nodos), Venta con importes (160 nodos) y Venta sin neto (151 nodos) produjeron DOM **idéntico byte a byte**, sin errores JS y con ancho de documento/panel de 1320 px en ambas versiones. El CSS final conserva el SHA anterior; entre los 33 módulos sólo cambia `src/core/i18n-runtime-catalog.ts`. Se reutiliza la matriz anterior por esta equivalencia focal, sin repetirla. Evidencia y hashes actualizados: `final/final-equivalence.json`; bundle renderer final SHA-256 `df6ce99ddb42315224b63cbde04155a01d0b3048998c5811a0065512ee084055`. Las imágenes externas se bloquearon por igual en ambas versiones durante esta comparación de DOM; no se presenta como nueva prueba de assets.
