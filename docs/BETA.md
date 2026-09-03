# Canal beta y paquete de release

## Estado actual

La última beta **publicada** sigue siendo la `0.1.21`. La `0.1.22` está integrada en `main` y pasa el
gate completo (22 pasos en verde, 2.589 tests en 193 ficheros, `tsc --noEmit` exit 0), pero **aún no
está publicada**: su tag, sus runs de CI y sus assets no existen hasta que se publique desde el
commit de release, y hasta entonces esta sección no puede citarlos.

`0.1.22` añade aviso de drop valioso encendido de serie sin interruptores (cinco canales a la vez:
toast, notificación del sistema con urgencia critical, sonido embebido, webhook opcional y cola
durable), señal de venta del saco 36038 sembrada desde datawars2 (tercera salida en el kernel,
recomendación hold dentro de temporada), y sesiones de farmeo que dejan de invalidarse solo por lo
que se gasta (ahora dan estimada con banda en lugar de contaminada). La instalación, primera carga
y actualización dentro de Obsidian, así como la comprobación con datos reales de Guild Wars 2,
siguen pendientes de QA humana. Una release publicada o un artifact verde de CI no demuestran esos
flujos.

Antes de probar, sigue el onboarding del [README](../README.md), crea una clave con la
[guía de permisos](API-KEY.md) y conserva a mano el contrato de
[soporte y redacción](SUPPORT.md). Estos documentos describen el producto actual; no sustituyen la
matriz humana ni acreditan la QA pendiente.

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

La publicación manual debe usar también `manifest.version` como nombre exacto de la GitHub Release.
Después de publicarla, valida los metadatos que sirve GitHub y el conjunto exacto de cinco assets:

```sh
gh release view "<versión>" --json tagName,name,isDraft,assets \
  | npm run release:brat-verify -- --release-json -
```

El verificador rechaza un nombre o tag distinto de `manifest.version`, una release draft y cualquier
asset ausente, duplicado, extra, no terminado de subir o vacío. GitHub puede tardar entre 5 y 15
minutos en reflejar una release a BRAT. Hasta comprobar instalación y carga desde BRAT en Obsidian
real, la formulación correcta es «canal publicado; instalación/runtime pendiente».

Referencias del contrato:

- [Cómo Obsidian descarga plugins](https://github.com/obsidianmd/obsidian-releases/blob/master/README.md#how-community-plugins-are-pulled)
- [Guía de BRAT para desarrolladores](https://tfthacker.com/brat-developers)
- [`versions.json` en la documentación de Obsidian](https://docs.obsidian.md/Reference/Versions)

## QA manual desde un artifact de rama (solo para desarrolladores)

Esta vía existe para probar un commit concreto que todavía no tiene release, y exige el repositorio
clonado, Node.js 22 y un CLI `obsidian` capaz de evaluar en la instancia viva. Quien solo quiera
instalar o actualizar el plugin usa BRAT: el [README](../README.md#install-the-beta) tiene el
procedimiento completo y no necesita nada de esto.

1. Descarga el artifact de CI correspondiente al SHA que se va a probar.
2. Comprueba que el artifact contiene `tyrian-companion-<versión>.zip`, su `.sha256` e
   `install-beta.mjs`. Con Obsidian completamente cerrado, ejecuta desde el directorio del
   artifact:

   ```sh
   node install-beta.mjs install \
     --vault "/ruta/a/una-bóveda-desechable" \
     --archive "tyrian-companion-<versión>.zip" \
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
   objeto de plugin cargado. Ese `obsidian` es un CLI externo que el script espera en el `PATH`; si
   se llama de otra forma, indícalo con `--obsidian-cli <ruta>`. Sin ese CLI el preflight no puede
   ejecutarse y la QA se registra como pendiente, no como fallida.
   La QA de instalación o actualización no es válida sin `PASS`, incluso si
   la versión en disco ya es la esperada. Un `runtime-version-mismatch` exige recargar el plugin o
   reiniciar Obsidian y repetir el preflight. En una instalación desde artifact, usa la copia del
   script correspondiente al mismo commit; el script no forma parte de los tres assets del plugin.

La evidencia de QA debe contener versión, SHA/checksum, plataforma, versión de Obsidian, origen de
instalación, modo de detección, fase y resultado. No se adjuntan claves, identidad de cuenta o
personaje, rutas absolutas, inventario/snapshots crudos, IndexedDB, notas completas ni logs o capturas
sin redactar. Usa el [formato de soporte seguro](SUPPORT.md) también para una prueba satisfactoria.

La release `0.1.19` incorpora el journal local H7.13 para preparar esa evidencia, pero publicarlo no
acredita el piloto. Antes de H7.7 todavía hay que ejecutar el dry run instrumentado en
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

La release pública `0.1.19` cumple el contrato de BRAT: el tag coincide con `manifest.version` y
adjunta `manifest.json`, `main.js` y `styles.css` como assets individuales. El ZIP reproducible puede
usarse para instalación manual y su SHA-256 es
`2e816cb9d25a5633645ddfc9c2824677477f9e0aa8f743ab5684a465a9fcbc40`; no sustituye los tres assets
que descarga BRAT.

Para instalarla con BRAT, añade `fodaveg/tyrian-companion` y selecciona la versión `0.1.19`. Antes de
dar por validada una plataforma se debe descargar de nuevo la release publicada, verificar su SHA y
sus tres assets, instalarla con BRAT en una bóveda desechable y probar una actualización real desde
una versión anterior. Hasta completar esa evidencia, la formulación correcta es «canal BRAT
publicado; instalación y actualización pendientes de QA humana».
