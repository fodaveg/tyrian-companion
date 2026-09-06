# SPEC: paneles de sesión e inventario sin prosa

Decidido por David el 6 sep 2026 sobre dos capturas de la 0.1.28. Es un cambio de PRESENTACIÓN:
no se elimina ninguna función, comando, transición de estado ni hook de instrumentación (la
detección asistida y las métricas del piloto H7.13 se quedan y tienen que seguir funcionando).
Cambia qué se pinta, en qué orden y con cuánta prosa. Toda frase que sea una garantía del
contrato («no lee la cuenta», «no escribe notas», «todas las acciones son manuales», «no usa la
clave API», «los iconos se cargan del CDN oficial») sale de la pantalla: va una vez a
`docs/PRODUCT.md` o al `title` (tooltip) del control.

Ficheros: `src/ui/product-shell.ts`, `src/ui/companion-view.ts`, `src/ui/inventory-advisor-view.ts`,
`src/ui/inventory-advisor-item-view.ts`, `src/ui/price-history-panel-view.ts`, `styles.css`,
`src/core/i18n.ts`, `src/core/i18n-runtime-catalog.ts` y los tests que aseveren sobre ellos.
`src/ui/settings-tab.ts` NO se toca (lo rehace otro lote).

## Diagnóstico medido

Vista de sesión sin sesión activa: cabecera del producto (eyebrow, h1, subtítulo, 3 pestañas);
«Resumen de la sesión» con cuatro formas de decir «no hay sesión» («Rinopopo · Resumen guardado»,
«Calidad: Limitada · Revisada · Estimada», «0g 0s 0c», «El resumen guardado no contiene
ganancias»); «Detección del saco #36038» con 3 líneas de explicación, 2 contadores, 3 tarjetas
monoespaciadas, 2 párrafos sobre la caché, «Desactivada» dos veces, botón y otra instrucción;
bloque Halloween fuera de temporada; tarjeta «Historial durable» con 2 párrafos. En pantalla:
2 números, 3 botones y 46 `createEl('p')` en `companion-view.ts`.

Vista de inventario: 7 líneas antes del primer control; «Inventario durable» repite el mismo dato
(1350 filas actualizadas) tres veces, pinta una `progress` al 100 % de una ejecución de hace dos
días y un timestamp ISO; «Histórico local de precios» ocupa un bloque para decir que no tiene
muestras; «Preferencias de inventario» duplica Ajustes; la lista de objetos del asesor empieza a
900 px de altura o no aparece.

## `product-shell.ts` (compartido)

`renderProductShell` monta SOLO una tira de 3 pestañas (Sesión · Inventario · Ajustes) de una
línea, `role="tablist"`, sin eyebrow, h1, subtítulo ni compás. El aviso «Falta vincular la clave
API» se queda como una fila compacta con su botón, solo cuando falte la clave. Del CSS salen
`.tyrian-product-shell__masthead`, `__compass`, `__eyebrow`, `__subtitle` y el grid `__workspace`
de dos columnas (la columna `actions` de 23 rem la ocupa un aside que nadie monta:
`mountActionPanel` no tiene consumidores fuera de tests; si ningún test lo importa, se retira con
su CSS).

## Vista de sesión (`companion-view.ts`)

| Estado | Se pinta |
|---|---|
| Sin sesión | Botón primario «Nueva sesión». Debajo, UNA línea con la última sesión guardada si existe: fecha, duración, oro neto, enlace a la nota. Nada más. |
| Sesión activa | Cabecera de una línea: personaje · inicio · duración. Un número grande: oro neto. Lista de ganancias (icono, nombre, cantidad, valor). Botón «Terminar sesión». Última y próxima consulta en UNA línea pequeña junto al número; la frase de la caché (5 a 10 min) como `title`. |
| Detección | Una fila: «Detección: apagada» + botón «Activar» (o «activa · próxima consulta 11:38» + «Desactivar»). Contadores y explicación del saco 36038 en un `<details>` plegado «Detalle de la detección». Los estados de propuesta (inicio/fin propuestos, confirmar/rechazar) siguen igual, en una fila con dos botones. |
| Halloween | Solo dentro de la ventana (`halloweenObservationActive` o equivalente) o con la ampliación manual. Una fila: bolsas contadas y valor. Fuera de temporada, nada. |
| Historial durable | Fuera de esta vista (ya está en Ajustes › Datos y soporte). El bloque y su CSS se retiran; la acción sigue como comando. |
| Calidad del resumen | Un badge pequeño junto al número, significado en `title`. |

## Vista de inventario (`inventory-advisor-view.ts`, `inventory-advisor-item-view.ts`)

| Zona | Se pinta |
|---|---|
| Barra superior (una línea, flex con wrap) | Buscar · Ordenar · «Filtros» como `<details>` plegado · botón secundario «Sincronizar» con «hace 2 días» al lado (relativa, ISO en `title`) · «Analizar sin escribir» en el mismo grupo. |
| Cuerpo | Tabla o tarjetas del asesor (`renderResults`, `renderTable`, `renderCards`) inmediatamente debajo de la barra. `advisor.view.state.loading` es una línea. |
| Pie | Última sincronización en UNA línea humana: «Sincronizado el 4 sep a las 16:29 · 1350 filas · 0 nuevas · 0 conflictos». `<details>` plegado con el desglose. La `progress` solo mientras la sincronización está en curso. El flujo `syncConfirm*` se queda, compacto. |
| Fuera | «Histórico local de precios» sale de esta vista (`price-history-panel-view.ts` sigue para la nota del objeto y el comando; si esta vista era su único punto de entrada, queda accesible por comando de paleta y se dice en la entrega). «Preferencias de inventario» sale (viven en Ajustes). Los párrafos `intro` e `iconDisclosure` salen. |

## CSS e i18n

Sin bloques huérfanos. Nada de `min-height: 44px` fuera de `.is-mobile`. Comprobar por grep que
toda clase usada en TS tiene regla y toda regla apunta a una clase viva. Claves nuevas en es y en;
las que queden sin uso se retiran. Fechas relativas con `Intl.RelativeTimeFormat`, absolutas con
`Intl.DateTimeFormat`, nunca `toISOString()` en pantalla.

## Landmines

- 34 tests leen el TEXTO FUENTE de otros `.ts` con `readFileSync`. Van a caer. Se actualizan para
  aseverar la estructura NUEVA; no se retiran ni se convierten en `expect(true)`; respetar
  `scripts/source-text-assertion-allowlist.json`.
- `scripts/action-observability-baseline.json` censa fronteras por `kind:line:column`. Se reindexa
  con `scripts/reindex-action-observability-baseline.mjs`, NUNCA con `--write-baseline`,
  con tabuladores, verificando que el conjunto de decisiones ignorando líneas es el mismo. Si
  desaparece una frontera, se dice en la entrega.
- `npm run lint` y `vitest` no tipan: `npx tsc --noEmit` aparte.
- Gate: `npm run check` y `npm test`, contando pasos contra `scripts/gate-steps.mjs`.

## Entrega

Rama y SHA. Ficheros con qué cambia cada uno. Recuento antes/después de `createEl('p')` en las dos
vistas. tsc, check y test con pasos ejecutados y veredicto literal. Qué queda fuera y por qué.
