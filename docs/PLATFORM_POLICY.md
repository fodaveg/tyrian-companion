# Política de plataformas e integraciones

Este documento fija las decisiones H0.4 y H0.6 vigentes desde el 14 de agosto de 2026. El
MVP sigue siendo un plugin de Obsidian para escritorio y obtiene la evidencia de juego
exclusivamente de la API oficial de Guild Wars 2.

## Matriz de plataformas

| Prioridad | Entorno de juego | Alcance del MVP | Criterio de release |
| --- | --- | --- | --- |
| Primaria | Linux con Steam/Proton | Conexión, sesiones manuales, detección asistida por API, recovery y artefactos Vault | La matriz funcional completa es bloqueante. No se publica con pérdida de datos, credenciales expuestas o un flujo obligatorio roto. |
| Secundaria | macOS con CrossOver | El mismo contrato API-only, sin integración con el proceso de CrossOver | Son bloqueantes los fallos de datos, privacidad, conexión, lifecycle o recovery. Una limitación exclusiva de presentación puede documentarse sin prometer paridad visual inmediata. |
| Beta | Windows | El mismo contrato API-only, distribuido como soporte experimental | Debe pasar instalación, conexión, sesión manual, recovery y escritura segura. Un defecto exclusivamente Windows puede quedar conocido durante la beta; nunca se relajan privacidad, integridad ni la prohibición de operar sobre la cuenta. |

Las métricas se publican separadas por plataforma y versión de Steam/Proton, CrossOver,
Windows, Obsidian y Tyrian Companion. Un agregado global no puede ocultar una regresión de la
plataforma primaria. La compatibilidad móvil sigue fuera de alcance.

## Límite del MVP: solo API

El MVP puede consultar exclusivamente endpoints oficiales de Guild Wars 2. La carga del plugin y
la apertura de la vista permanecen sin red; una conexión, una captura manual o el armado explícito
de la detección asistida son las únicas puertas de entrada a las consultas ya descritas en
[Arquitectura](ARCHITECTURE.md).

El MVP no integra Mumble Link, no inspecciona el cliente de juego y no depende de Steam, Proton o
CrossOver para obtener evidencia. Inicio y parada asistidos siguen siendo propuestas: una persona
debe aceptarlas o descartarlas. Vender, listar, abrir, consumir, mover, fabricar, canjear o ejecutar
cualquier otra operación dentro del juego o sobre la cuenta queda siempre fuera del companion.

## Mumble Link en v2

Mumble Link solo puede entrar en una v2 como helper local opcional, separado del proceso de
Obsidian y comunicado mediante un IPC mínimo y versionado. Su única entrada local será la interfaz
documentada de Mumble Link; no podrá inyectar código, enumerar o controlar procesos, leer la memoria
del proceso de Guild Wars 2 ni usar técnicas alternativas si el enlace no está disponible.

El helper solo podrá publicar mapa y actividad. No aportará inventario, economía, identidad de
cuenta ni acciones. Sus eventos podrán mejorar una ventana temporal o generar una propuesta, pero
nunca iniciar o parar una sesión por sí solos. Deshabilitar, no instalar o perder el helper debe
mantener funcional el recorrido API-only y degradar la evidencia de forma explícita.

Antes de implementar el helper se exige un contrato separado de IPC, versionado, permisos,
retención, cierre y fallo. El plugin debe validar todo mensaje como dato no confiable y poder
detener/reiniciar el helper sin afectar al runtime de sesión.

## Política de terceros y operaciones

Para observar el estado o la actividad del jugador en runtime solo se admiten:

1. La API oficial de Guild Wars 2.
2. La interfaz oficial Mumble Link, exclusivamente mediante el helper opcional de v2 anterior.

No se admiten scraping de estado personal, lectura de logs o memoria del cliente, inyección,
hooks, interceptación de tráfico, simulación de entrada, macros, bots ni automatización mediante
herramientas de Steam, Proton, CrossOver o Windows. Las fuentes editoriales usadas para modelos
estáticos deben seguir siendo citadas, fechadas y revisadas como evidencia offline; no se convierten
en una integración runtime ni en autoridad sobre la cuenta.

Ningún componente puede ejecutar operaciones desatendidas. Una recomendación solo explica una
acción que la persona realiza manualmente dentro del juego. El polling armado, el cálculo local y
la persistencia de evidencia no son autorización para cambiar el estado del juego, de la cuenta o
de una sesión sin la confirmación prevista por su lifecycle.

## Métricas del piloto

Antes del piloto se exige un dry run de instrumentación por plataforma: debe registrar cada
propuesta presentada, reconciliarla con la cola y el lifecycle y producir el esquema siguiente sin
usar aún sus resultados como muestra del piloto. Cada fila se identifica de forma estable por
`proposalId` y contiene `review_presented` y su timestamp, tipo `start|stop`, estado terminal
`decided|expired`, ventana y intervalo de polling, y las versiones de plataforma, Obsidian, Tyrian
Companion y Steam/Proton, CrossOver o Windows que correspondan. En `expired`, decisión, resultado
efectivo, causa H3.10 y frontera humana son `null`, salvo un dato ya observado antes de expirar que
se conserva sin inferir otro. En `decided`, la decisión es `dismissed|accepted`: un descarte tiene
resultado efectivo `dismissed` y su causa H3.10; una aceptación tiene
`accepted_workflow_succeeded|accepted_workflow_failed`. La frontera humana corregida permanece
`null` si no existe adjudicación humana, independientemente del terminal.

Al cierre de una evaluación, las propuestas que no llegaron a revisión quedan fuera. Para un tipo
`t`, el denominador de falso positivo `n_t` es el número de propuestas con `review_presented`,
estado `decided` y resultado efectivo `dismissed` o `accepted_workflow_succeeded`. El numerador
`k_t` es el subconjunto de `n_t` cuyo resultado efectivo es `dismissed`: todo descarte es un falso
positivo del tipo correspondiente. La causa H3.10 se publica como desglose de `k_t`, nunca como
filtro. Por tanto, `tasa_t = k_t / n_t`. Una
aceptación cuyo workflow falla se conserva y publica por separado, pero no entra en `k_t` ni `n_t`:
no adjudica la calidad de la detección. Una propuesta expirada tras llegar a revisión tampoco entra
en esas tasas, pero sí en la cobertura: `cobertura = decisiones / revisiones`, donde `decisiones`
son las revisiones con estado `decided` y `revisiones` las presentadas que cierran como
`decided|expired`. Así una tasa no mejora ocultando casos sin revisar. El umbral del 10 % se aplica
a la estimación puntual; el intervalo Wilson al 95 % se publica como su incertidumbre, no como un
umbral alternativo.

| Métrica | Definición | Publicación | Criterio de éxito |
| --- | --- | --- | --- |
| Falso inicio | `k_start / n_start`: `k_start` son inicios con resultado `dismissed`; `n_start` son inicios `decided` con resultado `dismissed|accepted_workflow_succeeded` | Recuento, `n_start`, estimación puntual, desglose H3.10 e intervalo Wilson al 95 % por plataforma | Estimación puntual menor o igual al 10 %, `n_start >= 20` y cobertura de decisión mayor o igual al 90 % |
| Falsa parada | `k_stop / n_stop`: `k_stop` son paradas con resultado `dismissed`; `n_stop` son paradas `decided` con resultado `dismissed|accepted_workflow_succeeded` | Recuento, `n_stop`, estimación puntual, desglose H3.10 e intervalo Wilson al 95 % por plataforma | Estimación puntual menor o igual al 10 %, `n_stop >= 20` y cobertura de decisión mayor o igual al 90 % |
| Sesiones recuperadas | Recoveries que restauran una sesión utilizable / sesiones recuperables presentadas | Éxitos, fallos, descartes voluntarios y tasa; los descartes no cuentan como éxito | 100 % en 20 reinicios forzados de la plataforma primaria y al menos 95 % en el piloto, sin pérdida silenciosa |
| Precisión temporal | Error absoluto en segundos entre el punto medio de la ventana propuesta y la frontera corregida por la persona | Mediana, p90 y máximo, en segundos y en múltiplos del intervalo de polling | Mediana menor o igual a 1 intervalo y p90 menor o igual a 2 intervalos |

La frontera corregida es una adjudicación humana, no una inferencia posterior del mismo detector. Si
no existe corrección temporal, el caso aporta decisión de falso positivo, pero no precisión. H3.10
ya conserva observaciones locales, pero `0.1.0` todavía no agrega ni sincroniza estas métricas ni
captura todas las adjudicaciones necesarias para calcularlas.

## Entrada y salida del piloto

El piloto puede comenzar cuando el mismo candidato cumple la matriz funcional completa en Linux,
los smoke tests obligatorios en macOS y Windows, y una revisión confirma que la medición no contiene
credenciales, snapshots crudos ni payloads crudos de inventario. El conjunto mínimo permitido es
la identidad del evento/sesión/propuesta, fase, resultado, modo, causa, ventana, incertidumbre,
calidad de evidencia y timestamps necesarios para las métricas. Cuando deba preservarse la
procedencia de un inicio asistido, se admite la `RelevantStartProposal` completa y nada más:
`version`, `proposalId`, `accountId`, `ruleSet.id|version`, `firstSignal` y
`confirmationSignal` —cada una con refs de snapshots, intervalo/ventana, ganancias `itemId` y
`quantity`, y `deltaStatus`—, `possibleStart`, `evidenceQuality` y `confirmedAt`. Nunca contiene
snapshots crudos, payloads crudos de inventario, texto libre ni API key. La beta de Windows debe
identificarse como tal en cualquier entrega.

El piloto se considera satisfactorio con un mínimo de 50 sesiones completadas, los denominadores
mínimos de ambas tasas, los 20 reinicios forzados de Linux y todos los umbrales anteriores. Además,
debe registrar cero operaciones ejecutadas por el companion y cero pérdidas silenciosas de runtime
o notas. Los mínimos —50 sesiones, `n_start >= 20`, `n_stop >= 20` y los reinicios exigidos— se
aplican por plataforma, no por cada combinación de versiones. Las versiones se publican como
estratos para permitir reproducir y acotar una regresión; cualquier regresión por versión se
investiga y no puede quedar oculta en un agregado. Los umbrales y muestras son obligatorios para
Linux; macOS o Windows que alcancen la misma muestra deben cumplirlos también. Un resultado
secundario o beta con una muestra menor se publica como inconcluso, no como verde; no se extrapolan
ni se mezclan plataformas para declarar éxito.
