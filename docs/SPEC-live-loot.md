# SPEC: captura pasiva de inventario y sesiones live1

Contrato normativo autorizado por David el **6 de octubre de 2026** para sustituir la fuente API-only de las sesiones por el lector propio y pasivo de Nexus. Fija el comportamiento requerido para el código candidato 0.5.0; **gate conjunto y QA real pendientes** según [ESTADO](ESTADO.md). No acredita carga del addon ni QA Windows.

La [política de plataformas](PLATFORM_POLICY.md) fija la frontera autorizada y el [puente v2/v3](SPEC-puente-ingame.md) sigue siendo el contrato base. La [investigación histórica](audit/2026-10-06-loot-memory-live.md) y su [procedencia verificable](audit/live-loot-evidence-provenance.md) acreditan solo las sondas allí descritas. Esta decisión prevalece sobre las descripciones históricas API-only para sesiones; no amplía la política específica H8 ni elimina integridad, privacidad o acciones manuales del inventario.

## 1. Decisiones vigentes

- Nexus es el único productor de observaciones. Hebra/Obsidian reciben por el puente existente; el núcleo de Tyrian posee sesiones, persistencia, precios, avisos y proyecciones. Sin servicio adicional ni cambios en H8.
- API autenticada: únicamente acciones manuales de inventario/cartera y la comprobación explícita de su conexión. Ningún arranque, presencia, inicio, observación, cierre, recovery, comparación, MF o refresco de la vista live lanza consultas autenticadas. Sin fallback automático API cuando falta Nexus. Catálogo y precios públicos siguen disponibles, mediante clientes, cachés y permisos existentes.
- Presencia y disponibilidad de fuente son estados distintos. La sesión sigue la conexión al juego, con gracia de diez minutos; un hueco de lectura se registra aunque Blish siga conectado y la presencia nunca se pierda.
- Baseline no es botín. La señal es inventario agregado observado, no un evento causal del motor del juego. No se promete observar cambios que ocurren y se compensan entre muestras.
- Solo lectura pasiva del juego: sin hooks nuevos, inyección de código adicional al addon cargado normalmente por Nexus, llamadas a getters del juego, escritura en su memoria, ptrace, suspensión de hilos ni automatización. Las funciones/vtables del perfil sirven para comprobar identidad y estructura, no para invocarlas.
- Una fuente Nexus vinculada por sesión. El `instance` del hello identifica un proceso addon, no una cuenta GW2. No asociarlo automáticamente con la cuenta de una clave API configurada.
- Blish conserva presencia, avisos y HUD en su 0.5.0 publicada, congelado desde el 8 oct 2026 (Nexus es obligatorio para las funciones en vivo y Blish no recibe funciones nuevas). Para el nuevo feed necesitaba Nexus local como productor; Blish/Mumble no aportan objetos ni monedas. Mostrar la carencia cuando no exista fuente. La QA Windows sigue siendo necesaria y la nueva dependencia debe explicarse.
- El objetivo completo incluye monedas y MF pendiente del audit. Se permite entregar código que declare falta de cobertura; eso no cierra esas tareas ni el objetivo completo.

## 2. Negociación y compatibilidad

Conservar sin cambios `hello`, `welcome`, v2/v3, autenticación, framing UTF-8, CRLF aceptado, claves exactas, rechazo de claves duplicadas, límite **512 bytes por línea sin terminador**, nonce, secuencia y plazos existentes. Ningún campo nuevo en hello/welcome/alert/farm1.

Solo en conexión v3 autenticada, el servidor nuevo envía una capacidad independiente:

```json
{
  "v": 3,
  "type": "live_cap",
  "nonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "tag": "live1"
}
```

Clientes anteriores ignoran el tipo desconocido. Un Nexus nuevo frente a servidor antiguo no envía mensajes live. La ausencia de capacidad significa fuente live no disponible, sin impedir contexto/avisos.

Nexus manda primero el `context` ordinario. Con gameplay y capacidad, abre una época:

```json
{
  "v": 3,
  "type": "live_open",
  "nonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "seq": 1,
  "tag": "live1",
  "epoch": "AgICAgICAgICAgICAgICAg",
  "build": "27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c",
  "profile": "owned-bags-v3"
}
```

`epoch`: 16 bytes aleatorios, base64url canónico de 22 caracteres, mismas reglas que nonce. `build`: SHA-256 minúscula de 64 caracteres. `profile`: exactamente `owned-bags-v3` en esta revisión. Todos los mensajes addon→host consumen **la misma** secuencia `seq` que context/heartbeat/bye/alert_ack/farming_sub; inicia en 0 y avanza de uno en uno. No existe una secuencia TCP paralela para live.

El servidor contesta:

```json
{
  "v": 3,
  "type": "live_ready",
  "nonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "tag": "live1",
  "epoch": "AgICAgICAgICAgICAgICAg",
  "status": "ready"
}
```

`status`: `ready|source_conflict|unsupported_build|not_gameplay`. Solo `client:nexus` puede abrir fuente. Un segundo productor no reemplaza al propietario de una sesión: recibe `source_conflict`, conserva contexto/avisos y aparece excluido. Se permite reconectar al mismo `instance`. No se cambia de proceso durante una sesión activa ni se mezclan sus muestras. Nueva fuente tras cierre produce sesión nueva. La atribución de mapa/personaje de live usa el contexto del productor seleccionado, no el contexto de otro cliente.

> **Regla añadida el 7 oct 2026 por decisión de David (relevo de una sesión caída):** si el host ha visto cerrarse la conexión del productor vinculado a la sesión activa, y ese productor no tiene ahora ninguna conexión abierta, otro `instance` puede relevarlo aunque el almacenamiento estuviera caído y la desconexión no llegara a guardarse. El relevo es el mismo que cuando la desconexión sí se guardó: la sesión anterior se cierra en el instante en que se vio cerrarse esa conexión, con lo que tenía guardado, y la fuente nueva empieza una sesión nueva con su propia línea base. Mientras el productor vinculado conserve alguna conexión abierta, un segundo productor sigue recibiendo `source_conflict`, haya o no almacenamiento. Lo que el host sabe de las conexiones vive solo en memoria; tras reiniciar el host rige la recuperación de §4. Si el almacenamiento sigue caído cuando llega el relevo, el cierre de la sesión anterior no se puede guardar y la respuesta sigue siendo `source_conflict`: no se abre una sesión nueva sin haber guardado el cierre de la anterior.

`live_cap`, `live_ready` y `live_ack` no usan `alert.seq` ni `farming_state.seq`. Son respuestas ligadas al nonce y, donde procede, época/cursor; nunca generan alert_ack. Repetir live_open de la misma época en la misma conexión devuelve el mismo ready sin reiniciar nada. Una época distinta invalida el ensamblado previo y exige baseline. El host solo permite una época viva por fuente.

## 3. Snapshot en lotes y tipos exactos

El addon agrega cantidades por ID antes de transportar. No envía punteros, PID, rutas, memoria cruda, nombre de cuenta ni slots individuales. Una muestra completa contiene los totales de todos los objetos leídos y los saldos de las monedas expresamente soportadas.

### live_begin (claves exactamente como el ejemplo)

```json
{
  "v": 3,
  "type": "live_begin",
  "nonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "seq": 2,
  "tag": "live1",
  "epoch": "AgICAgICAgICAgICAgICAg",
  "cursor": 0,
  "ctx": 0,
  "ms": 0,
  "mode": "baseline",
  "items": "complete",
  "currencies": "none",
  "unknown": 0,
  "slots": 8,
  "rows": 2
}
```

- `cursor`: entero seguro no negativo. Empieza en 0; cada muestra comprometida de esa época incrementa uno. Independiente de seq. `mode`: `baseline|sample`; cursor 0 exige baseline, posteriores sample.
- `ctx`: seq del context vigente que el productor capturó para esta muestra. Al aceptar un **begin nuevo**, debe corresponder al último context recibido de ese productor, en gameplay; el receptor fija también su valor semántico `(state,mapId,character)`. Un context posterior con seq nuevo y los mismos tres valores NO invalida el lote, abre hueco ni cambia época: solo actualiza la referencia de transporte para el siguiente begin. Un cambio real de cualquiera de los tres durante el ensamblado invalida el lote y exige época nueva; aunque luego vuelva al valor anterior, no recupera la continuidad perdida. Cambiar mapa/personaje corta época pero no cierra por sí solo la sesión de conexión. Para repetir el último cursor comprometido se acepta el ctx original guardado si el contexto semántico sigue siendo el mismo y la época no ha sido invalidada; no se obliga a reescribir la muestra repetida con un ctx más reciente.
- `ms`: milisegundos monotónicos desde la primera captura de la época (0 en baseline); entero seguro, creciente en muestras. Marca la captura, no su envío. El host conserva su fecha UTC de recepción por separado; no afirma hora exacta del drop.
- `items`: `complete|partial|none`. `complete` significa cobertura completa de las bolsas propias del personaje controlado bajo el perfil, no de toda la cuenta. `partial` indica cantidades/posiciones no resueltas; `none` ausencia de lectura.
- `currencies`: `none|listed`. En listed solo están cubiertos los IDs presentes como filas de moneda; **todos los IDs soportados se incluyen incluso con saldo cero**; soportado significa que la clave está presente en el mapa nativo de la cartera en esa lectura. Omitir un ID de moneda no significa cero.
- `unknown`: entero 0..4096, número de posiciones presentes cuya cantidad/identidad no se puede resolver; complete exige 0; none no admite filas de objetos.
- `slots`: huecos libres medidos del mismo inventario, entero 0..4096 o null. No derivar desde banco/cuenta. Si no se pueden demostrar, null.
- `rows`: número total de filas del lote, entero 0..4096. Currencies none prohíbe filas moneda; listed exige al menos una. Los límites son defensas del contrato, no afirmación sobre capacidad del juego.

### live_rows

```json
{
  "v": 3,
  "type": "live_rows",
  "nonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "seq": 3,
  "tag": "live1",
  "epoch": "AgICAgICAgICAgICAgICAg",
  "cursor": 0,
  "part": 0,
  "rows": [
    [0, 12147, 0],
    [0, 36038, 200]
  ]
}
```

Cada fila es una tupla exacta `[kind,id,quantity]`; kind 0=objeto, 1=moneda. ID entero 1..2147483647, quantity entero 0..2147483647. Cantidad es total agregado; puede superar 250 por sumar stacks. El perfil nativo actual solo acepta **cada stack** en 0..250. No recortar overflow ni convertir desconocido en 0.

De 1 a 8 filas por trama; `part` empieza en 0 y crece de uno en uno. Orden global lexicográfico por `(kind,id)`, sin duplicados. Emisor debe comprobar 512 bytes después de serializar; receptor también. Cero filas totales significa begin→end, sin live_rows.

### live_end y ACK durable

```json
{"v":3,"type":"live_end","nonce":"AQEBAQEBAQEBAQEBAQEBAQ","seq":4,"tag":"live1","epoch":"AgICAgICAgICAgICAgICAg","cursor":0}
{"v":3,"type":"live_ack","nonce":"AQEBAQEBAQEBAQEBAQEBAQ","tag":"live1","epoch":"AgICAgICAgICAgICAgICAg","cursor":0,"status":"stored"}
```

El receptor publica **solo** tras end, conteo/orden/contexto válidos y commit local durable con lease vigente. Antes, nada entra en totales, precios, gráfica, aviso ni UI de adquisiciones. `live_ack.status`: `stored|storage_unavailable|not_owner`; los dos fallos no autorizan descartar como guardado ni publicar. El addon muestra fallo de medición, mantiene presencia y reinicia el canal live mediante reconexión acotada cuando sea recuperable; no crea un bucle de muestras que no pueden persistirse.

Máximo un lote en vuelo; 4096 filas, 512 chunks, **256 KiB** de bytes de muestra y 10 s desde begin hasta end. Timeout/incompletitud descarta todo el lote y abre hueco; no cierra por sí sola la sesión. Nonce/seq/esquema inválidos conservan el cierre de conexión con los códigos existentes. Context/heartbeat pueden intercalarse; solo un cambio semántico de context invalida el lote, nunca su nueva revisión/seq por sí sola. Serializar ensamblado y commit: un segundo begin no puede adelantarse al commit pendiente ni reiniciar un lote en curso. Nunca bloquear render ni el hilo de juego esperando red o disco.

Tras end, el productor espera ACK antes de emitir otra muestra. El lector puede mantener la última lectura local acotada; no acumula backlog ilimitado. Timeout de ACK 10 s: reconexión y nueva época/baseline. No se implementa replay durable en el addon en este lote. Sus consecuencias quedan declaradas: pérdidas entre muestras y durante caída/reinicio no se reconstruyen.

Deduplicación durable por `(sourceInstance,epoch,cursor)`: se admite repetir **solo el último cursor comprometido** de la época vigente. El reintento completo usa nuevos seq de transporte consecutivos, empieza part en0 y conserva mode/ctx/ms/cobertura/filas originales. El fingerprint canónico incluye los metadatos de muestra y las filas ordenadas; excluye nonce, seq, partición en chunks y fecha de recepción. Contenido idéntico recibe stored sin nuevo commit lógico, filas, precios, avisos, cambio de baseline, cierre de huecos ni renovación de frescura. Mismo identificador y contenido distinto es error de protocolo. Esto incluye cursor0/mode baseline/ms0: repetirlo después de guardar el baseline solo devuelve ACK, no reinicia sesión/época ni vuelve a aplicar baseline. Comprobar esta rama antes de exigir cursor+1/ms creciente. Si ya se comprometió cursor1, repetir cursor0 se rechaza como replay antiguo; no se mantiene un historial ilimitado de fingerprints.

Una muestra nueva requiere cursor=último+1 y ms mayor al último, o cursor0/baseline/ms0 si la época aún no tiene muestra. El cursor solo avanza una vez al commit; begin/chunks y ACK duplicados no lo avanzan. Un ACK stored solo libera al productor si coincide exactamente con nonce/época/cursor del lote que espera; uno tardío de otro lote se ignora. Si la conexión cambia, hay nonce y época nuevos: no se reproduce cursor0 de la época vieja. No aceptar cursores futuros con salto como si fueran continuos: error de continuidad, hueco, nueva época. Los secuenciadores paran antes de superar enteros seguros.

## 4. Estado de fuente, huecos y frecuencia

Además de las muestras, Nexus puede informar:

```json
{
  "v": 3,
  "type": "live_status",
  "nonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "seq": 5,
  "tag": "live1",
  "epoch": "AgICAgICAgICAgICAgICAg",
  "status": "unavailable",
  "reason": "read_failed"
}
```

Claves exactas; `status` es `unavailable` y `reason` es `unsupported_build|root_unavailable|read_failed|partial_inventory|not_gameplay`. Este mensaje descarta lote, invalida comparabilidad y abre hueco desde la última muestra válida. Su epoch puede ser null si nunca se abrió una. Recuperar requiere live_open con época nueva. No mostrar excepciones, direcciones ni datos crudos en reason. `live_status` solo se envía después de live_cap, por Nexus autenticado.

Captura objetivo inicial: una muestra por segundo, limitada por lectura segura y ACK; comunicar resolución observada real, no prometer 100 ms. 5 s sin muestra completa implica fuente stale aunque lleguen heartbeats. El temporizador, un context equivalente y un ACK/reintento duplicado no rejuvenecen `ms` ni la fecha de captura. Pérdida de conexión/productor, fallo global de lectura, live_status, cambio real de contexto o caducidad invalidan la época: abrir huecos de los canales afectados y exigir live_open/época/baseline nuevos. Una pérdida de cobertura declarada dentro de una muestra atómica válida afecta solo al canal correspondiente, como se define a continuación. Nunca inferir del baseline lo adquirido durante un hueco.

No calcular delta de objetos entre muestras con items partial/none ni atravesándolas. Guardar cobertura/diagnóstico y cantidades conocidas para inspección, abrir hueco de items y dejar su baseline local inválido. La primera muestra posterior items complete es **baseline local de items**, sin cambios/avisos para ese canal; cierra su hueco. Puede llevar mode sample y cursor consecutivo de la misma época: este rebaseline por cobertura NO requiere live_open ni reinicia las monedas sanas. En cambio live_status partial_inventory declara fuente globalmente no disponible y sí exige época nueva; no usarlo para una muestra parcial que todavía aporta monedas válidas.

Para moneda, comparar solo un ID presente y cubierto en las dos muestras consecutivas; ausencia/pérdida de cobertura corta su continuidad. Su primera aparición o reaparición es baseline local de ese ID, sin delta. Monedas listadas pueden seguir aportando cambios mientras items está parcial, y viceversa. Un hueco currencies indica que el conjunto de monedas previamente cubierto dejó de estar completo; no niega los cambios observados válidos de IDs que permanecen cubiertos. Cerrar ese hueco solo cuando todos los IDs que faltaban vuelvan a tener baseline; mantener internamente ese conjunto durante recovery. `observedCurrenciesMs` cuenta únicamente intervalos con todos los IDs del conjunto cubierto presentes en ambos extremos; los cambios de IDs individuales no autorizan un total monetario completo cuando falta otro. Monedas sin soporte desde el inicio son coverage none, no un saldo cero ni una sucesión infinita de huecos. Límite conocido: el mapa nativo de cartera es disperso y una moneda que la cuenta nunca ha tenido no tiene clave. Su primera aparición es línea base local sin delta, así que su primera ganancia no se cuenta.

Huecos: representar un registro independiente por canal (channels con un único elemento); no cerrar currencies porque se recuperó items. Su fromAt es la última captura válida del canal, o startedAt si nunca pudo empezar. Mantener un solo hueco abierto por canal, conservando la primera causa; repetir errores no crea huecos solapados ni cambia fromAt. Cerrarlo con toAt de la captura comprometida que restablece su baseline, sin contar ese intervalo como observado. La posterior muestra comparable empieza a sumar tiempo desde ese baseline. Al finalizar la sesión, cerrar todo hueco abierto en endedAt, marcado por su razón existente y manteniendo el resultado incompleto: cerrar un hueco al terminar NO significa recuperación. Recortar los intervalos a [startedAt,endedAt] y omitir los de longitud cero; una sesión complete nunca conserva toAt null. Para el tiempo cubierto de tasas, usar unión de huecos del canal relevante, sin restar dos veces los huecos simultáneos de items/currencies. Ese cálculo no descuenta huecos de la duración declarada de conexión.

Desconexión: cerrar época; persistir gaps por canal desde sus últimas capturas válidas, mantener sesión durante la gracia existente. `game_exit` cierra con la última evidencia ya guardada, sin API final; si endedAt es posterior a la última captura cubierta, conservar ese tramo final sin observación en el canal pertinente. La pérdida abrupta puede impedir última muestra: cierre incompleto declarado. Host reiniciado restaura journal/cursor/sesión y huecos por canal, pero la nueva conexión exige nueva época y baseline. Ningún cero sintético ni aviso atrasado del baseline.

Recuperación tras una caída del almacén con el host vivo (7 oct 2026). Mientras el almacén rechaza escrituras, ninguna muestra se da por guardada y la vista muestra el error; lo que no pudo escribirse (causa del hueco, fin de época, desconexión del productor, presencia) queda en memoria y lo escribe el primer paso de ciclo de vida que encuentre el almacén de vuelta, sin temporizador ni bucle propios. Al volver queda un hueco `storage_unavailable` (o la primera causa que no se pudo guardar) en cada canal afectado, desde su última captura válida, y ningún delta lo cruza: la primera muestra guardada después es baseline local. No se inventa una desconexión ni se reinicia el enlace del productor. Si la lease se perdió durante la caída, el mismo recobro la readquiere y aplica estas mismas reglas, no las de un reinicio del host. Lo mismo vale para una lease perdida dentro del mismo proceso SIN caída del almacén (p. ej. tras suspender el equipo): solo `initialize` marca un reinicio del host; el recobro conserva el enlace y la presencia que el anfitrión conoce, deja el hueco con la misma causa `storage_unavailable` (no hay causa nueva: las escrituras de ese tramo fueron igualmente rechazadas), y aplica la última presencia notificada mientras estaba perdida, de modo que una desconexión de más de 10 minutos cierra la sesión en la última evidencia como siempre. Una escritura que el almacén aplicó pero contestó como fallida se trata, antes de escribir la memoria, como tras un reinicio con ese mismo disco: si el registro guardado es de la misma sesión y autoridad y está por delante de la memoria, pasa a ser la base y sus entradas de diario se publican una vez. Esto precisa la frase de §3 según la cual un fallo no autoriza a publicar: la muestra sí quedó guardada. Este último punto es decisión de implementación del 7 oct 2026, no una regla pedida por el usuario.

### 4.1. Presencia agregada, duración y objetivos

Precisión de ingeniería ratificada el 6 oct 2026, incorporada al código candidato; **verificación conjunta y QA real pendientes**. Mientras se pierde la presencia agregada de todos los addons, la sesión conserva su fase activa y la gracia de diez minutos, pero la proyección provisional de duración usa `lastPresenceAt` como extremo temporal en vez de avanzar con cada tick. El progreso y la cuenta atrás del objetivo de duración usan ese mismo reloj: el tiempo transcurrido durante la gracia no puede marcarlo alcanzado para luego revertirlo al cerrar en la última presencia. Al restaurarse la presencia agregada, se recupera el reloj de la conexión declarada, sin descontar una pausa inferida ni afirmar tiempo efectivamente jugado.

La indisponibilidad o antigüedad de la fuente, errores de items/currencies y pérdida de Nexus con gameplay de Blish todavía vivo no congelan este reloj. Los huecos de lectura solo afectan cobertura, tasas y la disponibilidad de ETA de bolsas según sus reglas; no son interrupciones del jugador. Esta precisión no añade estados, campos, almacenamiento ni pausas durables. Aceptación mínima: objetivo de 60 s, última presencia a los 55 s y tick a los 61 s durante pérdida agregada conserva 55 s y objetivo no alcanzado; restaurar presencia reanuda el reloj declarado, y mantener Blish en gameplay impide ese acotado aunque Nexus deje de observar.

## 5. DTOs que B expone a C

Módulo contractual asignado al núcleo: `src/sessions/live-session-model.ts`, propiedad B. Esta ruta identifica la juntura acordada, no acredita que su implementación o runtime estén verificados. C importa tipos, no reconstruye deltas desde DOM/StorageSnapshot. A usa las mismas fixtures wire, no depende de TypeScript.

`LiveObservationV1`:

```
version: 1
id: string                   # determinista: epoch/cursor/kind/id
source: 'nexus_inventory'
epoch: string; cursor: number
kind: 'item' | 'currency'; idNumber: number
before: number; after: number; delta: number
observedAt: string           # UTC de recepción del snapshot completo
windowStartAt: string        # recepción snapshot anterior; no fecha exacta del drop
sourceElapsedMs: number      # reloj monotónico del productor
cause: 'unknown'             # live1 nunca afirma venta/drop/apertura/depósito
coverage: 'observed_interval'
```

`LiveGapV1`: `{version:1,fromAt:string,toAt:string|null,reason,channels:('items'|'currencies')[]}`. Reason cerrado: `disconnect|source_stale|read_failed|partial_inventory|context_changed|host_restart|storage_unavailable|unsupported_build|source_missing|cursor_gap`. No crea observaciones por sí mismo.

`LiveSessionViewV1` (única proyección UI/HUD, propiedad B salvo formato visual):

```
version:1
sessionId:string|null
phase:'idle'|'starting'|'active'|'stopping'|'complete'|'error'
sourceState:'missing'|'warming_up'|'ready'|'stale'|'unavailable'|'conflict'
sourceReason:string|null     # solo enums anteriores; no error libre
source:'nexus_inventory'|null
startedAt:string|null; endedAt:string|null
elapsedMs:number|null; observedItemsMs:number; observedCurrenciesMs:number
lastObservationAt:string|null
itemCoverage:'complete'|'partial'|'none'
currencyCoverage:'none'|'listed'; currencyIds:number[]
freeSlots:number|null
observations:LiveObservationV1[]   # ventana paginable, nunca render infinito
gaps:LiveGapV1[]
totals:{kind,idNumber,positive,negative,net}[]
valuation:LiveValuationV1
magicFind:{value:number|null,source:'manual'|'verified'|'unknown'}
```

La API concreta de paginación queda local a B/C pero debe servir todas las filas en exportación. No truncar journal para limitar DOM. B publica `getLiveSessionView()` y suscripción ya integrada en refrescos del runtime; C no añade polling API. Persistir fuente/MF y procedencia; hoy no hay MF verified del lector. No degradar los controles manuales de preparación existentes ni prometer MagicFinder integrado.

## 6. Persistencia y legacy

Actualmente `SessionRuntimeRecord` v3 obliga a baseline/final StorageSnapshot y delta API; no fabricar estos objetos para introducir live. Añadir variante v4 discriminada `kind:'live_inventory'` al contrato del store existente. Mantener lectura v3 y sus validadores de forma; el recovery legacy puede mostrar/exportar evidencia guardada pero no consultar la cuenta automáticamente ni mezclarla con live.

Variante v4 contiene: sesión/lease/autoridad existentes, sourceInstance+profile+build, estado/época/contexto, última muestra comprometida y fingerprint/cursor, ledger de cambios, gaps por canal, precios capturados, contexto manual de preparación y receipt de nota. Utilizar transacción atómica del almacenamiento local existente para commit de cursor+muestra+observaciones; si hacen falta stores nuevos para journal, versión IDB aditiva, preservar el store y registros antiguos. No guardar una cronología creciente íntegra por cada tick si provoca reescritura cuadrática: journal append por muestra con clave compuesta y cursor en la misma transacción.

La representación durable de nota live será `tc_schema:7`, `tc_kind:session`, `tc_source:nexus_inventory`, con snapshot de resumen y ledger/coverage versionados en los bloques gestionados existentes; sin baseline crudo, punteros, IDs de cuenta ni sourceInstance raw en la nota. El identificador local de fuente se conserva solo en runtime; exportar `source:nexus_inventory`, build/profile y sesión pseudónima. `tc_account_ref` queda null/desconocido para live si no existe identidad demostrada; no inventar una cuenta a partir de instance/character. Ajustar lectores a un modelo discriminado, conservando notas schema1..6 sin reescritura. Legacy se presenta como neto API, no se fusiona en comparaciones live como si midiera lo mismo.

> **Presentación simplificada el 6 oct 2026 por decisión de David:** el selector CSV/JSON con «Exportar», «Sesión guardada» + «Actualizar historial», la recuperación y la exportación de la sesión anterior de cuenta, «Comparar tandas Nexus» y «Preparar la próxima tanda» dejan de pintarse en la pestaña «Sesión». Los datos y las exportaciones por comando se conservan y siguen exigiendo todo lo de este apartado.

Mantener notas humanas, CAS/verificación de regiones, recovery y requisito de receipt de nota antes de liberar. JSON/CSV live deben incluir todas las observaciones, huecos, fuente, tiempos, cobertura, cantidades, snapshot de precios y su criterio. Reusar exportación create-only, versionando el formato exportado cuando cambie su esquema. No sobrescribir exportaciones existentes.

### 6.1. Transferencia durable del runtime API legacy

Excepción estrecha de migración, ratificada como decisión de ingeniería dentro del alcance de conservar históricos y habilitar sesiones Nexus sin API. **Implementación en código candidato; verificación conjunta y QA real pendientes.** Permite retirar la clave `active-session` del store `active-session-v1` mediante transferencia durable de un runtime v3 válido, sin exigir una nota final que ese registro todavía no tenga. No es una finalización, un descarte ni una eliminación de evidencia; no relaja el receipt-before-clear del cierre live ni del recorrido v3 habitual.

- Se usa la misma base de datos y el store `active-session-v1`, que contiene la clave `active-session`. El destino es la clave `legacy-api-runtime:<sessionId>` en ese mismo store: conserva el registro v3 original validado, el recibo real de nota vinculado a esa misma sesión cuando exista, checksum del contenido preservado y `preservedAt`. Si no existe recibo, se conserva esa ausencia. No se fabrica receipt, estado `complete`, `endedAt`, snapshot final ni delta.
- La operación exige un lease específico de la sesión legacy: `handle.sessionId` debe coincidir con su ID y la autoridad seguir vigente. No se reutiliza el handle de la futura sesión live ni se arrebata un lease a un propietario vivo. Un v3 inválido, recibo presente que no corresponda o lease ajeno bloquean la transferencia conservando el activo.
- Antes de transferir se detiene y drena el trabajo local de esa sesión que pueda volver a escribir. No se inicia recaptura API para completar o reparar el registro. Dentro de la transacción se relee y compara por CAS el valor observado de la clave `active-session` del store `active-session-v1`, se comprueba la autoridad y se valida el destino. Un cambio concurrente, colisión o error aborta sin sobrescribir archivo ni liberar el único registro activo.
- Una sola transacción durable guarda el archivo íntegro y retira la clave `active-session` del store `active-session-v1`. No se publica éxito antes del commit. Solo después se libera el lease legacy y se adquiere la autoridad de una sesión live nueva. Si esa adquisición falla, el archivo ya preservado permanece; no se convierte ni se borra para reintentar. La nueva fuente exige su propia época/baseline y nunca calcula delta contra el snapshot API archivado.
- El archivo permanece de solo lectura, legible y exportable, incluso tras reiniciar. Preserva identidad, origen API y controles de acceso de la evidencia histórica; no se atribuye a la fuente Nexus ni se mezcla con sus observaciones. No se borra la copia preservada durante rollover, recovery o inicio live.
- Las acciones legacy de recaptura API o descarte no operan sobre un v4 ni sobre el archivo de solo lectura. La transferencia no autoriza consultas autenticadas automáticas ni una acción de borrado nueva.

B implementa esta migración en modelo/store/runtime. Pruebas requeridas: fallo IDB antes/durante commit conserva activo y evita pérdida; reread/CAS concurrente y colisión abortan; handle de otra sesión o dueño vivo no transfieren; v3 inválido y recibo cruzado bloquean; v3 sin recibo se conserva sin fingir finalización; tras reinicio el archivo se lee/exporta y sigue intacto; una nueva sesión live empieza con baseline propia, sin API ni cruce de datos; recaptura/descarte legacy no mutan v4 ni archivo. Los gates de finalización habituales siguen exigiendo su receipt.

## 7. Economía, gráfica y avisos

`LiveValuationV1` separa:

- `positiveItemValueKnownCopper`: valor de incrementos observados con precio conocido; puede incluir retiradas/compras y no equivale a beneficio.
- `netItemValueKnownCopper`: suma de delta firmado por precio unitario fijado para esa proyección; preserva pérdidas observadas.
- `coinNetCopper:number|null`: neto observado del oro (moneda 1) si la sesión lo ha seguido alguna vez, 0 si no cambió, null si nunca estuvo cubierto. Un hueco de monedas no lo anula: el hueco se guarda aparte.
- `knownNetValueCopper:number|null`: `netItemValueKnownCopper + coinNetCopper` cuando `coinNetCopper` no es null; null si no. En una sesión guardada, la gráfica se revalora con oro si la valoración guardada lo traía. «Por hora» (pestaña «Sesión») es la tasa del mismo valor que «Valor estimado» (objetos más oro cuando el oro se ha seguido, solo objetos si no) sobre el tiempo de objetos observado `observedItemsMs`; gastar oro la baja, un hueco de monedas no cambia el denominador, y se oculta si el tiempo de objetos observado es de menos de 15 minutos (`LIVE_RATE_MIN_OBSERVED_MS`, decisión de David del 8 oct 2026, los mismos 15 minutos de la nota resumen) o hay objetos sin precio. La regla es una sola para «Por hora» de la pestaña, el ritmo `lo`/`hi` de `farm1` y los bolsas/h de la comparación: depende solo de ese tiempo, no de que la última muestra fuera `partial` ni de que hubiera un hueco en medio, y la cifra se calcula solo sobre lo observado (los tramos `partial` no suman deltas ni tiempo). Un hueco y el fin de la sesión descartan la última muestra (cobertura `none`) pero conservan el tiempo observado, así que la vista reconstruida desde una nota guardada aplica la misma regla al pintar, también con una nota antigua (sin reescribirla); con menos de 15 minutos `observed` y los totales se siguen enviando y pintando, sin tasa. Etiqueta «Valor neto estimado», nunca «beneficio exacto».
- `unpricedItemIds`, moneda sin cobertura y gaps explícitos. Precio desconocido no vale cero. Divisas distintas de oro no se convierten a cobre sin modelo económico ya soportado y criterio mostrado.
- `priceBasis:'instant_sell_net'`, capturedAt y unitCopper por ID; reutilizar precio de venta inmediata neta y reglas/fees existentes, no duplicar fórmulas. Si no hay cotización válida, cantidad permanece visible. No usar valoraciones DRF.

Una venta puede retirar objetos y aumentar oro, por lo que neto firmado evita sumar íntegramente ambos como ganancias. Sin causa no afirmar que la operación fue venta. Depósito puede bajar bolsas sin bajar patrimonio: mostrar explícitamente ámbito bolsas, no riqueza de cuenta.

> **Presentación simplificada el 6 oct 2026 por decisión de David:** la pestaña pinta una sola gráfica, la de valor estimado, con los huecos de lectura como franja y corte; la gráfica de cantidad y «Datos de la gráfica» dejan de pintarse en la pestaña. `chartPoints` sigue llevando ambas series y los huecos.

Gráfica: cantidades observadas y valor estimado, huecos sin interpolación; al actualizar precios, recalcular toda la curva visible con el mismo snapshot y rotular su hora, o conservar el snapshot elegido al cierre. No mezclar precios sucesivos haciendo pasar una revalorización por adquisición. Valor/h = valor neto elegible / duración observada pertinente; null ante denominador cero o cobertura insuficiente; subtotal/h puede mostrarse como parcial con etiqueta distinta. La gráfica (viva y de una sesión guardada) cubre la sesión entera en como mucho 600 puntos: el primero, cada corte y el último (el valor actual exacto) nunca se pierden, solo cuentan las muestras que observaron algo y, si aun así se pasa del límite, se aclaran los puntos antiguos con un paso que se duplica (`LiveChartBuilder`); el límite de 600 incluye el punto final, nunca se supera y el primer punto no se pierde; si los cortes por sí solos lo superan, los cortes más antiguos tras el primero dejan de serlo y se funden en la línea, en lotes de un octavo del límite para que el coste por muestra no crezca (se conservan el primero y el último). Qué puntos quedan depende solo del ledger, no de los precios. Cronología, resumen, gráfica y export derivan del mismo ledger.

Avisos: reutilizar motor/umbral/canales existentes para observación positiva valorizable, clave idempotente observation.id + regla. Texto «Aumento observado: 2 Champiñones · valor estimado…»; jamás «drop», «botín confirmado» o «vendido» por inferencia. Baseline, negativo, muestra incompleta, duplicado, rebaseline, sin precio o fuera de cobertura no emiten aviso de objeto caro. Un precio que llega tarde no vuelve a avisar de una observación ya procesada; la regla evalúa una vez al resolver la observación pendiente o la descarta explícitamente al cerrar el intervalo, con intención y recibos durables según §13, sin insertar avisos live en la cola legacy ligada a cuenta. No requiere confirmación humana ni acciones en juego.

## 8. Ejemplo canónico UI y fixtures

> **Presentación simplificada el 6 oct 2026 por decisión de David:** la pestaña «Sesión» pinta una cabecera con un botón, «Valor estimado», «Por hora» (solo si hay tasa elegible), una gráfica de valor, la rejilla de objetos con las monedas observadas justo detrás y la cronología desplegable (lo último arriba, de 50 en 50). El orden, pedido por David el 8 oct 2026 («estado, valor estimado, gráfica y objetos»), es el del DOM y el visual: la gráfica va antes que los objetos (antes iba después de las monedas); las monedas siguen detrás de los objetos. Las pestañas «Cronología / Resumen de sesión», la tarjeta de coberturas visible, «Detalles», «Anterior/Siguiente», «Datos de la gráfica», el bloque «Huecos de lectura» y el selector de sesión guardada dejan de pintarse en la pestaña; el dato, el DTO y los comandos se conservan. El ejemplo de abajo sigue describiendo el comportamiento del núcleo.

Usar epoch E y fuente única. Baseline cursor0 (items complete, currencies none), total12147=0. Sin fila de cronología, resumen adquirido0; monedas «Sin cobertura», no0.

Cursor1: total12147=2 ⇒ observación +2, before0/after2, cause unknown. Cursor2: total12147=4 ⇒ segunda observación +2, before2/after4. Resumen: positivos4, negativos0, neto4. La hora es observada, no hora exacta del evento de juego.

Precio público sintético de fixture=10c netos/unidad: cada fila valor20c, subtotal objetos40c. Monedas y total económico completo siguen desconocidos. Nunca copiar importes DRF. Solo cuando una fuente real futura soporte moneda X y envíe baseline0→6→12: dos filas+6 y resumen12; no inferir22 de la captura de DRF.

Si se pierde enlace y nuevo baseline muestra12147=9: conservar total observado4, abrir/cerrar hueco, ninguna fila+5 ni aviso; nuevos cambios se comparan desde9. Resumen de cambios observados sigue separado de tenencia actual9. Si se reordena inventario pero agregado permanece4, cero filas. Si baja4→2: fila−2 unknown; no etiquetar venta/apertura.

## 9. Fuente nativa: evidencia y trabajo todavía real

Perfil aprobado técnicamente solo para SHA `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`, probado externamente en Fedora GE-Proton11-7. Las fuentes archivadas [inventory_reader_v3.py](audit/loot-inventory-probe/inventory_reader_v3.py) y [state_reader.py](audit/loot-inventory-probe/state_reader.py) contienen las guardas/relaciones observadas; reutilizar su conocimiento, no ejecutar Python como dependencia del addon.

A debe implementar descubrimiento autónomo de base/contexto, lectura segura desde el addon y comprobación de identidad de binario/perfil. No fijar la dirección virtual de la sonda ni su PID. Validar owner/location/vtables/quantities y reread coherente; abortar muestra si cambian. El límite<=250 es por stack de este perfil; una cantidad fuera de rango es parcial/error, nunca clamp.

Hash distinto, tipo no soportado o raíz no encontrada: estado explícito, sin lectura especulativa ni escaneo indiscriminado. La evidencia de sonda incluye baseline v3 de 254 tipos sin cantidad desconocida, pero no prueba todas las clases de ítem futuras. No inventar offsets de MF. Ruta de cartera validada en vivo el 7 oct 2026 para el binario del perfil (ver [recibo](audit/loot-wallet-probe/receipt-live-2026-10-07.json)); el lector dentro del addon está en implementación y su QA en el juego sigue pendiente. MF verificado sigue pendiente; placeholders none/null son honestidad, no cierre.

## 10. Propiedad y junturas

- **A / Nexus:** repo Nexus completo dentro del lote; nuevos módulos lector/cobertura/codec live, client/protocol/state/render diagnóstico, fixtures Rust y README. Emite contrato exacto; no edita Companion/Blish.
- **B / núcleo:** Companion alerts live codec/assembler/server, sessions live model/reducer/store/lifecycle/note/history/export, runtime wiring y eliminación de consultas autenticadas automáticas; tests correspondientes. Dueño de DTO, `getLiveSessionView` y wire TS. La documentación normativa corresponde al lote documental previo. Extraer módulos live en vez de duplicar motor API o crear proveedor genérico sin necesidad.
- **C / presentación:** Companion UI, i18n, estilos y proyección HUD; Blish consumo/etiquetas/estados y tests. No edita runtime/store/codec TS. Coordinar un único dueño de `farming-runtime-projection.ts` (C); B aporta datos y firma estable. Reutilizar `farm1` sin nuevas claves; textos/age/observed dejan de decir necesariamente API. No inventar capacidad de lectura Blish.
- **Raíz:** integra fixtures/contrato, decide diferencias, asigna las líneas compartidas de composición, valida evidencia y evita suites pesadas concurrentes. Cada lote rama/worktree propio. Los ocho ítems Halloween existentes no se recrean: enlazar las tareas nuevas a lo ya entregado y a los pendientes reales de QA/MagicFinder.

## 11. Casos de prueba discriminantes y gates

1. Fixture exacta cruzada TS/Rust de handshake, begin/rows/end/ack/status; cliente antiguo y servidor antiguo no reciben mensajes inesperados. Blish ignora live_cap y sigue farm1/avisos.
2. 512 bytes aceptados/513 rechazados, UTF-8 y claves duplicadas, nonce falso, hueco seq, enum/cantidad overflow, fila duplicada o fuera de orden, 9 filas/chunk, rows4097, byte budget, timeout, part faltante, end sin begin, contexto cambiado, currencies none con fila.
3. Begin y filas sin end no producen ni guardado ni UI ni aviso. Fallo IDB/lease no obtiene stored. Commit durable seguido de pérdida de ACK y reintento no duplica. Repetir cursor0 baseline ya comprometido con nuevos seq y mismo contenido devuelve ACK sin reset/avance/frescura; cambiar contenido bajo cursor0 falla. Tras cursor1, cursor0 es replay antiguo. ACK anterior no libera un lote posterior.
4. Fixture canónica0→2→4, reorder sin delta, negativo firmado, stacks múltiples>250 agregado permitido/stack251 rechazado, unknown qty no0, monedas none no0, listed0 demostrado; pérdida de cobertura por canal.
5. Dos productores: solo propietario; mismo instance reconecta con epoch nueva/baseline; Blish solo mantiene presencia pero nunca fuente ready. Context con seq nuevo y mismos state/mapId/character intercalado entre begin/rows/end conserva el lote y no crea hueco; cambio real seguido de retorno al valor anterior lo invalida. Cambio de personaje/mapa corta época sin fabricar adquisición ni terminar automáticamente conexión.
6. Desconexión/host restart/fuente stale con heartbeats vivos: gap durable, reloj observado detenido, rebaseline9 no+5, cierre/reapertura/CSV/JSON conserva las mismas sumas. Items partial con monedas válidas permite deltas de monedas; items complete siguiente solo rehace baseline items; tercera completa reanuda sus deltas. Recuperar items no cierra gap currencies. Finalizar con gap abierto fija toAt=endedAt sin contarlo observado; huecos simultáneos no duplican descuento y none de monedas nunca produce cero.
7. Espía de transporte HTTP que falla cualquier endpoint autenticado durante load→presence→start→sample→stop→recovery→render; captura manual inventario continúa funcionando. Catálogo/precios públicos se permiten según políticas existentes.
8. Lectura de notas1..6 y runtimev3 preservada; livev4/schema7 no simula StorageSnapshot, mantiene texto humano y receipt. Sesión pendiente de guardar no se pierde al llegar nueva presencia.
9. Avisos positivos con precio/umbral una vez; baseline, duplicado y sin cobertura ninguno. Compras/ventas/depósitos nunca reciben causa inventada. Gráfica y export coinciden con ledger y snapshot de precio.
10. UI claro/oscuro, teclado, contraste medido, 0/1/muchas filas, cantidades grandes, nombres largos, icono fallido, layouts estrechos, fuente ausente/parcial/error, monedas/MF desconocidos. Checklist siete ejes: todos parciales hasta esa evidencia, sin crear infraestructura de diseño nueva.

Rápidos/tests afectados antes de gate global. Companion: `npm run check`, `npm run check:guardrails` (incluyen seguridad/censo/ESM según grupo; CI también H6). Nexus: `cargo test` y `cargo build --release --target x86_64-pc-windows-gnu`. Blish: `dotnet run --project tests/ProtocolConsoleTests`, `dotnet build -c Release`. Una build/suite pesada cada vez, presupuesto/df previo. No volver a ejecutar H8 nativo por este cambio si su evidencia del mismo alcance sigue vigente y contratos no lo requieren.

QA real pendiente: addon cargado en Nexus, bootstrap autónomo, arranque/reapertura Hebra, adquisición/reordenación/apertura/depósito/venta/cambio personaje, caída y restauración, cerrar guardar reabrir exportar en Fedora/Proton; Windows con productor Nexus y Blish HUD consumidor. No confundir cross-build con carga nativa. Este documento no acredita publicación, instalación ni runtime de una release.

## 12. Referencias normativas reconciliadas

Companion: `docs/PRODUCT.md` (fuentes/semántica/no revisión), `docs/PLATFORM_POLICY.md` (API-only y frontera lector), `docs/SPEC-puente-ingame.md` (live1 y farm1), `docs/THREAT-MODEL.md` (proceso lector, fuente no confiable, volumen/retención, sin garantía frente a malware local), `docs/ARCHITECTURE.md` (runtime/puertos reales, fuente/sesiones/esquemas), `README.md`, `docs/QA-MVP.md` y documentación de soporte pertinente. Nexus README y Blish README por sus respectivos propietarios.

La vieja afirmación de que no leer memoria garantiza encaje en una política de terceros se sustituye por descripción factual del nuevo alcance; no afirmar aprobación de ArenaNet. Las reglas históricas de H8 siguen locales a H8. Las propuestas anteriores DRF/token/helper del audit no reabren la dirección ya elegida. La nueva autorización no elimina garantías de integridad, privacidad ni la obligación Windows existente.

## 13. Avisos live sin identidad de cuenta

Decisión de ingeniería ratificada en la coordinación del 6 oct 2026 dentro del alcance autorizado. **Implementación en código candidato; verificación conjunta y QA real pendientes**: no se presenta como una instrucción histórica adicional del usuario ni como entrega externa garantizada.

La intención de aviso vive en el journal live canónico, en la misma transacción que la observación. No se crea otra base de datos ni se inserta una copia en `EmittedAlertQueue`: esa cola y sus registros legacy conservan su contrato ligado a cuenta. La fuente es `nexus_inventory` y la cuenta desconocida permanece `null`; no se fabrican `accountRef` ni nombres de cuenta/sesión a partir de instance, personaje, bóveda o placeholders.

Registro `LiveAlertOutboxV1`, dentro del journal de la muestra o como clave hija del mismo store y transacción:

```text
version: 1
source: 'nexus_inventory'; accountRef: null
sessionId: string; observationId: string; ruleVersion: 1
outboxId: string  # determinista: sessionId + observationId + ruleVersion
state: 'awaiting_price' | 'skipped' | 'ready' | 'dispatching' | 'processed'
skipReason: null | 'no_price' | 'below_threshold' | 'session_closed'
alert: AlertV1 | null  # payload económico capturado, sin campos extra de origen
priceCapturedAt: string | null; thresholdCopper: number
claimedAt: string | null  # durable antes de efectos; inmutable para ese intento
deliveryReport: AlertDeliveryReport | null
sentTo: IngameBridgeClient[]
receipt: IngameAlertReceipt | null
```

Solo una observación positiva de objeto, comprometida y con cobertura, genera candidato. Baseline, rebaseline, negativo o duplicado no lo generan. La intención `awaiting_price`, o la decisión inmediata con precio disponible, se guarda atómicamente con la observación. El ACK live `stored` no espera precio, red ni notificaciones. Un booleano derivado como `alertsProcessed` no sustituye estos estados ni permite repetir un intento ambiguo.

El resolver público existente decide una sola vez `skipped` o `ready`, capturando precio, umbral y payload. Al cerrar, pendientes sin cotización quedan `skipped/session_closed`, visibles como no evaluables, sin bloquear el guardado. `ready` sin claim puede ejecutarse tras recovery. Deduplicar o cambiar ajustes/precios no altera un candidato evaluado ni reabre `skipped`/`processed`.

Antes de efectos externos, un CAS bajo lease/autoridad vigente guarda `ready → dispatching` y `claimedAt` en transacción durable. Si falla, no se llama al emisor; solo el ganador emite. Se reutiliza `AlertEmitter` con un ámbito interno tipado por emisión, nunca una variable global que mezcle avisos concurrentes. Su sink live confirma/proyecta el registro canónico, sin `EmittedAlertQueue.enqueue`; legacy mantiene su sink. Después se guarda el reporte de canales y el estado `processed`.

Los recibos conservan `pending | received | unconfirmed` y sus causas existentes. Antes del callback `sent` se registra la asociación efímera `alertSeq → { origin: 'live', sessionId, outboxId }`. `persistIngameReceipt` escribe en ese destino capturado, no en la cuenta o sesión actual. El upsert por `outboxId` es monotónico: un `pending` tardío no pisa `received` ni un reporte final. Fallar la persistencia produce diagnóstico, sin borrar la intención ni inventar recepción.

**Garantía: como máximo un intento automático de emisión por `outboxId`.** Al recuperar un `dispatching` o un recibo todavía `pending` después de un reinicio, se persiste `processed` y `unconfirmed/restart`, sin reemitir. Perder ACK produce `unconfirmed/timeout`, sin retransmitir el aviso. Una caída entre claim y envío puede dejar un aviso no mostrado: su fila permanece con entrega no confirmada. No se promete visualización exactamente una vez ni entrega eventual con una transacción local y canales externos no transaccionales.

La UI lee una proyección durable del journal con fuente, sesión, `outboxId` y recibo, también sin cuenta conocida y después del cierre. Puede componer filas legacy/live mediante unión discriminada, sin convertir live en un `EmittedAlertRecordV1` ficticio. El texto expresa aumento observado y valor estimado, no drop confirmado ni causalidad. Ingame, toast y sistema usan formato cerrado y origen interno tipado; no aceptan texto arbitrario ni envían cuenta, sesión, motivo interno o asociaciones de recibos al addon. `AlertV1`, `alert`, `alert_ack` y sus límites de privacidad permanecen intactos.

B posee modelo/outbox/store/lifecycle, composición y enrutado de recibos, con la adaptación mínima necesaria de emisor/formateadores. C presenta la proyección visible del ledger. El propietario del puente conserva codec/servidor; esta decisión no añade mensajes ni cambia la cola legacy.

Pruebas requeridas:

1. Cuenta `null` produce candidato, aviso y fila durable sin tocar la cola legacy; observaciones diferentes del mismo objeto/milisegundo tienen distintos IDs. Replay de muestra o ACK live perdido no duplica intención.
2. Claims concurrentes emiten una sola vez; fallo de commit antes del claim produce cero efectos. `ready` sin claim sigue procesable tras recovery.
3. Caída después de claim antes/después de enviar, ACK perdido y restart no reemiten: conservan entrega no confirmada. Los canales independientes continúan y su reporte no inventa éxito.
4. `pending` tardío no pisa `received`; cambiar clave/cuenta/sesión antes del ACK no redirige el recibo. La fila permanece accesible sin cuenta y después del cierre.
5. Precio tardío se resuelve una vez; cierre sin precio conserva `skipped/session_closed`. Baselines, negativos, duplicados y muestras sin cobertura no generan candidatos.
6. `AlertV1`, `alert` y `alert_ack` mantienen claves exactas; ningún payload de notificación expone identidad, texto arbitrario o metadata interna de origen.

## 14. Build declarada y comparación de sesiones live

Ampliación de ingeniería del 6 oct 2026 dentro del audit autorizado. Parser/modelo, retención de ajustes y validación v4 tienen evidencia acotada; este apartado fija además la obligación de notas, editor y comparador para 0.5.0. La integración de esos consumidores, el gate conjunto, la publicación y la QA real se acreditan por separado en [ESTADO](ESTADO.md).

### Alcance y fuente

La comparación de tandas debe consumir sesiones live schema 7, además de conservar el comparador API para sus registros anteriores. Son fuentes distintas y no se mezclan como si midieran lo mismo. Esta obligación forma parte de la entrega 0.5.0; una implementación que solo compara notas API deja sin cubrir las nuevas sesiones Nexus.

`live.build`/`live_open.build` sigue identificando el SHA del ejecutable de GW2. No identifica la build del jugador y no cambia su wire. Nexus no aporta configuración activa de habilidades/rasgos/equipo. El usuario puede declarar una plantilla mediante pegado de un código de build GW2 y una etiqueta opcional en la preparación existente. No se crea una vista principal nueva ni se consulta la API autenticada.

La declaración no acredita build actualmente equipada, atributos, estadísticas, piezas de equipo, mejoras, ni buffs/MF. Es preparación manual fechada por el inicio de sesión, no evidencia nativa del personaje. H8, protocolo y fuentes autorizadas permanecen intactos.

### Modelo y preferencia

Los módulos compartidos son `src/sessions/manual-build-model.ts` y `src/sessions/build-template-parser.ts`. Exports: `DeclaredBuildV1`, `DecodedBuildTemplateV1`, `FarmingDeclaredBuildPreferenceV1`, `isDeclaredBuild`, `readFarmingDeclaredBuild` y `manualBuildIdentityInput`; el parser puro exporta `parseBuildTemplate`.

```text
FarmingDeclaredBuildPreferenceV1 = {
  version: 1,
  templateCode: string,
  label: string | null
}
DeclaredBuildV1 = {
  version: 1,
  source: 'manual_template',
  label: string | null,
  templateCode: string,
  configuration: DecodedBuildTemplateV1
}
```

`label` es una clave requerida con valor `string|null`, no una propiedad omitible del DTO. Límite de plantilla: 4096 unidades de longitud JS antes de trim; etiqueta: 120, sin controles U+0000–U+001F ni U+007F. La lectura de preferencia null/ausente, o válida en forma con código vacío tras trim, retorna `empty`; una declaración válida normaliza la etiqueta con trim y cadena vacía a null, y el código a `[&Base64]` con padding canónico. `farmingDeclaredBuild` se almacena como `unknown`, con default null: migración y actualización de ajustes conservan mediante copia profunda el valor JSON raw inválido o de una versión futura, sin normalizarlo, resetearlo ni sustituirlo por la última declaración válida. Los límites anteriores gobiernan la aceptación del parser/modelo; no autorizan truncar evidencia persistida inválida.

`DecodedBuildTemplateV1` conserva campos conocidos y orden explícito:

- `profession`: Guardian, Warrior, Engineer, Ranger, Thief, Elementalist, Mesmer, Necromancer o Revenant.
- `specializations`: exactamente tres posiciones `{ id, traitSelections:[number,number,number] }`; id byte y selección de tier 0–3, incluidos los ceros.
- `skills`: `terrestrial` y `aquatic`, cada una `{ heal, utilities:[number,number,number], elite }`; son paletas u16, no IDs API de skills resueltos.
- `rangerPets`: cuatro bytes para Ranger, null en las otras profesiones.
- `revenantLegends`: cuatro bytes para Revenant; `inactiveLegendUtilities`: tres paletas u16 terrestres y tres acuáticas para Revenant; ambos null en las demás profesiones.
- `weaponTypes`: array u16; `skillOverrides`: array u32. Para formato legacy sin esa sección ambos son null, no arrays vacíos. El formato moderno puede acreditar arrays vacíos mediante sus counts explícitos.

Preferencia independiente `farmingDeclaredBuild`; snapshot opcional `declaredBuild?: DeclaredBuildV1|null` en sesión/nota, congelado al iniciar. Registros v4/schema 7 antiguos sin ese campo se leen como desconocidos, conservando su representación/bytes/checksums. Un campo durable presente pero inválido se rechaza sin reescribir ni descartar el original.

La identidad comparativa se deriva de los campos conocidos normalizados de `configuration`, su versión y fuente. Excluye la etiqueta, diferencias de representación Base64 admitidas y el SHA del ejecutable. No se confía en un hash almacenado que el registro pueda proporcionar: la identidad se recalcula desde la configuración validada. Cambiar solo una etiqueta no crea otra build; cambiar un campo significativo sí. Conservar orden/semántica de las ranuras que formen parte de la configuración.

### Entrada y compatibilidad

El editor mantiene la entrada inválida/no soportada y muestra el error; la validación aplica los límites anteriores. No bloquea el inicio de sesión. En ese inicio se captura `null`/desconocido cuando no hay una declaración válida; no se usa silenciosamente la última válida como fallback. Modificar o corregir la preferencia afecta sesiones posteriores, no la instantánea ya guardada de la sesión activa.

La validación del código es local y estricta. Se admite el formato legacy de 44 bytes y el moderno de longitud exacta `46 + 2*n + 4*m`, con counts consistentes, armas u16 y overrides u32. No se hidratan obligatoriamente los IDs contra una API para poder usar la declaración. Los IDs de paleta no se presentan como IDs de skill resueltos. Bytes reservados/formatos desconocidos se tratan como no soportados por la política de Tyrian, sin afirmar que el juego no los admite. Se conserva la entrada y no se adivina una configuración.

No se completa una declaración ausente desde nombre de personaje, etiqueta libre, SHA de GW2 ni API. Importar o leer un registro anterior no inventa declaración y no recalcula sus checksums por normalizar una ausencia histórica. Una declaración presente debe hacer roundtrip estricto en payload, nota y exportación; inconsistencias entre código canónico y configuración no son datos válidos.

### Comparación de tandas

El comparador live consume notas schema 7 validadas y usa datos de su fuente: incrementos positivos observados, neto con signo y tasas sobre intervalos cubiertos; no reutiliza el margen de caché API ni el total de tiempo sin observar. La cobertura de cantidades y tasas usa el tiempo observado válido del canal de items (`observedItemsMs`), independiente de precio/valor. Las tasas agregadas se ponderan por tiempo cubierto. Un cero observado exige un intervalo comparable, con al menos dos muestras y tiempo cubierto positivo; falta de intervalo permanece desconocida. Un precio ausente no elimina bolsas ni su tasa, y monedas sin cobertura no autorizan a fabricar oro/h. El perfil nativo actual no acredita oro/h completo; el valor estimado de objetos es otra métrica. Identificar huecos, falta de evidencia y tamaño de muestra; no atribuir causalidad al build declarado.

Se exige un mínimo de **dos sesiones completas por grupo comparable** para su agregado y confianza comparativa. Dos completas pertenecientes a grupos distintos con una sola muestra cada uno no acreditan grupos robustos ni una comparación consolidada. Las filas individuales pueden mostrarse por separado. La sesión activa puede mostrarse como provisional, fuera del conjunto de completas y de ese mínimo.

La agrupación separa origen API/live, presencia pura/mixta/desconocida, condiciones registradas y configuraciones manuales validadas. MF desconocido y MF manual cero son valores distintos. Configuración desconocida sigue desconocida: puede tener un grupo explícito de evidencia, sin certificar que esas sesiones compartan build, atribuir su resultado a una build conocida ni usar una etiqueta como identidad. Cambiar etiqueta, spelling Base64 equivalente o build de ejecutable no separa la identidad de la configuración declarada. La declaración es una covariable registrada, no una prueba de la configuración activa ni del motivo del rendimiento.

### Responsabilidades y aceptación

- Dominio/ajustes: parser/modelo públicos, preferencia, captura inmutable al iniciar, validación de identidad/configuración y compatibilidad sin pérdida en dominio/store.
- Notas: payload/schema 7 opcional con validación y roundtrip estricto, sin cambiar bytes/checksums de registros antiguos por su ausencia.
- Presentación/core: editor reutilizando preparación, error/desconocido visibles y comparador live; consume el modelo compartido, sin decodificar otra vez de forma divergente.

Pruebas discriminantes requeridas para el candidato integrado:

1. Fixtures reales de código legacy/moderno y profesión con pets/Revenant, armas y overrides; counts/longitud/trailing bytes/reservados desconocidos fallan de forma explícita y acotada.
2. Identidad igual con distinto label o representación admitida del mismo contenido, distinta con una configuración significativa distinta; nunca igualada mediante un hash almacenado hostil.
3. Entrada inválida conservada/error visible/inicio no bloqueado; snapshot capturado desconocido, sin recuperar una declaración válida anterior. Edición posterior no modifica la sesión activa.
4. Registros v4/schema 7 sin campo permanecen legibles y byte/checksum-estables; presente inválido se rechaza sin pérdida; presente válido hace roundtrip nota/payload/exportación.
5. Comparador toma sesiones live guardadas, mantiene activo provisional, exige dos completas por grupo comparable, separa API/live y calcula tasas con cobertura sin convertir desconocido en cero.
6. Ningún flujo de editar/iniciar/comparar provoca consulta API autenticada; no hay obligación de hidratar IDs para aceptar una plantilla local válida.

### Evidencia de formato y límites

Los seis golden fixtures de `src/sessions/__fixtures__/build-template-chatlinks.json` conservan la procedencia de las muestras upstream de [gw2-chatlinks-go](https://github.com/Ev3nt1ne/gw2-chatlinks-go/blob/main/chatlinks/chatlinks_test.go), etiquetadas allí como reales, y el SHA-256 del archivo de origen `f3183336799be033ef318e38b70f18ac9b43bcd8a811c8fae396c19a6a165f7a`. Las expectativas fueron decodificadas independientemente con base64/struct y contrastadas con las aserciones upstream. La investigación también consultó el [formato de chat links de la wiki oficial](https://wiki.guildwars2.com/wiki/Chat_link_format#Build_template_link). El parser local se prueba contra esas fixtures; no se ejecutaron los tests upstream ni QA del juego. Las restricciones conservadoras de Tyrian no se atribuyen al juego ni a la wiki.
