# RT-14 / DU-12: candado de vida con dos procesos sobre WebView2 en Windows, 11 oct 2026

Máquina: Windows 11 Pro 10.0.26300 (x64), runtime de WebView2 154.0.4258.62 (`BrowserVersionString` de todos los
controles), PowerShell 5.1.26100.9549. Hebra instalada: 0.2.2 en `%LOCALAPPDATA%\Hebra` (`hebra.exe`, 29 942 784
bytes, 10 oct 14:44), que es la de David y no se lanzó. Medición del 11 oct, 12:21 a 12:47. Solo medición: no se
escribió en ningún repo salvo este fichero. Lo LEÍDO de Hebra viene de `e1975217` (`main` de `fodaveg/hebra` en
GitHub, leído con `gh api`, sin clonar ni compilar); lo de `tauri-plugin-single-instance`, de su etiqueta
`single-instance-v2.4.2` (`5c7668b6`), byte a byte igual a la copia del registro de cargo de esta máquina.

**Resultado: en Windows los Web Locks de WebView2 SÍ cruzan procesos que abren la misma carpeta de datos (UDF) con
las mismas opciones de entorno, porque comparten el proceso de navegador `msedgewebview2.exe` (MEDIDO, 6 de 6).
Es lo contrario de Linux y macOS. Hebra de Windows SÍ tiene candado de instancia, pero no es un `instancia.lock`:
es el mutex con nombre `net.fodaveg.hebra-sim` de `tauri-plugin-single-instance` 2.4.2 (LEÍDO en el código y en el
binario instalado), con dos huecos estrechos. Tras `taskkill /F` del proceso que tiene el candado, el otro lo recibe
4-21 ms después de que muera el renderer del muerto (34-54 ms después del host; 166-237 ms desde que se lanza
`taskkill`, que tarda en volver); el mutex queda libre ~5 ms después de `TerminateProcess` (MEDIDO). Con
`taskkill /F /T` muere también el navegador compartido y el otro proceso se queda sin WebView: nunca recibe el
candado (MEDIDO).**

Convención: MEDIDO es lo observado en un proceso real; LEÍDO, lo que dice el código; INFERIDO, lo que se deduce de
ambos.

## 1. ¿Dos procesos sobre el mismo almacén ven el Web Lock del otro?

**Sí, si comparten las opciones de entorno (MEDIDO).** Sonda propia en PowerShell 5.1 con el control WinForms de
WebView2 (ver «Cómo se aisló la prueba»): página `https://probe.local/sonda.html` servida con
`SetVirtualHostNameToFolderMapping`, `isSecureContext` = `true`, `navigator.locks` presente y
`document.visibilityState` = `visible` en todas las medidas. Candado `tyrian-companion-lease:wl1:prueba-<tanda>`.

| Montaje | Resultado |
|---|---|
| Dos procesos, misma UDF, mismas opciones (6 repeticiones) | Los dos controles dan el MISMO `BrowserProcessId` (12980, 6904, 16348, 3204, 15656, 5196), hijo del primer host; cada host tiene su renderer. H toma el candado y lo retiene; W, otro proceso, con `ifAvailable`: `held`; `query().held` lo lista (`prueba-pair1`, `exclusive`); la petición bloqueante de W espera hasta que H muere (3643-3879 ms en las tres tandas con kill) |
| Mismo montaje, almacenamiento | Compartido: W lee en IndexedDB y en `localStorage` la marca aleatoria que acaba de escribir H (`marca-fae419e2`, `marca-be6e04ad`, `marca-007085d7`…, las seis) |
| Control positivo: dos controles en un proceso, misma UDF (3 repeticiones) | Un navegador, un renderer por control. A retiene; B con `ifAvailable`: `held`, `query().held` lo lista; el bloqueante de B espera 2043-2068 ms y se concede 9-21 ms después de que A suelte (A navega a `about:blank`) |
| Misma UDF, opciones distintas (W con `AdditionalBrowserArguments=--disable-background-timer-throttling`; 3 repeticiones) | W no llega a tener WebView: `CoreWebView2InitializationCompleted` falla con `0x8007139F` (`ERROR_INVALID_STATE`). No arranca otro navegador; H sigue igual |

En Linux (WebKitGTK) y macOS (WKWebView) el candado es de cada proceso de interfaz. En Windows el gestor de candados
vive en el proceso de navegador de WebView2, y dos hosts con la misma UDF y las mismas opciones se conectan al mismo
navegador: el candado es de la UDF, no del host. Con opciones distintas no hay dos navegadores sobre una UDF: el
segundo host falla al inicializar.

## 2. ¿Hebra de Windows deja abrir dos procesos sobre la misma biblioteca?

**Por el código, no, salvo en dos casos estrechos (LEÍDO). No MEDIDO en una Hebra real: la de David no se lanzó y no
se construyó una de prueba.** Rutas y líneas de `fodaveg/hebra` `e1975217`.

### El candado es el mutex de `tauri-plugin-single-instance` (LEÍDO)

- `src-tauri/Cargo.toml:91` trae `tauri-plugin-single-instance = "=2.4.2"` con la feature `deep-link` y sin `semver`.
- `single_instance_plugin()` (`src-tauri/src/lib.rs:450-458`) se registra en Windows como PRIMER plugin del
  `Builder` (`lib.rs:510-511`, «Tiene que ser el PRIMER plugin: el segundo proceso sale antes de montar la biblioteca
  o los módulos»). El plugin de limpieza del service worker de WebView2 va justo después (`lib.rs:528-536`) y su
  comentario cuenta con que el `setup` del de instancia «ya ha salido si otra Hebra tiene el perfil».
- No hay módulo propio de candado para Windows: `linux_single_instance.rs` y `macos_single_instance.rs` se compilan
  solo en su sistema (`lib.rs:18-20`, `lib.rs:74-75`); los únicos módulos `#[cfg(windows)]` son `windows_updater` y
  `webview2_service_worker` (`lib.rs:78-82`). En Windows no hay `instancia.lock` ni `salida.lock`.
- El plugin en Windows (`plugins/single-instance/src/platform_impl/windows.rs:54-129`, etiqueta
  `single-instance-v2.4.2`): en su `setup` hace `CreateMutexW(NULL, TRUE, "<identificador>-sim")`. Si el mutex no
  existía, se lo queda (lo guarda en el estado de la app) y crea una ventana oculta de clase `<identificador>-sic` y
  título `<identificador>-siw`. Si ya existía (`ERROR_ALREADY_EXISTS`), busca esa ventana con `FindWindowW`; si la
  encuentra, le manda sus argumentos por `WM_COPYDATA`, llama a `cleanup_before_exit` y sale con
  `std::process::exit(0)`. Al salir de forma ordenada, `destroy` hace `ReleaseMutex` y `CloseHandle`.
- Sin la feature `semver` el nombre es `net.fodaveg.hebra-sim`, en el espacio de nombres local de la sesión (sin
  `Global\`).

### La Hebra instalada lo lleva (MEDIDO, sin lanzarla)

- Búsqueda de bytes en `%LOCALAPPDATA%\Hebra\hebra.exe` (0.2.2): `net.fodaveg.hebra` (3), `-sim` (3), `-sic` (1),
  `-siw` (1); `instancia.lock` (0) y `salida.lock` (0).
- Hebra no estaba abierta en ningún momento de la medición, así que no había mutex que comprobar. No hay ningún
  `*.lock` bajo `%LOCALAPPDATA%\net.fodaveg.hebra` ni `%APPDATA%\net.fodaveg.hebra`.
- Su UDF de WebView2 es `%LOCALAPPDATA%\net.fodaveg.hebra\EBWebView` y su biblioteca
  `%APPDATA%\net.fodaveg.hebra\library-v1`: dos procesos de Hebra compartirían UDF.

### Dónde quedan dos procesos vivos (LEÍDO e INFERIDO)

- **Mutex ocupado pero sin ventana**: si `FindWindowW` devuelve nulo, el plugin no tiene rama para ese caso y sigue
  arrancando (`windows.rs:72-97`): segundo proceso sobre la misma biblioteca. Pasa si el segundo arranque cae entre
  el `CreateMutexW` del primero y su `CreateWindowExW` (las dos llamadas van seguidas en el mismo `setup`, así que la
  ventana es muy corta), o si el primero sigue vivo pero ya destruyó su ventana o aún no la creó. INFERIDO; no se
  provocó.
- **Otra sesión de Windows** del mismo usuario (cambio rápido de usuario, escritorio remoto): el mutex es local a la
  sesión y no se ve. Comparten la misma UDF y la misma biblioteca. Que dos sesiones compartan además el navegador de
  WebView2 no se midió.
- Lo que en macOS es «ejecutable sin bundle» no tiene equivalente aquí: el nombre del mutex sale de
  `config.identifier`, que está compilado, así que también lo coge un binario lanzado a mano.

### `api.has('instance.lock')` es `false` en Windows (LEÍDO, `e1975217`)

`hostFeatureAvailable` (`src/lib/plugins/api/capabilities.ts:113-117`) devuelve `platform === 'linux'` para
`instance.lock`, igual que lo recogió la medición de macOS. En Windows `false` es conservador: hay candado, pero con
los huecos de arriba.

## 3. `taskkill /F` al proceso que tiene el candado

**El candado queda libre en cuanto muere el renderer del muerto (MEDIDO).** Marcas con un reloj común a todos los
procesos (`GetSystemTimePreciseAsFileTime`); las muertes, de `Process.ExitTime` (hora del núcleo) con el handle
abierto antes del kill. La concesión es la hora a la que el host recibe el mensaje de la página, así que añade unos
ms de IPC. Las horas «desde el `taskkill`» incluyen el arranque del propio `taskkill.exe`, que tardó 133-188 ms en
volver.

| Paso tras `taskkill /F /PID <H>`, con W esperando en el bloqueante | pair1 | pair2 | pair3 |
|---|---|---|---|
| Muere H | +142,6 ms | +126,6 ms | +183,2 ms |
| Muere el renderer de H | +172,8 ms | +145,2 ms | +218,7 ms |
| Se concede el candado a W | **+176,5 ms** | **+166,1 ms** | **+236,9 ms** |
| Concesión menos muerte de H / de su renderer | 33,9 / 3,7 ms | 39,5 / 20,9 ms | 53,7 / 18,2 ms |

- Sobreviven el navegador compartido (con su PPID apuntando al H muerto), gpu, utility, crashpad y el renderer de W.
  Al matar después a W, el árbol entero de esa UDF desaparece solo en 338-1457 ms.
- **`taskkill /F /T /PID <H>`** (3 repeticiones): mueren los 8 procesos de la UDF, navegador compartido y renderer
  de W incluidos, entre +154 y +212 ms. W recibe `ProcessFailed` (`BrowserProcessExited`, `Unexpected`, código 1) a
  +234-291 ms y después `BrowserProcessExited` (`Failed`). **W no recibe el candado nunca**: su host sigue vivo sin
  WebView.
- **Proceso nuevo R tras matar H, sin otro host vivo** (3 repeticiones): el navegador de H muere solo a +359-710 ms.
  R arranca un navegador nuevo, lee la marca de H en IndexedDB y `localStorage`, y antes de pedir el candado su
  `ifAvailable` da `free` y `query().held` = `[]`. El bloqueante se concede con 0,2-2,2 ms de espera, a +4918-6157 ms
  del kill. Ese total es arranque de PowerShell con `Add-Type` (1,7-2,5 s) y primera carga de la página (~2 s), no el
  candado: no representa el arranque de Hebra.
- **Mutex con nombre** (sonda aparte: un proceso PowerShell crea y retiene `tc-sonda-candado-…-sim` con
  `initiallyOwned`; el orquestador mata ese PID tras comprobar su línea de comandos y sondea creándolo de nuevo):
  - con `TerminateProcess` directo (5 repeticiones): libre a +4,9-14,0 ms, antes de que el proceso termine de salir
    (+15,1-20,7 ms);
  - con `taskkill /F` (5 repeticiones): libre en la primera comprobación tras volver `taskkill` (+117-144 ms, casi
    todo el arranque de `taskkill.exe`).

Para Hebra en Windows (INFERIDO de lo anterior y del punto 2): tras un `taskkill /F` el mutex queda abandonado y
libre en milisegundos, así que una Hebra reabierta lo coge sin esperar. Si el navegador de WebView2 de la muerta
sigue vivo, la nueva se le conecta (misma UDF, mismas opciones). Si no, arranca otro. En los dos casos el candado de
la muerta ya no existe. El total lo marca el arranque de Hebra, no medido aquí.

**No medido:** que Tyrian TOME el arriendo de sesión en Hebra de Windows ni los eventos `life_lock_*`; mismas razones
que en Linux y macOS (hace falta una sesión con clave de GW2).

## 4. Obsidian

La instalación por BRAT en Obsidian de Windows está en
[`2026-10-11-obsidian-brat-windows.md`](2026-10-11-obsidian-brat-windows.md). Para esta medición no se lanzó
Obsidian.

## ¿Basta el candado de vida en Windows?

**INFERIDO de 1, 2 y 3:** en Windows el caso que temía el código (dos procesos vivos que ven libre el candado del
otro) no se da en la capa WebView2 mientras los dos usen las mismas opciones: comparten navegador y el Web Lock es
real entre procesos. Además, Hebra publicada no deja dos procesos en uso normal (mutex más ventana de
`tauri-plugin-single-instance`). Quedan dos riesgos residuales:

- Los huecos del punto 2 (mutex sin ventana, otra sesión de Windows). Ahí el candado de vida aún protegería si los
  dos procesos acaban en el mismo navegador.
- Un `taskkill /F /T` (o un fallo del navegador de WebView2) que mate el navegador compartido. Deja a la otra Hebra
  sin WebView, y entonces el problema ya no es el candado.

Si dos builds de Hebra usaran opciones de entorno distintas, la segunda no abriría su WebView (`0x8007139F`), en vez
de quedar con candados separados. No se midió con qué opciones crea wry el entorno de Hebra.

## Cómo se aisló la prueba

- **Sonda propia en PowerShell 5.1** (STA, 64 bits) con WinForms y las DLL del paquete NuGet oficial
  `Microsoft.Web.WebView2` 1.0.4258.31 (sha256 del `.nupkg`
  `56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9`; `Core.dll`, `WinForms.dll` y
  `WebView2Loader.dll` con Authenticode válido de Microsoft Corporation). El paquete se descargó y extrajo en su
  propio directorio, separado de los scripts. No se instaló `dotnet`, Visual Studio ni nada con `cargo`.
- Host de 100 líneas, orquestador de 136, un helper C# de 15 (compilado con el `Add-Type` del .NET Framework del
  sistema: reloj preciso común y formulario sin activación en (-4000, -4000) fuera de la barra de tareas) y página de
  32. Roles `hold`, `peek` y `both`, como en macOS. Resultados por `chrome.webview.postMessage`, una línea JSON por
  evento con la hora del host y el `jsT` de la página como contraste.
- UDF nueva por tanda en `%TEMP%\tc-wv2-udf-<tanda>`: nada bajo `%LOCALAPPDATA%\net.fodaveg.hebra`,
  `%LOCALAPPDATA%\Hebra` ni `%APPDATA%\net.fodaveg.hebra`.
- Antes de cada `taskkill`, el orquestador comprobaba en `Win32_Process` que el PID era su `powershell.exe` (línea de
  comandos con `\tc-wv2-sonda\host.ps1` y la UDF de la tanda) o un `msedgewebview2.exe` de esa UDF. Los seis
  `msedgewebview2` ajenos que había (de `MicrosoftWindows.Client.CBS`) eran los mismos, con los mismos PPID, a las
  12:23 y a las 12:40. Al final no quedaba ningún proceso de la sonda.
- Mutex: un orquestador PowerShell lanza el que lo retiene, comprueba por su línea de comandos que es el suyo antes
  de matarlo y sondea con `New-Object System.Threading.Mutex($true, <nombre>, [ref]$creado)`, liberando cada handle
  de prueba.
- Se descartaron dos tandas por fallos del lector de la propia sonda (una perdió mensajes al chocar escritura y
  lectura; otra esperaba 40 s por paso por un `-bor` mal agrupado). Dieron el mismo patrón y no se usa ningún número
  suyo.

## Constancia: la Hebra de David no se tocó

- Hebra no estuvo abierta en ningún momento (ningún proceso `hebra` a las 12:21:03 ni a las 12:46:37). No se lanzó
  `%LOCALAPPDATA%\Hebra\hebra.exe` de ninguna forma y ningún proceso de la prueba usó su UDF ni su identificador.
- `hebra.exe`: 29 942 784 bytes y mtime 1791636244, igual antes y después (solo se leyeron sus bytes).
- Mtime y tamaño, solo con `find -printf`, iguales antes (12:28) y después (12:46) bajo
  `%APPDATA%\net.fodaveg.hebra`:
  - `library-v1/hebra.sqlite3`: 1790502464.3338326, 4096;
  - `library-v1/hebra.sqlite3-shm`: 1791465209.4210061, 32768;
  - `library-v1/hebra.sqlite3-wal`: 1791461578.9387795, 329632;
  - `plugins/installed.json`: 1791654993.8189486, 29858.
- El Obsidian de David tampoco cambió; la comparación completa está en el documento de BRAT.

## Limpieza y límites

Se borraron el paquete NuGet extraído (67 MB), las 16 UDF de la sonda (8,5-11 MB cada una), los registros crudos y
la sonda del mutex. Espacio libre (`df`): 111 GiB al empezar y al acabar.

No medido: Hebra real con dos procesos (el punto 2 queda LEÍDO/INFERIDO), los dos huecos del mutex provocados, dos
sesiones de Windows, las opciones con que wry crea el entorno de WebView2 de Hebra, el tiempo de arranque de Hebra
tras un kill, un proceso nuevo lanzado mientras aún vive el navegador del muerto, y Tyrian tomando el arriendo de
sesión con clave.
