# ADR 0005 — Política shadow de presencia y ausencia H8.8

## Estado

Implementación pura y aislada, `@wip`. No autoriza composición, salida de shadow ni release.

## Contexto

H8.6 proyecta en memoria el mapa y la actividad de records ya autenticados y secuenciados, pero esa
señal local no es evidencia API ni puede operar el lifecycle. H8.8 necesita medir si esa proyección
podría acotar ventanas de presencia/ausencia sin convertir una pérdida de canal, un tick parado o un
recovery en una decisión de producto.

## Decisión

- El único target es el mapa oficial `866`, **Mad King's Labyrinth / Laberinto del Rey Loco**.
- Presencia requiere 5.000 ms de crédito aceptado en el target con autoridad idle. Ausencia requiere
  60.000 ms de crédito aceptado fuera del target con una sesión ligada. Cada record puede aportar
  como máximo los 500 ms nominales de H8.4 y no permite catch-up. Gaps, heartbeat/source degradation,
  `link_stalled`, pérdida de canal y recovery reinician o degradan la ventana y nunca cuentan como
  ausencia.
- Cada latch puede materializar como máximo un DTO efímero. Repetir el mismo estado no lo reemite.
- `accountId` forma parte del contexto efímero de la señal tanto en idle como durante una sesión.
  Un cambio de cuenta reinicia ventana y latch; la identidad no se inyecta después mediante una
  factory separada.
- El DTO declara evidencia `limited` y review `human_required`. Vive solo en memoria y no es una
  propuesta H5.3: no se encola, persiste, muestra ni entrega a captura o lifecycle de sesión.
- La API v1 continúa siendo autoritativa. Una discrepancia local degrada el contraste shadow y no
  corrige snapshots ni inicia o termina sesiones.

## Consecuencias

El reducer recibe el instante como dato inyectado y puede probarse sin reloj ambiente, red,
filesystem, stores, UI ni autoridad de sesión.
La fase no añade launcher, executor, settings, autoarranque o composición desde `main`.

Antes de valorar cualquier salida de shadow hacen falta composición revisada, métricas comparativas
y QA humana en Windows, Linux/Steam/Proton y macOS/CrossOver. La matriz debe cubrir al menos entrada
y salida del mapa, gaps, heartbeat/source unavailable, `link_stalled`, recovery, sleep y falsos
positivos/negativos de ambos umbrales.
