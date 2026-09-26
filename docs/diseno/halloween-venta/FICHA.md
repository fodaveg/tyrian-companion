# Venta de Halloween · ficha

David aprobó el diseño el 26 sep 2026 («adelante con el diseño»). `maqueta.html` es la maqueta
aprobada (abrir en un navegador; sus comentarios CSS marcan cada pieza como `[vivo]`, `[H18.31]` o
`[NUEVO]`). Esta ficha sigue el formato de `docs/diseno/h18-31-interfaz/FICHA.md`.

## Alcance

Pestaña **Venta** nueva en `src/ui/product-shell.ts` (Compañero / Inventario / Ajustes → + Venta),
con vista, comando de paleta y navegación propios. Reutiliza datos ya calculados por el asesor de
inventario (`src/ui/inventory-advisor-*`), la recomendación por posición
(`src/advisor/inventory-position-recommendation.ts`), el calendario de festival
(`src/advisor/inventory-advisor-builtin-bundle.ts` + `src/economy/models/halloween-festival-anchors.ts`),
el espacio de almacenamiento (`src/inventory/storage-space.ts`) y la señal de venta del saco
(`src/economy/sell-signal-runtime.ts`, ya usada por `src/ui/sell-signal-line.ts`).

Piezas: línea de estado, bloque de espacio (`renderStorageSpace`, ahora exportado y con `low`/
`optimum` en el `meter`), tarjeta destacada del Saco de Halloween (36038, veredicto de
`recommendPosition` con comparación abrir-vs-vender cuando existe), calendario de ventanas por
objeto, lista agrupada Ahora/Esperar/Sin datos con antigüedad de precio por fila, y pie con
«Actualizar».

## Decisiones de abajo (dentro del alcance autorizado, no reabren las de la maqueta)

1. **Vocabulario propio de esta vista**: `sale.action.sell` = «Vender ahora», `sale.action.wait` =
   «Esperar» (nunca «Mantener», nunca «Conservar»: esas palabras ya significan otra cosa en
   `inventory.decision.action.*`, que es del asesor de descarte, no de esta vista),
   `sale.action.notYet` = «Todavía no», `sale.action.deposit` reutiliza
   `advisor.view.action.deposit_material` («Depositar material»), `sale.action.noData` = «Sin
   cotización».
2. **Mapeo de la recomendación de `recommendPosition` a los 3 estados de venta**: `sell` → Vender
   ahora; `hold` → Esperar (sin ventana concreta: rule (c), fuera de cualquier calendario o con
   evidencia insuficiente); `sell_at_season` → Todavía no (tiene ventana concreta,
   `sellWindowFromDay`/`ToDay`); `review`/`hold_for_legendary` → Sin datos (el segundo se filtra:
   un objeto reservado para una legendaria no es «para vender»). La vista pinta lo que decida la
   regla; no se reinterpreta. **Esto incluye al Saco (36038)**, corrección del 26 sep 2026 (ver
   decisión 2-bis): su tarjeta usa la MISMA regla que cualquier fila, no una aparte.
2-bis. **Corrección de revisión (26 sep 2026)**: la primera entrega sacaba el veredicto del Saco de
   la señal de venta de cuenta (`sell-signal-runtime.ts`), que en su ventana de venta (−28..−1) y del
   1 oct al 15 nov solo puede dar `hold`/`none` — la tarjeta protagonista nunca podía decir «Vender
   ahora» justo cuando el encargo la pidió para eso. Corregido: `computeSaleHeroTiming`
   (`src/main.ts`) llama a `recommendPosition` directamente para el Saco, con su propia entrada de
   calendario (`resolveSaleSeasonalInputFor`, compartida con la del resto de filas), aunque la ruta
   del asesor para el Saco sea `open` y por eso `decideInventoryObjectRoute`
   (`inventory-object-result.ts`) descarte ese timing al fusionar ruta+momento
   (`saleSourceRowFromAdvisorRow` ya documentaba este mismo descarte para cualquier fila no-`sell`/
   `list`; el Saco solo era el caso donde SÍ nos importa el momento). La señal de cuenta se queda
   como dato secundario (umbral del año), nunca como veredicto. **Medido con el backtest curado real
   de 7 ediciones** (`sell-timing-history-36038.ts`, `src/main-sale-hero-timing.test.ts`): a 26 sep
   2026 (dentro de −28..−1, puja 342 por debajo del umbral del 90 %) el veredicto real es `sell`/
   `no_demonstrated_wait_advantage` («Vender ahora»); a 14 oct 2026 (fuera de esa ventana, calendario
   resuelve a la ventana anual de mayo porque 2027 no tiene ancla) el veredicto real, con ESTE
   fixture, es TAMBIÉN `sell` (`wait_evidence_insufficient`: la comparación «vender ya vs esperar a
   mayo» desde un día ya dentro del festival tiene 0 temporadas comparables en los datos curados,
   que se construyeron para la decisión ANTES del festival, no para ésta). No encontré una fecha
   realista donde la regla real, con los datos curados actuales, deje de decir «Vender ahora» sin
   más historial del que el fixture tiene — es un hallazgo para David, no una plaza sin cubrir del
   mecanismo: la ausencia de comparación resulta en `wait_evidence_insufficient`/`sell`, nunca en un
   `hold` inventado, que es la propiedad que pedía la corrección.
2-ter. **Abrir vs vender (nueva pieza)**: cuando la fila del Saco trae `containerEconomy`
   (`evaluateInventoryContainerEconomy`, ya calculada por el asesor — nunca recalculada aquí),
   `saleOpenVsSellCopper` lee `liquidOnly.explanation.open.totalExpectedMicroCopper` (convertido a
   cobre) y `.sellNow.netCopper`, y `applyOpenVsSellOverride` cambia el veredicto de «Vender ahora» a
   «Abrir» (`sale.action.open`, reutiliza `advisor.view.action.open`) cuando abrir es mayor. Solo
   sustituye `sell`; nunca toca esperar/todavía no/sin datos. Sin `containerEconomy` en la fila
   (activación pendiente, profundidad de mercado ausente, precio caducado…), la comparación se
   muestra como no disponible, nunca inventada.
3. **Punto 4 del encargo (decisión de David, 24 sep): con poco espacio, "esperar" pasa a "vender
   ahora"**. Se aplica tanto a `hold` como a `sell_at_season`: los dos significan «no ahora», y la
   regla no distingue entre «esperar genérico» y «ventana concreta demostrada» — solo entre vender
   ya o no. Esto es una lectura deliberada más amplia que el ejemplo del Saco en la maqueta (que
   solo dibuja la transición para su propia tarjeta); se aplica de forma uniforme a toda la lista
   para no crear una segunda regla sin escribir. Un material con `materialStorage` (puede ir al
   almacén) tiene prioridad sobre la venta: pasa a «Depositar material» en vez de «Vender ahora»,
   porque depositar no renuncia al precio. Con espacio de sobra ninguna fila cambia.
   **Discrepancia conocida con la maqueta**: en su lámina «poco espacio», Jorcamelo (43320) se
   dibuja sin cambios («Mantener»); con la regla anterior aplicada de forma literal a la posición
   real que calcularía `recommendPosition` (Jorcamelo SIEMPRE tiene entrada de calendario — su
   ventana anual de junio — así que su acción real nunca puede ser `hold` puro, solo `sell` o
   `sell_at_season`), Jorcamelo pasaría a «Vender ahora» con poco espacio. Se documenta como
   hallazgo para que David lo confirme o lo tumbe; no se reescribió la maqueta.
4. **Huecos que libera**: se muestra siempre que hay poco espacio y la fila queda en Vender/
   Depositar (haya cambiado de acción o ya lo fuera), igual que la maqueta lo hace con «Colmillos de
   plástico de alta calidad» (ya era «Vender ahora» y aun así gana «Libera 1 hueco.”). El número es
   `allocations.length` de la fila del asesor (una posición = un hueco, mismo criterio de
   `storage-space.ts`).
5. **Netos**: la venta inmediata reutiliza la valoración de posiciones con profundidad que comparte
   Inventario/Base (`row.value`, ruta `instant_sell`) y exige que su cantidad coincida con la
   cantidad mostrada. Como respaldo admite `marketComparison` solo con profundidad completa y
   cantidad cubierta exacta. Una puja por unidad no demuestra liquidez para toda la pila: sin esa
   evidencia dice «Neto no disponible», aunque conserve la puja. El Saco sigue la misma regla.
   La cifra de publicar sigue usando el ask y la política compartida de comisiones; es un anuncio,
   no una promesa de ejecución inmediata.
6. **47909 se muestra con el nombre que dé el catálogo** (la API), nunca con el `seasonId` interno
   ni con el nombre de la auditoría: coincide con lo que ya hace cada fila del asesor.
7. **Fuera de alcance** (igual que pide el encargo): el aviso «empieza su mejor semana de venta»
   (no existe ese motivo hoy), las pestañas Sesiones/Inventario del boceto H18.31, el escenario de
   simulación y los conmutadores de la maqueta (marco, no producto), y la bandeja de avisos
   (`renderHalloweenAlertPanel`): la lista de piezas del encargo no la incluye y ya vive en la
   pestaña Compañero.

## Checklist de 7 ejes

| Eje | Estado | Qué cubre / qué falta |
|---|---|---|
| Tokens | Cubierto | Solo variables de Obsidian; una variable propia (`--tyrian-action-mark`), igual que H18.31. |
| Componentes y estados | PARCIAL (falta ver con datos reales de una cuenta con Halloween activo) | Vender, esperar, todavía no, abrir (Saco, cuando abrir gana), sin cotización, precio viejo, 0 unidades, icono caído, cargando, bloqueado (fallo de API / límite de peticiones, reutilizando `advisor.view.blockedReason.*`). Verificado con vitest + jsdom y con el backtest real de 7 ediciones, no con Obsidian real. |
| Responsive | Cubierto | Mismos cortes de contenedor que el resto del plugin (759/520/400), copiados de la maqueta. |
| Accesibilidad | PARCIAL (falta lector de pantalla real) | `role="status"` en la línea de estado, `meter` nativo, marca de acción con forma (filete sólido/discontinuo) + palabra, nunca solo color. |
| Contenido real | Cubierto | IDs reales de la auditoría (36038, 36041, 43320, 47909, 48805); nombres del catálogo, no inventados. |
| Feedback del sistema | Cubierto | Línea de estado con última lectura y caducidad; pie con «Actualizar». |
| Assets | PARCIAL | Icono real vía `<img>` con la URL del catálogo cuando existe; iniciales cuando no (icono caído). |

## Lo que no se implementó

- El calendario usa un eje común de seis semanas: siete días antes de hoy y 35 después. Dibuja
  la ventana efectiva cuando la recomendación demuestra que esperar compensa; en las otras filas,
  todos los candidatos curados que intersectan ese rango. El calendario y la fila de una espera
  leen así la misma decisión, sin anunciar fechas incompatibles. Las ventanas lejanas se conservan en texto con
  su año y su cuenta de días, sin falsear su posición en la escala. La marca de hoy y las fechas del
  eje se explicitan. Los nombres y las fechas ocupan líneas separadas.
- El escenario de simulación (14 oct) de la maqueta no se implementa: la vista siempre lee «hoy»
  real, según pide el encargo (fuera de alcance el marco de conmutadores).
- **No medí la cifra real de abrir-vs-vender del Saco con datos de mercado actuales del plugin**:
  hacerlo exige simular una captura de cuenta completa (catálogo, precios, profundidad de mercado)
  para llegar a `evaluateInventoryContainerEconomy`, fuera de alcance razonable de este lote. La
  lógica de lectura y conversión (`saleOpenVsSellCopper`) está probada con un `containerEconomy`
  de ejemplo con la forma real (`main-sale-hero-timing.test.ts`), no con la cifra que el bazar da
  hoy.


## Corrección de continuidad (26 sep 2026)

«Actualizar» siembra los objetos del calendario mediante el servicio existente antes de refrescar
el asesor, solo con histórico opt-in. Abrir la vista mantiene la captura inicial existente sin
solicitar nuevas semillas. Los importes muestran unidades compactas con la cantidad completa en
`aria-label` y `title`; cada celda permite partir importes excepcionalmente largos. Un recuento de
huecos desconocido se omite, nunca se convierte en uno o cero.

La evidencia de precios de aceptación conserva los cinco payloads públicos reales del 26 sep y sus
hashes; ejecuta `parseDatawars2History` (media cuando existe, punto medio como respaldo). Los fixtures
anteriores de `0109128` usaban siempre el punto medio y no reproducían el parser de producción.
Las cantidades y pujas copiadas de Positions son una entrada histórica de prueba, no una captura
actual de cuenta; el test de refresco acredita el camino frío con IndexedDB y motor reales,
transporte público grabado y frontera de cuenta técnica controlada. Ninguno acredita instalación
Obsidian ni un precio vivo. La QA visual usa CSS de Obsidian y declara aparte qué datos desconoce.


Resultados del ensayo del 26 sep 2026 07:35 UTC, con las pujas de las notas de Positions del 13 sep
como entrada controlada (no cotizaciones vivas), y serie pública completa parseada por producción:

| Objeto | Veredicto | Temporadas ganadas/perdidas por esperar |
|---|---|---|
| Saco (36038) | Vender ahora | 2/5 |
| Trozo (36041) | Todavía no | 5/2 |
| Barra (47909) | Todavía no | 6/1 |
| Jorcamelo (43320) | Todavía no, junio de 2027 | 6/1 |
| Colmillos de alta calidad (48805) | Vender ahora | 0/0, entrenamiento elige vender |

Jorcamelo daba vender 0/0 cuando se evaluaba contra Halloween. Al comparar su junio propio cambia
el resultado; no se ha ajustado el histórico ni el criterio para conservar la tabla del relevo.
