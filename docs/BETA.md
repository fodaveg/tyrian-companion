# Canal beta y paquete de release

## Estado actual

[0.6.22 está publicada](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.22) como release
normal, sin draft ni prerelease: **canal publicado; instalación/runtime pendiente**. Nombre de
GitHub Release, tag y `manifest.version` son exactamente `0.6.22`, con ocho assets reales subidos,
no vacíos y verificados. El SHA del tag, gates y workflows están en [ESTADO](ESTADO.md).
`manifest.json` por sí solo identifica un checkout o instalación; no demuestra carga correcta.
Para volver a verificar los metadatos de la release:

```sh
version="$(node -p "require('./manifest.json').version")"
gh release view "$version" --json tagName,name,isDraft,assets
```

El contrato BRAT (`npm run release:brat-verify`, ver más abajo) debe dar `PASS` con los ocho assets
exactos contra esa salida. El detalle línea a línea de cada release ya cerrada —tag, commit, SHAs de
los tres ficheros, runs de CI y gate local— vive en el [changelog](CHANGELOG.md) y, para las más
antiguas, en [`docs/historico/ESTADO-lotes-cerrados.md`](historico/ESTADO-lotes-cerrados.md).

La instalación, primera carga y actualización dentro de Obsidian, así como la comprobación con datos
reales de Guild Wars 2, siguen pendientes de QA humana salvo que `docs/ESTADO.md` registre lo
contrario para la release vigente. Una release publicada o un artifact verde de CI no demuestran esos
flujos por sí solos.

Antes de probar, sigue el onboarding del [README](../README.md) y el contrato de
[soporte y redacción](SUPPORT.md). **Las sesiones live Nexus se prueban sin clave API.** Solo las
acciones manuales de inventario/cartera y la comprobación explícita de conexión necesitan una clave
con la [guía de permisos](API-KEY.md); catálogo y precios públicos no la requieren. No usar una
sincronización API como sustituto de una fuente live ausente.

### Release 0.5.0: alcance y QA pendientes

La captura propia se rige por [SPEC-live-loot](SPEC-live-loot.md). La release incluye lector/
transporte, consumidor de sesiones, journal/notas, avisos y presentación. Gate del árbol publicado,
CI y assets servidos están acreditados en [ESTADO](ESTADO.md); la QA real sigue pendiente. Esos
checks no demuestran instalación ni ejecución en el host o el juego.

La release 0.5.0 integra plantilla de build declarada y comparación live separada del historial
API: parser, captura inmutable, notas, editor y comparador cuentan con revisión independiente. Los
checks de cada lote no sustituyen el gate conjunto ni la QA real. En QA se comprueban captura
inmutable al solicitar el inicio, entrada inválida visible y mínimo de dos completas por grupo;
una plantilla declarada no acredita build equipada ni equipo/stats.

La entrega 0.5.0 es una release **normal, no prerelease**, disponible para el instalador del Hebra
canónico. Hebra consume los tres assets de plugin externo de esa misma versión; no se
infiere carga correcta de la versión que figure en disco. Nexus no ofrece autoactualización para
este addon: con GW2 cerrado, sustituir manualmente la DLL por el artifact elegido y comprobar la
versión cargada al reabrir. Publicar Companion no sustituye la DLL local de Nexus.

Icono en Hebra (desde la 0.6.11; con borde desde la 0.6.12; desde la 0.6.15, el dibujo a color con un solo contorno; desde la 0.6.17, recorte nuevo desde la acuarela con un borde negro): `hebra.json` lleva el monstruo como `iconImage` (PNG de 128 px versionado en
`assets/hebra-icon.png`, comprobado en el empaquetado contra los límites de Hebra) y `sword` como respaldo en
`icon`. Una Hebra anterior a ese campo lo ignora y pinta la espada; Obsidian sigue con la espada.

La matriz vigente de sesiones requiere Nexus en Fedora/GE-Proton y Windows. Desde el 8 oct 2026 el
addon de Nexus es obligatorio para las funciones en vivo en todas las plataformas y el módulo de Blish HUD
queda congelado en su 0.5.0, sin funciones nuevas; que Windows nativo funcione con Nexus es una expectativa
sin probar (el lector solo está probado en Fedora con Proton). Blish por sí solo no aporta objetos; su soporte
en Fedora no está acreditado. La sesión abarca la conexión al juego y diez minutos de gracia,
independientemente de los huecos de lectura. El addon 0.6.0 lee la cartera (verificado en el juego:
55 monedas cubiertas); el lector nativo sigue sin cubrir MF verificado ni huecos de bolsas: se muestran desconocidos, nunca cero ni inferidos mediante
consultas privadas automáticas. La preparación MF manual conserva su procedencia.

La [matriz live de QA](QA-MVP.md) exige arranque, reapertura, adquisición, huecos, cierre, guardado,
exportación y avisos en clientes reales, además de instalación/actualización BRAT y carga Hebra.
Todo ello permanece pendiente. Las matrices históricas de sesiones API y del helper H8 conservan
su evidencia de compatibilidad y sus propios límites; no certifican live1 ni requieren activar H8.
Las condiciones de paquete, ocho assets y verificación BRAT que siguen no cambian.

## Contrato del paquete

`npm run release:package` elimina cualquier `main.js` previo, ejecuta el build de producción y crea
`.release/` desde una lista cerrada:

- `manifest.json`
- `main.js`
- `styles.css`

El comando valida la identidad y versión de `package.json`, `manifest.json` y `versions.json`, exige
archivos regulares no vacíos, escanea los bytes finales contra credenciales y genera un ZIP
determinista con su fichero `.sha256`. Después vuelve a leer el ZIP y comprueba nombres, orden,
metadatos fijos, CRC y contenido exacto. `versions.json` permanece en la raíz del repositorio: Obsidian
lo consulta para resolver compatibilidad histórica, pero BRAT no lo instala como asset de una release.

El mismo comando prepara también Tyrian como plugin externo de Hebra (`docs/SPEC-PLUGINS-EXTERNOS.md`
del repo de Hebra, §3): ejecuta `npm run build:host-esm`, que genera `hebra-main.mjs` (un solo módulo ES
que exporta `activate(api)`, con su guardarraíl: sin `obsidian`, `electron`, `node:*`, `Buffer`,
`process` ni imports sin resolver) y `hebra-styles.css` (`src/host/hebra/tyrian-host.css` y después
`styles.css`), y genera `hebra.json` desde `manifest.json` con la versión del tag sin `v`, el
`sha256` de esos dos ficheros y lo que declara Tyrian para Hebra (API `^1.0.0`, capacidades, hosts y
plataformas). Los tres van a `.release/<id>/` junto a los de Obsidian, pasan el mismo escaneo de
credenciales y se publican como assets, pero no entran en el ZIP, que sigue siendo la instalación de
Obsidian. Son generados: no se commitean (`.gitignore`).

El workflow `ci.yml` ejecuta `check` y `check:guardrails` en cada push de rama o pull request;
en `main` añade los benchmarks existentes. Los jobs del helper nativo solo se ejecutan cuando ese
alcance cambia. Tras los gates prepara el artifact de desarrollo con `release:package` y
`beta:artifact`. Mantiene permisos `contents: read` y no publica releases.

El workflow `release.yml` es propietario de la publicación al hacer push de un tag. Ejecuta su
propio `check`, genera el paquete y exige un plan válido de ocho assets antes de crear la release.
El tag y el título deben coincidir **exactamente** con `manifest.version`, sin prefijo `v`; el cuerpo
procede de la entrada correspondiente del changelog. Solo ese job tiene `contents: write`.
Tras subir los assets verifica el contrato contra los metadatos reales de GitHub.

La sesión de publicación comprueba además los metadatos que sirve GitHub y el conjunto exacto de ocho assets
(`manifest.json`, `main.js`, `styles.css`, el ZIP, su `.sha256`, `hebra.json`, `hebra-main.mjs` y
`hebra-styles.css`):

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

El siguiente piloto H7.13/H7.7 es evidencia y QA del recorrido histórico de detección API; no es la
matriz live1 de 0.5.0 ni autorización para reintroducir sondeo privado en sesiones. H8 conserva
su contrato aislado y sus pendientes propios.

El journal local H7.13, ya publicado desde hace varias releases, prepara esa evidencia, pero
publicarlo no acredita el piloto. Antes de H7.7 todavía hay que ejecutar el dry run instrumentado en
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

Una release solo se declara publicada después de verificar su salida real de GitHub: nombre y tag
coinciden con `manifest.version`, y están completos los ocho assets enumerados arriba. Los tres
assets individuales de Obsidian son `manifest.json`, `main.js` y `styles.css`. El ZIP reproducible puede
usarse para instalación manual; su SHA-256 exacto es el que reporta `npm run release:package` para
esa versión y no sustituye los tres assets que descarga BRAT.

Para instalarla con BRAT, añade `fodaveg/tyrian-companion` y selecciona la versión publicada más
reciente (la que declara `manifest.json`). Antes de
dar por validada una plataforma se debe descargar de nuevo la release publicada, verificar su SHA y
los ocho assets exigidos, instalarla con BRAT en una bóveda desechable y probar una actualización real desde
una versión anterior. Hasta completar esa evidencia, la formulación correcta es «canal BRAT
publicado; instalación y actualización pendientes de QA humana».
