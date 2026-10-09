# Instalar Tyrian Companion en Windows desde cero

Guía para el plugin **0.6.18** y el addon de Nexus **0.8.4**. Las dos versiones ya están
publicadas (plugin 0.6.18 y addon 0.8.4); publicadas no es instaladas ni verificadas en Windows.

## Límites de esta guía

- **Windows nativo no está probado.** Todo lo verificado hasta hoy es Fedora con Proton
  (ver [ESTADO](ESTADO.md)). Esta guía describe el procedimiento previsto. Lo que no se ha podido
  comprobar está en [Lo que aún no está verificado](#10-lo-que-aún-no-está-verificado).
- **Tope de hilos del lector del addon.** Hasta la 0.8.3, el addon se rendía si veía más de
  4096 hilos en todo el sistema, algo que en Windows nativo se supera con pocos programas
  abiertos. Desde la 0.8.4 ese tope es de 65 536 hilos del sistema y el del propio juego es de 256
  (antes 128), y el addon salta un hilo que ya no existe en vez de fallar. Ese arreglo **no se ha
  visto funcionar en Windows**. Si el panel sigue sin datos, mira
  [Problemas frecuentes](#9-problemas-frecuentes).
- **Las sesiones en vivo no necesitan clave de API.** El addon de Nexus sí es obligatorio en todas
  las plataformas desde el 8 oct 2026. El módulo de Blish HUD queda congelado en 0.5.0.
- **Una release publicada no prueba que funcione en tu equipo.** Del plugin y del addon hay canal
  publicado, pero su instalación y su ejecución en un cliente real siguen pendientes.
- **El addon no se actualiza solo.** Para actualizarlo hay que sustituir el fichero `.dll` a mano
  con Guild Wars 2 cerrado.

## 1. Qué necesitas

| Pieza                          | Versión                      | Para qué                            | Dónde se consigue                                                                     |
| ------------------------------ | ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Guild Wars 2                   | La que tengas instalada      | El juego del que se leen las bolsas | Tu copia del juego                                                                    |
| Nexus                          | No consta una versión mínima | Carga el addon dentro del juego     | La web de Raidcore (raidcore.gg)                                                      |
| Addon Tyrian Companion (Nexus) | 0.8.4                        | Lee el juego y pinta el panel       | [Release 0.8.4](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.4) |
| Obsidian (escritorio)          | 1.11.4 o más reciente        | App de notas donde corre el plugin  | La web de Obsidian (obsidian.md)                                                      |
| Hebra (escritorio)             | 0.2.2 para Windows           | App de notas alternativa a Obsidian | Ver [4.2](#42-hebra)                                                                  |
| Plugin Tyrian Companion        | 0.6.18                       | Sesiones, notas y avisos            | [Release 0.6.18](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.18)     |
| BRAT (solo con Obsidian)       | La que publique su autor     | Instala el plugin beta en Obsidian  | [BRAT](https://github.com/TfTHacker/obsidian42-brat)                                  |
| Clave de API de Guild Wars 2   | Opcional                     | Solo inventario y cartera manuales  | [Applications de ArenaNet](https://account.arena.net/applications)                    |

Necesitas Obsidian o Hebra. No hace falta tener las dos.

El addon 0.8.4 pide un plugin que hable su protocolo. La release 0.8.3 pedía Tyrian Companion 0.6.10
o posterior; la 0.6.18 lo cumple. Los requisitos de la 0.8.4 están en las notas de su release.

## 2. Instalar Nexus

1. Cierra Guild Wars 2 por completo.
2. Abre la web de Raidcore (raidcore.gg) y descarga Nexus. Los repositorios de Tyrian Companion no
   describen el instalador de Nexus: sigue las instrucciones de esa web.
3. Abre Guild Wars 2 una vez para comprobar que Nexus arranca. Lo que debe aparecer en pantalla no
   está descrito en los repositorios; si Nexus no se ve, resuélvelo con su soporte antes de seguir.

## 3. Instalar el addon

1. Cierra Guild Wars 2 por completo.
2. Abre la [release 0.8.4 del addon](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.4).
3. Descarga el fichero `.dll` adjunto a la release y el fichero `.sha256` adjunto a la misma
   release. Las releases anteriores los publicaron con el nombre `tyrian_companion_nexus.dll` y
   `tyrian_companion_nexus.dll.sha256`.
4. Calcula la suma de comprobación del `.dll`. En PowerShell, en la carpeta donde lo descargaste:

   ```
   Get-FileHash .\tyrian_companion_nexus.dll -Algorithm SHA256
   ```

5. Abre el fichero `.sha256` con el Bloc de notas. Contiene una línea con el hash seguido del
   nombre del fichero. Comprueba que el hash de la columna `Hash` del paso anterior es idéntico al
   del `.sha256`. PowerShell lo escribe en mayúsculas y el `.sha256` en minúsculas: eso no es una
   diferencia. Si los hashes no coinciden, borra la descarga y vuelve a bajarla.
6. Localiza la carpeta de Guild Wars 2: es la carpeta donde está `Gw2-64.exe`. No hay una ruta
   que valga para todos los equipos. Para encontrarla, haz clic derecho en el acceso directo del
   juego y elige **Abrir ubicación del archivo**, o busca `Gw2-64.exe` en el Explorador.
7. Si no existe, crea la carpeta `addons` dentro de esa carpeta.
8. Copia el `.dll` dentro de `addons`. La ruta del addon es `<carpeta de Guild Wars 2>\addons\`.
9. Abre Guild Wars 2. En la ventana de log de Nexus debe aparecer `Loaded addon`.
10. Comprueba la versión cargada. El addon no escribe su versión en ninguna ventana de opciones ni
    en el panel. Hay dos maneras de saber cuál tienes:
    - Calcula la suma de comprobación del `.dll` de `addons` (paso 4) y compárala con el
      `.sha256` de la release que crees instalada.
    - Busca en el log de Nexus la línea `Tyrian Companion addon v<versión> loading`, que el addon
      escribe al cargarse. Esta línea sale del código y no se ha visto en una pantalla de Windows.

El nombre del fichero dentro de `addons` no figura en el README del addon como requisito. Su
dueño lo tiene instalado como `TyrianCompanion.dll` y Nexus lo carga con ese nombre, así que puedes
dejarlo con el de la release o renombrarlo. Si lo renombras, la comprobación del paso 5 sigue
valiendo, porque se compara el hash y no el nombre.

El addon guarda sus ajustes en `<carpeta de Guild Wars 2>\addons\tyrian_companion_nexus\settings.json`,
una carpeta distinta del `.dll` y que no depende de su nombre.

## 4. Instalar la app de notas

Elige una de las dos. Para la primera prueba usa una bóveda o un espacio de notas desechable.

### 4.1. Obsidian

1. Descarga Obsidian de escritorio desde la web de Obsidian (obsidian.md), versión 1.11.4 o más
   reciente, e instálalo.
2. Crea una bóveda de prueba.

### 4.2. Hebra

Hebra tiene versión para Windows. Según los documentos del repositorio de Hebra
(`docs/windows-actualizador.md` y `docs/ESTADO.md`), la 0.2.2 para Windows se publicó el 8 oct 2026.

1. Descarga el instalador desde `https://app.hebra.pro/repo/hebra-latest-x64-setup.exe`. Es el
   enlace de descarga manual que documenta Hebra. Por confirmar: esta guía no ha descargado ese
   instalador.
2. Ejecuta el instalador. Hebra no lleva firma de código de Windows, así que SmartScreen avisará la
   primera vez. Su documentación dice que se continúa con **Más información** y **Ejecutar de todas
   formas**.
3. Hebra se actualiza desde la propia app: al arrancar pregunta si quieres instalar una versión
   nueva y nunca instala sin preguntar.
4. No hay que instalar nada más en Hebra antes del apartado 5.

## 5. Instalar el plugin

### 5.1. En Obsidian, con BRAT

1. Abre **Settings → Community plugins → Browse** e instala y activa **BRAT**.
2. En BRAT, elige **Add beta plugin**, escribe `fodaveg/tyrian-companion` y selecciona la versión
   publicada **0.6.18**.
3. Vuelve a **Settings → Community plugins** y activa **Tyrian Companion**.
4. Abre la paleta de comandos y ejecuta **Open companion** (en español, **Abrir acompañante**).
5. El plugin usa una sola página de ajustes, sin pestañas. Las filas de mantenimiento están en un
   bloque plegado llamado **Maintenance** (en español, **Mantenimiento**).

### 5.2. En Hebra

Según el documento de plugins externos de Hebra (`docs/SPEC-PLUGINS-EXTERNOS.md`), el plugin se
instala así:

1. Abre los ajustes de Hebra y entra en **Plugins**.
2. Activa **Plugins de terceros**. Está apagado por defecto y Hebra enseña un aviso antes de
   activarlo.
3. Instala Tyrian Companion desde el listado de Hebra o, en **Añadir por URL de GitHub**, escribe
   `fodaveg/tyrian-companion` o `https://github.com/fodaveg/tyrian-companion` y pulsa **Buscar**.
4. Acepta la hoja de consentimiento. Hebra instala la última release normal. No instala
   prereleases, y la 0.6.18 es una release normal.
5. Los ajustes del plugin están en **Plugins**, en la ficha de Tyrian Companion, con el botón
   **Ajustes…**. Es la misma página de ajustes que en Obsidian.

Por confirmar: estos nombres salen del código y de los documentos de Hebra. Nadie los ha visto en
la app de Windows, ni se ha comprobado que esa versión muestre la versión instalada del plugin.

### 5.3. Las Bases

Desde la 0.6.16, el plugin mantiene sus Bases al cargarse: crea las Bases nuevas del paquete,
actualiza las que no editaste y retira `Sessions.base`, `Halloween.base` y `Materials.base` si no
las editaste. Solo lo hace si ya aplicaste los assets gestionados una vez. En una instalación
nueva no crea nada por sí solo: la primera vez, aplica los assets como explica
[Inventario durable y Bases](INVENTORY-VAULT-SYNC.md). Si una Base la editaste tú, el plugin no
escribe ninguna y avisa. Las notas resumen de sesión llevan una columna **Icono** en la Base de
resúmenes.

## 6. Crear la clave de API (opcional)

Las sesiones en vivo no la necesitan. Sí hace falta para el inventario y la cartera manuales y
para el botón de comprobar conexión. Detalle completo en [Clave API de Guild Wars 2](API-KEY.md).

1. Entra en [Applications, en la cuenta de ArenaNet](https://account.arena.net/applications).
2. Crea una clave con un nombre reconocible, por ejemplo `Tyrian Companion beta`.
3. Elige un perfil:

   | Perfil                          | Permisos                                                                    | Qué permite                                                                                  |
   | ------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
   | Solo comprobar conexión         | `account`                                                                   | Valida la clave y muestra la cuenta. No sirve para sesiones.                                 |
   | Mínimo funcional v1             | `account`, `characters`, `inventories`, `builds`                            | Capturas estables, inventario principal, personaje y build activo.                           |
   | Recomendado para la beta actual | Los cuatro anteriores más `wallet`, `tradingpost`, `progression`, `unlocks` | Monedas, entregas, órdenes, historial del bazar y señales de logros, recetas, skins y minis. |

   No hacen falta `guilds`, `pvp` ni `wvw`. Los permisos de una clave no se pueden editar: para
   cambiar el perfil, crea otra clave y revoca la anterior.
4. Copia el valor una sola vez. En Obsidian, guárdalo como secreto y elígelo en los ajustes del
   plugin, en la fila **Clave API** (en inglés, **API key**). El plugin solo guarda el nombre del
   secreto. Por confirmar dónde se guarda en Hebra en Windows: se comprueba abriendo la misma fila
   en los ajustes del plugin.
5. No pegues el valor en una nota, en `data.json`, en un informe ni en una captura.
6. Si quieres validarla, pulsa **Comprobar conexión** (en inglés, **Check connection**) en la vista
   del plugin. Ese botón no está en los ajustes.

## 7. Conectar el plugin y el addon

1. En los ajustes del plugin, activa la fila **Aviso dentro del juego (opcional)** (en inglés,
   **In-game alert (optional)**) y elige **Activadas** (en inglés, **Enabled**). Está apagada por
   defecto. Hasta que la actives, la fila del token no aparece.
2. En la fila **Token del addon** (en inglés, **Addon token**), pulsa **Copiar token** (en inglés,
   **Copy token**). La primera vez crea el token; las siguientes copian el mismo. También puedes
   usar el comando **Copiar token del puente con el juego** (en inglés, **Copy in-game bridge
   token**). El token es distinto de la clave de API. En Hebra la fila está en la misma página
   de ajustes del plugin.
3. El puerto es **47823**. El plugin ya no tiene una fila para cambiarlo: usa el valor guardado,
   que por defecto es 47823. Si el servidor no puede arrancar, el plugin lo dice bajo la fila del
   aviso con el texto «El servidor no pudo iniciarse».
4. En Guild Wars 2, abre las Opciones de Nexus y busca **Tyrian Companion**.
5. Pulsa **Paste** junto al campo **Token**, o haz clic en el campo y pulsa Ctrl+V.
6. Comprueba que el campo **Port** del addon vale 47823.
7. Pulsa **Save**. Si Obsidian o Hebra están abiertos con el plugin activo, la línea de estado
   debe pasar a **Status: connected** en unos segundos.

Avisos:

- No pegues una clave de API de Guild Wars 2 en el campo Token. El addon la rechaza al guardar y
  nunca la envía.
- El token tiene entre 32 y 128 caracteres sin espacios.
- El addon guarda el token en claro en `<carpeta de Guild Wars 2>\addons\tyrian_companion_nexus\settings.json`.
  No compartas ese fichero.

## 8. Primera sesión

1. Abre Obsidian o Hebra con el plugin activo.
2. Abre Guild Wars 2 y entra a jugar. La sesión empieza sola al detectar que estás en el juego.
   No hay botón de inicio.
3. Opcional: en las Opciones de Nexus, activa **Show Labyrinth farming panel / Mostrar panel de
   Laberinto**. Viene oculto por defecto. Nexus también pone en su barra de acceso rápido dos
   iconos del addon: la calabaza muestra u oculta el panel y el monstruo abre las opciones.

Qué debes ver:

- **En las Opciones de Nexus:** la línea de estado en **Status: connected**.
- **En el panel del juego, si lo activaste:**
  - Una columna con las bolsas observadas y su ritmo por hora, y otra con el precio bruto de un
    stack de 250 bolsas.
  - Las líneas de huecos, de Magic Find y de estado.
  - El punto de estado: verde con una sesión en curso, gris si espera sesión, naranja si hay un
    problema que se lee en el tooltip.
- **En la app de notas:**
  - La vista del plugin muestra la fase de la sesión y el tiempo transcurrido.
  - La primera muestra del inventario fija la línea base. No es botín. Las variaciones se
    registran a partir de ahí.
  - Una conexión del addon no demuestra que haya objetos. Mira también la fase y el estado de la
    fuente.
  - Al salir del juego, la sesión se cierra. Si el addon deja de estar presente, hay diez minutos de
    gracia.
  - Al cerrar la sesión se escribe una nota resumen en la carpeta `summaries/` de la **Carpeta de
    salida** del plugin (en inglés, **Output folder**). Por defecto esa carpeta se llama
    `Tyrian Companion` y está dentro de la bóveda en Obsidian o de la biblioteca en Hebra. No es una
    ruta del sistema de Windows. Las notas de sesión completas van a `sessions/<año UTC>/`, dentro
    de la misma carpeta.

## 9. Problemas frecuentes

| Síntoma                                                               | Qué mirar                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La línea de estado no pasa a **connected**                            | Que el puerto sea 47823 en el addon; que el token esté en el campo Token; que Obsidian o Hebra estén abiertos con el plugin activo; que **Aviso dentro del juego** esté activado. Corrige y pulsa **Save** otra vez.                                                                          |
| El addon avisa de que el token fue rechazado y no vuelve a intentarlo | Es lo previsto: no reintenta tras un rechazo hasta que pegues un token nuevo y guardes. Si rotaste el token en el plugin, copia el nuevo con **Copiar token**.                                                                                                                                |
| `version_unsupported`                                                 | El plugin es anterior a lo que pide el addon. Esta guía usa el plugin 0.6.18, que cumple lo que pedía la 0.8.3 (0.6.10 o posterior).                                                                                                                                                          |
| `source_conflict`                                                     | Otra fuente tiene la sesión. El addon vuelve a intentarlo cada 30 segundos. Mientras tanto el panel dice que otra fuente es la dueña.                                                                                                                                                         |
| `unsupported_build`                                                   | El addon solo lee el ejecutable con SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`. Para ver el tuyo, en PowerShell: `Get-FileHash "<carpeta de Guild Wars 2>\Gw2-64.exe" -Algorithm SHA256`. Otro build no se lee hasta que se certifique.                       |
| Panel sin datos, con «no coverage» y el motivo de límites de lectura  | Es el tope de hilos. En las Opciones de Nexus, despliega **Reader diagnostics** y mira **Own threads: N / 256**. Esa línea cuenta los hilos del propio juego. Los hilos del sistema (tope de 65 536 desde la 0.8.4) no aparecen en pantalla. Con la 0.8.3 o anterior, el tope era 4096 y 128. |
| Nexus registra `Failed LoadLibrary` con `Error Code 126`              | El DLL no carga sus dependencias. Copia de nuevo el `.dll` de la release y verifica su SHA-256. El `.dll` de la release está enlazado para no necesitar librerías externas. Si persiste, no está resuelto.                                                                                    |
| Obsidian o Hebra no se abren solos al arrancar el juego               | En Windows nativo el addon solo los abre si la app registró su esquema `obsidian://` o `hebra://` al instalarse. Si no, no hace nada a propósito. Abre la app a mano. La opción se desactiva en las Opciones de Nexus, en **Open Obsidian or Hebra automatically when the game starts**.      |
| El `.dll` instalado es antiguo                                        | El addon no se actualiza solo. Con el juego cerrado, sustituye el `.dll` y comprueba `Loaded addon` al abrir el juego.                                                                                                                                                                        |
| BRAT no ofrece la versión 0.6.18                                      | GitHub puede tardar entre 5 y 15 minutos en servir una release. Usa **Check for updates** en BRAT.                                                                                                                                                                                            |
| El guardado de las opciones aparece en rojo                           | El ajuste no llegó al disco. Pulsa **Save** otra vez.                                                                                                                                                                                                                                         |
| Error con la clave de API                                             | Consulta la [tabla de errores de la clave](API-KEY.md#errores-habituales).                                                                                                                                                                                                                    |

Para un informe, sigue [Soporte y reporte seguro](SUPPORT.md). Nunca incluyas el token, la clave de
API, rutas locales ni nombres de cuenta o de personaje.

## 10. Lo que aún no está verificado

- La instalación de Nexus, del addon 0.8.4 y del plugin 0.6.18 en Windows nativo, y la lectura del
  juego allí. Se confirma cargando el addon y viendo la línea `Loaded addon` en el log de Nexus y
  la línea de estado en **connected**.
- Que el arreglo del tope de hilos de la 0.8.4 funcione en Windows. Se confirma con un Windows con
  muchos programas abiertos: el panel debe tener datos y **Reader diagnostics** no debe mostrar
  «no coverage» por límites.
- Qué muestra Nexus al cargar el addon y cuál es su instalador en Windows. Se confirma con las
  instrucciones de la web de Raidcore.
- La versión mínima de Nexus que necesita el addon. Los repositorios no la dan. Se confirma en la
  web de Raidcore o preguntando en el soporte de Nexus.
- La apertura automática de Obsidian o de Hebra al arrancar el juego en Windows nativo. Se confirma
  cerrando la app, abriendo el juego y mirando la línea de lanzamiento de las Opciones de Nexus.
- La causa de un `Error Code 126` si aparece. Se confirma con el log de Nexus y el SHA-256 del
  `.dll`.
- Que el instalador de Hebra para Windows se descargue de ese enlace y que su pantalla de Plugins
  tenga los nombres citados en el apartado 5.2.
- Dónde guarda Hebra en Windows la clave de API.
- Que la instalación por BRAT y la carga en Obsidian funcionen en un cliente real. Se confirma
  con **Check for updates** en BRAT y abriendo la vista del plugin.

