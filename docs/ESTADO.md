# Estado

## Vertical activa

**Foundation, conexión GW2, H1.4 coordinación, H3.1–H3.10 lifecycle/detección/revisión/calidad local, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta`, H2.7 contaminación, economía H4.1–H4.19, UI/assets H5.1–H5.12 y contratos declarativos H8.1/H8.4: implementados. H8.2 aporta un spike técnico aislado y H8.3 está `accepted_for_implementation` de forma provisional; no se ha implementado ningún helper/runtime productivo y su QA real sigue pendiente.**

**H7.4 está implementado técnicamente y H7.5 preparado, sin publicación.** El release package parte de
un build nuevo, contiene únicamente `manifest.json`, `main.js` y `styles.css`, valida versiones y tag,
escanea los bytes staged y genera ZIP reproducible + SHA-256 con prueba causal. CI conserva permisos de
solo lectura y sube el candidato como artifact de rama/tag tras el gate. No se ha creado tag ni GitHub
Release, BRAT no está activo y la instalación/actualización real en Obsidian sigue pendiente de QA
humana en las plataformas soportadas.

**H7.2, H7.3 y H7.6 están implementados técnicamente, sin afirmar QA humana.** El README conduce desde
un artifact verificado hasta la primera sesión, explica que **Open companion** abre la vista y que
**Finish farming session** solo aparece tras un inicio realmente activo, separa modo manual/asistido y
expone límites de exactitud e Inventory Advisor. La guía de clave distingue conexión-only, mínimo real
`account + characters + inventories + builds` y permisos opcionales de cobertura. Soporte aporta un
issue form cerrado con versión, plataforma, origen, detección, fase y reproducción; prohíbe secretos,
identidad, rutas, inventario/snapshots, IndexedDB y salida sin redactar. El contrato ejecutable y sus
sabotajes impiden relajar esos campos o habilitar issues en blanco en silencio.

H5.10 añade exportación manual y fail-closed del historial durable: solo consume notas H5.4/H5.7 íntegras, ordena resultados de forma determinista y crea JSON/CSV sin contenido humano ni identificadores crudos. Ajustes ofrece además un scrub warning explícito con preview y confirmación ES/EN: un token efímero ligado a bytes/path/ref, consumido o revocado en toda salida, usa `Vault.process` CAS para quitar solo `tc_*` y los seis bloques intactos, sin papelera ni borrado físico. Una autoridad compartida excluye transiciones de sesión, recovery y detector durante el scrub y relee el runtime antes de cada escritura.

**H0.4, H0.6, H8.1 y H8.4: política y contrato v2 documentados; helper/runtime, validación multiplataforma y piloto pendientes.** El MVP es
API-only con Linux + Steam/Proton como plataforma primaria, macOS + CrossOver como secundaria y
Windows en beta. H8.1 fija Mumble Link para v2 como helper IPC opt-in de mapa/actividad, sin
implementarlo: defaults revisables deshabilitado/shadow/on-when-armed, API v1 autoritativa,
confirmación humana, raw no persistente, payload mínimo, `initialSequence:0` y transporte loopback
fail-closed. Las tasas de falso inicio/parada, recovery y precisión
temporal tienen definición, muestra mínima y umbrales verificables en
[Política de plataformas e integraciones](PLATFORM_POLICY.md).

El único artefacto productivo H8.1 es un modelo TS declarativo bajo allowlist AST recursiva, sin
imports, asignaciones, red, procesos, timers, persistencia ni funciones. Scanner v4 permite su
mención exacta y conserva en rojo cualquier helper
fuera de censo; los sabotajes cubren inyección, proceso/memoria, logs, tráfico, entrada y
automatización. La API oficial confirmó el mapa `866` como **Mad King's Labyrinth / Laberinto del
Rey Loco**. No existe helper, IPC runtime, listener, setting ni conexión con H3.8/H5.3.

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
lecturas híbridas idénticas siguen siendo un riesgo residual y la señal permanece shadow. El host inspeccionado
es macOS 26.6.1 ARM, con CrossOver 26.3.0, botella win64 `Guild Wars 2`, Apple Clang y CMake; no hay
MinGW/LLVM Windows cross-compiler disponible. El test portable compila y queda verde, pero no se ha
instalado nada, copiado nada a la botella, abierto CrossOver/GW2 ni ejecutado un PE. Por tanto H8.2
permanece en curso: la lectura estable durante una sesión real y las transiciones/reinicios son QA
humana pendiente.

**H8.3: ADR de lenguaje/artefacto cerrado para implementación, sin código nativo.** Se elige Rust
provisionalmente, target único `x86_64-pc-windows-msvc` con CRT estático, fuente futura
`native/mumble-helper` y un único `tyrian-mumble-helper.exe`. El ZIP será separado del plugin y
llevará manifest, checksums y licencias. Linux/Steam/Proton primaria, macOS/CrossOver secundaria y
Windows x64 beta siguen `QA=pending`; ejecución nativa Linux/macOS, Windows x86/ARM64, móvil y Wine
fuera de Steam/Proton/CrossOver quedan unsupported. Authenticode sigue pendiente y bloquea release.
El guard v11 y sus sabotajes mantienen este lote solo documental mediante censo positivo. Fuera de
docs/examples/fixtures/tests, fuente Rust/C#, configuración Cargo/toolchain exacta y señales de
prefijo Mumble Link por path o contenido quedan censadas globalmente; outputs
EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA y symlinks relevantes siempre fallan.
Un `bridge` genérico continúa permitido. El bloque JSON, el ADR y `PLATFORM_POLICY.md` completo tienen
parsing/hash canónicos, de modo que `QA completada` tampoco puede añadirse al final del documento.
No hay helper/runtime, wiring ni CI productivo.

**H8.4: protocolo IPC local cerrado y ejecutable solo como referencia de tests.** Helper servidor y
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
prohibidos. El censo conserva un único artefacto Mumble
productivo declarativo y cero importadores/runtime. No existen helper, socket, timer, process manager,
adapter, Cargo o packaging productivo; API v1 sigue autoritativa, shadow, human-confirmed y sin
persistencia.

H5.1 sustituye la portada de tarjetas por una bitácora compacta con fase y reloj de sesión, rail de detector/polling/calidad/cuenta, incidencia priorizada y detalles plegables; no añade red ni acciones automáticas.

H5.2 añade paleta y un único ribbon contextual para start, finish/retry, review, recover, discard confirmado y clear confirmado, siempre mediante los workflows existentes y con revalidación ante estado stale.

H5.3 añade una cola local durable para propuestas asistidas: enqueue previo al rearmado, intención exacta, claims renovables cercados por operación/ventana, receipts tras resolución, reconcile de identidad y una única propuesta visible con contador. El fondo solo actualiza indicadores existentes in-place: no reconstruye la vista, muestra notices/modales/notificaciones, enfoca, revela vistas ni ejecuta transiciones de sesión.

H5.4 genera mediante Vault una nota de sesión completa antes de permitir limpiar el runtime. Usa referencias SHA-256, ruta UTC, frontmatter `tc_*` estable y managed blocks hasheados; conserva tags/frontmatter/cuerpo humano y falla cerrado ante identidad, colisión o edición ambigua.

H5.5 deriva desde la evidencia H5.4 una única presentación de botín para nota y Companion: cambios netos, destino reservado/retenido/libre, subtotal económico y recomendación manual. Respeta permisos H2.7 y falla cerrado ante incoherencias H4 sin ocultar las filas físicas observadas.

H5.6 añade el motor genérico de assets administrados y una Base neutral. Preview no escribe; install/upgrade/repair usan manifiesto v1, CAS exacto y journal durable reanudable. Rutas inseguras, assets ajenos/modificados y formatos futuros fallan cerrados. Move instala destino antes de cambiar el puntero y Remove manda solo bytes propios exactos a la papelera de Obsidian, conservando manifiesto detached.

H5.7 sube las notas a schema v2 con evento, fuente manual/asistida correlacionada y recomendación histórica validados, y registra `Halloween.base` ES/EN en el bundle v2 sin un segundo writer. Sus cinco vistas filtran el evento explícito, separan cero de ausencia y reservan g/h a sesiones exactas, de confianza alta y cobertura completa. Falta QA manual en una bóveda desechable compatible con Bases; no se ha tocado la bóveda canónica.

H5.8 centraliza el contrato de rutas Vault para settings, notas y assets: solo NFC relativo con `/`, sin segmentos de navegación/configuración, controles/surrogates inválidos, nombres reservados de Windows ni longitudes que comprometan Sync. Settings v4 se reescribe de forma canónica al normalizar: elimina propiedades desconocidas y solo conserva las rutas pre-H5.8 autorizadas en `legacyOutputFolder`/`legacyManagedAssetsRoot`, read-only y sin alterar el puntero de assets. Move/Remove inspeccionan siempre la raíz heredada y rechazan un puntero divergente o manifiesto no exacto. Move exige estado ready incluso si el puntero ya la nombraba. Un Remove reintentado reconoce ese manifiesto exacto ya detached sin escribir ni volver a adoptarlo solo con puntero inicialmente vacío e idéntico tras la inspección, para terminar la limpieza de settings tras perder una respuesta. Una reubicación explícita instala primero el destino seguro y después elimina solo bytes propios de esa raíz. Manifiesto y journal ligan id/kind/locale/path y hashes previos permitidos; ready/detached exigen el conjunto exacto del bundle actual sin romper manifiestos compatibles previos. Las notas siguen usando únicamente UTC y hashes; ningún nombre incorpora cuenta, personaje, evento o ruta local.

H5.9 centraliza el texto visible ES/EN en un catálogo tipado con paridad de claves/placeholders: ajustes, Companion, incidencias, acciones, menús, modales, notas, botín y Bases cambian sin alterar IDs, enums, `tc_*`, hashes, rutas o consultas de Bases. La interfaz abierta se repinta y el bundle gestionado cambia con el idioma; los comandos ya registrados por Obsidian adoptan el nuevo nombre tras recargar el plugin.

H6.1 fija por regresión las seis direcciones entre personaje, banco y materiales —incluido split/merge— y comprueba holdings y composición exactos sin generar loot ni disponibilidad falsos. H6.2 recorre el workflow durable completo para apertura, reciclaje, compra en bazar y compra a mercader: persiste la revisión, reinicia una segunda instancia y conserva clasificación contaminada y permisos; la actividad del bazar sigue siendo una declaración explícita, no observación automática.

H6.3 fija que jackpots excluidos no alteran el EV ni la decisión y que un precio TP cero permanece `null/partial`. H6.4 recupera `stopping` y `provisional` sin recapturar evidencia, y prueba la cancelación real del modal sin backend ni mutación; no existe una acción inventada de cancelar sesión activa. H6.5 cubre 500/502/503/504 reintentables, 401/403/501 fatales y agotamiento 5xx con error saneado.

H6.6 añade un benchmark reproducible de cuenta grande, aislado de I/O: fuerza una primera pasada divergente y dos convergentes mediante la ruta pura productiva, finaliza snapshots estables, los compara, clasifica la frontera y valora 4.840 ganancias. Sus 21 muestras fijan mediana/p95 y la retención acumulada contra un baseline único post-warmup; CI prueba verde y sabotaje de heap explícito en Node 22 y 24, sin usar la duración de Vitest como evidencia.

H4.13 define la frontera pura del Inventory Advisor para `supported_storage_v1`. Liga snapshot, catálogo, precios, objetivos, excepciones de conservación, señales de cuenta y rule pack hasheado; valida particiones exactas de toda la propiedad por posición y devuelve un envelope manual separado del envelope de sesión. No existe acción `destroy`: `discard_candidate` requiere regla curada y permanece revisión irreversible. H4.14 captura la evidencia, H4.15 clasifica y H4.16 aplica la allowlist pura. H4.18 aporta un bundle built-in v2 inmutable y source-backed para 36038. H4.19 extrae el kernel económico H4.10 independiente de sesión, captura en Refresh el saco y sus ocho outcomes líquidos y liga modelo/regla/knowledge/TTL/cobertura/binding/reservas/excepciones. Con activación humana explícita y evidencia completa puede recomendar manualmente abrir o vender al bid/mercader con margen del 10%; cualquier estado parcial, revocado, vencido o incoherente queda en revisión. El built-in continúa `pending_human_review`, por lo que hoy no activa economía ni descarte. H5.11 conecta una vista separada ES/EN: Open no captura; Refresh es el único trigger y compone las capas con single-flight/latest-wins. H5.12 añade el editor plegable local de objetivos y excepciones. H6.11 está cerrado por auditoría automatizada; siguen pendientes la QA visual/manual ES/EN y la aprobación humana del pack/economía H4.19.

H4.19 añade el kernel económico independiente de sesión, el adapter/pack de economía del Advisor, captura hermana de precios, integración contextual y guards causales. Gate completo verificado: lint, 94 ficheros/1315 tests, release-preflight, scanner de seguridad y build en verde.

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 define el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`. H3.2–H3.10 cubren captura manual, recovery durable, detección asistida explícita, revisión de contaminación y medición local de calidad. H4.1–H4.12 añaden valoración, reservas, intenciones y recomendaciones manuales puras; no operan sobre la cuenta. H5.12 persiste objetivos y excepciones locales con CAS explícito. No hay persistencia de recomendaciones, operación sobre la cuenta ni escritura libre en el vault: H5.4 solo genera notas completas con bloques gestionados, H5.6 solo modifica assets tras una operación explícita y H5.10 exporta o scrubbea únicamente mediante acciones explícitas. El panel/agregación del historial sigue pendiente.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 100 ficheros y 1391 tests verdes, incluidos 63 tests H8.1/H8.4 dirigidos, más la
  lane C H8.2 normal/ASan/UBSan,
  syntax-check del wrapper y cinco sabotajes causales.
- `npm run test:security-scan` y `npm run security:scan`: scanner v4 y sabotajes verdes.
- `npm run build`: TypeScript y bundle de producción verdes.
- `npm run release:package`: paquete de tres archivos, checksum y segunda ejecución byte a byte reproducible en verde; debe regenerarse tras integrar cualquier otro lote.
- `npm run bench:h6-performance` y su sabotaje de heap: verdes en Node 24.19.0.
- H7.2/H7.3/H7.6 añade `test:support-contract`: formulario, docs y dieciocho sabotajes causales verdes;
  `npm run check`, benchmark, sabotaje de heap y `git diff --check` pasan en este worktree. No existe
  todavía evidencia de instalación, primera sesión o soporte real en dispositivo.

## Pendientes de producto

1. Compilar el PE del spike H8.2 con un toolchain Windows aprobado y ejecutar su comando documentado dentro de la botella durante una sesión real; después implementar ambos extremos del contrato H8.4 bajo el ADR H8.3, ejecutar QA separada en Linux/Steam/Proton, macOS/CrossOver y Windows x64 antes de salir de shadow, y resolver firma/licencias antes de release.
2. Ejecutar la matriz H0.4 por plataforma y reunir la muestra del piloto H0.6; `0.1.0` conserva observaciones H3.10 locales, pero aún no agrega ni exporta las métricas.
3. Diseñar el panel/agregación del historial durable de sesiones finalizadas.
4. Revisar y aprobar humanamente el pack/economía H4.19 antes de activar la capacidad 36038; el built-in sigue pending/disabled y fail-closed.
5. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
6. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
7. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
8. Consultar en una fase posterior el historial TP para complementar la declaración manual H3.9.
9. Hacer QA manual de H3.2–H3.4 en dos ventanas y, si Obsidian comparte el origin, dos procesos reales: doble clic, stop/retry, reload, cierre forzado, recuperación/descarte y pérdida del lease.
10. Descargar el artifact del SHA integrado, verificar el checksum e instalar/actualizar el plugin en una bóveda desechable por plataforma; solo después podrá el release owner publicar la release y activar BRAT.
