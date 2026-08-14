# Canal beta y paquete de release

## Estado actual

La automatización prepara candidatos verificables, pero **no existe todavía una release publicada ni
un canal BRAT activo**. La instalación, primera carga y actualización dentro de Obsidian siguen
pendientes de QA humana en Linux, macOS y Windows. Un artifact verde de CI no demuestra esos flujos.

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

En CI, todo push de rama o tag ejecuta primero el gate completo y después sube `.release/` como artifact
temporal. Un tag solo es aceptado cuando coincide **exactamente** con `manifest.version`, sin prefijo
`v`. La pipeline tiene permisos `contents: read` y no crea tags, GitHub Releases ni publicaciones.

Referencias del contrato:

- [Cómo Obsidian descarga plugins](https://github.com/obsidianmd/obsidian-releases/blob/master/README.md#how-community-plugins-are-pulled)
- [Guía de BRAT para desarrolladores](https://tfthacker.com/brat-developers)
- [`versions.json` en la documentación de Obsidian](https://docs.obsidian.md/Reference/Versions)

## QA manual desde un artifact de rama

1. Descarga el artifact de CI correspondiente al SHA que se va a probar.
2. Verifica el hash antes de extraer:

   ```sh
   cd <directorio-descargado-del-artifact>
   shasum -a 256 -c tyrian-companion-0.1.0.zip.sha256
   ```

   En GNU/Linux puede usarse `sha256sum -c`. En Windows, compara el valor de
   `certutil -hashfile tyrian-companion-0.1.0.zip SHA256` con el fichero `.sha256`.

3. Extrae el ZIP y confirma que contiene únicamente `manifest.json`, `main.js` y `styles.css`.
4. Con Obsidian cerrado, copia esos tres archivos a
   `<vault>/.obsidian/plugins/tyrian-companion/`; conserva una copia recuperable de cualquier versión
   anterior.
5. Abre Obsidian, activa el plugin y ejecuta la matriz manual aplicable. Registra por separado
   instalación, carga, conexión, sesión, recovery, escritura segura y actualización.

Si el hash, el contenido o la versión no coinciden, no se instala el candidato. La QA debe usar una
bóveda desechable; la bóveda canónica queda fuera de este procedimiento.

## Activación futura de BRAT

BRAT solo se habilitará después de que el release owner cree una GitHub Release —opcionalmente marcada
como prerelease— cuyo tag sea idéntico a `manifest.version` y adjunte como assets individuales
`manifest.json`, `main.js` y `styles.css`. El ZIP puede adjuntarse además para instalación manual, pero
no sustituye esos tres assets.

Antes de anunciar el canal se debe descargar de nuevo la release publicada, verificar su SHA y sus tres
assets, instalarla con BRAT en una bóveda desechable y probar una actualización real desde una versión
anterior. Hasta completar esa evidencia, la formulación correcta es «canal preparado; publicación,
instalación y actualización pendientes».
