# H18.13 · Medición del asesor de inventario en Fedora (24 sep 2026)

Encargo: medir sin cambiar código de producto. Recibo del asesor y notas de `42.31` en Fedora con
la versión actual, y confirmar o descartar la causa de `rule_stale` con la línea de código y un
caso real.

Fecha: 24 sep 2026, de 08:53 a 09:10 CEST. Máquina: Fedora (`Linux 7.2.7-200.fc44.x86_64`).
Árbol: worktree `agent-a606dd9e7cf8fa10a`, `HEAD` = `origin/main` = `a2584af3ca73` (0.1.35).
Los dos SHA salieron idénticos tras `git fetch`. `git status --porcelain` y `origin/main..HEAD`
estaban vacíos, así que no hizo falta `reset`. Se ejecutó `npm ci` dentro del worktree.

## Veredicto corto

- **Versión**: el `main.js` instalado en el vault es, byte a byte, el build de `a2584af` (0.1.35).
  Obsidian arrancó después de esa instalación. No pude leer la versión cargada en memoria con
  `obsidian eval` porque el entorno del agente bloquea cualquier orden que contenga `eval`
  (detalles en §1).
- **Recibo del asesor en Fedora con la 0.1.35: no existe.** El único recibo que hay en disco es
  del 13 sep, anterior a la instalación de la 0.1.35. Sacar uno nuevo exige una captura con la
  clave de API de David, y eso estaba prohibido. Lo que sí hice fue ejecutar el clasificador real
  de `a2584af` sobre las 1.371 posiciones de las notas de `42.31` con datos públicos (§2). Esa
  reconstrucción reproduce la forma del recibo del Mac: **1.371 de 1.371 decisiones en
  «revisar», 1.369 con `rule_stale`**.
- **`rule_stale`: causa CONFIRMADA**, con un matiz sobre la hipótesis de la auditoría. Es cierto
  que `equipment-salvage-economy.ts:132` valida la entrada completa antes de mirar el tipo
  (`:135`). Pero lo que invalida la entrada no es el objeto: es el **ectoplasma**. La validación
  exige que la puja del ecto que da `/v2/commerce/prices` coincida con el primer nivel de compra
  de `/v2/commerce/listings` (`:396`). Son dos endpoints distintos, se capturan por separado y a
  veces no coinciden. Cuando no coinciden, todos los objetos sin capacidad curada de la cuenta
  (armas, materiales, reliquias, trofeos…) salen `review / rule_stale`. Con los mismos datos y la
  puja igualada, `rule_stale` baja a 0 y «revisar» pasa de 1.371 a 62 decisiones.

## 1. Versión medida

| Medida | Comando | Resultado |
|---|---|---|
| `manifest.json` instalado | `cat ~/Documentos/fodaveg/.obsidian/plugins/tyrian-companion/manifest.json` | `"version":"0.1.35"` |
| sha256 del `main.js` instalado | `sha256sum …/tyrian-companion/main.js` | `abb69ce8d56f6d603661f709fe813d395f9352823264a337007ec31bb283c0ab` (mtime 19 sep 06:15) |
| sha256 del build de `a2584af` | `npm ci && npm run build && sha256sum main.js` en el worktree | `abb69ce8…283c0ab`, **idéntico** |
| Plugin habilitado | `grep '"tyrian-companion"' .obsidian/community-plugins.json` | presente |
| Arranque de Obsidian | `ps -o lstart -p 54502` (`/app/obsidian`, Flatpak) | 24 sep 07:42:12, posterior a la instalación del 19 sep |
| Versión en memoria | `obsidian eval 'code=…manifest.version'` | **NO MEDIDA**: el hook del agente rechaza la orden (se pidió en el encargo) |

Sobre el `eval`: el guardarraíl de aislamiento del worktree rechaza cualquier orden de Bash que
contenga `eval`, incluso un `grep` de esa palabra. No lo sorteé metiéndolo en un script, porque
eso sería saltarse un control. Si hace falta la versión en memoria, tendrá que ejecutarla una
sesión sin ese aislamiento. Aun así la conclusión apenas depende de ello: el fichero que Obsidian
cargó al arrancar a las 07:42 es el de la 0.1.35.

## 2. Recibo del asesor

### 2.1 Lo que hay en Fedora: recibo del 13 sep (anterior a la 0.1.35)

Leído en `.obsidian/plugins/tyrian-companion/inventory-advisor-capture-receipt.json`, sin
modificarlo. El plugin lo reescribe en cada captura (`inventory-advisor-evidence.ts:201`,
`main.ts:1749`), así que su fecha demuestra que **en Fedora no ha habido ninguna captura del
asesor desde el 13 sep**. Por tanto el estado en memoria del asesor (`InventoryAdvisorWorkflow.last`)
está vacío desde el arranque de hoy, y un `eval` tampoco habría devuelto un recibo con la 0.1.35
sin lanzar antes una captura con la clave, que está prohibida.

| Campo | Valor (13 sep 10:41Z) |
|---|---|
| `status` | `partial` |
| catálogo | 1.219 pedidos, 1.216 resueltos |
| precios | 1.191 pedidos, 572 capturados, 619 sin precio |
| `snapshot.quality` / pasadas | `stable` / 2 |
| `workflow.resultStatus` | **`invalid`**: `lineCount` 0, sin `actionCounts` ni `reasonCounts` |

Ese recibo no aporta conteos por acción ni por motivo: el resultado fue `invalid` entero. La causa
de ese `invalid` no se puede determinar sin los datos de aquella captura. Hay una pista, sin
verificar, en §5.

### 2.2 Reconstrucción con el código de `a2584af` (no es el recibo del plugin)

Método:
- Las posiciones salen de las notas de `42.31`, leídas en solo lectura y copiadas a JSON en el
  scratchpad.
- Catálogo, precios y profundidad del bazar son **públicos**: `/v2/items`, `/v2/commerce/prices` y
  `/v2/commerce/listings`, descargados hoy entre 09:01 y 09:02, **sin clave y sin cabecera
  `Authorization`**.
- El catálogo se normaliza con el parser real (`parseCatalogItems`).
- Se ejecutan de verdad `classifyInventoryAdvisor`, `applyInventoryDiscardAllowlist` e
  `inventoryAdvisorWorkflowReceipt` del repo, con el paquete de reglas integrado real
  (`inventoryAdvisorBuiltinBundleProvider`) y `EQUIPMENT_SALVAGE_POLICY_V1`.

Simplificaciones declaradas, que no tocan el camino de `rule_stale`:
- Todas las posiciones se colocan en banco.
- Las señales de cuenta van `complete` pero vacías: sin desbloqueos, porque leerlas exige la clave.
- No hay economía de contenedores ni metas o excepciones de conservación.
- El objeto 86804 queda `malformed` (§5).

La única diferencia entre A y B es la puja del ecto:

- **A, incoherente**: la puja de `/prices` supera en 6 c al primer nivel de `/listings`. Es el
  delta que medí en vivo a las 08:57 (1.703 frente a 1.697).
- **B, coherente**: la puja coincide con el primer nivel, como se midió a las 09:01 (1.701 = 1.701).

| Conteo (forma del recibo) | A incoherente | B coherente |
|---|---|---|
| `resultStatus` | `limited` | `limited` |
| líneas (objetos) | 1.191 | 1.191 |
| decisiones | 1.371 | 1.298 |
| decisiones visibles por defecto (≠ review) | **0** | 1.236 |
| **acción `review`** | **1.371** | **62** |
| acción `keep` | 0 | 549 |
| acción `list` | 0 | 429 |
| acción `vendor` | 0 | 166 |
| acción `sell` | 0 | 92 |
| **motivo `rule_stale`** | **1.369** | **0** |
| motivo `alternative_route_exists` | 0 | 687 |
| motivo `no_sell` | 0 | 549 |
| motivo `no_salvage` | 0 | 34 |
| motivo `salvage_exotic_rate_unverified` | 0 | 26 |
| motivo `price_partial` | 1 | 1 |
| motivo `salvage_item_evidence_uncertain` | 1 | 1 |
| objetos con todo en «revisar» | 1.191 | 57 |
| objetos con algún `rule_stale` | 1.189 | 0 |

Para comparar, el recibo del Mac del 10 sep daba 1.715 de 1.718 en «revisar», con 1.592
`rule_stale`. Es la misma firma que el caso A: casi todo en «revisar» y casi todo por
`rule_stale`.

## 3. Notas de inventario de `42.31`

Ruta: `40-49 Aficiones y creación/42 Guild Wars 2/42.31 Datos de cuenta de Guild Wars 2/`.

| Medida | Valor |
|---|---|
| Ficheros bajo `42.31` | 1.399 |
| Notas de posición (`Inventory/Positions/*.md`) | **1.371**, todas `tc_active: true` |
| Objetos distintos (`tc_item_id`) | **1.191** |
| Unidades totales | 176.731 |
| Fecha de escritura | 1.372 entradas del directorio con fecha 13 sep y 1 del 9 sep |
| Por origen | character 542 · bank 339 · materials 478 · shared_inventory 12 |
| Por tipo (posiciones) | CraftingMaterial 448 · Consumable 256 · Trophy 177 · Gizmo 109 · UpgradeComponent 103 · Relic 61 · Weapon 41 · Gathering 41 · Container 40 · Trinket 31 · Tool 20 · Armor 19 · Bag 10 · MiniPet 5 · Back 5 · null 4 · JadeTechModule 1 |

Comparación con el asesor:
- Los **1.191 objetos distintos** coinciden exactamente con `prices.requested = 1.191`
  (`availableByItem`) del recibo del 13 sep. Las notas y el asesor salieron de la misma captura
  de inventario.
- El catálogo pidió 1.219 porque incluye `ownedByItem`: objetos poseídos pero no disponibles.
- Solo **96 posiciones** son de equipo (Armor, Back, Trinket, Weapon). Que `rule_stale` afecte a
  1.369 decisiones de 1.371 descarta que el problema sea del equipo: afecta a todos los tipos.
- Las cifras del Mac (1.718) no son comparables una a una. Son otra captura, en otra fecha, y el
  Mac no tiene la carpeta `42.31`.

## 4. `rule_stale`: dónde se emite y por qué

El motivo `rule_stale` puede salir de cuatro sitios en `src/advisor/inventory-advisor-classifier.ts`:
1. `:439`: `policy_invalid_or_stale → rule_stale`, cuando la economía de desguace de equipo
   devuelve `review`.
2. `:475`: el paquete de reglas no es usable para una capacidad curada.
3. `:483-484`: una regla curada deshabilitada.
4. `:565-566`: activación económica revocada o caducada.

La reconstrucción del §2.2 señala la vía 1: B solo cambia la puja del ecto y hace desaparecer los
1.369 casos.

Cadena, con código de `a2584af`:

1. `classifyLine` llama a `categorySalvageRoute` para **todos** los objetos con cantidad libre,
   antes de `chooseRoute` (`inventory-advisor-classifier.ts:195` frente a `:210`). No filtra antes
   por tipo ni por rareza.
2. El adaptador (`inventory-equipment-economy.ts:18-86`) solo se salta los objetos con capacidad
   curada. Para el resto rellena `output.instantSellUnitCopper` con la puja del ecto de
   `/commerce/prices` (`:76`) y `output.instantSellLevels` con los niveles de compra de
   `/commerce/listings` (`:77`).
   - La puja llega por `capture.containerPrices`, que captura `captureContainerPrices`
     (`inventory-advisor-evidence.ts:153`).
   - Los niveles llegan por `capture.marketDepth`, que captura `captureInventoryMarketDepth` (`:146`).
   - Las dos piezas se juntan en `inventory-advisor-workflow.ts:264-267`.
3. `evaluateEquipmentSalvageEconomy` valida la entrada completa primero
   (`equipment-salvage-economy.ts:132`, `isInput`) y solo después mira el tipo (`:135`). `isInput`
   llama a `salvageOutput` (`:237`), que exige `instantSellUnitCopper === levels[0].unitCopper`
   (`:396`).
4. Si no coinciden, `isInput` devuelve `false` y el resultado es `review /
   policy_invalid_or_stale` con `ruleId: null`, **para cualquier objeto**, incluidos los que la
   función devolvería como `not_applicable / known_non_equipment` dos líneas más abajo.
   `salvageRouteFromEvaluation` lo traduce a `rule_stale` (`:439`) y `classifyLine` pone toda la
   cantidad libre en `review` (`:205-206`) sin llegar a `chooseRoute`.

La hipótesis de la auditoría («`:132` valida antes de mirar el tipo») es correcta sobre el orden
de las comprobaciones. Pero, por sí sola, no explica el volumen: hace falta un dato global
inválido. Ese dato es la **incoherencia entre las dos fuentes de la puja del ecto**. No es la
política, que es válida hasta `2027-02-25`, ni el objeto.

### 4.1 Caso con tres objetos de la cuenta

Los tres ids salen de las notas de `42.31`. Catálogo y precios son públicos, descargados a las
08:57. Sonda: `sonda-rule-stale.ts`, ejecutada con `node node_modules/jiti/lib/jiti-cli.mjs`.

| Objeto (id · tipo · rareza · nivel) | A: puja /prices 1.703 ≠ /listings 1.697 (medido en vivo) | B: puja = 1.697 (única diferencia) |
|---|---|---|
| 100063 Reliquia de sobrecarga · Relic · Exotic · 60 | eval `policy_invalid_or_stale` → línea `review×1` motivo **`rule_stale`** | eval `not_applicable / known_non_equipment` → `list×1`, `alternative_route_exists` |
| 101540 Faceta mística · CraftingMaterial · Rare · 0 (`NoSalvage`) | `policy_invalid_or_stale` → `review×1` **`rule_stale`** | `not_applicable / known_non_equipment` → `sell×1`, `alternative_route_exists` |
| 103643 Báculo sanguino · Weapon · Exotic · 80 (`NoSell`, `AccountBound`) | `policy_invalid_or_stale` → `review×1` **`rule_stale`** | `review / exotic_output_rate_unverified` → `review×1`, `salvage_exotic_rate_unverified` |

Bisección directa sobre `evaluateEquipmentSalvageEconomy` con el objeto 101540. Todas las
variantes pasan por la misma política y las mismas preferencias:

| Variante de `output` | Resultado |
|---|---|
| puja 1.697, 314 niveles (primer nivel 1.697) | `not_applicable / known_non_equipment` |
| puja 1.697, `instantSellLevels: null` | `not_applicable` |
| puja 1.697, un solo nivel | `not_applicable` |
| **puja 1.703, 314 niveles** | **`policy_invalid_or_stale`** |
| **puja 1.703, un solo nivel (1.697)** | **`policy_invalid_or_stale`** |
| puja 1.703, `instantSellLevels: null` | `not_applicable` |

Sale `policy_invalid_or_stale` solo cuando hay niveles de profundidad Y la puja de `/prices` no
coincide con su primer nivel. Con los niveles a `null` (profundidad del ecto incompleta), el mismo
desfase no invalida nada.

### 4.2 ¿Con qué frecuencia se desfasan las dos fuentes?

Sonda pública, sin clave: `/commerce/prices/19721` frente a `/commerce/listings/19721`, pedidos uno
detrás de otro.

| Ventana | Muestras válidas | Distintas |
|---|---|---|
| 08:57:42–08:57:55 | 7 | 7 (1.703 frente a 1.697) |
| 09:01:23 (descarga de la cuenta) | 1 | 0 (1.701 = 1.701) |
| 09:03:51–09:09:12, cada ~10 s | 28 (2 errores HTTP 400 descartados) | 1 (09:03:51: 1.701 frente a 1.702) |

El desfase es **intermitente**. Aparece en rachas, cuando una de las dos cachés de ArenaNet va por
detrás de la otra. Con los datos de hoy no se puede dar una tasa: las muestras de una misma ventana
no son independientes. Sí se puede afirmar lo siguiente:
- Una sola captura que caiga en una racha deja casi todo el inventario en `rule_stale`.
- En la captura real el riesgo aumenta, porque `/prices` y `/listings` se piden en llamadas
  distintas y la de `/listings` va en lotes secuenciales.

## 5. Hallazgo lateral (NO verificado en la captura real)

`/v2/items` devuelve hoy el objeto **86804** («Vale de intercambio de Tyria», Container) con un
salto de línea al final del nombre (`"Vale de intercambio de Tyria\n"`). `parseCatalogItem` lo
rechaza (`public-catalog-parsers.ts:32`, `nonEmptyString`, `isReportSafeCatalogItemName`) y
`parseCatalogItems` lanza la excepción para el array entero. En la reconstrucción lo parseé
entrada a entrada y lo marqué `malformed`. No he medido qué hace el resolutor real del catálogo
con el lote de 200 que contiene ese objeto, ni si esto tiene que ver con el
`resultStatus: invalid` del recibo del 13 sep. Queda como hipótesis para otra tarea.

## 6. Prueba de que el vault no cambió

Marca creada antes de leer nada: `touch <scratchpad>/marca-antes`, a las 2026-09-24 08:53:52.

Al terminar, a las 09:10:04, ejecuté
`find /home/fodaveg/Documentos/fodaveg -newer <scratchpad>/marca-antes -type f`, que listó 4 ficheros:

```
.obsidian/workspace.json
20-29 Trabajo y productos/21 Productos de software propios/21.11 Lumbre/Lumbre - Decisiones y aprendizajes.md
20-29 Trabajo y productos/21 Productos de software propios/21.14 Vega/Vega - Decisiones y aprendizajes.md
.obsidian/plugins/notebook-navigator/data.json
```

- **Ninguno está bajo `42.31` ni bajo `.obsidian/plugins/tyrian-companion/`.**
- `workspace.json` y `notebook-navigator/data.json` los escribe la propia interfaz de Obsidian, que
  está abierta.
- Las dos notas de decisiones son de Lumbre y Vega, que otras sesiones mantienen.
- Esta medición solo leyó el vault (`cat`, `grep`, `find`, `stat`, `sha256sum` y un script Python
  que abre las notas en modo lectura) y escribió únicamente en el scratchpad y en este worktree.

No ejecuté ningún comando del plugin, ni `dev:install`, ni peticiones con la clave. No abrí ni
imprimí `data.json`.

## 7. Límites

- La versión en memoria no está medida (hook de `eval`); sí lo están el fichero cargado y la hora
  de arranque.
- No hay recibo del asesor de la 0.1.35 en Fedora: haría falta una captura con la clave de David.
  La tabla del §2.2 es una reconstrucción con código real y datos públicos de hoy sobre el
  inventario del 13 sep. Las cifras de `keep` (549, `no_sell`) y de rutas de mercado dependen de
  las simplificaciones: señales de cuenta vacías, todo en banco y sin economía de contenedores. La
  cifra de `rule_stale` y su desaparición en B no dependen de ellas.
- Las sondas (`sonda-rule-stale.ts`, `sonda-cuenta.ts`, `extraer-posiciones.py`,
  `descargar-publico.py`, `muestrear-ecto.py`) viven en el scratchpad de la sesión y no se
  versionan. Sus salidas están resumidas arriba.
