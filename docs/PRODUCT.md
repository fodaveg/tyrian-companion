# Producto

## Propósito y usuarios

Tyrian Companion es una plataforma modular para entender y organizar una cuenta de Guild Wars 2 desde Obsidian. Su norte es convertir datos dispersos de cuenta, inventario, economía, sesiones y objetivos en información explicada y accionable, sin operar nunca sobre la cuenta del jugador.

H5.1 convierte la vista base en una bitácora de campo: en dos segundos debe responder si una sesión puede o está farmeando y si su observación es fiable. Fase y duración dominan; detector, polling, calidad y cuenta forman una sola rail, mientras la incidencia más importante interrumpe la superficie y el diagnóstico completo queda bajo disclosures. Esta vertical no añade comandos, notificaciones, historial ni acciones económicas.

H5.2 hace accesible el mismo lifecycle desde la paleta y un único menú de ribbon. Solo muestra acciones válidas para el estado observado y vuelve a comprobarlas al ejecutar; recovery bloquea Start, stop fallido puede reintentarse, y provisional abre la revisión existente. Descartar recovery o limpiar una sesión completa requiere confirmación y solo afecta datos locales del companion. No existe un comando que cancele una sesión activa ni se añaden operaciones sobre la cuenta.

H5.3 conserva localmente las propuestas asistidas aunque la nota esté cerrada. El fondo solo encola y actualiza indicadores existentes: no reconstruye controles, muestra `Notice`, modal o notificación del sistema, cambia el foco ni revela una vista. La bitácora y el ribbon anuncian cuántas confirmaciones esperan y enseñan una sola propuesta para revisar. La elección fija la identidad exacta observada; aceptar reutiliza Start/Stop, renueva su claim y solo emite receipt tras el éxito, mientras descartar conserva una causa cerrada incluso si la medición auxiliar no puede escribirse. Un Start/Stop manual ordinario deja intacta la cola.

H5.4 convierte una sesión completa en una nota durable antes de permitir **Clear**. La nota muestra el neto observado, su fiabilidad y las decisiones manuales disponibles sin incluir account id, snapshots o cotizaciones crudas. Tyrian Companion conserva cualquier texto humano, no ejecuta acciones en Guild Wars 2 y rechaza actualizar una región gestionada que haya sido alterada o resulte ambigua.

H5.5 presenta ese neto como un ledger de botín compartido por la nota y el Companion: separa ganancia de pérdida, reserva de retención y cantidad libre, y total de subtotal conocido. Si la clasificación no permite valorar o recomendar, conserva las cantidades observadas pero oculta dinero y acciones; ninguna recomendación ejecuta nada en el juego.

Está pensado tanto para un jugador individual como para grupos o clanes que quieran compartir la misma herramienta manteniendo sus datos separados. Cada instalación usa la clave y el vault de su propietario: no existe un servidor central, no se comparten claves ni se agregan datos del clan por defecto.

## Semántica de exactitud

El producto nunca promete conocer «todo el loot»: la API de Guild Wars 2 ofrece snapshots, no un flujo de cada objeto obtenido. Toda medición futura deberá declarar uno de estos estados:

- `exacta`: snapshots estables y sin actividad externa detectada o declarada.
- `estimada`: resultado útil con una limitación conocida, como una ubicación no validada o incertidumbre temporal.
- `contaminada`: compras, ventas, aperturas, reciclaje, consumo u otros movimientos impiden atribuir todo el delta al farmeo.
- `inválida`: faltan datos esenciales; no se calcula rendimiento ni se emite recomendación económica.

Ante datos desconocidos o una regla insuficiente, el advisor debe recomendar conservar o revisar, nunca destruir.

## Alcance de v1

La primera versión de producto incluye:

- Núcleo de API, credenciales, catálogo, caché y snapshots de las superficies de cuenta soportadas.
- Paridad con la sincronización de materiales y cartera existente.
- Sesiones manuales y detección autoasistida mediante API, con revisión final del usuario.
- Valoración económica trazable y recomendación conservadora de abrir, vender o reservar.
- Notas y Bases instalables sin sobrescribir contenido del usuario.
- Inventory Advisor limitado a reglas de alta confianza.

El MVP es estrictamente API-only. Linux con Steam/Proton es la plataforma primaria, macOS con
CrossOver la secundaria y Windows permanece en beta. La matriz de soporte, los gates y las métricas
del piloto se fijan en [Política de plataformas e integraciones](PLATFORM_POLICY.md).

Quedan fuera de v1 Mumble Link, cualquier automatización del juego, operaciones sobre el bazar, un backend compartido y recomendaciones destructivas automáticas. Mumble Link solo puede evaluarse en v2 como helper IPC opcional y separado para mapa/actividad; no sustituye la API, no inspecciona el proceso del juego y no confirma ni ejecuta acciones.

## Vertical actual

La versión `0.1.0` valida la base técnica:

- El plugin carga solo en escritorio.
- Un comando abre una vista con el estado de conexión.
- Los ajustes permiten seleccionar una clave de API con `SecretComponent`.
- La configuración persistida contiene el nombre del secreto, nunca su valor.
- **Check connection** valida explícitamente la clave y la cuenta; **Start session** y **Stop session** capturan las fronteras manuales. **Arm assisted detection** inicia el muestreo solo tras una acción explícita. Ninguna llamada de red ocurre al cargar o abrir la vista.
- Los ajustes versionados preparan idioma, carpeta de salida, personaje preferido, intervalo y modo de detección; el modo asistido expone un control de armado que siempre vuelve desarmado al recargar.
- H1.4 garantiza mediante lease cercado local que una máquina no tenga dos sesiones activas coordinadas a la vez; todavía no crea ni gestiona sesiones de producto.
- H3.1 aporta una máquina de estados pura y cercada para `idle → starting → active → stopping → provisional → complete|error`.
- H3.2 conecta el inicio manual a la vista: pide personaje y Magic Find, captura un baseline estable y el build activo, conserva sus timestamps y mantiene la autoridad mediante heartbeat. Un fallo de arranque vuelve a `idle` y no deja una sesión de producto fantasma.
- H3.3 conecta el cierre manual: captura un final estable, calcula el delta físico y revalida el fence antes de dejar la sesión `provisional`. Un fallo de captura/delta conserva el baseline y permite reintentar; H3.9 clasifica después y H5.10 exporta el historial durable de forma explícita.
- H3.4 persiste localmente el runtime recuperable —baseline, final/delta cuando existen y estado cercado— y ofrece recuperación o descarte explícitos tras reiniciar, sin red automática ni escritura al vault.
- H3.5 aporta el reloj de polling: no solapa consultas, pausa ante offline/sleep y reintenta con rate limit/backoff sin ráfagas. H3.8 solo lo arranca tras capturar un baseline estable desde el control de armado.
- H3.6 reconoce actividad sostenida solo mediante listas versionadas de IDs relevantes: dos deltas positivos que comparten snapshot fronterizo generan una propuesta con la ventana en que pudo empezar. La regla inicial usa el id oficial de los sacos de Halloween; no usa nombres ni heurísticas de catálogo y no inicia una sesión sin confirmación.
- H3.7 detecta silencio sostenido mediante muestras contiguas y un umbral temporal. Produce una propuesta revisable con ventana posible de fin; una ganancia reinicia el reloj y nunca termina la sesión automáticamente.
- H3.8 conecta esas piezas a un estado permanentemente visible: desarmado, armando, armado, propuesta o error. Las propuestas pausan el polling y exigen iniciar, detener o descartar explícitamente; cargar el plugin nunca restaura el armado.
- H3.9 pregunta de forma explícita por aperturas, reciclaje, consumo, fabricación/conversión, compras/ventas en bazar o mercader, transferencias y otra actividad. H2.7 deriva la calidad: limpio confirmado puede finalizar, actividad declarada queda contaminada y una duda permanece estimada/provisional. La revisión y la sesión completa sobreviven al reinicio en almacenamiento local; H5.10 permite exportar el historial durable, aunque el panel/agregación de sesiones siga pendiente.
- H3.10 registra localmente cómo se fijó cada frontera: manual o asistida, causa, incertidumbre y calidad de evidencia. Descartar una propuesta exige clasificar el falso positivo; el resumen conserva correcciones, modo e incertidumbre sin snapshots ni payloads crudos de inventario ni texto libre. Para procedencia de inicio asistido permite únicamente la `RelevantStartProposal` completa: `version`, `proposalId`, `accountId`, `ruleSet` id/versión, `firstSignal` y `confirmationSignal` con refs de snapshots, intervalos/ventanas, ganancias `itemId`/`quantity` y `deltaStatus`, además de `possibleStart`, `evidenceQuality` y `confirmedAt`. La medición es auxiliar y nunca bloquea la sesión.
- H4.1 fija todas las magnitudes monetarias en cobre entero. Bruto, venta inmediata, listado, mercader y ausencia de valor líquido tienen fórmulas y liquidez explícitas; `null` significa no valorable, mientras que `0` sigue siendo un importe real.
- H4.2 aplica una política versionada de tasas del bazar —5% de publicación y 10% de intercambio sobre la venta total— y solo ofrece valor de mercader cuando el catálogo declara un valor positivo y no incluye `NoSell`.
- H4.3 clasifica cada pila por disponibilidad, binding y evidencia de precio. Ninguna pila ligada o sin precio infla el valor del bazar; un valor de mercader probado permanece separado, incluso para objetos account-bound, y los objetos engastados/equipados no se tratan como realizables sin extraerlos.
- H4.4 captura al cerrar bid y ask públicos de los items ganados, con timestamp, fuente y cobertura explícita. La consulta envía solo ids numéricos al endpoint público oficial y un fallo no bloquea la sesión ni se interpreta como valor cero.
- H4.5 combina el neto físico con precio, catálogo y binding explícito. Conserva por separado inmediato/listado/mercader/no líquido, suma moneda observada y calcula sacos/h y cobre/h; la evidencia incompleta degrada cobertura y las pérdidas no reciben un valor inventado.
- H4.6 exige que cada modelo de saco declare versión, fuente, muestra fechada, resultados, incertidumbre y política de valoración. Las unidades observadas y esperadas se conservan con aritmética entera para que el cálculo sea reproducible y admita varias unidades del mismo objeto por saco.
- H4.7 fija el primer modelo de Bolsa de truco o trato a la revisión `3161313` de la investigación comunitaria de la wiki: 106.264 sacos y 18 resultados auditables. El modelo conservador excluye todos los superraros y el resto de la cola rara, en lugar de atribuir a un jackpot observado un valor esperado injustificable.
- H4.8 calcula el EV conservador de abrir en microcobre y mantiene dos cifras distintas: venta inmediata al bid y listado al ask, ambas netas de tasas. Los premios excluidos o ligados suman exactamente cero oro líquido; si falta una cotización, el total de esa ruta queda desconocido y solo se muestra el subtotal respaldado.
- H4.9 reserva el balance final para objetivos activos sin duplicar unidades: distingue propiedad de disponibilidad, prioridad, faltantes, uso previsto y cobertura demostrada por namespace. Sus allowances dicen qué cantidad sigue elegible para liquidar, abrir, consumir, canjear o gastar; evidencia desconocida bloquea ese cálculo. El overlay solo acepta evidencia H4.5 coherente, separa cantidades protegidas/elegibles y conserva intactos importes, fees, cobertura y tasas. Todavía no persiste objetivos/planes, muestra UI ni recomienda una acción.
- H4.10 emite una recomendación pura y trazable de abrir o vender únicamente para la parte no reservada de un contenedor. Exige sesión exacta de alta confianza, modelo aprobado y vigente, un único batch de precios fresco, identidad coherente y una ruta de venta realizable. Recalcula tasas para la pila libre y compara con enteros exactos contra un margen versionado; igualdad abre. Evidencia limitada bloquea sin acción y evidencia incoherente invalida. No abre, vende, persiste ni muestra todavía la recomendación.
- H4.11 permite expresar una intención explícita de conservar items hasta un precio o deadline. Las intenciones activas comparten sin duplicar la cantidad libre posterior a reservas; alcanzar el precio, cancelar o expirar devuelve unidades a H4.10, y un precio ausente conserva temporalmente en vez de inventar una señal. La salida explica asignación, faltante y neto objetivo con las tasas H4.2. Todavía no persiste ni edita intenciones y nunca opera sobre la cuenta.
- H4.12 convierte cada resultado en un envelope JSON manual y sin efectos laterales. Reserva, retención, recomendación económica o revisión quedan como decisiones con cantidades y referencias internas; ningún dato contiene callbacks, credenciales, órdenes ejecutadas o una capacidad de operar. El guard arquitectónico impide que la frontera de recomendaciones importe clientes/transportes/stores/secretos o invoque métodos de ejecución.
- H4.13 fija el contrato defensivo del Inventory Advisor para `supported_storage_v1`, no para toda la cuenta. Catálogo, precios, objetivos, excepciones de conservación, desbloqueos y reglas revisadas quedan ligados al mismo snapshot. La salida particiona cantidades y solo describe acciones manuales; `discard_candidate` es una revisión irreversible curada y nunca una orden de destruir. H4.14-H4.16 cubren captura, motor y allowlist pura. H5.11 añade la vista manual separada: abrir no captura y actualizar compone esas capas una sola vez; el descarte se muestra solo como review warning con proof. Hasta publicar un bundle revisado real, la vista queda bloqueada antes de red con `missing_rules`. H5.12 sigue pendiente para preferencias persistidas.
- H4.14 ya captura manualmente la evidencia completa de esa superficie: catálogo para cada item propio,
  precios públicos frescos para cada item disponible y señales de TP/desbloqueos/progreso con cobertura
  y TTL, con fingerprint SHA-256 del snapshot que conserva el orden físico. Un permiso ausente o fallo de API no se disfraza de «no desbloqueado»; deja la evidencia limitada.
  Sigue sin persistir ni mostrar una interfaz. H4.15 ya clasifica puramente cada posición física propia:
  reserva y excepciones preceden a cualquier ruta, lo no suelto se revisa, y uso/abrir/reciclar/mercader/TP
  solo salen con evidencia completa y fresca. H4.16 ya añade una allowlist excepcional y pura: solo
  conserva candidatos review-only cuando reproduce exactamente el productor H4.15 y prueba ausencia
  de rutas, reservas y excepciones. H5.11 ya presenta el resultado manual; H5.12 y el bundle revisado permanecen pendientes.
- H5.6 ofrece Preview, Apply, Repair, Move y Remove para assets gestionados. H5.7 añade una Base Halloween ES/EN al mismo bundle: cinco vistas consumen notas schema v2 con evento explícito y mantienen fuera de mejor g/h cualquier sesión estimada, contaminada, parcial o no evaluada. H5.8 mantiene esos outputs portables entre macOS, Linux y Windows mediante rutas NFC relativas, sin rutas personales ni nombres incompatibles; la reescritura canónica de settings elimina propiedades desconocidas y conserva solo las rutas legacy autorizadas para reubicar o retirar explícitamente. No se escribe al cargar en el Vault ni se sobrescriben modificaciones humanas.
- H5.9 permite usar ajustes, Companion, confirmaciones, menús, modales, notas de sesión, botín y Bases en español o inglés sin cambiar los datos que consultan Bases ni los identificadores de acciones. El cambio de idioma refresca las superficies abiertas y selecciona el bundle localizado; la paleta de comandos de Obsidian puede conservar el nombre registrado hasta recargar el plugin.
- H5.10 permite exportar manualmente el historial durable validado como JSON y CSV. El export no recorre el vault hasta que el usuario lo pide, no acepta esquemas futuros, referencias duplicadas ni bloques alterados, y no incluye IDs crudos, rutas, nombres de personaje/build ni notas humanas.
- H5.10 ofrece también en Ajustes una eliminación conservadora con preview y confirmación explícita: conserva los archivos y todo contenido humano, quita únicamente `tc_*` y los seis bloques gestionados, no toca exports/configuración/assets/stores ni usa la papelera, y se bloquea mientras sesión, recovery o detector no estén en reposo.
- El núcleo `storage_snapshot` observa roster, inventarios de personaje, almacenamiento compartido, banco y materiales; cartera y delivery son capacidades opcionales.
- Cada snapshot declara cuenta, identidad, intervalo, cobertura y calidad temporal; separa propiedad de disponibilidad y conserva el origen de las divisas sin calcular valor económico.
- `PublicCatalog` resuelve aparte nombres y metadatos localizados de objetos, divisas y categorías, con cobertura por id, persistencia local fuera del vault y sin credenciales.
- H2.6 compara dos snapshots cualificados, valida sus agregados y separa variación neta, disponibilidad y composición. La falta de wallet limita las divisas sin ocultar cambios de items; todavía no infiere causa, sesión, contaminación ni valor.
- H2.7 combina ese neto con fronteras, delivery/wallet con cobertura completa, eventos TP y declaración del usuario para clasificarlo como exacto, estimado, contaminado o inválido. Una confirmación limpia manual puede resolver aumentos ambiguos de wallet; evidencia observada de actividad siempre prevalece. La clasificación v2 solo autoriza recomendar cuando el resultado es exacto y de confianza alta; H3.9 posee las preguntas y persistencia, mientras H2.7 sigue sin UI, red ni valoración.
- Las entradas H2.7 se validan en runtime y cualquier estructura corrupta produce una clasificación inválida segura, nunca una atribución optimista ni una excepción hacia la UI futura.
- `account`, `advisor`, `sessions` y `objectives` tienen límites de módulo explícitos.

## Fuera de alcance de la vertical 0.1.0

- Sincronización periódica independiente del armado o panel/agregación del historial durable de sesiones finalizadas.
- Precios y cálculo de patrimonio total.
- Consulta automática del historial personal del bazar; H3.9 usa por ahora declaración explícita.
- Panel histórico agregado de precisión/recall; H3.10 conserva observaciones locales, pero todavía no calcula métricas de población ni sincroniza telemetría.
- Escritura libre o automática de notas del vault; H5.4 solo escribe la nota completa con bloques gestionados tras completar la sesión y H5.6 solo modifica assets mediante una operación explícita.
- Persistencia de preferencias/intenciones y ejecución de recomendaciones; H5.11 solo presenta decisiones manuales y no opera en el juego.
- Inicio o cierre automático de sesiones sin confirmación.
- Compatibilidad móvil.

## Principios

1. **Privacidad por defecto.** Los secretos no se copian a `data.json`, logs ni vistas.
2. **Sin actividad implícita.** Cargar o abrir el plugin no inicia peticiones.
3. **Recomendaciones trazables.** Una vertical futura deberá separar datos observados, reglas y explicación.
4. **Vault bajo control del usuario.** Toda escritura requiere un contrato y una acción explícita.
