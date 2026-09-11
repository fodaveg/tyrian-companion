# M3 · Medición de festival por objeto (datawars2)

Medido el 2026-09-11 desde `/home/fodaveg/code/tyrian-companion`, rama `main`, HEAD `42dfaa4ba12f`
(`git rev-parse HEAD` = `git rev-parse origin/main` tras `git fetch origin`; `git status --porcelain`
y `git log origin/main..HEAD` vacíos). Repo sin tocar. Todo lo producido vive en el scratchpad de la
sesión que midió (`raw-<id>.json`, `wiki-<año>.json`, `agrega.mjs`, `agregado.md`,
`control-36038.txt`, `detalle-36059.txt`, `inventario.txt`); este fichero es su copia canónica en el
repo, exigida por `docs/SPEC-recomendacion-por-objeto.md` §3.b («primero el informe, después el
código») y M3 (§5). Protocolo seguido: el de 4 pasos de esa sección. Campo medido: `buy_price_avg`
(mejor puja media diaria, en cobre; en las tablas 100 cobre = 1,00 plata). Endpoint: el único
autorizado en `docs/PLATFORM_POLICY.md:22-24`.

## 1. Descarga (paso 1)

Comando (una petición por ítem, secuencial, `sleep 1` entre ellas):

    for id in 36038 36041 47909 36059 43320 48805; do
      curl -sS -o raw-$id.json -w '%{http_code}' --max-time 60 \
        "https://api.datawars2.ie/gw2/v2/history/json?itemID=$id&fields=date,buy_price_avg,buy_price_max,buy_price_min,sell_price_avg,sell_price_max,sell_price_min"
    done

Inventario (`node` sobre cada `raw-<id>.json`):

| id | objeto (nombre del encargo) | HTTP | bytes | filas | rango de fechas | filas con `buy_price_avg` numérico | primera con `buy_price_avg` |
|---|---|---|---:|---:|---|---:|---|
| 36038 | Saco de Halloween | 200 | 689933 | 4969 | 2012-10-24..2026-09-11 | 2562 | 2019-07-13 |
| 36041 | Trozo de caramelo | 200 | 661405 | 4935 | 2012-10-24..2026-09-11 | 2561 | 2019-07-13 |
| 47909 | Barra de caramelo | 200 | 689883 | 4571 | 2013-10-17..2026-09-11 | 2561 | 2019-07-13 |
| 36059 | Colmillos de plástico | 200 | 681019 | 4969 | 2012-10-24..2026-09-11 | 719 | 2019-07-13 |
| 43320 | Jorcamelo | 200 | 709848 | 4738 | 2013-06-12..2026-09-11 | 2561 | 2019-07-13 |
| 48805 | Colmillos de plástico de alta calidad | 200 | 671582 | 4579 | 2013-10-17..2026-09-11 | 2562 | 2019-07-13 |

Hechos de la serie que condicionan todo lo demás:

- `buy_price_avg` / `sell_price_avg` **solo existen desde 2019-07-13** en los 6 ítems; antes solo hay
  `*_max` y `*_min`. Por eso el análisis cubre las ediciones **2019 a 2025** (2019 parcial: la serie
  empieza 2019-07-13, dentro de la ventana -42) y no llega a 2013 aunque la serie sí.
- Las claves de cada fila son exactamente las 7 pedidas: `buy_price_avg,buy_price_max,buy_price_min,date,sell_price_avg,sell_price_max,sell_price_min`.
- **36059 no tiene mercado de puja**: sus 719 filas con `buy_price_avg` valen **0** todas (`filas con
  buy_price_avg>0: 0 de 719`), 2021-2024 el campo viene `null`, y en 2026 `buy_price_max` trae el
  centinela `-9223372036854776000` (int64 mínimo, artefacto de datawars2). Su `sell_price_avg` sí
  existe (2562 filas, min 29, max 87 cobre, casi siempre 30). Detalle en `detalle-36059.txt`.

### Fila cruda de ejemplo (JSON tal cual sale del endpoint)

36038, 2025-04-15 (`node -e '...find(r=>r.date.startsWith("2025-04-15"))'` sobre `raw-36038.json`):

    {"buy_price_avg":477,"buy_price_max":477,"buy_price_min":477,"date":"2025-04-15T00:00:01.000Z","sell_price_avg":513,"sell_price_max":515,"sell_price_min":507}

47909, 2024-10-20 (primer domingo del festival 2024):

    {"buy_price_avg":50054,"buy_price_max":53007,"buy_price_min":49126,"date":"2024-10-20T00:00:01.000Z","sell_price_avg":55263,"sell_price_max":59989,"sell_price_min":50002}

36059, 2024-10-20 (sin puja) y última fila 2026-09-11 (centinela en `buy_price_max`):

    {"buy_price_avg":null,"buy_price_max":null,"buy_price_min":null,"date":"2024-10-20T00:00:01.000Z","sell_price_avg":30,"sell_price_max":30,"sell_price_min":30}
    {"buy_price_avg":0,"buy_price_max":-9223372036854776000,"buy_price_min":0,"date":"2026-09-11T00:00:00Z","sell_price_avg":30,"sell_price_max":30,"sell_price_min":30}

Primeros bytes de `raw-36038.json` (2012, sin `*_avg`):
`[{"buy_price_max":68,"buy_price_min":68,"date":"2012-10-24T00:00:00.000Z","sell_price_max":77,"sell_price_min":77},…`

## 2. Fechas de Shadow of the Mad King (paso 2)

Fuente: infobox (`| date =` / `| end date =`) del wikitext de cada página, descargado con
`curl "https://wiki.guildwars2.com/api.php?action=parse&page=Shadow_of_the_Mad_King_<año>&prop=wikitext&format=json"`.
El encargo original pedía 2021-2025 (+2026); se añadieron 2019 y 2020 porque la serie con
`buy_price_avg` las cubre y eso da 7 ediciones en vez de 5.

| edición | inicio | fin | días | URL |
|---|---|---|---:|---|
| 2019 | 2019-10-15 | 2019-11-05 | 21 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2019 |
| 2020 | 2020-10-13 | 2020-11-03 | 21 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2020 |
| 2021 | 2021-10-05 | 2021-11-09 | 35 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2021 |
| 2022 | 2022-10-18 | 2022-11-08 | 21 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2022 |
| 2023 | 2023-10-17 | 2023-11-07 | 21 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2023 |
| 2024 | 2024-10-15 | 2024-11-05 | 21 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2024 |
| 2025 | 2025-10-07 | 2025-11-04 | 28 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2025 |
| 2026 (anunciada) | 2026-10-13 | 2026-11-03 | 21 | https://wiki.guildwars2.com/wiki/Shadow_of_the_Mad_King_2026 |

La prosa de cada página coincide con la infobox (p. ej. 2025: «launched on October 7, 2025, and ended
on November 4, 2025»). 2026 está en futuro en la wiki («will be launched on October 13, 2026»).

## 3. Método de agregación (paso 3)

Script: `agrega.mjs` (Node, sin dependencias; conservado en el scratchpad de la medición, no en el
repo). Un solo ítem: `node agrega.mjs 36038`.

- (a) Mensual: media de `buy_price_avg` de los días de cada mes-año (n días entre paréntesis). Columna
  «índice» = media, entre los años completos 2020-2025 con ≥15 días en ese mes, de (media del mes /
  media anual de ese año). El índice quita la deriva interanual: sin él, el mes techo lo decide el año
  caro y no la estación. Mes techo / mes suelo se leen del índice; además va la tabla
  techo/suelo/amplitud POR AÑO para ver si el techo es estable.
- (b) Festival: tramos de 7 días desde -42 hasta +41 respecto al día de inicio de la wiki (12 tramos;
  el día 0 es el inicio). «Edición completa» = ≥60 de los 85 días de la ventana con `buy_price_avg`
  numérico. Agregado sobre ediciones completas; «índice» = media entre ediciones de (media del tramo /
  media anual de esa edición). Fases: antes (-42..-1), al empezar (0..+6), durante (+7..fin real de
  esa edición), después (fin+1..fin+42).
- Veredicto automático: <3 ediciones completas → «datos insuficientes»; amplitud techo/suelo del
  índice mensual <1,10 → «sin ciclo estacional»; si no, «ventana medible». El veredicto final de §5 lo
  redacta quien mide leyendo las tablas, porque el automático solo mira el mes techo y no si el
  festival ayuda o estorba.

## 4. Controles de la sonda

### (i) 36038 contra `docs/SPEC-avisos-y-venta.md:36-37`

El texto que estaba en `docs/SPEC-avisos-y-venta.md:36-37` decía: suelo nov 3,2-3,6 plata; techo
abr-may 4,2-4,9 «y en septiembre»; **media anual** 2024: 5,8 / 2025: 4,7 / 2026: 4,0; amplitud 1,35x.

Agregación de esta medición (tabla (a) de 36038 en §6; `node agrega.mjs 36038`):

- Noviembre: 2023 3,31 · 2024 3,73 · 2025 3,21 (2022: 2,59; 2021: 2,99). Coincide con 3,2-3,6 salvo el
  2024 (3,73) y los años anteriores, más bajos. Suelo del índice = nov (0,777). **Coincide.**
- Abril-mayo: 2024 5,08 / 5,48 · 2025 4,73 / 4,82 · 2026 3,91 / 4,00. Techo del índice = may (1,190),
  con abr 1,058 y jul-sep 1,10-1,11 (el «y en septiembre» del texto anterior: 2023 y 2024 el mes techo
  real fue sep). **Coincide en forma; el 2024 sale algo más alto que 4,9.**
- Amplitud por año: 2022 1,37x · 2023 1,39x · 2025 1,50x · 2024 1,58x. El 1,35x del texto anterior es
  el extremo bajo del rango. **Compatible.**
- **Las medias anuales NO coinciden con «5,8 / 4,7 / 4,0»**: esta medición da 2024 **4,78** · 2025
  **4,14** · 2026 **3,83** (media de los 355/361/254 días con dato). Comprobados los 7 campos
  (`control-36038.txt`): ninguna media anual de ningún campo da 5,8/4,7/4,0 (`buy_price_max`
  4,85/4,32/4,03; `sell_price_avg` 5,59/4,80/4,20). Lo que SÍ casa es el **techo mensual de cada año**:
  2024 sep **5,81** · 2025 may **4,82** · 2026 may **4,00**. **Conclusión (hallazgo 2 de este audit):
  la frase «media anual 5,8 / 4,7 / 4,0» de `docs/SPEC-avisos-y-venta.md:36-37` es, con toda
  probabilidad, el TECHO MENSUAL de cada año, no la media anual; la dirección de la deriva (a la baja
  2024→2026) se sostiene con cualquiera de las dos lecturas.** El texto anterior no dejó comando
  reproducible; esta medición sí (`control-36038.txt`, tabla (a) de §6). `docs/SPEC-avisos-y-venta.md`
  se corrige en el mismo commit que este audit, citándolo.

### (ii) Uniformidad

Techos: may / sep / (sin dato) / jun / oct / oct. Suelos: nov / nov / (sin dato) / ago / ene / feb.
Mejor fase de festival: antes / antes / - / después / al empezar / al empezar. **No es uniforme**: la
sonda discrimina. Control adicional: el ítem sin mercado (36059) sale como sin dato, no como un ciclo
inventado.

## 5. Resultado por ítem (paso 4)

Resumen (índice = adimensional sobre la media anual; plata = `buy_price_avg`/100):

| id | objeto | ediciones completas | mes techo (índice) | mes suelo (índice) | amplitud índice | amplitud por año | deriva interanual (media anual, plata: 2020→2026) | fase festival mejor (índice) | mejor tramo 7d (índice) |
|---|---|---:|---|---|---:|---|---|---|---|
| 36038 | Saco de Halloween | 7 | may (1,190) | nov (0,777) | 1,53x | 1,09x..2,39x | 5,02 · 4,11 · 3,23 · 3,63 · 4,78 · 4,14 · 3,83 | antes (1,149); al empezar 0,877; durante 0,802; después 0,763 | -14..-8 (1,156) |
| 36041 | Trozo de caramelo | 7 | sep (1,196) | nov (0,783) | 1,53x | 1,27x..3,28x | 0,33 · 0,33 · 0,30 · 0,34 · 0,76 · 0,62 · 0,60 | antes (1,201); al empezar 0,976; durante 0,900; después 0,766 | -7..-1 (1,237) |
| 47909 | Barra de caramelo | 7 | oct (1,209) | ene (0,871) | 1,39x | 1,05x..1,93x | 321 · 307 · 266 · 233 · 328 · 435 · 408 | al empezar (1,264); antes 1,196; durante 1,182; después 0,909 | +0..+6 (1,264) |
| 36059 | Colmillos de plástico | 0 | - | - | - | - | puja = 0 todos los días con dato | - | - |
| 43320 | Jorcamelo | 7 | jun (1,396) | ago (0,814) | 1,72x | 1,36x..2,63x | 416 · 473 · 287 · 225 · 313 · 445 · 526 | después (0,917); antes 0,853; al empezar 0,865; durante 0,886 (TODAS <1) | +35..+41 (0,934) |
| 48805 | Colmillos de plástico de alta calidad | 7 | oct (1,445) | feb (0,786) | 1,84x | 1,17x..2,85x | 52,7 · 51,8 · 56,7 · 39,3 · 33,9 · 26,4 · 29,1 | al empezar (1,556); durante 1,281; antes 1,200; después 0,954 | +0..+6 (1,556) |

Veredictos:

- **36038 Saco de Halloween** → **ventana medible: vender en mayo o en las 4 semanas ANTES del
  festival (-28..-1, índice 1,14-1,16); nunca desde el día 0. El festival es el suelo.** Cae de 1,15 a
  0,88 en la semana de inicio y sigue bajando hasta 0,75 seis semanas después, en las 7 ediciones sin
  excepción. Mes techo por año: may 2020, abr 2021, jul 2022, sep 2023, sep 2024, may 2025, may 2026:
  se reparte entre may y jul-sep (índices 1,19 y 1,10-1,11), el suelo es nov/dic en 6 de 7 años.
  Deriva: a la baja 2020→2022, rebote 2024, de nuevo a la baja 2025-2026.
- **36041 Trozo de caramelo** → **ventana medible: vender la semana anterior al inicio (-7..-1, índice
  1,237) o en sep (índice 1,196); no durante el festival (0,90) ni después (0,77).** Suelo nov en el
  índice; techo por año disperso (may, sep, ago, sep, ago, abr, abr). 2024 es un año atípico (ago 1,12
  plata contra 0,3-0,6 el resto: media anual 0,76 frente a 0,30-0,34 antes), y la deriva desde entonces
  es a la baja (0,76 → 0,62 → 0,60). Amplitud 1,53x sobre un precio de ~0,5 plata: la ganancia absoluta
  es pequeña salvo con miles de unidades.
- **47909 Barra de caramelo** → **ventana medible: vender al EMPEZAR el festival (+0..+6, índice
  1,264) o la semana anterior (1,258); mes techo oct.** Es el ciclo «invertido» de un consumible de
  festival: la puja sube hacia el festival, se mantiene las dos primeras semanas (1,17-1,19) y se hunde
  a partir de +21 (1,01 → 0,92). Mes techo por año: may 2020, oct 2021, sep 2022, oct 2023, oct 2024,
  sep 2025 (2026 aún sin oct); suelo ene-feb en 5 de 7. Deriva: a la baja hasta 2023 (233 plata), subida
  fuerte 2024-2025 (435), 2026 en 408.
- **36059 Colmillos de plástico** → **datos insuficientes (0 ediciones con puja): el objeto no tiene
  mercado de puja en datawars2.** `buy_price_avg` es 0 en las 719 filas donde existe y `null` en
  2021-2024; `sell_price_avg` está clavado en 29-30 cobre casi siempre (max 87). Con una serie de
  `buy_price_avg` así, la señal de venta sobre la puja es `undecidable`/sin referencia por
  construcción. **Hallazgo 1 de este audit: 36059 está en `PRICE_HISTORY_NOTE_PILOT_ITEMS`
  (`src/inventory/price-history-note-block.ts:17-22`) y en `docs/PLATFORM_POLICY.md:64-65` como ítem
  del piloto; su gráfica de puja será una línea a cero.** Cae a la regla (c) o a «sin recomendación» de
  M3; no entra en el calendario de festivales. Se documenta aquí y NO se retira del piloto: la señal de
  precios (venta, `sell_price_avg`) sigue existiendo para este ítem, es solo la puja la que está
  vacía.
- **43320 Jorcamelo** → **ventana medible: vender en JUNIO (índice 1,396; mes techo jun en 5 de 7
  años, may en los otros 2); el festival NO es la ventana: las cuatro fases están por debajo de la
  media anual (0,85-0,92).** Es el caso contrario al 47909: Halloween le baja el precio (la oferta
  entra en el festival) y el techo está a 8 meses. Suelo ago en el índice, pero por año el suelo salta
  (ene, dic, oct, ago, ene, ene, ago). Amplitud 1,72x sobre ~3-5 oros: es el ítem donde el momento vale
  más dinero. Deriva: 416 → 473 → 287 → 225 → 313 → 445 → 526 plata (a la alza desde 2023). No se
  verificó que 43320 sea catalogado como objeto de Halloween; entra como candidato medido en el vault
  del encargo y el dato dice que su ciclo no lo gobierna Halloween.
- **48805 Colmillos de plástico de alta calidad** → **ventana medible: vender en la PRIMERA SEMANA
  del festival (+0..+6, índice 1,556, el pico más nítido de los seis); mes techo oct (1,445), suelo feb
  (0,786).** El pico es de una semana: +7..+13 ya cae a 1,32 y +35..+41 a 1,05. Antes del festival
  también está alto (1,20-1,31 de -21 a -1). Techo por año: sep, jul, abr, oct, jul, oct, ago (disperso
  fuera de la ventana; la constante es la semana 0). Deriva claramente a la baja: 52,7 (2020) → 26,4
  (2025), 29,1 en 2026; «espera al máximo del año pasado» aquí no dispararía nunca, que es la trampa
  que nombra la spec.

Ninguno cae a «sin ciclo estacional detectable»: todos los que tienen mercado superan 1,39x de
amplitud en el índice mensual. Lo que sí cambia entre ellos es DÓNDE está la ventana: antes del
festival (36038, 36041), al empezar (47909, 48805) o lejos de él (43320). Con tres respuestas
distintas entre cinco ítems, la ventana tiene que ser por ítem, como propone `SellSignalRuntimeOptions`
(una `SeasonalWindowV1` propia por runtime) y el calendario multi-festival de M3.

## 6. Reproducir cada número

Todos los comandos se ejecutan sobre el directorio de descarga (`raw-<id>.json`, `wiki-<año>.json`):

- Inventario (bytes, filas, rango, cobertura de `buy_price_avg`, claves): `node -e 'const
  r=JSON.parse(require("fs").readFileSync("raw-36038.json","utf8"));console.log(r.length,r[0].date,r.at(-1).date,r.filter(x=>typeof
  x.buy_price_avg==="number").length)'`.
- Fila cruda: `node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("raw-36038.json","utf8")).find(r=>r.date.startsWith("2025-04-15"))))'`.
- Fechas de festival: `node -e 'const j=JSON.parse(require("fs").readFileSync("wiki-2025.json","utf8"));console.log(j.parse.wikitext["*"].match(/\|\s*(date|end date)\s*=\s*[^\n]*/gi))'`.
- Tablas (a), (b), fases, resumen y veredicto automático: `node agrega.mjs` (todos) o `node agrega.mjs <id>`.
- Control (i), medias anuales por campo y máximo mensual de 36038: `control-36038.txt`.
- Detalle de 36059 por año: `detalle-36059.txt` y `node -e 'const
  r=JSON.parse(require("fs").readFileSync("raw-36059.json","utf8"));console.log(r.filter(x=>x.buy_price_avg>0).length)'`
  → `0`.

## 7. Hallazgos para el repo

1. **36059 (Colmillos de plástico) no tiene puja en datawars2** y sigue en
   `PRICE_HISTORY_NOTE_PILOT_ITEMS` (`src/inventory/price-history-note-block.ts:17-22`). No se retira
   del piloto: su serie de venta (`sell_price_avg`) sí existe; es la señal de compra (`buy_price_avg`)
   la que está vacía, así que cae a la regla (c) del asesor de recomendación (o a `review` por falta de
   referencia), nunca al calendario de festivales de M3.
2. **La frase «media anual 5,8 / 4,7 / 4,0» de `docs/SPEC-avisos-y-venta.md:36-37` mide en realidad el
   TECHO MENSUAL de cada año** (2024 sep 5,81; 2025 may 4,82; 2026 may 4,00), no la media anual medida
   sobre `buy_price_avg` (2024: 4,78; 2025: 4,14; 2026: 3,83; `control-36038.txt`). Corregido en el
   mismo commit que este audit.
