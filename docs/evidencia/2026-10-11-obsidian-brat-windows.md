# Obsidian desechable en Windows, 11 oct 2026: instalación real por BRAT de la 0.6.47

Máquina: Windows 11 Pro 10.0.26300 (x64), Node v24.19.0. Código leído y scripts ejecutados: `origin/main` =
`1b6322d3d42e`, desde una copia `git archive` fuera del repo; no se instaló nada en el repo y su
`git status --porcelain` siguió vacío. Release medida: la GitHub Release `0.6.47` publicada
(2026-10-11T10:07:35Z). Medición del 11 oct, 12:37 a 12:45.

Marcas: MEDIDO = observado en la instancia real; LEÍDO = leído en código o documentación;
INFERIDO = deducido, no observado.

## Resultado

| Comprobación | Resultado | Clase |
|---|---|---|
| BRAT añade `fodaveg/tyrian-companion` y baja la release | `latest` resuelve a **0.6.47**; manifest registrado, plugin cargado y activado (`runtimeReady=true`) a los 4,06 s de pulsar «Add plugin» | MEDIDO |
| `main.js` y `styles.css` instalados frente a los assets publicados | sha256 iguales al `digest` de `gh release view 0.6.47 --json assets` | MEDIDO |
| `manifest.json` instalado | `"version":"0.6.47"`, mismo JSON que el publicado; distinto en bytes porque BRAT lo reescribe (ver abajo) | MEDIDO / LEÍDO |
| Consola al instalar y activar | 0 errores, 0 avisos | MEDIDO |
| `verify-beta-runtime` | `beta runtime v2: PASS (disk=0.6.47; registered=0.6.47; runtime=0.6.47; runtimeReady=true; release-bytes=match)`, exit 0 | MEDIDO |
| Cerrar y reabrir (como RT-03) | carga otra vez sin errores ni avisos; el verificador da la misma línea `PASS` | MEDIDO |
| Obsidian de David | perfil, instalación, protocolo `obsidian://` y PATH de usuario sin cambios; su Obsidian no estuvo abierto | MEDIDO |

Con esto la 0.6.47 pasa en Windows de «canal publicado; instalación/runtime pendiente» a instalada por BRAT y cargada en Obsidian real. No se midió una actualización por BRAT desde una versión anterior (ver «Límites»).

## Versiones

- Obsidian 1.13.7, el instalado en `%LOCALAPPDATA%\Programs\Obsidian`. Por CDP: `Chrome/150.0.7871.212`,
  `Electron/43.3.0`, V8 15.0.245.23.
- BRAT (`TfTHacker/obsidian42-brat`) 2.2.0, la última release (1 jul 2026), descargada con `gh release download`.
  sha256 iguales al `digest` de GitHub: `main.js` `d2fb579d4e83162aa13fc14f8f87d593bc2294529bddec6ea74011dc0f84b72c`,
  `manifest.json` `42fc033124eada81cbda727061b22e9cc0588bf993366cd9c23ba72fd8e81e01`, `styles.css`
  `47bbeb6e1692083e7ac668e87759c76fce7c3085265808b3d3d365742191d5f9`.

## Instalación por BRAT (MEDIDO)

1. Bóveda desechable con BRAT en `.obsidian/plugins/obsidian42-brat/` y los plugins de comunidad activos. Al abrir
   no salió el modal de confianza y BRAT cargó solo.
2. Flujo real de BRAT: comando `obsidian42-brat:AddBetaPlugin`, repo `fodaveg/tyrian-companion` (BRAT lo valida al
   perder el foco). El selector ofreció `latest, 0.6.47, 0.6.46…`; se eligió `latest`, con «Enable after installing
   the plugin» marcado (su valor por defecto), y «Add plugin». Aviso de BRAT: «fodaveg/tyrian-companion (version:
   latest) The plugin has been registered with BRAT.».
3. `latest` resolvió a 0.6.47 porque es la última release, ni borrador ni prerelease. La activación la hizo BRAT en el
   mismo paso, con su opción por defecto; la consola se escuchaba desde antes de pulsar «Add plugin».
4. Al terminar: `community-plugins.json` = `["obsidian42-brat","tyrian-companion"]` y BRAT guarda
   `pluginSubListFrozenVersion: [{repo:"fodaveg/tyrian-companion", version:"latest"}]`. Los comandos
   `open-companion`, `open-inventory-advisor` y `open-sale` abren su vista: el panel dice «Sin sesión · Esta
   instalación está en modo consulta: no lleva sesiones»; Inventario y Venta, «Falta vincular la clave API».

| Asset instalado | sha256 instalado | `digest` publicado | ¿Igual? |
|---|---|---|---|
| `main.js` | `d99ee51b69095f209b1f825ab877a222fdaeeafb388c4b4e67663bc39cd786d9` | el mismo | sí |
| `styles.css` | `dbbab93d36c22ff18c3952622dab91bf32df13cf6321604693ddff7c9eee120e` | el mismo | sí |
| `manifest.json` | `71703831ce9d5de7a9abfec2d5abd1d82cfc3bcd21dce6b2c24b5978c574e07a` (214 B) | `9c5fc9f04ddcd6ab66adfb851fa8ab7b5ed3ec0151d3c3ac72effc8b65c1b3a1` (237 B) | no en bytes, sí en contenido |

El `manifest.json` instalado es el mismo JSON que el publicado, pero en una sola línea, sin tabuladores ni salto
final (MEDIDO al parsear los dos). BRAT escribe el manifest que leyó al validar el repo,
`(g||h.manifest==="")&&(h.manifest=JSON.stringify(d))` en su `main.js` (LEÍDO). Por eso el verificador compara solo
`main.js` y `styles.css`. En Linux no se vio porque allí se instaló con `install-beta.mjs`.

## Consola (MEDIDO)

CDP sobre la página principal (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`):

- Instalación y activación: 0 errores y 0 avisos. Solo el banner de Obsidian, el `debug` «loading BRAT», dos `debug`
  de BRAT y dos `log` «Received CLI command», que son las consultas del verificador. Tyrian Companion no escribió nada.
- Reapertura: 0 errores y 0 avisos.
- Control positivo: en la reapertura se inyectaron un `console.warn`, un `console.error` y una excepción no
  capturada, y el colector registró los tres. No cuentan en lo anterior.
- Solo se escuchó la página principal, no los dos workers ni la ventana «Preferencias» que Obsidian abrió aparte.
  El código de los plugins corre en la principal: los `debug` de BRAT llegaron por ella aunque su modal se pintara en
  «Preferencias» (INFERIDO).

## Verificador (MEDIDO)

Desde la copia `git archive origin/main`, con el CLI real de Obsidian:

```
node scripts/verify-beta-runtime.mjs --vault <bóveda desechable> --obsidian-cli "%LOCALAPPDATA%\Programs\Obsidian\Obsidian.com"
beta runtime v2: PASS (disk=0.6.47; registered=0.6.47; runtime=0.6.47; runtimeReady=true; release-bytes=match)
```

Exit 0, con la misma línea en la primera carga y en la reapertura.

- `Obsidian.com` (22,8 kB, «Obsidian CLI») habla directamente con `\\.\pipe\obsidian-cli-<usuario>` y no lanza
  `Obsidian.exe` (MEDIDO). No conoce ningún `--user-data-dir`: le contesta la instancia que tenga la pipe, que aquí
  era la desechable. `Obsidian.com eval` devolvió la ruta de la bóveda desechable y `Electron/43.3.0`, y el
  verificador habría dado `runtime-vault-mismatch` con otra bóveda.
- El servidor de CLI se activó en la instancia desechable con `ipcRenderer.sendSync("cli", true)`. Según
  `obsidian.asar`, esa llamada solo escribe `cli:true` en el `obsidian.json` del perfil y arranca el servidor; el
  registro en el PATH lo hace otro handler, `register-cli`, que no se usó (LEÍDO).

## Cómo se aisló del Obsidian de David

En Windows Obsidian usa dos recursos que no dependen del perfil (LEÍDO por búsqueda de bytes en `obsidian.asar`):

- el servidor de CLI escucha en `\\.\pipe\obsidian-cli-<usuario>`;
- al arrancar hace `isDefaultProtocolClient("obsidian") || setAsDefaultProtocolClient("obsidian")`.

Por eso:

- **Binario instalado, sin modificar y sin cambiar variables de entorno**, solo con `--user-data-dir=<perfil
  desechable>` y `--remote-debugging-port=9339`. Como ya es el cliente registrado de `obsidian://`, no reescribe el
  protocolo. Una copia en otra ruta sí lo habría hecho, así que no se usó.
- **Solo con el Obsidian de David cerrado**, para no quitarle la pipe del CLI. Se comprobó antes de lanzar (0
  procesos `Obsidian.exe`) y una vigilancia cada 2 s (181 comprobaciones, 12:38:06-12:44:25) habría cerrado la
  instancia desechable al aparecer un `Obsidian.exe` ajeno: siempre `mios=4 ajenos=0`.
- El `obsidian.json` del perfil desechable lleva la bóveda con `open:true` y `updateDisabled:true`, para que no se
  bajara otra asar. El servidor de CLI le añadió `cli:true`.
- Perfil, bóveda, copia del repo, descargas y registros en `%TEMP%\tcw1011\`, fuera del repo: la ruta del scratch
  de la sesión mide 245 caracteres y con la bóveda y los almacenes de Chromium pasaba de `MAX_PATH`.
- Las dos instancias (instalación y reapertura) tuvieron 4 procesos con ese `--user-data-dir` y se cerraron con
  `window.close()` por CDP en menos de 1 s; no se mató ningún proceso.

| Comprobación (MEDIDO) | Antes | Después |
|---|---|---|
| HKCU `obsidian\shell\open\command` | `"…\Programs\Obsidian\Obsidian.exe" "%1"` (12:21 y 12:37) | idéntico (12:44 y 12:46) |
| `%APPDATA%\obsidian\obsidian.json` (mtime, sha256) | 2026-08-19T09:22:07.4071185Z, `344ED510…87271` | idéntico |
| Los 8 ficheros de `%APPDATA%\obsidian` (tamaño, mtime, sha256) y el total (90 entradas, 25 108 942 bytes) | foto de las 12:21:03 | idénticos a las 12:46:37 |
| `Obsidian.exe`, `app.asar` y `obsidian.asar` instalados (tamaño, mtime, sha256) | foto de las 12:21:03 | idénticos a las 12:46:37 |
| PATH de usuario (sha256) | `4DE24DD2…2F55E97` | idéntico |
| Procesos `Obsidian.exe` | 0 | 0 |
| Pipe `obsidian-cli-*` | no existe | no existe |
| Hebra | ningún proceso | ningún proceso |

## Límites

- **No medido: actualización real por BRAT desde una versión anterior.** `docs/BETA.md` la pide para dar por validada
  una plataforma; aquí solo hubo instalación limpia.
- Nada con clave de GW2 ni en modo `collector`.
- El modal de confianza de los plugins de comunidad no apareció, así que no se midió.
- La consola de los workers y de la ventana «Preferencias» no se escuchó.

## Limpieza

Se borró `%TEMP%\tcw1011` entero (50 MB: perfil 17 MB, copia del repo 29 MB, bóveda 2,5 MB, assets de la release
2,3 MB, BRAT, scripts y registros). No queda ningún proceso de la medición. Espacio libre (`df`): 111 GiB antes y
después.
