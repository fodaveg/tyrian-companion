# Tyrian Companion — audit de utilidad para el laberinto de Halloween

Fecha: 6 de octubre de 2026. Autor: Codex. Encargo: analizar funciones que faltan o necesitan pulirse, incluyendo los addons de Nexus y Blish HUD, y entregar el informe en Hebra.

## Veredicto

Tyrian ya tiene buena parte del motor necesario: sesiones automáticas, bolsas por hora, valoración neta, recomendaciones sobre el inventario acumulado y avisos dentro del juego. El mayor retorno no está en añadir otro sistema económico, sino en **hacer que esos datos sean comparables y útiles mientras se farmea**.

Priorizaría tres cosas antes de ampliar funciones: corregir la presión de espacio del personaje, independizar las estadísticas de bolsas de la cobertura de precios y comprobar el recorrido completo con Hebra + Nexus en Fedora y con Blish HUD en Windows. Después añadiría un panel pequeño dentro del juego y distinguiría las tandas de laberinto de las conexiones mixtas.

Las prioridades siguientes son recomendaciones de este audit, no decisiones aprobadas ni tareas creadas en Lumbre. No se ha cambiado código de producto.

## Alcance y evidencia

Se revisaron los checkouts limpios de:

| Componente | Candidato leído |
|---|---|
| Tyrian Companion 0.3.4 | `715c12f50b3b72fd446a3801eed9679ffbcea732` |
| Addon Nexus | `fe0fe81bc4cf340f557a6efb1b577a3484513f2f` |
| Módulo Blish HUD | `6b8c4d52d691b6a0595ff7f0c242e8900c336446` |

Memoria: nota compartida **Tyrian Companion - Decisiones y aprendizajes**, especialmente decisiones del 24–26 de septiembre y adopción de Hebra. Se contrastó con PRODUCT, SPEC del puente, changelog, código de los tres repositorios y auditorías del 2 de octubre. El grafo se usó para localizar; sus rangos desactualizados se contrastaron con el fichero actual.

Se ejecutó una sonda sobre funciones puras productivas con fixtures sintéticas: **salida 0 y cinco comprobaciones reproducidas**. No son datos de la cuenta. No hubo peticiones autenticadas a GW2, escritura en sus notas, builds, suite global, instalación, ni prueba del juego o de la UI real. Este es un audit funcional con comprobaciones focales, no una certificación de runtime ni una revisión exhaustiva de todos los ficheros.

Las referencias de código son relativas al repo del componente y corresponden a los SHAs anteriores. Para consultar una revisión inmutable: `https://github.com/fodaveg/<repo>/blob/<SHA>/<ruta>`.

## Lo que ya existe y conviene aprovechar

| Necesidad del farmeo | Estado comprobado |
|---|---|
| Empezar y terminar al jugar | Puente autenticado y `IngameSessionMarker`; inicio al recibir gameplay y cierre por fin de presencia, con gracia ante desconexión. No está limitado al laberinto. |
| Identificar el laberinto | Mapa 866 etiquetado en el contexto y en la sesión. |
| Saber cuántas bolsas entran | `LiveSessionLootTracker`, contador y banda de bolsas/h en la vista Sesión; dependen de observaciones de la API. |
| Comparar sesiones | Historial con grupos por actividad, nombre de build y calidad, y tasas ponderadas; presenta limitaciones detalladas abajo. |
| Vender, abrir o esperar | Asesor del inventario y pestaña Venta, bolsa 36038, ventanas estacionales, precios y valoración con comisiones/profundidad. No hace falta inventar esta función de nuevo. |
| Liberar inventario | Contadores de huecos y acciones priorizables; selección del personaje jugado recientemente. El criterio de presión sigue teniendo un defecto. |
| Avisar de un drop valioso | Canales y protocolo v3 con acuse del addon. La recepción/presentación técnica no acredita que el jugador haya leído el aviso. |
| Magic Find | Deriva suerte, logros y enriquecimiento; admite bonus manuales. No observa los buffs temporales del juego. |
| Abrir el host desde Nexus | Selector Obsidian/Hebra y lanzamiento desde el addon. El módulo Blish inspeccionado no ofrece ese mismo lanzamiento. |
| Funcionar en Hebra | Adaptador y distribución como plugin externo desde 0.3.0. Eso no acredita el recorrido real de esta versión. |

No vuelvo a dar por abiertos los fallos de netos negativos, bucle de inicio sin clave o inicio inmediatamente posterior a una parada: el changelog y el código ya incorporan correcciones. Tampoco está vigente la antigua caducidad del paquete curado en noviembre: `inventory-advisor-builtin-bundle.ts` fija el 1 de junio de 2027 y amplía su antigüedad permitida.

## Prioridades

### 1. P0 — Corregir la presión de espacio del personaje que está farmeando

**Defecto reproducido.** `storageSpaceOf()` selecciona las bolsas del personaje reciente, pero llama a `resolveStorageSpaceState()`, que suma también los huecos del banco. Con **0 huecos en las bolsas, 100 en el banco y umbral 10**, devuelve `isLow: false`. Si el banco no se pudo observar, devuelve `null` aunque se conozca que las bolsas están llenas.

Esto llega al orden del Asesor y a Venta: `buildSaleViewModel()` consume `storageSpace.lowSpace.isLow`. Puede seguir recomendando esperar cuando el jugador necesita liberar sitio para continuar la ruta.

**Qué pulir:** separar capacidad del personaje, capacidad de almacenamiento y posibilidades de depósito. Usar las bolsas del personaje observado por el addon cuando haya evidencia válida, con fallback explícito al personaje reciente. La falta de lectura del banco no debe ocultar que el personaje está lleno. Los «N huecos liberados» deben identificar dónde se liberan; vender una pila de otro personaje o del banco no despeja la mochila actual.

**Aceptación:** el caso 0/100 activa presión; banco desconocido no bloquea el diagnóstico de bolsas; las acciones prioritarias liberan huecos del personaje relevante.

Evidencia: `src/inventory/storage-space.ts:56`, `src/inventory/inventory-analysis.ts:519`, `src/ui/sale-view-model.ts:261`, `prioritizeInventoryAdvisorRowsBySpace()`.

### 2. P0 — Poder comparar bolsas/h aunque falten cotizaciones

**Defecto reproducido.** `performanceGroup()` exige `valuationCoverage === 'complete'` y `observedImmediateCopper` para calcular tanto oro/h como bolsas/h. Dos sesiones de una hora con 500 bolsas cada una dan 500 bolsas/h con precios completos. Al cambiar solamente la cobertura a parcial, quedan cero sesiones elegibles y bolsas/h pasa a `null`.

**Qué pulir:** elegibilidad separada por métrica. Bolsas y duración suficientes permiten comparar bolsas/h; oro/h puede quedar parcial o desconocido. Cada tasa debe mostrar cuántas sesiones y cuánto tiempo la sostienen. No convertir ausencias en cero ni sumar valor incompleto como total.

**Aceptación:** las dos mismas tandas siguen mostrando 500 bolsas/h cuando falta el precio de un objeto ajeno a las bolsas, mientras el dinero conserva su limitación.

Evidencia: `src/sessions/session-history-summary.ts:149` y `:203`. El informe `2026-10-02-h18-29-correcciones.md` ya registró que las notas reales leídas entonces no reunían dos sesiones elegibles por grupo; no se han releído esos datos hoy.

### 3. P0 — Certificar una sesión completa con cada addon y Hebra

**Falta evidencia de aceptación del conjunto actual.** No equivale a afirmar que no funcione. Las últimas releases declaran no haberse comprobado en Hebra/Obsidian reales antes de publicar; el README de Blish mantiene pendiente carga, aviso y sesión completa en Windows.

Recorrido mínimo: host cerrado → arrancar juego → conectar → capturar baseline → farmear → ver un aviso → salir → esperar captura final → guardar → volver a jugar. Añadir desconexión corta/larga, recarga de Hebra, suspensión y pérdida temporal de API. Una baseline que tarda en capturarse debe dejar claro desde cuándo hay botín medido; la hora de entrada al juego no convierte en observados los objetos anteriores a esa captura.

**Nexus:** comprobar la selección Hebra y su lanzamiento real desde Proton. **Blish:** cerrar o documentar la asimetría de lanzamiento; actualmente requiere tener el host disponible por otra vía. Validar sus señales de loading/selección de personaje: usa presencia de nombre de personaje, mientras Nexus aplica una ventana temporal de 60 s. Son aproximaciones diferentes, no paridad demostrada.

**Aceptación:** una nota válida por sesión, sin duplicados con ambos addons, sin silencios ante errores y con un aviso visible comprobado en cada plataforma. No basta un ACK, una build o tests del protocolo.

Evidencia: `docs/CHANGELOG.md` 0.3.0–0.3.4; Nexus `core/src/game_context.rs`, `addon/src/obsidian_launch.rs`; Blish `GameContextSampler.cs`, `Module.cs`, README «What is verified, and what is not».

### 4. P1 — Un panel de farmeo pequeño dentro del juego

**Función nueva con retorno alto.** Los addons actuales son fundamentalmente emisores de contexto y receptores de avisos. Nexus tiene opciones y últimos avisos; Blish muestra notificaciones. El protocolo no publica un modelo de estado de sesión con bolsas/h, capacidad y frescura.

Propondría un panel opcional con: sesión activa/capturando/error, duración, bolsas observadas y banda de bolsas/h, antigüedad de la observación, huecos del personaje y estado de conexión. La rentabilidad puede ir en detalle para no distraer. Un aviso discreto debe informar si no se pudo iniciar o si el recolector dejó de observar: «puente conectado» no significa «sesión midiendo».

Requiere ampliar el protocolo con mensajes versionados de estado, expiración y compatibilidad para ambos clientes. El cálculo sigue en Tyrian; no duplicar la economía en Rust y C#. Empezaría solo lectura. Controles de pausa o cierre exigirían otro contrato y no forman parte de esta recomendación mínima.

**Aceptación:** poder saber si se está midiendo y cómo va la tanda sin cambiar a Hebra; un dato viejo se distingue inmediatamente de uno recién observado.

Evidencia: `src/alerts/alert-contract.ts:13`, `docs/SPEC-puente-ingame.md`; Nexus `addon/src/render.rs`; Blish `Module.cs`.

### 5. P1 — Distinguir tandas de laberinto y sesiones mixtas

**Limitación de producto, no incumplimiento del contrato actual.** El marker guarda la primera visita al laberinto y la sesión se etiqueta Halloween. No recorta el botín ni el tiempo al mapa 866. Una conexión con otras actividades antes o después no sirve como medida limpia de rendimiento del laberinto.

Conservaría la sesión automática de conexión aprobada y añadiría tramos de presencia por mapa, indicando «mixta» cuando corresponda. No dividiría el oro proporcionalmente por minutos: las instantáneas de cuenta no permiten atribuir así el loot. Las comparaciones de laberinto deberían excluir sesiones mixtas o presentarlas en un grupo separado.

**Aceptación:** 30 min fuera + 60 min dentro no se presentan como 90 min de farmeo puro ni se inventa una fracción exacta de botín. La corrección de horario no debe aparentar que recaptura el pasado.

Evidencia: `src/sessions/ingame-session-marker.ts:166` y `:213`; `ingameLabyrinthDeclaration()` en `src/runtime/tyrian-companion-core.ts`; SPEC del puente, sección Presencia.

### 6. P1 — Comparaciones que distingan build, Magic Find y contexto

**Carencias comprobadas en el modelo.** Se captura una build estructurada, pero la nota guarda su nombre en `tc_build` y el historial agrupa por esa cadena. Un nombre vacío termina en `null` y excluye la sesión: reproducido con dos fixtures. Nombres iguales pueden representar configuraciones distintas. El agrupador tampoco incorpora Magic Find ni distingue una tanda mixta por sus tramos.

Además, el arranque automático pasa `consumablesBonus: 0`: su Magic Find procede de componentes consultables, no del total efectivo con comida, potenciadores y efectos de mapa. No debe usarse como si certificara igualdad de buffs entre dos tandas.

**Qué pulir:** identidad estable de build derivada de los campos ya capturados, con nombre solo como etiqueta; estadísticas básicas aunque no haya nombre; desglose de MF observable/manual/desconocido; contexto opcional de la tanda. Mostrar muestras y dispersión, no proclamar una build mejor por dos observaciones con condiciones distintas. Comparar bolsas/h ayuda a separar rendimiento de cambios del mercado.

**Aceptación:** una build sin nombre conserva estadísticas; dos builds diferentes con el mismo nombre no se fusionan como equivalentes; MF parcial se etiqueta como parcial.

Evidencia: `src/sessions/session-start-capture.ts` (`parseActiveBuild`), `src/sessions/session-note-renderer.ts:81` y `:339`, `src/sessions/session-history-summary.ts:149`; `startIngameSession()` en el runtime; `src/account/magic-find-model.ts`.

### 7. P1 — Explicar qué significa «bolsas ganadas» cuando se abren durante la sesión

**Límite del método que necesita presentación clara.** El contador activo acumula ganancias observadas; al cerrar, `reconcile()` lo sustituye por el delta entre fronteras. Si entre capturas entran y se abren bolsas, el neto no permite reconstruir cuántas se obtuvieron. Por ejemplo, obtener 100 y abrir 100 puede dejar delta cero. Un contador que baja al reconciliar necesita explicar por qué.

Separaría «incrementos observados durante la sesión», «bolsas netas conservadas al cierre» y «total obtenido no observable». Tampoco usaría la comparación de aperturas como contador de farmeo: tiene su propia elegibilidad y trabaja con desaparición neta de bolsas, no con cada apertura real. El contador de sacos configurado cuenta 36038; otros contenedores deben mantenerse explícitamente separados.

**Aceptación:** adquirir y abrir entre dos sondeos nunca se presenta como cero bolsas obtenidas con certeza. Ninguna estimación del contenido se suma al valor de la bolsa de forma que cuente dos veces el mismo botín.

Evidencia: `src/sessions/live-session-loot.ts` (`observe`, `reconcile`), `src/sessions/session-economy-evidence.ts:26`, `src/halloween/halloween-loot-comparison.ts:259`.

### 8. P2 — Preparación y buffs sin prometer telemetría que no existe

Una checklist breve antes de farmear tendría valor: personaje/build, huecos, modo recolector, conexión del addon, evidencia del MF y recordatorio de comida/utilidad. Los temporizadores manuales pueden ayudar si se etiquetan como recordatorios, no como lectura de buffs activos.

Antes de construir un detector de buffs propio, probaría la complementariedad con **MagicFinder para Reffect**, cuyo autor documenta seguimiento de buffs de MF y avisos de expiración específicos del laberinto. No se ha probado su compatibilidad con la instalación de David, ni se propone integrarlo de forma automática. Fuente: [README de MagicFinder](https://github.com/DominantNostril/MagicFinder).

El protocolo actual de Tyrian no transporta buffs, combate, ruta ni un flujo de botín. Tampoco demuestra AFK. No inferir pausas solo por falta de drops o combate. Una pausa declarada puede ser útil, pero necesitaría definir qué tiempo y qué objetos siguen entrando en el cálculo.

## Secuencia recomendada

1. Arreglar espacio y estadísticas independientes; revisar la identidad de build y los nombres vacíos.
2. Ejecutar el recorrido real Fedora + Hebra + Nexus, y Windows + Blish HUD. Corregir lo que aparezca antes de anunciar preparación para Halloween.
3. Llevar estado, frescura y métricas al pequeño panel de ambos addons.
4. Añadir distinción de sesiones mixtas y contexto de comparación sin inventar atribución de loot.
5. Pulir preparación/buffs y rentabilidad explicada. Mantener Venta como decisión sobre inventario acumulado, separada del resultado de la tanda.

No priorizaría un nuevo helper Mumble, un backend de clan, rutas automáticas, lectura de memoria de inventario, operaciones automáticas de bazar ni rehacer todo el asesor. Tampoco afirmaría que una ventana estacional garantiza ganancias: su utilidad es orientar una decisión con datos frescos, incertidumbre y coste de ocupar espacio.

## Resultado mínimo que haría útil el conjunto

Entrar al juego y saber que Tyrian está midiendo; seguir el tren sin cambiar de ventana; ver bolsas/h con frescura y límites; recibir una indicación útil antes de quedarse sin espacio; cerrar y conservar una sesión comprensible; comparar tandas equivalentes; decidir después qué vender, abrir o guardar desde el inventario.

## Evidencia focal reproducible

Sonda local temporal: `/tmp/tyrian-halloween-audit-probe.cjs`. Resultado temporal: `/tmp/tyrian-halloween-audit-evidence.json`. Esas rutas no son portables ni garantizan conservación en otra máquina; los resultados relevantes quedan aquí:

| Entrada sintética sobre funciones productivas | Salida observada |
|---|---|
| Bolsas 0/100 libres, banco 100/100, umbral 10 | `isLow: false`, 100 libres sumados |
| Bolsas 0/100 libres, banco desconocido | Estado de espacio `null` |
| Dos sesiones de 1 h, 500 bolsas cada una, misma build, precios completos | Grupo ready, 500 bolsas/h |
| Mismas sesiones y cantidades, cobertura de precios parcial | Cero elegibles, bolsas/h `null` |
| Mismas sesiones, build `null` | Dos excluidas por contexto, ningún grupo |

La sonda transpila módulos TypeScript y ejecuta sus funciones puras; no altera su implementación. Las fixtures no certifican la UI ni todo el flujo. La lectura de los consumidores documentada arriba establece dónde se usa el resultado de espacio. No se ejecutó una build ni un gate global para este audit de solo lectura.

## Entrega

Publicado y releído en Hebra con el título **Tyrian Companion - Audit del laberinto de Halloween 2026-10-06**.
ID de nota: `d6e87335-1f8c-4b80-aa4b-748ab35c5fbf`. El cuerpo transferido conserva el audit íntegro salvo esta sección de entrega y añade frontmatter para el título; lectura posterior de 17.235 caracteres. El cliente informó sincronización correcta, sin subidas pendientes. El MCP no proporcionó un enlace navegable.

Recibo local temporal: `/tmp/tyrian-hebra-audit-delivery.txt`; traza de transferencia: `/tmp/tyrian-hebra-audit-transfer.log`. No se modificó ninguna nota de decisiones ni se crearon tareas.
