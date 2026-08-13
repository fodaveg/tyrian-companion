# Producto

## Propósito y usuarios

Tyrian Companion es una plataforma modular para entender y organizar una cuenta de Guild Wars 2 desde Obsidian. Su norte es convertir datos dispersos de cuenta, inventario, economía, sesiones y objetivos en información explicada y accionable, sin operar nunca sobre la cuenta del jugador.

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

Quedan fuera de v1 Mumble Link, cualquier automatización del juego, operaciones sobre el bazar, un backend compartido y recomendaciones destructivas automáticas.

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
- H3.3 conecta el cierre manual: captura un final estable, calcula el delta físico y revalida el fence antes de dejar la sesión `provisional`. Un fallo de captura/delta conserva el baseline y permite reintentar; H3.9 clasifica después y el historial durable sigue pendiente.
- H3.4 persiste localmente el runtime recuperable —baseline, final/delta cuando existen y estado cercado— y ofrece recuperación o descarte explícitos tras reiniciar, sin red automática ni escritura al vault.
- H3.5 aporta el reloj de polling: no solapa consultas, pausa ante offline/sleep y reintenta con rate limit/backoff sin ráfagas. H3.8 solo lo arranca tras capturar un baseline estable desde el control de armado.
- H3.6 reconoce actividad sostenida solo mediante listas versionadas de IDs relevantes: dos deltas positivos que comparten snapshot fronterizo generan una propuesta con la ventana en que pudo empezar. La regla inicial usa el id oficial de los sacos de Halloween; no usa nombres ni heurísticas de catálogo y no inicia una sesión sin confirmación.
- H3.7 detecta silencio sostenido mediante muestras contiguas y un umbral temporal. Produce una propuesta revisable con ventana posible de fin; una ganancia reinicia el reloj y nunca termina la sesión automáticamente.
- H3.8 conecta esas piezas a un estado permanentemente visible: desarmado, armando, armado, propuesta o error. Las propuestas pausan el polling y exigen iniciar, detener o descartar explícitamente; cargar el plugin nunca restaura el armado.
- H3.9 pregunta de forma explícita por aperturas, reciclaje, consumo, fabricación/conversión, compras/ventas en bazar o mercader, transferencias y otra actividad. H2.7 deriva la calidad: limpio confirmado puede finalizar, actividad declarada queda contaminada y una duda permanece estimada/provisional. La revisión y la sesión completa sobreviven al reinicio en almacenamiento local; el historial de varias sesiones aún no existe.
- H3.10 registra localmente cómo se fijó cada frontera: manual o asistida, causa, incertidumbre y calidad de evidencia. Descartar una propuesta exige clasificar el falso positivo; el resumen de la sesión conserva correcciones, modo e incertidumbre sin texto libre ni datos de inventario. La medición es auxiliar y nunca bloquea la sesión.
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
- El núcleo `storage_snapshot` observa roster, inventarios de personaje, almacenamiento compartido, banco y materiales; cartera y delivery son capacidades opcionales.
- Cada snapshot declara cuenta, identidad, intervalo, cobertura y calidad temporal; separa propiedad de disponibilidad y conserva el origen de las divisas sin calcular valor económico.
- `PublicCatalog` resuelve aparte nombres y metadatos localizados de objetos, divisas y categorías, con cobertura por id, persistencia local fuera del vault y sin credenciales.
- H2.6 compara dos snapshots cualificados, valida sus agregados y separa variación neta, disponibilidad y composición. La falta de wallet limita las divisas sin ocultar cambios de items; todavía no infiere causa, sesión, contaminación ni valor.
- H2.7 combina ese neto con fronteras, delivery/wallet con cobertura completa, eventos TP y declaración del usuario para clasificarlo como exacto, estimado, contaminado o inválido. Una confirmación limpia manual puede resolver aumentos ambiguos de wallet; evidencia observada de actividad siempre prevalece. La clasificación v2 solo autoriza recomendar cuando el resultado es exacto y de confianza alta; H3.9 posee las preguntas y persistencia, mientras H2.7 sigue sin UI, red ni valoración.
- Las entradas H2.7 se validan en runtime y cualquier estructura corrupta produce una clasificación inválida segura, nunca una atribución optimista ni una excepción hacia la UI futura.
- `account`, `advisor`, `sessions` y `objectives` tienen límites de módulo explícitos.

## Fuera de alcance de la vertical 0.1.0

- Sincronización periódica independiente del armado o historial durable de sesiones finalizadas.
- Precios y cálculo de patrimonio total.
- Consulta automática del historial personal del bazar; H3.9 usa por ahora declaración explícita.
- Panel histórico agregado de precisión/recall; H3.10 conserva observaciones locales, pero todavía no calcula métricas de población ni sincroniza telemetría.
- Escritura o modificación de notas del vault.
- UI, persistencia o ejecución de recomendaciones; H4.10 solo entrega una explicación pura para contenedores.
- Inicio o cierre automático de sesiones sin confirmación.
- Compatibilidad móvil.

## Principios

1. **Privacidad por defecto.** Los secretos no se copian a `data.json`, logs ni vistas.
2. **Sin actividad implícita.** Cargar o abrir el plugin no inicia peticiones.
3. **Recomendaciones trazables.** Una vertical futura deberá separar datos observados, reglas y explicación.
4. **Vault bajo control del usuario.** Cualquier escritura futura requerirá un contrato y una acción explícita.
