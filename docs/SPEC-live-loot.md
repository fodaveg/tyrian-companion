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

Recuperación tras una caída del almacén con el host vivo (7 oct 2026). Mientras el almacén rechaza escrituras, ninguna muestra se da por guardada y la vista muestra el error; lo que no pudo escribirse (causa del hueco, fin de época, desconexión del productor, presencia) queda en memoria y lo escribe el primer paso de ciclo de vida que encuentre el almacén de vuelta, sin temporizador ni bucle propios. Al volver queda un hueco `storage_unavailable` (o la primera causa que no se pudo guardar) en cada canal afectado, desde su última captura válida, y ningún delta lo cruza: la primera muestra guardada después es baseline local. No se inventa una desconexión ni se reinicia el enlace del productor. Si la lease se perdió durante la caída, el mismo recobro la readquiere y aplica estas mismas reglas, no las de un reinicio del host. Lo mismo vale para una lease perdida dentro del mismo proceso SIN caída del almacén (p. ej. tras suspender el equipo): solo `initialize` marca un reinicio del host; el recobro conserva el enlace y la presencia que el anfitrión conoce, deja el hueco con la misma causa `storage_unavailable` (no hay causa nueva: las escrituras de ese tramo fueron igualmente rechazadas) salvo que el productor haya notificado un hueco mientras la lease estaba perdida (9 oct 2026): ese hueco no lo podía escribir nadie y antes se descartaba, así que el del recobro lleva ahora su causa (la primera notificada, y solo si el almacén no había rechazado antes otra) y, si era una desconexión del productor, se escribe con él; no cambia el formato guardado, y tras un reinicio del host la causa sigue siendo `host_restart`. El recobro aplica además la última presencia notificada mientras estaba perdida, de modo que una desconexión de más de 10 minutos cierra la sesión en la última evidencia como siempre. Una escritura que el almacén aplicó pero contestó como fallida se trata, antes de escribir la memoria, como tras un reinicio con ese mismo disco: si el registro guardado es de la misma sesión y autoridad y está por delante de la memoria, pasa a ser la base y sus entradas de diario se publican una vez. Esto precisa la frase de §3 según la cual un fallo no autoriza a publicar: la muestra sí quedó guardada. Este último punto es decisión de implementación del 7 oct 2026, no una regla pedida por el usuario.

Almacén que no contesta (9 oct 2026). Un almacén que acepta la operación y no dispara ningún evento no rechaza nada, así que antes no entraba en las reglas anteriores: la operación esperaba para siempre dentro de la cola del ciclo de vida, todas las posteriores detrás, con la sesión mostrada como activa y sin error. Ahora cada espera al almacén, al coordinador de la lease y al escritor de la nota tiene un plazo de 10 s (`STORAGE_ANSWER_TIMEOUT_MS`, el mismo tiempo que el productor espera su ACK); vencido, la llamada se contesta como contesta ese puerto cuando el almacén no está disponible y la operación sigue por el camino del párrafo anterior hasta terminar. El plazo es por llamada y no por operación encolada a propósito: la cola nunca pasa a la operación siguiente con una anterior suspendida, de modo que no queda ninguna continuación que despierte más tarde junto a trabajo nuevo. La llamada no se cancela y aún puede escribir: un registro que llega tarde lo rechaza el propio almacén (`persistedAt` anterior, u otra sesión o autoridad), y el que llegó sin que nadie lo supiera se adopta antes de volver a escribir la memoria, como arriba. Un latido que encuentra el anterior todavía en cola o en curso no añade otro. Un anfitrión que no puede armar un temporizador conserva la espera sin plazo. Decisión de implementación del 9 oct 2026.

El escritor de la nota no es el almacén, y una nota puede tardar más de 10 s en escribirse sin que nada haya fallado. Por eso su intento se conserva mientras está en curso: a quien se le vence la espera se le contesta que la nota aún no está escrita (el cierre devuelve `false`, la sesión queda `complete` sin recibo), y el siguiente que la necesite (el latido siguiente, un inicio) espera ESE intento, otra vez con plazo, en vez de llamar de nuevo al escritor. El escritor se invoca una vez por contenido (la autoridad y la hora del último guardado no forman parte de la nota) y nunca hay dos intentos a la vez; el recibo se guarda en el primer latido posterior a que termine. Si el intento falla, lo avisa quien recoge la respuesta y el siguiente es una llamada nueva. Antes cada espera vencida era una llamada más: una nota que siempre tardara más del plazo no se sellaba nunca, se relanzaba en cada latido e impedía iniciar la sesión siguiente.

El inicio es la única escritura cuya pérdida no deja en memoria nada desde lo que recuperarse: para este host la sesión aún no existe. Si el almacén no dice si guardó la sesión nueva (plazo vencido, o cualquier otro `unavailable`), puede haberla guardado o guardarla después, porque la escritura no se cancela. Por eso ese inicio se trata como una sesión guardada que nadie ha leído: se avisa, la vista queda en error en vez de en reposo, y el latido y el inicio siguiente vuelven a leer; si la sesión está, siguen con ella, y es la que devuelven los inicios posteriores. Si la carga contesta que no hay nada y la escritura llega después, la encuentra el inicio al que le estorba (el almacén se lo rechaza), que relee antes de nada. Esa sesión es el inicio de este mismo proceso encontrado tarde, no una dejada por un host que ya no está, así que se recobra como tras una caída del almacén y no como tras un reinicio: sigue conectada, con la presencia con la que se inició, y su único hueco es el `source_missing` con el que nace toda sesión. Con las reglas de reinicio quedaría escrita como desconectada desde su propio inicio y, sin productor enlazado ni nuevo aviso de presencia, el latido la cerraría a los diez minutos. Un inicio que el almacén rechaza con una respuesta definida (`stale`, `corrupt`) no cambia: nada pudo quedar escrito.

Almacén caído al arrancar (9 oct 2026). Si la carga de la sesión guardada falla porque el almacén no está disponible, nadie sabe todavía si hay una sesión guardada ni en qué fase: la vista muestra el error, se avisa una vez, y el latido repite la carga en cada pulso (también el siguiente inicio, antes de nada). Mientras siga sin leerse no se inicia ninguna sesión. Cuando el almacén contesta, la sesión encontrada sigue exactamente como tras cualquier reinicio del host (hueco `host_restart`, época y baseline nuevas). Un registro que no valida no es una caída pasajera: no se reintenta, y sigue siendo el almacén quien rechaza escribir encima.

**Límite conocido: cierre brusco del host (9 oct 2026, sin arreglar).** Un proceso que muere sin liberar la lease deja al plugin que vuelve sin su propia sesión hasta que la lease caduca: `source_conflict` en cada `live_open` y nada medido durante hasta 5 minutos, que es lo que dura la lease de la sesión en vivo (`LIVE_SESSION_LEASE_TTL_MS`, los mismos 300 s del coordinador, H14.22). Un test lo fija tal como es hoy: `source_conflict` a los 70 s y `ready` cuando la lease caduca. Un equipo suspendido más tiempo que la lease no cierra la sesión: la encuentra perdida al volver y la recobra como tras una caída del almacén, con las reglas de arriba (hueco y época nueva).

No se acorta la lease, aunque el ciclo de vida late cada 5 s y una lease corta curaría ese caso (se probó con 30 s el 9 oct 2026 y se retiró). El latido es un temporizador, y el uso normal del plugin es con la aplicación de notas oculta o minimizada mientras se juega; los motores basados en Chromium frenan los temporizadores de una página oculta hasta una vez por minuto. Una lease más corta que el latido real se pierde en cada latido con el proceso vivo. Medido durante 10 minutos con una muestra por segundo sobre los almacenes de producción:

| Lease | Latido cada | Muestras guardadas | `live_open` rechazados | Tiempo en `error` |
|---|---|---|---|---|
| 30 s | 5 s | 600 de 600 | 0 | 0 s |
| 30 s | 20 s | 600 de 600 | 0 | 0 s |
| 30 s | 60 s | 150 de 600 | 445 | 300 s |
| 300 s | 60 s | 600 de 600 | 0 | 0 s |

Las dos últimas filas las reproduce el test «a heartbeat that fires once a minute» (la tercera, como su prueba negativa). Cambiar un fallo raro, 5 minutos sin medir tras un cierre brusco, por perder tres cuartas partes de las muestras en el caso habitual no compensa, y la cadencia real del latido con la ventana oculta no se ha medido en ningún cliente.

Arreglo de fondo, pendiente: que `renew` acepte una lease caducada que nadie tomó, y que la lease se renueve también desde la ruta de datos (las muestras llegan por el socket del addon, no por temporizador), de modo que la caducidad solo decida cuánto espera OTRO propietario. Eso cambia el contrato del coordinador (hoy `renew` y `assertOwned` contestan `lost` a un handle caducado, y un test lo fija) y exige medir antes la cadencia real del latido con la ventana oculta en Obsidian y en Hebra. `acquire` y `renew` ya aceptan la duración como parámetro y el ciclo de vida tiene la opción `leaseTtlMs`; hoy nadie pide una distinta de la del coordinador. Coste conocido del mismo origen, también fijado por test: una renovación que agota su plazo de almacén (10 s) y nunca llega a disco deja la lease con margen de sobra (240 s con un latido por minuto) y la siguiente la renueva; si llega a disco después del plazo, el handle que el host conserva deja de coincidir, el latido siguiente la da por perdida y el de después la recobra: unos 10 s sin medir con el latido normal, 108 s medidos con un latido por minuto.

La recuperación de la sesión en vivo no puede impedir que arranque el resto del plugin (9 oct 2026): `initialize()` nunca rechaza. El runtime lo espera antes de declararse listo, y antes una excepción posterior a la lectura del registro (diario ilegible, diario que no cuadra con su registro, recobro que no se pudo guardar) dejaba el plugin entero sin arrancar. Ahora el fallo se avisa, la vista queda en error y el arranque sigue. En memoria solo queda lo que se leyó Y se comprobó: un registro cuyo diario no se pudo leer o no cuadra no se conserva como sesión, así que nada (una nota, un cierre, un inicio nuevo) se escribe a partir de un registro sin su evidencia; el disco queda intacto. Un diario que el almacén no pudo leer se vuelve a pedir en cada latido, igual que una carga sin respuesta (el almacén rechaza con el mismo error un diario ilegible y uno con una entrada inválida, y ninguno de los dos se sobrescribe nunca); un diario que no cuadra es evidencia contradictoria y no se reintenta. Una sesión que sí quedó en memoria y no pudo recobrarse la reintenta el latido, como siempre.

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

**Nota resumen (8 oct 2026, petición de David: «una nota resumen cada vez que se cierra la sesión», «a una subcarpeta dentro de la raíz elegida en ajustes»; contenido aprobado el mismo día).** Al cerrarse una sesión live, una vez guardada la nota completa y confirmado su recibo, se escribe una nota corta (una pantalla) en `<carpeta de salida>/summaries/<fecha> <hora UTC>Z - <ref16> - summary.md`, en el idioma de la sesión; la subcarpeta es fija, como `sessions/` o `exports/`. La nota completa no se toca y sigue alimentando «Sesiones anteriores». Se calcula desde el payload que la nota completa ya guarda, la lista de personajes del runtime, y lo que haya en la caché del catálogo; de arriba abajo:

1. Cabecera: mapa principal por nombre (el que pasa del 70 % del tiempo OBSERVADO: el tiempo sin mapa conocido cuenta en el denominador; si ninguno, «varios mapas»; sin ningún intervalo de mapa, «mapa desconocido») y, si hubo un solo personaje, su nombre; fecha, inicio y fin en hora local del equipo, duración y % observado. El porcentaje se trunca hacia abajo, nunca se redondea: solo es 100 con la sesión observada entera, y con cualquier tramo sin observar es como mucho 99 (23 s sin observar en 115 minutos no son un 100 %). Es la misma cifra de `observed_percent` y de la sección de cobertura.
2. Personajes, solo si hubo más de uno: sus nombres en orden y la frase de que al cambiar de personaje no se mide lo que cambió entre uno y otro (las bolsas del nuevo no cuentan como ganadas ni las del anterior como perdidas).
3. Veredicto: neto estimado, «por hora», oro de la cartera y «tu media en sesiones parecidas» (media del «por hora» de las notas resumen anteriores con el mismo mapa principal; se omite con menos de 3). Sin «por hora» con menos de 15 minutos observados, y esa es la única condición (decisión de David, 8 oct 2026): es la misma regla (`liveItemRateEligible`) de la pestaña «Sesión», de `farm1` y de la comparación, así que una sesión que acaba en `partial` o tras una desconexión lo conserva. Se calcula sobre el tiempo observado, nunca sobre la duración. Si ningún objeto con cantidad tiene precio de bazar, no hay neto ni «por hora» (ni `null` convertido en 0): una línea dice que no hay precios. En una sesión de venta sin objetos nuevos tampoco se escriben, y el titular es el oro. Si un solo objeto supera la mitad del valor, el «por hora» sale también sin él, siempre que sin él quede algo positivo; si lo que queda es cero o negativo (lo que salió del inventario resta, así que ese objeto puede valer más que el neto entero) no se escribe ningún ritmo: la línea dice en cuánto queda la sesión sin ese objeto y que vale más que el neto de la sesión, o que es todo el neto si queda exactamente cero. Una sesión de venta (el oro sube y el inventario baja) abre con el oro ganado; si lo principal fue una moneda que no es oro y no hay valor de objetos, esa moneda abre el veredicto. Un objeto que entra 10 veces o más y es el primero por cantidad se destaca con su ritmo por hora (sin nombrar ningún objeto en el código).
4. Para vender ahora: hasta 5 objetos por valor, con cantidad y valor neto de comisión (precio de venta inmediata). Los ligados a cuenta (`AccountBound`, `SoulbindOnAcquire`) o no vendibles (`NoSell`), según los `flags` de `/v2/items` que el catálogo ya trae, quedan fuera de la lista y del valor; si el plugin no pudo leer los flags de algún objeto, el valor se marca «como máximo». Los contenedores (tipo `Container` del catálogo) se marcan «sin abrir». Lo que no tiene precio de bazar va en una línea aparte, fuera del valor.
5. Otras monedas de la cartera, cada una en su unidad; nunca se suman al oro.
6. Lo bueno: los avisos que saltaron en la sesión, con su hora local.
7. Un número con lo que salió del inventario (unidades, no tipos de objeto) y la frase de que no se distingue vendido, consumido o depositado; con una sola unidad la frase va en singular.
8. Mapas con minutos (nombre de `/v2/maps`; sin nombre, «Mapa <id>»).
9. Al cerrar: hallazgo mágico (solo si es `verified`, es decir, llegó del addon) y huecos libres (`live_begin.slots` de la última muestra). Sin dato, la línea no sale.
10. Cobertura: una línea salvo que lo observado baje del 90 %; entonces lista los tramos sin observar con su motivo, y un tramo `context_changed` que contiene el instante de un cambio de personaje se nombra «cambio de personaje». «Sin tramos sin observar» se escribe solo cuando la cabecera dice 100 %; si no hay ningún tramo registrado pero el tiempo observado no llega a la duración, la línea dice el porcentaje observado y que ningún tramo quedó registrado. Un párrafo que sigue a una lista («La lista puede estar incompleta.», «… y N más.») va precedido de una línea en blanco.

Sin objetos nuevos solo salen cabecera, monedas y cobertura. Frontmatter (`tyrian_summary_version: 3`, todas las claves con prefijo `tyrian_summary_`, ninguna `tc_*`): `of` (sessionRef de 64 hex), `locale`, `started_at`, `ended_at`, `main_map` (id o `null`, lo lee la media por mapa; el lector acepta las versiones 2 y 3), `net_copper`, `per_hour_copper`, `observed_minutes`, y para una Base `date` (fecha local de inicio, `AAAA-MM-DD`), `map` (texto del título), `characters` (lista en orden), `duration_minutes`, `observed_percent`, `net_gold`, `per_hour_gold`, `wallet_gold` (oro decimal, cobre / 10 000), `top_item` y `top_item_count` (el objeto que más valor aportó, o el destacado por la regla del contenedor), `top_item_icon` (URL entrecomillada del icono de ese objeto, leída del mismo registro de la caché del catálogo que el nombre, sin petición nueva; solo si es `https://render.guildwars2.com/...`, y `null` sin caché, sin icono o con otro origen), `alerts` (avisos que saltaron) y `free_slots`. Un valor es `null` exactamente cuando el cuerpo omite esa cifra (por ejemplo «Por hora» con menos de 15 minutos observados); los textos van como cadenas YAML entrecomilladas. La Base `Session summaries.base` (asset `session-summaries-base`, `contentVersion` 2, bundle 8) las lista: filtro `file.hasTag("gw2/session-summary")` y `tyrian_summary_version >= 2`, vista «Sesiones» ordenada por `tyrian_summary_started_at` descendente (enlace a la nota, fecha, mapa, duración, neto, por hora, personajes, % observado, icono y objeto principal con `image()` como Inventario y Cartera, avisos) y vista «Por mapa» agrupada por mapa, sin medias. En una nota v2 las columnas nuevas quedan vacías, y lo mismo el icono en una nota anterior a esta clave (las notas ya escritas no se regeneran). El lector del historial toma las claves una a una y no rechaza las desconocidas, por eso la versión sigue en 3. El cuerpo de la nota no lleva imágenes: Hebra pinta una imagen remota como su texto alternativo. Su frontmatter no lleva ninguna clave `tc_*` (solo `tyrian_summary_*`, entre ellas el mapa principal, el neto, el «por hora» y los minutos observados que alimentan la media): el historial lee todas las notas y una clave `tc_*` desconocida lo deja sin servicio. No es un registro de sesión ni entra en el historial. Los personajes vistos y la marca «resumen ya escrito para esta sesión» se guardan en el almacén de runtime local bajo su propia clave (`live-session-summary-state`), nunca dentro del registro v4 cerrado (un 0.6.12 rechaza un registro con claves de más y no deja arrancar ninguna sesión) ni en la nota de sesión; si la clave se pierde, la nota sale con un solo personaje. Con la marca puesta, cargar el plugin no lee notas, no pide nada y no reescribe una nota borrada; sin ella, en la carga se escribe usando solo caché. Es idempotente (el mismo contenido no se reescribe; una nota editada a mano o ajena en esa ruta no se toca) y un fallo se registra sin bloquear el cierre: se reintenta como máximo dos veces más, con un minuto de separación, en los siguientes cambios de estado de la sesión. Los nombres de mapa (la única consulta pública nueva, ver [PLATFORM_POLICY](PLATFORM_POLICY.md)) se esperan como mucho 5 s. Los nombres de objetos y monedas salen, por este orden, de lo que el plugin tiene en memoria (nada, si la sesión se cerró antes de esta carga) y de la caché del catálogo público (`readCachedItems`, `readCachedCurrencies`, de cualquier antigüedad); el resumen no hace ninguna petición por ellos, ni en la carga ni tras cerrar: la única consulta de red que tiene aprobada es `maps`. Un nombre que no está en ninguno de los dos sitios se escribe «Objeto <id>» o «Moneda <id>» (`Item <id>`, `Currency <id>` en inglés), también en `top_item`, y nunca el id solo; la nota completa usa el mismo respaldo. No hay ajuste para desactivarla; el modo consulta, que no lleva sesiones, no la escribe.

**Hallazgo mágico y huecos libres desde el addon: propuesta pendiente del addon (8 oct 2026).** Los huecos libres ya viajan en `live_begin.slots` y se leen de ahí. El hallazgo mágico no viaja hoy. El parser publicado (0.6.12, `parseLiveIngameMessage`) exige claves exactas en cada línea addon→host (`exactKeys`): un campo nuevo en `live_begin` o un tipo de línea nuevo se rechaza como `frame_schema` o `unexpected_message` y cierra la conexión, así que un addon que lo enviase sin más rompería un plugin 0.6.12. Por eso no se implementa la lectura: una propuesta compatible exige que el addon envíe el dato **solo tras una capacidad nueva** del host (`live_cap2`, línea nueva host→addon que los addons anteriores ignoran, igual que ignoran hoy los tipos desconocidos) y que un host anterior, que nunca la emite, no reciba nada nuevo. El contenido de la línea queda por definir con el addon; mientras tanto la nota omite la línea de hallazgo mágico.

Mantener notas humanas, CAS/verificación de regiones, recovery y requisito de receipt de nota antes de liberar. JSON/CSV live deben incluir todas las observaciones, huecos, fuente, tiempos, cobertura, cantidades, snapshot de precios y su criterio. Reusar exportación create-only, versionando el formato exportado cuando cambie su esquema. No sobrescribir exportaciones existentes.

### 6.0. Versiones del payload de la nota live (9 oct 2026)

El frontmatter lleva `tc_payload_version` y el payload su campo `version`: han de coincidir. El cursor de 4 (`cursor: cada muestra comprometida de esa época incrementa uno`) es del protocolo con el addon y no cambia; lo que cambia es qué parte del diario se guarda en la nota.

- **1** (la única que escribió la 0.6.16): una entrada de diario por muestra, también las que no cambiaron nada. Cursores consecutivos por época y `windowStartAt` igual al `observedAt` de la entrada anterior. Se valida exactamente como siempre, y su valoración solo puede declarar `instant_sell_net`.
- **2**: ninguna entrada para una muestra que no observó nada, no corta la línea (`breakBefore`) y no es la baseline de su época (cursor 0). Los cursores solo crecen (con huecos), la ventana de una observación empieza en un instante entre el `observedAt` de la entrada previa de su época y el suyo (el código solo acota ese intervalo, no comprueba que haya una muestra ahí), una entrada vacía dentro es **inválida** (se fija en `live-session-sparse-journal.test.ts`) y `coverage.lastObservationAt` no puede ser anterior a la última entrada: esa marca es la constancia de vida, sin latidos. La duración sale de `endedAt`, el tiempo observado de `observedItemsMs` (se acumula por muestra en el registro, también sin entrada), el recuento de `sampleCount` (un contador del registro, no `journal.length`; en v2 no tiene tope superior, solo se exige que `sampleCount > 0` implique al menos una entrada, la baseline de cursor 0 que nunca se descarta, y que cada época empiece en el cursor 0) y la gráfica termina en `coverage.lastObservationAt`.
- **Base de precio (`valuation.priceBasis`, 9 oct 2026, decisión de David: «yo guardaría el precio bruto»).** La valoración declara una sola base para todos sus precios; una fila de `prices` lleva `itemId` y `unitCopper` y ninguna base propia, así que una nota no puede mezclar bases (una fila con una clave de más es inválida, y una fila en la otra base no cuadra con los subtotales).
  - `instant_sell_net` (la única hasta la 0.6.16): `unitCopper` es lo que deja UNA unidad descontada la comisión del bazar, y una cantidad vale ese neto por la cantidad. Se lee y se valora exactamente como siempre: ninguna nota ya escrita cambia de cifras.
  - `instant_sell_gross`: `unitCopper` es la mejor orden de compra por unidad, sin descontar nada, y una cantidad vale su total (cantidad × bruto) menos la comisión calculada **sobre ese total** (`bestSaleNetCopper` de `gw2-fees.ts`, la misma función de Halloween y de los avisos). La comisión tiene un mínimo de 1 cobre en cada uno de sus dos tramos (5 % y 10 %), así que valorar una unidad y multiplicar infravalora lo barato: 250 unidades a 8 c son 1 700 c, no 250 × 6 c = 1 500 c. Lo que salió del inventario vale lo mismo con el signo cambiado. La cifra no es aditiva: la cronología valora cada cambio por separado y su columna no tiene por qué sumar el subtotal de la sesión.
  - **A qué versión pertenece cada una:** una nota **1** solo puede declarar `instant_sell_net` (es lo único que acepta una 0.6.16, comprobado en su validador: con otra base da la nota por inválida); una nota **2** puede declarar cualquiera de las dos. El validador recalcula los subtotales con la base declarada y rechaza los que no salgan de ella.
  - **Quién la lee:** el modelo y el validador, la vista de una sesión guardada y su gráfica (cada punto en la base de la nota), el orden de la rejilla y de «Sesiones anteriores», la comparación, la nota resumen, la cronología de la nota y la exportación (`price_basis` y `unit_copper` salen tal cual se guardaron). Todos pasan por `liveItemValueCopper` (`live-session-reducer.ts`).
  - **Qué se escribe y qué se ve en vivo:** el registro de runtime no tiene dónde decir en qué base están sus precios y su juego de claves está cerrado, así que la base del runtime es la del formato que escribe el plugin (`liveRuntimePriceBasis()`): neto por unidad con la constante en 1, bruto con la constante en 2. La economía guarda la cotización en esa base, el panel, la gráfica viva y el aviso de un aumento se valoran con ella y la nota la declara: la cifra del panel y la de la nota guardada coinciden siempre. **Con la constante en 1 la sesión en vivo sigue valorando neto por unidad × cantidad a propósito**: una nota 1 no puede decir otra cosa, y si el panel calculara sobre el total enseñaría 1 700 c de una pila que la nota guarda como 1 500 c. Pedir una nota 1 declara como neto los precios que haya (el escritor no convierte); la opción `noteVersion` del ciclo de vida (tests y benchmark) solo cambia la compactación del diario, no la base.
- **Qué escribe esta versión del plugin** lo decide una sola constante, `LIVE_SESSION_NOTE_WRITE_VERSION` (definida en `live-session-model.ts` para que el reductor la lea sin ciclo de imports, y reexportada por `live-session-note-model.ts`); hoy es **1**, así que la escritura es byte a byte la de la 0.6.16. La misma constante decide si el ciclo de vida guarda las muestras vacías y en qué base guarda el runtime sus precios. Se enciende cuando los lectores que entienden la 2 llevan tiempo repartidos.
- **Un lector acepta todas las versiones hasta `LIVE_SESSION_MAX_PAYLOAD_VERSION`.** Una nota con un `tc_payload_version` mayor está **apartada**: no cuenta como inválida, no provoca `conflict`, no se interpreta (solo se lee para clasificarla), no se mueve ni se reescribe (tampoco la reescribe el escritor de esa misma sesión), el historial y la comparación listan las demás y ambos paneles la nombran por su ruta con un aviso. Una nota candidata rota o editada dentro de sus bloques también se aparta con aviso, sin tumbar el historial; los duplicados de una misma sesión siguen siendo `conflict`. El borrado de privacidad falla cerrado ante una nota apartada de versión futura.
- **Una 0.6.16 trata una nota v2 como inválida**: su historial y su comparación pasan a `conflict` mientras exista, y si vuelve a guardar esa misma sesión le sustituye los bloques gestionados por los suyos en formato 1.

**Antes de encender el escritor v2** (latente, a resolver o aceptar):
1. La exportación CSV emite una fila `sample` por entrada del diario y el nombre del fichero sigue acabando en `-v1`: con v2, un export previo de la misma sesión daría `conflict`; este SPEC pide versionar el formato exportado cuando cambie.
2. Una sesión iniciada con compactación v2 y recuperada por un plugin con la constante en 1 no se puede renderizar (`version === 1 && sampleCount > journal.length` devuelve `null`) y se queda sin nota.
3. El historial de la API (`SessionHistoryService.scan`) sigue dando `conflict` ante una nota de sesión en vivo rota.
4. El registro de runtime no dice en qué base están sus precios (la deduce de la constante). Una sesión empezada con la constante en 1 (precios netos en el registro) y continuada o cerrada por un plugin con la constante en 2 vería sus netos leídos como brutos: la comisión aplicada dos veces, en torno a un 15 % de menos, hasta que la economía vuelva a cotizar cada objeto (una cotización caduca a los 15 minutos; lo que la sesión conserva se vuelve a pedir cada 60 s, 50 objetos por pasada), y una sesión ya cerrada con la nota pendiente se escribiría como bruto con cifras netas, sin que el validador pueda notarlo. Al revés (constante de 2 a 1) los brutos se leerían como netos, de más. Hace falta una marca fuera del registro cerrado (como `live-session-summary-state`) o descartar los precios restaurados al cambiar de base.
5. Con el bruto, una orden de compra de 1 c deja de ser «sin precio»: una unidad vale 0 c y diez valen 8 c. Con el neto por unidad esa cotización no se guardaba (la comisión se la come entera), así que `unpricedItemIds`, y con él «Por hora» en la pestaña, puede cambiar para esos objetos.
6. La media «tu media en sesiones parecidas» de la nota resumen mezclará sesiones valoradas en neto por unidad con sesiones valoradas sobre el total; la diferencia solo es apreciable con pilas grandes de objetos muy baratos.
7. Los tests dorados de la nota fijan `payloadVersion: 1` y siguen dando los mismos bytes con la constante en 2, porque una nota 1 declara neto. Lo que hay que repasar al encender es que ningún camino de producción pida una nota 1 con un registro en bruto.

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
- `priceBasis` (`'instant_sell_net'`, o `'instant_sell_gross'` solo en una nota 2: ver 6.0, que fija qué significa `unitCopper` en cada base y cómo se valora una cantidad; con el bruto los dos subtotales de arriba son el neto de vender cada total, no delta × precio), capturedAt y unitCopper por ID; reutilizar precio de venta inmediata neta y reglas/fees existentes, no duplicar fórmulas. Si no hay cotización válida, cantidad permanece visible. No usar valoraciones DRF.

Una venta puede retirar objetos y aumentar oro, por lo que neto firmado evita sumar íntegramente ambos como ganancias. Sin causa no afirmar que la operación fue venta. Depósito puede bajar bolsas sin bajar patrimonio: mostrar explícitamente ámbito bolsas, no riqueza de cuenta.

> **Presentación simplificada el 6 oct 2026 por decisión de David:** la pestaña pinta una sola gráfica, la de valor estimado, con los huecos de lectura como franja y corte; la gráfica de cantidad y «Datos de la gráfica» dejan de pintarse en la pestaña. `chartPoints` sigue llevando ambas series y los huecos.

Gráfica: cantidades observadas y valor estimado, huecos sin interpolación; al actualizar precios, recalcular toda la curva visible con el mismo snapshot y rotular su hora, o conservar el snapshot elegido al cierre. No mezclar precios sucesivos haciendo pasar una revalorización por adquisición. Valor/h = valor neto elegible / duración observada pertinente; null ante denominador cero o cobertura insuficiente; subtotal/h puede mostrarse como parcial con etiqueta distinta. La gráfica (viva y de una sesión guardada) cubre la sesión entera en como mucho 600 puntos: el primero, cada corte y el último (el valor actual exacto) nunca se pierden, solo cuentan las muestras que observaron algo y, si aun así se pasa del límite, se aclaran los puntos antiguos con un paso que se duplica (`LiveChartBuilder`); el límite de 600 incluye el punto final, nunca se supera y el primer punto no se pierde; si los cortes por sí solos lo superan, los cortes más antiguos tras el primero dejan de ser puntos, en lotes de un octavo del límite para que el coste por muestra no crezca (se conservan el primero y el último), y el siguiente punto conservado hereda el corte (`breakBefore`; si no queda ninguno, el punto que cierra la línea): la línea nunca cruza un tramo sin cobertura como si hubiera datos. Qué puntos quedan depende solo del ledger, no de los precios. Cronología, resumen, gráfica y export derivan del mismo ledger.

Avisos: reutilizar motor/umbral/canales existentes para observación positiva valorizable, clave idempotente observation.id + regla. Texto «Aumento observado: 2 Champiñones · valor estimado…»; jamás «drop», «botín confirmado» o «vendido» por inferencia. Baseline, negativo, muestra incompleta, duplicado, rebaseline, sin precio o fuera de cobertura no emiten aviso de objeto caro. Un precio que llega tarde no vuelve a avisar de una observación ya procesada; la regla evalúa una vez al resolver la observación pendiente o la descarta explícitamente al cerrar el intervalo, con intención y recibos durables según §13, sin insertar avisos live en la cola legacy ligada a cuenta. No requiere confirmación humana ni acciones en juego.

**Tarjeta de botín de la sesión de API (`LiveSessionLootTracker`, `live-session-loot.ts`): cambia ya, con la constante en 1 (9 oct 2026).** Es el seguimiento en memoria de lo que la API va enseñando durante una sesión de cuenta; no es la sesión live de este SPEC ni persiste nada, pero comparte la decisión del precio bruto. Hasta la 0.6.16 valoraba cada pila como `floor(bid × 0,85) × cantidad`; ahora guarda la mejor orden de compra tal cual y valora cada pila con la comisión sobre su total, `bestSaleNetCopper(bid, null, cantidad)`, que es como la valora la nota durable de esa misma sesión. Con ello cambian las filas de la tarjeta (`totalCopper`), su orden, «ganado hasta ahora» (`knownTotalCopper`) y cuándo salta el aviso de botín valioso, que compara esa cifra con el umbral. `LiveSessionLootRow.unitCopper` deja de ser el neto de una unidad y pasa a ser la mejor orden de compra en bruto.

- Cuánto cambia (medido el 9 oct 2026 con la función real): 250 × 8 c pasa de 1 500 a 1 700 c. En 2 000 000 de combinaciones (bid de 1 a 2 000 c, cantidad de 1 a 1 000) la cifra solo baja en 5, siempre una unidad suelta a entre 2 y 6 c (1 → 0, 2 → 1, 3 → 2, 4 → 3, 5 → 4), por el mínimo de 1 c de cada tramo; en el resto sube o queda igual, en proporción que depende del rango (bid de 1 a 240 c por cantidad de 1 a 100: 22 393 suben, 1 602 quedan igual y 5 bajan, de 24 000).
- Aviso de botín valioso con el umbral por defecto de 50 000 c: ninguna de esas combinaciones deja de avisar (las cinco que bajan valen 5 c o menos) y 540 que antes no avisaban ahora sí, por ejemplo 997 × 59 c: antes `floor(59 × 0,85)` = 50 c por unidad, × 997 = 49 850 c; ahora 58 823 c de total menos 2 941 y 5 882 de comisión = 50 000 c.
- Una venta que los dos mínimos se comen entera (una unidad a 1 o 2 c) vale 0 c y sigue contando como con precio.
- **Diferencia conocida, heredada y sin arreglar:** este camino no considera el precio de vendedor. La respuesta de `/v2/items` que ya pide lo trae (`vendor_value`), pero el seguimiento solo lee de ella el nombre, así que un objeto que vale más en el vendedor que en el bazar se valora por el bazar. Halloween y los avisos de botín (`src/alerts/loot-alert-criteria.ts`) sí toman el mejor de los dos (`bestSaleNetCopper(bid, vendedor, cantidad)`).

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

Antes de efectos externos, un CAS bajo lease/autoridad vigente guarda `ready → dispatching` y `claimedAt` en transacción durable. Si falla, no se llama al emisor; solo el ganador emite. Un aviso que se queda en `ready` porque el almacén o el lease rechazaron esa escritura (o cuya decisión tampoco se pudo guardar) no espera a un reinicio ni a un cambio de modo: la economía lo recuerda y lo vuelve a intentar en cada pasada posterior y en cada cambio de estado de la sesión (`retryUnclaimedAlerts()`, que el núcleo llama desde `onStateChange`, la única señal que da el ciclo de vida cuando una escritura rechazada por fin entra); sin nada pendiente no hace nada, varias peticiones seguidas encolan una sola pasada y lo pendiente de una sesión se olvida con ella. Esa pasada no pide al bazar una cotización que alguien pidió hace menos de 60 s (`UNQUOTED_RETRY_MS`), haya contestado lo que haya contestado: con la cotización caducada y el bazar fallando, treinta cambios de estado en treinta segundos son una petición, no treinta. El reintento pasa por el mismo CAS, así que un aviso ya `dispatching` o `processed` vuelve intacto y nunca suena dos veces. Cuando el ciclo de vida sabe del corte, su recuperación (`ready()`, donde reescribe lo no guardado) ya avisa con un cambio de estado y el reintento ocurre ahí. Laguna conocida: una reclamación rechazada no marca el almacén como caído (`updateAlert` devuelve `null` sin más), así que en una sesión que se queda quieta justo después (sin muestras, sin presencia y sin corte registrado) el reintento espera al siguiente cambio de estado; el latido de 5 s no avisa a la economía. Cerrarla exige tocar el ciclo de vida (que el latido dé esa oportunidad, o que una escritura de aviso rechazada cuente como corte). Una reclamación contestada como rechazada puede haberse escrito (plazo de almacén vencido, o motor caído tras el commit): antes la memoria quedaba en `ready` y el disco en `dispatching`, y el reintento repetía el mismo paso contra una entrada que ya no cuadraba, en cada cambio de estado y sin fin. Ahora, tras un rechazo, `updateAlert` relee esa entrada del diario (una lectura por clave, `readLiveJournalEntry`) antes de contestar. Si el disco tiene exactamente lo que esa llamada estaba escribiendo, es su propia escritura: sigue como escrita, y si era la reclamación el aviso suena, una vez. Si tiene otra cosa (una escritura anterior de este host que llegó sin que nadie lo supiera, por ejemplo una reclamación aplicada después de haberse releído), la memoria la adopta y se contesta que este paso no ocurrió: esa reclamación no se ejecuta, porque aquí no se puede saber si ya se ejecutó, así que el aviso puede quedarse sin sonar pero no suena dos veces, y el reintento termina en la pasada siguiente. Si la lectura falla, todo queda como antes de ella. Se reutiliza `AlertEmitter` con un ámbito interno tipado por emisión, nunca una variable global que mezcle avisos concurrentes. Su sink live confirma/proyecta el registro canónico, sin `EmittedAlertQueue.enqueue`; legacy mantiene su sink. Después se guarda el reporte de canales y el estado `processed`.

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
