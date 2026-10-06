# Ficha · Panel de farmeo y preparación

Mockup temporal: `/tmp/tyrian-halloween-panel-design.html` (puede no conservarse en otra máquina). Propuesta de componente, no implementación final. Tres pantallas ancla: panel en juego, objetivo/preparación en host y resumen al cerrar. Controles de demostración: ES/EN, tema sistema/claro/oscuro, objetivo sin/bolsas/tiempo. Todas las cifras son ficticias. No se consultó la cuenta. El contrato final de datos está en `docs/SPEC-puente-ingame.md`.

## Dirección y sistema

Evolución: sobria, legible, discreta. Reutiliza la jerarquía de la tarjeta de sesión y los tokens vivos de `styles.css`; Hebra conserva sus aliases de `docs/HEBRA-CSS-VARIABLES.md`. Referencia de color del prototipo: simulación de host de `docs/diseno/h18-31-interfaz/boceto.html`, no una nueva paleta productiva. No assets raster, no sombras, no fondos transparentes sobre el juego (el fondo de juego variable impide garantizar contraste). Se reducen cuatro ambigüedades: conectado≠midiendo, dato antiguo≠dato vivo, observado≠obtenido total, neto de cierre≠observado acumulado.

## Panel Nexus / Blish HUD

- Opcional, movible desde cabecera; ancho inicial 288 px, rango 250–320 px. Escalar con fuente/DPI del host. Nexus usa ventana ImGui y navegación existentes; Blish usa su panel y sus fuentes. No recrear el cromo del host desde el HTML.
- 12 px de padding, 8 px entre filas, separadores de 1 px del host. Texto base 13 px / 1,5, cifra principal 20 px / 1,3 / semibold, duración 15 px, meta 12 px. Son medidas de referencia de la escala existente; la accesibilidad/DPI del host prevalece.
- Orden estable: cabecera Tyrian·Laberinto; estado de medición; bolsas observadas + duración medida; banda bolsas/h + edad; huecos del personaje + edad; objetivo opcional + progreso + ETA; conexión al host.
- No truncar estado, edad, bolsas, objetivo o errores; envolver etiquetas. Nombre largo de personaje/build va al host; si se presenta, wrap, sin desplazar cifras fuera del panel. Espacio desconocido `—` con «Sin lectura»; cero es una observación conocida. Identidad inferida se etiqueta «Personaje reciente» y no se presenta como personaje confirmado.
- El tiempo se etiqueta «Duración / Duration»: el campo `elapsed` representa duración declarada de la sesión, no tiempo de botín observado. La captura del punto de partida y las observaciones de la API tienen sus propios límites de cobertura. No inferir pausa por ausencia de botín.
- Cada observación conserva su propia edad; un refresco del transporte no renueva inventario/bolsas. Si varias cifras comparten realmente observación, se puede usar una sola línea de antigüedad.
- Con datos antiguos: mantener último dato identificado, no presentarlo como ritmo actual; retirar ETA de bolsas. Las cifras no se desvanecen (deben seguir siendo legibles). La duración puede continuar solo si su contrato la acredita independientemente de la API.
- Sin botones de empezar/parar sesión. Visibilidad, posición y restablecer posición usan el menú/configuración del addon; no capturar teclado del juego para un panel solo lectura. Ocultar se revierte en ese menú.

## Estados y strings ES / EN

| Situación | ES | EN | Cifras |
|---|---|---|---|
| Offline sin lectura | Sin conexión | Offline | —, Sin lectura / No reading |
| Transporte conectado, sesión inactiva | Sin medición | Not measuring | —, Esperando sesión / Waiting for session |
| Inicio aún sin punto de partida | Preparando medición | Preparing measurement | —, Capturando el punto de partida / Capturing the starting point |
| Activa | Midiendo | Measuring | Bolsas observadas / Observed bags; Duración / Duration |
| Cierre | Terminando sesión | Finishing session | Última cifra provisional; Esperando la lectura final / Waiting for the final reading |
| Fallo de inicio | No se pudo empezar | Could not start | —; Revisa la sesión en Hebra u Obsidian / Check the session in Hebra or Obsidian |
| Fallo tras medir | No se pudo actualizar | Could not update | Última lectura, edad y cifra anterior |
| Caducidad | Datos antiguos | Stale data | Última lectura hace… / Last reading … ago |
| Ritmo insuficiente | Ritmo aún no disponible | Rate not available yet | —, no 0 |
| Espacio | Huecos del personaje | Character bag slots | 8 libres / 8 free + edad |
| Objetivo | Quedan aprox. … | Approx. … left | Intervalo cuando el modelo ofrece banda |
| Objetivo sin base de ETA | ETA aún no disponible | ETA not available yet | Progreso permanece |
| Objetivo cumplido | Objetivo alcanzado | Goal reached | Progreso llega a 100%; observaciones continúan |
| Host al cierre | Bolsas netas al cierre | Net bags at close | Segunda métrica independiente |

No confundir error de iniciar, actualizar o finalizar; usar el mensaje específico acreditado por el estado. Offline con una lectura anterior mantiene «Última lectura hace…» y no sustituye los datos por cero. Una pérdida de host no equivale a detener la sesión.

## Objetivo / preparación en Hebra y Obsidian

Reutilizar la tarjeta de sesión y `details/summary`, no crear otro dashboard. Padding y gap 16 px. Fieldset «Objetivo de esta tanda / Goal for this run» con sin objetivo, bolsas, duración. Defaults propuestos 1.000 bolsas / 60 minutos; si permite editar, etiqueta y entrada junto al tipo seleccionado, unidad explícita. La banda de progreso lleva texto numérico accesible, no solo relleno. Actualización inline; no toast por cada lectura.

Ejemplo: 248 / 1.000 bolsas; banda 480–560 bolsas/h; quedan aprox. 1 h 21–34 min. La estimación depende de la base suficiente/frescura resueltas por el modelo, nunca se fabrica en el addon. El especialista propone ≥3 observaciones, 20 min y antigüedad máxima 15 min: esa política pertenece al modelo, no a CSS. Duración: 28:36 / 60:00; quedan 31 min 24 s. Objetivo cero/no válido: error de campo junto al input, sin borrar valor anterior guardado. No dividir por cero ni anunciar objetivo alcanzado sin observación.

«Preparación opcional / Optional preparation» cerrado por defecto (abierto solo en lámina demostrativa). Lista: personaje/build; huecos + frescura; recolector; addon conectado; Hallazgo mágico / Magic Find. MF «Parcial / Partial» siempre que no certifique buffs temporales. Desglose observable/manual/desconocido; ausencia de bonus manual no significa 0. Caption: «Datos consultables + bonus manuales. Buffs temporales sin verificar.» / «Available account data + manual bonuses. Temporary buffs unverified.»

Comida/utilidad: «He revisado comida y utilidad / I checked food and utility» + «Recordatorio manual / Manual reminder». Si hay temporizador, opt-in e iniciado explícitamente, jamás simular buff leído. Ningún check bloquea inicio, observaciones ni cierre. A 250–320 px filas y opciones envuelven, al ancho mayor se alinean; no tablas con scroll horizontal.

Cierre conserva **dos métricas y etiquetas**: «Bolsas observadas» y «Bolsas netas al cierre». Nota breve en detalle o junto a la discrepancia: «El neto puede ser menor si abriste o gastaste bolsas. El total obtenido entre lecturas no se puede reconstruir.» No renombrar el neto «obtenidas» ni cambiar silenciosamente el contador observado. Objetivo de bolsas usa observadas y no retrocede al reemplazarlo por netas.

## Accesibilidad e interacción

Estados con palabra y forma; el color nunca es la única señal. Contraste medido sobre los valores simulados: texto normal claro 15,91:1 / oscuro 11,93:1; muted sobre papel 6,69:1 / 7,95:1; muted sobre panel 6,19:1 / 7,22:1; acento/foco sobre papel 4,74:1 / 6,05:1. Los temas reales del host requieren comprobación propia. Los separadores decorativos no representan estados ni límites de controles; controles llevan borde visible del token de texto secundario.

Host: Tab recorre grupo objetivo, entrada si aparece, preparación, checkboxes, recordatorios. Flechas dentro de radios; Espacio para marcar; Enter/Espacio en summary. Foco 2 px con offset 3 px según el host. Tamaño desktop del control 30 px según escala actual, touch mínimo 44 px solo en modo táctil. Progreso con nombre y valores accesibles. `role=status` solo para cambio de estado, no cada tic del cronómetro; errores inline persistentes, no alertas repetidas. Respeta reduced-motion; ningún pulso o animación necesario.

## Checklist de siete ejes

| Eje | Estado | Evidencia / límite |
|---|---|---|
| Tokens | Cubierto en propuesta | Reutiliza variables del host y escala existente; ratios calculados. No nuevos tokens de producto. |
| Componentes/estados | Cubierto en diseño | 7 variantes de estado + activa, objetivo ausente y de tiempo, cierre separado; estados de entrada descritos. Runtime pendiente. |
| Responsive por componente | Parcial | CSS wrap 250–320, host apilable y texto largo previstos; sin navegador instalado, medidas de render no verificadas. |
| Accesibilidad | Parcial | Ratios, foco, teclado, coarse44 y reduced-motion definidos; lector real y navegación ImGui/Blish pendientes. |
| Contenido/casos límite | Cubierto en diseño | Fixtures identificadas, sin identidad de cuenta; build sin nombre, desconocido≠0, antigüedad, estados y cifras que no retroceden por reconciliación. |
| Feedback | Cubierto en diseño | Errores persistentes y específicos, espera inicial/final, medición separada de conexión, sin toasts de refresco. |
| Assets | No aplicable | Reutilizar cromo/iconos nativos; no nuevos logos, raster, fuentes remotas ni CDN. |

Validado localmente: script inline parsea con Node; ocho pares de contraste calculados. Sin navegador instalado ni instalación solicitada: no se afirma screenshot/QA pixel. No fuentes de producto modificadas, no build ni suite ejecutadas.
