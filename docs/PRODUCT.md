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
- **Check connection** valida explícitamente la clave y la cuenta; **Start session** ejecuta la captura inicial. Ninguna llamada de red ocurre al cargar o abrir la vista.
- Los ajustes versionados preparan idioma, carpeta de salida, personaje preferido, intervalo y modo de detección sin activar todavía esas funciones.
- H1.4 garantiza mediante lease cercado local que una máquina no tenga dos sesiones activas coordinadas a la vez; todavía no crea ni gestiona sesiones de producto.
- H3.1 aporta una máquina de estados pura y cercada para `idle → starting → active → stopping → provisional → complete|error`.
- H3.2 conecta el inicio manual a la vista: pide personaje y Magic Find, captura un baseline estable y el build activo, conserva sus timestamps y mantiene la autoridad mediante heartbeat. Un fallo de arranque vuelve a `idle` y no deja una sesión de producto fantasma.
- El núcleo `storage_snapshot` observa roster, inventarios de personaje, almacenamiento compartido, banco y materiales; cartera y delivery son capacidades opcionales.
- Cada snapshot declara cuenta, identidad, intervalo, cobertura y calidad temporal; separa propiedad de disponibilidad y conserva el origen de las divisas sin calcular valor económico.
- `PublicCatalog` resuelve aparte nombres y metadatos localizados de objetos, divisas y categorías, con cobertura por id, persistencia local fuera del vault y sin credenciales.
- H2.6 compara dos snapshots cualificados, valida sus agregados y separa variación neta, disponibilidad y composición. La falta de wallet limita las divisas sin ocultar cambios de items; todavía no infiere causa, sesión, contaminación ni valor.
- H2.7 combina ese neto con fronteras, delivery/wallet con cobertura completa, eventos TP y declaración del usuario para clasificarlo como exacto, estimado, contaminado o inválido. Una confirmación limpia manual puede resolver aumentos ambiguos de wallet; evidencia observada de actividad siempre prevalece. Expone permisos conservadores, pero no pregunta, persiste, valora ni recomienda.
- Las entradas H2.7 se validan en runtime y cualquier estructura corrupta produce una clasificación inválida segura, nunca una atribución optimista ni una excepción hacia la UI futura.
- `account`, `advisor`, `sessions` y `objectives` tienen límites de módulo explícitos.

## Fuera de alcance de la vertical 0.1.0

- Sincronización periódica o persistencia de snapshots y sesiones.
- Precios y cálculo de patrimonio total.
- Preguntas, aceptación y persistencia H3.9 de la clasificación de sesión.
- Parada, cierre y recovery H3.3–H3.4 sobre la sesión iniciada.
- Escritura o modificación de notas del vault.
- Recomendaciones, priorización o inferencias sobre qué debería hacer el jugador.
- Seguimiento automático de sesiones.
- Compatibilidad móvil.

## Principios

1. **Privacidad por defecto.** Los secretos no se copian a `data.json`, logs ni vistas.
2. **Sin actividad implícita.** Cargar o abrir el plugin no inicia peticiones.
3. **Recomendaciones trazables.** Una vertical futura deberá separar datos observados, reglas y explicación.
4. **Vault bajo control del usuario.** Cualquier escritura futura requerirá un contrato y una acción explícita.
