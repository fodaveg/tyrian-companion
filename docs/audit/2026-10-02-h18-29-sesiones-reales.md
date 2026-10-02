# H18.29 — comprobación con sesiones existentes, 2 oct 2026

Avance parcial. No se certifican las diez pruebas de aceptación ni la instalación actual.
Encargo: aprovechar las sesiones de juego recientes de David para evitar repetir trabajo
ya observable. Se leen las notas originales sin modificarlas; las sondas no consultan la API
ni acceden a claves. No se ha abierto Obsidian ni Guild Wars 2.

## Candidato y entorno

- Código comprobado: `875eb05869799d5cbc939e1c3b183a3e8260ceef`, versión 0.2.17.
- Árbol del candidato: `f646cb75ba00127758d99c6bb1049add4991d93f`.
- Fedora/Linux x64, Node v22.23.1; Vitest instalado 3.2.7.
- Manifest del plugin instalado observado al iniciar la investigación: 0.2.14. El último
  estado del recolector declara 0.2.11, con heartbeat del 1 oct. Ninguno demuestra qué versión
  generó cada nota histórica ni que el proceso cargado corresponda al manifest.
- Fuente: carpeta `sessions/2026` bajo la salida configurada de Tyrian, en
  `42.31 Datos de cuenta de Guild Wars 2` del vault resuelto desde `~/.jd/config.json`.
- 29 notas del 30 ago al 29 sep; siete desde el 24 sep. Ocho notas declaran al menos una hora.
  Las siete recientes tienen duración coherente con sus timestamps de inicio y fin.
- Las notas no guardan versión del plugin y las siete recientes tienen
  `tc_detection_mode: null`. No permiten demostrar por sí solas inicio manual/automático,
  ausencia de fin falso ni rearme del detector.

## Resultados por criterio

Las pruebas unitarias/composiciones ejercitan el código actual. Las notas antiguas son
evidencia histórica. No se suman ambas como una ejecución integral sobre una misma versión.

| Prueba | Evidencia disponible | Pendiente para aceptación integral |
| --- | --- | --- |
| 1. Reservas | Tests de inventario: reserva completa, parcial repartida, objetivos solapados y tabla desconocida | Asesor y Base visibles en el host real |
| 2. Precios | Tests de serie plana, precio hundido, ventanas, separación de fechas y recálculo | Recorrido visual completo, sin precio actual y día incompleto |
| 3. Fallos de cierre | Tests antes/después de guardar estado, reintento, dos ventanas simuladas y escritura idempotente | Fallos controlados y concurrencia en cliente real |
| 4. Suspensión | Tests de gaps, reapertura, descuento de tiempo suspendido y sesión posterior | Suspensión/reanudación real de Fedora y reapertura de Obsidian |
| 5. Sesión de una hora e historial | Notas del 26 sep (61,90 min) y 28 sep (129,38 min), con calidad estimada y valoración parcial | Historial completo en conflicto por una nota antigua; pantalla, comparación visible y ausencia de fin falso sin acreditar |
| 6. Detección consecutiva | Dos notas el 26 sep; no prueban rearme. Bucle sin clave reproducido en composición actual | Resolver el fallo; comprobar detector sin intervención entre sesiones |
| 7. Atribución | Tests de atribución; notas recientes declaran limitaciones por caché y consumo de insumos | Acciones A→B, bazar, mercader y delivery observadas y correlacionadas |
| 8. Inventario sin espacio | Tests de slots libres y ausencia de capacidad inventada | Comprobar en cliente capacidad desconocida y materiales por encima de 250 |
| 9. Resincronizar | Tests de escritura idempotente, preservación de texto humano y actualización de valoración | Dos sincronizaciones reales con hashes antes/después y precio nuevo |
| 10. Fechas | Cinco tests focales de reglas/conocimiento caducados | Avisos visibles y guardado en las fechas de aceptación; caída de datawars2 |

La guía `docs/QA-MVP.md` aún contiene frases históricas de «código no implementado» del
24 sep. Tampoco enumera exactamente las mismas fechas que §8 de la auditoría
(13 nov, 2 dic y mayo siguiente frente a 12 nov, 1 dic y 10 dic en la guía).
Este informe no convierte esas frases en hechos del candidato actual ni declara cubierta
la matriz de fechas por cinco tests de caducidad.

## Arranque automático sin clave

Los logs locales de 0.2.11 contienen 2.969 registros con razón `MissingApiKeyError` entre
`2026-09-29T07:45:29.873Z` y `2026-09-29T07:46:27.340Z`, acompañados de errores de arranque.
No son 2.969 acciones del jugador. La sesión de las 07:46:43 se guardó después.

La composición de clases reales de 0.2.17 reproduce cinco intentos fallidos a partir de
una sola llamada externa a `reconcile()`. La sonda limita expresamente a cinco para no
dejar un bucle y falla si se intenta hacer HTTP. La selección tiene nombre, pero el
proveedor de secretos no devuelve valor.

Cadena comprobada: el guard de `tyrian-companion-core.ts` comprueba el nombre de la
selección; `GuildWars2Client.beginOperation()` lanza `MissingApiKeyError`; el servicio de
inicio vuelve a `idle` y notifica; el callback vuelve a reconciliar la presencia; al no
haberse creado enlace, el marker vuelve a iniciar. Los tests existentes de esos módulos
pasan, pero no cubren esta realimentación.

Pendiente: cortar reintentos automáticos ante credencial ausente y añadir regresión de la
composición. No se ha determinado por qué el almacén real no devolvió la clave ni se ha
modificado configuración o código de producto.

## Historial completo rechazado por un neto negativo

`SessionHistoryService.scan()` sobre las 29 notas devuelve
`{status: 'conflict', invalid: 1, duplicates: 0}`. Las siete notas desde el 24 sep
cargan correctamente por separado. Esto no acredita que el historial completo funcione:
su lector real rechaza el conjunto que contiene la nota antigua.

La nota rechazada es `2026-09-18 153400Z - c5a5935232c30c6f.md`, SHA-256
`800cb6219e1d025db8756ebdcee5c9f953c869251100720bc3a979867b8bc3ab`.
Registra netos de −42.201 y −4.713 cobres. El parser, los seis hashes de bloques y la
duración son válidos, pero `validValuationMetadata()` exige `safeNonNegative` para
ambos netos observados. El rechazo no demuestra corrupción de la nota; señala que el
lector no acepta una sesión con pérdidas.

Pendiente: reconciliar la validación de netos con el contrato económico y cubrir la
lectura/agregación de sesiones con pérdidas. No cambiar los netos de la nota ni excluirla
silenciosamente del historial como arreglo. La agregación aislada de las notas válidas
sirve para diagnóstico, no como resultado del historial completo.

Control causal únicamente en memoria: poner uno de los netos a cero mantiene el rechazo;
poner ambos a cero permite la lectura. Un control negativo independiente con duración −1
también provoca conflicto. Se verificaron sin cambios los hashes de las 29 notas originales;
el puerto read-only registró cero intentos de escritura.

En la agregación exploratoria de las 28 válidas hay 19 estimadas, cinco exactas y cuatro
contaminadas. Las calidades quedan separadas; ningún grupo reúne dos sesiones elegibles
para rendimiento. La comparación de las dos últimas conserva sus fechas y diferencia de
duración, pero las diferencias de tasas horarias son `null`. Tener dos notas no basta para
afirmar que ya exista una comparación numérica de rendimiento utilizable.

## Verificación automatizada

Salida terminal 0 en todos los comandos siguientes; no se ejecutó el gate global:

```sh
node_modules/.bin/vitest run --configLoader runner \
  src/sessions/session-played-duration.test.ts \
  src/sessions/session-resume-gap-end.test.ts \
  src/sessions/retry-from-error.test.ts \
  src/sessions/session-attribution.test.ts \
  src/sessions/session-note-writer.test.ts \
  src/advisor/inventory-sell-or-wait-acceptance.test.ts \
  src/inventory/inventory-vault-sync.test.ts
# 131/131

node_modules/.bin/vitest run --configLoader runner src/inventory/inventory-analysis.test.ts
# 26/26

node_modules/.bin/vitest run --configLoader runner \
  src/advisor/inventory-advisor-classifier.test.ts -t 'stale|caducity'
# 5 pasan, 41 omitidos por el filtro explícito

node_modules/.bin/vitest run src/sessions/ingame-session-marker.test.ts \
  src/core/secret-provider.test.ts src/account/guild-wars-2-client.test.ts
# 30/30

node_modules/.bin/vitest run --configLoader runner \
  src/sessions/session-history.test.ts src/sessions/session-history-summary.test.ts
# 65/65
```

Estos verdes no contradicen los fallos de datos/composición encontrados fuera de las
fixtures existentes. No hay publicación, instalación ni QA visual acreditadas por ellos.

Total: **257 tests pasan**, 41 omitidos expresamente por el filtro de caducidad.
Las sondas salen 0 porque sus aserciones reproducen los dos fallos: no es un verde de producto.
La primera expectativa de que las 29 notas serían válidas falló (exit 1); se conservó el
hallazgo y se caracterizó, sin cambiar las fuentes para hacerlas pasar.

## Evidencia conservada

Artefactos en [2026-10-02-h18-29-evidence](2026-10-02-h18-29-evidence/):

- `history-evidence.json`: hashes, diagnóstico, siete recientes, agregación exploratoria y controles.
- `history-execution.json`: comandos, códigos de salida y límites.
- `history-probe.mjs.txt` y `start-feedback-probe.mjs.txt`: sondas exactas ejecutadas,
  archivadas como texto; no son scripts mantenidos del producto.
- `start-feedback-result.json`: reproducción limitada del bucle.
- Cinco logs de tests: `targeted-tests.log`, `inventory-tests.log`, `expiry-tests.log`,
  `start-focused-tests.log` y `history-tests.log`.

Las sondas preservan las rutas absolutas de esta ejecución. Para repetirlas en esta máquina,
crear `/tmp/tyrian-h18-29-probe` si no existe y ejecutar:

```sh
cp docs/audit/2026-10-02-h18-29-evidence/start-feedback-probe.mjs.txt /tmp/tyrian-h18-29-start-feedback-probe.mjs
cp docs/audit/2026-10-02-h18-29-evidence/history-probe.mjs.txt /tmp/tyrian-h18-29-probe/probe.mjs
node /tmp/tyrian-h18-29-start-feedback-probe.mjs
NODE_PATH=/home/fodaveg/code/tyrian-companion/node_modules \
  node /tmp/tyrian-h18-29-probe/probe.mjs
```

La sonda del historial exige exactamente este corpus de 29 notas. Otra máquina o un corpus
cambiado requiere adaptar las rutas y declarar un candidato/dataset nuevos; estos resultados
no certifican ese cambio. Los paths `/tmp` mencionados en el recibo de ejecución son históricos;
los artefactos adjuntos a este informe son la copia persistente.

## Siguiente paso

H18.29 permanece abierta. Primero corregir y cubrir con regresión el rechazo de netos negativos
y la realimentación de arranque sin credencial. Después repetir los checks afectados y recorrer
historial/detección en el cliente real sobre el mismo candidato. Las notas largas existentes
evitan partir sin datos, pero no sustituyen los escenarios que nunca quedaron registrados.
