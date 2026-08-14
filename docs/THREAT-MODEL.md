# Modelo de amenazas

## Alcance y supuestos

Tyrian Companion es un plugin local de Obsidian para escritorio. Consulta la API oficial de Guild Wars 2 (GW2), escribe notas y assets en la bóveda y mantiene estado operativo en IndexedDB. No tiene backend propio, Sync propio, analítica remota, telemetría remota, exportación de soporte, automatización de cuenta ni integración Mumble. Sí existe telemetría **local** de calidad de detección para poder revisar cómo se propuso o confirmó una sesión.

Obsidian, sus servicios opcionales de Sync, el sistema operativo, la API de GW2 y cualquier otro plugin instalado son fronteras externas. El modelo protege contra filtraciones accidentales dentro del código y las superficies implementadas. No promete confidencialidad frente a malware local, un plugin con privilegios equivalentes, una bóveda o cuenta ya comprometida ni un paquete de desarrollo malicioso.

## Flujos de red y credencial

- El token GW2 se obtiene de `SecretStorage` solo al ejecutar una operación que lo necesita. La configuración persistida guarda el **nombre de la entrada**, no el valor del token.
- Toda petición autenticada construida por `GuildWars2Client` va exclusivamente a `https://api.guildwars2.com/v2/...`. El constructor no permite sustituir ese host. La cabecera de autorización se añade después de validar que la ruta es relativa.
- La validación consulta `/v2/tokeninfo`; su identificador, nombre y scopes se materializan transitoriamente al parsear la respuesta. El estado de conexión expuesto al resto del plugin conserva nombre y scopes, pero no el identificador del token ni el token crudo.
- Catálogos y precios públicos también proceden de la API oficial de GW2 y no llevan la cabecera de autorización.
- No hay endpoints del proyecto, subida de diagnósticos, analítica remota ni tráfico Mumble. Cualquiera de esas superficies futuras exige reabrir este modelo antes de implementarse.

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
| Puntero de assets gestionados | Identidad hash de la bóveda, raíz, generación y estado | Persiste para poder actualizar o retirar assets gestionados. No contiene token; la raíz sí puede revelar estructura local a quien ya lea el almacenamiento del plugin. |
| Notas de sesión en la bóveda | Personaje/profesión/build, tiempos, economía, resultados y referencias estables SHA-256 de cuenta/sesión | Se conservan hasta que el usuario las borra. Los hashes estables son seudónimos, no anonimización. Assets gestionados no contienen datos de cuenta. |

Los snapshots completos permiten comparar el antes y el después, pero elevan el impacto de acceso local no autorizado. La implementación minimiza campos en cada parser y no guarda la credencial; aun así, el usuario debe considerar la bóveda y el perfil de Obsidian datos personales locales.

## Amenazas y controles

| Amenaza | Control actual | Riesgo residual |
| --- | --- | --- |
| Token persistido o enviado al host equivocado | `SecretStorage`, migración de settings, operación efímera y host HTTPS oficial no inyectable. El test de frontera ejecuta el cliente y transporte reales y exige host, protocolo y cabecera exactos. | Código nuevo podría crear otro cliente HTTP o leer el secreto fuera del flujo revisado. |
| Token en runtime, stores o notas | Validadores exactos en fronteras de persistencia; pruebas productivas invocan `save`, `saveData` y el writer real con un centinela y exigen rechazo antes de escribir. Descubrimiento recursivo revisa stores/writers nuevos. | El guard es una defensa de regresión, no aislamiento frente a código local malicioso u ofuscado. |
| Fuga por errores, logs o soporte | `HttpTransportError` sanea respuestas. No se admite `console.*` ni logger/telemetry remotos en fuente productiva; no existe exportador de soporte. Rutas futuras con nombres de soporte/export/share/backup/report exigen allowlist revisada. | Un nombre no convencional o un sistema fuera de `src` requiere revisión humana. |
| Secreto o credencial real en repositorio/fixtures | El scanner enumera ficheros tracked y untracked no ignorados mediante Git, normaliza rutas multiplataforma y decodifica texto UTF-8/UTF-16 con o sin BOM. Busca claves privadas, formatos conocidos, asignaciones de credencial, Bearer y fixtures con evidencia de secreto. Solo informa ruta y regla. | Es análisis textual: no cubre historia Git, binarios, cifrado, fragmentación/obfuscación ni todos los formatos futuros. No sustituye un secret scanner histórico del servidor. |
| Scanner que deja de vigilar una regla | La suite tiene un positivo por regla, corpus real por Git, encodings, negativos de falsos positivos, redacción de salida, sabotaje individual de cada regla y un scanner always-green. | Al añadir una regla hay que añadir también su positivo y su sabotaje. |
| Helper Mumble no revisado | Cualquier variante textual productiva (`Mumble`, `MumbleLink`, `mumbleLink`, `mumble_link`, dependencia o manifest) falla en el scanner. | No cubre un nombre deliberadamente oculto ni una dependencia nativa indirecta. Una integración futura debe definir permisos y minimización antes de allowlist. |
| Datos remotos o IndexedDB corruptos | Parsers y esquemas exactos fallan cerrados ante tipos, campos o valores inesperados. | La disponibilidad puede degradarse y requerir limpieza local; no hay reparación automática de todos los stores. |
| Sobrescritura de contenido del vault | Rutas normalizadas, ownership explícito, manifest/bloques con hash y escritura controlada; contenido ajeno no se adopta silenciosamente. | El usuario u otro plugin pueden editar/copiar notas con información sensible; Sync de Obsidian queda fuera del control del proyecto. |
| Sync, soporte o exportación futuros | No están implementados; los tests descubren nombres comunes y el contrato exige revisión explícita. | Un módulo con nombre atípico o fuera del árbol inspeccionado exige review manual. Antes de Sync deben definirse autenticación, cifrado, retención, revocación, residencia y metadatos. |

## Controles ejecutables

- `npm run security:scan` ejecuta el scanner v3 sin red sobre el corpus Git relevante.
- `npm run test:security-scan` prueba cada regla, corpus/encodings, falsos positivos, redacción y controles de sabotaje.
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
