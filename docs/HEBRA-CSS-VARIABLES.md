# Variables CSS de Obsidian en Tyrian → tokens de Hebra (R1c-CSS)

Tabla de equivalencias para que Hebra cargue `styles.css` de Tyrian dentro de sus huecos de módulo y se vea con el diseño de Hebra. Contrato: `hebra/docs/SPEC-TYRIAN-EN-HEBRA.md` §2 («la tabla de equivalencias de sus 44 variables CSS de Obsidian con los tokens de Hebra») y fila R1c de §6.

Árboles medidos (28 sep 2026):

- Tyrian: `eeef248` (rama `r1c-css`), `styles.css` de 3.109 líneas.
- Hebra: `main` en `ac30bf0e`, solo lectura.
- Obsidian: `app.css` de la 1.14.2, sacado en solo lectura del asar que usa la app en este Mac (`~/Library/Application Support/obsidian/obsidian-1.14.2.asar`). Los valores «Obsidian claro / oscuro» de la tabla salen de ahí: bloques `body`, `.theme-light` y `.theme-dark` del tema por defecto, con el acento por defecto (`--accent-h: 258`, `--accent-s: 88%`, `--accent-l: 66%`), que el usuario puede cambiar en los ajustes de Obsidian.

## 1. Inventario medido

Desde la raíz del repo de Tyrian:

```sh
# nombres distintos y usos de cada uno
grep -o 'var(--[a-zA-Z0-9_-]*' styles.css | sed 's/var(//' | sort | uniq -c | sort -rn
# nombres distintos
grep -o 'var(--[a-zA-Z0-9_-]*' styles.css | sort -u | wc -l          # 49
# variables propias que se DEFINEN en styles.css
grep -n -e '--tyrian-[a-z-]*[[:space:]]*:' styles.css
# variables propias que pone el TS en el atributo style
grep -rn -e '--tyrian-figures:' -e '--from:' -e '--at:' src/ui --include='*.ts' | grep -v '\.test\.'
```

Resultado: **49 nombres, 707 usos** (`grep` cuenta los mismos 707 con y sin comentarios: ningún comentario contiene `var(`).

**Propias de Tyrian: 5 nombres, 6 usos.** No hay que mapearlas.

| Variable | Usos | Dónde se define |
| --- | --- | --- |
| `--tyrian-action-mark` | 1 (`border-inline-start` de `.tyrian-action`) | `styles.css:2330-2334`, `2669-2681` (color de la marca por `data-action`) |
| `--tyrian-figures` | 1 (`grid-template-columns`) | atributo `style` en `src/ui/session-card.ts:193` y `src/ui/sale-view.ts:166`; respaldo `3` en `styles.css:86` |
| `--from`, `--to` | 2 + 1 (`left`, `width` de `.tyrian-sale__bar`) | atributo `style` en `src/ui/sale-view.ts:201` |
| `--at` | 1 (`left` de `.tyrian-sale__today`) | atributo `style` en `src/ui/sale-view.ts:205` |

**No propias: 44 nombres, 701 usos.** De ellas:

- **43 las define Obsidian 1.14.2** (700 usos).
- **`--font-weight-bold` no la define nadie**: 0 apariciones en el `app.css` de Obsidian 1.14.2 y 0 en Tyrian. Su único uso (`styles.css:1696`, `font-weight: var(--font-weight-bold, 600)`) cae siempre al respaldo `600`, en Obsidian y en Hebra. No hace falta mapearla.

La cifra de la spec (44) coincide si se cuenta `--font-weight-bold`. La de la tarea de Lumbre (45) no se reproduce sobre `eeef248`.

Aislamiento: los **622 selectores** de `styles.css` llevan todos `tyrian` o `.tc-` (0 sin prefijo, medido con un recorrido de los bloques sin comentarios). Hebra puede cargar el fichero global sin que toque su propia UI.

## 2. Lado Hebra (medido en `ac30bf0e`)

- **Tokens de aplicación**: `src/app.css:13-167` (tipografía `--type-ui-*`/`--type-doc-*`, espacio `--space-*`, radios `--radius-*`, estados `--state-hover`/`--state-pressed`, velos, dianas `--hit-*`).
- **Tokens de color y familias**: `src/lib/themes/generated/themes.css` y `themes/*.css`, generados por `scripts/build-themes.mjs`. 16 temas × 2 modos = 32 bloques, los 32 con las mismas 61 claves. Por eso la tabla nombra tokens y no valores: claro y oscuro son el MISMO token, que cada tema resuelve en `[data-mode]`. `:root` lleva los valores de noctiluna oscuro.
- **Hebra no define ninguna de las 44 variables** (0 coincidencias exactas en `src/` y `static/`; `--radius-s/m/l` solo casaban como prefijo de `--radius-sm/md/lg`). Hoy, sin el bloque del §5, todas caerían a su valor inicial.
- **Hebra no tiene tokens de peso ni de interlineado**: los escribe como literales (`font-weight: 600` 84 veces, `700` 22, `650` 13, `500` 11, `400` 3; `line-height` entre `1` y `1.5`).
- **`button` va reseteado** (`src/app.css:289-294`: sin borde ni fondo) y el foco global es `outline: 2px solid var(--focus)` (`src/app.css:303-311`). Los botones de Tyrian dependen de los estilos globales de elemento de Obsidian (ver §6).

Huecos donde Hebra monta contenido de Tyrian (las variables se heredan, basta con declararlas en el contenedor):

| Hueco | Selector | Dónde nace | Superficie de fondo |
| --- | --- | --- | --- |
| Pestaña del inspector (`placement: 'column'`, 288 px) | `.lv1-context-module-el` | `src/lib/library-ui/LibraryContextPanel.svelte:771` | `--panel` (`.lv1-context`, línea 795) |
| Diálogo de vista (`placement: 'dialog'`, 928 px) | `.hebra-module-view-content` | `src/lib/modules/ModuleViewSlot.svelte:65` | `--panel` (línea 77) |
| `ui.openModal` | `.hebra-module-modal-content` | `src/lib/modules/host-ui.ts:335` | `--panel` (`src/app.css:8447`) |
| `ui.settingsPanel` | `.lv1-modules-panel[data-module-panel]` | `src/lib/library-ui/LibrarySettingsModules.svelte:97` | `--panel` (`.lv1-settings-card`, `LibrarySettings.svelte:1084`) |
| `ui.registerCodeBlock` (dentro de la nota) | `.cm-hebra-module-code-block` | `src/lib/editor/module-code-blocks.ts:72`; estilo en `src/app.css:8515` | `--paper` (la hoja del editor) |

`.lv1-context-module-el` y `.lv1-modules-panel` son clases de componentes Svelte con estilo acotado, pero el nombre de clase sigue en el DOM: un selector global de `app.css` las alcanza.

## 3. Tabla de equivalencias

Criterio: **por rol, no por valor**. Una fila es «directo» si Hebra tiene un token con ese rol; «sin equivalente directo» si no lo tiene, con la propuesta y el motivo. Resultado: **31 directas, 12 sin equivalente directo, 1 que no es de Obsidian**.

Los usos son `propiedad×n` medidos sobre `styles.css` (script de §7). «otro» = declaraciones en una sola línea o valores partidos en varias líneas.

### Superficies y bordes

| Variable de Obsidian | Rol | Usos en Tyrian | Obsidian claro / oscuro | Token de Hebra | Notas |
| --- | --- | --- | --- | --- | --- |
| `--background-primary` | fondo de la vista | 12: background×7, fill×2, stroke×2, border×1 | `#ffffff` / `#1c1c1c` | `--panel` | Directo. Es la superficie de los cinco huecos salvo el bloque de código, que va sobre `--paper` (override en §5). |
| `--background-secondary` | superficie de tarjeta o sección dentro de la vista | 18: background×18 | `#f6f6f6` / `#282828` | `--paper` | Directo. En Obsidian claro la tarjeta se hunde (más oscura) y en oscuro se eleva; en Hebra `--paper` es siempre la superficie elevada (`docs/formato-tema-intercambio.md`: `surfaceRaised`). En el bloque de código: `color-mix(in srgb, var(--panel) 82%, var(--paper))`, la misma derivación que el bloque de código de Hebra (`src/app.css:2937`). |
| `--background-modifier-border` | filete y borde | 61: border×25, border-block-end×16, border-block-start×7, border-block×4, border-inline-start×3, border-top×2, otros×4 | `#e4e4e4` / `#333333` | `--line` | Directo. No `--soft-line`: 3 de los `border` son de controles (`.tyrian-product-settings__nav button`, `.tyrian-price-chart__reset`, `.tyrian-inventory-advisor__recommendation-action`) y Hebra bordea sus controles con `--line`. La maqueta aprobada del inspector usa `--soft-line` en sus tablas y tarjetas de Tyrian simulado: si la comparación a 288 px pesa demasiado, el ajuste es esta línea. |
| `--background-modifier-hover` | estado hover | 3: background×3 | negro 6,7 % / blanco 6,7 % (`color-mix` oklch) | `--state-hover` | Directo. Mismo patrón: tinta al 6 % sobre la superficie. |
| `--background-modifier-error` | fondo de estado de error | 3: background×3 | `#e93147` / `#fb464c` (rojo sólido) | `--danger-soft` | Directo por rol, no por valor. En Obsidian es rojo sólido y Tyrian escribe texto rojo encima (`.tyrian-action-panel__feedback[data-tone="error"]`, `styles.css:557-559`): rojo sobre rojo. En Hebra `--danger-ink` sobre `--danger-soft` da ≥ 5,33:1 en los 32 bloques. |

### Texto y acento

| Variable de Obsidian | Rol | Usos en Tyrian | Obsidian claro / oscuro | Token de Hebra | Notas |
| --- | --- | --- | --- | --- | --- |
| `--text-normal` | texto principal | 20: color×13, otros×5, border-color×1, background×1 | `#222222` / `#dadada` | `--ink` | Directo. `--ink` es el texto de interfaz; `--body` es el del documento. |
| `--text-muted` | texto secundario | 92: color×83, otros×5, border×2, stroke×1, fill×1 | `#5c5c5c` / `#b3b3b3` | `--muted` | Directo. Sobre `--paper` también llega: ≥ 5,13:1 medido, no hace falta `--muted-on-raised`. |
| `--text-faint` | texto terciario, trazos tenues | 5: stroke×2, color×1, border-inline-start×1, otros×1 | `#ababab` / `#666666` | `--quiet` | Directo. `--quiet` es AA en Hebra (≥ 4,78:1) y el `faint` de Obsidian no: aquí casi no se distingue de `--muted` (1,07 a 1,40:1 entre sí). Las marcas `none` y `deposit` se siguen distinguiendo por la palabra y el filete discontinuo. |
| `--text-accent` | acento como texto o trazo | 4: stroke×2, border-inline-start×1, otros×1 | `hsl(258 88% 66%)` / `hsl(255 89,76% 75,9%)` | `--accent-text` | Directo. |
| `--text-on-accent` | texto sobre relleno de acento | 1: color×1 | `white` / `white` | `--on-accent` | Directo. Su único uso es el botón pulsado de `.tyrian-price-chart__window-group`, que va con el override de §5. |
| `--interactive-accent` | acento interactivo (en Obsidian: relleno, anillo y trazo a la vez) | 27: outline×11, border-color×3, otros×3, stroke×2, fill×2, background×2, box-shadow×2, border-block-end-color×1, border×1 | `hsl(257 88,88% 70,95%)` / `hsl(258 88% 66%)` | `--accent-text` | **Sin equivalente directo.** Hebra reparte ese rol en tres: relleno (`--accent`), acento de primer plano (`--accent-text`) y anillo de foco (`--focus`). Tyrian lo usa 25 de 27 veces como línea (11 anillos de foco, trazos del gráfico, bordes de seleccionado). Con `--accent` esas líneas se quedan por debajo de 3:1 en 12 de 32 bloques (1,40:1 en neon claro); con `--accent-text` dan ≥ 5,19:1 en los 32. El único relleno con texto encima (el botón pulsado de la ventana de tiempo) vuelve a `--accent` con el override de §5. |
| `--text-error` | texto de error | 13: color×8, otros×3, border-inline-start×2 | `#e93147` / `#fb464c` | `--danger-ink` | Directo. Hebra pinta el texto de estado con `*-ink` (74 usos de `color: var(--danger-ink)` frente a 16 de `--danger`). |
| `--text-warning` | texto de aviso | 6: color×3, border×2, background×1 | `#ec7500` / `#e9973f` | `--warning-ink` | Directo. |
| `--text-success` | texto de éxito | 4: color×3, otros×1 | `#08b94e` / `#44cf6e` | `--success-ink` | Directo. |

### Colores con nombre (marcas de acción y avisos)

Obsidian define `--text-warning` como `var(--color-orange)` y `--text-success` como `var(--color-green)`. Hebra no tiene paleta categórica (azul, amarillo, morado): solo acento y estados.

| Variable de Obsidian | Rol en Tyrian | Usos en Tyrian | Obsidian claro / oscuro | Token de Hebra | Notas |
| --- | --- | --- | --- | --- | --- |
| `--color-green` | marca de acción positiva (`list`, `sell`) | 2: `--tyrian-action-mark`×2 | `#08b94e` / `#44cf6e` | `--success` | Directo: marca de estado positivo, como el punto `ok` de la maqueta del inspector. `--success` sobre `--panel` ≥ 4,50:1. |
| `--color-orange` | acento de aviso (3 filetes) y 1 texto (`.tyrian-sale__quote[data-state="stale"] .is-small`) | 4: border-inline-start×2, border-color×1, color×1 | `#ec7500` / `#e9973f` | `--warning-ink` | Directo. `--warning-ink` y no `--warning` por el uso como texto: `--warning` sobre `--panel` baja a 3,63:1 en 15 temas claros; `--warning-ink` da ≥ 4,99:1. Queda igual a `--text-warning`, como en Obsidian. |
| `--color-yellow` | marca de acción `vendor` | 1 | `#e0ac00` / `#e0de71` | `--warning` | **Sin equivalente directo** (color de categoría). Es el tono ámbar más cercano y como filete de 4 px pasa 3:1 en los 32 bloques (mín. 3,63:1). |
| `--color-purple` | marca de acción `use` | 1 | `#7852ee` / `#a882ff` | `--accent-text` | **Sin equivalente directo** (color de categoría). `--accent-text` y no `--accent` por lo mismo que `--interactive-accent`: es un filete. Solo es morado en los temas de acento violeta. |
| `--color-blue` | marca de acción `salvage` | 1 | `#086ddd` / `#027aff` | `--link` | **Sin equivalente directo** (color de categoría). `--link` pasa 3:1 como filete (≥ 4,90:1), pero en noctiluna oscuro es casi el mismo violeta que `--accent-text` (`#c7b8ff` frente a `#b8a6f2`): `salvage` y `use` no se distinguen por el color. La palabra siempre va (`styles.css:2653`, «el color nunca va solo en el texto»). Si hace falta distinguirlas por color, es una paleta categórica que Hebra no tiene: decisión de Hebra, no de este mapeo. |

### Tipografía

| Variable de Obsidian | Rol | Usos en Tyrian | Obsidian | Token de Hebra | Notas |
| --- | --- | --- | --- | --- | --- |
| `--font-ui-smaller` | metadatos, chips | 35: font-size×34, otros×1 | 12px | `--type-ui-sm` (12px) | Directo. |
| `--font-ui-small` | interfaz por defecto | 5: font-size×5 | 13px | `--type-ui-md` (13px) | Directo. |
| `--font-ui-medium` | cabecera de sección | 2: font-size×1, otros×1 | 15px | `--type-ui-lg` (15px) | Directo («cabeceras de panel»). |
| `--font-ui-large` | cifra destacada, título de la tarjeta principal | 4: font-size×4 | 20px | `--type-ui-lg` (15px) | **Sin equivalente directo.** La escala de interfaz de Hebra acaba en 15px y lo siguiente es tipografía de documento. En la columna de 288 px, tres cifras de 20px en `.tyrian-companion-session__figures` (3 columnas de ~90 px) arriesgan desbordar. Se pierde el salto entre la cabecera y la cifra; se mide en la comparación a 288 px. |
| `--font-small` | texto secundario pequeño | 6: font-size×5, font×1 | `0.933em` | `--type-ui-sm` (12px) | Directo por rol, pasa de `em` a `rem`. El inspector pone `font-size: var(--type-ui-sm)` en su raíz, así que `0.933em` darían 11,2px. |
| `--font-smallest` | etiqueta mínima (badges, `dt`, cabeceras de grupo) | 5: font-size×5 | `0.8em` | `--type-ui-xs` (11px) | Directo por rol («mínimo absoluto: kbd, timestamps, badges»). Con `0.8em` sobre los 12px del inspector saldrían 9,6px, por debajo del mínimo de 11px de Hebra. |
| `--font-monospace` | cifras y rutas en monoespaciada | 4: font-family×3, font×1 | pila `ui-monospace, SFMono-Regular, …` | `--mono` | Directo. |
| `--font-normal` | peso normal | 4: font-weight×4 | 400 | `400` | **Sin equivalente directo**: Hebra no tiene tokens de peso y escribe el literal. Queda el literal, el mismo número que usa Hebra. |
| `--font-medium` | peso medio | 11: font-weight×9, otros×2 | 500 | `500` | **Sin equivalente directo**, igual que el anterior. |
| `--font-semibold` | peso de etiqueta y cifra | 29: font-weight×29 | 600 | `600` | **Sin equivalente directo**, igual. `600` es el peso de etiqueta de Hebra (pestañas del inspector, `.ty-status b` de la maqueta). |
| `--font-weight-bold` | (no es de Obsidian) | 1: font-weight×1 | no definida | no se mapea | Cae a su respaldo `600` en los dos hosts. |
| `--line-height-normal` | interlineado de texto corrido | 1: line-height×1 | 1.5 | `1.5` | **Sin equivalente directo**: Hebra no tiene tokens de interlineado. |
| `--line-height-tight` | interlineado de cifras y títulos | 5: line-height×5 | 1.3 | `1.3` | **Sin equivalente directo**, igual. |

### Espacio, radios y controles

| Variable de Obsidian | Rol | Usos en Tyrian | Obsidian | Token de Hebra | Notas |
| --- | --- | --- | --- | --- | --- |
| `--size-4-1` | paso de 4 | 45: gap×29, margin/padding×16 | 4px | `--space-1` (0.25rem) | Directo. |
| `--size-4-2` | paso de 8 | 113: gap×45, padding×36, margin×16, otros×16 | 8px | `--space-2` | Directo. |
| `--size-4-3` | paso de 12 | 76: padding×29, gap×28, margin×11, otros×8 | 12px | `--space-3` | Directo. |
| `--size-4-4` | paso de 16 | 32: padding×9, margin×14, gap×4, otros×5 | 16px | `--space-4` | Directo. |
| `--size-4-5` | paso de 20 | 2: margin-block×2 | 20px | `--space-5` | Directo. |
| `--size-4-8` | paso de 32 | 1: max-height×1 | 32px | `--space-8` | Directo. |
| `--size-2-2` | paso fino de 4 | 7: margin-top×2, gap×2, otros×3 | 4px | `--space-1` | Directo. |
| `--size-2-1` | paso fino de 2 | 2: inset-block-start×1, inset-inline-end×1 | 2px | `calc(var(--space-1) / 2)` | **Sin equivalente directo**: la escala de Hebra empieza en 4px. Mitad del primer paso. Solo lo usa el punto de pendiente del ribbon (`.tyrian-companion-ribbon--pending::after`); en Hebra el ribbon lo pinta `ModuleRibbon.svelte`, así que puede quedar inerte (no medido si HebraHost pone esa clase). |
| `--radius-s` | radio de control y chip | 22: border-radius×22 | 4px | `--radius-sm` (6px) | Directo. |
| `--radius-m` | radio de tarjeta y aviso | 7: border-radius×7 | 8px | `--radius-md` (10px) | Directo. |
| `--radius-l` | radio de contenedor grande | 3: border-radius×3 | 12px | `--radius-md` (10px) | **Sin equivalente directo.** `--radius-lg` (20px) está reservado a hojas grandes flotantes (`src/app.css`, comentario de radios). Los tres usos son un panel pegado dentro de la vista, una tarjeta y un botón (`.tyrian-inventory-advisor__recommendation-action`): ninguno es una hoja. |
| `--input-height` | alto de control | 1: height×1 | 30px | `--hit-pointer` (32px) | Directo («área táctil mínima por tipo de puntero»). |

## 4. Contraste de los pares resultantes

Medido en los 32 bloques (16 temas × 2 modos) con la fórmula WCAG sobre los hex de `themes.css` y `themes/*.css`. Mínimo y bloque donde se da.

| Par (primer plano / fondo) | Qué pinta | Mínimo | Umbral | Resultado |
| --- | --- | --- | --- | --- |
| `--ink` / `--panel` | texto normal | 8,90 (tokyo-night claro) | 4,5 | pasa en 32 |
| `--muted` / `--panel` | texto secundario | 4,82 (noctiluna claro) | 4,5 | pasa en 32 |
| `--muted` / `--paper` | texto secundario sobre tarjeta | 5,13 (noctiluna claro) | 4,5 | pasa en 32 |
| `--quiet` / `--panel` | texto terciario | 4,78 (tokyo-night claro) | 3 | pasa en 32 |
| `--accent-text` / `--panel` | anillos, trazos, marca `use` | 5,19 (aquelarre claro) | 3 | pasa en 32 |
| `--accent` / `--panel` | (descartado para líneas) | 1,40 (neon claro) | 3 | falla en 12 |
| `--danger-ink` / `--panel` | texto de error | 6,05 | 4,5 | pasa en 32 |
| `--warning-ink` / `--panel` | texto de aviso | 4,99 | 4,5 | pasa en 32 |
| `--success-ink` / `--panel` | texto de éxito | 5,44 | 4,5 | pasa en 32 |
| `--warning` / `--panel` | (descartado para `--color-orange`) | 3,63 | 4,5 | falla en 15 claros |
| `--success` / `--panel` | marca `list`/`sell` | 4,50 | 3 | pasa en 32 |
| `--link` / `--panel` | marca `salvage` | 4,90 | 3 | pasa en 32 |
| `--danger-ink` / `--danger-soft` | texto de error sobre fondo de error | 5,33 | 4,5 | pasa en 32 |
| `--on-accent` / `--accent` | botón pulsado (override de §5) | 4,77 (niebla oscuro) | 4,5 | pasa en 32 |
| `--on-accent` / `--accent-text` | (por eso el override) | 2,16 (niebla oscuro) | 4,5 | falla en 14 |
| `--warning-ink` / `--danger-soft` | `.tyrian-companion-settings__diagnostic-status[role="alert"]` | 4,16 (gruvbox claro) | 4,5 | **falla en 15 claros** |

El último par no lo arregla el mapeo: es Tyrian quien pone texto de aviso (`--text-warning`) sobre fondo de error (`styles.css:2616-2619`). El arreglo es de Tyrian (usar `--text-error` en esa regla, o fondo de aviso), fuera de este lote.

## 5. Bloque CSS para Hebra

Para pegar en `src/app.css` de Hebra. Solo tokens de Hebra, salvo los cinco literales marcados (pesos e interlineados: Hebra no tiene tokens para ellos). Selectores reales de los cinco huecos del §2.

```css
/* Tyrian Companion en Hebra: variables de Obsidian que usa su styles.css,
   resueltas a tokens de Hebra por rol. Tabla y motivos:
   tyrian-companion/docs/HEBRA-CSS-VARIABLES.md */
.lv1-context-module-el,
.hebra-module-view-content,
.hebra-module-modal-content,
.lv1-modules-panel[data-module-panel],
.cm-hebra-module-code-block {
  /* superficies y bordes */
  --background-primary: var(--panel);
  --background-secondary: var(--paper);
  --background-modifier-border: var(--line);
  --background-modifier-hover: var(--state-hover);
  --background-modifier-error: var(--danger-soft);
  /* texto y acento */
  --text-normal: var(--ink);
  --text-muted: var(--muted);
  --text-faint: var(--quiet);
  --text-accent: var(--accent-text);
  --text-on-accent: var(--on-accent);
  --text-error: var(--danger-ink);
  --text-warning: var(--warning-ink);
  --text-success: var(--success-ink);
  --interactive-accent: var(--accent-text); /* sin equivalente directo: rol partido en Hebra */
  /* colores con nombre */
  --color-green: var(--success);
  --color-orange: var(--warning-ink);
  --color-yellow: var(--warning); /* sin equivalente directo: color de categoría */
  --color-purple: var(--accent-text); /* sin equivalente directo: color de categoría */
  --color-blue: var(--link); /* sin equivalente directo: color de categoría */
  /* tipografía */
  --font-ui-smaller: var(--type-ui-sm);
  --font-ui-small: var(--type-ui-md);
  --font-ui-medium: var(--type-ui-lg);
  --font-ui-large: var(--type-ui-lg); /* sin equivalente directo: la escala de interfaz acaba en 15px */
  --font-small: var(--type-ui-sm);
  --font-smallest: var(--type-ui-xs);
  --font-monospace: var(--mono);
  --font-normal: 400; /* literal: Hebra no tiene tokens de peso */
  --font-medium: 500; /* literal */
  --font-semibold: 600; /* literal */
  --line-height-normal: 1.5; /* literal: Hebra no tiene tokens de interlineado */
  --line-height-tight: 1.3; /* literal */
  /* espacio */
  --size-2-1: calc(var(--space-1) / 2); /* sin equivalente directo: no hay paso de 2px */
  --size-2-2: var(--space-1);
  --size-4-1: var(--space-1);
  --size-4-2: var(--space-2);
  --size-4-3: var(--space-3);
  --size-4-4: var(--space-4);
  --size-4-5: var(--space-5);
  --size-4-8: var(--space-8);
  /* radios y controles */
  --radius-s: var(--radius-sm);
  --radius-m: var(--radius-md);
  --radius-l: var(--radius-md); /* sin equivalente directo: --radius-lg es de hojas flotantes */
  --input-height: var(--hit-pointer);
}

/* Dentro de la nota el bloque va sobre la hoja (--paper), no sobre --panel. La
   tarjeta usa la misma superficie que el bloque de código de Hebra (app.css:2937). */
.markdown-editor .cm-hebra-module-code-block {
  --background-primary: var(--paper);
  --background-secondary: color-mix(in srgb, var(--panel) 82%, var(--paper));
}

/* Único relleno de acento con texto encima (botón pulsado de la ventana de tiempo,
   styles.css:1752-1756): aquí el acento es RELLENO, no línea. --on-accent sobre
   --accent >= 4,77:1 en los 32 bloques; sobre --accent-text bajaría a 2,16:1. */
.tyrian-price-chart__window-group {
  --interactive-accent: var(--accent);
}
```

Los botones de esa ventana de tiempo no tienen anillo propio en `styles.css` (el de la línea 1761 es de `.tyrian-price-chart__range input`), así que el override no toca ningún foco: les queda el global de Hebra con `--focus`.

## 6. Clases de Obsidian que usa la UI de Tyrian

Medido sobre `styles.css` (selectores sin comentarios) y los literales de clase de `src/**/*.ts` sin tests (`cls:`, `addClass`, `className`, `classList`). Se cuentan también las reglas que tiene cada clase en el `app.css` de Obsidian 1.14.2, para separar las de Obsidian de las propias de Tyrian con nombre genérico.

### Las que Hebra tiene que estilar

| Clase | Dónde en Tyrian | Rol en Obsidian | Patrón de Hebra a reutilizar |
| --- | --- | --- | --- |
| `mod-cta` | `companion-view.ts` (8), `settings-tab.ts` (2), `product-shell.ts:68`, `inventory-advisor-view.ts:504`, `session-card.ts:151`; y `TyrianButtonControl.setCta()` del puerto | botón principal: relleno `--interactive-accent`, texto `--text-on-accent` | `.dialog-actions button.primary` (`src/app.css:4819`): `--violet` / `--violet-ink` |
| `mod-warning` | `settings-tab.ts` (10), `companion-view.ts` (4), `product-shell.ts:187` | botón destructivo: relleno `--background-modifier-error`, texto blanco | en la hilera de un modal, `.dialog-actions button.primary.danger` (`src/app.css:4843`); suelto, `.danger-action` (`src/app.css:4246`) |
| `modal-button-container` | `settings-tab.ts` (7 modales, líneas 1478-1692); los 5 de `companion-view.ts` usan su propia `tyrian-companion-view__session-actions` | hilera de botones al pie del modal, a la derecha, `gap: --size-4-2` | `.dialog-actions` (`src/app.css:4804`) |
| `clickable-icon` | `product-shell.ts:56` (ajustes), `inventory-advisor-view.ts:546` (copiar) | botón solo-icono, sin fondo | `.icon-button` (`src/app.css:469`) |
| `svg-icon` | `receipt.ts:33`, `inventory-advisor-view.ts:1410`; 4 selectores en `styles.css` | clase del `<svg>` que pone `setIcon`; su tamaño sale de `--icon-size` | que el `setIcon` de HebraHost ponga `svg-icon` en el `<svg>` para que casen los 4 selectores |
| `callout`, `callout-title`, `callout-title-inner`, `callout-content` | `session-card.ts:228-243`, `data-callout` = `warning` o `error`; 4 selectores en `styles.css:249-317` | callout nativo con su color por tipo | los tonos de callout de Hebra: `warning` como `.cm-hebra-callout-warning` (`src/app.css:2861`) y `error` como `.cm-hebra-callout-caution` (`src/app.css:2865`), con `--hebra-callout-accent` y `--hebra-callout-surface` |
| `setting-item`, `setting-item-info`, `setting-item-name`, `setting-item-description`, `setting-item-control` | los construye `host.ui.setting()`; `styles.css:592`, `1176-1177` | fila de ajuste: nombre y descripción a la izquierda, control a la derecha | **no es solo estilo**: `settings-tab.ts:334` busca `.setting-item-description` dentro de la fila para pintar el estado de guardado. La fila de HebraHost tiene que dar esas clases a `settingEl`, `descEl` y `controlEl` |
| `is-mobile` | `styles.css:2043` (diana del `summary` en móvil) | clase del `body` en móvil | poner `is-mobile` en la raíz del hueco en la hoja de iPhone, o aceptar que ese ajuste no se aplica |

### Elementos nativos que en Obsidian vienen estilados

Obsidian estila `button`, `select`, `input` y compañía de forma global; Hebra resetea `button` (`src/app.css:289-294`). Sin reglas acotadas al hueco, los botones de Tyrian se ven como texto suelto. Medido en `src/ui` y `src/runtime` (`createEl('…')` y `createElement`, sin tests):

| Elemento | Veces | Patrón de Hebra |
| --- | --- | --- |
| `button` | 61 | `.lv1-context-retry` (`LibraryContextPanel.svelte:1043`): `--hit-pointer`, `--radius-sm`, borde `--line`, `--ink`, `--type-ui-sm`, peso 600; en modal, `.dialog-actions button` (`src/app.css:4810`) |
| `details` / `summary` | 14 / 14 | foco ya global (`src/app.css:303-311`) |
| `label` | 14 | |
| `input` | 12 | |
| `select` | 7 | |
| `table` | 6 | la tabla de la maqueta del inspector (`.ty-tbl`, `design/inspector-2026-09-28/index.html:291-298`) |
| `fieldset` | 2 | |
| `progress` | 1 | |

### Las que parecen de Obsidian y no lo son

0 reglas en el `app.css` de Obsidian 1.14.2: `mod-link` (3 ficheros de `src/ui`), `is-small`, `is-num`, `is-wide`, `is-read`, `is-deviation`, `c-item`, `c-qty`, `c-action`, `c-money`, `c-keep` y las nueve `price-*` del gráfico. Son de Tyrian o no hacen nada. `mod-link` tampoco tiene regla en `styles.css`: en Obsidian ya se pinta como un botón normal, y en Hebra le basta la regla de `button`.

## 7. Cómo se ha medido y qué queda sin medir

- Usos por propiedad: un recorrido línea a línea de `styles.css` sin comentarios, que por cada `var(--x)` anota la propiedad de su línea. Mismo total que el `grep` del §1 (707).
- Valores de Obsidian: `app.css` sacado del asar 1.14.2. Un `.asar` es una cabecera JSON (tamaño en el byte 12, datos desde `8 + uint32 del byte 4`) seguida de los ficheros; se leyó solo `app.css` y se tomaron los bloques `body`, `.theme-light` y `.theme-dark`. No es el tema del usuario: un tema o snippet de la comunidad cambia esos valores.
- Contraste: fórmula WCAG 2.x sobre los hex de los 32 bloques de Hebra.
- **Sin medir**: cómo se ve de verdad. No se ha cargado `styles.css` en Hebra con este bloque; la comparación visual a 288 px (columna), 361 (hoja de iPhone) y 928 (diálogo) es el paso siguiente de R1c. Tampoco se ha medido el tamaño de letra de la raíz de una vista de Obsidian, del que dependen `--font-small` y `--font-smallest` allí.
