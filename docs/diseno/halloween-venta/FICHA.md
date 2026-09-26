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
`optimum` en el `meter`), tarjeta destacada del Saco de Halloween (36038), calendario de ventanas
por objeto, lista agrupada Ahora/Esperar/Sin datos con antigüedad de precio por fila, y pie con
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
   regla; no se reinterpreta.
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
5. **Netos**: se reutiliza `row.marketComparison.instantSellCopper`/`listingCopper` (ya neto de la
   política de comisiones de `gw2-fees.ts`) cuando el objeto aparece como fila del asesor. Para el
   Saco (36038, ruta `open`, puede no tener `marketComparison`) hay un cálculo propio de respaldo,
   `computeInstantSellNetCopper`, que envuelve la MISMA `createTradingPostValueWithPolicy`
   (`instant_sell`) — nunca una fórmula nueva — solo para la venta inmediata; sin precio de venta
   (ask) de respaldo, «Publicar» queda sin dato en ese caso límite.
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
| Componentes y estados | PARCIAL (falta ver con datos reales de una cuenta con Halloween activo) | Vender, esperar, todavía no, sin cotización, precio viejo, 0 unidades, icono caído, cargando, bloqueado (fallo de API / límite de peticiones, reutilizando `advisor.view.blockedReason.*`). Verificado con vitest + jsdom, no con Obsidian real. |
| Responsive | Cubierto | Mismos cortes de contenedor que el resto del plugin (759/520/400), copiados de la maqueta. |
| Accesibilidad | PARCIAL (falta lector de pantalla real) | `role="status"` en la línea de estado, `meter` nativo, marca de acción con forma (filete sólido/discontinuo) + palabra, nunca solo color. |
| Contenido real | Cubierto | IDs reales de la auditoría (36038, 36041, 43320, 47909, 48805); nombres del catálogo, no inventados. |
| Feedback del sistema | Cubierto | Línea de estado con última lectura y caducidad; pie con «Actualizar». |
| Assets | PARCIAL | Icono real vía `<img>` con la URL del catálogo cuando existe; iniciales cuando no (icono caído). |

## Lo que no se implementó

- El calendario dibuja el eje y una barra por objeto con la ventana que GOBIERNA hoy
  (`resolveFestivalCalendarWindow`-equivalente); no dibuja una barra por cada candidato del objeto
  (el Saco tiene dos: antes del festival y mayo). El texto de la fila sí menciona ambas.
- El escenario de simulación (14 oct) de la maqueta no se implementa: la vista siempre lee «hoy»
  real, según pide el encargo (fuera de alcance el marco de conmutadores).
