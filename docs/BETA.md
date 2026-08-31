# Canal beta y paquete de release

## Estado actual

La beta pública actual es
[`0.1.17`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.17), tag y commit
`214362e2e7bc037befdaf81ac7a201ce9aaab37c`. Los runs de CI de `main` `33311829149` y del tag
`33311981029` terminaron en verde. La release adjunta exactamente `manifest.json`, `main.js`,
`styles.css`, `tyrian-companion-0.1.17.zip` y `tyrian-companion-0.1.17.zip.sha256`, por lo que el
canal BRAT está publicado. El ZIP tiene SHA-256
`dd06a408b771d9fc4b2bb76ff34d31740ea099d0accb24ac20e3cc4976f99386`. La instalación, primera
carga y actualización dentro de Obsidian, así como la comprobación con datos reales de Guild Wars 2,
siguen pendientes de QA humana. Una release publicada o un artifact verde de CI no demuestran esos
flujos.

`0.1.17` corrige el bloqueo de inicialización al restaurar una sesión completada persistida. El
guardarraíl de runtime reproduce ese estado terminal y exige alcanzar el estado listo; los detalles
del log local no forman parte de la evidencia publicada.

Antes de probar, sigue el onboarding del [README](../README.md), crea una clave con la
[guía de permisos](API-KEY.md) y conserva a mano el contrato de
[soporte y redacción](SUPPORT.md). Estos documentos describen el producto actual; no sustituyen la
matriz humana ni convierten el candidato en una release publicada.

## Contrato del paquete

`npm run release:package` elimina cualquier `main.js` previo, ejecuta el build de producción y crea
`.release/` desde una lista cerrada:

- `manifest.json`
- `main.js`
- `styles.css`

El comando valida la identidad y versión de `package.json`, `manifest.json` y `versions.json`, exige
archivos regulares no vacíos, escanea los tres bytes finales contra credenciales y genera un ZIP
determinista con su fichero `.sha256`. Después vuelve a leer el ZIP y comprueba nombres, orden,
metadatos fijos, CRC y contenido exacto. `versions.json` permanece en la raíz del repositorio: Obsidian
lo consulta para resolver compatibilidad histórica, pero BRAT no lo instala como asset de una release.

En CI, todo push de rama o tag ejecuta primero el gate completo, recrea un staging temporal exacto y
después sube únicamente el ZIP, su `.sha256` e `install-beta.mjs`. El upload ocurre inmediatamente tras
sellar y enumerar esos tres ficheros: identidad del directorio, bytes persistidos y pareja
checksum/ZIP deben seguir coincidiendo con las fuentes capturadas. No se sube el directorio de build
interno ni se admite otra variante de la acción de upload en ese job.
Un tag solo es aceptado cuando coincide **exactamente** con `manifest.version`, sin prefijo `v`. La
pipeline tiene permisos `contents: read` y no crea tags, GitHub Releases ni publicaciones.

Referencias del contrato:

- [Cómo Obsidian descarga plugins](https://github.com/obsidianmd/obsidian-releases/blob/master/README.md#how-community-plugins-are-pulled)
- [Guía de BRAT para desarrolladores](https://tfthacker.com/brat-developers)
- [`versions.json` en la documentación de Obsidian](https://docs.obsidian.md/Reference/Versions)

## QA manual desde un artifact de rama

1. Descarga el artifact de CI correspondiente al SHA que se va a probar.
2. Comprueba que el artifact contiene `tyrian-companion-<versión>.zip`, su `.sha256` e
   `install-beta.mjs`. Con Obsidian completamente cerrado, ejecuta desde el directorio del
   artifact:

   ```sh
   node install-beta.mjs install \
     --vault "/ruta/a/una-bóveda-desechable" \
     --archive "tyrian-companion-0.1.17.zip" \
     --confirm-obsidian-closed
   ```

   Node.js 22 solo es necesario para este instalador beta guardado. Si la bóveda usa deliberadamente
   otro directorio de configuración, añade `--config-dir <nombre-seguro>`.

3. El instalador relee ZIP y checksum como ficheros regulares, verifica SHA-256, cabeceras, CRC,
   nombres, manifest e identidad y rechaza una versión igual o anterior. Escribe únicamente
   `manifest.json`, `main.js` y `styles.css` bajo el plugin; conserva `data.json`, otros ficheros del
   plugin y el resto de la bóveda. Un lock exclusivo serializa instaladores cooperativos; antes de
   cada swap se revalidan versión, hashes e identidad de directorios. Mientras la autoridad de ruta
   permanece intacta, un fallo de escritura, swap o cierre del lock restaura la versión anterior desde
   los bytes originales capturados —no desde un backup mutable— y limpia temporales; el éxito solo se
   comunica después de cerrar la transacción y retirar el lock;
   si cambia un directorio, se detiene sin tocar el sustituto y exige inspección manual. No acepta
   symlinks en las fronteras administradas.
4. Abre Obsidian, activa el plugin y ejecuta la matriz manual aplicable. Registra por separado
   instalación, carga, conexión, sesión, recovery, escritura segura y actualización.

   Antes de aceptar la carga o actualización, con la bóveda abierta y el plugin activado ejecuta:

   ```sh
   node scripts/verify-beta-runtime.mjs --vault "/ruta/a/la-bóveda-probada"
   ```

   El preflight lee `manifest.json` del plugin instalado y obtiene desde la instancia viva, mediante
   `obsidian eval`, la bóveda efectiva, el estado activado, el manifest registrado y la versión del
   objeto de plugin cargado. La QA de instalación o actualización no es válida sin `PASS`, incluso si
   la versión en disco ya es la esperada. Un `runtime-version-mismatch` exige recargar el plugin o
   reiniciar Obsidian y repetir el preflight. En una instalación desde artifact, usa la copia del
   script correspondiente al mismo commit; el script no forma parte de los tres assets del plugin.

La evidencia de QA debe contener versión, SHA/checksum, plataforma, versión de Obsidian, origen de
instalación, modo de detección, fase y resultado. No se adjuntan claves, identidad de cuenta o
personaje, rutas absolutas, inventario/snapshots crudos, IndexedDB, notas completas ni logs o capturas
sin redactar. Usa el [formato de soporte seguro](SUPPORT.md) también para una prueba satisfactoria.

La rama candidata incorpora el journal local H7.13 para preparar esa evidencia, pero no forma parte
de la release `0.1.17`. Antes del piloto H7.7 todavía hay que ejecutar el dry run instrumentado en
Linux/Steam/Proton, macOS/CrossOver y Windows beta, revisar la muestra de cada plataforma y confirmar
que limpiar/desactivar funciona dentro de Obsidian real. El dry run debe incluir además una revisión
que quede `stale` tras mutación concurrente y tras desactivar/reactivar el mismo perfil, un fallo de
workflow seguido de reintento/exclusión y una
recovery clasificada antes de recargar; ninguna de esas rutas puede bloquear la acción de sesión ni
degradar el journal. Un gate automatizado o una exportación local no acreditan por sí solos esa QA ni
autorizan una release.

El checksum evita una alteración accidental, pero no autentica el origen si alguien sustituye juntos
ZIP y `.sha256`: el ancla de confianza es el artifact del run y SHA de CI que el release owner haya
señalado. Si el origen, hash, contenido o versión no coinciden, no se instala el candidato. La QA debe
usar una bóveda desechable; la bóveda canónica queda fuera de este procedimiento. El flag de cierre es
una confirmación humana: el script no intenta inspeccionar ni abrir Obsidian.

## Canal BRAT publicado

La release pública `0.1.17` cumple el contrato de BRAT: el tag coincide con `manifest.version` y
adjunta `manifest.json`, `main.js` y `styles.css` como assets individuales. El ZIP reproducible puede
usarse para instalación manual y su SHA-256 es
`dd06a408b771d9fc4b2bb76ff34d31740ea099d0accb24ac20e3cc4976f99386`; no sustituye los tres assets
que descarga BRAT.

Para instalarla con BRAT, añade `fodaveg/tyrian-companion` y selecciona la versión `0.1.17`. Antes de
dar por validada una plataforma se debe descargar de nuevo la release publicada, verificar su SHA y
sus tres assets, instalarla con BRAT en una bóveda desechable y probar una actualización real desde
una versión anterior. Hasta completar esa evidencia, la formulación correcta es «canal BRAT
publicado; instalación y actualización pendientes de QA humana».
