# Estado

## Vertical activa

**H9.16/H9.3, comparación manual de reciclaje de equipo: implementada y aprobada mediante
`1d04b61`, `bc1d8ed` y `b4b79ba`; pendiente de integrar en `main`.** El Asesor compara equipo Rare
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
executor ni operación de reciclaje. El lote no forma parte de `0.1.13` y todavía no acredita QA visual
o ejecución dentro de Obsidian.

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
y 2.015 tests, además de seguridad, contratos, build y paquete. El lote todavía no forma parte de la
release `0.1.13` ni acredita llamadas reales a `/v2/commerce/listings`, QA visual o ejecución dentro
de Obsidian.

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
y 1.999 tests, además de seguridad, contratos, build y paquete. Este lote todavía no forma parte de
la release `0.1.13` ni acredita QA visual o ejecución dentro de Obsidian.

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
y 1.988 tests, además de seguridad, contratos, build y paquete. Este lote todavía no forma parte de
la release `0.1.13` ni acredita QA visual o llamadas reales a la API desde Obsidian.

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
ficheros y 1.968 tests, además de seguridad, contratos, build y paquete. Este lote todavía no forma
parte de la release `0.1.13` ni acredita QA visual o instalación en Obsidian.

**Release beta `0.1.13` publicada el 2026-08-29.** El tag y commit
`1fe6c4ca2e0b0713f7c71e27a6f24c8f425fa42a` están disponibles en la
[GitHub Release pública](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.13). BRAT puede
instalarla porque la release adjunta `manifest.json`, `main.js` y `styles.css` como assets
individuales. El ZIP reproducible tiene SHA-256
`133cb03e5b8bbcd694065360fce37620bf1bc8cfa208d69908d5c73e864ba9f2`. La publicación no acredita
todavía la instalación, actualización, QA visual ni entrega real de avisos dentro de Obsidian.

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

**Foundation, conexión GW2, H1.4 coordinación, H3.1–H3.10 lifecycle/detección/revisión/calidad local, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta`, H2.7 contaminación, economía H4.1–H4.19, UI/assets H5.1–H5.12 y contratos H8.1/H8.4: implementados. H8.2 aporta el spike, con su QA humana ya ejecutada y completa en Linux/Steam/Proton, H8.3 la decisión, H8.5 el helper/servidor Rust aislado, H8.6 el cliente core TS, H8.7 una frontera safe-launch sin executor y H8.8 una política shadow pura de presencia/ausencia; launcher real, composición del plugin, firma, publicación y QA real siguen pendientes. H8.7/H8.8 permanecen `@wip`.**

**H8 (Mumble v2) queda congelada por decisión de producto del 2026-08-18** hasta que cierre
H8.2, que tiene dos pasos: compilar el PE del spike y leer MumbleLink dentro de la botella
durante una sesión real. El paso 1 cerró el 2026-08-18: el PE compila con `zig` como driver de
C y su tabla de importación censada con `llvm-readobj` no trae ni `OpenProcess` ni
`ReadProcessMemory`. El paso 2, ejecutarlo dentro de la botella con GW2 corriendo, sigue
pendiente y es exclusivamente humano. Congelar no cuesta nada al MVP: cero consumidores de
`src/platform/` fuera de sí mismo, y `esbuild.config.mjs` mantiene `treeShaking: true` al
entrar por `src/main.ts`, así que nada de H8 viaja en el ZIP.

**Arranque del plugin diferido a `onLayoutReady`.** `onload()` esperaba el bundle de assets
gestionados, el hash del vaultId, varias aperturas de IndexedDB, `sessions.initialize()` y
`refreshLootPresentation()` antes de registrar las vistas; un leaf `tyrian-companion-*`
guardado podía restaurarse contra un view type todavía sin registrar y bloquear el arranque de
Obsidian. Ahora `onload()` registra las dos vistas, el setting tab, los cinco comandos, los
comandos de sesión y los listeners de DOM antes de cualquier otro `await`, y termina con
`workspace.onLayoutReady`; el resto se movió sin cambiar el orden a `initializeRuntime()`. Entre
ambas fases una guarda `runtimeReady` da valores neutros y el aviso `notices.pluginStarting`
(ES/EN); `onunload()` marca `unloaded` antes que nada. Test de la propiedad de orden,
verificado en rojo con sabotaje.

**Gate del repo aislado de los worktrees de agente.** Un worktree de agente bajo `.claude/`
es una segunda copia entera de `src/`: medido con uno presente, `vitest list --filesOnly`
devolvía 226 ficheros de test (113 bajo `.claude/`) y `scripts/h8-native-decision-contract.mjs`
ponía `npm run check` en rojo con 20 hallazgos `forbidden-product-artifact`, todos dentro de
`.claude/worktrees/`. Excluido en `vitest.config.mts`, `eslint.config.mts`,
`scripts/h8-native-decision-contract.mjs`, `scripts/security-scan.mjs` y `.gitignore`;
verificado que el contrato sigue mordiendo con una copia no revisada real. `tsconfig.json`
pasa `moduleResolution` de `node` (modo node10 retirado) a `bundler`, el modo que corresponde
al build vía esbuild.

**H7.4 está implementado técnicamente y H7.5 distribuye `0.1.13` mediante GitHub Release y BRAT.** El
release package parte de un build nuevo, contiene únicamente `manifest.json`, `main.js` y
`styles.css`, valida versiones y tag, escanea los bytes staged y genera ZIP reproducible + SHA-256
con prueba causal. CI conserva permisos de solo lectura, recrea un staging enumerado y sube
exactamente ZIP, checksum e instalador tras el gate.
El instalador verifica de nuevo paquete e identidad, serializa instalaciones, revalida directorios y
estado antes de operar, escribe solo los tres ficheros gestionados y revierte fallos bajo la misma
autoridad desde los bytes originales capturados; backups alterados y fallos de cierre del lock quedan
en rojo sin dejar aplicada la versión nueva. El staging relee y compara los tres bytes antes del upload
y el censo impide otra acción de artifact. Una sustitución de directorio se bloquea sin tocar el destino
ajeno. El tag y la GitHub Release `0.1.13` publican los tres assets individuales requeridos por BRAT;
la instalación/actualización real en Obsidian sigue pendiente de QA humana en las plataformas
soportadas.

**H7.2, H7.3 y H7.6 están implementados técnicamente, sin afirmar QA humana.** El README conduce desde
un artifact verificado hasta la primera sesión, explica que **Open companion** abre la vista y que
**Finish farming session** solo aparece tras un inicio realmente activo, separa modo manual/asistido y
expone límites de exactitud e Inventory Advisor. La guía de clave distingue conexión-only, mínimo real
`account + characters + inventories + builds` y permisos opcionales de cobertura. Soporte aporta un
issue form cerrado con versión, plataforma, origen, detección, fase y reproducción; prohíbe secretos,
identidad, rutas, inventario/snapshots, IndexedDB y salida sin redactar. El contrato ejecutable y sus
sabotajes impiden relajar esos campos o habilitar issues en blanco en silencio.

**H7.1 fija la identidad de la release publicada.** El ID `tyrian-companion`, el nombre
**Tyrian Companion**, el autor público **David**, el repositorio `fodaveg/tyrian-companion` y la
licencia MIT quedan ligados por un contrato ejecutable. La comprobación oficial fijada del
2026-08-16 no encontró colisiones de ID o nombre en registros activos ni retirados de Obsidian.
El repositorio y la release `0.1.13` son públicos desde el 2026-08-29.

H5.10 añade exportación manual y fail-closed del historial durable: solo consume notas H5.4/H5.7 íntegras, ordena resultados de forma determinista y crea JSON/CSV sin contenido humano ni identificadores crudos. Ajustes ofrece además un scrub warning explícito con preview y confirmación ES/EN: un token efímero ligado a bytes/path/ref, consumido o revocado en toda salida, usa `Vault.process` CAS para quitar solo `tc_*` y los seis bloques intactos, sin papelera ni borrado físico. Una autoridad compartida excluye transiciones de sesión, recovery y detector durante el scrub y relee el runtime antes de cada escritura.

**H0.4, H0.6, H8.1 y H8.4: política y contrato v2 documentados; H8.5/H8.6 implementan ambos extremos, H8.7 prepara el lanzamiento sin executor y H8.8 añade la política shadow aislada, pero integración, validación multiplataforma y piloto siguen pendientes.** El MVP es
API-only con Linux + Steam/Proton como plataforma primaria, macOS + CrossOver como secundaria y
Windows en beta. H8.1 fija Mumble Link para v2 como helper IPC opt-in de mapa/actividad: defaults
revisables deshabilitado/shadow/on-when-armed, API v1 autoritativa,
confirmación humana, raw no persistente, payload mínimo, `initialSequence:0` y transporte loopback
fail-closed. Las tasas de falso inicio/parada, recovery y precisión
temporal tienen definición, muestra mínima y umbrales verificables en
[Política de plataformas e integraciones](PLATFORM_POLICY.md).

El contrato H8.1 permanece declarativo bajo allowlist AST recursiva. El censo productivo permite
exactamente ese contrato, los módulos TS puros H8.6/H8.7/H8.8 y los seis módulos Rust H8.5; el scanner
y sabotajes mantienen en rojo cualquier módulo/helper adicional o capacidad de sesión, store, red,
filesystem, logging o timer global. La API oficial confirmó el mapa `866` como **Mad King's
Labyrinth / Laberinto del Rey Loco**. No existe executor host, composición, setting ni conexión
con H3.8/H5.3; el adapter H8.7 sigue siendo una frontera pura e inyectada.

H8.2 aporta bajo `spikes/h8-mumble-crossover/` un decoder C portable, un wrapper PE de lectura
`FILE_MAP_READ`, muestreo best-effort de pares completos idénticos con ocho intentos, fixtures
adversariales tick-igual/map-híbrido y tearing, guard de censo/capacidades, ASan/UBSan y sabotajes
causales de offset/5.460/512/ocho pares/entero seguro. El guard fija una sola apertura y un solo map
read-only, censa llamadas/sumideros del core, wrapper, stub y script, y mantiene `npm run check` sin
Wine/CrossOver ni copias fuera del temporal. El extractor léxico no acepta llamadas buenas fingidas
en comentarios/literales y detecta el permiso decimal `2u`; el host usa un contrato positivo byte a
byte de todos sus comandos y destinos temporales, no una blacklist. El preprocesador del wrapper
está igualmente cerrado a un define inocuo y cinco includes exactos:
no puede redefinir permisos, nombre del mapping, bytes del view ni introducir aliases contractuales.
Además, la lane usa el mismo `cc` y stub para generar el wrapper preprocesado y valida allí los
argumentos expandidos `0x0004u`, `MumbleLink` y `5460u`; hashes exactos cubren wrapper, core header,
stub y validador. Redefiniciones desde headers, `%:` o continuaciones de línea quedan rojas por el
resultado efectivo, no por una blacklist de grafías.
No se presenta como seqlock ni como snapshot coherente: dos
lecturas híbridas idénticas siguen siendo un riesgo residual y la señal permanece shadow. El primer host inspeccionado fue macOS 26.6.1 ARM,
con CrossOver 26.3.0 y botella win64 `Guild Wars 2`, sin MinGW/LLVM Windows cross-compiler: allí el
test portable quedó verde pero no se instaló nada, no se copió nada a la botella ni se ejecutó un PE.
Esa sigue siendo la situación de macOS/CrossOver.

**QA humana ejecutada el 2026-08-19 en Linux/Steam/Proton.** Host Fedora Linux 44, kernel
`7.1.8-200.fc44`, `mingw64-gcc` 16.1.1 y `protontricks` 1.14.0; PE x86-64 compilado fuera del prefijo
en `/tmp` y lanzado con `protontricks-launch --appid 1284210` y `STEAM_COMPAT_DATA_PATH` sobre el
prefijo `compatdata/1284210`, que corre **GE-Proton11-5**, no Proton estable de Valve. No se instaló
ni copió nada dentro del prefijo. Resultados:

- **Muestras repetidas:** dos tandas de diez ejecuciones con el juego abierto y el personaje quieto.
  Las veinte devolvieron una única línea JSON con `sequence:0` y `activity:"link_advancing"`, cada una
  con su nonce de 128 bits distinto y correctamente devuelto, y con `uiTick` estrictamente creciente
  (13.625→16.962 y 572→4.131, saltos de 353-405). No se observó ninguna pareja de lecturas idéntica.
- **Transición de mapa:** `mapId` pasó de `1442` a `1595` al cambiar de zona, contrastados contra
  `api.guildwars2.com/v2/maps` como Seitung Province y Shipwreck Strand.
- **Reinicio del juego:** tras cerrar y reabrir GW2 el `uiTick` se reinició de 16.962 a 572 en el
  mismo mapa, lo que ata la señal al proceso vivo y descarta que se estuviera leyendo un mapping
  rancio superviviente.
- **Contrato de payload:** ningún frame contuvo identidad, personaje, coordenadas, identificadores de
  proceso ni contexto crudo.
- **Control negativo:** con GW2 cerrado, diez ejecuciones consecutivas no emitieron frame. El wrapper
  no imprime nada cuando falla y solo señala por código de salida, así que se repitió una corrida sin
  tubería y sin silenciar stderr: devolvió `exit=2`, o sea `TC_MUMBLE_PROBE_VIEW_TOO_SMALL`, que es lo
  que retorna el wrapper cuando `OpenFileMappingW` da `NULL`. El stderr de esa corrida trae
  `ntsync: up and running` y los `loader_init` de wine-staging 11.0, de modo que el proceso Windows sí
  arrancó y la salida vacía no se explica por un lanzamiento fallido.
- **Propagación del código de salida:** para descartar que ese `2` lo produjera `protontricks-launch`
  y no la sonda, se lanzó el mismo PE sin argumentos, que por su propio `main` debe devolver
  `TC_MUMBLE_PROBE_INVALID_ARGUMENT`. Devolvió `exit=1`. El canal transmite el código del PE sin
  alterarlo, así que el `2` del control negativo significa lo que dice.

Por tanto la lectura estable durante una sesión real, las transiciones, el reinicio y la ausencia de
mapping con el juego cerrado dejan de ser QA pendiente **en Linux/Steam/Proton bajo GE-Proton**;
quedan abiertos Proton estable de Valve, macOS/CrossOver y Windows nativo. El riesgo residual de dos lecturas
híbridas idénticas no queda refutado por estas veinte muestras: no se observó, que no es lo mismo que
no poder ocurrir. La señal permanece shadow y la API sigue siendo autoritativa.

**H8.5: helper/servidor Rust implementado, sin integración del plugin ni publicación.** El crate
`native/mumble-helper` implementa framing/JSON estricto, auth constant-time + zeroize, nonce y
secuencia compartida, proyección de cadence y adapter Win32 read-only de cuatro campos/ocho pares.
Un watchdog stdin y event loop acotado prueban EOF, slowloris, cliente extra, reconnect con token del
mismo proceso y nonce/secuencia nuevos. Cargo host está verde; CI Windows debe confirmar PE x64,
CRT estático y reproducibilidad y solo puede conservar un marker `UNSIGNED-NOT-FOR-RELEASE` por un
día. Windows, Proton y CrossOver siguen `QA=pending`; Authenticode, package productivo, launcher,
settings y UI siguen pendientes. Por tanto H8.5 está implementado, pero no cerrado para release.

La cadencia servidor consume raw tick/map/status: primer slot a 500 ms, warm-up sin historia,
segundo válido abre época advancing, stalled exacto a 1.500 ms, lateness reprogramada desde now y
`heartbeat_timeout` exacto a 2.000 ms sin emitir ni recuperar slots perdidos.

**H8.6: núcleo aislado del cliente TypeScript implementado, sin launcher ni wiring.** Cuatro módulos
puros aportan codec incremental cerrado, lifecycle por puertos inyectados de proceso/TCP/reloj/CSPRNG,
salud en tres ejes y observación shadow memory-only de `mapId + activity` bajo `enabled && armed`.
Token por proceso, nonce por conexión, secuencia `0,+1`, deadlines y generaciones fallan cerrados;
callbacks externos quedan aislados ante throw/reentrada. Restart y reconnect comparten el backoff
`[250,500,1000,2000,5000]`, que solo se resetea tras `healthy`. No hay imports Node, I/O ambiente,
timers globales, sesiones, stores, captura, persistencia ni logging. Las 42 pruebas H8.6 cubren
fragmentación/coalescing/huge, replay/gap/wrap, primer sample, helper exit/backoff, callbacks stale,
salud unavailable vs stalled y sabotajes arquitectónicos. Launcher real, composición en `main`,
settings/UI, packaging y QA de plataforma siguen pendientes.

**H8.7: frontera safe-launch aislada implementada, todavía `@wip`.** Tres módulos puros fijan
config/route/diagnostic cerrados y planes exactos para Windows, CrossOver `wine` y Proton
`protontricks-launch`. AppID `1284210`, `MumbleLink` y launchers son constantes; no hay
args/env/shell/command/mapping libres. Package/bottle/compat-data son estrictos y efímeros; el plan
usa `shell:false` y tres pipes. El adapter abre el paquete H8.5 canónico de cinco ficheros antes de
cada intento, valida manifest + cuatro checksums y delega solo una capability opaca ligada a
bytes/digests, nunca un helper path re-resoluble. Drena stderr, aplaza un stdout inline de máximo 516
bytes y revalida antes de abrir la entrega; overflow, segundo evento, exit o un aplazamiento inline
cierran el handle una vez, publican diagnóstico saneado y notifican exit a H8.6. Stop es idempotente. El resultado se etiqueta
solo `integrity_checked` / `unsigned_qa_only`: no autentica
origen. No hay Node, spawn real, settings/UI/main/onload, persistencia, composición ni QA. Un executor
futuro debe exigir trust anchor de release o Authenticode y revalidar cada arranque/restart.
Las 25 pruebas H8.7 —16 funcionales y nueve arquitectónicas— cubren planes/plataformas/paths,
paquete compartido H8.5, artefactos corruptos, capability/TOCTOU, stderr/stop, callbacks acotados y sabotajes
de capacidades, incluido un único call-site de capability dentro del método hasheado y hash del adaptador completo; scanner v13 y
guard v17 mantienen el censo exacto.

**H8.8: política shadow de presencia/ausencia implementada en aislamiento, todavía `@wip`.** El
reducer puro solo acepta el mapa objetivo `866`: fija presencia tras 5.000 ms de crédito y ausencia
tras 60.000 ms de crédito. La primera solo acumula en idle y la segunda durante una sesión
ligada; cada record aporta como máximo 500 ms. Gaps, heartbeat/source degradation, `link_stalled`, caída de canal y
recovery reinician o degradan la ventana y nunca se interpretan como ausencia. Cada latch produce
como máximo un DTO efímero con evidencia `limited` y review `human_required`; muestras posteriores
del mismo estado no lo reemiten. La señal liga `accountId` dentro de su contexto efímero en idle y
sesión; un cambio de cuenta reinicia ventana y latch. El DTO no entra en la cola H5.3, no persiste,
no llega a UI y no invoca captura ni lifecycle. La API sigue siendo autoritativa. Faltan composición, métricas
comparativas y QA humana en Windows, Linux/Steam/Proton y macOS/CrossOver.

**H8.3: ADR de lenguaje/artefacto que autorizó la implementación.** Se elige Rust
provisionalmente, target único `x86_64-pc-windows-msvc` con CRT estático, fuente futura
`native/mumble-helper` y un único `tyrian-mumble-helper.exe`. El ZIP será separado del plugin y
llevará manifest, checksums y licencias. Linux/Steam/Proton primaria, macOS/CrossOver secundaria y
Windows x64 beta siguen `QA=pending`; ejecución nativa Linux/macOS, Windows x86/ARM64, móvil y Wine
fuera de Steam/Proton/CrossOver quedan unsupported. Authenticode sigue pendiente y bloquea release.
El guard v17 y sus sabotajes mantienen un censo positivo, incluido el orden causal que publica
shutdown antes de desconectar stdin para que EOF previo al bootstrap sea limpio también en Windows. Fuera de
docs/examples/fixtures/tests, fuente Rust/C#, configuración Cargo/toolchain exacta y señales de
prefijo Mumble Link por path o contenido quedan censadas globalmente; outputs
EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA tracked/no ignorados y symlinks relevantes siempre fallan. Un PDB
efímero de MSVC se permite únicamente bajo `target`; staging, paquete y artefacto CI lo rechazan.
Un `bridge` genérico continúa permitido. El bloque JSON, el ADR y `PLATFORM_POLICY.md` completo tienen
parsing/hash canónicos, de modo que `QA completada` tampoco puede añadirse al final del documento.
H8.5/H8.6 aportan servidor y cliente core y H8.7 el plan/adapter inyectado, pero no wiring del plugin ni artefacto publicable.

**H8.4: protocolo IPC local cerrado; H8.5/H8.6 lo implementan aún sin composición.** Helper servidor y
plugin cliente quedan fijados a TCP IPv4 `127.0.0.1`, bind port `0`, bootstrap/ready por
stdin/stdout y hello/welcome TCP. Todos los records usan `uint32` big-endian + JSON UTF-8 1..512 y
buffer incremental máximo 516 incluso con chunks enormes; los seis schemas, credenciales base64url,
binding bootstrap→hello y comparación constant-time, secuencia
conjunta heartbeat+sample, un único record por llamada debida de 500 ms —sample derivado de tick/map
raw sustituye heartbeat y satisface liveness—, calentamiento sin retener tick, segunda lectura como
nueva época advancing, borrado de tick/startedAt en source-status y primer record limitado a
heartbeat, stalled exacto 1.499/1.500 ms, lateness sin catch-up y fallo `heartbeat_timeout`, deadlines
2.000/5.000 ms, lifecycle,
backoff y errores están cerrados en el modelo y ADR parseable con igualdad/orden/hashes completos.
Los tests cubren framing fragmentado/coalescido/truncado, parser estricto, token/nonce y superficies,
host/puerto/versión, replay/gap/regresión/overflow/stale nonce, tick rollover, fake clock/sleep,
records fuera de fase, routing total de helper-exit —incluido reconnect—, token/puerto/nonce nuevos,
samples que renuevan salud, reset solo healthy, reconnect/EOF, high-water simultáneo sin copia,
cadencia con fake clock, recovery con tick stale, salto de 60 s y sabotajes de catch-up,
doble/ningún record, warm-up infinito, sample prematuro, heartbeat `healthy`, source status y datos
prohibidos. El censo conserva el contrato y los módulos H8.5/H8.6/H8.7/H8.8 exactos, sin importadores desde
`main`. No existen executor host, composición, settings/UI o packaging productivo; API
v1 sigue autoritativa, shadow, human-confirmed y sin persistencia.

H5.1 sustituye la portada de tarjetas por una bitácora compacta con fase y reloj de sesión, rail de detector/polling/calidad/cuenta, incidencia priorizada y detalles plegables; no añade red ni acciones automáticas.

H5.2 añade paleta y un único ribbon contextual para start, finish/retry, review, recover, discard confirmado y clear confirmado, siempre mediante los workflows existentes y con revalidación ante estado stale.

H5.3 añade una cola local durable para propuestas asistidas: enqueue previo al rearmado, intención exacta, claims renovables cercados por operación/ventana, receipts tras resolución, reconcile de identidad y una única propuesta visible con contador. El fondo solo actualiza indicadores existentes in-place: no reconstruye la vista, muestra notices/modales/notificaciones, enfoca, revela vistas ni ejecuta transiciones de sesión.

H5.4 genera mediante Vault una nota de sesión completa antes de permitir limpiar el runtime. Usa referencias SHA-256, ruta UTC, frontmatter `tc_*` estable y managed blocks hasheados; conserva tags/frontmatter/cuerpo humano y falla cerrado ante identidad, colisión o edición ambigua.

H5.5 deriva desde la evidencia H5.4 una única presentación de botín para nota y Companion: cambios netos, destino reservado/retenido/libre, subtotal económico y recomendación manual. Respeta permisos H2.7 y falla cerrado ante incoherencias H4 sin ocultar las filas físicas observadas.

H5.6 añade el motor genérico de assets administrados y una Base neutral. Preview no escribe; install/upgrade/repair usan manifiesto v1, CAS exacto y journal durable reanudable. Rutas inseguras, assets ajenos/modificados y formatos futuros fallan cerrados. Move instala destino antes de cambiar el puntero y Remove manda solo bytes propios exactos a la papelera de Obsidian, conservando manifiesto detached.

H5.7 sube las notas a schema v2 con evento, fuente manual/asistida correlacionada y recomendación histórica validados, y registra `Halloween.base` ES/EN en el bundle v2 sin un segundo writer. Sus cinco vistas filtran el evento explícito, separan cero de ausencia y reservan g/h a sesiones exactas, de confianza alta y cobertura completa. Falta QA manual en una bóveda desechable compatible con Bases; no se ha tocado la bóveda canónica.

H5.8 centraliza el contrato de rutas Vault para settings, notas y assets: solo NFC relativo con `/`, sin segmentos de navegación/configuración, controles/surrogates inválidos, nombres reservados de Windows ni longitudes que comprometan Sync. Settings v4 se reescribe de forma canónica al normalizar: elimina propiedades desconocidas y solo conserva las rutas pre-H5.8 autorizadas en `legacyOutputFolder`/`legacyManagedAssetsRoot`, read-only y sin alterar el puntero de assets. Move/Remove inspeccionan siempre la raíz heredada y rechazan un puntero divergente o manifiesto no exacto. Move exige estado ready incluso si el puntero ya la nombraba. Un Remove reintentado reconoce ese manifiesto exacto ya detached sin escribir ni volver a adoptarlo solo con puntero inicialmente vacío e idéntico tras la inspección, para terminar la limpieza de settings tras perder una respuesta. Una reubicación explícita instala primero el destino seguro y después elimina solo bytes propios de esa raíz. Manifiesto y journal ligan id/kind/locale/path y hashes previos permitidos; ready/detached exigen el conjunto exacto del bundle actual sin romper manifiestos compatibles previos. Las notas de sesión usan UTC y hashes; las de inventario usan item, fuente y hash. Ningún nombre incorpora cuenta, nombre de personaje, evento o ruta local.

H5.9 centraliza el texto visible ES/EN en un catálogo tipado con paridad de claves/placeholders: ajustes, Companion, incidencias, acciones, menús, modales, notas, botín y Bases cambian sin alterar IDs, enums, `tc_*`, hashes, rutas o consultas de Bases. La interfaz abierta se repinta y el bundle gestionado cambia con el idioma; los comandos ya registrados por Obsidian adoptan el nuevo nombre tras recargar el plugin.

H6.1 fija por regresión las seis direcciones entre personaje, banco y materiales —incluido split/merge— y comprueba holdings y composición exactos sin generar loot ni disponibilidad falsos. H6.2 recorre el workflow durable completo para apertura, reciclaje, compra en bazar y compra a mercader: persiste la revisión, reinicia una segunda instancia y conserva clasificación contaminada y permisos; la actividad del bazar sigue siendo una declaración explícita, no observación automática.

H6.3 fija que jackpots excluidos no alteran el EV ni la decisión y que un precio TP cero permanece `null/partial`. H6.4 recupera `stopping` y `provisional` sin recapturar evidencia, y prueba la cancelación real del modal sin backend ni mutación; no existe una acción inventada de cancelar sesión activa. H6.5 cubre 500/502/503/504 reintentables, 401/403/501 fatales y agotamiento 5xx con error saneado.

H6.6 añade un benchmark reproducible de cuenta grande, aislado de I/O: fuerza una primera pasada divergente y dos convergentes mediante la ruta pura productiva, finaliza snapshots estables, los compara, clasifica la frontera y valora 4.840 ganancias. Sus 21 muestras fijan mediana/p95 y la retención acumulada contra un baseline único post-warmup; CI prueba verde y sabotaje de heap explícito en Node 22 y 24, sin usar la duración de Vitest como evidencia.

H6.13 (`abea4e1`) corrige la sesión cuando un personaje devuelve `404` entre la pasada base y la de cierre. El diagnóstico inicial era al revés: la clasificación salía `invalid` y se perdía el delta entero de la cuenta, y `manual-session-start-service.ts` exigía una referencia de snapshot estable antes de calcular el delta, así que el 404 dejaba el `stop()` colgado en `stopping`. Ahora una pasada cuyo único hueco es `missing_character` no se descalifica, el personaje ilegible se excluye de las dos proyecciones con el delta en `limited` y el aviso nuevo `character_unobserved`, que degrada la clasificación a `estimated` en vez de `contaminated`. Un `500` (`unavailable`) sigue invalidando el delta entero por decisión de producto asumida, pendiente de ratificar por David si el 404 excusable entra en el gate de v1 (H7.8) o se aparta a post-MVP.

H6.16 sustituye cuatro suites de test de `src/advisor/` y `src/economy/` que leían el texto fuente con expresiones regulares por tests de comportamiento ejecutados, y añade `src/test/module-boundary.ts` y `src/test/ambient-capabilities.ts`. El sabotaje S14 (meter `this.ports.invalidate?.()` dentro de `current()` del controller del Inventory Advisor) probó que la regex conservada no se ponía roja y el test de comportamiento nuevo sí: los guardarraíles léxicos declaraban más cobertura de la que tenían.

H4.13 define la frontera pura del Inventory Advisor para `supported_storage_v1`. Liga snapshot, catálogo, precios, objetivos, excepciones de conservación, señales de cuenta y rule pack hasheado; valida particiones exactas de toda la propiedad por posición y devuelve un envelope manual separado del envelope de sesión. No existe acción `destroy`: `discard_candidate` requiere regla curada y permanece revisión irreversible. H4.14 captura la evidencia, H4.15 clasifica y H4.16 aplica la allowlist pura. H4.18 aporta un bundle built-in v2 inmutable y source-backed para 36038. H4.19 extrae el kernel económico H4.10 independiente de sesión, captura en Refresh el saco y sus ocho outcomes líquidos y liga modelo/regla/knowledge/TTL/cobertura/binding/reservas/excepciones. David aprobó regla y economía el 2026-08-16: evidencia completa y fresca puede recomendar manualmente `open|sell|vendor` para 36038 con margen fijo del 10%; evidencia parcial o incoherente sigue en revisión y descarte continúa deshabilitado. Los demás items pueden mostrar la mejor salida líquida manual respaldada sin habilitar uso/abrir/reciclar. H5.11 conecta una vista separada ES/EN: Open no captura; Refresh es el único trigger y compone las capas con single-flight/latest-wins. La vista captura en una sola pasada acotada bolsas de personaje+compartido como núcleo, y banco, materiales y delivery como ámbitos opcionales desmarcados por defecto. Cada control muestra cobertura saneada y se deshabilita si su fuente no fue leída; un 403 opcional no bloquea el núcleo y un 401 conserva el fallo global de credencial. Añade icono oficial, progreso indeterminado, un único reintento de pasada parcial y conserva el último resultado solo ante `capture_unavailable`. H5.12 añade el editor plegable local de objetivos y excepciones. H6.11 está cerrado por auditoría automatizada; sigue pendiente la QA visual/manual ES/EN de la ruta activada.

El inventario durable está integrado en el Inventory Advisor como flujo manual independiente:
Preview captura las cuatro fuentes físicas completas y prepara un plan Vault-only; Apply relee y usa
CAS. El writer genera una nota por objeto, ubicación y personaje, suma pilas del mismo personaje y
marca stale como inactivo/cero sin borrar archivos. No persiste cuenta, snapshot, token ni payload
raw. El bundle gestionado v5 conserva `Inventory.base` y `Materials.base` ES/EN con orden numérico por
valor y corrige sus nombres visibles mediante `properties.note.tc_*`. Falta QA visual/manual dentro de Obsidian y comparación contra los scripts legacy antes de que
David los retire.

H4.19 añade el kernel económico independiente de sesión, el adapter/pack de economía del Advisor, captura hermana de precios, integración contextual y guards causales. Gate completo verificado: lint, 94 ficheros/1315 tests, release-preflight, scanner de seguridad y build en verde.

El hotfix de datos reales del Inventory Advisor alinea el catálogo JSON, respuestas parciales 206,
la captura hermana H4.19 y la allowlist contextual. Una lectura real de solo lectura produjo snapshot
estable con las seis fuentes completas y una presentación `limited` de 1.206 objetos/1.701 posiciones,
todas en revisión manual; la clave y los endpoints requeridos respondieron correctamente.
Cada Refresh reemplaza un recibo diagnóstico local saneado con estado, duración y cobertura por
pasada/fuente; excluye secreto, identidad, personajes, objetos, URLs y cuerpos, y nunca se sube.
La QA visual real aisló `snapshot_invalid`: el Advisor heredaba el contrato account-wide y exigía banco
y materiales estables aunque estuvieran desmarcados. El flujo ahora captura únicamente personaje +
inventario compartido, valida ese scope de forma independiente y conserva fail-closed las fuentes básicas;
banco/materiales/delivery no se consultan ni pueden bloquearlo. La clasificación distingue cobertura de
estabilidad: una única pasada completa se conserva como `unstable/limited`, muestra rutas líquidas
manuales y retiene usar/abrir/reciclar. Cada intento consulta una vez roster, inventario compartido y
personajes serializados con timeout de 30 segundos; solo una pasada parcial transitoria repite el
conjunto. El clasificador evalúa catálogo/precio por objeto: un batch TP parcial no oculta las filas
con precio presente ni las rutas de mercader con omisión demostrada; en esa QA, el pack todavía pendiente
retenía sus capacidades curadas. La vista prioriza ahora una cola directa «Qué hacer ahora» y relega
`keep|review|discard_review` a controles de contexto. Gate: 106 ficheros/1481 tests en
verde; queda pendiente repetir
la QA manual del plugin instalado y confirmar filas reales visibles.

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 define el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`. H3.2–H3.10 cubren captura manual, recovery durable, detección asistida explícita, revisión de contaminación y medición local de calidad. H4.1–H4.12 añaden valoración, reservas, intenciones y recomendaciones manuales puras; no operan sobre la cuenta. H5.12 persiste objetivos y excepciones locales con CAS explícito. No hay persistencia de recomendaciones, operación sobre la cuenta ni escritura libre en el vault: H5.4 solo genera notas completas con bloques gestionados, H5.6 solo modifica assets tras una operación explícita y H5.10 exporta o scrubbea únicamente mediante acciones explícitas. El panel/agregación del historial sigue pendiente.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 115 ficheros y 1.579 tests verdes (la sesión empezó en 1.562: sube con H6.13 y
  con la poda de guardarraíles léxicos de H6.16), incluidas las 2 pruebas nuevas del orden de
  arranque diferido, las 13 del cooldown 429 compartido H6.12, 42 pruebas H8.6 —33 funcionales y nueve
  de arquitectura—, 25 H8.7 —16 funcionales y nueve de arquitectura— y 25 H8.8 —17 funcionales y
  ocho de arquitectura—, los contratos H8.1/H8.4 y el
  verifier de supply-chain/staging H8.5, más la lane C H8.2 normal/ASan/UBSan, syntax-check del
  wrapper y cinco sabotajes causales. Rust añade 14 unitarios y ocho lifecycle verdes.
- `npm run check` (gate completo): vitest, eslint, `scripts/h8-native-decision-contract.mjs` y
  `scripts/security-scan.mjs` excluyen los worktrees de agente bajo `.claude/`; exit code 0 en 42
  segundos sobre el árbol final (`69dc795`), 115 ficheros/1.579 tests más las ocho suites de scripts, el
  scanner de seguridad y el build. `src/eslint-default-project-config.test.ts` y
  `src/platform/mumble-v2-shadow-architecture.test.ts` dejan de caer al azar por presupuesto de
  tiempo: presupuesto explícito de 30 s y lectura del árbol de `src/` memoizada con copia por
  llamada. Ninguna aserción cambia y sus controles negativos siguen poniéndose en rojo.
- `npm run test:security-scan` y `npm run security:scan`: scanner v14 y sabotajes verdes.
- `npm run test:release-identity-contract`: identidad H7.1 y veinticuatro sabotajes causales verdes.
- `npm run test:beta-channel`: instalación, actualización, exclusión mutua, rollback y matrices
  causales de ZIP, rutas, symlinks, TOCTOU, CLI, staging y artifact CI verdes; no sustituye la QA
  dentro de Obsidian.
- `npm run build`: TypeScript y bundle de producción verdes; H8.7 no entra en `main` ni ejecuta proceso alguno.
- `npm run release:package`: paquete de tres archivos, checksum y segunda ejecución byte a byte reproducible en verde; debe regenerarse tras integrar cualquier otro lote.
- `npm run bench:h6-performance` y su sabotaje de heap: verdes en Node 24.19.0.
- H7.2/H7.3/H7.6 añade `test:support-contract`: formulario, docs y dieciocho sabotajes causales verdes;
  `npm run check`, benchmark, sabotaje de heap y `git diff --check` pasan en este worktree. No existe
  todavía evidencia de instalación, primera sesión o soporte real en dispositivo.

## Pendientes de producto

1. Repetir el spike H8.2 en macOS/CrossOver, Windows nativo y Proton estable de Valve, donde todavía no se ha ejecutado ningún PE; después implementar executor con trust anchor y composición de H8.5/H8.6/H8.7/H8.8, ejecutar QA separada —incluidos los latches 5 s/60 s, gaps, stalled, heartbeat y recovery— en Linux/Steam/Proton, macOS/CrossOver y Windows x64 antes de salir de shadow, y resolver firma/licencias antes de release.
2. Ejecutar la matriz H0.4 por plataforma y reunir la muestra del piloto H0.6; `0.1.0` conserva observaciones H3.10 locales, pero aún no agrega ni exporta las métricas.
3. Diseñar el panel/agregación del historial durable de sesiones finalizadas. Ya tiene tarea en Lumbre: H9.7.
4. Ejecutar QA manual ES/EN de la recomendación activada para 36038 con evidencia real completa y parcial.
5. Cerrado por H6.13 (`abea4e1`): un personaje que devuelve `404` (`missing_character`) entre pasada base y de cierre se excluye de las dos proyecciones y el delta pasa a `limited` con el aviso `character_unobserved`, en vez de invalidar el delta entero de la cuenta. Un `500` (`unavailable`) sigue invalidando el delta entero. Decisión de producto pendiente de ratificar por David: si ese criterio del 404 excusable entra en el gate de v1 (H7.8) o se aparta a post-MVP; hoy queda etiquetado `#v1` sin que él lo haya decidido.
6. ~~Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.~~ Cerrado por H6.12 (`7f97d44` y `61a20dc`): `RateLimitCoordinator` comparte un único enfriamiento entre captura de sesión, detección asistida e Inventory Advisor, y lo arma también con el 429 de una fuente opcional que `captureSource()` convierte en cobertura parcial de una captura que resuelve. Los reintentos por petición siguen siendo del transporte. Queda pendiente el copy de superficie por razón en `failureLabel()` de `src/ui/companion-status-model.ts` para los fallos de inicio y fin de sesión, que hoy leen el mensaje genérico: la conexión sí muestra el enfriamiento mientras corre. Va con la QA visual de H6.9.
7. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
8. ~~Consultar el historial TP para complementar la declaración manual H3.9.~~ Cerrado por H9.8
   (`3e84514`, `ed7f8b8` y `f825621`): el modal puede proponer compras y ventas desde un historial
   completo de hasta 90 días, pero solo la confirmación humana modifica la revisión.
9. Hacer QA manual de H3.2–H3.4 en dos ventanas y, si Obsidian comparte el origin, dos procesos reales: doble clic, stop/retry, reload, cierre forzado, recuperación/descarte y pérdida del lease.
10. Instalar/actualizar `0.1.13` desde BRAT en una bóveda desechable por plataforma, verificar que los
    tres assets corresponden a la release publicada y registrar el resultado; la publicación y el canal
    BRAT ya están activos, pero no acreditan esta QA.
11. Ejecutar el protocolo de QA manual que piden H6.8 y H6.9: instalación en una bóveda desechable, sesión real y matriz de plataforma documentadas en `docs/QA-MVP.md`; una guía preparada no acredita una prueba superada.
