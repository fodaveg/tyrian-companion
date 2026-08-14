# Modelo de amenazas

## Alcance y supuestos

Tyrian Companion es un plugin local de Obsidian para escritorio. Consulta la API oficial de Guild Wars 2 (GW2), escribe notas y assets en la bóveda y mantiene estado operativo en IndexedDB. No tiene backend propio, Sync propio, analítica remota, telemetría remota, exportación de soporte, automatización de cuenta ni runtime Mumble. H8.1 incorpora solo un contrato declarativo de v2; H8.2 añade un spike C fuera de `src/` y del paquete, y H8.3 acepta provisionalmente Rust y una forma de distribución futura. Ninguno añade todavía helper, transporte, listener ni composición productiva. Sí existe telemetría **local** de calidad de detección API para poder revisar cómo se propuso o confirmó una sesión.

Obsidian, sus servicios opcionales de Sync, el sistema operativo, la API de GW2, el repositorio/issue
tracker de GitHub y cualquier otro plugin instalado son fronteras externas. El modelo protege contra
filtraciones accidentales dentro del código y las superficies implementadas. No promete
confidencialidad frente a malware local, un plugin con privilegios equivalentes, una bóveda o cuenta
ya comprometida, un reporte humano que ignore la redacción ni un paquete de desarrollo malicioso.

## Flujos de red y credencial

- El token GW2 se obtiene de `SecretStorage` solo al ejecutar una operación que lo necesita. La configuración persistida guarda el **nombre de la entrada**, no el valor del token.
- Toda petición autenticada construida por `GuildWars2Client` va exclusivamente a `https://api.guildwars2.com/v2/...`. El constructor no permite sustituir ese host. La cabecera de autorización se añade después de validar que la ruta es relativa.
- La validación consulta `/v2/tokeninfo`; su identificador, nombre y scopes se materializan transitoriamente al parsear la respuesta. El estado de conexión expuesto al resto del plugin conserva nombre y scopes, pero no el identificador del token ni el token crudo.
- Catálogos y precios públicos también proceden de la API oficial de GW2 y no llevan la cabecera de autorización.
- No hay endpoints del proyecto, subida de diagnósticos, analítica remota ni tráfico Mumble. H8.1 reabre el modelo para fijar esa frontera futura, pero no autoriza ni implementa red/IPC. Cualquier runtime posterior exige una nueva revisión sobre su diff y QA real.
- El formulario de bugs es una superficie humana de GitHub, no un uploader del plugin. Solicita solo
  versión, plataforma, modo/fase y reproducción redactada; una confirmación obligatoria prohíbe clave,
  identidad, ruta local, inventario/snapshot crudo, IndexedDB, notas y salida sin redactar.

Los errores HTTP se reducen a estado y mensaje estable: no incluyen URL, cabeceras ni cuerpo remoto. La API de GW2 es entrada no confiable; sus respuestas se validan antes de convertirse en modelos o persistirse.

## Inventario de datos, retención y borrado

| Superficie | Datos | Retención y borrado actuales |
| --- | --- | --- |
| `SecretStorage` de Obsidian | Token GW2 crudo | Ciclo de vida controlado por Obsidian y el usuario. El plugin lee el valor de forma efímera y solo selecciona su nombre. |
| Settings (`data.json` del plugin) | Nombre de la entrada secreta, locale, carpeta de salida, personaje preferido, modo/sondeo de detección y rutas/estado de assets gestionados | Persiste hasta cambiar ajustes, desinstalar o borrar los datos del plugin. La carga elimina campos antiguos de credencial y fuerza su reescritura incluso si también debe retener rutas legacy. Según la configuración del usuario, Obsidian podría sincronizar settings; este proyecto no controla ni ha verificado ese servicio. |
| Estado de conexión en memoria | Cuenta, mundo, fecha de creación, access/scopes y nombre de la key | No se persiste por este estado; se descarta al descargar/reiniciar el plugin o cambiar/desconectar el secreto. El ID del token solo existe durante la validación. |
| `tyrian-companion-session-runtime` | Una sesión activa/recuperable: `accountId`, personaje, inventario/build/wallet inicial y final, deltas, revisión y precios | Se conserva hasta descartar la sesión o limpiarla después de escribir con seguridad la nota. No tiene expiración automática. Los esquemas exactos rechazan campos extra. |
| `tyrian-companion-coordination` | IDs de máquina, instancia y sesión; fences, leases y timestamps | Se sobrescribe o libera durante la coordinación; los leases expiran, aunque el registro local puede permanecer. No contiene token. |
| `tyrian-companion-detection-quality` | Eventos locales, IDs de sesión/propuesta, ventanas, causa y, en propuestas asistidas, `accountId`, IDs de snapshots y ganancias de items | No tiene expiración ni borrado/exportación integral expuestos actualmente. Es telemetría local; nunca se envía por el código inspeccionado. |
| `tyrian-companion-confirmation-queue` | Cuenta/sesión/propuesta/snapshot y evidencia de ganancias; decisiones de confirmación | Las propuestas pendientes expiran a las 24 h y los recibos se podan a los 30 días durante el procesado. No existe aún un borrado integral explícito para el usuario. |
| Cache de catálogo | Metadatos públicos de items, monedas y materiales; marcadores de ausencias | TTL: 7 días para items/monedas, 1 día para materiales y 1 hora para ausencias; se admite stale hasta 30 días. No contiene datos personales ni credenciales. |
| Contrato H8.1 Mumble v2 | Constantes públicas de versión, límites, fuentes, map id 866 y tipos TS | No procesa ni persiste datos. El helper/IPC productivo todavía no existe. El contrato futuro exige retención `none` para raw y frames. |
| Spike H8.2 CrossOver | Fuente C no productiva, fixtures sintéticos y un frame efímero por stdout en la futura QA | No se importa ni empaqueta. La prueba automatizada no abre la botella; la prueba real aún no se ha ejecutado. El probe no guarda raw ni frame. |
| Puntero de assets gestionados | Identidad hash de la bóveda, raíz, generación y estado | Persiste para poder actualizar o retirar assets gestionados. No contiene token; la raíz sí puede revelar estructura local a quien ya lea el almacenamiento del plugin. |
| Notas de sesión en la bóveda | Personaje/profesión/build, tiempos, economía, resultados y referencias estables SHA-256 de cuenta/sesión | Se conservan hasta que el usuario las borra. Los hashes estables son seudónimos, no anonimización. Assets gestionados no contienen datos de cuenta. |

Los snapshots completos permiten comparar el antes y el después, pero elevan el impacto de acceso local no autorizado. La implementación minimiza campos en cada parser y no guarda la credencial; aun así, el usuario debe considerar la bóveda y el perfil de Obsidian datos personales locales.

## Amenazas y controles

| Amenaza | Control actual | Riesgo residual |
| --- | --- | --- |
| Token persistido o enviado al host equivocado | `SecretStorage`, migración de settings, operación efímera y host HTTPS oficial no inyectable. El test de frontera ejecuta el cliente y transporte reales y exige host, protocolo y cabecera exactos. | Código nuevo podría crear otro cliente HTTP o leer el secreto fuera del flujo revisado. |
| Token en runtime, stores o notas | Validadores exactos en fronteras de persistencia; pruebas productivas invocan `save`, `saveData` y el writer real con un centinela y exigen rechazo antes de escribir. Descubrimiento recursivo revisa stores/writers nuevos. | El guard es una defensa de regresión, no aislamiento frente a código local malicioso u ofuscado. |
| Fuga por errores, logs o soporte | `HttpTransportError` sanea respuestas. No se admite `console.*` ni logger/telemetry remotos en fuente productiva; no existe exportador de soporte. El issue form exige contexto cerrado y aceptación de redacción; el guard prueba también que los issues en blanco permanecen desactivados. Rutas futuras con nombres de soporte/export/share/backup/report exigen allowlist revisada. | GitHub, notificaciones y caches quedan fuera del plugin; el usuario aún puede pegar un dato prohibido pese al aviso. Un nombre no convencional o un sistema fuera de `src` requiere revisión humana. |
| Secreto o credencial real en repositorio/fixtures | El scanner enumera ficheros tracked y untracked no ignorados mediante Git, normaliza rutas multiplataforma y decodifica texto UTF-8/UTF-16 con o sin BOM. Busca claves privadas, formatos conocidos, asignaciones de credencial, Bearer y fixtures con evidencia de secreto. Solo informa ruta y regla. | Es análisis textual: no cubre historia Git, binarios, cifrado, fragmentación/obfuscación ni todos los formatos futuros. No sustituye un secret scanner histórico del servidor. |
| Scanner que deja de vigilar una regla | La suite tiene un positivo por regla, corpus real por Git, encodings, negativos de falsos positivos, redacción de salida, sabotaje individual de cada regla y un scanner always-green. | Al añadir una regla hay que añadir también su positivo y su sabotaje. |
| Helper Mumble no revisado o fuera de censo | Scanner v4 permite la mención productiva solo en `src/platform/mumble-v2-contract.ts`; docs/tests quedan no productivos. El guard AST usa una allowlist recursiva, rechaza imports, asignaciones, updates, tagged templates, llamadas, clases, funciones y exports alternativos, y censusa cualquier nuevo fichero que lo nombre/importe. | Un nombre deliberadamente oculto o dependencia nativa indirecta todavía requiere review humana y análisis de artefactos de release. No hay aislamiento frente a código local malicioso. |
| Lectura excesiva de Mumble | Allowlist contractual de `uiVersion`, `uiTick`, `context_len` y `context.mapId`; el frame exacto lleva solo versión/nonce/secuencia/tick/map/activity. Tests rechazan identidad, coordenadas y PID en la proyección. | El futuro helper nativo debe demostrar por revisión y QA que su implementación real respeta offsets/tamaños y no copia el buffer completo a otra superficie. |
| Tearing o muestra híbrida con tick estable | H8.2 usa loads `uint32` alineados y exige dos candidatos completos idénticos; hasta ocho pares distintos terminan en `unstable_sample`. Fixtures inyectan el mismo tick con map distinto y tearing de word. | No es un seqlock: el writer no coopera y dos híbridos idénticos podrían aceptarse. La señal sigue shadow/no autoritativa y la QA real debe medir el comportamiento. |
| Spike adoptado accidentalmente como producción | Vive solo bajo `spikes/`, no tiene imports desde `src`, no entra en el ZIP de tres archivos y la documentación prohíbe cablearlo o ampliar la allowlist. Un guard censusa sus ficheros exactos y capacidades. | Un cambio futuro de packaging o un copiado manual exige nueva revisión; el scanner actual no trata `spikes/` como fuente productiva. |
| Deriva del helper H8.3 | El ADR fija Rust, raíz `native/mumble-helper`, target MSVC x64, CRT estático y un único PE `tyrian-mumble-helper.exe`. Fuera de docs/examples/fixtures/tests, el guard censa globalmente fuente Rust/C#, configuración Cargo/toolchain exacta, señales helper por path y cualquier prefijo `mumble-link`/`mumble_link`/`MumbleLink` por contenido, además de outputs EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA y symlinks sin seguirlos. Un `bridge` genérico sin esas señales no entra en scope. | La cadena Rust, una dependencia o un error de layout/rollover todavía pueden ampliar la superficie o copiar más memoria que H8.1. C# NativeAOT no requiere un runtime instalado, pero tendría riesgos propios de trimming/AOT, runtime mínimo embebido, toolchain y símbolos. |
| Cadena de suministro y paquete separado | El contrato futuro cierra el ZIP a EXE, manifest del helper, checksums, licencia y avisos de terceros; el ZIP del plugin no lo incluye. La salida prevista es un único PE con CRT estático. | No existe todavía pipeline que demuestre reproducibilidad, SBOM/licencias, hashes ni ausencia de DLL/runtime auxiliar. Un ZIP declarativo no sustituye el análisis de bytes. |
| Binario sin firma o identidad falsa | Authenticode es la firma prevista, `status=pending` y `releaseAllowed:false`; la firma sigue pendiente y no se puede presentar el helper como firmado o publicable. | Incluso tras firmar, SmartScreen/reputación, expiración, custodia de claves y validación bajo Proton/CrossOver necesitan política y QA específicas. |
| Cliente local falso, replay o frame corrupto | Solo loopback numérico, puerto efímero, nonce de 128 bits mínimo, versión exacta, frame máximo 512 bytes, claves cerradas, `initialSequence:0` y secuencia estrictamente creciente. Cualquier desviación se descarta y la API v1 continúa. | Otro proceso con los mismos privilegios podría observar o alterar el canal; el nonce reduce conexión accidental, no sustituye el límite del modelo frente a malware local. |
| Señal local interpretada como verdad o acción | Defaults `enabled:false`, `shadow`, `on_when_armed`, API v1 autoritativa y confirmación humana obligatoria. `activity` solo expresa avance/stall del tick y nunca movimiento/combate/farmeo. | Una fase posterior podría introducir sesgo en ventanas/propuestas; salir de shadow requiere decisión humana, métricas separadas y QA por plataforma. |
| Raw o frame retenido/logueado | Contrato `retention:none`; no se admite settings, IndexedDB, Vault, log ni telemetría para raw/frames. Caída/reinicio invalida nonce, secuencia y estado derivado. | Dumps del proceso o herramientas del SO quedan fuera del threat model local actual. |
| Datos remotos o IndexedDB corruptos | Parsers y esquemas exactos fallan cerrados ante tipos, campos o valores inesperados. | La disponibilidad puede degradarse y requerir limpieza local; no hay reparación automática de todos los stores. |
| Sobrescritura de contenido del vault | Rutas normalizadas, ownership explícito, manifest/bloques con hash y escritura controlada; contenido ajeno no se adopta silenciosamente. | El usuario u otro plugin pueden editar/copiar notas con información sensible; Sync de Obsidian queda fuera del control del proyecto. |
| Sync, soporte o exportación futuros | No están implementados; los tests descubren nombres comunes y el contrato exige revisión explícita. | Un módulo con nombre atípico o fuera del árbol inspeccionado exige review manual. Antes de Sync deben definirse autenticación, cifrado, retención, revocación, residencia y metadatos. |

## Controles ejecutables

- `npm run security:scan` ejecuta el scanner v4 sin red sobre el corpus Git relevante; el empaquetador invoca además su entrada cerrada sobre `manifest.json`, `main.js` y `styles.css` ya staged.
- `npm run test:security-scan` prueba cada regla, corpus/encodings, falsos positivos, redacción, el bundle final normalmente ignorado y controles de sabotaje.
- `src/platform/mumble-v2-contract-architecture.test.ts` fija el único artefacto permitido, sus exports y ausencia de runtime. Sus sabotajes cubren inyección, proceso, memoria, logs, tráfico, entrada, automatización, red, persistencia, temporizadores y helpers fuera del censo.
- `scripts/h8-native-decision-contract.mjs` fija el schema exacto del ADR H8.3, su reflejo documental y
  la ausencia actual del scope nativo/helper mediante censo positivo. Parsea y hashea el bloque JSON,
  el sobre autoritativo del ADR, el fragmento H8.3 y el `PLATFORM_POLICY.md` completo canonizado. La suite causal sabotea lenguaje,
  target, CRT, PE único, paquete, matriz/QA, prosa contradictoria, unsupported, firma, riesgos y
  reopen triggers, y conserva fuente de ejemplo legítima fuera de producción salvo outputs/symlinks.
- `npm run test:support-contract` valida el issue form con esquema top-level exacto, allowlist de
  IDs/tipos y SHA-256 semántico canónico del formulario completo —nombre, descripción, título,
  prompts y atributos visibles—, además de un único
  Markdown seguro, diagnóstico opcional, confirmación de redacción, bloqueo de issues en blanco, guía
  de permisos y acciones de sesión. Sus sabotajes quitan o añaden campos, introducen prompts hostiles,
  vuelven obligatorios datos opcionales, eliminan categorías/opciones o erosionan la guía.
- `src/platform/mumble-v2-spike-architecture.test.ts` censusa el spike, core/wrapper, stub y script;
  fija una sola apertura y un solo map read-only y rechaza permisos write —también `0x0002`—,
  Toolhelp/proceso/memoria, sumideros alternativos, datos privados, red, persistencia, logs,
  ejecución de Wine/CrossOver, copias fuera del temporal o una allowlist productiva ampliada.
  El extractor léxico ignora decoys en comentarios/literales y el host script se acepta únicamente
  bajo su contrato positivo byte a byte con destinos temporales exactos.
  Un censo positivo independiente fija todas las directivas del wrapper y rechaza `#undef`, macros
  o aliases que redefinan permisos, nombre del mapping o tamaño del view.
  La lane confirma además el resultado de `cc -E -P` con el mismo stub: hashes contractuales y
  sabotajes desde ambos headers, digraphs `%:` y line-splicing evitan depender solo del texto fuente.
- `npm run test:h8-crossover-spike` compila el decoder normal y con ASan/UBSan, syntax-checkea el
  wrapper, valida su expansión real `cc -E -P`, ejecuta fixtures corruptos/interleaved y demuestra rojos causales para offset, 5.460,
  512, ocho pares y `9007199254740991`. No sustituye la ejecución del PE dentro de CrossOver.
- `src/security-boundary.test.ts` ejecuta el flujo real de credencial hasta la única salida permitida, invoca la persistencia real de settings y descubre recursivamente fronteras presentes y futuras.
- Los tests de `session-runtime-store`, `session-detection-quality-store` y `session-note-writer` demuestran que los sumideros productivos rechazan capacidad de credencial antes de escribir.
- `npm run check` incluye lint, tests, preflights, pruebas del scanner, scanner, TypeScript y build. CI ejecuta ese mismo gate en Node 22.20.0 y 22.x.

Los controles no requieren red y son guardarraíles de regresión. No reemplazan revisión de diseño, pruebas dentro de Obsidian, auditoría de dependencias/CVEs, análisis de historia Git ni pruebas frente a un atacante con acceso local equivalente.

## Privacidad y RGPD

El código inspeccionado no crea un responsable/encargado remoto del proyecto: no hay backend propio, analítica remota ni exportación de soporte. Por eso no se puede afirmar ni exigir residencia UE/DPA a un servicio del proyecto inexistente. La relación, residencia y términos de la API externa de GW2 y de servicios opcionales de Obsidian no se han verificado en este lote.

Los datos de cuenta, personaje y sesiones son datos personales o seudónimos cuando pueden vincularse al usuario. El usuario puede inspeccionar/exportar/borrar directamente sus notas y descartar la sesión runtime, pero el producto **no ofrece todavía borrado y exportación integrales** de detection-quality, coordination y confirmation-queue. Tampoco automatiza la eliminación de backups o copias creadas por Obsidian/Sync. No debe declararse cumplimiento pleno de autoservicio de acceso, portabilidad o supresión hasta cubrir esos stores y documentar el procedimiento.

## Verificaciones no cubiertas

- No se verificaron políticas, residencia, DPA ni comportamiento de Obsidian Sync o de la API de GW2.
- No se ejecutó auditoría CVE ni análisis de dependencias transitivas; el scanner de secretos no cumple esa función.
- No se validó borrado físico del navegador/IndexedDB, copias de seguridad, swap ni memoria del proceso.
- No se probaron malware local, plugins hostiles, manipulación deliberadamente ofuscada ni recuperación forense.
