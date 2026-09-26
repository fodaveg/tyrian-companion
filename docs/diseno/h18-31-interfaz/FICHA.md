# H18.31 · Boceto de interfaz: ficha

Pieza de aprobación para David antes de implementar. No toca `src/` ni `styles.css`. Abre
`boceto.html` en un navegador; `boceto-publicable.html` es el mismo contenido sin `<!doctype>`,
`<html>`, `<head>` ni `<body>`, listo para publicar. En los dos, arriba se cambia el tema (sistema,
claro, oscuro) y el panel (los dos, lateral 320 px, central 860 px). Tema y ancho funcionan sin
script; con script, cada lámina se pinta a la vez a 320 y a 860 px con el mismo HTML.

- **Base medida:** `main@3c5502d` (0.2.3), igual que `origin/main` al empezar. La versión anterior
  de este boceto era del 24 sep sobre `a2584af` (0.1.35); desde entonces entraron 170 commits.
- **Modo componente.** Solo variables de Obsidian, piezas vivas de `styles.css` y piezas que David
  aprobó en `docs/diseno/halloween-venta` (26 sep). En el CSS del boceto, la capa 2 marca cada
  bloque como `[vivo styles.css:N]`, `[aprobado Venta]` o `[NUEVO]`. La capa 1 imita a Obsidian y la
  capa 0 es el marco: ninguna de las dos se implementa.
- **Venta no se rediseña.** Sus láminas del 24 sep (4.1 y 4.2) quedan obsoletas y la lámina 4 remite
  a la maqueta aprobada y a su implementación.

## Láminas y estado

Estados: **implementado** (está en 3c5502d), **decidido** (lo decidió David, falta código),
**propuesta** (pendiente de aprobar), **obsoleto** (se retira). Cada lámina lleva además su tabla de
piezas con la cita `fichero:línea`.

| Lámina | Estado | Qué enseña |
|---|---|---|
| 0 | medición | Qué hay ya en 3c5502d, lámina a lámina |
| 1 · Navegación | propuesta | Barra `<nav>` viva; línea de estado en las tres pestañas; Ajustes como icono |
| 2.1 · En curso | propuesta | Laberinto, «Ganado» (decidido), avisos con recorrido de 3 pasos, comparación de botín viva, línea del saco leída de Venta |
| 2.2 · Espera de cierre | propuesta | Cuenta atrás viva, «Capturar ya» vivo y secundario, porqué a la vista, recorrido |
| 2.3 · Fallo al cerrar | propuesta | Reintento vivo, nota sin guardar viva, sesión abandonada viva; callout sin código |
| 2.4 · Sin señal | propuesta | Regla de 10 min (viva en lógica) llevada a pantalla |
| 2.5 · Sin sesión e historial | propuesta | Historial fuera del cajón, una tabla, rendimiento por calidad (vivo), corregir hora (decidido) |
| 3.1 · Poco espacio | propuesta | Bloque de espacio de Venta, una lista con `subgrid`, marca de acción, «Conservar» reversible |
| 3.2 · Estados del análisis | propuesta | Espacio de sobra, análisis antiguo, analizando, fallo sin código; lo que se retira |
| 4 · Venta | implementado | Referencia a la maqueta aprobada y a `sale-view.ts` |
| 4.1 · 4.2 (24 sep) | obsoleto | Sustituidas por la maqueta aprobada |

## Delta sobre 3c5502d

| Lámina | Ya implementado | Obsoleto | Queda por aprobar e implementar |
|---|---|---|---|
| 1 | `<nav>` con Sesión · Inventario · Venta · Ajustes y `aria-current` (`ui/product-shell.ts:43-47,194-198`); línea de estado solo en Venta (`ui/sale-view.ts:61-93`) | `role="tablist"`: cada botón abre otra hoja (`main.ts:4691-4710`) | Línea de estado en Sesión e Inventario; Ajustes como icono |
| 2.1 | Cajones fijos Detalle · Avisos · Historial (`ui/session-card.ts:142-145`); «Valor observado», «Sacos», «Última consulta» (`ui/companion-view.ts:857-878`); marcado por el addon y etiqueta del Laberinto en lógica (`sessions/ingame-session-marker.ts:5-21`); motivos H18.32 de la comparación de botín (`ui/halloween-alert-panel.ts:177-198`) | Paso «Recibido en el juego»: el protocolo v2 no tiene acuse (`docs/SPEC-puente-ingame.md:224,262-270`) | «Ganado» y «Lectura de la cuenta» (decidido); insignia Laberinto y «la marcó Nexus»; Avisos primero; cajón Botín; recorrido de 3 pasos; línea del saco desde Venta |
| 2.2 | «Terminando sesión», «Captura final en» con cuenta atrás, «Capturar ya» desde el 1 sep (`ui/companion-view.ts:606-631,942-959`) | La nota «sin botón Cerrar ya»: el botón ya existía (fe5a8b1) | Porqué a la vista (hoy en Detalle, `:540`); cifra provisional; recorrido |
| 2.3 | Reintento solo y «Reintentar finalizar sesión»; «Abandonar sesión» con confirmación; «Reintentar guardado» (`ui/companion-view.ts:611-622,646-655,699-723`) | — | Meta con la hora del reintento (hoy «Reconciliando…», `:626`); callout sin código (hoy puede llevarlo, `:333-339`); «Copiar detalle técnico»; recorrido |
| 2.4 | Cierre tras 10 min sin señal, fin en la hora observada, sesión manual adoptada y nunca cerrada por el addon (`sessions/ingame-session-marker.ts:5-21`) | — | Todo el estado en pantalla: la tarjeta no lee la presencia |
| 2.5 | «Listo para empezar»; historial en su cajón con «Cargar historial»; subtotal conocido y «N sin valorar»; rendimiento por actividad · build · calidad (`ui/session-history-panel.ts:73-100,151-274,343-355`) | Fila «si falta una, Desconocido» del antes; el texto `sessionHistory.ready` (`core/i18n-runtime-catalog.ts:1060`) aún lo dice y contradice el subtotal | Historial fuera del cajón y leído al abrir; una tabla en vez de tabla y tarjetas (`:185-186`); corregir hora |
| 3.1 | Bloque de espacio compartido con Venta y umbral 20 (`ui/inventory-advisor-view.ts:984-1039`, `core/settings.ts:35-39`, `inventory/storage-space.ts:50-70`); orden por huecos y «Libera N huecos» (`:702-706,1672-1690`); «Conservar» por fila (`:1227-1243`); tres relojes y vender-o-esperar en texto (`:1529-1563`); alcance (`:1042-1057`) | Tres `meter` por almacén | Una lista con `subgrid` (hoy tabla y tarjetas, `:970-971`); marca de acción (hoy color como texto, `styles.css:2146-2170`); `hold` como «Esperar»; «Conservar» reversible; bloque de espacio en el orden y con la marca aprobados |
| 3.2 | «Se conserva el último resultado válido…» (`ui/inventory-advisor-view.ts:1427-1434`); progreso solo mientras corre | «Confirmar cambios antes de escribir» (`core/i18n-runtime-catalog.ts:452-454`) | Quitar los 13 «Código seguro: …» (`:387-399`); análisis antiguo con fecha y lista a la vista (hoy `stale_evidence` bloquea, `:404`) |
| 4 | Venta aprobada e implementada (`ui/sale-view.ts`, `sale-view-model.ts`, `sale-item-view.ts`); estado H18.34 «Las reglas de venta caducaron el {{date}}: actualiza el plugin.» (`ui/sale-view.ts:101-116`) | 4.1 y 4.2 enteras, incluido el gráfico de 7 temporadas | Nada |

## Checklist de 7 ejes

| Eje | Estado | Qué cubre / qué falta |
|---|---|---|
| Tokens | **Cubierto** | Cero colores fijos en la capa 2 (los únicos hex y `rgba` están en la capa 1). La marca de acción reutiliza `--tyrian-action-mark`, ya vivo; `list` y `keep` son dos valores nuevos de esa misma variable, marcados `[NUEVO]`. El contraste de `--text-muted` (6,69:1 claro, 7,95:1 oscuro) sale de los valores por defecto aproximados del 24 sep; no lo he vuelto a medir ni probado con los temas de David. |
| Componentes con todos los estados | **PARCIAL** (falta: sin señal con sesión iniciada a mano; cajones Botín y Detalle abiertos; error de «Corregir hora», por ejemplo fin antes de inicio; Inventario sin datos del banco, `advisor.view.storage.lowUnknown`; Inventario vacío y primer análisis) | Sesión en curso, espera, fallo de lectura, nota sin guardar, abandonada, sin señal, lista para empezar con historial; inventario con poco y mucho espacio, antiguo, analizando, fallo; sin cotización, precio sin leer, reserva entera e incierta, conservado. |
| Responsive por componente | **Cubierto** | Mismo DOM a 320 y 860 px con los cortes de contenedor vivos (759, 520, 400). Medido con Chromium headless: ninguna lámina desborda su panel de 320 px y la página no tiene scroll horizontal a 400 px, en los dos temas y en los dos ficheros. Lista de inventario con `subgrid`; historial que esconde columnas `.is-wide`. |
| Accesibilidad | **PARCIAL** (falta pasar un lector de pantalla real en Obsidian) | `<nav>` + `aria-current` (el `tablist` anterior prometía paneles que no existen); `role="status"` y `role="alert"`; `meter` nativo con `low`/`high`/`optimum` como el vivo; acción y calidad con forma y palabra, no solo color; títulos de callout en color de texto; cada «Conservar» con `aria-label` que nombra el objeto y `aria-pressed`. |
| Casos límite de contenido real | **Cubierto** | IDs reales (36038, 47909, 36059, 43320) y textos copiados del catálogo vivo. Fechas de caducidad reales: paquete curado hasta el 1 jun 2027 (`advisor/inventory-advisor-builtin-bundle.ts:85`) y tabla de legendarias hasta el 10 dic 2026 (`economy/legendary-materials.ts:406`). Cifras de ejemplo subrayadas. El nombre de build es un hueco declarado, no inventado. |
| Feedback del sistema | **Cubierto** | Una línea de estado por pestaña; recorrido de 3 pasos común a aviso, cierre y análisis; «Conservado · Guardado» en la fila; reintento con su hora. |
| Assets | **PARCIAL** (falta el icono real del catálogo) | El boceto no carga red: todos los objetos usan el sustituto vivo con iniciales y borde discontinuo (icono caído). Iconos de interfaz como trazos tipo Lucide (`setIcon`). |

## Decisiones mías del 24 sep, revisadas

| # | Decisión del 24 sep | Hoy |
|---|---|---|
| 1 | Pestaña «Venta», no «Oportunidades de venta»; Ajustes como icono | «Venta» **aplicada** (`core/i18n-runtime-catalog.ts:997`). Ajustes como icono **sigue viva**. |
| 2 | Línea `role="status"` bajo las pestañas | **Aplicada en Venta** (`ui/sale-view.ts:61-93`); **viva** para Sesión e Inventario. |
| 3 | Recorrido de 4 pasos común, sin botón «Cerrar ya» | El recorrido **sigue vivo pero con 3 pasos** (ver A). «Sin botón» **cae**: «Capturar ya» existe desde fe5a8b1 (1 sep). |
| 4 | El código de error solo va al portapapeles | **Viva**, sin implementar: siguen 13 textos con «Código seguro». |
| 5 | Avisos como primer cajón en el Laberinto | **Viva**, sin implementar. |
| 6 | Historial debajo de la tarjeta, leído al abrir | **Viva**, sin implementar (pregunta 1). |
| 7 | Acciones con marca lateral y texto en `--text-normal` | **Aplicada en Venta** (`styles.css:2566-2598`); **viva** para Inventario. |
| 8 | «Conservar» no mueve la fila hasta el siguiente análisis | **Aplicada en parte**: la fila se queda y dice «Guardado para conservar» (`ui/inventory-advisor-view.ts:1229-1234`), pero no se deshace desde la fila (pregunta 5). |
| 9 | «Poco espacio» = bolsas de todos los personajes + banco, umbral 20 | **Sustituida por David el 26 sep**: bolsas del personaje con actividad reciente + banco. Una selección ambigua deja el espacio desconocido; la actividad API se etiqueta como inferencia. Ver `docs/PRODUCT.md`. |
| 10 | Supuesto: las reglas se renuevan con una versión nueva del plugin | **Cae como supuesto**: ya es el mecanismo (H18.34, «actualiza el plugin»). |

## Decisiones mías nuevas (se pueden tumbar)

- **A.** Recorrido de 3 pasos (visto · enviado · en la nota; fin · lectura final · nota; leyendo ·
  analizado · notas). Sin «Recibido en el juego», porque nadie lo confirma.
- **B.** Se queda `<nav>` con `aria-current`; el `tablist` sale del boceto.
- **C.** En Inventario, el bloque de espacio es el aprobado en Venta, sin tocar.
- **D.** En Inventario, `hold` se dice «Esperar» y lo que no tiene puja «Sin cotización», con las
  palabras de Venta. «Conservar» queda solo para guardar el objeto.
- **E.** En Inventario, el saco (36038) dice «Abrir», que es su ruta en el asesor, y remite a Venta
  para decidir cuándo vender.
- **F.** «Capturar ya» se queda como botón secundario, con su aviso a la vista.
- **G.** La línea del saco en Sesión lee el veredicto de Venta, no la señal de cuenta.
- **H.** La forma de «Corregir hora»: inicio, fin y «Guardar» en un cajón de la última sesión.
- **I.** Nota sin guardar sin callout: la cabecera ya lo dice.
- **J.** Tras un fallo al cerrar, la meta dice cuándo se reintenta solo, en vez de «Reconciliando…».
- **K.** Fechas del asesor como las escribe hoy el código (`precio del 2026-09-26`); no propongo
  cambiarlas en este lote.

## Preguntas para aprobar

1. **¿El historial sale del cajón y se lee solo al abrir la pestaña?** Recomiendo que sí: una vez
   al abrir Obsidian y otra al guardar una sesión. Evita una pestaña sin sesión que enseña un cajón
   cerrado y pide un clic para lo único que ofrece. Coste: recorre las notas del vault.
2. **¿Se queda «Capturar ya» durante la espera?** Recomiendo que sí, secundario y con su aviso.
   Evita quitar un control que funciona y dejar sin salida a quien tiene que cerrar Obsidian ya.
3. **¿Basta «Enviado a Nexus» en cada aviso?** Recomiendo 3 pasos ahora y el acuse como tarea aparte.
   Evita pintar «recibido» sin que el addon lo confirme; el acuse exige cambiar el protocolo v2 en el
   plugin y en los dos addons.
4. **¿Inventario pasa a una lista de seis columnas?** Recomiendo que sí; «En propiedad»,
   «Ubicación» y «Evidencia» pasan a detalle. Evita pintar hasta 1.600 filas dos veces y dos DOM
   que divergen.
5. **¿«Conservar» queda solo para guardar, reversible en la fila, y `hold` se dice «Esperar»?**
   Recomiendo que sí. Evita que David vea «Conservar» en la Barra de caramelo, crea que ya la
   protegió y no sepa deshacerlo.
6. **¿La línea del saco en Sesión lee el veredicto de Venta?** Recomiendo que sí. Evita que Sesión
   diga «Espera» mientras Venta dice «Vender ahora» para el mismo saco.

## Lo que el boceto no decide

- Las cifras subrayadas son de ejemplo; las bandas por hora y los netos no están medidos.
- La hora del reintento automático tras un fallo de cierre no la he medido en el código.
- El texto de «sin señal» con una sesión iniciada a mano está descrito en una nota, no dibujado.
- El 47909 se enseña con el nombre de la API, «Barra de caramelo»; David lo llama «la mazorca».
