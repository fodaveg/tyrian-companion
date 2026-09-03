# Histórico de `docs/ESTADO.md` — lotes ya cerrados

Movido desde `docs/ESTADO.md` el 2026-09-03, en H13.13 (recorte de `docs/` sin perder trazabilidad).
Es el relato completo, línea a línea, de las releases y lotes que estaban integrados y publicados
*antes* de la `0.1.21`: el estado de HOY vive en `docs/ESTADO.md`, esto es el histórico que ese
documento resumía con «La evidencia de la release anterior se conserva como histórico.» antes de
cada entrada. No se ha corregido ni actualizado ningún dato; es una copia literal.

---

**Release beta `0.1.20` publicada el 2026-09-01 desde el tag y commit
`be5434b4cfc283198bd0054053bb7092b80decc6`.** `manifest.json` y `package.json` declaraban `0.1.20`.
Los tres runs terminaron en verde: CI de `main` `33509432201`, CI del tag `33509449053` y el
workflow `Release` `33509449093`. Fue la primera publicación hecha por el workflow automático, que
corre el contrato BRAT como puerta antes de publicar en vez de auditar después.

La release adjuntó los cinco assets exactos. El ZIP tiene SHA-256
`cca1d1f3e6af81cae98258375067782bc660e7a53e1b06ae9cf776d605110c93`, y el `main.js` publicado se
descargó y comparó: coincidió byte a byte con el construido localmente, SHA-256
`905c31240f1f54513f4366d810156b1d8bd43b78565ed9a1d89d851e70707618`. El contrato BRAT, ejecutado
contra la salida real de `gh release view`, dio `PASS (version=0.1.20; assets=5)`.

Esa publicación no acreditó instalación, actualización desde BRAT, carga del plugin, QA visual ni
llamadas reales a la API de Guild Wars 2 desde el cliente.

La evidencia de la release anterior a esa se conserva como histórico.
**Release beta `0.1.18` publicada el 2026-08-31; canal BRAT actualizado.** El tag y commit
`6090defe5fd4b485e4f49efdbfd10f395197a716` están disponibles en la
[GitHub Release pública](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.18). Los runs
de CI de `main` [`33422321993`](https://github.com/fodaveg/tyrian-companion/actions/runs/33422321993)
y del tag [`33422707286`](https://github.com/fodaveg/tyrian-companion/actions/runs/33422707286)
terminaron en verde. La release publica los cinco assets exactos `manifest.json`, `main.js`,
`styles.css`, `tyrian-companion-0.1.18.zip` y `tyrian-companion-0.1.18.zip.sha256`; sus digests
remotos coinciden con los bytes locales sellados y el ZIP tiene SHA-256
`fb7aa0ff08b101ae00d7786d273c0d68a02db5971cd95f13f56f7c62b57ebf99`.

H12.3 corrige el bloqueo de inicialización observado al restaurar una sesión completada persistida.
La presentación de esa sesión se reconstruía antes de componer una dependencia que necesitaba, por
lo que el runtime diferido no alcanzaba el estado listo. El hotfix adelanta esa composición y añade
un test ejecutable que persiste una sesión terminal, reproduce el fallo en rojo sobre el orden
anterior y verifica ahora que el runtime termina listo; el control sin sesión persistida permanece
verde. La evidencia local detallada no sale del entorno de soporte.

H12.1 incorpora en la release el panel visible con paridad 16/16 frente a la paleta. H12.2 deja
censadas Sesión, Inventario, Ajustes, el panel compartido y nueve modales/confirmaciones; sus
entregables durables viven en `docs/design/H12.2-ui-ux-audit.md` y
`docs/design/H12.2-mockup.html`.

**Lote H9.5/H9.19/H9.20/H12.5/H12.6 integrado en `main` y publicado en `0.1.18`.** H9.5 añade al
historial local actividad Halloween y build
declarado, con agrupaciones de al menos dos sesiones `exact/high` y completamente valoradas. Las
tasas se calculan desde sumas y duración total; los campos nuevos no cruzan la allowlist JSON ni las
columnas CSV.

H9.19 corrige tres promesas económicas: la duración procede de `delta.window`; un filtro de una
valoración account-wide no prorratea profundidad ni tasas; y el mejor anuncio vendedor se presenta
como referencia bruta, no como total realizable. H9.20 comparte un cursor de profundidad por objeto
entre valoración de sesión, inventario durable y economía curada de `#36038`, aplicando las tasas
con aritmética segura. Profundidad ausente, parcial, agotada, stale o futura conserva la cobertura y
bloquea rutas curadas en vez de volver optimista el resultado.

H12.5 ordena el Advisor como actualización manual, **Qué hacer ahora**, sync/histórico y
preferencias; búsqueda y orden quedan siempre visibles y el resto de filtros se pliega. Los botones
resumen dicen que filtran y no ejecutan. H12.6 conserva las 26 filas de Ajustes mostrando una sola
categoría con navegación accesible lateral/horizontal; cada escritura visible pasa por una cola
común y muestra guardando/guardado/error. Halloween usa tarjeta, resumen o tabla según 480/760 px, y
diagnóstico/soporte comparte terminología ES/EN con aviso de revisión humana del extracto saneado.

Los commits incluidos son `e247d35`, `77745ca`, `46d1e1f`, `ed8d3d8`, `6d9cfb0`, `35dd853`,
`85949ae`, `80898b0`, `1747443` y `22b4a17`. El gate obligó a aislar
`commerce-listings-capture` de los
valoradores puros y los guardarraíles rechazan causalmente importar esa capacidad HTTP desde H4.19.
La revisión final cerró además la combinación manipulada de profundidad `complete` sin venta y la
omisión del warning ante venta parcial; ambos contratos tienen regresiones. Pasan 431 pruebas
dirigidas y el gate completo posterior con lint, 167 ficheros/2.318 tests, spike nativo, scanner, 644
fronteras de observabilidad, empaquetado reproducible, contratos beta/release/soporte y build. La
rerevisión independiente no encuentra más hallazgos y deja el árbol listo para release. La
matriz de diseño cubre tokens,
componentes/estados, responsive, contenido real y feedback; assets no aplican. Sigue
pendiente medir accesibilidad/contraste y validar claro/oscuro/tercer tema, zoom, teclado,
1280/900/600/420/280 px y datos extremos dentro de Obsidian. La publicación no sustituye el
contraste pendiente de listings reales de `#36038` y outcomes, un Refresh durable y una sesión
manual pequeña y otra que agote niveles. No se ha tocado la bóveda real ni se han hecho operaciones
sobre la cuenta.

**Lote H6.26/H12.4 integrado en `main` y publicado en `0.1.18`.** H6.26 hace alcanzables las acciones
curadas del Inventory Advisor sin relajar su cierre
conservador: cada Refresh usa como máximo dos observaciones bajo la misma operación y credencial,
solo dos capturas completas con ownership y placement equivalentes producen `stable`, y divergencia,
relocation o recuperación de un fallo transitorio permanecen limitadas. `429` cede inmediatamente al
cooldown compartido; no hay tercera pasada ni retry exterior. Una fuente opcional parcial conserva el
núcleo usable, pero nunca habilita rutas curadas ni veta recuperar un fallo transitorio del núcleo.

H12.4 prioriza Companion como HUD de juego. El panel de 16 acciones se mantiene expandido desde
1050 px y pasa a un disclosure único cerrado por defecto por debajo; si un resize oculta el control
en foco, este vuelve al toggle. Companion ordena sesión, detección del saco `#36038`, confirmaciones,
historial, botín/Halloween y cuenta; la detección muestra última consulta, resultado y próxima en una
estructura semántica. La CTA primaria se reproyecta con el estado vivo, las propuestas obsoletas no
se promueven y una propuesta fresca arma el timer único incluso si llega tras el render; al caducar
desaparecen CTA y acciones inline con foco preservado. Halloween se resume salvo alerta no leída o
error de store. Los commits incluidos son `71c562a`, `3bf3250`, `cd1a0d0`, `742e245`, `95e9381`,
`bca8a9d`, `e449df5`, `c837acf` y `5d1641f`; `ee1f923`, `a19d5e1` y `e04414e`
realinean únicamente sus fronteras de observabilidad revisadas. El gate combinado pasa lint,
167 ficheros y 2.288 tests, spike nativo, scanner, 643 fronteras de observabilidad sin pendientes,
empaquetado reproducible, contratos de release/beta/soporte y build. Las revisiones focales están
verdes y la revisión combinada queda como último control externo. Siguen
pendientes la latencia/timeout/`429` con una cuenta grande y la QA visual/teclado en Obsidian real a
1280/900/600/420/280 px, temas claro/oscuro/tercero y zoom.

**Lote H6.23–H6.25 de fallos live integrado en `main` y publicado en `0.1.18`.** H6.23 reconcilia la
topología observada con manifiesto v2 en la raíz
anterior y cinco Bases reserializadas en la salida: solo relocation puede adoptar el set completo,
exacto y semánticamente equivalente; un journal precede puntero/cleanup y cualquier extra, faltante,
cambio o autoridad ajena falla cerrado sin escribir. La QA filesystem sobre una bóveda desechable
confirmó destino `ready`, origen `detached` y bytes preservados; añadir `Human.base` devolvió
`conflict` y dejó el árbol byte-idéntico. La bóveda real no se tocó.

H6.24 corta una captura account-wide en cuanto una pasada contiene un fallo parcial transitorio,
conserva `passCoverages` y no publica snapshot incompleto. Los endpoints de inventario/build de
personaje reciben un intento de 30 segundos y el scheduler conserva en exclusiva un único
timer/backoff; una recuperación vuelve a scheduled sin duplicar polling ni reabrir H6.19.

H6.25 atribuye el TypeError histórico al único span propietario
`session_projection/precondition_failed`, distingue lectura `storage_failure` de bug interno de
proyección y permite que `plugin_load/runtime_initialize` termine bien. El paquete de soporte
conserva solo campos estructurados y omite `message|stack|errorName|state|details`, por lo que el código y la
correlación siguen diagnosticables sin el texto personal observado. Los commits incluidos son
`446ae51`, `cf0f7c0`, `7732485` y `463d367`. El gate combinado pasa lint, 167 ficheros y 2.269 tests,
scanner, 644 fronteras de observabilidad sin pendientes, contratos y build; el lote forma parte de
`0.1.18`.

**Lote H8.8/H7.13 integrado en `main` y publicado en `0.1.18`.** H8.8 queda reconciliada con el
alcance shadow aislado de
`a4fd22b` y `25a1057`: política pura 5 s/60 s para el mapa 866, DTO efímero y revisión humana, sin
runtime, cola, persistencia ni UI; la composición y QA posteriores siguen en H8.9–H8.15 y H8 continúa
congelada por H8.2.

H7.13 añade un journal local opt-in y separado por vault para el piloto H0.6. Registra propuestas
presentadas y cierres humanos u operativos, sesiones completadas y recoveries sin bloquear ninguna
acción de producto; una recovery no clasificada se conserva y deja el veredicto inconcluso. Agrega
por plataforma y estratos de versión `k/n`, cobertura, Wilson 95 %, precisión, recovery y umbrales;
la revisión de pérdidas queda ligada a una `sampleRevision` monotónica e invalidada
transaccionalmente ante cada cambio real; una carrera devuelve `stale` y no certifica evidencia no
vista. Desactivar borra perfil, evidencia y revisión, pero avanza y retiene únicamente el contador
generacional no personal para impedir ABA al reactivar. Ajustes ofrece preview, cuatro exports
JSON/CSV deterministas create-only, limpieza de muestra+revisión y desactivación del journal. No hay
Sync propio ni telemetría remota; los
exports del Vault pueden ser copiados por Obsidian Sync y las referencias SHA-256 siguen siendo
seudónimas.

Los commits incluidos de H7.13 son `e267ae4`, `ab321a9`, `c2981ba`, `388dc86`, `8c7f343`,
`221862a`, `82c0b94`, `ba77b95`, `686194b`, `e765b5c`, `4902bf5`, `f64a06c` y `e70fb66`. La revisión contractual obligó a cerrar también
`superseded|invalidated` y cualquier propuesta viva al desarmar; seguridad obligó a ligar la revisión
a entorno+muestra y a precisar el alcance de clear/disable/exports. La revisión final hizo cerrar
además cuatro fallos: muestra concurrente, modal instrumental que gateaba producto, segundo terminal
tras `accepted_workflow_failed` y clasificación de recovery perdida al recargar. El fix rehidrata y
cierra esa clasificación, sella el primer fallo y mantiene aceptar/iniciar/parar directos con frontera
nullable. Seguridad detectó además el reinicio generacional tras disable/re-enable; el contador ya
sobrevive como dato no personal y la revisión anterior queda `stale`. La rerevisión cerró también el
cambio concurrente de perfil: se compara primero la revisión y un store sano ya no se degrada por
entorno obsoleto. El último control de seguridad cerró además la combinación de perfil corrupto y
revisión cambiada: la forma inválida vuelve a fallar cerrada antes de clasificar una carrera. Pasan
108 tests focales y el gate completo con lint, 167 ficheros y 2.250 tests, scanner,
observabilidad, contratos de release/beta/soporte y build. Siguen pendientes la QA visual/manual ES/EN
en temas reales, IndexedDB multiwindow y borrado en Obsidian real, el dry run instrumentado en las tres
plataformas y la muestra H7.7; publicar el journal no acredita el piloto.

**H9.7/H6.21: integradas en `main` y publicadas en `0.1.18`.** H9.7 añade a Companion un historial
durable ES/EN que solo escanea
el vault tras activar **Cargar historial**. Presenta seis estados cerrados, bloquea resultados
parciales ante notas inválidas o duplicadas, agrega duración, sacos y valores sin convertir `null`
en cero y compara las dos sesiones más recientes en tabla o tarjetas responsive. La proyección
elimina referencias de cuenta/sesión y no persiste recomendaciones ni opera sobre la cuenta.

H6.21 sustituye el mensaje genérico de inicio y cierre por copy accionable y exhaustivo para los
ocho códigos de arranque y los seis de finalización, con paridad ES/EN. El enfriamiento `429` de la
conexión conserva su ruta independiente y no queda oculto por este cambio. Ambos frentes tienen
tests focales verdes. La revisión independiente detectó el orden por inicio y la pérdida de segundos
en duraciones cortas; ambos quedaron corregidos con regresiones por cierre solapado y deltas
subminuto. El gate combinado pasa lint, 162 ficheros y 2.178 tests, escáner de seguridad, censo de
observabilidad, contratos de release/beta/soporte y build.

**H6.19/H6.20: reconciliadas y publicadas en `0.1.18`, sin cambios nuevos de producción.** La
corrección `6c6e2cd` ya forma parte de `0.1.16` y `0.1.17`. La evidencia de
H6.19 no correspondía a dos calendarios de detección: el poll de las 06:30:12 era el deadline
independiente del histórico de precios y el de las 06:30:24 pertenecía a detección; antes del fix
ambos heredaban la identidad `detection_poll`. Producción ya los distingue como
`price_history_poll` y `detection_poll`. `40d1678`, incluido en `0.1.18`, añade una regresión con
reloj falso
que reproduce los dos arranques, avanza por ambos deadlines y exige exactamente un poll y un timer
por consumidor, con `actionId` e identidad propios.

H6.20 quedó resuelta por el mismo commit: `session_start` identifica únicamente el inicio humano y
la persistencia de acquire/renew/release/contención de autoridad usa `session_lease`, saneada y sin
datos del lease o de la sesión. La arquitectura vigila ambas identidades cerradas. La observación
live de una sesión continua de veinte minutos sigue siendo aceptación manual; el repositorio no la
declara realizada. El gate combinado previo a la release pasa lint, 162 ficheros y 2.178 tests,
escáner de
seguridad, censo de observabilidad, contratos de release/beta/soporte y build.

La dirección conserva el panel visible de H12.1 y H12.4 aplica su primera tranche en `0.1.18`:
ordena Companion como sesión, detección, confirmaciones, historial, botín/Halloween y
cuenta. El alcance real queda explícito: el polling asistido busca la señal de los cinco drops del
Laberinto que la regla vigila; no refresca todo el inventario ni detecta farmeo general. Su cadencia
por defecto en una instalación nueva es de 10 minutos, que además es ya la más rápida ofrecida: la
opción de 2 minutos se retiró por quedar por debajo de la caché de 5-10 minutos de la API, y una
instalación que la tuviera guardada adopta el defecto al cargar. Los valores vivos son
`DEFAULT_SETTINGS.pollingIntervalMinutes` y `POLLING_INTERVAL_OPTIONS` en `src/core/settings.ts`. El
Inventory Advisor se actualiza manualmente y el histórico de precio usa su propia cadencia.

El mockup navega entre las tres vistas, cuatro categorías de Ajustes y siete escenarios reales;
conserva las 16 acciones, claro/oscuro y responsive hasta 390 px. La QA standalone con Firefox cubre
1.440, 1.280, 900 y 390 px, estados activo/sin clave/error/proceso largo/textos extremos, targets de
44 px y ratios AA medidos. Esta evidencia valida la propuesta fuera del plugin, no su fidelidad ni
contraste dentro de temas reales de Obsidian. El canal BRAT está publicado, pero la instalación o
actualización efectiva en Obsidian, la fidelidad del rediseño en sus temas y la comprobación con
datos reales de Guild Wars 2 siguen pendientes de QA humana.

**H6.17, diagnóstico local exhaustivo: integrado y publicado en `0.1.15` y `0.1.16`.** El plugin
incorpora un writer JSONL local fail-open y rotativo (5×2 MiB), contrato cerrado con secuencia y
correlación, saneado positivo central y spans para las acciones foreground/background. Settings v11
deja la captura `debug` activada por defecto en beta, expone salud y retención, y ofrece
copy/export/clear explícitos; Companion hace visible una degradación sin bloquear la acción principal.

La composición cubre lifecycle, ajustes, UI/comandos, red GW2 y reintentos, sesiones y detección,
Asesor, histórico de precios, Halloween, assets, persistencia, avisos y errores globales. H8/Mumble
sigue fuera de `main` y conserva su superficie diagnóstica cerrada sin importar el logger ni retener
frames. El censo AST de fronteras asíncronas forma parte del gate y exige clasificación/motivo para
cualquier cambio.

El árbol final supera 155 suites y 2.106 tests, lint, TypeScript/build, escáner de seguridad, censo
de observabilidad y contratos de release. El benchmark H6 queda dentro de presupuesto —mediana
226 ms, p95 231 ms y 1,14 MiB máximos de heap retenido acumulado— y su sabotaje determinista vuelve
rojo. La integración superó además la revisión independiente como último gate. La instalación
en Obsidian real y la reproducción live de fallo de API/escritura/IndexedDB/helper/aviso siguen
siendo aceptación manual y no se declararán realizadas desde el repositorio.

**H9.16/H9.3, comparación manual de reciclaje de equipo: integrada en `main` y publicada en
`0.1.16` mediante `1d04b61`, `bc1d8ed` y `b4b79ba`.** El Asesor compara equipo Rare
de nivel 68 o superior con sus rutas líquidas actuales mediante una EV inferior demostrada de 0,9
ectoplasmas por objeto. La valoración excluye y declara materiales base, suerte y mejoras recuperadas;
no los convierte en valor cero.

La venta inmediata del ectoplasma exige profundidad real de pujas suficiente para toda la salida
esperada. El anuncio usa el ask actual como referencia y no demuestra demanda ni garantiza ejecución.
La comparación del objeto conserva las comisiones de bazar y la ruta de mercader. Solo una ventaja
estricta del neto de reciclaje produce `salvage`; en otro caso prevalece la mejor ruta líquida.

Settings v10 añade kit y estrategia de venta configurables, además de segundos por objeto y coste de
oportunidad por hora opcionales. La ausencia de kit usa explícitamente el coste conservador del kit de
maestro y la ausencia de estrategia usa la menor cotización neta disponible. El tiempo se incluye solo
cuando ambos campos están presentes; si falta uno, queda fuera de la EV con procedencia
`excluded_missing_preference` visible. El kit místico se retiene porque su coste publicado no cubre las
Piedras de la Forja Mística.

La política v1 compilada referencia la API oficial del ectoplasma y revisiones fijadas de GW2 Wiki
para tasas y kits, tiene vigencia cerrada y se valida por SHA-256. Cada `salvageProof` enlaza el item,
su snapshot de catálogo y la política/regla exactas; reporte y envelope vuelven a comprobar ese
contexto. Exotic de nivel 68 o superior queda en revisión sin tasa inventada. `NoSalvage`, snapshot no
estable, catálogo o precios incompletos, política stale y profundidad parcial fallan cerrado. No existe
executor ni operación de reciclaje. Su publicación en `0.1.16` todavía no acredita QA visual o
ejecución dentro de Obsidian.

**H9.6/H9.15, benchmarking de clan y cambio oro-gemas: cerradas como decisiones de producto.**
H9.6 queda descartada en el producto actual. Comparar un clan exigiría intercambio de datos o un
backend compartido y reabriría la evaluación de privacidad y RGPD. Solo se reconsiderará como una
iniciativa separada y opt-in, con agregación local previa, cohorte mínima y sin claves API, account
IDs ni identificadores persistentes.

H9.15 tampoco será una feature independiente. Los endpoints públicos oficiales
`/v2/commerce/exchange/coins` y `/v2/commerce/exchange/gems` permiten obtener una cotización, pero
una observación aislada no demuestra que convenga usar la bolsa en vez del banco. Únicamente
`/v2/commerce/exchange/coins` podrá reconsiderarse dentro de un futuro planificador explícito de
capacidad, con cotización temporal, acción siempre humana y sin persistencia.

**H9.2, profundidad real del bazar: integrada en `main` mediante `8569139`, `2234d5f`,
`8c280bb`, `e743405` y `f28e063`.** Cada Refresh explícito del Asesor consulta el endpoint público
oficial `/v2/commerce/listings`, sin clave, con ids deduplicados y ordenados, lotes secuenciales de
hasta 200 y el coordinador compartido de rate limit. El parser conserva cobertura por objeto y
rechaza niveles duplicados, desordenados o corruptos.

La venta instantánea consume las pujas reales de mayor a menor y valora únicamente la cantidad
cubierta. Publicar usa el mejor precio vendedor observado para la pila completa: la cantidad ya
publicada a ese precio no se presenta como capacidad de compra ni como garantía de ejecución futura.
La profundidad se consume una sola vez por objeto agregado, aunque aparezca en varias posiciones.
La UI ES/EN distingue profundidad completa, parcial, sin mercado y error, y muestra cantidad cubierta,
cantidad sin cubrir y neto demostrado.

Si la profundidad falta o queda incompleta, el Asesor conserva el comportamiento anterior basado en
`/v2/commerce/prices`, pero el resultado público queda `limited`; una respuesta parcial nunca se
disfraza de profundidad completa. El guard compartido de fronteras usa ahora el AST de TypeScript y
cubre imports y exports estáticos, imports laterales, `import = require`, tipos `import()`, `import()`
dinámico y `require()` cuando el specifier es literal. Su límite explícito son los specifiers
computados u ofuscados.

La revisión final de `f28e063` no encontró hallazgos. El gate completo quedó verde con 151 ficheros
y 2.015 tests, además de seguridad, contratos, build y paquete. El lote está publicado en `0.1.16`,
pero no acredita llamadas reales a `/v2/commerce/listings`, QA visual o ejecución dentro de Obsidian.

**H9.17/H9.18, capacidad y depósito manual de materiales: integradas en `main` mediante `d86c526`,
`88d2322` y `eb54e02`.** Settings v9 añade una capacidad global opcional por material entre 250 y
3.000, en pasos de 250, con migración cerrada. El valor `null` no inventa una ampliación: aplica el
mínimo garantizado de 250 y conserva `minimum_guaranteed` como procedencia visible; un valor elegido
se presenta como `configured`.

`deposit_material` es una recomendación manual y sin efectos laterales. Solo consume posiciones
`loose` de personaje o inventario compartido después de asignar reservas y excepciones. Exige
snapshot estable, cobertura completa de materiales, pertenencia a una única categoría demostrada y
catálogo completo y fresco. La cantidad agregada recomendada para cada objeto nunca supera
`capacity - stored`; capacidad llena, cobertura incompleta, dato stale o pertenencia ambigua dejan la
ruta sin recomendar.

La revisión final de `eb54e02` no encontró hallazgos. El gate completo quedó verde con 149 ficheros
y 1.999 tests, además de seguridad, contratos, build y paquete. El lote está publicado en `0.1.16`,
pero no acredita QA visual o ejecución dentro de Obsidian.

**H9.8/H9.14, evidencia personal del bazar: integrada en `main` mediante `3e84514`, `ed7f8b8` y el
fix `f825621`.** H9.14 consulta las órdenes actuales de compra y venta durante el Refresh explícito
del Asesor. Una orden de compra activa suprime únicamente la recomendación coincidente de vender al
instante; una orden de venta activa suprime únicamente la recomendación de publicar. La supresión
exige cobertura `complete` del lado correspondiente. Cobertura `missing`, `partial` o no disponible
es neutral y no retira ninguna acción.

H9.8 consulta como máximo 90 días de compras y ventas completadas dentro de la ventana exacta de la
sesión. El resultado solo prepara una propuesta dentro del modal de revisión: David puede aplicarla,
ignorarla o modificar las respuestas antes de guardar. La evidencia incompleta no propone actividad
y nunca entra directamente en la clasificación. Los IDs crudos de transacción no salen de la
captura, no hay persistencia del historial y ninguna ruta compra, vende, publica o cancela órdenes.

La revisión final de `f825621` no encontró hallazgos. El gate completo quedó verde con 149 ficheros
y 1.988 tests, además de seguridad, contratos, build y paquete. El lote está publicado en `0.1.16`,
pero no acredita QA visual o llamadas reales a la API desde Obsidian.

**H9.10-H9.13, prioridades visibles del inventario: integradas en `main` mediante `06919f4` y
`762d67f`.** H9.10 identifica el peso muerto retenido y lo pendiente sin clasificar, conserva las
posiciones exactas que ocupan espacio y muestra sus unidades y huecos ocupados. El orden principal
prioriza primero el espacio liberable agregado por objeto y después el valor demostrado.

H9.11 añade a cada valor conocido su porcentaje del total visible y el porcentaje acumulado, con
cálculo seguro y determinista. H9.12 explica cada protección con la reserva u excepción concreta, su
cantidad, motivo, base y destino previsto, sin atribuir carga de inventario a lo que el usuario ha
decidido conservar. H9.13 presenta en paralelo el neto de vender al instante, el neto de publicar y
su diferencia absoluta y porcentual; respeta la profundidad finita de las pujas y no inventa el lado
del mercado que falta.

La información aparece en tabla y tarjetas, con copy ES/EN y sin perder la procedencia al filtrar por
ubicación. La revisión final de `762d67f` no encontró hallazgos. El gate completo quedó verde con 147
ficheros y 1.968 tests, además de seguridad, contratos, build y paquete. El lote está publicado en
`0.1.16`, pero no acredita QA visual o instalación en Obsidian.

**H11.6, valoración personal de resultados no líquidos de Halloween: integrada en `main` y
`origin/main` mediante `17da38f` e incluida en `0.1.13`, sin afirmar instalación ni QA visual.** Un overlay
manual separado del modelo permite valorar en cobre los diez resultados explícitos que el EV líquido
de la bolsa excluye. Ajustes sube a schema v8 con migración cerrada, valores por defecto aislados y un
editor ES/EN que acepta el cero explícito, rechaza entradas inválidas y restaura el foco después de
guardar o retirar un valor.

La cobertura distingue `none`, `partial` y `complete`. El EV y la decisión líquidos permanecen
intactos; una cobertura parcial solo expone el límite inferior conocido y la valoración personal no
puede cambiar la recomendación hasta completar los diez valores. Claves ajenas, duplicados, campos
extra y desbordamientos fallan cerrados.

La persistencia publica el overlay nuevo al runtime únicamente después de que `saveData` termine. Si
existe una captura fresca, el Asesor la reclasifica en memoria sin consultar la red; si no puede
hacerlo, el editor informa `next_refresh`. El resultado `reclassified` confirma la reclasificación
local. La revisión independiente no encontró hallazgos y `npm run check` quedó verde sobre `17da38f`
con 147 ficheros y 1.961 tests, además de seguridad, contratos y build.

**H11-B, comparación H11.3 y aviso de precio H11.5: integrado en `main` e incluido en `0.1.13`.**
H11.3 solo sella el
delta `session_final` cuando la revisión termina como `finalized`; el resultado intermedio `reviewed`
ya no puede sellar como final una revisión guardada cuya finalización falló. La elegibilidad exige
sesión Halloween, delta comparable, certeza confirmada, `open=true`, todas las demás actividades
falsas y descenso neto del item `36038`. La cantidad se presenta como **bolsas desaparecidas netas**,
sin afirmar que sean aperturas demostradas.

La comparación persiste atómicamente los 18 outcomes del modelo, incluidos los ceros, y reproduce la
criba con `BigInt`: `n>=1100`, expectativa `E>=20`, diferencia mínima del 10% y `|z|>=3,45`. Los
records nuevos guardan `modelId` y `modelVersion` y se resuelven contra un registry histórico; el
legacy conserva su modelo original y las versiones desconocidas fallan cerradas. El panel distingue
todavía no finalizada, ignorada con razón, recopilando, muestra suficiente sin desviación, desviación
y fallo de almacenamiento, y muestra la tabla completa de resultados.

H11.5 evalúa solo el item `36038` desde el puerto local de H9.1: compara la puja actual con el p90
nearest-rank, posición 27, de los 30 días UTC completos inmediatamente anteriores. Un día ausente,
una puja nula, una captura futura, datos inválidos o la falta del cierre de hoy producen
`insufficient_history`. El anti-spam durable y multiwindow solo avisa en el cruce `below→high`, como
máximo una vez por día UTC y después del cooldown; solo un `below` válido rearma, y
`lastValidCapturedAtMs` impide que una evaluación antigua sobrescriba una decisión más nueva. Apagar
H9.1 deja el runtime `disabled`: una activación o callback anterior no puede reabrirlo ni emitir.
Ajustes sube a schema v7 con el aviso desactivado, margen mínimo configurable y cooldown
6/12/24/48 h. El panel expone estados, bandeja y reconocimiento; `Notice` solo se emite desde el
adaptador foreground.

La revisión independiente declaró apto `5ce118b` y `npm run check` quedó verde con 144 ficheros y
1.912 tests, además de seguridad, paquete, contratos y build. H11.3 necesita acumular al menos 1.100
bolsas desaparecidas netas antes de poder concluir desviaciones y H11.5 necesita 30 cierres UTC
completos. Quedan pendientes la QA visual y de contraste en temas reales de Obsidian y la entrega
live de `Notice`; la inclusión en `0.1.13` no acredita instalación ni esa entrega real.

**H11-A, alertas de Halloween H11.1/H11.2/H11.4: integrado en `main` e incluido en `0.1.13`.** El
runtime opt-in consume únicamente deltas positivos de sesiones
Halloween aceptadas y genera alertas revisables por valor, rareza, primera observación y desbloqueo
de skin o mini. La rareza Rare+ solo alerta cuando existe ausencia de cotización demostrada o el
objeto está vinculado. Un inbox/outbox durable deduplica cada objeto dentro del episodio; durante el
polling puede emitir avisos provisionales y el cierre los reconcilia con el delta final,
sustituyéndolos por una alerta final o eliminándolos cuando ya no aplica ninguna señal. El
reconocimiento se conserva solo cuando el contenido final sigue siendo un subconjunto válido.

La lista empírica se aprende de forma incremental y canónica, con backfill de notas de sesión antes
del tráfico vivo. Las notas nuevas suben a schema v3; las v1, que carecen de `tc_event`, no alimentan
`seen`, y las v2 de Halloween sin deltas exactos permanecen como aprendizaje `partial` sin habilitar
`first_seen`. El normalizador de catálogo v3 conserva `details.skins[]` y transforma el
`minipet_id` de la API cruda en `details.minipetId`; las señales de desbloqueo solo se emiten cuando
la cobertura autenticada de la dimensión correspondiente es completa.

Halloween parte desactivado en ajustes schema v6, con umbral de valor configurable y consultas de
unlocks opcionales. Su IndexedDB dedicada falla cerrada y queda separada por vault y cuenta. Cuando
H9.1 está activo, el bridge añade al histórico los ids positivos observados, incluido el backfill
reciente, sin activarlo por su cuenta. Tanto `seen` como el inbox de IndexedDB son locales al
dispositivo y no se sincronizan entre instalaciones. La revisión independiente declaró apto
`c867488` y `npm run check` quedó verde con 138 ficheros y 1.877 tests, además de seguridad, paquete,
contratos y build. No se han verificado todavía el aspecto en temas reales de Obsidian, la entrega
real de `Notice` ni las llamadas live a la API; la inclusión en `0.1.13` no acredita esas pruebas ni
la instalación.

**H9.1, histórico local de precios: integrado en `main` e incluido en `0.1.13`.** El plugin muestrea
la API oficial pública `/v2/commerce/prices`, sin clave ni
GW2Efficiency, y conserva en una IndexedDB dedicada snapshots compactos y agregados diarios UTC.
Compacta antes de podar, aplica retenciones raw y diarias configurables mediante trabajo incremental
acotado y calcula percentiles reproducibles sobre cierres observados, sin rellenar días ausentes.

La captura es opt-in y parte desactivada. Construir el runtime o abrir el panel no toca IndexedDB ni
red; la UI permite cargar la serie local, elegir lado y ventana, y distingue recopilación insuficiente,
datos parciales y almacenamiento no disponible. La revisión independiente dejó el candidato listo
para integrar y `npm run check` quedó verde con 130 ficheros y 1.804 tests, además de las suites de
seguridad, paquete, contratos y build. Este repo no dispone de harness Playwright/e2e. Quedan como QA
manual el contraste en temas reales de Obsidian y la coordinación multiwindow sobre IndexedDB real;
no se afirman como verificadas ni bloquean la integración técnica.

**H10, pulido del Asesor de inventario: integrado en `main` y `origin/main` mediante `21285d1` e
incluido en `0.1.13`, sin afirmar instalación.** El flujo automático distingue los fallos de captura de los de
escritura, rechaza planes concurrentes distintos y revalida el estado antes de escribir o persistir.
La vista añade **Analizar sin escribir**, extrae el panel de sincronización, comparte un único
formateador de dinero y reduce la tabla a la información útil para jugar, con el detalle técnico
reservado al modo avanzado.

La revisión independiente no encontró bloqueos y el gate base del repo quedó verde con 124 suites y
1.742 tests. Este repo no dispone de harness Playwright/e2e. La semántica, el foco, los objetivos de
44 px y los cortes responsive 479/480/759/760 están cubiertos por código y tests, pero el contraste
AA no se ha medido en temas reales. H10.4 y H10.7 conservan QA manual pendiente antes de su aceptación
humana.

