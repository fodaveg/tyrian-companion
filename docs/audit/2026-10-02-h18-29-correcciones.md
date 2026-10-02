# H18.29 — correcciones de historial y arranque, 2 oct 2026

Este lote continúa el [diagnóstico con sesiones reales](2026-10-02-h18-29-sesiones-reales.md).
Corrige los dos fallos reproducidos; no sustituye la QA restante de las pruebas 1–10 ni
acredita instalación, carga en Obsidian o funcionamiento dentro del juego.

## Cambios de producto

### El historial admite las pérdidas sin alterar las notas

El lector acepta enteros seguros con signo para netos monetarios y tasas de cobre.
Sacos, otras cantidades y duraciones conservan sus restricciones no negativas; se
mantiene la matriz de clasificación y cobertura. JSON y CSV preservan el signo, con la
protección de celdas CSV existente.

Las tasas ponderadas usan cociente/resto exactos de `BigInt`, respetando el redondeo
de `Math.round`, también para negativos. Se comprueban ambos límites de entero seguro.
Las sumas se acumulan exactamente antes de comprobar el resultado final: una pérdida
que compensa una ganancia no convierte un total seguro en desconocido por un exceso
intermedio. Los desbordamientos finales reales siguen devolviendo `null`.

### El inicio automático no se realimenta cuando falla

Antes de iniciar una sesión nueva se comprueba que el secreto seleccionado tenga valor.
La comprobación afecta solo al inicio: no bloquea la frontera de cierre de una sesión ya
enlazada si su credencial desaparece. Las reconciliaciones causadas por el propio inicio
pendiente no encolan nuevos intentos; los eventos reales de presencia conservan su cola.
Una reconciliación posterior permite recuperarse cuando vuelve la clave o desaparece el fallo.

Las regresiones cubren selección ausente, valor ausente, captura que falla, recuperación,
salida durante la captura inicial y pérdida de clave tras enlazar una sesión. En este
último caso, la hora de salida se conserva a través del fallo de cierre y su reintento.

## Evidencia de regresión

Fixtures sintéticas, sin claves ni datos de cuenta reales:

- Historial y redondeo: 12 fallos antes del arreglo; 132 tests focales pasan después.
- Cancelación de sumas: dos fallos antes del ajuste de revisión; 85 tests focales pasan después.
- Arranque: cuatro fallos antes del arreglo; 80 tests focales pasan después.
- TypeScript y ESLint dirigidos pasan en ambos lotes.

Son ejecuciones con conjuntos solapados; sus recuentos no se suman como tests únicos.
La revisión independiente cubrió los ocho archivos iniciales, los consumidores de
exportación/UI y la composición de presencia/credenciales. Encontró el problema de
compensación de sumas, que se corrigió y se volvió a revisar.

El primer `npm run check` ejecutó sus ocho pasos: siete pasaron y la suite encontró un
único fallo entre 4.275 tests. La fixture de `main-alert-wiring.test.ts` seleccionaba
`gw2-key` sin almacenar ningún valor. Su caso positivo necesita una clave sintética;
no se ha relajado el guard de producción para hacerlo pasar.

## Comprobación con los datos originales

La sonda del candidato combinado leyó las 29 notas a través de `SessionHistoryService.scan`
y `buildSessionHistoryAggregate`: 29 válidas, cero ignoradas. La nota del 18 sep conserva
sus netos de −42.201 y −4.713 cobres. Los subtotales conocidos, incluidas esas pérdidas,
son 1.344.805 y 1.539.796 cobres.

Se conservan 20 sesiones estimadas, cinco exactas y cuatro contaminadas, con calidad
separada; ocho sesiones duran al menos una hora. Las métricas desconocidas siguen siendo
`null`: estos datos aún no reúnen dos sesiones elegibles por grupo para tasas de rendimiento.
El control negativo en memoria (duración −1) sigue siendo rechazado.

Los hashes de las 29 notas coinciden antes y después de la lectura y con la evidencia del
diagnóstico. Cero intentos de escritura, sin peticiones de cuenta ni precios nuevos.

## Verificación final y límite del gate

Candidato de producto: `7012e5e149d1bbbd38f15dc7267cbdd963150b72`, árbol
`4e0212230a7424f07c84ded633af474925acc649`. La documentación de este informe
se añade después; no cambia las fuentes verificadas.

- `npm run check`: exit 0, ocho pasos correctos, 4.275 tests en 264 archivos;
  tipos, lint, seguridad, censo, i18n y bundles Obsidian/Hebra correctos.
- Revisión independiente final del candidato: sin hallazgos pendientes, nueve
  archivos de producto/tests revisados, incluidos los ajustes posteriores.
- Sonda de notas reales ejecutada sobre ese SHA: exit 0, 29/29 válidas,
  hashes conservados y cero intentos de escritura.
- `npm run check:guardrails`: exit 1, 24/25 pasos correctos. El único fallo es
  `h8-helper-decision-contract`, con diagnóstico `platform-document-hash`.
  `node scripts/h8-native-decision-contract.mjs` reproduce el mismo diagnóstico
  y exit 1 tanto en este candidato como en el checkout principal limpio
  `875eb05869799d5cbc939e1c3b183a3e8260ceef`. Es un fallo previo, no resuelto
  por este lote. El gate completo de infraestructura permanece rojo.

Evidencia canónica en [el directorio del lote](2026-10-02-h18-29-fix-evidence/):
[gate principal](2026-10-02-h18-29-fix-evidence/check-final.log),
[guardrails](2026-10-02-h18-29-fix-evidence/guardrails-final.log),
[comparación del fallo previo](2026-10-02-h18-29-fix-evidence/h8-baseline.txt),
[datos de la sonda](2026-10-02-h18-29-fix-evidence/real-history-evidence.json) y
[recibo de ejecución](2026-10-02-h18-29-fix-evidence/real-history-execution.json).
Los logs rojos y verdes dirigidos también se conservan allí. El código de la sonda
se archiva como texto, para que ESLint no lo trate como fuente mantenida del producto.

## Alcance pendiente

El candidato es local. No se ha instalado ni publicado y no se ha observado Obsidian/BRAT,
Nexus, Windows/Blish o una sesión de juego nueva. H18.29 sigue pendiente de su matriz real;
H18.30 no forma parte de esta corrección. La evidencia histórica no se transforma en QA
de una instalación nueva por el hecho de que el consumidor actual la acepte.
