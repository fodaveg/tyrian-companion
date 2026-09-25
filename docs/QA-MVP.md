# QA manual del MVP

## Estado y alcance

Este protocolo cubre H6.8/H6.9 y recoge las dieciséis pruebas de aceptación de la sección 8 de la
[[Tyrian Companion - Auditoría final consolidada 2026-09-24]], con las precisiones de su sección 9
(«Lo que has decidido», 24 sep 2026).

**Estado: ejecución humana pendiente.** Una guía preparada no acredita una prueba superada. Estas
pruebas aún no se han ejecutado.

**Sobre las pruebas marcadas «depende de H18.x en desarrollo».** El código de esa parte no existe
todavía en `main` (verificado por grep en `src/` al escribir esta guía, 24 sep 2026): ejecutarlas hoy
debe dar el resultado ANTIGUO, no el esperado. Repetirlas cuando el lote correspondiente aterrice en
`main` y marcar cuál commit las cerró.

## Precondiciones comunes

Para todas las pruebas:

1. Crear una bóveda **desechable** nueva. No abrir, copiar ni modificar la bóveda canónica.
2. Instalar el candidato y anotar: versión de Tyrian Companion (de `manifest.json`), SHA-256 del
   commit (`git rev-parse HEAD`), versión de Obsidian, sistema operativo y plataforma (Fedora con
   Proton / Windows nativo con Blish HUD para el clan — macOS con CrossOver queda fuera de esta ronda
   salvo que David lo pida).
3. Crear un secreto de Obsidian con una clave de pruebas (`account`, `characters`, `inventories`,
   `builds` como mínimo).
4. Configurar una carpeta de salida portable en Ajustes.
5. Registrar timestamps en UTC. Conservar solo: rutas de notas, SHA-256 de ficheros, estado visible,
   versiones y capturas sin secretos (nunca la clave API, el account id ni un snapshot completo).

Para cada prueba: marcar `PASS` solo tras observar el resultado esperado. Marcar `FAIL` si aparece un
error inesperado, un control bloqueado o el resultado antiguo en una prueba que no está marcada como
dependiente de H18.x. Anotar siempre la versión (paso 2) en la prueba, no solo en las precondiciones:
una regresión entre dos candidatos solo se ve si cada fila dice contra qué versión se ejecutó.

---

## Pruebas de aceptación (año normal)

### Prueba 1: Reservas

Verificar que el inventario y el asesor distinguen cantidad libre de reservada, objetivos que se
solapan, un objetivo sin tabla de recursos y una reserva repartida entre banco y personajes
(auditoría §8.1).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Crea un objetivo de legendaria en Ajustes (Asesor de inventario → Objetivos) para un ítem del que
   tengas materiales repartidos entre banco y al menos un personaje.
2. Crea un segundo objetivo que reclame el mismo material que el primero (objetivos solapados).
3. Añade a mano, en Ajustes, un objetivo cuyo material no tenga tabla curada en el repo.
4. Abre **Asesor de inventario** y pulsa **Sincronizar inventario**.

**Resultado esperado:**
- El objeto completamente reservado no aparece para vender; uno parcialmente reservado muestra
  cantidad libre y reservada por separado.
- Los dos objetivos solapados no duplican la cantidad reclamada.
- El objetivo sin tabla se muestra como incierto (falta la regla), nunca como protegido con una cifra
  inventada.
- La reserva del material repartido entre banco y personajes se suma correctamente entre las dos
  ubicaciones sin duplicarla ni perderla.

**Evidencia mínima:** captura del Asesor con las filas de reserva/libre visibles; captura de
`Bases/Inventory.base` con el objeto sin tabla marcado incierto; ruta y SHA-256 de la nota del objeto
repartido.

**Versión probada:** ______________

---

### Prueba 2: Precios

Verificar que el histórico y el precio de hoy se distinguen por fecha, que una serie plana no se
etiqueta como oportunidad excepcional, que un precio hundido no obliga a vender sin motivo, y el caso
sin precio de hoy y el de un día a medias (auditoría §8.2).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Con **Historial de precios** activado en Ajustes, deja pasar al menos un día de captura para un
   ítem del asesor.
2. Fuerza (o espera) un día en que datawars2/el propio histórico no tenga precio de hoy para ese ítem.
3. Repite con un ítem cuya serie reciente sea plana (variación mínima) y con uno cuyo precio de hoy
   esté muy por debajo de su histórico dentro de la ventana de temporada del saco (`36038`).
4. Abre el panel de historial de precios del ítem desde el Asesor.

**Resultado esperado:**
- El histórico y el precio actual muestran fechas distintas y nunca se confunden en una sola cifra.
- «Precio desconocido» se muestra como tal, nunca como cero.
- Una serie plana no se presenta como oportunidad excepcional, pero puede dar «vender ahora» si
  esperar no tiene ventaja demostrada.
- Un precio hundido dentro de la ventana de temporada NO obliga a vender por sí solo; si el plugin
  recomienda vender de todas formas, debe mostrar un motivo visible, no solo el calendario.
- Un día con datos parciales (a medias) no se trata como un día completo ni se descarta en silencio.

**Depende de H18.x en desarrollo:** hoy (`src/advisor/inventory-position-recommendation.ts:240-251`,
`evaluateSeasonalRule`), estar dentro de la ventana de temporada produce `sell`/`seasonal_sell_window`
incondicionalmente, sin mirar el precio — el resultado «precio hundido no obliga a vender con un
motivo visible» todavía falla. Ejecutar igualmente y registrar el resultado ANTIGUO (vende igual, sin
motivo de precio) hasta que la Entrega 4 (comparación cuantificada, auditoría §3.D y §7) aterrice.

**Evidencia mínima:** capturas de los cuatro casos (sin precio de hoy, día a medias, serie plana,
precio hundido en ventana) con la recomendación y su motivo visibles.

**Versión probada:** ______________

---

### Prueba 3: Fallos del cierre

Verificar los cuatro puntos de fallo del cierre (antes y después de guardar el estado interno, antes
y después de escribir la nota), el reintento, y dos ventanas compitiendo por la misma sesión
(auditoría §8.3).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Inicia sesión con **Iniciar sesión de farmeo**. Cierra o desconecta la red justo después de pulsar
   **Terminar sesión de farmeo**, antes de que la captura final termine.
2. Restaura la red y pulsa **Reintentar finalizar sesión**.
3. Repite forzando el fallo un instante después: con la captura final ya hecha pero antes de que la
   nota se escriba (por ejemplo, revocando el permiso de escritura de la carpeta de salida un
   momento).
4. Abre una segunda ventana de Obsidian sobre la misma bóveda e intenta iniciar o terminar sesión
   mientras la primera ventana tiene el lease.

**Resultado esperado:**
- Cada reintento genera una sola nota final, nunca dos.
- La segunda ventana recibe un error de sesión ocupada (lease), no una segunda sesión activa.
- No hay sobrescrituras ni corrupción del runtime en ningún punto de fallo.

**Depende de H18.x en desarrollo (bug conocido, no bloqueado por decisión de producto):**
`stopInternal` (`src/sessions/manual-session-start-service.ts:757-759`) solo acepta la sesión en
`active` o `stopping`; si una pérdida de lease o de coordinación deja el estado en `error` durante el
cierre, **Reintentar finalizar sesión** no reactiva el flujo (auditoría §3.B, «el reintento desde el
estado de error no funciona nunca»). Provocar ese camino específico (paso 3 con pérdida de lease, no
solo de red) y registrar el resultado ANTIGUO hasta que se arregle en la Entrega 1.

**Evidencia mínima:** ruta y SHA-256 de la nota final única; captura del error de la segunda ventana;
captura del estado tras forzar el camino de `error`.

**Versión probada:** ______________

---

### Prueba 4: Suspensión

Verificar que suspender el equipo durante una sesión no la pierde al reactivar, y que empezar la
sesión siguiente no exige limpiar la anterior a mano (auditoría §8.4).

**Plataforma:** Fedora con Proton (primaria). macOS con CrossOver solo si David lo pide expresamente.

**Pasos:**
1. Inicia sesión y suspende el equipo durante más de 5 minutos (lease de 300 s, H14.21).
2. Reactiva el equipo y observa el estado de la sesión sin tocar nada.
3. Cierra Obsidian con la sesión aún activa y vuélvelo a abrir.
4. Termina la sesión y, sin pulsar **Limpiar sesión completada**, intenta **Iniciar sesión de
   farmeo** de nuevo.

**Resultado esperado:**
- La sesión no se pierde tras la suspensión; en el peor caso pide **Recuperar sesión guardada**
  (recovery), nunca queda huérfana sin ninguna acción posible.
- Tras reabrir Obsidian, aparece recovery si corresponde, sin borrar la sesión sola.
- El cierre y guardado funcionan sin error tras la suspensión.

**Depende de H18.x en desarrollo:** hoy, iniciar una sesión nueva mientras la anterior sigue
`complete` sin limpiar falla con «A farming session is already in progress»
(`src/sessions/manual-session-start-service.ts:691-693`); hace falta **Limpiar sesión completada**
antes. La Entrega 2 (auditoría §7, «sesión siguiente sin limpiar») aún no lo cambia. Ejecutar el paso
4 igualmente y registrar el bloqueo actual.

**Evidencia mínima:** capturas del estado tras suspender/reactivar, tras reabrir Obsidian, y del
mensaje de bloqueo al intentar iniciar sin limpiar.

**Versión probada:** ______________

---

### Prueba 5: Sesión manual año normal

Verificar que una sesión manual de 60 minutos en un mapa normal (fuera del Laberinto) se clasifica sin
fin falso, aparece en el historial y en la comparación de rendimiento con su calidad separada, y que
si falta su valor el total declara cuántas sesiones quedan sin valorar (auditoría §8.5).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Inicia sesión con **Activar detección asistida** en un mapa que no sea el 866.
2. Juega o simula actividad normal (sin sacos de Halloween) durante al menos 60 minutos.
3. Termina la sesión manualmente con **Terminar sesión de farmeo**.
4. Abre el panel de historial de sesiones (`ui/session-history-panel.ts`) y revisa el total y la
   comparación de rendimiento.

**Resultado esperado:**
- La detección asistida no propone un fin falso a los 15 minutos solo por no ver objetos de
  Halloween: sigue activa mientras haya evidencia de actividad relevante o el jugador la detenga a
  mano.
- La nota se guarda en `<carpeta de salida>/sessions/<año UTC>/`.
- El historial cuenta la sesión como manual, con su calidad (`exact`/`estimated`), y participa en la
  comparación de rendimiento sin mezclar calidades en una sola media.
- Si a esta sesión (u otra del conjunto) le falta valor, el total muestra el subtotal conocido y
  cuántas sesiones quedan sin valorar, sin llamarlo ganancia total.

**Evidencia mínima:** ruta y SHA-256 de la nota; captura del historial con la sesión clasificada;
captura de la comparación de rendimiento con el desglose por calidad.

**Versión probada:** ______________

---

### Prueba 6: Dos sesiones con detección rearmada

Verificar que, tras completar una sesión con la detección asistida activada, la detección vuelve a
funcionar sin tener que comprobar la conexión a mano (auditoría §8.6, hallazgo F7).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Activa la detección asistida y completa una sesión de principio a fin.
2. Sin pulsar **Comprobar conexión**, intenta que la detección proponga o permita iniciar una segunda
   sesión.

**Resultado esperado:**
- Tras guardar la primera sesión, la detección asistida vuelve a quedar operativa sola, sin que el
  jugador tenga que comprobar la conexión a mano.

**Depende de H18.x en desarrollo:** hoy, `armAssistedDetection` solo se dispara desde
**Comprobar conexión** (manual o el calentamiento automático de carga, `src/main.ts:1171-1173`) o
desde el comando **Activar detección asistida**; no hay ningún rearme automático al completar una
sesión. Ejecutar igualmente y confirmar que, sin uno de esos tres disparadores, la detección queda
desarmada tras la primera sesión (resultado ANTIGUO) hasta que la Entrega 2 lo cierre.

**Evidencia mínima:** captura del estado del detector inmediatamente tras completar la primera sesión,
antes y después de pulsar **Comprobar conexión**.

**Versión probada:** ______________

---

### Prueba 7: Atribución

Verificar que el delta no confunde un traslado A→B con ganancia, distingue movimientos entre
ubicaciones, y separa compras en el bazar/mercader sin contaminar la sesión (auditoría §8.7).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Durante una sesión activa, mueve un objeto de un personaje a otro (A→B) sin pausa.
2. Compra y vende en el bazar durante la misma sesión.
3. Compra a un mercader NPC.
4. Recoge una entrega del bazar (delivery).

**Resultado esperado:**
- El movimiento A→B no se cuenta como ganancia neta ni se duplica.
- Las compras/ventas en el bazar degradan la sesión a `estimated` (banda), nunca a `contaminated`.
- La compra a mercader NPC se resta en «Moneda neta» sin degradar la sesión.
- Recoger una entrega del bazar se refleja como movimiento de delivery, no como botín de sesión.

**Evidencia mínima:** nota de la sesión con las razones de clasificación (`tp_buy_observed`,
`tp_sell_observed`, `wallet_decreased`, `delivery_items_changed`, según aplique) visibles.

**Versión probada:** ______________

---

### Prueba 8: Inventario sin espacio

Verificar que la capacidad desconocida del almacén se etiqueta como tal y que los materiales por
encima de 250 se muestran con el mínimo observado, no como la capacidad exacta (auditoría §8.8).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Sin configurar una capacidad de material en Ajustes, sincroniza un vault con más de 250 unidades de
   algún material.
2. Configura una capacidad explícita (250-3.000, en pasos de 250) y repite.

**Resultado esperado:**
- Sin capacidad configurada, se muestra únicamente el mínimo garantizado (250) con su procedencia
  explícita, nunca como capacidad exacta.
- Con capacidad configurada, la suma de depósito nunca supera el hueco demostrado.
- Ninguna decisión se bloquea solo por desconocer la capacidad exacta; se separa lo conocido de lo
  asumido.

**Evidencia mínima:** captura de Ajustes con y sin capacidad configurada; captura de
`Bases/Materials.base` mostrando el mínimo observado.

**Versión probada:** ______________

---

### Prueba 9: Resincronizar

Verificar que **Sincronizar inventario** sin cambios de datos no reescribe notas, que un precio nuevo
sí, y que el texto añadido por el jugador se conserva (auditoría §8.9).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Pulsa **Sincronizar inventario** una vez y anota los hashes de las notas escritas.
2. Añade una línea de texto propio a una nota de inventario.
3. Vuelve a pulsar **Sincronizar inventario** sin que la cuenta haya cambiado.
4. Espera a que cambie un precio de venta instantánea (o fuerza una captura de precio distinta) y
   vuelve a pulsar **Sincronizar inventario**.

**Resultado esperado:**
- El paso 3 no reescribe ningún fichero (todas las filas «sin cambios», sin pedir confirmación) y
  conserva el texto añadido en el paso 2.
- El paso 4 sí actualiza las notas cuyo precio cambió, sin pedir confirmación (crear/actualizar sin
  desactivar filas no pausa el flujo).
- El texto humano fuera de los bloques gestionados nunca se pierde.

**Evidencia mínima:** SHA-256 de una nota antes y después del paso 3 (deben coincidir); SHA-256 antes
y después del paso 4 (deben diferir); captura de la nota con el texto propio conservado.

**Versión probada:** ______________

---

### Prueba 10: Fronteras de fecha

Verificar que las caducidades se declaran visiblemente (asesor hacia el 12 nov por la regla de 90
días, conocimiento curado el 1 dic, tabla de legendarias el 10 dic) y que las sesiones alrededor de
esas fechas siguen funcionando (auditoría §8.10 y §7 y §G).

**Plataforma:** Fedora con Proton (primaria). Esta prueba solo puede ejecutarse en o cerca de esas
fechas de calendario, o adelantando el reloj del sistema en un entorno de pruebas desechable.

**Pasos:**
1. Con el reloj del sistema en o después del 12 nov 2026, abre el Asesor de inventario.
2. Con el reloj en o después del 1 dic 2026, repite.
3. Con el reloj en o después del 10 dic 2026, revisa la recomendación de legendarias.
4. En cualquiera de esos momentos, completa una sesión normal y comprueba que se guarda con su fecha y
   el aviso de caducidad correspondiente, sin romper el flujo.

**Resultado esperado:**
- Pasado el 12 nov, el asesor degrada su confianza y lo declara.
- Pasado el 1 dic, el conocimiento curado se marca caducado.
- Pasado el 10 dic, la tabla de legendarias se marca caducada.
- Ninguna caducidad bloquea el guardado de una sesión; el aviso queda visible junto al resultado.

**Evidencia mínima:** capturas del aviso de caducidad en cada una de las tres fechas; nota de sesión
guardada con su fecha visible en cualquiera de ellas.

**Versión probada:** ______________

---

## Pruebas de aceptación (Halloween)

### Prueba 11: Drop que se queda frente a drop consumido

Verificar que el delta distingue un saco que permanece de uno que se abre entre dos lecturas de la
API, documentando qué se detecta y qué se pierde (auditoría §8.11).

**Plataforma:** Fedora con Proton, con el Laberinto del Rey Loco disponible (temporada o mapa 866).

**Pasos:**
1. Con detección asistida activa dentro del Laberinto, obtén un saco `36038` y espera a que se refleje
   en una captura.
2. Obtén y abre otro saco completamente entre dos lecturas consecutivas de la API (antes de que el
   siguiente poll capture el estado intermedio).

**Resultado esperado:**
- El saco del paso 1, que permanece en dos capturas, se resta correctamente al abrirse.
- El saco del paso 2, que aparece y se consume entre dos lecturas, no aparece en ninguna captura; la
  nota declara la limitación («no detectado entre capturas»), no un número inventado.
- La nota declara su cobertura y su limitación explícitamente.

**Evidencia mínima:** nota de sesión con la sección de cobertura/limitación visible para ambos casos.

**Versión probada:** ______________

---

### Prueba 12: Laberinto

Verificar el marcado automático de sesión al entrar al juego, el etiquetado como Laberinto al entrar
al mapa 866, el cierre al salir o tras 10 minutos desconectado, un drop de más de 5 oros visible
dentro del juego con su retraso real medido, y que reiniciar Obsidian no silencia los avisos
siguientes (auditoría §8.12, ya reescrita por la decisión del 24 sep, sección 9).

**Plataforma:** Fedora con Proton + Nexus (primaria para esta prueba); Windows con Blish HUD para el
recorrido de los compañeros de David (prueba 14 aparte).

**Pasos:**
1. Con el addon de Nexus conectado y el puente activo, entra al juego sin iniciar sesión a mano.
2. Entra al mapa 866 y obtén un drop de más de 5 oros.
3. Sal del mapa (o desconéctate más de 10 minutos) y observa el cierre.
4. Reinicia Obsidian con el addon aún conectado y provoca un segundo aviso.

**Resultado esperado:**
- La sesión se marca sola al entrar al juego, sin que el jugador pulse **Iniciar sesión de farmeo**.
- Al entrar al mapa 866 la sesión se etiqueta Laberinto.
- Al salir del mapa o tras 10 minutos desconectado, la sesión se cierra sola.
- El drop de más de 5 oros se ve dentro del juego; se mide el retraso real entre el drop y el aviso.
- Reiniciar Obsidian no silencia los avisos posteriores al primero.

**Depende de H18.x en desarrollo:** el marcado automático de sesión por los addons y su protocolo
bidireccional autenticado son la Entrega 5 de la auditoría (decidida el 24 sep, sección 9); no está en
`main` (verificado por grep: no hay ningún consumidor del puente que inicie o cierre una sesión de
producto, solo `alert-ingame-server.ts` pinta avisos en una sola dirección). Con el código de hoy, la
sesión solo se marca con **Iniciar sesión de farmeo** manual o con la detección asistida armada; los
pasos 1 y 3 de arriba no pueden dar el resultado esperado todavía. Ejecutar igual la parte de avisos
(pasos 2 y 4, que sí existen hoy) y registrar el resultado antiguo de marcado manual para el resto.

**Evidencia mínima:** captura del aviso en el juego con marca de tiempo; medición del retraso
(drop → aviso) en segundos; captura del estado de sesión tras reiniciar Obsidian.

**Versión probada:** ______________

---

### Prueba 13: Puente

Verificar el reinicio del puente o del addon, una conexión muda, dos addons simultáneos y una
desconexión sin cerrar el juego (auditoría §8.13).

**Plataforma:** Fedora con Proton + Nexus; Windows con Blish HUD.

**Pasos:**
1. Con el puente activo y un addon conectado, reinicia el addon (o el puente) y observa que el estado
   se recupera.
2. Conecta un cliente que abra el socket sin completar el saludo (conexión muda) y comprueba que no se
   cuenta como «entregado».
3. Conecta Nexus y Blish a la vez sobre la misma sesión.
4. Desconecta la red del addon sin cerrar el juego y observa la política de gracia.

**Resultado esperado:**
- El reinicio del addon o del puente no pierde la sesión ni el estado de avisos.
- Una conexión muda (sin saludo válido) no se cuenta como cliente entregado.
- Dos addons conectados a la vez no duplican ni fragmentan la sesión (hoy, sin protocolo
  bidireccional, verificar al menos que ambos reciben el mismo aviso sin errores).
- Una desconexión de red sin cierre del juego se distingue de un cierre real y no cuenta como fin de
  sesión por sí sola.

**Evidencia mínima:** log/captura del estado de conexión en cada uno de los cuatro pasos.

**Versión probada:** ______________

---

### Prueba 14: Windows con Blish

Verificar que un compañero en Windows con Blish HUD ve una sesión automática de principio a fin y un
aviso visible (auditoría §8.14, sección 9: Windows deja de ser solo beta para este recorrido).

**Plataforma:** Windows x64 con Blish HUD.

**Pasos:**
1. Instala el módulo de Blish HUD (`fc5d871` o posterior; comprobar que el `.bhm` instalado no es
   anterior al arreglo que reinicia la numeración de avisos al reconectar, auditoría §3.F).
2. Repite los pasos de la prueba 12 en esta plataforma.

**Resultado esperado:** el mismo que la prueba 12, en Windows con Blish.

**Depende de H18.x en desarrollo:** mismo bloqueo que la prueba 12 para el marcado automático (Entrega
5); además, el binario de Blish publicado en la release 0.1.0 apunta a `fc5d871`, anterior al arreglo
de reconexión — comprobar la versión exacta instalada antes de anotar un fallo como del plugin.

**Evidencia mínima:** versión exacta del `.bhm` instalado (hash o commit); captura del aviso en Blish
HUD con marca de tiempo.

**Versión probada:** ______________

---

### Prueba 15: Obsidian cerrado

Verificar que, al empezar a jugar con Obsidian cerrado, el addon lo abre solo y la sesión se marca sin
clics (auditoría §8.15, decisión 1 de la sección 9).

**Plataforma:** Fedora con Proton + Nexus (primaria); Windows con Blish (más directo, sin la capa
Proton).

**Pasos:**
1. Cierra Obsidian por completo.
2. Entra al juego con el addon instalado y activo a nivel de sistema/cliente de GW2.
3. Observa si Obsidian se abre solo y si la sesión se marca sin intervención.

**Resultado esperado:**
- Obsidian se abre automáticamente al detectar el juego.
- La sesión se marca sin que el jugador toque nada.
- La nota se genera correctamente al cerrar la sesión.

**Depende de H18.x en desarrollo:** decidido el 24 sep (sección 9, pregunta 1). La viabilidad técnica
ya está medida ([H18.27](SPEC-puente-ingame.md), sonda `docs/audit/sonda-h18-27-abrir-obsidian-desde-proton.md`):
un proceso dentro de Proton puede abrir/enfocar el Obsidian del host vía `winebrowser.exe`, e
implementada en el addon de Nexus (rama `feat/abrir-obsidian-al-arrancar`, pendiente de integrar).
En Fedora con Nexus, esta prueba ya puede ejecutarse como aceptación en cuanto esa rama esté
integrada, no solo como sonda de viabilidad. El marcado automático sigue siendo la misma Entrega 5
de las pruebas 12 y 14. En Windows con Blish HUD sigue sin verificarse ni el mecanismo de apertura
(Windows nativo, sin Wine/Proton) ni su integración; ejecutar ahí solo como sonda de viabilidad,
registrando el resultado como diagnóstico.

**Evidencia mínima:** log del intento de apertura (lanzado / sin handler / error, según lo que
muestre el panel de Options del addon); nota de qué mecanismo del sistema operativo se usó.

**Versión probada:** ______________

---

### Prueba 16: Venta del saco con datos de hoy

Verificar que la recomendación del saco (`36038`) usa una comparación cuantificada fechada, con banda
de incertidumbre, y que puede terminar honestamente en «sin ventaja demostrada para esperar» en lugar
de un calendario fijo (auditoría §8.16 y §3.D).

**Plataforma:** Fedora con Proton (primaria).

**Pasos:**
1. Con precio de hoy fresco para `36038`, abre la recomendación de venta dentro y fuera de la ventana
   de temporada del festival.
2. Compara el resultado con el backtest de la auditoría (mediana 1,020 en pre-festival, 0,911 en
   mayo, §3.D): la recomendación no debería preferir «esperar a mayo» sin justificarlo con datos
   fechados.

**Resultado esperado:**
- La recomendación lleva la fecha de decisión y el precio de hoy usado, por separado del histórico.
- La comparación es cuantificada (ventaja neta, rango, número de temporadas, riesgo de no vender),
  no un calendario fijo por día/mes.
- «Sin ventaja demostrada para esperar» es una salida válida y visible, nunca una fecha inventada.
- Se muestra la incertidumbre y el número de años de la muestra histórica usada.

**Depende de H18.x en desarrollo:** esta es la Entrega 4 completa (auditoría §7). Hoy,
`evaluateSeasonalRule` (`src/advisor/inventory-position-recommendation.ts:226-269`) sigue siendo un
calendario fijo por ventana de temporada: dentro de la ventana siempre `sell`, fuera de ella compara
solo contra el máximo del año corriente, sin la comparación de tres relojes (fecha del precio, vigencia
del análisis, ventana futura) ni el experimento reproducible que pide la auditoría. Ejecutar
igualmente contra el candidato actual y registrar el resultado antiguo (calendario fijo, sin banda de
incertidumbre) como línea de base para comparar cuando la Entrega 4 aterrice.

**Evidencia mínima:** captura de la recomendación con fecha de decisión y precio visible, dentro y
fuera de ventana.

**Versión probada:** ______________

---

## Medición de línea base (pendiente)

Estos límites se miden **después** de ejecutar una línea base real, **no antes** (auditoría §8, nota
final: «Los límites de retraso, clics y tiempos se fijan después de medir una línea base, no antes.»):

- Retraso entre el drop en el juego y el aviso dentro del juego (pruebas 12 y 14).
- Número de clics para completar una sesión de principio a fin sin el marcado automático.
- Tiempo de carga de las vistas (Companion, Asesor de inventario) sobre un vault con inventario grande.

No fijar un umbral de aceptación para estos tres antes de tener al menos una medición real registrada
en esta misma tabla.
