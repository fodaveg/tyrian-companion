# Instalar Tyrian Companion en Windows desde cero

## Límites de esta guía

- **Windows nativo no está probado.** Todo lo verificado hasta hoy es Fedora con Proton
  (ver [ESTADO](ESTADO.md)). Esta guía describe el procedimiento previsto. Los pasos marcados
  «por confirmar» no están descritos en los repositorios.
- **El lector del addon puede quedarse sin datos en Windows nativo.** Tiene un tope de 4096 hilos
  del sistema (`MAX_SYSTEM_ENTRIES` en `addon/src/inventory.rs` del repo del addon). Con muchos
  programas abiertos puede impedir leer el juego. Hay un arreglo en curso que **aún no está
  publicado**: hasta la versión que lo corrija, el panel del juego puede quedarse sin datos.
  Qué mirar está en [Problemas frecuentes](#9-problemas-frecuentes).
- **Las sesiones en vivo no necesitan clave de API.** El addon de Nexus sí es obligatorio en todas
  las plataformas desde el 8 oct 2026. El módulo de Blish HUD queda congelado en 0.5.0.
- **Lo publicado no está instalado ni probado en tu equipo.** El plugin 0.6.16 tiene el canal
  publicado; su instalación y su ejecución en cliente real siguen pendientes. El addon 0.8.3 está
  publicado y su carga dentro del juego en Windows no se ha visto.
- **El addon no se actualiza solo.** Para actualizarlo hay que sustituir el DLL a mano con
  Guild Wars 2 cerrado.

## 1. Qué necesitas

| Pieza                             | Versión                                   | Para qué                                              | Fuente                                                                                  |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Guild Wars 2                      | La que tengas instalada                   | El juego del que se leen las bolsas                   | Tu copia del juego                                                                      |
| Nexus                             | Por confirmar                             | Carga el addon dentro del juego                       | [raidcore.gg](https://raidcore.gg/)                                                     |
| Addon Tyrian Companion (Nexus)    | 0.8.3                                     | Lee el juego y pinta el panel                         | [Release 0.8.3](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.3)   |
| Obsidian (escritorio)             | 1.11.4 o más reciente                     | App de notas donde corre el plugin                    | Por confirmar                                                                           |
| Hebra (escritorio)                | Por confirmar si hay versión para Windows | App de notas alternativa a Obsidian                   | Por confirmar                                                                           |
| Plugin Tyrian Companion           | 0.6.16                                    | Sesiones, notas y avisos                              | [Release 0.6.16](https://github.com/fodaveg/tyrian-companion/releases/tag/0.6.16)       |
| BRAT (solo con Obsidian)          | La que publique su autor                  | Instala el plugin beta en Obsidian                    | [BRAT](https://github.com/TfTHacker/obsidian42-brat)                                    |
| Clave de API de Guild Wars 2      | Opcional                                  | Solo inventario y cartera manuales                    | [Applications de ArenaNet](https://account.arena.net/applications)                      |

Necesitas Obsidian o Hebra. No hace falta tener las dos.

## 2. Instalar Nexus

1. Cierra Guild Wars 2 por completo.
2. Instala Nexus. Por confirmar: los repositorios no describen el instalador de Nexus para
   Windows. El sitio del proyecto es [raidcore.gg](https://raidcore.gg/).
3. Abre Guild Wars 2 una vez para comprobar que Nexus arranca. Por confirmar qué debe aparecer.

## 3. Instalar el addon

1. Cierra Guild Wars 2 por completo.
2. Abre la [release 0.8.3 del addon](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.3)
   y descarga el DLL. Por confirmar el nombre exacto del fichero de la 0.8.3: la 0.8.2 publicó
   `tyrian_companion_nexus.dll`.
3. Comprueba el SHA-256 del DLL. Debe ser:

   ```
   c0e6880223aa6e0185b11b8dc8d12ba28a197504718ba89fe8d49133ef28ad8b
   ```

   Por confirmar el comando para calcularlo en Windows.
4. Si no existe, crea la carpeta `addons` dentro de la carpeta de instalación de Guild Wars 2.
5. Copia el DLL dentro de `addons`. La ruta del addon es `<Guild Wars 2>/addons/`. Por confirmar
   la ruta por defecto de Guild Wars 2 en Windows.
6. Abre Guild Wars 2. En la ventana de log de Nexus debe aparecer `Loaded addon`.
7. Comprueba la versión cargada. Por confirmar dónde se muestra el número de versión: no se ha
   visto en pantalla.

## 4. Instalar la app de notas

Elige una de las dos. Para la primera prueba usa una bóveda o un espacio de notas desechable.

### 4.1. Obsidian

1. Instala Obsidian de escritorio, versión 1.11.4 o más reciente. Por confirmar dónde descargarlo.
2. Crea una bóveda de prueba.

### 4.2. Hebra

1. Instala Hebra de escritorio. Por confirmar si hay una versión publicada para Windows.
2. Hebra aloja el plugin como plugin externo. No hay que instalar nada más en Hebra antes del
   paso 5.

## 5. Instalar el plugin

### 5.1. En Obsidian, con BRAT

1. Abre **Settings → Community plugins → Browse** e instala y activa **BRAT**.
2. En BRAT, elige **Add beta plugin**, escribe `fodaveg/tyrian-companion` y selecciona la versión
   publicada **0.6.16**.
3. Vuelve a **Settings → Community plugins** y activa **Tyrian Companion**.
4. Abre la paleta de comandos y ejecuta **Open companion**.

### 5.2. En Hebra

1. Añade el plugin desde el listado de Hebra o con la URL del repositorio,
   `https://github.com/fodaveg/tyrian-companion`. Por confirmar el nombre exacto del menú en Hebra.
2. Elige la release normal **0.6.16**. Hebra no instala prereleases.
3. Por confirmar dónde se ven los ajustes del plugin en Hebra y si muestra la versión instalada.

## 6. Crear la clave de API (opcional)

Las sesiones en vivo no la necesitan. Sí hace falta para el inventario y la cartera manuales y
para el botón de comprobar conexión. Detalle completo en [Clave API de Guild Wars 2](API-KEY.md).

1. Entra en [Applications, en la cuenta de ArenaNet](https://account.arena.net/applications).
2. Crea una clave con un nombre reconocible, por ejemplo `Tyrian Companion beta`.
3. Elige un perfil:

   | Perfil                          | Permisos                                                             | Qué permite                                                                                 |
   | ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
   | Solo comprobar conexión         | `account`                                                            | Valida la clave y muestra la cuenta. No sirve para sesiones.                                |
   | Mínimo funcional v1             | `account`, `characters`, `inventories`, `builds`                     | Capturas estables, inventario principal, personaje y build activo.                          |
   | Recomendado para la beta actual | Los cuatro anteriores más `wallet`, `tradingpost`, `progression`, `unlocks` | Monedas, entregas, órdenes, historial del bazar y señales de logros, recetas, skins y minis. |

   No hacen falta `guilds`, `pvp` ni `wvw`. Los permisos de una clave no se pueden editar: para
   cambiar el perfil, crea otra clave y revoca la anterior.
4. Copia el valor una sola vez. En Obsidian, guárdalo como secreto en **Ajustes de Obsidian →
   Tyrian Companion → API key**. Por confirmar dónde se guarda en Hebra.
5. No pegues el valor en una nota, en `data.json`, en un informe ni en una captura.
6. Si quieres validarla, pulsa **Check connection / Comprobar conexión**.

## 7. Conectar el plugin y el addon

1. En los ajustes del plugin, activa el puente con el juego. Por confirmar el nombre exacto del
   interruptor.
2. En los ajustes del plugin, en la fila **Token del addon**, pulsa **Copiar token**. Por confirmar
   dónde está esta fila en Hebra. El token es distinto de la clave de API.
3. Anota el puerto que muestra el plugin. Por defecto es **47823**.
4. En Guild Wars 2, abre las Opciones de Nexus y busca **Tyrian Companion**.
5. Pulsa **Paste** junto al campo Token, o haz clic en el campo y pulsa Ctrl+V.
6. Comprueba que el puerto del addon es el mismo que el del plugin. Por defecto, 47823 en los dos.
7. Pulsa **Save**. Si Obsidian o Hebra están abiertos con el plugin activo, la línea de estado
   debe pasar a **connected** en unos segundos.

Avisos:

- No pegues una clave de API de Guild Wars 2 en el campo Token. El addon la rechaza al guardar y
  nunca la envía.
- El token tiene entre 32 y 128 caracteres sin espacios.
- El addon guarda el token en claro en `<Guild Wars 2>/addons/tyrian_companion_nexus/settings.json`.
  No compartas ese fichero.

## 8. Primera sesión

1. Abre Obsidian o Hebra con el plugin activo.
2. Abre Guild Wars 2 y entra a jugar. La sesión empieza sola al detectar que estás en el juego.
   No hay botón de inicio.
3. Opcional: en las Opciones de Nexus, activa **Show Labyrinth farming panel / Mostrar panel de
   Laberinto**. Viene oculto por defecto.

Qué debes ver:

- **En las Opciones de Nexus:** la línea de estado en **connected**.
- **En el panel del juego, si lo activaste:**
  - Una columna con las bolsas observadas y su ritmo por hora, y otra con el precio bruto de un
    stack de 250 bolsas.
  - Las líneas **Huecos**, **MF** y **Estado**.
  - Estado **● Midiendo** cuando mide.
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
  - Al cerrar la sesión se escribe una nota resumen en `sessions/<año UTC>/`, dentro de la carpeta
    de salida configurada.

## 9. Problemas frecuentes

| Síntoma                                                                 | Qué mirar                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La línea de estado no pasa a **connected**                              | Que el puerto sea el mismo en el plugin y en el addon; que el token esté en el campo Token; que Obsidian o Hebra estén abiertos con el plugin activo; que el puente esté activado. Corrige y pulsa **Save** otra vez.                                          |
| El addon avisa de que el token fue rechazado y no vuelve a intentarlo   | Es lo previsto: no reintenta tras un rechazo hasta que pegues un token nuevo y guardes. Si rotaste el token en el plugin, copia el nuevo con **Copiar token**.                                                                                              |
| `version_unsupported`                                                   | El plugin es anterior a lo que pide el addon. El addon 0.8.3 pide Tyrian Companion 0.6.10 o posterior. Esta guía usa 0.6.16.                                                                                                                                  |
| `source_conflict`                                                       | Otra fuente tiene la sesión. El addon vuelve a intentarlo cada 30 segundos. Mientras tanto el panel dice que otra fuente es la dueña.                                                                                                                         |
| `unsupported_build`                                                     | El addon solo lee el ejecutable con SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`. Otro build no se lee hasta que se certifique. Por confirmar cómo comprobar ese hash en tu copia de Windows.                                       |
| Panel sin datos, con «no coverage» y el motivo de límites de lectura   | Es el tope de hilos de la sección de límites. En las Opciones de Nexus, despliega **Reader diagnostics** y mira **Own threads: N / 128**. Esa línea cuenta los hilos del propio juego. El tope de 4096 del sistema no aparece en pantalla: por confirmar cómo verlo. Cerrar programas que no uses puede reducir los hilos del sistema; no está medido en Windows. |
| Nexus registra `Failed LoadLibrary` con `Error Code 126`                | El DLL no carga sus dependencias. Copia de nuevo el DLL de la release y verifica su SHA-256. El DLL de la release está enlazado para no necesitar librerías externas. Si persiste, no está resuelto: por confirmar.                                             |
| Obsidian o Hebra no se abren solos al arrancar el juego                 | La apertura automática en Windows nativo no está verificada. Solo puede funcionar si la app registró su esquema `obsidian://` o `hebra://` al instalarse. Abre la app a mano.                                                                               |
| El DLL instalado es antiguo                                             | El addon no se actualiza solo. Con el juego cerrado, sustituye el DLL y comprueba `Loaded addon` al abrir el juego.                                                                                                                                              |
| BRAT no ofrece la versión 0.6.16                                        | GitHub puede tardar entre 5 y 15 minutos en servir una release. Usa **Check for updates** en BRAT.                                                                                                                                                              |
| El guardado de las opciones aparece en rojo                             | El ajuste no llegó al disco. Pulsa **Save** otra vez.                                                                                                                                                                                                          |
| Error con la clave de API                                               | Consulta la [tabla de errores de la clave](API-KEY.md#errores-habituales).                                                                                                                                                                                    |

Para un informe, sigue [Soporte y reporte seguro](SUPPORT.md). Nunca incluyas el token, la clave de
API, rutas locales ni nombres de cuenta o de personaje.

## 10. Lo que aún no está verificado

- La instalación de Nexus, del addon 0.8.3 y del plugin 0.6.16 en Windows nativo.
- La carga del addon y la lectura del juego en Windows nativo.
- La instalación del plugin en Obsidian y en Hebra en cliente real.
