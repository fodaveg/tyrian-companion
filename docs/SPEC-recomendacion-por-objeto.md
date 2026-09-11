# SPEC: recomendación por objeto (vender / mantener)

Escrita el 2026-09-11 sobre `main@2e58083` (0.1.33). Es la especificación que lee la sesión que
implementa: no arrastra la conversación de diseño. Todo lo que afirma sobre el código lleva
`ruta:línea` y se puede comprobar en ese SHA.

**Decisiones cerradas el 11 sep 2026 (§7).** La implementación arranca en sesión aparte leyendo solo
este fichero.

## Lo que David quiere, con sus palabras

«quiero un campo que me diga si vender o mantener. Por ejemplo: pedazo de ámbar gris son 440 oros.
¿gano algo teniendo todo ese material parado? ¿es necesario para alguna legendaria que quiera hacer?
¿o la recomendación es vender? Otro ejemplo serían las barras de caramelo, más enfocadas a Halloween.
Te pedí métricas de precios precisamente para saber cuándo es buen momento para vender el acumulado,
por ejemplo unos días antes de empezar el evento de Halloween o nada más empezar. Quiero maximizar
ganancias.»

El inventario que motiva la petición (captura de `Inventory.base`): Pedazo de ámbar gris antiguo
×313 (4,4 M cobre), Moneda mística ×243, Esquirla de Janthir Syntri ×273, Esquirla de las Costas
Bajas ×273, Gema amalgamada ×389, Barra de caramelo ×71, Esquirla de los Yermos de Pavesas de Niebla
×160, Jorcamelo ×31. Son materiales de legendarias de 2.ª y 3.ª generación más objetos de festival:
las dos familias que hoy el asesor no sabe distinguir de «cualquier pila».

## ⛔ Choque de rumbo que hay que resolver ANTES de implementar la regla (a)

`docs/PRODUCT.md:47-50` dice, firmado por David el 2026-09-01:

> **No se abre el frente de «qué me falta para X»** (materiales que faltan para una legendaria, una
> colección o un ascendido). […] Queda descartado para esta versión: no se empieza, y proponerlo de
> nuevo exige que David lo reabra.

`docs/SPEC-avisos-y-venta.md:81` lo repite como límite del lote de octubre («No abre "qué me falta
para X"»).

La frase «¿es necesario para alguna legendaria que quiera hacer?» es exactamente ese frente. Esta
spec **no lo da por reabierto**: lo marca como la decisión 1 de la lista final y separa la regla (a)
en un milestone propio (M4) que no arranca sin esa firma. Los milestones M1 a M3 entregan valor sin
tocarla y no la presuponen: el campo nace con un valor `hold_for_legendary` en su unión de tipos que
simplemente nunca se emite hasta M4.

## Restricciones duras que no se negocian

| Restricción | Dónde está escrita |
|---|---|
| El plugin nunca compra ni vende en el bazar | `docs/PRODUCT.md:132`; «ninguna recomendación ejecuta nada en el juego» `docs/PRODUCT.md:15` |
| Ninguna llamada de red al cargar el plugin ni al abrir una vista | `docs/PRODUCT.md:332`; `docs/PLATFORM_POLICY.md:53-55` |
| Solo hay dos hosts autorizados: `api.guildwars2.com` y `api.datawars2.ie` | `docs/PLATFORM_POLICY.md:30-39` |
| La cuenta se consulta solo por la API oficial | `docs/PRODUCT.md:118` |
| Ante dato desconocido o regla insuficiente: conservar o revisar, nunca destruir | `docs/PRODUCT.md:28` |
| Las notas del vault solo cambian por una operación explícita y validada | `docs/PRODUCT.md:323-324`; Principio 4 `docs/PRODUCT.md:334` |
| Los paneles no llevan prosa: la garantía va a `PRODUCT.md` o al `title` | `docs/SPEC-paneles-sin-prosa.md:6-9` |

## 1. Qué existe ya, y qué hay que generalizar

### 1.1 El asesor de inventario (`src/advisor/*`)

- **La unión de acciones ya contiene lo que hace falta.**
  `src/advisor/inventory-advisor-model.ts:12-22` declara, como diez miembros de una unión cerrada:
  `sell`, `list`, `vendor`, `salvage`, `use`, `open`, `deposit_material`, `keep`, `review` y
  `discard_candidate`. «Mantener» ya es `keep`: **no se añade una acción nueva**, se añade el motivo
  que dice POR QUÉ.
- **Los motivos son un código cerrado**, no prosa: `src/advisor/inventory-advisor-model.ts:24-59`.
  Ya existen los dos que esta spec necesita reutilizar:
  - `reserved_for_goal` (línea 37), que emite el clasificador en
    `src/advisor/inventory-advisor-classifier.ts:159` para la parte de la pila que un objetivo
    reserva.
  - `seasonal_hold` (línea 48), que emite `src/advisor/inventory-advisor-classifier.ts:553` cuando la
    economía del contenedor devuelve `hold`. El comentario de las líneas 550-552 fija la doctrina que
    esta spec extiende: *«la tercera salida de la capa económica aterriza en el `keep` que ya existe
    en vez de en una cuarta acción propia»*.
- **El motor de reservas por objetivo ya está construido y cableado.** `ReservationGoal` con sus
  `requirements` (`src/economy/reservation-model.ts:10-28`) entra en el asesor como
  `input.goals` (`src/advisor/inventory-advisor-model.ts:217`), se convierte en plan con
  `createReservationPlan` (`src/advisor/inventory-advisor-classifier.ts:43` y `:76`) y produce
  `shortfall` por activo (`src/economy/reservation-model.ts:54`). **La cantidad que falta para una
  legendaria ya tiene tubería**: lo único que falta es quién crea el objetivo.
- **Los objetivos ya se persisten**, por cuenta y bóveda, con CAS:
  `src/advisor/inventory-preferences-model.ts:25-31` (`goals: ReservationGoal[]`), almacén
  `src/advisor/inventory-preferences-store.ts:33`.
- **Ya existe la intención de conservar hasta un precio o una fecha**, con la categoría exacta que
  pide el caso de festival: `HoldIntentCategory` incluye `seasonal_rebound`
  (`src/economy/hold-intent.ts:9`), con `deadlineAt` y `target.unitGrossCopper`
  (`src/economy/hold-intent.ts:12-24`). **No se persiste todavía** (`docs/PRODUCT.md:243`: «Todavía no
  persiste ni edita intenciones»): ese es el hueco real.

**Se reutiliza**: la acción `keep`, los motivos `reserved_for_goal` y `seasonal_hold`, el motor de
reservas entero, la persistencia de preferencias.
**Hay que generalizar**: nada del asesor está atado a `36038`; lo que está atado es el histórico y la
señal de venta (§1.2) y la lista de objetivos, que hoy nadie crea desde la interfaz.

### 1.2 Histórico de precios y señal de venta (`src/economy/price-history-*`, `sell-signal-*`, `price-seed-*`)

Lo que hoy es **genérico y no hay que tocar**:

- `evaluateSellSignal(series, nowMs, parameters, window)` en `src/economy/sell-signal.ts:108-113`
  **ya recibe la ventana de temporada como cuarto parámetro**. No sabe nada de Halloween salvo por su
  valor por defecto.
- `SeasonalWindowV1` (`src/economy/seasonal-window.ts:17-26`) es un tipo de datos completo: `seasonId`
  libre, `opensOn`/`closesOn` en `MM-DD` UTC, soporte de ventanas que cruzan el año
  (`src/economy/seasonal-window.ts:54-56`) y rechazo explícito del 29 de febrero
  (`src/economy/seasonal-window.ts:107-117`). **Un calendario de festivales es una lista de estos, no
  código nuevo.**
- `mergeSellSignalSeries(seed, daily, itemId)` (`src/economy/sell-signal.ts:183-187`) ya filtra por
  `itemId`.
- `fetchPriceSeed(itemId, options)` (`src/economy/price-seed-source.ts`) ya es por ítem.
- La watch list de la IndexedDB de precios **ya admite 400 ids**
  (`PRICE_HISTORY_MAX_WATCH_ITEMS = 400`, `src/economy/price-history-model.ts:9`) y hoy solo lleva
  cinco semillas (`PRICE_HISTORY_SEED_ITEM_IDS = [36038, 36041, 105402, 48715, 73474]`,
  `src/economy/price-history-model.ts:8`), más los ids positivos observados al cerrar sesión
  (`src/economy/price-history-store.ts:128-151`).
- `calculatePriceHistoryPercentile(daily, side, windowDays, requiredDays = 42)`
  (`src/economy/price-history-statistics.ts:68-93`) devuelve **en qué percentil está el valor de HOY
  dentro de su propia ventana**, o `insufficient_history` con los días que sí tiene. Es exactamente la
  «banda» que pide la regla (c) y **no hay que escribirla**.

Lo que hoy está **atado al ítem 36038** y hay que generalizar:

| Atadura | Línea | Qué hacer |
|---|---|---|
| `HALLOWEEN_PRICE_ALERT_ITEM_ID = 36_038` | `src/halloween/halloween-price-alert.ts:6` | Se queda. Es el aviso de Halloween, no la recomendación. |
| `SellSignalRuntime` se construye con ese único id | `src/runtime/assemble-price-history.ts:92` | Pasar a un runtime **por ítem** de una lista curada. |
| `evaluate()` llama a `evaluateSellSignal` **sin** el 4.º argumento, así que siempre usa `HALLOWEEN_SEASONAL_WINDOW` | `src/economy/sell-signal-runtime.ts:137` | Añadir `window` a `SellSignalRuntimeOptions` y pasarlo. **Esta es la línea que hace que generalizar el runtime sin tocarla produzca un verde falso**: una barra de caramelo evaluada con el calendario de Halloween daría la respuesta correcta por accidente, y un objeto de Año Nuevo Lunar daría la contraria sin que nada se ponga rojo. |
| La lectura diaria y la cantidad poseída se piden para ese id | `src/main.ts:2190` y `src/main.ts:2206` | Iterar la lista. |
| El pack económico solo trae `sellSignal` para el saco | `src/runtime/assemble-price-history.ts:94-97` | Parámetros por ítem dentro del pack curado. |

**La semilla de datawars2** (`docs/PLATFORM_POLICY.md:19-28`) ya es por ítem en el endpoint
(`itemID=<id>`), ya está aprobada para «el objeto que la persona tenga elegido»
(`docs/PLATFORM_POLICY.md:30-39`) y ya tiene caché de 24 h por `(vaultId, itemId)` en
`tyrian-companion-price-seed-cache` (`src/economy/price-seed-cache-store.ts`,
`docs/PLATFORM_POLICY.md:43-47`). Lo que **no** está aprobado es pedirla para N ítems en una sola
acción: eso es la decisión 4.

### 1.3 El modelo de temporada (`src/economy/models/halloween-season.ts`)

Una sola ventana congelada: `seasonId: 'halloween'`, `10-01` a `11-15` UTC
(`src/economy/models/halloween-season.ts:16-26`), validada al cargar el módulo
(`src/economy/models/halloween-season.ts:24`). El comentario de las líneas 13-14 ya declara la
intención: *«vive dentro del pack económico curado, se hashea con él y se puede ampliar publicando
datos»*. El calendario multi-festival es ese mismo tipo repetido.

### 1.4 Las notas de posición (`Inventory/Positions/*.md`) y las Bases

- Una nota por combinación objeto × ubicación × personaje
  (`docs/INVENTORY-VAULT-SYNC.md:32-34`), decisión ratificada en `docs/PRODUCT.md:97-101`.
- El frontmatter es `InventoryNoteFields` (`src/inventory/inventory-vault-sync.ts:112-135`), y la
  lista cerrada de claves permitidas es `INVENTORY_NOTE_KEYS`
  (`src/inventory/inventory-vault-sync.ts:136-149`). Una clave extra desconocida en la nota es un
  **conflicto** y el plan entero no escribe nada.
- El DTO que las alimenta es `InventoryVaultPosition`
  (`src/inventory/inventory-vault-sync.ts:43-60`), construido por `InventoryVaultCaptureService.capture`
  (`src/inventory/inventory-vault-sync.ts:180-200`), que hoy resuelve catálogo, precios, acceso al
  bazar y profundidad de mercado, **pero no ejecuta el asesor**.
- Las Bases son assets gestionados hasheados: `src/assets/inventory-bases.ts` (textos ES/EN en
  `COPY`, líneas 6-23; `properties` compartidas en `commonBody`, líneas 25-71; orden de columnas de la
  vista principal en `inventoryBody`, línea 75, y **seis listas `order:` en total** en el fichero).
  Cambiar una columna cambia el hash del asset (`src/assets/managed-assets.ts:87`).

#### ⛔⛔ La landmine que se cobró un vault de 1.302 notas

`src/inventory/inventory-vault-sync.ts:151-163`, comentario literal del repo:

> THIS IS THE ONLY LIST OF ITS KIND. Adding a frontmatter key without listing it here turns every
> note already in the Vault into a conflict on the next sync, which writes nothing at all: that is
> exactly what `tc_unit_list_copper`/`tc_total_list_copper` did to a 1302-note Vault when they were
> added.

**Toda clave `tc_recommendation*` va en `INVENTORY_NOTE_KEYS` (línea 136) Y en
`INVENTORY_NOTE_KEYS_ADDED_LATER` (línea 158), en el mismo commit.** El criterio de cierre de M1 lo
mide, no lo asume.

#### ⛔⛔ La segunda landmine, gemela de la anterior: `contentVersion` del asset

`src/assets/inventory-bases.ts:156-163`, comentario literal del repo:

> H14.8: the `note.tc_captured_at` → `file.mtime` column swap shipped in 0.1.30 without bumping this.
> `ManagedAssetsManager.validManifestRelations` treats an unchanged `contentVersion` whose semantic
> bytes moved as a corrupt manifest (`conflict`), not an `update` […] on every vault that already had
> 0.1.30 installed.

Hoy vale `contentVersion: 6` (`src/assets/inventory-bases.ts:164`). **Añadir la columna sin subirlo a
7 convierte en `managed_assets_conflict` la Base de cualquier bóveda que ya tenga 0.1.33.** Es el
mismo fallo que la lista de claves de arriba, en la otra mitad del sistema: ya se cometió una vez y
está documentado en el propio fichero.

## 2. El campo de recomendación

### 2.1 Forma en el frontmatter

Cuatro claves nuevas en `InventoryNoteFields` (`src/inventory/inventory-vault-sync.ts:112`):

```yaml
tc_recommendation: sell / hold / hold_for_legendary / sell_at_season / review
tc_recommendation_reason: <código cerrado>      # nunca prosa
tc_recommendation_until: <ISO-8601> o null      # cuándo deja de valer esta recomendación
tc_recommendation_missing: <entero> o null      # solo en hold_for_legendary: cuántas faltan
```

Reglas de forma, todas heredadas de contratos que ya existen en el repo:

- `tc_recommendation` es una unión cerrada, igual que `InventoryRecommendationAction`
  (`src/advisor/inventory-advisor-model.ts:12`). **`review` es un valor legítimo y es el valor por
  defecto ante evidencia insuficiente**, por `docs/PRODUCT.md:28`. Nunca se escribe `sell` por falta
  de datos.
- `tc_recommendation_reason` es un **código**, no una frase, igual que
  `InventoryAdvisorReasonCode` (`src/advisor/inventory-advisor-model.ts:24-59`). La traducción vive en
  `src/core/i18n-runtime-catalog.ts` bajo `advisor.view.reason.*` (ver el precedente literal de
  `seasonal_hold` en `src/core/i18n-runtime-catalog.ts:515` y `:1423`). Esto es lo que permite que la
  Base sea bilingüe sin duplicar datos y lo que cumple `docs/SPEC-paneles-sin-prosa.md:6-9`.
- `tc_recommendation_until` es la fecha a partir de la cual la recomendación deja de ser fiable: para
  `sell_at_season` es el borde de la ventana calculado con
  `seasonalWindowClosesAfterMs` (`src/economy/seasonal-window.ts:80`); para `sell`/`hold` es
  `capturedAt + policy.maxPriceAgeMs` (`src/advisor/inventory-advisor-builtin-bundle.ts:86`, hoy
  900.000 ms). Que caduque es el punto: una recomendación de precio de hace tres semanas es ruido.
- Ningún campo lleva account id, clave, ruta ni snapshot (`docs/PRODUCT.md:13`).

### 2.2 Dónde se calcula

Una función **pura**, nueva, en `src/advisor/inventory-position-recommendation.ts`:

```
recommendPosition(input: PositionRecommendationInput): PositionRecommendationV1
```

sin red, sin IndexedDB, sin `Date.now()` (el instante entra como argumento, como en
`evaluateSellSignal`). La llama `InventoryVaultCaptureService.capture`
(`src/inventory/inventory-vault-sync.ts:190`) después de resolver precios y profundidad, y su salida
se añade a `InventoryVaultPosition` (`src/inventory/inventory-vault-sync.ts:43`).

Esto respeta el guard arquitectónico de la frontera de recomendaciones (`docs/PRODUCT.md:244`: la
frontera no puede importar clientes, transportes, stores ni secretos). Hay tests de arquitectura que
lo vigilan: `src/advisor/inventory-advisor-architecture.test.ts` y
`src/economy/recommendation-envelope-architecture.test.ts`.

### 2.3 La columna en la Base

En `src/assets/inventory-bases.ts`: dos claves nuevas en `COPY.es`/`COPY.en` («Recomendación» /
«Recommendation», «Motivo» / «Reason»), dos entradas en `properties` de `commonBody` (líneas 36-67) y
dos posiciones en **cada una de las seis listas `order:`** del fichero (la de `inventoryBody` está en
la línea 75), **justo después de `formula.item_link`**, que es la columna del nombre desde que H14.8 la
convirtió en enlace: es lo primero que David quiere leer, no la última columna de catorce. Y
`contentVersion` sube de 6 a 7 (`src/assets/inventory-bases.ts:164`).

Vista nueva sugerida, con el mismo patrón de `filters` que ya usan las cinco vistas actuales: **«Para
vender»**, filtrada por `tc_recommendation` igual a `sell` o a `sell_at_season`, ordenada por
`tc_total_sell_copper` descendente. Es la pantalla que responde «¿qué vendo hoy?».

## 3. Las reglas, en orden de precedencia

El orden es precedencia dura: la primera que decide, decide. Es el mismo orden que ya aplica el
clasificador (reservas y excepciones **antes** de cualquier ruta económica,
`src/advisor/inventory-advisor-classifier.ts:156-162`), y no se reabre aquí.

### (a) Necesario para una legendaria objetivo → `hold_for_legendary`

**Solo entra si David reabre `docs/PRODUCT.md:47-50` (decisión 1).**

**Quién dice qué legendarias quiere**: un ajuste del plugin. No se infiere: tener 313 pedazos de ámbar
gris no dice qué legendaria piensa hacer, y adivinarlo produciría exactamente el «mantener» que impide
vender. Esto no es una limitación técnica, es la frase de David («alguna legendaria **que quiera
hacer**»).

**De dónde sale la LISTA de legendarias que se le ofrece**: medido el 2026-09-11,
`GET https://api.guildwars2.com/v2/legendaryarmory` devuelve **410 entradas** de la forma
`{"id": 30704, "max_count": 2}`, sin clave. Los nombres e iconos salen de `/v2/items?ids=`, que el
plugin ya consume (`src/core/http.ts:10`, `publicCatalogLogicalEndpoint` en
`src/catalog/public-catalog-client.ts:43`). **La lista de legendarias no se cura a mano y no se
pudre**: es un endpoint público.

**De dónde salen los MATERIALES de cada legendaria**: aquí sí hay que elegir, y la medición decide.

Medido el 2026-09-11 contra la API oficial:

| Comando | Respuesta |
|---|---|
| `GET /v2/recipes/search?output=30704` (Twilight, rareza `Legendary`) | `[]` |
| `GET /v2/recipes/search?output=19675` (Mystic Clover) | `[]` |
| `GET /v2/recipes` (total) | 26.366 ids |

**La API no publica ninguna receta de Forja Mística.** El árbol recursivo `/v2/recipes` más
`/v2/items` resuelve la mitad artesanal (refinados, componentes) y se queda ciego exactamente en el
nudo que importa: dones, tributos, tréboles y la legendaria misma. Un árbol a medias es peor que
ninguno, porque produce una cifra de «te faltan N» que parece completa y no lo es, y eso viola
`docs/PRODUCT.md:28` por el lado optimista.

**Recomendación: tabla curada en el repo, con el mismo contrato que la bolsa 36038.** Es decir:
`sourceIds` apuntando a revisiones fijas de la wiki con `oldid`, `retrievedAt`, `publishedAt`,
`reviewedAt`, `validUntil` y `sha256`, exactamente como
`src/advisor/inventory-advisor-builtin-bundle.ts:39-62` (mira `SOURCES` en las líneas 58-62: cada
fuente es una URL con `oldid` congelado). Los hashes se recalculan **con el script del repo, nunca a
mano**: `node node_modules/jiti/lib/jiti-cli.mjs scripts/recompute-bundle-hashes.ts`
(`src/advisor/inventory-advisor-builtin-bundle.ts:52-54`).

**Coste de mantener esa tabla, sin adornos**: una legendaria de 3.ª generación son del orden de 8 a 12
nudos de árbol y 20 a 30 materiales hoja. Curar **una** legendaria con sus fuentes congeladas y su
hash es una tarde; curar las 410 no lo hace nadie y no hace falta. La tabla nace con las que David
nombre en la decisión 1 y crece publicando datos, que es justo lo que el formato del pack permite.
`validUntil` obliga a revisarla; el precedente de H13.7
(`src/advisor/inventory-advisor-builtin-bundle.ts:41-49`) es la prueba de que ese vencimiento se
vigila de verdad.

**Descontar lo ya conseguido**: `GET /v2/account/legendaryarmory` con permisos `account`, `unlocks` e
`inventories`. `unlocks` **ya está en los scopes recomendados**
(`src/account/account-service.ts:9-18`), así que no hay que pedirle a David una clave nueva. Requiere
una ruta nueva en el mapa de endpoints lógicos (`src/core/http.ts:7-18` y
`guildWars2LogicalEndpoint` en `src/account/guild-wars-2-client.ts:125-146`). Una legendaria ya
forjada sale de los objetivos sola.

**Cómo aterriza**: cada legendaria elegida se traduce a un `ReservationGoal`
(`src/economy/reservation-model.ts:20-28`) con `reason: 'achievement'` (o un valor nuevo `'legendary'`
en `ReservationReason`, `src/economy/reservation-model.ts:5`) y un `ReservationRequirement` por
material con `intendedUse: 'hold'`. **A partir de ahí el motor que ya existe hace todo el trabajo**:
`createReservationPlan` calcula `shortfall` (`src/economy/reservation-model.ts:54`) y el clasificador
emite `keep` con `reserved_for_goal` (`src/advisor/inventory-advisor-classifier.ts:159`). La
recomendación por objeto lee ese plan y escribe `hold_for_legendary` con
`tc_recommendation_missing = shortfall`.

**El excedente sí se vende.** Si el objetivo pide 100 y hay 313, la recomendación de las 213 libres se
decide por la regla (c). El motor ya particiona protegido frente a elegible
(`ReservationPlanAsset.unprotectedAvailable`, `src/economy/reservation-model.ts:70`); no hacer esto
sería dejar 3 M de cobre parados por un objetivo de 1,4 M.

### (b) Objeto de festival → `sell_at_season`

Objetos afectados en la captura de David: Barra de caramelo ×71, Jorcamelo ×31, y por extensión la
bolsa 36038 y los tres del piloto (`src/inventory/price-history-note-block.ts:17-22`:
36038 Saco de Halloween, 36041 Trozo de caramelo, 47909 Barra de caramelo, 36059 Colmillos de
plástico; correspondencia castellano confirmada en `docs/PLATFORM_POLICY.md:64-65`).

**Los ids del resto de objetos de la captura se resuelven en implementación por catálogo, no aquí.**
Las notas ya llevan `tc_item_id` (`src/inventory/inventory-vault-sync.ts:117`): la lista curada se
construye leyendo el vault, no transcribiendo nombres. No se escribe en esta spec ningún id que no se
haya medido.

**Mecánica**: `SellSignalRuntime` por ítem, con su `SeasonalWindowV1` propia, y
`evaluateSellSignal` recibiendo esa ventana **explícitamente** (arreglar
`src/economy/sell-signal-runtime.ts:137`). La salida `sell` fuera de temporada ya significa hoy
«vende, está caro» y la salida `hold` en temporada ya significa «no vendas, está en el suelo»
(`src/economy/sell-signal.ts:142-144`). El campo de la nota traduce:

- `sell` produce `tc_recommendation: sell`, motivo `bid_above_reference`.
- `hold` produce `tc_recommendation: sell_at_season`, motivo `seasonal_hold`,
  `tc_recommendation_until` = fin de la ventana. **Este es el que contesta la pregunta de David**:
  no es «guarda para siempre», es «guarda hasta esta fecha, que es cuando se vende».
- `none` cae a la regla (c).
- `undecidable` produce `tc_recommendation: review` con el motivo exacto
  (`malformed_input`, `no_close_today`, `insufficient_reference` o `undecidable_calendar`,
  `src/economy/sell-signal.ts:93`).

#### Qué hay que MEDIR con datawars2 para que la ventana sea un dato y no una suposición

David pide «unos días antes de empezar el evento, o nada más empezar». **Hoy no se sabe cuál de las
dos es**, y para el saco 36038 la medición que sí existe apunta a una tercera respuesta. De
`docs/SPEC-avisos-y-venta.md:36-37`, medido el 2026-09-03:

> Ciclo anual del saco (mejor puja media mensual): suelo en noviembre (3,2 a 3,6 plata), techo en
> abril y mayo (4,2 a 4,9) y en septiembre; deriva anual a la baja (2024: 5,8; 2025: 4,7; 2026: 4,0).
> Amplitud máximo/mínimo 1,35x: con 500 sacos la diferencia son unos 5 oros.

Es decir: para el **saco**, el mejor momento no es el festival, es **abril**. Y la ganancia en el
volumen real son cinco oros, un dato que la interfaz debe decir porque es lo que convierte la señal en
una decisión (`src/economy/sell-signal.ts:152-163`, `sellSignalGainCopper`).

**Pero el saco no es la barra de caramelo.** El saco es la moneda de entrada del evento y su oferta
explota durante el festival; un consumible de festival como la barra puede tener el ciclo invertido.
Asumir que comparten forma es exactamente la trampa. El protocolo de medición, que es un milestone
propio (M3) y no un supuesto:

1. Para cada ítem candidato, `GET https://api.datawars2.ie/gw2/v2/history/json?itemID=<id>&fields=date,buy_price_avg,buy_price_max,buy_price_min,sell_price_avg,sell_price_max,sell_price_min`
   (el endpoint exacto ya autorizado, `docs/PLATFORM_POLICY.md:23-24`), serie diaria completa.
2. Agregar por **mes del año** y por **día relativo al inicio de la ventana del festival**, con al
   menos **3 ediciones** (3 años) para poder hablar de ciclo. Con dos años cualquier forma es ruido.
3. Reportar, por ítem: mes techo, mes suelo, amplitud máx/mín, **y la deriva interanual**. La deriva
   del saco (5,8 luego 4,7 luego 4,0) es lo que hace que «espera al máximo del año pasado» sea un
   consejo que nunca dispara.
4. El entregable de M3 **es ese informe**, con la fila cruda de al menos un ítem a la vista, y solo
   después la ventana escrita en el pack. Una salida uniforme para todos los ítems (todos con el mismo
   mes techo) es señal de que la sonda no midió, no de que el mercado sea uniforme.

Si el resultado de un ítem es «no hay ciclo estacional detectable», eso **es** el resultado: ese ítem
sale de la familia (b) y cae a la regla (c). Es un desenlace legítimo y hay que escribirlo.

### (c) El resto → `sell` o `hold`

Es el caso del ámbar gris, las esquirlas, la gema amalgamada y la moneda mística mientras no sean
objetivo de nada.

**Dos condiciones, ambas necesarias para decir `sell`:**

1. **Capital parado por encima de un umbral.** Se mide con `tc_total_sell_copper`, que la nota ya
   lleva (`src/inventory/inventory-vault-sync.ts:122`) y que es venta instantánea **demostrada contra
   profundidad real de pujas** (`docs/PRODUCT.md:286-290`), no `precio × cantidad`. El umbral es la
   decisión 5.
2. **El precio está en la banda alta de su propio histórico.** `calculatePriceHistoryPercentile(daily,
   'bid', windowDays, requiredDays)` (`src/economy/price-history-statistics.ts:68`) devuelve dónde
   está hoy dentro de su ventana. **«Banda alta» = percentil ≥ 90.** Es el p90 local que ya existe, no
   un estadístico nuevo.

Por debajo de la banda: `hold`, motivo `below_local_band`. La lógica es la que David enuncia: si el
capital está parado pero el precio está en el suelo de su año, venderlo ahora es materializar la
pérdida.

**Tres detalles que deciden si esto funciona o miente:**

- `insufficient_history` **no es `hold`**. Es `review`, con el motivo
  `price_history_insufficient` y `coveredDays` a la vista. El umbral por defecto son 42 días
  (`src/economy/price-history-statistics.ts:72`) y un vault nuevo no los tiene. Decir «mantén» porque
  no se sabe es indistinguible de decir «mantén» porque está barato, y son cosas opuestas.
- `calculatePriceHistoryPercentile` hace `.slice(-windowDays)` sobre **entradas**, no sobre días de
  calendario (`src/economy/price-history-statistics.ts:79`). Con huecos en la serie, «últimos 365»
  puede abarcar dos años. Para la recomendación hay que **filtrar por `dayUtc` antes de llamar**, como
  ya hace `evaluateSellSignal` (`src/economy/sell-signal.ts:127-129`), o el percentil describe una
  ventana distinta de la que dice describir.
- El histórico local es **opt-in y nace apagado** (`priceHistoryEnabled`, `src/core/settings.ts:88`;
  `docs/PRODUCT.md` H9.1). Si está apagado, la regla (c) devuelve `review` con motivo
  `price_history_disabled` y la interfaz ofrece encenderlo. No se enciende sola.

## 4. Qué NO hace

- **No compra ni vende.** No hay executor, no hay orden, no hay confirmación de operación.
  `docs/PRODUCT.md:132` y `docs/PRODUCT.md:15`. La recomendación es un texto en una nota.
- **No infiere qué legendaria quiere el usuario.** Sale de un ajuste explícito o no sale.
- **No inventa un árbol de crafteo.** Medido: la Forja Mística no está en `/v2/recipes`
  (`/v2/recipes/search?output=19675` devuelve `[]`). Lo que no esté en la tabla curada se declara
  desconocido, no se estima.
- **No consulta la red al cargar ni al abrir la vista.** Todo cuelga de «Sincronizar» o de una sesión
  activa (`docs/PLATFORM_POLICY.md:53-55`).
- **No escribe notas fuera del plan Preview/Apply** ni toca contenido humano
  (`docs/INVENTORY-VAULT-SYNC.md:22-26`).
- **No añade prosa a los paneles** (`docs/SPEC-paneles-sin-prosa.md:6-9`).
- **No añade una acción nueva al asesor**: `hold_for_legendary` y `sell_at_season` son valores del
  campo de la NOTA; dentro del asesor siguen siendo `keep` con su motivo, por la doctrina de
  `src/advisor/inventory-advisor-classifier.ts:550-553`.

## 5. Milestones

Cada uno cierra en verde (`npm run check` y `npm test`, contando los pasos ejecutados contra
`scripts/gate-steps.mjs`) y con commit. Las dos cifras son **mi reloj**: camino limpio / con una
vuelta más.

### M1 · El campo existe, se calcula y llega a la Base (solo regla (c) básica) · 3 h / 6 h

Alcance: las cuatro claves de frontmatter, `recommendPosition` pura con la regla (c), la columna en
`Inventory.base` ES/EN, la vista «Para vender», las claves i18n.

**Criterio de cierre, medido, no asumido:**

1. Una sincronización sobre una bóveda con notas escritas por 0.1.33 produce **cero pasos
   `conflict`** en el plan (`InventoryVaultSyncStep.status`,
   `src/inventory/inventory-vault-sync.ts:69-74`). Se mide contando los `conflict` del plan, no
   leyendo que «funcionó». Esta es la prueba de que
   `INVENTORY_NOTE_KEYS_ADDED_LATER` se tocó (`src/inventory/inventory-vault-sync.ts:158`).
2. **Prueba negativa deliberada**: quitar la clave nueva de `INVENTORY_NOTE_KEYS_ADDED_LATER` tiene que
   poner el test en rojo con `conflict > 0`. Si sigue verde, el test no mide lo que dice.
3. Un test de **cableado** (no solo de la función pura) que demuestre que `capture()` rellena
   `tc_recommendation` en el DTO. La función pura verde no prueba que nadie la llame.
4. `contentVersion` de `inventory-bases` subido a 7. **Prueba negativa deliberada**: dejarlo en 6 con
   los bytes cambiados tiene que producir `managed_assets_conflict`, no `update`
   (`src/assets/inventory-bases.ts:156-163`).
5. `npx tsc --noEmit` aparte: `npm run lint` y vitest no tipan
   (`docs/SPEC-paneles-sin-prosa.md:78`).
6. `scripts/action-observability-baseline.json` reindexado con
   `scripts/reindex-action-observability-baseline.mjs`, nunca con `--write-baseline`
   (`docs/SPEC-paneles-sin-prosa.md:74-77`).

### M2 · Histórico por lista curada: la banda deja de ser adivinanza · 4 h / 8 h

Alcance: la watch list se alimenta de los ítems del inventario durable con capital por encima del
umbral (tope 400, `src/economy/price-history-model.ts:9`); semilla datawars2 por ítem; filtrado por
`dayUtc` antes del percentil; `tc_price_percentile` y `tc_price_coverage_days` opcionales en la nota.

**Cierre**: para una muestra real del inventario de David, cada fila declara `ready` con
`coveredDays` o `insufficient_history` con `coveredDays`. **Ninguna fila sale con un percentil y cero
días detrás.** Un resultado donde TODAS las filas salen igual (todas `ready` o todas
`insufficient_history`) se investiga antes de aceptarlo: es la firma de una sonda que no llegó a
mirar.

### M3 · Medición de festivales y calendario multi-temporada · 5 h / 10 h

Alcance: **primero el informe** (§3.b, protocolo de 4 pasos), después el código. Calendario como lista
de `SeasonalWindowV1` en el pack; `window` añadido a `SellSignalRuntimeOptions` y pasado en
`src/economy/sell-signal-runtime.ts:137`; un runtime por ítem de festival; `sell_at_season` con su
`tc_recommendation_until`.

**Cierre**: el informe con la serie cruda de al menos un ítem a la vista y la ventana ganadora por
ítem; un test que, con la ventana de un festival de invierno y una fecha de octubre, **no** devuelva
`in_season` (control negativo del arreglo de la línea 137: con el bug presente ese test es rojo).

### M4 · Legendarias · 6 h / 14 h · **BLOQUEADO por la decisión 1**

Alcance: ajuste de objetivos con la lista de `/v2/legendaryarmory`; tabla curada de materiales para
las legendarias que David nombre, con `sourceIds`, `retrievedAt`, `validUntil` y `sha256`; ruta nueva
`account/legendaryarmory` en `src/core/http.ts:7-18` y
`src/account/guild-wars-2-client.ts:125-146`; traducción a `ReservationGoal`;
`hold_for_legendary` más `tc_recommendation_missing`.

**Cierre**: para una legendaria elegida, la nota de un material suyo dice `hold_for_legendary` con la
cantidad que falta, **y la nota del excedente de ese mismo material dice `sell`** si la regla (c) lo
dice. Sin esa segunda mitad el objetivo congela toda la pila y la funcionalidad hace daño.
Los hashes del pack recalculados con `scripts/recompute-bundle-hashes.ts`, nunca transcritos.

**Total**: 18 h / 38 h, de las que 12 h / 24 h son M1 a M3 y no dependen de ninguna decisión de rumbo.

## 6. Riesgos

| Riesgo | Cómo muerde | Mitigación |
|---|---|---|
| ⛔ Clave de frontmatter sin registrar en `INVENTORY_NOTE_KEYS_ADDED_LATER` | Cada nota del vault pasa a `conflict` y la sincronización **no escribe nada**, en silencio aparente | Criterio de cierre 1 y 2 de M1, con su prueba negativa. Precedente: 1.302 notas (`src/inventory/inventory-vault-sync.ts:151-163`) |
| ⛔ `src/economy/sell-signal-runtime.ts:137` sin tocar al generalizar | La barra de caramelo se evalúa con el calendario de Halloween y acierta por accidente; otro festival falla y nada se pone rojo | Control negativo de M3, con una ventana de invierno |
| `insufficient_history` colapsado en `hold` | «No sé» se vuelve indistinguible de «está barato»: dos consejos opuestos con la misma salida | `review` explícito; `coveredDays` en la nota |
| `.slice(-windowDays)` sobre entradas, no días | El percentil describe una ventana distinta de la que dice | Filtrar por `dayUtc` antes de llamar (§3.c) |
| Árbol de crafteo a medias desde `/v2/recipes` | «Te faltan N» con N incompleto, que parece exacto | Medido: Forja Mística ausente. Tabla curada, y lo no curado se declara desconocido |
| Objetivo de legendaria que congela la pila entera | 3 M de cobre parados por un objetivo de 1,4 M | `unprotectedAvailable` y el criterio de cierre de M4 |
| ⛔ Columna nueva en `Inventory.base` sin subir `contentVersion` | Toda bóveda con 0.1.33 instalado ve `managed_assets_conflict`, no un `update`. Ya pasó en 0.1.30 (`src/assets/inventory-bases.ts:156-163`) | Subir a 7 y el criterio de cierre 4 de M1, con su prueba negativa |
| Añadir la columna a una sola de las seis listas `order:` | La columna existe pero no se ve en cuatro de las cinco vistas, y parece que el campo no se calcula | Contar las seis (`grep -c 'order:' src/assets/inventory-bases.ts`) |
| El pack curado caduca (`validUntil = 2026-12-01`, `src/advisor/inventory-advisor-builtin-bundle.ts:50`) | Todo lo que cuelga del pack deja de recomendar | Ya vigilado; la tabla de legendarias hereda la misma disciplina |
| Un lote sobre `src/ui/inventory-advisor-view.ts` | `docs/ESTADO.md:382-404`: 34 tests aseveran texto fuente y caen con un renombrado | Actualizarlos a la estructura nueva; nunca convertirlos en `expect(true)` |

## 7. Decisiones abiertas para David

**1. ¿Se reabre «qué me falta para X»?** `docs/PRODUCT.md:47-50` lo cerró el 2026-09-01 y dice que
reabrirlo exige tu firma. Tu frase «¿es necesario para alguna legendaria que quiera hacer?» es
exactamente ese frente.
▸ **Mi recomendación: SÍ, reabrir acotado** a «materiales de legendarias que YO nombre», no a
colecciones ni ascendidos. La tubería de reservas ya está construida y sin usar
(`src/economy/reservation-model.ts`, `src/advisor/inventory-advisor-classifier.ts:159`): es la parte
más cara y ya está pagada. Si la respuesta es no, M1 a M3 se entregan igual y el valor
`hold_for_legendary` nunca se emite.

**2. Materiales por legendaria: ¿árbol de la API o tabla curada?**
▸ **Mi recomendación: tabla curada**, por la medición del 2026-09-11:
`/v2/recipes/search?output=30704` (Twilight) y `?output=19675` (Mystic Clover) devuelven ambos `[]`.
La Forja Mística no está en la API y es justo donde vive el nudo. Coste: una tarde por legendaria, y
la lista de legendarias en sí la da `/v2/legendaryarmory` (410 ids, sin clave) sin curar nada.

**3. ¿Cuántos objetos llevan histórico propio, y quién los elige?** La watch list admite 400
(`src/economy/price-history-model.ts:9`) y hoy lleva 5.
▸ **Mi recomendación: derivada, no escrita a mano**: los ítems del inventario durable cuyo
`tc_total_sell_copper` supere el umbral de la decisión 5, tope 400, recalculada en cada
sincronización. Un ítem que deja de importar se cae solo.

**4. ¿Puede el plugin pedir a datawars2 la semilla de N ítems en una sola acción?** La política
autoriza hoy un ítem por acción explícita (`docs/PLATFORM_POLICY.md:30-39`) y cachea 24 h por
`(vaultId, itemId)`.
▸ **Mi recomendación: sí, pero solo detrás del botón «Sincronizar»**, secuencial (nunca en paralelo),
respetando la caché de 24 h y con un tope por ejecución. Toca `docs/PLATFORM_POLICY.md`, así que es
decisión tuya, no mía. Si la respuesta es no, la regla (c) funciona igual pero tarda 42 días en
arrancar en cada ítem nuevo.

**5. ¿Cuál es el umbral de «capital parado» que dispara la regla (c)?**
▸ **Mi recomendación: un ajuste nuevo, por defecto 10 oros (100.000 cobre) de
`tc_total_sell_copper`.** Deliberadamente **no** reutilizo `valuableLootThresholdCopper`
(`src/core/settings.ts:107`, 5 oros): mide otra cosa (el valor de UN drop en una sesión) y reutilizarlo
reescribiría en silencio la política de cualquier instalación que lo hubiera ajustado, que es el
error que el propio comentario de `src/core/settings.ts:101-106` documenta como ya cometido una vez.
Con 10 oros, de tu captura entran el ámbar gris, las esquirlas y la gema amalgamada, y quedan fuera
las pilas pequeñas. Cambia `SETTINGS_SCHEMA_VERSION` (hoy 12, `src/core/settings.ts:25`).

### Veredictos de David (11 sep 2026)

1. **Decidido el 11 sep 2026: SÍ, acotado.** Se reabre «qué me falta para X» solo para legendarias que
   David nombre en un ajuste; materiales desde tabla curada; lo conseguido se descuenta con
   `/v2/account/legendaryarmory`. M4 queda desbloqueado. Anotado en `docs/PRODUCT.md`.
2. **Decidido el 11 sep 2026: tabla curada.** La API no tiene recetas de Forja Mística (medición de la
   decisión 2).
3. **Decidido el 11 sep 2026: lista derivada del inventario, tope 400.**
4. **Decidido el 11 sep 2026: SÍ, solo tras «Sincronizar inventario», secuencial**, con caché de 24 h y
   tope por ejecución. Pendiente de anotar en `docs/PLATFORM_POLICY.md` en M2.
5. **Decidido el 11 sep 2026: ajuste nuevo, 10 oros (100 000 cobre).** No se reutiliza
   `valuableLootThresholdCopper`.
