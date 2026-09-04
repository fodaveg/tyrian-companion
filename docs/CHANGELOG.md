# Changelog

## Release beta 0.1.28 - la gráfica de precio se puede leer y se puede acercar

### Antes se veía una forma y no un dato

- **No había ejes.** La gráfica del histórico dibujaba una nube de puntos sin ninguna escala: se veía
  la silueta del precio y no se podía decir ni cuánto valía ni cuándo. Ahora lleva **eje de precios**
  formateado en oro, plata y cobre con el mismo formateador que usa el resto del plugin, y **eje de
  fechas** con la densidad de marcas ajustada a la ventana visible.
- **Y el número que importa está a la vista**: máximo, mínimo y valor más reciente de la ventana que
  se esté mirando, en texto, no solo en el dibujo.
- **Toda la serie salía punteada.** El punteado existe para distinguir el tramo que publica un
  tercero del que mide el propio plugin, pero en la nota de un objeto no hay medición local, así que
  se punteaba el cien por cien y el resultado se leía como ruido. Ahora, sin serie local con la que
  confundirla, la línea es continua.

### Se puede acercar

- **Cuatro ventanas**: un mes, un año, cinco años y todo. Se anclan al día más reciente de la propia
  serie, no al reloj, así que un objeto que dejó de cotizar no muestra una ventana vacía.
- **Y se puede arrastrar sobre la gráfica** para acotar un rango, con vuelta atrás. Quien no use
  ratón tiene dos deslizadores que hacen lo mismo.
- **El zoom no se guarda en ningún sitio**: ni en la nota, ni en el vault, ni en disco. Vive mientras
  la vista está abierta.

### Ya no se recorta a 400 días

- **La gráfica pedía 400 días y ahora pide la serie entera.** Para la Barra de caramelo eso son 4.564
  días diarios desde 2013 en vez de 400: se estaba enseñando el 8,8 % de lo que hay.
- **El recorte de 400 sigue en pie donde tenía sentido.** Lo usaba también la regla de venta, que
  razona sobre un año; ese consumidor no ha cambiado y su decisión es la misma. Los dos límites son
  ahora dos cosas distintas y el código lo dice.
- **Cuando hay más días que píxeles, se agrega.** Cuatro mil puntos en mil píxeles no muestran más
  información, muestran más ruido: por encima del ancho del dibujo la serie se agrupa por semana, y
  por encima de eso por mes. **La gráfica declara qué está agrupando**, para que nadie lea un punto
  mensual como si fuera un día.

### Lo que no cambia

- Sigue sin haber ninguna llamada de red al cargar el plugin. La descarga es diferida y cacheada 24
  horas, igual que en la 0.1.27.
- No se guarda ninguna serie en el vault.
- El motor de dibujo se extrajo a su propio módulo para poder compartirlo entre el panel de ajustes y
  la nota sin un import circular. Quien importaba el anterior sigue funcionando igual.

### Conocido y sin resolver

- La tabla accesible del panel ya no se recorta, así que un objeto con historial largo puede llevar
  miles de filas al DOM. Está dentro de un desplegable cerrado, pero no está virtualizada.

## Release beta 0.1.27 - el precio deja de darse por perdido, y la nota de un objeto puede enseñar su historia

### El aviso decía «sin cotización» sobre objetos que sí se venden

- **Un aviso llegó al juego diciendo que una pieza de equipo excepcional no tenía cotización.** Ese
  objeto, el `83008`, cotizaba en ese momento con puja de 1.921 y oferta de 1.980. El plugin no lo
  había consultado mal: no lo había consultado, y aun así afirmaba el resultado.
- **La causa era un dato que se tiraba por el camino.** El detector que produce esos avisos ya mira
  el precio dos veces, para decidir si un objeto es valioso y si es raro y no vendible. Pero el
  registro que le pasaba al emisor solo llevaba id, cantidad, nombre y motivos: el precio y su
  estado se perdían ahí, y el emisor los rellenaba con dos constantes escritas a mano. El comentario
  que defendía esas constantes decía que el detector nunca mira el precio, y era falso.
- **Ahora el precio viaja hasta el aviso**, y su estado se traduce con honestidad: si la consulta
  respondió y no había puja, se dice «sin cotización»; si no se pudo consultar, si la respuesta no
  era válida o si la cuota estaba agotada, se dice «no se pudo consultar». Son cosas distintas y ya
  no se cuentan igual.
- **El estado del precio es ahora un dato de tres valores** en el contrato de avisos, no un número
  que puede faltar. Ningún camino puede declarar que un objeto no cotiza sin haber preguntado.
- **Y el registro local de diagnóstico guarda qué objetos pidió** en cada fallo de red, con un tope
  de cincuenta. Antes solo decía que había fallado una consulta de precios, sin decir de qué, y eso
  hacía imposible identificar la causa desde el log.

### Avisaba de «primera vez que veo este objeto» sobre cosas que ya tenías

- **El almacén de objetos vistos solo aprendía de las ganancias observadas.** Nada lo sembraba con
  lo que el jugador ya tenía en el inventario, así que cualquier objeto poseído desde antes contaba
  como nuevo la primera vez que caía. La fase de aprendizaje previa tampoco lo tapaba: se completa
  leyendo notas ya escritas, no el inventario vivo.
- **Ahora se siembra desde el mismo snapshot de inventario que el plugin ya captura** para medir las
  sesiones por diferencia, antes de que pueda emitirse ningún aviso de primera vez. Se hace una vez
  por bóveda y cuenta, y no vuelve a repetirse.
- **Si la siembra no se puede hacer** (sin clave, sin red, sin snapshot), no se emite ningún aviso de
  primera vez. Callar es correcto; avisar en falso no.

### El histórico de precios enseñaba una línea plana y un número por nombre

- **El desplegable decía «Objeto #3526».** Ahora resuelve el nombre por el catálogo público que el
  plugin ya consulta, con su caché, y lo muestra también en el título de la gráfica. Junto al nombre
  va el icono del objeto.
- **La gráfica dibujaba solo las muestras que el propio plugin había capturado**, que eran dos días.
  Ahora puede añadir la serie diaria que datawars2 publica desde 2012, y **la procedencia se ve**:
  el tramo de terceros va en línea punteada y dibujado por debajo, para que un día medido en local
  nunca quede tapado; la tabla accesible lleva una columna de origen; y una nota dice cuántos días
  aportó la fuente externa.
- **La petición es diferida y cacheada 24 horas.** Nunca se hace al cargar el plugin.

### Piloto: la historia del precio dentro de la nota del objeto

- **Cuatro objetos llevan ahora un bloque que dibuja su histórico al abrir la nota**: Saco de
  Halloween (`36038`), Trozo de caramelo (`36041`), Barra de caramelo (`47909`) y Colmillos de
  plástico (`36059`). Las otras 1.369 notas de posición no cambian.
- **No se guarda ninguna serie en el vault.** En la nota va un bloque de tres líneas con el id, y los
  datos se piden al pintarlo y se cachean 24 horas fuera del vault. Sin el plugin activo, ese bloque
  se lee en claro y dice qué objeto es.
- Es el primer procesador de bloque de código que registra este plugin. El registro ocurre al cargar
  y no hace red; la red la hace el pintado.

### Menos bytes por la misma información

- **La consulta del histórico pasa de la ruta v1 de datawars2 a la v2 con campos declarados**: los
  mismos siete campos que el analizador ya leía, con los mismos valores, bajan de 2.196.838 bytes a
  688.848 por objeto. Afecta a los tres consumidores a la vez, porque los tres pasan por la misma
  función.

### Sobre la política de plataforma

- `docs/PLATFORM_POLICY.md` recoge las dos ampliaciones aprobadas: contactar `render.guildwars2.com`
  para los iconos y datawars2 para el histórico, en el panel y en la nota. Lo que **no** se relaja es
  la regla de que no hay ninguna llamada de red al cargar el plugin: ambas son diferidas y cacheadas.

## Release beta 0.1.26 - una sesión guardada que ya no se puede releer deja de bloquear el plugin

### El plugin se quedaba sin salida al arrancar

- **La pantalla de sesión mostraba «Error de recuperación» y desactivaba iniciar una sesión nueva.**
  Medido en la bóveda de un jugador: el log del plugin registraba en cada arranque
  `validation_failed` sobre el almacén `session_runtime`. Había una sesión de farmeo guardada en
  IndexedDB y el validador de hoy la rechazaba entera.
- **La causa no era el registro, era cómo se validaba.** `isSessionContaminationReview` no
  comprobaba la forma del análisis de contaminación guardado: lo **volvía a calcular** desde las
  evidencias y comparaba los dos con `JSON.stringify`. El clasificador cambió en la `0.1.25` (la
  declaración «he abierto contenedores» pasó de `activity_declared` con detalle `open` a
  `open_activity_declared`), así que todo análisis escrito antes dejó de coincidir. Como el análisis
  vive dentro del registro de sesión, el registro entero salía «corrupto».
- **Y las tres salidas estaban cerradas a la vez**: la vista no pintaba ningún botón en la rama de
  error, la ruta de descarte exigía un registro que la carga no había podido producir, y el borrado
  del almacén también validaba antes de borrar, así que se negaba a borrar justo lo que no se podía
  leer. Iniciar una sesión nueva estaba desactivado para no sobrescribir evidencia recuperable. El
  resultado era un plugin sin ninguna acción disponible.

### Qué cambia

- **Un análisis que ya no recalcula igual deja de invalidar el registro.** Al **leer**, el registro
  solo tiene que tener la forma correcta, y se marca si el análisis pudo re-verificarse. Al
  **escribir**, la comprobación estricta sigue igual que antes: un registro nuevo solo se guarda si
  su análisis recompone exacto. Se conserva el análisis guardado en vez de vaciarlo, porque la
  comprobación de una sesión completada compara dos campos escritos juntos en su cierre, no contra
  el clasificador de hoy.
- **El desajuste deja de ser un fallo mudo.** Se registra con código propio (`precondition_failed`)
  en vez de confundirse con un registro inválido, así que el log dice cuál de las dos cosas pasó.
- **Hay salida aunque el registro sea de verdad ilegible.** La rama de error pinta un botón para
  descartar la sesión guardada, detrás de una confirmación que dice que no se puede leer y que
  descartarla borra esos datos. Por debajo, el almacén gana un borrado forzado que no valida.
- **El mensaje dice cuál de los dos fallos es**: «la sesión guardada no se pudo leer» frente a «el
  almacén local de recuperación no está disponible». Antes los dos salían como «La operación no se
  pudo completar de forma segura», que no dice qué hacer.

### Lo que aprendimos

- **Un validador que re-deriva el dato guardado convierte cualquier cambio del algoritmo en pérdida
  de datos.** El propio fichero ya había tropezado con esto y lo evitaba para la ventana de
  liquidación de la API, con un comentario que lo explica; no lo evitaba para el clasificador. La
  regla que queda: al leer se valida la FORMA, y solo al escribir se exige que el cálculo coincida.
- El commit que lo introdujo se llamaba «que unos insumos gastados no invaliden una sesión entera»,
  y acabó invalidando la sesión entera.

## Release beta 0.1.25 - el canal del aviso dentro del juego abre el puerto al encenderlo

### El interruptor no abría nada

- **Encender el aviso dentro del juego no abría el servidor.** Medido en la máquina de un jugador
  con el juego delante: con el ajuste activado, `ss -ltn` no encontraba a nadie escuchando en el
  puerto, y el panel del addon dentro de Guild Wars 2 se quedaba en «esperando al plugin» para
  siempre. El socket solo se abría dentro de la entrega de un aviso.
- **Y el primer aviso se habría perdido.** La entrega abría el servidor en ese mismo instante y acto
  seguido comprobaba si había algún addon conectado. No lo había, porque el addon necesita unos
  milisegundos para conectarse a un puerto que acaba de aparecer, así que ese primer aviso se
  declaraba fallido y no llegaba al juego. Solo llegaba el segundo. En una sesión de farmeo, el
  primer hallazgo valioso es justamente el que importa.
- **Ahora el servidor se abre en cuanto se activa el interruptor**, y también al cargar el plugin si
  ya venía activado de una sesión anterior. Al apagarlo se cierra, y al cambiar el puerto se cierra
  el viejo y se abre el nuevo. Un fallo al abrir el puerto (ocupado, permiso) se registra y no tumba
  la carga del plugin.
- **Lo que no cambia**: si no hay ningún addon conectado cuando salta un aviso, el canal sigue
  declarándose fallido en el informe. Eso es deliberado, para que el jugador sepa que el juego no lo
  recibió.
- **El test que faltaba.** Había test de que el servidor funciona y test de que el canal está
  cableado, y ninguno de que **encender el ajuste abre el puerto**. Por eso el defecto llegó a la
  pantalla de un jugador. El test nuevo activa el ajuste sin emitir ningún aviso y comprueba con un
  socket TCP real que el puerto escucha y acepta la conexión, y que apagarlo lo cierra.
- `docs/PLATFORM_POLICY.md` precisa que «ninguna llamada de red al cargar» significa ninguna petición
  **saliente**, y que abrir un socket de escucha en `127.0.0.1` no es una excepción a esa regla.

## Release beta 0.1.24 - la comisión del bazar deja de calcularse de dos formas, y una de las dos estaba mal

### La aritmética de la comisión se unifica sobre la que usa el juego

- **El plugin calculaba la comisión del bazar de dos maneras y no daban lo mismo.** La divergencia
  llevaba fijada desde la `0.1.23` en un test que la documentaba sin resolverla: 14.927 de 15.706
  brutos muestreados diferían, con una brecha de −0,75 a +0,60 cobre. Lo que faltaba no era una
  preferencia, era una medición contra el juego.
- **Medido contra seis parejas precio→neto verificadas dentro del juego**, la ruta que usa
  `calculateTradingPostFees` acertó **6 de 6** y la que aplicaba techo en micro-cobre, **2 de 6**:

  | Bruto | Neto real | Ruta de sesión | Ruta del advisor (antes) |
  |---|---|---|---|
  | 2 | 0 | 0 | 0 |
  | 6 | 4 | 4 | 4 |
  | 12 | 10 | 10 | 9,8 |
  | 18 | 15 | 15 | 15,2 |
  | 51 | 43 | 43 | 43,35 |
  | 68 | 58 | 58 | 57,8 |
  | 11 | 9 | 9 | 8,9 |

- **La fórmula real del bazar** es `max(round(precio × tasa), 1)` aplicada **por separado** a la
  comisión de publicación (5 %) y a la de transacción (10 %), cada una con **su propio suelo de un
  cobre**. El techo que aplicaba la otra ruta no es lo que hace el juego en ningún punto documentado
  ni verificado, y el suelo tampoco: `floor` falla en el caso de 18 cobre.
- **`valueExpectedInstantSellDepth` deja de calcular su propio techo.** Ahora llama a
  `calculateTradingPostFees` una vez por nivel de profundidad, sobre el precio unitario **entero** de
  ese nivel, y escala por las unidades fraccionarias con una multiplicación exacta, sin introducir un
  redondeo propio en el escalado.
- **Un bruto de un cobre dejaba un neto de −1.** Ese −1 es la pérdida de bolsillo (la comisión de
  publicación se paga por adelantado y no se devuelve), no lo que entrega la venta, que es 0. El
  campo dice neto recibido, así que queda acotado a 0. La cotización de 1 cobre pasa de `invalid` a
  un neto de 0.
- **Ninguna recomendación cambia de lado.** Sobre el order book real capturado el 1 de septiembre, el
  kernel de disposición sigue diciendo vender; solo se mueven los valores esperados, muy por debajo
  del umbral de decisión.
- El test de paridad deja de documentar la brecha y **asevera las ocho parejas verificadas en juego
  sobre las dos rutas**. Comprobado que muerde: reponiendo el techo se pone rojo citando
  `expected netMicroCopper 10000000n, received 9800000n`.

### Una sola huella canónica

- **Había dos funciones que calculaban la huella canónica de un objeto y diferían solo en cómo
  trataban una fecha**: una la convertía en `{}`, con lo que todas las fechas compartían huella, y la
  otra devolvía su ISO. Se colapsan sobre la de ISO.
- **La decisión se tomó midiendo, no razonando.** Con la función instrumentada y la suite completa
  corrida, la variante que colapsaba fechas **no recibe una sola fecha en ningún camino de
  producción**: los únicos impactos son las aserciones del propio test que documentaba la
  divergencia. Una auditoría estática lo corrobora: cero campos tipados `Date` en todo `src/`, porque
  el dominio representa el tiempo siempre como cadena ISO validada. Y las huellas que sí se
  persisten ya usaban la variante de ISO, así que **no se reescribe ningún valor en disco**.
- Se elimina `canonicalBlockFingerprint`, que no tenía ni una llamada. Y se actualiza la copia
  deliberada de la función que vive en `inventory-advisor-builtin-bundle.ts` (el censo de fronteras
  le prohíbe importarla), que replicaba el comportamiento viejo y habría quedado divergente.

### Los dos addons del aviso dentro del juego existen

- **No forman parte de esta release ni de este repositorio**, pero ya hay código: el addon de Nexus
  en Rust (`tyrian-companion-nexus`), que compila a un DLL de Windows que exporta `GetAddonDef`, y el
  módulo de Blish HUD en C# (`tyrian-companion-blish`), escrito pero sin compilar por falta de
  toolchain .NET. Ninguno de los dos manda nada al plugin salvo su línea de presentación, ni lee
  Mumble Link, ni llama a la API del juego, ni automatiza ninguna acción.

## Release beta 0.1.23 - el webhook deja de contar lo que no le toca, y el aviso puede salir dentro del juego

### Arreglo de privacidad en un canal ya publicado

- **El webhook de la `0.1.22` mandaba a un destino de terceros si el jugador tenía desbloqueada o no
  una skin o una mini.** El fichero prometía en su propio comentario de cabecera que no salían «los
  códigos de motivo que describen la colección de desbloqueos», y hacía lo contrario: la función que
  construía el cuerpo aceptaba una cadena ya compuesta, y quien la llamaba le pasaba la copia del
  toast, que para un aviso `always_alert` termina en el motivo traducido. El campo estructurado
  estaba acotado a tres claves y un test lo vigilaba, pero la fuga viajaba por el parámetro de texto
  libre, que ningún test de forma cubría.
- **El arreglo es estructural, no de contenido.** `alertWebhookPayload` ya no tiene parámetro de
  prosa: compone el texto a partir de los mismos campos declarados, así que quien la llama no tiene
  dónde meter una frase. Verificado ejecutando el camino real, no leyendo la firma: el cuerpo sale
  `{"content":"<nombre> ×<n> · no quoted value","version":1,"name":…,"quantity":…,"totalCopper":…}`
  y el motivo no aparece en ninguna de las cuatro clases de aviso por los siete motivos.

### Sexto canal: el aviso dentro del juego (Nexus y Blish HUD)

- **Un servidor TCP en `127.0.0.1` al que se conecta un addon del juego, apagado de serie.** El
  plugin escucha en el puerto de ajustes (47823 por defecto), los addons conectan y cada aviso cruza
  como una línea JSON de 512 bytes como máximo. Con dos anfitriones instalados el plugin manda a los
  dos. Sin cliente conectado el canal se declara `failed` en el informe del emisor: no encola ni
  reenvía, porque la cola durable ya guarda el histórico.
- **El canal es de una sola dirección a propósito.** Del cliente se lee exactamente una línea de
  presentación y después se deja de leer; cualquier byte posterior cierra la conexión. Eso es lo que
  mantiene el addon dentro de la clasificación de «utility que ayuda al jugador sin afectar a otros»
  de la política de terceros de ArenaNet: el addon solo dibuja, nunca puede desencadenar una acción.
- **Lo que cruza son siete campos y ni uno más**: `v`, `seq`, `kind`, `name`, `quantity`,
  `totalCopper` y la línea ya compuesta. No cruzan la clave de API, el account ID, el identificador
  de aviso, el motivo, el ID de objeto, ningún snapshot, el identificador de bóveda, el idioma ni el
  texto del toast. Igual que en el webhook, la función que construye el cuerpo recibe solo el aviso y
  no acepta cadenas de fuera.
- **El censo de frontera tenía un agujero y ahora no lo tiene.** `src/security-boundary.test.ts`
  vigilaba `requestUrl`, `fetch`, `WebSocket` y los imports HTTP, pero `node:net` no lo casaba ningún
  patrón: el canal nuevo podía haber entrado sin que el guardarraíl lo viera, en verde. Ahora hay un
  patrón propio y una lista revisada de un solo fichero, comprobada rompiéndola a propósito.
- Los dos addons viven en repositorios aparte y **no forman parte de esta release**. El
  contrato de cable, el reparto y los riesgos medidos están en `docs/SPEC-puente-ingame.md`.

### Robustez y deuda

- **El cuerpo que devuelve datawars2 se acota antes de que nada lo parsee**, en vez de después.
- **`main.ts` baja de 3.811 a 3.563 líneas**: Halloween, el histórico de precios, el advisor de
  inventario y los servicios de sesión se ensamblan en cuatro funciones propias fuera de
  `initializeRuntime`, con tests de cableado en lugar de suites que aseveraban texto fuente.
- **Los diez almacenes de IndexedDB abren por un único handshake compartido.** Dos de ellos
  (`session-runtime-store` y `session-detection-quality-store`) se colgaban para siempre si la
  apertura no resolvía.
- **Las copias de los ayudantes de JSON canónico se comparten** en lugar de duplicarse, y la
  divergencia que queda entre las dos que tratan un `Date` distinto está fijada en un test que la
  documenta sin arreglarla.
- **`obsidian` queda fijado a la versión instalada** (`1.13.1`) en lugar de `latest`, que hacía que
  dos instalaciones del mismo commit pudieran compilar contra API distinta.
- **La divergencia entre las dos aritméticas de comisión del bazar queda medida y congelada** en un
  test: 14.927 de 15.706 brutos muestreados difieren, con una brecha de −0,75 a +0,60 cobre.
  Coinciden solo cuando el bruto es múltiplo de 20. El test no unifica nada: unificar mueve cifras
  ya escritas en notas de sesión y es una decisión del dueño del repositorio.

### Documentación

- **El histórico se separa de lo vigente.** `docs/CHANGELOG.md` baja de 125.961 a 31.302 bytes y
  `docs/ESTADO.md` de 80.788 a 46.476, con lo movido íntegro en
  `docs/historico/CHANGELOG-hasta-0.1.17.md` y `docs/historico/ESTADO-lotes-cerrados.md`.
  Comprobado línea a línea que no se perdió contenido: del changelog viejo, cero líneas no aparecen
  ni en el vivo ni en el histórico.

## Release beta 0.1.22 - aviso de drop valioso y señal de venta del saco

### Aviso de drop valioso sin interruptores

- **Punto de salida único, `emitAlert`, que reparte a cinco canales a la vez.** El aviso vigila en
  toda sesión activa (manual o asistida) con poll de 5 minutos. Dos criterios en OR disparan el
  evento: valor total ≥ 50.000 cobre (5 oros, editable) o la política de «siempre avisa». Halloween
  pasa a activarse solo por calendario (ventana del pack, 1 octubre a 15 noviembre UTC), nunca por
  interruptor. La interfaz declara que el aviso llega entre 5 y 20 minutos después del drop, por la
  caché de 5 a 10 minutos de la API de cuenta.
- **Canales de salida.** Obsidian toast, notificación del sistema con urgencia `critical` en Linux,
  sonido sintetizado con WebAudio (896 bytes en el bundle, frente a los 43.692 de un WAV base64),
  webhook opcional solo HTTPS que manda nombre, cantidad y valor sin clave ni account ID, y una cola
  durable que abre IndexedDB en el primer aviso y nunca al cargar.

### Señal de venta del saco 36038

- **Semilla de serie diaria desde datawars2.** Una descarga sin clave al primer arranque con sesión,
  y luego la captura propia del plugin extiende la serie. Si datawars2 falla se declara «sin semilla»
  y se usa lo capturado; nunca se inventa un día. La regla usa 365 días muestreados (no consecutivos),
  con el porcentaje como dato del pack (`sellSignal`, 9.000 puntos básicos) y no como constante.
- **Tercera salida en el kernel de 36038.** Recomendación `hold` dentro de la ventana de temporada
  (puja ≤ mínimo de los 365 días) y `sell_signal` fuera (puja ≥ 90 % del máximo). Enfriamiento de
  24 horas entre avisos del mismo tipo. `validUntil` del pack y del bundle movido a 2026-12-01,
  después del cierre de la ventana.

### Sesiones de farmeo no invalidadas por lo que se gasta

- **Antes, cualquier divisa del monedero a la baja marcaba `contaminated` y suprimía el veredicto
  económico entero.** Ahora solo contaminan el oro y las gemas; gastar llaves o consumibles,
  declarar actividad `open` y perder objetos netos producen una sesión `estimated` con banda de
  atribución, con sus causas nombradas. Medido sobre una sesión real: antes daba cero cifras, ahora
  da 47.851 cobre con banda de 47.851 a 49.176.

### El detector exige la bolsa, y el ritmo se publica como banda

- **`halloween.labyrinth-drops` sube a v3 y nombra `36038` como ancla.** Antes los cinco drops del
  Laberinto eran intercambiables, así que unos colmillos bastaban para proponer inicio de sesión.
  Ahora la subida de la bolsa es necesaria, los otros cuatro siguen contando como ganancia pero no la
  sustituyen, y una bajada de la bolsa dentro del mismo delta invalida la muestra con razón
  `anchor_decreased`: una bolsa que baja se está abriendo, no farmeando.
- **Sacos por hora, valor inmediato y valor de listado se publican como banda**, no como número
  exacto. El margen no es una constante nueva, es `API_SETTLEMENT_WINDOW_MS`, y la banda lleva
  `windowMs`, `marginMs` y los dos extremos de ventana para que se puedan recomputar en vez de
  creérselos. La nota dice de dónde sale la banda («ventana de 60 min ± 10 min de caché de la API»)
  y la tarjeta de sesión mantiene un contador de sacos en vivo sobre el tick de un segundo que ya
  movía el reloj.

### Política y producto reescritos

- H13.8 y H13.1 integran datawars2, el webhook y el addon de Nexus en la política de producto. Primera
  ejecución humana en 21 releases, con su resultado documentado.

## Release beta 0.1.21 - la sesión por fin da un número

### La Bolsa de truco o trato deja de estar muda

- **El objeto insignia del plugin llevaba todo el año en «revisión».** La Bolsa de truco o trato
  (`36038`) tiene ocho resultados líquidos y, medido el 2026-09-01 contra `/v2/commerce/listings`,
  **seis de ellos no tienen ni una sola orden de compra**: cuarenta millones de unidades a 30 cobre
  y demanda cero, que es su estado normal, no una anomalía. El kernel leía esa ausencia como
  evidencia que faltaba y se callaba. Ahora un resultado cuya cotización llega SIN puja y cuyo libro
  de órdenes confirma que no hay compradores vale **cero declarado**, con su lista de ids a la
  vista; solo se sigue considerando desconocido cuando las dos lecturas se contradicen.
- **Segunda base de venta: el anuncio.** El kernel compara ahora la venta inmediata (consumiendo
  pujas reales) y la publicación al mejor ask, cada una con su umbral y su veredicto, y la vista
  muestra las dos filas. La ruta de anuncio **nunca** encabeza la recomendación mientras exista una
  ruta ejecutable, y la interfaz dice en cada fila qué garantiza: el mejor ask sigue siendo solo
  referencia estimada de publicación, ni demanda ni ejecución. Con los precios del 2026-09-01 ambas
  rutas coinciden en vender (207,37 c de EV frente a 334,40 c de umbral por puja; 308,40 c frente a
  374,00 c por anuncio).
- **La cola excluida deja de ser un cero invisible.** El modelo conservador sigue excluyendo los
  jackpots (esa decisión de producto no cambia), pero ahora los nombra: cinco infusiones, 13 de las
  50 unidades de muestra del cubo super-raro. Valen **78,57 c por saco a puja**, entre un tercio y
  un 38 % de lo que rinde abrir, y se muestran en un disclosure aparte con su desviación típica, que
  es de unas **113 monedas de plata por saco**: dos órdenes de magnitud por encima de su propia
  media, o sea que la cola es retorno esperado real y aun así no es un plan para cien sacos. La
  recomendación principal sigue siendo la conservadora.
- **Halloween pasa a tener calendario.** No había ninguno: un grep de `october|season|festival` en
  `src/` no daba una sola coincidencia en producción, así que en marzo el saco seguía consultándose
  y la alerta de precio seguía armada, porque el saco cotiza todo el año y ningún precio dice nunca
  que la fiesta terminó. La ventana se declara como dato dentro del pack curado
  (`1 de octubre - 15 de noviembre`, UTC, ambos extremos incluidos) y viaja hasheada con él. Fuera
  de ventana el asesor responde `out_of_season`, la vista dice «Halloween vuelve en octubre» y la
  alerta de precio ni siquiera abre el histórico. Un `29-02` como extremo se rechaza al validar.
- Reindexados los localizadores de `scripts/action-observability-baseline.json` con LCS contra el
  padre: solo se transfirió lo que sobrevivió byte a byte, 0 decisiones descartadas, 0 huérfanas y
  0 fronteras sin revisar. Nunca se usó `--write-baseline`.

### La nota de sesión nunca había dado un número económico (`8ef1ca7`)

- `calculateSessionValuation` (`src/economy/session-valuation.ts:89`) tenía una sola aparición en
  producción: su propia definición. `src/main.ts`, en `sessionNoteInput`, pasaba `valuation: null`
  escrito a mano. Todo el motor económico (el modelo de 106.264 sacos, precios y tasas) estaba
  desconectado del único sitio donde el usuario lo vería. Consecuencia: la nota decía «No evaluado»
  en oro, oro/hora, sacos y sacos/hora en todas las sesiones desde siempre, y por eso ninguna
  entraba nunca en el panel de rendimiento.
- Fichero nuevo `src/sessions/session-economy-evidence.ts` (puro):
  `buildSessionEconomyEvidence(runtime, catalogItems, goals)` construye valoración, reserva y hold
  desde el runtime de la sesión.
- `src/catalog/public-catalog-service.ts` gana `resolveItems(ids, locale)`, porque `resolve()` solo
  aceptaba un snapshot entero de la cuenta y una sesión necesita el puñado de ids ganados.
- La vinculación (bound/unbound) sale del snapshot de cierre y no del delta: `compareComposition`
  (`src/account/storage-delta.ts:361`, dentro de la función que arranca en la línea 354) hace
  `continue` sobre todo id cuya cantidad haya cambiado, así que un objeto ganado nunca aparece en
  los cambios de composición.
- Dos junturas había que cablear a la vez o no funcionaba nada. Primera: `reservation` no era
  opcional, porque `src/sessions/session-note-model.ts:221` revalida con `sackItemIds` vacío si la
  reserva no es válida, y entonces la valoración que cuenta sacos se rechaza como `invalid`.
  Segunda: con `hold: null` la nota seguía diciendo «evidencia económica no válida», porque
  `src/sessions/loot-presentation.ts:162` corta con `if (note.hold.status !== 'valid')` y eso
  invalida el bloque de economía entero. El hold va con lista de intents vacía, que es lo cierto:
  nada en el árbol produce un `HoldIntentV1`.
- Siguen en `null` a propósito `recommendation` y `envelope`: `recommendContainerDisposition` exige
  un `ContainerModelReview` y no hay ningún productor de ese tipo en el árbol.
- Prueba negativa: devolver `valuation: null` pone 4 de 5 casos en rojo, con
  `expected 'not_evaluated' to be 'complete'`.
- La nota que ahora se escribe lleva `tc_valuation_coverage: complete`, `tc_sacks: 240`,
  `tc_sacks_per_hour_milli: 240000`, `tc_observed_immediate_copper: 32640` y un bloque de economía
  con «Liquidación neta: 3g 26s 40c».

### El detector asistido no proponía nunca (`3d8c62b`, `43cd2a7`, `71a206a`, `9b21d52`)

- `src/sessions/relevant-item-start-detector.ts` exigía dos consultas consecutivas con ganancia, y
  cualquier consulta sin ganancia borraba la evidencia acumulada. Con la caché de la API de cuenta
  de 5 a 10 minutos y la cadencia de 2 minutos que era el valor por defecto, nunca hay dos seguidas:
  el detector no proponía nunca. Ahora usa una ventana deslizante de `max(3 muestras, 30 min)`,
  alcanzable a cualquier cadencia; una muestra `limited` dentro del tramo degrada la propuesta a
  `evidenceQuality: 'limited'`.
- `src/sessions/assisted-detection-service.ts` vigilaba un solo objeto, el saco `36038`. Ahora
  vigila los cinco drops del Laberinto, verificados contra `/v2/items` en vivo: `36038`
  Trick-or-Treat Bag, `36041` Piece of Candy Corn, `36059` Plastic Fangs, `36060` Chattering Skull,
  `36061` Nougat Center. La regla pasa de `halloween.trick-or-treat-bag` v1 a
  `halloween.labyrinth-drops` v2.
- `DEFAULT_INACTIVITY_THRESHOLD_MS` baja de 30 a 15 minutos, que sigue por encima del techo
  documentado de la caché.
- La tarjeta del Companion (`src/ui/companion-view.ts`) declara cuánto retraso lleva la propuesta de
  parada, porque detener en ese momento graba ese margen como tiempo jugado.
- `POLLING_INTERVAL_OPTIONS` (`src/core/settings.ts`) retira la cadencia de 2 minutos: está por
  debajo del suelo de la caché de la API, así que solo gastaba cuota releyendo bytes idénticos. La
  migración no sube `SETTINGS_SCHEMA_VERSION` a propósito, para no tirar también las elecciones
  deliberadas de 30, 60 o 240 minutos.

### Lo que la 0.1.21 no arregla, y tiene que quedar dicho

- El panel de rendimiento sigue dejando fuera las sesiones iniciadas a mano: `buildPerformance`
  (`src/sessions/session-history-summary.ts`) agrupa por `tc_event`, y su único productor en
  runtime (`sessionNoteEventDeclarationFromDetectionSummary`, `src/sessions/session-note-model.ts`)
  solo devuelve `source: 'assisted'` o `null`. El tipo `manual_explicit` existe en el modelo pero no
  tiene productor.
- `humanBoundaryAt` no mueve la frontera real de la sesión: solo alimenta las métricas del piloto
  (`src/sessions/pilot-metrics-recorder.ts`, `src/sessions/pilot-metrics-model.ts`). «Detener
  sesión» sigue cerrando en el instante del clic.
- El bundle curado del saco caduca en silencio el 2026-11-12
  (`VALID_UNTIL`, `src/advisor/inventory-advisor-builtin-bundle.ts:42`): pasada esa fecha `load()`
  devuelve `{ status: 'unavailable', reason: 'expired' }` sin ninguna notificación al usuario.
- El rendimiento sigue sin agrupar por Magic Find, aunque `tc_magic_find` sí se persiste
  (`src/sessions/session-note-renderer.ts:208`).

## Release beta 0.1.20 - superficies cableadas y cierre honesto

- Publicada el 2026-09-01 la
  [GitHub Release `0.1.20`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.20) desde el
  tag y commit `be5434b4cfc283198bd0054053bb7092b80decc6`. Los runs de CI terminaron en verde para
  `main` ([`33509432201`](https://github.com/fodaveg/tyrian-companion/actions/runs/33509432201)) y
  para el tag ([`33509449053`](https://github.com/fodaveg/tyrian-companion/actions/runs/33509449053)).
- **Primera publicación por el workflow automático** ([`33509449093`](https://github.com/fodaveg/tyrian-companion/actions/runs/33509449093)),
  que ejecuta el contrato BRAT como puerta ANTES de publicar en vez de auditar después. Los cinco
  assets exactos están adjuntos; el ZIP tiene SHA-256
  `cca1d1f3e6af81cae98258375067782bc660e7a53e1b06ae9cf776d605110c93` y el `main.js` publicado
  coincide byte a byte con el construido localmente (SHA-256
  `905c31240f1f54513f4366d810156b1d8bd43b78565ed9a1d89d851e70707618`).

### Superficies que existían y no se mostraban

Cuatro paneles estaban escritos, probados y sin montar, mientras sus comandos, contadores y avisos
seguían anunciándolos. Ahora se montan: alertas de Halloween (el plugin lanzaba el aviso y no había
ninguna pantalla donde marcarlo leído, así que el contador de no leídos no podía bajar nunca),
confirmaciones pendientes (el ribbon mostraba el contador y el comando existía sin vista que pudiera
mostrar una propuesta), la superficie completa de la detección asistida, y el historial de sesiones.
Se retiró el test de arquitectura que certificaba que el historial NO estaba conectado.

Añadido el botón **Abrir la nota** tras guardar una sesión, primer `openLinkText` en código de
producción: hasta ahora el plugin escribía su único entregable y no ofrecía forma de abrirlo.
Corregido `viewCount` del journal de arranque, que declaraba 3 vistas cuando se registran 2. La
línea de tiempo de detección pasa a resolución de minutos, porque la API de cuenta no da precisión
al segundo y presentarla lo aparentaba.

El resto de la bitácora de campo antigua se retiró tras comprobar dato a dato cuáles llegaban ya al
usuario por otra vía. Los que no llegaban por ninguna se integraron en la tarjeta de sesión: calidad
de la observación, incidentes, comprobación de conexión cuando la cuenta no responde, y la decisión
de sesión guardada, que antes ofrecía «Iniciar sesión» con el arranque bloqueado por la recuperación.

### Cierre de sesión: se espera a que la API confirme

El snapshot final se capturaba en el instante en que el usuario pulsaba «Terminar sesión». Como la
API de cuenta sirve desde caché de 5 a 10 minutos, lo ganado en los últimos minutos no había cruzado
todavía: **todas las sesiones subcontaban su botín, siempre y a la baja**, por un camino que devolvía
éxito y clasificaba el resultado como exacto.

Ahora la sesión entra en espera declarada, con cuenta atrás visible y un control para capturar ya
advirtiendo de lo que se pierde. La espera sobrevive a reiniciar Obsidian. Una captura forzada o
fuera de plazo deja la sesión en `estimada`, nunca en `exacta`.

En la misma medida se corrigió el efecto contrario: la duración facturada pasó a ser tiempo jugado
(`stoppedAt`) y no la ventana observada, que habría sumado los diez minutos de espera a cada sesión.
Al unificarla aparecieron **tres** definiciones distintas de «duración» en el código, y un fallo real:
con la hora de parada ilegible el detalle mostraba un guion y no levantaba incidente.

### Primera ejecución

El idioma se resuelve con `getLanguage()` de Obsidian con reserva `en`, en vez de forzar español a
todos los usuarios; la elección manual sigue ganando. El registro de diagnóstico nace apagado y en
nivel `warn`, y la cadencia de consulta por defecto pasa de 2 a 10 minutos. **Los tres solo alcanzan
instalaciones nuevas**: en disco un valor heredado es indistinguible de uno elegido, así que quien ya
tenga el registro encendido debe apagarlo en Ajustes.

### Infraestructura

El gate dejó de encadenar sus pasos con `&&`, que ocultaba en silencio los que nunca llegaban a
correr: ahora son 22 pasos que se ejecutan siempre, cada uno con su veredicto, y un paso no ejecutado
se imprime por su nombre. Añadidos un contrato que rechaza tests nuevos que aseveran sobre el texto
fuente de otro módulo (37 congelados, el número solo puede bajar), `noUnusedLocals` en el typecheck,
y el workflow de publicación por etiqueta. Unificada la máquina de sincronización con el vault, que
estaba duplicada con diferencia cero entre cartera e inventario.

Se auditaron las 24 reimplementaciones de `canonical()` y **no se unificaron**: 29 cuerpos distintos,
varios alimentando huellas ya escritas en el vault del usuario. Unificarlas habría cambiado hashes
persistidos en silencio.

Reindexados 31 localizadores de `src/ui/settings-tab.ts` en
`scripts/action-observability-baseline.json` tras el desplazamiento de una línea que introdujo la
fusión. Solo cambian `line` y `endLine`; ninguna decisión revisada del censo se alteró.

## Release beta 0.1.19 - companion de farmeo en vivo

- Publicada la [GitHub Release `0.1.19`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.19)
  desde el tag y commit `8dace194cc7a6b3a9eba58971091d18c719a7647`. `manifest.json` y `package.json`
  declaran `0.1.19`.
- El lote de producto es `a24c364`, cuyo asunto es
  `feat(session): restore the live farming companion`.
- Hueco declarado: esta entrada no registra la fecha de publicación, los runs de CI, los digests
  remotos de los assets ni el SHA-256 del ZIP de `0.1.19`. No se han medido y no se inventan.

## Release beta 0.1.18 - HUD, historial, Advisor y endurecimiento

- Publicada el 2026-08-31 la
  [GitHub Release `0.1.18`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.18) desde el
  tag y commit `6090defe5fd4b485e4f49efdbfd10f395197a716`.
- Los runs de CI de `main` `33422321993` y del tag `33422707286` terminaron en verde con las tres
  matrices Node, Rust portable/Windows, benchmark y paquete reproducible.
- La release contiene exactamente `manifest.json`, `main.js`, `styles.css`,
  `tyrian-companion-0.1.18.zip` y `tyrian-companion-0.1.18.zip.sha256`. Los digests remotos coinciden
  con los bytes sellados y el ZIP tiene SHA-256
  `fb7aa0ff08b101ae00d7786d273c0d68a02db5971cd95f13f56f7c62b57ebf99`.
- El canal BRAT está publicado. La instalación/actualización por plataforma, la QA visual en
  Obsidian y el contraste live de profundidad del Bazar siguen pendientes y no se consideran
  acreditados por la publicación.

## Incluido en beta 0.1.18 - H9.5, H9.19, H9.20, H12.5 y H12.6

- H9.5 permite comparar el historial por actividad Halloween y build declarado. Los campos viven
  solo en el record local, no atraviesan JSON ni CSV, y un grupo exige al menos dos sesiones
  `exact/high` con valoración completa. Sacos/h y oro/h se agregan ponderando por duración, sin
  promediar tasas ya redondeadas.
- H9.19 toma la duración económica de `delta.window`, no de timestamps auxiliares. Un filtro por
  personaje o almacén conserva cantidades y decisiones, pero retiene el total realizable porque la
  profundidad y el redondeo de tasas pertenecen al conjunto account-wide. El mejor ask se rotula
  como referencia bruta de publicación, nunca como venta total realizable.
- H9.20 reutiliza la profundidad consumible y las tasas del bazar en sesión, inventario durable y el
  kernel curado del saco `#36038`. Los niveles se consumen una vez por objeto, la cobertura parcial o
  agotada queda explícita y las rutas curadas fallan cerradas ante profundidad ausente, stale,
  futura o incompleta.
- H12.5 abre el análisis del Inventory Advisor con **Qué hacer ahora**, mantiene búsqueda y orden
  visibles y pliega el resto bajo **Filtros avanzados**. Los resúmenes se nombran como filtros de la
  lista, no como ejecución, y los controles de una carga quedan deshabilitados de forma nativa.
- H12.6 muestra una sola de las cuatro categorías de Ajustes mediante navegación accesible, conserva
  las 26 definiciones y serializa los guardados visibles para que una respuesta antigua no pise una
  nueva. La navegación pasa de lateral a horizontal bajo 1050 px; filas, tablas Halloween y controles
  cambian causalmente en 760/480 px. Logging y soporte usan el mismo vocabulario ES/EN y recuerdan
  revisar el extracto saneado antes de compartirlo.
- Commits incluidos: `e247d35`, `77745ca`, `46d1e1f`, `ed8d3d8`, `6d9cfb0`, `35dd853`,
  `85949ae`, `80898b0`, `1747443` y `22b4a17`. La revisión del gate separó la captura HTTP de listings del
  modelo/valoradores puros y añadió sabotajes que impiden importarla desde H4.19. Pasan 431 pruebas
  dirigidas. La revisión final cerró además un hueco del validator: profundidad `complete` exige una
  venta demostrada y el warning `market_depth_incomplete` equivale exactamente a una línea parcial,
  inválida o sin cobertura. El gate completo posterior pasa lint, 167 ficheros/2.318 tests, spike
  nativo, scanner, 644 fronteras de observabilidad, empaquetado reproducible, contratos
  beta/release/soporte y build. La rerevisión independiente no encuentra más hallazgos y da el
  árbol por listo para release. Siguen pendientes la QA visual/teclado en Obsidian real y el
  contraste live de listings, Refresh durable y sesión manual; la publicación no acredita esas
  comprobaciones.

## Incluido en beta 0.1.18 - H6.26 y H12.4

- H6.26 limita cada Refresh del Inventory Advisor a dos observaciones dentro de la misma operación y
  credencial. Solo dos capturas completas con ownership y placement equivalentes producen `stable`;
  relocation, divergencia o recuperación transitoria siguen limitadas y bloquean rutas curadas. Un
  primer `429` termina sin segunda pasada para que el cooldown compartido gobierne el reintento.
- Banco y materiales siguen siendo fuentes opcionales: su parcialidad se conserva sin descartar un
  núcleo personaje+compartido completo. El progreso cuenta lecturas reales y no inventa un total
  estable cuando el roster cambia entre observaciones. Un fallo opcional no reintentable ya no veta
  la segunda observación necesaria para recuperar un fallo transitorio del núcleo.
- H12.4 convierte Companion en un HUD priorizado. Las 16 acciones se pliegan bajo un disclosure único
  por debajo de 1050 px, conservan feedback y devuelven el foco al toggle si un resize oculta la acción
  enfocada. La página ordena sesión, detección del saco `#36038`, confirmaciones, historial,
  botín/Halloween y cuenta.
- La detección presenta última consulta, resultado y próxima como datos semánticos. La única CTA
  primaria se recalcula con el estado vivo y no promueve propuestas obsoletas; Halloween permanece
  compacto salvo alerta no leída o error de store. El timer único también cubre propuestas que llegan
  tras el render y, al caducar, elimina CTA y acciones inline sin dejar controles muertos.
- Commits incluidos: `71c562a`, `3bf3250`, `cd1a0d0`, `742e245`, `95e9381`, `bca8a9d`, `e449df5`,
  `c837acf` y `5d1641f`; `ee1f923`, `a19d5e1` y `e04414e` realinean sus fronteras de observabilidad.
  El gate combinado queda verde con lint, 167 ficheros/2.288 tests, spike nativo, scanner,
  643 fronteras de observabilidad sin pendientes,
  empaquetado reproducible, contratos de release/beta/soporte y build. La revisión combinada es el
  último control externo; la QA con cuenta grande y la QA visual/teclado en Obsidian real siguen
  pendientes aunque el lote ya está publicado.

## Incluido en beta 0.1.18 - H6.23, H6.24 y H6.25

- H6.23 corrige la divergencia live entre manifiesto v2 en la raíz anterior y cinco Bases ya
  reserializadas en la nueva carpeta de salida. La relocation exige origen owned/ready/current,
  destino completo y semánticamente exacto, sin extras, y escribe un journal durable antes del
  cambio de puntero y del cleanup; install ordinario no adopta ficheros markerless. QA con filesystem
  y vault desechable: positivo `relocated` con bytes preservados y negativo con `Human.base` ajena
  `conflict` sin una sola escritura.
- H6.24 evita que un timeout parcial de personaje dispare hasta tres fan-outs account-wide. El primer
  `timeout|network|429|5xx` parcial corta las pasadas restantes, conserva cobertura incompleta y no
  publica snapshot; el scheduler mantiene el único timer/backoff y recupera sin duplicar polling.
  `character_inventory|character_build` usan una política explícita de un intento y 30 segundos;
  el calendario ya corregido por H6.19 no cambia.
- H6.25 separa lectura, proyección y publicación del cache de loot. El TypeError histórico queda en
  un único terminal `session_projection/precondition_failed`; lectura real conserva
  `storage_failure`, otro bug de proyección usa `internal_failure` y `runtime_initialize` continúa
  con terminal success. El paquete de soporte excluye texto libre, stack, errorName, state y details.
- Commits incluidos: `446ae51` (assets), `cf0f7c0` (polling), `7732485` (atribución) y `463d367`
  (baseline combinada). El gate queda verde con lint, 167 ficheros/2.269 tests, scanner,
  observabilidad (644 fronteras, 0 pendientes), contratos y build. El lote forma parte de `0.1.18`.

## Incluido en beta 0.1.18 - H8.8 y H7.13

- H8.8 queda reconciliada como política shadow pura y aislada: presencia de 5 s o ausencia de 60 s
  en el mapa 866 producen como máximo un DTO efímero sujeto a revisión humana. No hay composición,
  cola, persistencia, UI ni cambio del lifecycle; H8.9–H8.15 y la congelación por H8.2 permanecen.
- H7.13 incorpora un journal local opt-in, lazy y separado por vault. Toda propuesta presentada se
  reconcilia con una decisión o con `expired|superseded|invalidated`; desarmar una propuesta viva
  inicia el cierre fail-open sin retrasar producto, mientras una propuesta nunca mostrada no crea
  fila. Recoveries sin clasificación permanecen visibles y hacen el resultado inconcluso.
- La agregación publica por plataforma y estratos recuentos, cobertura, Wilson 95 %, precisión,
  recoveries, sesiones y `pass|fail|inconclusive`. La revisión de pérdidas silenciosas queda ligada
  al entorno y a `sampleRevision`: cada mutación real la incrementa e invalida la revisión en la
  misma transacción; una carrera devuelve `stale` y no certifica evidencia no vista.
- La revisión final detectó y `82c0b94` cerró cuatro fallos: el modal instrumental ya no puede
  cancelar aceptar/iniciar/parar; un primer `accepted_workflow_failed` queda sellado ante reintentos
  o exclusiones posteriores; la clasificación de recovery se rehidrata y bloquea contradicciones
  tras recargar; estadísticas y export rechazan revisiones legacy o de otra revisión de muestra.
- La revisión de seguridad detectó un ABA al desactivar y reactivar el mismo perfil. `686194b`
  conserva únicamente un contador generacional no personal, lo avanza durante el borrado y prueba
  que una revisión anterior nunca vuelva a ser válida sobre evidencia nueva.
- La rerevisión detectó que un cambio concurrente de perfil comparaba antes el entorno y degradaba
  un store sano. `4902bf5` prioriza la revisión transaccional: una muestra anterior devuelve `stale`;
  solo una discrepancia de entorno dentro de la revisión vigente es `inconsistent`.
- El último control de seguridad encontró que perfil corrupto y revisión cambiada podían ocultar
  temporalmente la corrupción como `stale`. `f64a06c` valida primero la forma presente, falla
  cerrado y mantiene la carrera legítima de perfil como `stale`.
- Ajustes añade perfil ES/EN, preview, revisión, cuatro exports JSON/CSV deterministas create-only,
  clear de muestra+revisión y disable del journal completo. No hay Sync propio ni telemetría remota;
  los exports del Vault sobreviven a clear/disable y pueden entrar en Obsidian Sync. Los hashes de
  propuestas son seudónimos, no anonimización.
- Los commits incluidos son `25a1057` para la reconciliación H8.8 y `e267ae4`, `ab321a9`,
  `c2981ba`, `388dc86`, `8c7f343`, `221862a`, `82c0b94`, `ba77b95`, `686194b`, `e765b5c`,
  `4902bf5`, `f64a06c` y `e70fb66` para H7.13. Los hallazgos contractuales, de seguridad y de
  revisión independiente quedan cubiertos; 108 tests focales y el gate completo quedan verdes con
  lint, 167 ficheros/2.250 tests, scanner, observabilidad, contratos y build. El dry run real en
  las tres plataformas, QA visual/IndexedDB y la muestra H7.7 siguen pendientes; publicar el journal
  no acredita el piloto.

## Incluido en beta 0.1.18 - reconciliación H6.19 y H6.20

- Ambos hallazgos de QA real estaban corregidos en producción desde `6c6e2cd`, incluido ya en las
  releases `0.1.16` y `0.1.17`; este lote documenta la causa y añade cobertura, sin cambiar de nuevo
  el comportamiento productivo.
- H6.19 no era un doble calendario de detección. Los deadlines observados pertenecían al histórico
  de precios y a detección, pero el primero heredaba erróneamente la identidad `detection_poll`.
  Ahora se distinguen como `price_history_poll` y `detection_poll`; `40d1678` añade una regresión con
  reloj falso que cruza ambos deadlines y exige una ejecución y un timer por consumidor.
- H6.20 reserva `session_start` al gesto humano y etiqueta la persistencia periódica de autoridad
  como `session_lease`, con el saneado positivo habitual y sin datos del lease o de la sesión. La
  sesión live de veinte minutos continúa como aceptación manual no ejecutada desde el repositorio.
- El gate combinado previo a la release queda verde con lint, 162 ficheros y 2.178 tests, seguridad,
  observabilidad, contratos de release/beta/soporte y build.

## Incluido en beta 0.1.18 - H9.7 y H6.21

- H9.7 añade a Companion un panel ES/EN de historial durable. Abrir o repintar la vista no lee el
  vault: el escaneo completo solo parte de **Cargar historial**, coalesce dobles activaciones y
  conserva en memoria los estados `idle`, `loading`, `empty`, `ready`, `conflict` y `unavailable`.
- La agregación elimina referencias de cuenta y sesión, ordena las sesiones finalizadas, compara las
  dos más recientes y presenta tabla o tarjetas responsive. Totales y diferencias desconocidos
  permanecen `null`; una nota inválida o duplicada bloquea toda la presentación sin modificar notas.
- H6.21 incorpora copy accionable ES/EN para los ocho motivos de fallo de inicio y los seis de
  cierre. Los mapas tipados son exhaustivos y el mensaje/cooldown de conexión conserva su circuito
  independiente.
- Los dos commits están integrados y publicados en `0.1.18`. La revisión independiente hizo corregir
  el orden por cierre y
  la pérdida de segundos en duraciones/deltas subminuto. El gate combinado final queda verde con
  lint, 162 ficheros y 2.178 tests, seguridad, observabilidad, contratos de release/beta/soporte y
  build. La QA visual de H9.7 y H6.21 y la comprobación de un `429` real dentro de Obsidian siguen
  pendientes.

El detalle de `0.1.17` y anteriores, hasta `[0.1.0] - Unreleased`, vive en
[`docs/historico/CHANGELOG-hasta-0.1.17.md`](historico/CHANGELOG-hasta-0.1.17.md). Incluye la
introducción de H8.5, el helper Mumble en Rust cuyo artefacto de CI conserva solo el marker
`UNSIGNED-NOT-FOR-RELEASE`, y para el que firma y QA real siguen pendientes.

