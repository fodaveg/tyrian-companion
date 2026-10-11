# Obsidian desechable en Windows, 11 oct 2026: actualización por BRAT 0.6.46 → 0.6.47 y RT-15

Máquina: Windows 11 Pro 10.0.26300 (x64), Node v24.19.0, Obsidian 1.13.7 instalado (CDP: `Chrome/150.0.7871.212`,
`Electron/43.3.0`), BRAT 2.2.0. Scripts del repo desde una copia `git archive origin/main` (`ee344f74`) fuera del
repo. Medición del 11 oct, 13:02 a 13:10. Mismo aislamiento que
[`2026-10-11-obsidian-brat-windows.md`](2026-10-11-obsidian-brat-windows.md), con perfil, bóveda y sondas nuevos en
`%TEMP%\tcw1011b\`.

Marcas: MEDIDO = observado en la instancia real; LEÍDO = leído en código o documentación;
INFERIDO = deducido, no observado.

## Resultado

| Comprobación | Resultado | Clase |
|---|---|---|
| BRAT instala la 0.6.46 fijada | carga 0.6.46; `main.js` y `styles.css` iguales al `digest` de la 0.6.46; verificador `PASS` (`disk=0.6.46; registered=0.6.46; runtime=0.6.46; runtimeReady=true; release-bytes=match`) | MEDIDO |
| BRAT actualiza a `latest` | queda la **0.6.47**; `main.js` y `styles.css` iguales al `digest` de la 0.6.47; verificador `PASS` (`disk=0.6.47; …; release-bytes=match`) | MEDIDO |
| `data.json` de la 0.6.46 | sobrevive idéntico a la actualización (mismo sha256, mismas claves y valores) | MEDIDO |
| Consola desde que se pide la actualización | 0 errores, 0 avisos | MEDIDO |
| Cerrar y reabrir | carga la 0.6.47, verificador `PASS`, 0 errores y 0 avisos | MEDIDO |
| RT-15: `taskkill /F` (sin `/T`) del proceso principal y reabrir | el candado de vida de la instancia muerta está libre en la nueva en cuanto se puede preguntar, en 3 de 3 | MEDIDO |
| Obsidian de David | sin cambios; cerrado toda la medición | MEDIDO |

Con esto la actualización por BRAT que pide `docs/BETA.md` para validar plataforma queda medida en Windows.

## C. Actualización por BRAT de la 0.6.46 a la 0.6.47

**Cómo se hizo.** Al enviarlo, el modal «Add beta plugin» de BRAT llama a
`betaPlugins.addPlugin(repo, false, false, false, <versión>, <reinstalar>, <activar>)`, con `<reinstalar>` a
`true` cuando el repo ya está fijado, que es el caso de editar la versión (LEÍDO en el `main.js` de BRAT 2.2.0). Se
llamó a esa misma función por CDP, con las mismas posiciones, en vez de rellenar el DOM del modal. La medición
anterior ya había recorrido el modal real hasta esa llamada. BRAT 2.2.0 descargado con `gh release download`, sha256
iguales al `digest` de GitHub (`main.js` `d2fb579d…5f9b72c`, `manifest.json` `42fc0331…e81e01`, `styles.css`
`47bbeb6e…1d5f9`).

1. `addPlugin('fodaveg/tyrian-companion', …, '0.6.46', false, true)`: `true` a los 7,8 s y BRAT fija
   `{repo:"fodaveg/tyrian-companion", version:"0.6.46"}`. Se abrieron `open-companion`, `open-inventory-advisor`
   y `open-sale`, y el plugin creó `data.json` (1651 bytes, sha256 `816a07a1…1b4efc`, 42 claves de primer nivel,
   de `schemaVersion` a `salvageOpportunityCostCopperPerHour`).
2. Actualización, como al editar la versión en BRAT: `addPlugin('fodaveg/tyrian-companion', …, 'latest', true,
   true)` devuelve `true` a los 7,5 s y deja la versión fijada en `latest`, `latest` = 0.6.47.
3. Cerrar con `window.close()` por CDP y reabrir con el mismo perfil.

| | 0.6.46 fijada | Tras actualizar a `latest` | Tras reabrir |
|---|---|---|---|
| Manifest registrado / plugin cargado | 0.6.46 / 0.6.46 | 0.6.47 / 0.6.47 | 0.6.47 |
| `main.js` | `50aed680…72c18a` = `digest` de la 0.6.46 | `d99ee51b…cd786d9` = `digest` de la 0.6.47 | igual |
| `styles.css` | `dbbab93d…eee120e` = `digest` de la 0.6.46 | `dbbab93d…eee120e` = `digest` de la 0.6.47 (no cambió entre versiones) | igual |
| `data.json` | 1651 B, `816a07a1…1b4efc` | 1651 B, `816a07a1…1b4efc`; 0 claves nuevas, 0 perdidas, 0 valores cambiados | — |
| Verificador | `PASS` (0.6.46) | `PASS` (0.6.47) | `PASS` (0.6.47) |
| Consola | — | desde la marca de inicio de la actualización: solo dos `debug` de BRAT | banner, `debug` «loading BRAT» y un `log` «Received CLI command» |

Consola por CDP sobre la página principal (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`):
0 errores y 0 avisos en la instancia de la instalación y la actualización, y otros tantos en la reabierta. El
verificador se corrió así:
`node scripts/verify-beta-runtime.mjs --vault <bóveda> --obsidian-cli "%LOCALAPPDATA%\Programs\Obsidian\Obsidian.com"`,
con el servidor de CLI activado en la instancia desechable.

## D. RT-15 en Windows: el candado de vida tras matar Obsidian

**Tyrian toma su candado de vida también en modo consulta (MEDIDO).** Tras reabrir, `navigator.locks.query()` daba
`held` = `[{name:"tyrian-companion-lease:wl1:1ed8319c-…", mode:"exclusive"}]`. El nombre es
`tyrian-companion-lease:` más el `instanceId` de la instancia, que empieza por `wl1:` y cambia en cada arranque
(`lifeLockName`, `src/sessions/coordination-coordinator.ts:69-70` y `:739-741`, LEÍDO). Quien encuentra el arriendo
de otra instancia pregunta por el candado de ESE `instanceId`. Por eso lo que se mide es si, en la instancia
reabierta, el candado con el nombre de la muerta está libre.

Método: un orquestador PowerShell lista los `Obsidian.exe` con el `--user-data-dir` desechable, abre sus handles,
lanza `taskkill /F /PID <principal>` (sin `/T`) y toma la hora con `GetSystemTimePreciseAsFileTime`. Las muertes
salen de `Process.ExitTime`. Reabre con el mismo `--user-data-dir`, inmediatamente o esperando 5 s, y un sondeo por
CDP cada 25 ms anota cuándo hay página, la primera respuesta de `navigator.locks.query()` y cuándo aparece el
candado nuevo de Tyrian. Después se pide el nombre viejo con `ifAvailable` desde la instancia nueva.

| Paso (ms desde lanzar `taskkill`) | k1 (reabrir ya) | k2 (esperar 5 s) | k3 (reabrir ya) |
|---|---|---|---|
| Vuelve `taskkill` | 143 | 139 | 135 |
| Muere el principal | 138 | 132 | 130 |
| Mueren utility / renderer / gpu (solos, sin `/T`) | 213 / 243 / 316 | 150 / 180 / 260 | 140 / 164 / 254 |
| Se relanza | 442 | 5327 | 307 |
| CDP y página disponibles | 1084 | 5825 | 844 |
| Primera respuesta de `query()` | 1440: `held` = `[]`, `pending` = `[]` | 6062: `[]`, `[]` | 1148: `[]`, `[]` |
| Tyrian cargado | 2262 | 6844 | 1966 |
| Tyrian tiene su candado nuevo | 2491 (`…274c0e23…`), `pending` = `[]` | 7088 (`…67b3b8d8…`), `pending` = `[]` | 2212 (`…53d41345…`), `pending` = `[]` |
| Candado de la muerta, `ifAvailable` desde la nueva | `free` (`…1ed8319c…`) | `free` (`…274c0e23…`) | `free` (`…67b3b8d8…`) |

- Sin `/T` no sobrevive ningún proceso del árbol: utility, renderer y gpu mueren solos entre 8 y 186 ms después del
  principal.
- El candado de la muerta no existe en la reabierta: la primera consulta ya da `held` vacío y sin `pending`, y la
  petición `ifAvailable` del nombre viejo lo concede. El tiempo hasta poder preguntar lo marca el arranque de
  Obsidian (≈0,8-1,1 s desde el relanzamiento hasta tener página y ≈0,3 s más hasta la primera respuesta de
  `navigator.locks`), no el candado.
- Tras el último kill y reapertura el verificador sigue dando `PASS` con la 0.6.47.

Como en Linux (`2026-10-11-obsidian-appimage.md`, RT-15), el proceso nuevo empieza con el registro de candados
vacío. En Obsidian el candado es del proceso de Electron y muere con él.

## Aislamiento del Obsidian de David (MEDIDO)

- El binario instalado se lanzó sin modificarlo y sin cambiar variables de entorno, solo con `--user-data-dir` y
  `--remote-debugging-port=9341`. El `obsidian.json` del perfil desechable lleva `updateDisabled:true`. Antes de cada
  lanzamiento se comprobó que no había ningún `Obsidian.exe` ajeno.
- Vigilancia cada 2 s, de 13:03:52 a 13:09:29 (162 comprobaciones): nunca hubo un `Obsidian.exe` ajeno y no saltó
  ninguna alarma, que habría cerrado los procesos desechables.
- Solo se mataron PIDs con el `--user-data-dir` desechable en su línea de comandos, comprobados antes de cada
  `taskkill`. El vigilante se paró comprobando también su línea de comandos.
- Comparación de las 13:02:33 y las 13:10, sin ninguna diferencia:
  - `Obsidian.exe`, `app.asar` y `obsidian.asar` instalados (tamaño, mtime, sha256);
  - los 8 ficheros de `%APPDATA%\obsidian` (tamaño, mtime, sha256) y su total; `obsidian.json` sigue en
    2026-08-19T09:22:07.4071185Z, `344ED510…87271`;
  - HKCU `obsidian\shell\open\command` (`"…\Programs\Obsidian\Obsidian.exe" "%1"`);
  - sha256 del PATH de usuario (`4DE24DD2…2F55E97`);
  - pipes `obsidian*` (ninguna);
  - procesos de Obsidian y de Hebra (ninguno);
  - los ficheros de `%APPDATA%\net.fodaveg.hebra`.

## Límites

- La actualización se pidió con la misma llamada que hace el modal de BRAT, no rellenando el modal; tampoco se probó
  el «Check for updates» automático de BRAT, porque una versión fijada no se actualiza sola.
- Nada con clave de GW2 ni en modo `collector`. No se midieron los eventos `life_lock_*` ni que otra instancia tome
  el arriendo de la muerta: solo que su candado queda libre.
- Consola solo de la página principal, no de los workers ni de la ventana «Preferencias».

## Limpieza

Se borró `%TEMP%\tcw1011b` (50 MB: perfil, bóveda, copia del repo, BRAT, sondas y registros) y un fichero suelto que
dejó el primer intento de escribir el perfil desechable con la ruta mal formada. No queda ningún proceso de la
medición. Espacio libre (`df`): 111 GiB antes y después.
