# Instalar Tyrian Companion en Windows: guía detallada

La guía corta, con solo los pasos, es [Instalar Tyrian Companion en Windows](INSTALAR-WINDOWS.md).
Esta es la versión larga: límites, opciones, problemas y lo que aún no está verificado.

Guía para el plugin **0.6.29** y el addon de Nexus **0.8.6**. Las dos versiones ya están
publicadas (plugin 0.6.29 y addon 0.8.6); publicadas no es instaladas ni verificadas en Windows.

## Qué parte seguir

Tyrian Companion son dos piezas: el **addon**, que vive dentro de Guild Wars 2 a través de Nexus,
y el **plugin**, que vive en una app de notas (Hebra, o Obsidian) y es quien lleva las sesiones y
escribe las notas. La guía va por separado para que puedas instalar una sin la otra.

| Qué quieres                                   | Qué seguir                                                    |
| --------------------------------------------- | ------------------------------------------------------------- |
| Solo el addon, sin ninguna app de notas       | [Parte 1](#parte-1-guild-wars-2-nexus-y-el-addon)             |
| Sesiones y notas con Hebra                    | Parte 1 y después [Parte 2](#parte-2-hebra-y-la-conexión-con-el-addon) |
| Sesiones y notas con Obsidian en vez de Hebra | Parte 1, el apartado de [Obsidian](#si-usas-obsidian-en-vez-de-hebra) y los pasos de conexión de la Parte 2 |

Al final hay tres apartados comunes: la [clave de API](#a-clave-de-api-de-guild-wars-2-opcional),
los [problemas frecuentes](#b-problemas-frecuentes) y
[lo que aún no está verificado](#c-lo-que-aún-no-está-verificado).

## Límites de esta guía

- **Windows nativo no está probado.** Todo lo verificado hasta hoy es Fedora con Proton
  (ver [ESTADO](ESTADO.md)). Esta guía describe el procedimiento previsto. Lo que no se ha podido
  comprobar está en [Lo que aún no está verificado](#c-lo-que-aún-no-está-verificado).
- **Tope de hilos del lector del addon.** Hasta la 0.8.3, el addon se rendía si veía más de
  4096 hilos en todo el sistema, algo que en Windows nativo se supera con pocos programas
  abiertos. Desde la 0.8.4 ese tope es de 65 536 hilos del sistema y el del propio juego es de 256
  (antes 128), y el addon salta un hilo que ya no existe en vez de fallar. Ese arreglo **no se ha
  visto funcionar en Windows**. Si el panel sigue sin datos, mira
  [Problemas frecuentes](#b-problemas-frecuentes).
- **Las sesiones en vivo no necesitan clave de API.** El addon de Nexus sí es obligatorio en todas
  las plataformas desde el 8 oct 2026. El módulo de Blish HUD queda congelado en 0.5.0.
- **Una release publicada no prueba que funcione en tu equipo.** Del plugin y del addon hay canal
  publicado, pero su instalación y su ejecución en un cliente real siguen pendientes.
- **El addon se actualiza solo desde la 0.8.5.** Con la 0.8.4 o anterior hay que sustituir el
  fichero `.dll` a mano, con Guild Wars 2 cerrado, una vez. Nexus guarda 30 minutos la lista de
  versiones de GitHub. La actualización automática se ha visto en Fedora con Proton, no en Windows nativo.

# Parte 1. Guild Wars 2, Nexus y el addon

Esta parte no necesita ninguna app de notas. Al terminarla tienes el addon cargado en el juego.
Para que muestre datos, el addon necesita el plugin de Tyrian Companion en Hebra (Parte 2) o en
Obsidian; la conexión se explica en la Parte 2.

## 1.1. Qué necesitas

| Pieza                          | Versión                      | Para qué                            | Dónde se consigue                                                                     |
| ------------------------------ | ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Guild Wars 2                   | La que tengas instalada      | El juego del que se leen las bolsas | Tu copia del juego                                                                    |
| Nexus                          | No consta una versión mínima | Carga el addon dentro del juego     | La web de Raidcore (raidcore.gg)                                                      |
| Addon Tyrian Companion (Nexus) | 0.8.6                        | Lee el juego y pinta el panel       | [Release 0.8.6](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.6) |

El addon 0.8.6 pide un plugin que hable su protocolo. La release 0.8.3 pedía Tyrian Companion 0.6.10
o posterior; la 0.6.29 lo cumple. Los requisitos de la 0.8.6 están en las notas de su release.

## 1.2. Instalar Nexus

1. Cierra Guild Wars 2 por completo.
2. Abre la web de Raidcore (raidcore.gg) y descarga Nexus. Los repositorios de Tyrian Companion no
   describen el instalador de Nexus: sigue las instrucciones de esa web.
3. Abre Guild Wars 2 una vez para comprobar que Nexus arranca. Lo que debe aparecer en pantalla no
   está descrito en los repositorios; si Nexus no se ve, resuélvelo con su soporte antes de seguir.

## 1.3. Instalar el addon

Instalarlo es copiar un fichero `.dll` a la carpeta de addons de Nexus.

1. Abre la [release 0.8.6 del addon](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.6)
   y descarga el fichero `.dll` adjunto.
2. Abre Guild Wars 2 y, en Nexus, abre la lista de addons.
3. Pulsa **Abrir carpeta de addons**, abajo en esa ventana, junto a **Buscar actualizaciones**
   (nombres con Nexus en español). Se abre la carpeta de addons en el Explorador.
4. Copia el `.dll` en esa carpeta.
5. Vuelve al juego. El addon debe aparecer en la lista de Nexus. Si no aparece, pulsa el botón de
   refrescar que hay junto a **Buscar actualizaciones**, o cierra el juego y vuelve a abrirlo. Si
   aparece sin cargar, cárgalo desde su ficha.
6. Comprueba que carga: en la ventana de log de Nexus debe aparecer `Loaded addon`, y en las
   Opciones de Nexus debe haber una sección **Tyrian Companion**.

Por confirmar: que Nexus detecte el `.dll` nuevo sin reiniciar el juego y cómo se llama el botón
de cargarlo. El botón **Abrir carpeta de addons** sí se ha visto en Nexus.

Desde la 0.8.5 Nexus actualiza el addon. Si tienes la 0.8.4 o anterior, o quieres ponerlo a mano,
cierra Guild Wars 2, sustituye el `.dll` de esa carpeta por el nuevo y abre el juego. Con el juego
abierto, Windows no deja sustituir un `.dll` cargado.

La carpeta de addons es `<carpeta de Guild Wars 2>\addons\`, donde la carpeta de Guild Wars 2 es
la que contiene `Gw2-64.exe`. El nombre del fichero no importa: su dueño lo tiene instalado como
`TyrianCompanion.dll` y Nexus lo carga con ese nombre, así que puedes dejarlo con el de la release
o renombrarlo. El addon guarda sus ajustes aparte, en
`<carpeta de Guild Wars 2>\addons\tyrian_companion_nexus\settings.json`.

Para saber qué versión tienes cargada, busca en el log de Nexus la línea
`Tyrian Companion addon v<versión> loading`. El addon no escribe su versión en las opciones ni en
el panel. Esa línea sale del código y no se ha visto en una pantalla de Windows.

## 1.4. Las opciones del addon y el panel

Las opciones están en las Opciones de Nexus, en la sección **Tyrian Companion**.

| Opción                                                           | Qué hace                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Línea de estado (**Status**)                                     | Dice si el addon está conectado al plugin. Sin plugin, no pasa de **Status: waiting for the plugin...** o de **Status: no token yet. Paste it below**. |
| **Token** y **Port**                                             | Los datos de la conexión con el plugin. Se rellenan en la Parte 2. El puerto por defecto es 47823. |
| **Open Obsidian or Hebra automatically when the game starts**    | Viene activada. Abre la app de notas si estaba cerrada al arrancar el juego. Se desactiva aquí. |
| **App to open**                                                  | Elige qué app abre la opción anterior: Obsidian (por defecto) o Hebra.                          |
| **Show Labyrinth farming panel / Mostrar panel de Laberinto**    | Muestra el panel del juego. Viene oculto por defecto.                                           |
| Casilla de idioma del panel                                      | Cambia solo el panel entre español e inglés.                                                    |
| **Reader diagnostics**                                           | Despliega lo que leyó el lector del addon en su último ciclo. Sirve para los problemas.         |

Nexus también pone en su barra de acceso rápido dos iconos del addon: la calabaza muestra u oculta
el panel y el monstruo abre las opciones.

El panel tiene una forma fija:

- Una columna con las bolsas observadas y su ritmo por hora, y otra con el precio bruto de un
  stack de 250 bolsas.
- Las líneas de huecos, de Magic Find y de estado.
- El punto de estado: verde con una sesión en curso, gris si espera sesión, naranja si hay un
  problema que se lee en el tooltip.

## 1.5. Qué hace el addon por sí solo y qué no

Según el README del addon, el addon se conecta a un servidor local (`127.0.0.1`, puerto 47823)
que abre el plugin, y se identifica con un token que se copia del plugin. Eso fija lo que tiene y
lo que no tiene quien se queda solo en la Parte 1.

- **Con el addon solo, sin plugin ni app de notas abierta:**
  - Se carga en el juego, aparecen sus opciones y su panel, y los iconos de la barra de Nexus.
  - Reintenta conectar sin parar y sin mostrar un error. No necesita que el juego o la app
    arranquen en un orden concreto.
  - Si la opción de apertura automática está activa y nadie escucha en el puerto, intenta abrir la
    app elegida, una vez por carga. En Windows nativo solo lo hace si la app registró su
    esquema `obsidian://` o `hebra://` al instalarse. Eso no se ha visto en Windows.
- **Lo que NO tienes sin el plugin:**
  - Los avisos dentro del juego: cada aviso lo emite el plugin y el addon solo lo pinta.
  - Sesión, tiempo transcurrido y notas: el addon informa del contexto del juego (estado, mapa,
    personaje), pero no lleva sesiones ni escribe notas.
  - Las cifras de bolsas y de precio del panel, que llegan del plugin. Los huecos y el Magic Find
    los puede leer el propio addon, pero solo mientras el plugin le haya negociado una fuente
    de lectura, así que sin plugin conectado el panel tampoco las muestra.

Para conectar el addon con el plugin sigue la [Parte 2](#parte-2-hebra-y-la-conexión-con-el-addon)
(con Hebra) o el apartado de [Obsidian](#si-usas-obsidian-en-vez-de-hebra).

# Parte 2. Hebra y la conexión con el addon

Haz esta parte con la Parte 1 terminada.

## 2.1. Qué hace falta de cada parte

| Pieza                     | Hace falta | Para qué                                         |
| ------------------------- | ---------- | ------------------------------------------------ |
| Guild Wars 2              | Sí         | Parte 1, apartado 1.1                            |
| Nexus                     | Sí         | Parte 1, apartado 1.2                            |
| Addon 0.8.6               | Sí         | Parte 1, apartado 1.3                            |
| Obsidian y BRAT           | No         | Solo si usas Obsidian en vez de Hebra            |
| Hebra (escritorio)        | Sí         | Instalar en 2.2. Versión para Windows: 0.2.3     |
| Plugin Tyrian Companion   | Sí         | Instalar en Hebra en 2.3. Versión 0.6.29         |
| Clave de API de Guild Wars 2 | Opcional | Solo inventario y cartera manuales (ver apartado A) |

## 2.2. Instalar Hebra

Hebra tiene versión para Windows. La vigente es la **0.2.3**. Según `docs/ESTADO.md` del
repositorio de Hebra, se publicó el 9 oct 2026, y `https://app.hebra.pro/updates/windows/latest.json`
anuncia esa versión.

1. Descarga el instalador desde `https://app.hebra.pro/repo/hebra-latest-x64-setup.exe`. Es el
   enlace de descarga manual que documenta Hebra: el 9 oct 2026 respondía 200 con 10.773.054 bytes
   y servía la 0.2.3. Esta guía no ha descargado ese instalador.
2. Ejecuta el instalador. Hebra no lleva firma de código de Windows, así que SmartScreen avisará la
   primera vez que lo instales desde el navegador. En Windows se continúa con **Más información** y
   **Ejecutar de todas formas**. Esos nombres son los de SmartScreen en general; la documentación
   de Hebra solo dice que el aviso aparece.
3. Abre Hebra y entra en una biblioteca de prueba, desechable.
4. Hebra se actualiza desde la propia app: al arrancar pregunta si quieres instalar una versión
   nueva («Actualizar ahora» o «Más tarde») y nunca instala sin preguntar.

Sin medir según Hebra: el arranque del binario 0.2.3 (no se lanzó ni se instaló) y la
actualización desde la 0.2.2 a la 0.2.3.

## 2.3. Instalar el plugin en Hebra

Los nombres coinciden entre `docs/SPEC-PLUGINS-EXTERNOS.md` de Hebra y las cadenas de su código
(`LibrarySettingsPlugins.svelte`). Nadie los ha visto en la app de Windows.

1. Abre los ajustes de Hebra y entra en **Plugins**.
2. Activa **Plugins de terceros**. Está apagado por defecto y Hebra enseña un aviso antes de
   activarlo.
3. Instala Tyrian Companion de una de estas dos maneras:
   - Desde el listado de Hebra: busca Tyrian Companion y pulsa **Instalar**.
   - Por URL: en **Añadir por URL de GitHub**, escribe `fodaveg/tyrian-companion` o
     `https://github.com/fodaveg/tyrian-companion` y pulsa **Buscar**. Esta vía existe en Windows.
4. Acepta la hoja de consentimiento con **Instalar**. Hebra instala la última release normal. No
   instala prereleases, y la 0.6.29 es una release normal.
5. Comprueba que Tyrian Companion está encendido en la lista de plugins.

El plugin declara la API de plugins `^1.0.0` en `hebra.json`, así que se instala en una Hebra que no
tenga la API 1.3.0. Por confirmar: que esa pantalla de Windows muestre la versión instalada del
plugin.

## 2.4. Los ajustes del plugin y la carpeta de salida

1. En **Plugins**, en la ficha de Tyrian Companion, pulsa **Ajustes…**. Es la misma página de
   ajustes que en Obsidian, sin pestañas. Las filas de mantenimiento están en un bloque plegado
   llamado **Mantenimiento** (en inglés, **Maintenance**).
2. En **Carpeta de salida** (en inglés, **Output folder**), elige la carpeta de la biblioteca donde
   quieres las notas. Por defecto es `Tyrian Companion`. No es una ruta del sistema de Windows.
3. En Hebra ese campo es un buscador de carpetas: solo guarda una carpeta que **ya exista** en la
   biblioteca, y no la crea. Si `Tyrian Companion` no existe todavía, la fila avisa con «(no existe
   en la biblioteca)». Crea la carpeta en Hebra y elígela.

## 2.5. Conectar con el addon

1. En los ajustes del plugin, activa la fila **Aviso dentro del juego (opcional)** (en inglés,
   **In-game alert (optional)**) y elige **Activadas** (en inglés, **Enabled**). Está apagada por
   defecto. Hasta que la actives, la fila del token no aparece.
2. En la fila **Token del addon** (en inglés, **Addon token**), pulsa **Copiar token** (en inglés,
   **Copy token**). La primera vez crea el token; las siguientes copian el mismo. También puedes
   usar el comando **Copiar token del puente con el juego** (en inglés, **Copy in-game bridge
   token**). El token es distinto de la clave de API.
3. El puerto es **47823**. El plugin ya no tiene una fila para cambiarlo: usa el valor guardado,
   que por defecto es 47823. Si el servidor no puede arrancar, el plugin lo dice bajo la fila del
   aviso con el texto «El servidor no pudo iniciarse» y un código.
4. En Guild Wars 2, abre las Opciones de Nexus y busca **Tyrian Companion**.
5. Pulsa **Paste** junto al campo **Token**, o haz clic en el campo y pulsa Ctrl+V.
6. Comprueba que el campo **Port** del addon vale 47823.
7. Pulsa **Save**. Si Hebra está abierta con el plugin activo, la línea de estado debe pasar a
   **Status: connected** en unos segundos.

Avisos:

- No pegues una clave de API de Guild Wars 2 en el campo Token. El addon la rechaza al guardar y
  nunca la envía.
- El token tiene entre 32 y 128 caracteres sin espacios.
- El addon guarda el token en claro en `<carpeta de Guild Wars 2>\addons\tyrian_companion_nexus\settings.json`.
  No compartas ese fichero.
- En Windows, Hebra puede abrir el puerto local: su documentación da el servidor TCP de los
  plugins como disponible en Windows. No se ha visto funcionar allí.

## 2.6. Primera sesión

1. Abre Hebra con el plugin activo.
2. Abre la vista del plugin: pulsa el botón de Tyrian Companion de la barra de Hebra y elige
   **Abrir acompañante** (en inglés, **Open companion**), o ejecuta ese mismo comando desde la
   paleta. En Hebra 0.2.3 de Windows la sesión se abre en la columna derecha (ver 2.8).
3. Abre Guild Wars 2 y entra a jugar. La sesión empieza sola al detectar que estás en el juego.
   No hay botón de inicio.
4. Opcional: en las Opciones de Nexus, en **App to open**, elige **Hebra**. Viene en Obsidian, y
   es la app que el addon intenta abrir al arrancar el juego (ver 1.4).
5. Opcional: en las Opciones de Nexus, activa **Show Labyrinth farming panel / Mostrar panel de
   Laberinto** (ver 1.4).

Qué debes ver:

- **En las Opciones de Nexus:** la línea de estado en **Status: connected**.
- **En el panel del juego, si lo activaste:** las bolsas observadas y su ritmo, el precio del stack
  de 250, los huecos, el Magic Find y el punto de estado (ver 1.4).
- **En Hebra:**
  - La vista del plugin muestra la fase de la sesión y el tiempo transcurrido.
  - La primera muestra del inventario fija la línea base. No es botín. Las variaciones se
    registran a partir de ahí.
  - Una conexión del addon no demuestra que haya objetos. Mira también la fase y el estado de la
    fuente.
  - Al salir del juego, la sesión se cierra. Si el addon deja de estar presente, hay diez minutos de
    gracia.
  - Al cerrar la sesión se escribe una nota resumen en la carpeta `summaries/` de la **Carpeta de
    salida** del plugin, dentro de la biblioteca de Hebra. Las notas de sesión completas van a
    `sessions/<año UTC>/`, dentro de la misma carpeta.

## 2.7. Las Bases en Hebra

Las Bases son los ficheros `.base` que ordenan las notas del plugin en tablas. En Hebra viven
dentro de la carpeta de salida, en `Bases/`.

- **Instalación nueva:** el plugin no crea nada por sí solo. La primera vez, en **Assets
  gestionados**, ejecuta **Vista previa** y después **Aplicar**, como explica
  [Inventario durable y Bases](INVENTORY-VAULT-SYNC.md).
- **Bases ya importadas** (por ejemplo desde una bóveda de Obsidian): si la carpeta de salida ya
  tiene su manifiesto o algún `.base` en `Bases/`, Hebra apunta el plugin a esa carpeta (código de
  `src/host/hebra/hebra-host.ts`) y el plugin las adopta y actualiza.
- **Después de aplicar los assets una vez**, desde la 0.6.16 el plugin mantiene sus Bases al
  cargarse: crea las Bases nuevas del paquete, actualiza las que no editaste y retira
  `Sessions.base`, `Halloween.base` y `Materials.base` si no las editaste. Si una Base la editaste
  tú, el plugin no escribe ninguna y avisa. Las notas resumen de sesión llevan una columna
  **Icono** en la Base de resúmenes.

## 2.8. Dónde se muestra la vista del plugin en Hebra

La 0.6.21 añade una fila en los ajustes del plugin. Texto del catálogo del plugin:

| Idioma  | Nombre               | Ayuda                                                                                                                   | Opciones                              |
| ------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Español | Dónde se muestra     | En la pantalla principal o en la barra lateral. Solo afecta a este dispositivo. En la principal se abre con «Abrir acompañante», en el menú del botón de Tyrian Companion. | Pantalla principal / Barra lateral    |
| Inglés  | Where it is shown    | On the main screen or in the sidebar. Affects this device only. On the main screen, open it with "Open companion" in the Tyrian Companion button's menu. | Main screen / Sidebar                 |

Por defecto es la pantalla principal, allí donde Hebra lo permite.

**Límite en Windows.** La vista en la pantalla principal necesita un Hebra con la API de plugins
1.3.0. La Hebra 0.2.3 de Windows se construyó desde el commit `17321b16` de Hebra, y el merge que trae
la API 1.3.0 (`85bb3917`, 9 oct 2026) no es antepasado de ese commit. Por tanto, **en Hebra 0.2.3 de
Windows la fila «Dónde se muestra» no aparece** y el plugin 0.6.21 se ve como antes: la sesión en la
columna derecha, y Inventario y Venta en un diálogo. La opción llegará con la primera versión de
Hebra para Windows posterior a la 0.2.3 que incluya esa API. No hay fecha ni número de versión. En
Linux, el rpm `0.2.0-15` de Hebra sí la trae. En Windows no se ha visto.

# Si usas Obsidian en vez de Hebra

Los pasos de la Parte 1 valen igual. De la Parte 2 no hacen falta Hebra (2.2), la instalación del
plugin en Hebra (2.3) ni el apartado de Dónde se muestra (2.8). La conexión con el addon (2.5) y la
primera sesión (2.6) son iguales, con "Obsidian" donde ponga "Hebra".

## Instalar Obsidian y el plugin con BRAT

Para la primera prueba usa una bóveda desechable.

1. Descarga Obsidian de escritorio desde la web de Obsidian (obsidian.md), versión 1.11.4 o más
   reciente, e instálalo.
2. Crea una bóveda de prueba.
3. Abre **Settings → Community plugins → Browse** e instala y activa **BRAT**
   ([BRAT](https://github.com/TfTHacker/obsidian42-brat), la versión que publique su autor).
4. En BRAT, elige **Add beta plugin**, escribe `fodaveg/tyrian-companion` y selecciona la versión
   publicada **0.6.29**.
5. Vuelve a **Settings → Community plugins** y activa **Tyrian Companion**.
6. Abre la paleta de comandos y ejecuta **Open companion** (en español, **Abrir acompañante**).
7. Los ajustes son los mismos que en Hebra (sin pestañas, con el bloque plegado **Maintenance**).

Después, conecta con el addon como en el apartado 2.5 y haz la primera sesión como en el 2.6.

## Lo que cambia respecto a Hebra

- **Carpeta de salida:** es una carpeta de la bóveda de Obsidian. Por defecto `Tyrian Companion`.
- **Clave de API:** se guarda como secreto de Obsidian y se elige en la fila **Clave API**. El
  plugin solo guarda el nombre del secreto.
- **Bases:** primero aplica los assets una vez, como en 2.7. Las Bases se escriben en la raíz de
  los assets gestionados, que se fija en el primer **Aplicar**. Si cambias después la carpeta de
  salida, el plugin intenta mover las Bases y lo avisa; si avisa de que no pudo, usa el botón
  **Mover** de **Assets gestionados**.
- **Apertura del plugin:** no existe la opción «Dónde se muestra»: es de Hebra.

## Obsidian y Hebra abiertos a la vez

Lo que demuestra el código del plugin:

- Los dos usan el puerto **47823** en `127.0.0.1`. Solo uno puede tenerlo.
- Si el puerto está ocupado, el plugin reintenta cinco veces (a los 250, 500, 1000, 2000 y 5000 ms)
  y después deja de intentarlo. Entonces lo avisa una vez al arrancar y escribe bajo la fila del aviso «Otra app
  (¿Obsidian o Hebra?) tiene el puerto» (con otros errores, «El servidor no pudo iniciarse» y el código). Hebra informa de un puerto ocupado con el mismo código
  (`EADDRINUSE`), así que se comporta igual.
- El token se guarda en el almacén de secretos de cada app: el de Obsidian y el llavero de Hebra.
  Cada instalación tiene su propio token.
- El addon se conecta a quien tenga el puerto, y solo acepta el token de esa app.

Regla: usa una sola app como recolector a la vez en el mismo equipo (detalle en
[BETA](BETA.md#obsidian-y-hebra-en-el-mismo-equipo-una-app-a-la-vez)). La otra, en **Consulta**
(Ajustes, **Modo de esta instalación**). Si no lo haces, la que llegue segunda al puerto lo avisa
(«Otra app (¿Obsidian o Hebra?) tiene el puerto») y el addon habla con la primera. Si cambias de
app, copia el token de la que vayas a usar y pégalo en el addon. No se ha probado con las dos
abiertas de verdad; lo que el plugin avisa está comprobado con tests, no a mano.

# Apartados comunes

## A. Clave de API de Guild Wars 2 (opcional)

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
4. Copia el valor una sola vez y guárdalo según tu app:
   - **Obsidian:** como secreto de Obsidian, y elígelo en los ajustes del plugin, en la fila
     **Clave API** (en inglés, **API key**). El plugin solo guarda el nombre del secreto.
   - **Hebra:** el plugin guarda todos sus secretos con nombre en una sola entrada del llavero de
     Hebra (`src/host/hebra/secrets.ts`), y en `data.json` solo queda el nombre. Según el
     `Cargo.toml` de Hebra, en Windows ese llavero es el Administrador de credenciales de Windows.
     Si Hebra no pudiera guardar secretos, el plugin los dejaría solo en memoria y la clave se
     perdería al recargar. Por confirmar en Windows: nadie lo ha visto allí.
5. No pegues el valor en una nota, en `data.json`, en un informe ni en una captura.
6. Si quieres validarla, pulsa **Comprobar conexión** (en inglés, **Check connection**) en la vista
   del plugin. Ese botón no está en los ajustes.

## B. Problemas frecuentes

| Síntoma                                                               | Qué mirar                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La línea de estado no pasa a **connected**                            | Que el puerto sea 47823 en el addon; que el token esté en el campo Token; que Hebra u Obsidian estén abiertos con el plugin activo; que **Aviso dentro del juego** esté activado. Corrige y pulsa **Save** otra vez.                                                                          |
| «El servidor no pudo iniciarse» en los ajustes del plugin             | Otro programa tiene el puerto 47823; lo más probable es la otra app de notas con el plugin activo. Cierra una de las dos.                                                                                                                                                                    |
| El addon avisa de que el token fue rechazado y no vuelve a intentarlo | Es lo previsto: no reintenta tras un rechazo hasta que pegues un token nuevo y guardes. Si rotaste el token en el plugin, copia el nuevo con **Copiar token**. Cada app tiene su propio token.                                                                                               |
| `version_unsupported`                                                 | El plugin es anterior a lo que pide el addon. Esta guía usa el plugin 0.6.29, que cumple lo que pedía la 0.8.3 (0.6.10 o posterior).                                                                                                                                                          |
| `source_conflict`                                                     | Otra fuente tiene la sesión. El addon vuelve a intentarlo cada 30 segundos. Mientras tanto el panel dice que otra fuente es la dueña.                                                                                                                                                         |
| `unsupported_build`                                                   | El addon solo lee el ejecutable con SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`. Para ver el tuyo, en PowerShell: `Get-FileHash "<carpeta de Guild Wars 2>\Gw2-64.exe" -Algorithm SHA256`. Otro build no se lee hasta que se certifique.                       |
| Panel sin datos, con «no coverage» y el motivo de límites de lectura  | Es el tope de hilos. En las Opciones de Nexus, despliega **Reader diagnostics** y mira **Own threads: N / 256**. Esa línea cuenta los hilos del propio juego. Los hilos del sistema (tope de 65 536 desde la 0.8.4) no aparecen en pantalla. Con la 0.8.3 o anterior, el tope era 4096 y 128. |
| Panel sin cifras y sin plugin                                         | Es lo previsto: las bolsas y el precio llegan del plugin (ver 1.5). Conecta el plugin con la Parte 2.                                                                                                                                                                                       |
| Nexus registra `Failed LoadLibrary` con `Error Code 126`              | El DLL no carga sus dependencias. Copia de nuevo el `.dll` de la release y verifica su SHA-256. El `.dll` de la release está enlazado para no necesitar librerías externas. Si persiste, no está resuelto.                                                                                    |
| Hebra u Obsidian no se abren solos al arrancar el juego               | En Windows nativo el addon solo los abre si la app registró su esquema `obsidian://` o `hebra://` al instalarse. Si no, no hace nada a propósito. Abre la app a mano. Comprueba también **App to open**. La opción se desactiva en **Open Obsidian or Hebra automatically when the game starts**. |
| El `.dll` instalado es antiguo                                        | Con la 0.8.4 o anterior el addon no se actualiza solo. Con el juego cerrado, sustituye el `.dll` y comprueba `Loaded addon` al abrir el juego.                                                                                                                                                                        |
| No veo la fila «Dónde se muestra» en Hebra                            | En Hebra 0.2.3 de Windows es lo previsto: necesita la API de plugins 1.3.0 (ver 2.8).                                                                                                                                                                                                        |
| BRAT no ofrece la versión 0.6.29                                      | GitHub puede tardar entre 5 y 15 minutos en servir una release. Usa **Check for updates** en BRAT.                                                                                                                                                                                            |
| El guardado de las opciones aparece en rojo                           | El ajuste no llegó al disco. Pulsa **Save** otra vez.                                                                                                                                                                                                                                         |
| Error con la clave de API                                             | Consulta la [tabla de errores de la clave](API-KEY.md#errores-habituales).                                                                                                                                                                                                                    |

Para un informe, sigue [Soporte y reporte seguro](SUPPORT.md). Nunca incluyas el token, la clave de
API, rutas locales ni nombres de cuenta o de personaje.

## C. Lo que aún no está verificado

- La instalación de Nexus, del addon 0.8.6 y del plugin 0.6.29 en Windows nativo, y la lectura del
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
- Que el instalador de Hebra 0.2.3 para Windows se descargue de ese enlace, se instale y arranque
  (Hebra no lo ha medido), y la actualización desde la 0.2.2. Que su pantalla de Plugins tenga en
  Windows los nombres citados en 2.3 (coinciden en la spec y en el código de Hebra, pero no se han
  visto en la app).
- Que el servidor local del plugin (puerto 47823) funcione en la Hebra de Windows, y que su llavero
  guarde allí la clave de API.
- Cuándo llegará a Windows la fila «Dónde se muestra»: no hay fecha ni versión.
- Qué pasa en la práctica con Obsidian y Hebra abiertos a la vez (solo hay lectura del código).
- Que la instalación por BRAT y la carga en Obsidian funcionen en un cliente real. Se confirma
  con **Check for updates** en BRAT y abriendo la vista del plugin.
