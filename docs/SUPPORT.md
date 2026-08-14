# Soporte y reporte seguro de errores

Tyrian Companion todavía es una beta no publicada. El canal de soporte es el formulario **Bug
report** del repositorio que indique el coordinador de la beta. Si ese repositorio no está disponible,
envía al coordinador solo el mismo conjunto mínimo y redactado; no abras un canal alternativo con más
datos.

## Antes de informar

1. Anota la versión de Tyrian Companion que muestra `manifest.json` y, si procede, el SHA o checksum
   del artifact probado.
2. Anota la versión de Obsidian, el sistema y el entorno real: Linux + Steam/Proton, macOS +
   CrossOver, Windows u otro desktop.
3. Indica el origen de instalación: artifact manual o build local. BRAT no está activo todavía.
4. Indica el modo de detección (`Off/manual`, asistido armado o asistido desarmado) y la fase visible
   de sesión (`idle`, `starting`, `active`, `stopping`, `provisional/review`, `complete` o
   `recovery/error`).
5. Reproduce una vez en una bóveda desechable si es seguro. Describe el comando o botón exacto, el
   resultado esperado y el texto o código de error visible.

No reinstales sobre la bóveda canónica ni borres IndexedDB, notas o assets para “limpiar” el fallo.
Esos pasos destruyen evidencia y pueden convertir un problema recuperable en otro distinto.

## Datos permitidos

Un informe normal debe limitarse a:

- versión del plugin y de Obsidian;
- sistema operativo y runtime de GW2;
- origen del candidato y checksum público del artifact;
- modo de detección y fase de sesión;
- secuencia de acciones, resultado esperado y resultado observado;
- texto de interfaz o código de error, después de revisarlo y redactarlo;
- un extracto mínimo de consola solo si es imprescindible y después de sanear cada línea.

Usa sustituciones inequívocas como `<cuenta-redactada>`, `<personaje-redactado>` y
`<ruta-redactada>`. Una captura debe recortarse y revisarse visualmente antes de adjuntarla; ocultar
una zona con una capa reversible no es una redacción segura.

## Datos prohibidos

No publiques ni envíes en el formulario:

- clave API, token, subtoken, cabeceras `Authorization`, secretos o credenciales de cualquier tipo;
- nombre o ID de cuenta, nombres de personajes, nombre de build o guild;
- ruta absoluta del vault, nombre de usuario del sistema o lista de ficheros personales;
- inventario crudo, snapshots completos, payloads de la API, contenido íntegro de notas o exports;
- dumps de IndexedDB, bases locales, settings completos o un ZIP de `.obsidian`;
- logs sin redactar o consola completa, capturas sin redactar, direcciones IP o identificadores de
  terceros.

No existe todavía un exportador oficial de diagnóstico. Que un dato esté en DevTools no significa que
sea seguro adjuntarlo. Si el problema no puede describirse sin un dato prohibido, detén el reporte y
pide al coordinador un canal privado y un procedimiento específico.

## Si una clave pudo quedar expuesta

Revoca primero la clave en [Applications de ArenaNet](https://account.arena.net/applications), cambia
el secreto seleccionado en Obsidian y vuelve a comprobar la conexión. Después informa de que hubo una
exposición y de cuándo fue revocada, pero nunca copies el valor comprometido. Una edición posterior de
un issue no garantiza que el secreto haya desaparecido de notificaciones, caches o historial.

## Criterio de cierre

Un arreglo técnico no demuestra la instalación o el comportamiento real. El reporte solo puede
cerrarse como validado en una plataforma cuando se ha repetido el flujo exacto sobre el artifact del
SHA corregido. La carga, actualización, Steam/Proton, CrossOver y Windows conservan evidencias de QA
separadas.
