# H18.27 · Sonda: ¿puede un proceso Windows dentro de Wine/Proton abrir o enfocar el Obsidian de Fedora?

Medido el 2026-09-24 desde `/home/fodaveg/code/tyrian-companion/.claude/worktrees/agent-a5c40e76fff95154a`,
rama `main`, HEAD `a2584af3ca73` (= `origin/main`; `git status --porcelain` y
`git log origin/main..HEAD` vacíos). **Sonda previa, sin implementación**: no se ha tocado
ningún fichero del plugin ni del juego. Todo lo producido (fuente C, binario, prefijo de
Wine desechable, log de wineboot) vive en el scratchpad de la sesión; este fichero es su
copia canónica en el repo.

## Contexto de la decisión (David, 24 sep 2026)

Si Obsidian está cerrado y el jugador empieza a jugar, que se abra solo. El plugin no ve
nada con Obsidian cerrado, así que quien tendría que abrirlo es un proceso **dentro** del
juego (Windows/Proton): un addon de Nexus (DLL) o un módulo de Blish HUD (ambos procesos
Windows corriendo bajo Wine/Proton en esta máquina Fedora). Esta sonda mide si esa vía es
viable en absoluto, antes de diseñar nada.

## 1. Cómo está instalado Obsidian aquí

```
$ flatpak list | grep -i obsidian
Obsidian        md.obsidian.Obsidian   1.13.7  stable  flathub  system

$ which obsidian
/home/fodaveg/.local/bin/obsidian        # wrapper que en realidad lanza el flatpak

$ xdg-mime query default x-scheme-handler/obsidian
md.obsidian.Obsidian.desktop

$ cat /var/lib/flatpak/exports/share/applications/md.obsidian.Obsidian.desktop
[Desktop Entry]
Name=Obsidian
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=obsidian.sh --file-forwarding md.obsidian.Obsidian @@u %U @@
MimeType=x-scheme-handler/obsidian;
X-Flatpak=md.obsidian.Obsidian
```

Obsidian es un flatpak (`md.obsidian.Obsidian`), corre dentro de su propio sandbox `bwrap`,
y el esquema `obsidian://` **sí está registrado** en el host apuntando a su `.desktop`.
Durante toda la sonda, el Obsidian real de David estaba abierto (PID base `54502` y sus
hijos Electron); no se cerró ni se tocó su bóveda en ningún momento (`obsidian://open`,
sin vault ni fichero).

Entorno de sesión: GNOME Shell sobre Wayland (`XDG_SESSION_TYPE=wayland`,
`WAYLAND_DISPLAY=wayland-0`, con XWayland en `DISPLAY=:0`).

## 2. Control positivo y negativo desde el host

```
$ date -Ins   # 2026-09-24T08:54:54
$ xdg-open "obsidian://open"; echo EXIT=$?
EXIT=0
```

`journalctl --user` en esa ventana:

```
systemd[4191]: Started app-flatpak-md.obsidian.Obsidian-2751032070.scope.
systemd[4191]: Started app-flatpak-md.obsidian.Obsidian-3634276202.scope.
md.obsidian.Obsidian.desktop[54502]: {"argv":["obsidian://open"],...}
md.obsidian.Obsidian.desktop[54502]: Received command line [ 'obsidian://open' ]
md.obsidian.Obsidian.desktop[54502]: Received callback URL obsidian://open
systemd[4191]: app-flatpak-md.obsidian.Obsidian-2751032070.scope: Consumed 392ms CPU
  time over 1.291s wall clock time, 167.6M memory peak.
```

Es decir: `xdg-open` lanza una instancia nueva y efímera del flatpak, que detecta el lock
de instancia única de Electron, reenvía el argv por IPC a la instancia **ya abierta**
(PID 54502, la de David) y se cierra sola en ~1,3 s. El recuento de procesos de Obsidian
antes y después es idéntico (10 líneas de `pgrep -af obsidian`, sin contar el ruido del
`md.obsidian.Obsidian.desktop[54502]: Received callback URL ...` — esa línea es la señal
de "abrir/enfocar" que se puede medir sin cerrar nada).

Control negativo:

```
$ xdg-open "no-existe-este-esquema://test"; echo EXIT=$?
gio: no-existe-este-esquema://test: La ubicación especificada no está soportada
EXIT=4
```

Discrimina correctamente: URI real → `Received callback URL` + exit 0; esquema inventado →
error de `gio` + exit 4. Este es el patrón de referencia que se busca reproducir desde
Wine/Proton.

## 3. Sonda `loader.exe` (C, mingw)

Fuente completo (vive también en el scratchpad de la sesión,
`h18-27/loader.c`):

```c
/* H18.27 - sonda minima: puede un proceso Windows dentro de Wine/Proton abrir
 * o enfocar el Obsidian del host (Fedora) via el esquema obsidian:// ?
 *
 * Prueba tres vias, en orden, e imprime el resultado de cada una:
 *   1. ShellExecuteW(..., L"open", L"obsidian://open", ...)
 *   2. ShellExecuteW con el verbo NULL (que Windows resuelve solo)
 *   3. CreateProcessW lanzando "C:\\windows\\system32\\start.exe" con la URI
 *      (start.exe en Wine reenvia a winebrowser.exe -> xdg-open del host)
 *
 * Compilar: x86_64-w64-mingw32-gcc -municode -o loader.exe loader.c -lshell32
 * Ejecutar: wine loader.exe   (o el "proton run"/binario de Proton)
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>

static void print_last_error(const char *label) {
    DWORD err = GetLastError();
    fprintf(stderr, "[loader] %s: GetLastError=%lu\n", label, (unsigned long)err);
}

int wmain(void) {
    HINSTANCE r;

    fprintf(stdout, "[loader] arrancando sonda H18.27\n");
    fflush(stdout);

    /* Via 1: ShellExecuteW con verbo "open" */
    r = ShellExecuteW(NULL, L"open", L"obsidian://open", NULL, NULL, SW_SHOWNORMAL);
    fprintf(stdout, "[loader] via1 ShellExecuteW(open, obsidian://open) -> handle=%p (>32 es exito)\n",
            (void *)r);
    if ((INT_PTR)r <= 32) { print_last_error("via1"); }
    fflush(stdout);
    Sleep(1500);

    /* Via 2: ShellExecuteW con verbo NULL, deja que el sistema lo resuelva */
    r = ShellExecuteW(NULL, NULL, L"obsidian://open", NULL, NULL, SW_SHOWNORMAL);
    fprintf(stdout, "[loader] via2 ShellExecuteW(NULL, obsidian://open) -> handle=%p (>32 es exito)\n",
            (void *)r);
    if ((INT_PTR)r <= 32) { print_last_error("via2"); }
    fflush(stdout);
    Sleep(1500);

    /* Via 3: start.exe (Wine reenvia esto a winebrowser.exe -> xdg-open del host) */
    {
        STARTUPINFOW si; PROCESS_INFORMATION pi; WCHAR cmdline[512]; BOOL ok;
        ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si); ZeroMemory(&pi, sizeof(pi));
        wcscpy(cmdline, L"C:\\windows\\system32\\start.exe /unix obsidian://open");
        ok = CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi);
        if (ok) {
            fprintf(stdout, "[loader] via3 CreateProcessW(start.exe) -> lanzado pid=%lu\n",
                    (unsigned long)pi.dwProcessId);
            WaitForSingleObject(pi.hProcess, 5000);
            DWORD code = 0; GetExitCodeProcess(pi.hProcess, &code);
            fprintf(stdout, "[loader] via3 start.exe exit code=%lu\n", (unsigned long)code);
            CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        } else {
            fprintf(stdout, "[loader] via3 CreateProcessW(start.exe) -> FALLO\n");
            print_last_error("via3");
        }
        fflush(stdout);
    }

    /* Control negativo: esquema inexistente, via ShellExecuteW */
    Sleep(1000);
    r = ShellExecuteW(NULL, L"open", L"no-existe-este-esquema://test", NULL, NULL, SW_SHOWNORMAL);
    fprintf(stdout, "[loader] control-neg ShellExecuteW(no-existe-este-esquema://test) -> handle=%p\n",
            (void *)r);
    print_last_error("control-neg");
    fflush(stdout);

    fprintf(stdout, "[loader] fin de sonda\n");
    return 0;
}
```

Compilación (mingw ya instalado en el sistema):

```
x86_64-w64-mingw32-gcc -municode -o loader.exe loader.c -lshell32
```

## 4. Prefijo de Wine desechable

**Nunca** se tocó `compatdata/1284210/pfx` (el prefijo del juego). Todo corrió en:

```
WINEPREFIX=<scratchpad>/h18-27/wineprefix-wine   (WINEARCH=win64, creado de cero)
```

### 4.1 Aviso operativo: `wineboot --init` se cuelga con la config por defecto

El primer intento de `wineboot --init` (sin overrides) se quedó colgado **más de 15
minutos** en `rundll32.exe setupapi,InstallHinfSection DefaultInstall 128 wine.inf`
(proceso en estado `S`, 0,1 % CPU, bloqueado en `ntsync_schedule` — no es CPU-bound, es un
cuelgue real, no lentitud por carga de máquina). Se mató el árbol de procesos
(`wineserver -k`) y se repitió con:

```
WINEDLLOVERRIDES="mscoree=d;mshtml=d;winemenubuilder.exe=d" wineboot --init
```

que terminó en segundos. La hipótesis más probable es `winemenubuilder.exe` (el paso de
integración de menú/asociaciones de Wine con el escritorio Linux) bloqueado por contención
de D-Bus/gio en una máquina con varias sesiones activas a la vez; no se investigó más a
fondo por no ser el objetivo de esta sonda, pero **queda anotado como landmine** para
cualquier sonda futura de Wine en este equipo: si `wineboot --init` no termina en ~30 s,
matar y reintentar con ese `WINEDLLOVERRIDES`.

### 4.2 Vía 1 y 2 (`ShellExecuteW`) — SIN registrar el esquema: FALLA

```
$ wine loader.exe
[loader] via1 ShellExecuteW(open, obsidian://open) -> handle=000000000000001f (>32 es exito)
[loader] via1: GetLastError=3
[loader] via2 ShellExecuteW(NULL, obsidian://open) -> handle=000000000000001f (>32 es exito)
[loader] via2: GetLastError=3
[loader] via3 CreateProcessW(start.exe) -> lanzado pid=236
La aplicación no se pudo ejecutar, o no hay ninguna aplicación asociada con el archivo especificado.
ShellExecuteEx fallido: Ruta no encontrada.
[loader] via3 start.exe exit code=1
```

`0x1f` = 31 = `SE_ERR_NOASSOC`. Es el comportamiento esperado: Wine sólo trae asociaciones
por defecto para `http`, `https`, `ftp`, `mailto`, etc. (ver `system.reg`, todas apuntando a
`winebrowser.exe "%1"`). El esquema `obsidian` no existe en el prefijo porque nunca se
instaló nada dentro de Windows/Wine que lo registrase (Obsidian es un flatpak Linux, no un
`.exe` instalado en el prefijo). **Con `ShellExecuteW`/`start.exe` desnudos, la vía no
funciona out-of-the-box.**

### 4.3 Registrar el esquema en el prefijo y repetir: FUNCIONA

Se registró manualmente la misma asociación que Wine ya usa para `http` (mismo patrón,
mismo binario destino), tal como lo haría un instalador de Windows real (`.reg` importado
con `wine regedit`):

```
[HKEY_LOCAL_MACHINE\Software\Classes\obsidian]
"URL Protocol"=""

[HKEY_LOCAL_MACHINE\Software\Classes\obsidian\shell\open\command]
@="\"C:\\windows\\system32\\winebrowser.exe\" \"%1\""
```

(Nota: la clave debe ir en `HKEY_LOCAL_MACHINE\Software\Classes`, no en
`HKEY_CURRENT_USER\Software\Classes`: la vista fusionada `HKEY_CLASSES_ROOT` de este Wine
11.0 no recogió la clave puesta en HKCU — se comprobó con `wine reg query HKCR\obsidian`,
vacío tras escribir en HKCU y presente tras escribir en HKLM.)

```
$ wine loader.exe
[loader] via1 ShellExecuteW(open, obsidian://open) -> handle=0000000000000021 (>32 es exito)
[loader] via2 ShellExecuteW(NULL, obsidian://open) -> handle=0000000000000021 (>32 es exito)
[loader] via3 CreateProcessW(start.exe) -> lanzado pid=248
[loader] via3 start.exe exit code=0
[loader] control-neg ShellExecuteW(no-existe-este-esquema://test) -> handle=000000000000001f
[loader] control-neg: GetLastError=3
```

`0x21` = 33 (> 32 = éxito) en las tres vías; el control negativo (esquema no registrado)
sigue devolviendo `SE_ERR_NOASSOC` (31) tal cual — la sonda discrimina limpio.
`journalctl --user` en la ventana de esa ejecución (09:17:35–09:17:40) muestra, una vez
por cada vía disparada:

```
md.obsidian.Obsidian.desktop[54502]: Received command line [ 'obsidian://open/' ]
md.obsidian.Obsidian.desktop[54502]: Received callback URL obsidian://open/
```

Tres veces, una por cada vía (`via1`, `via2`, `via3`), exactamente el mismo patrón que el
control positivo del host (§2). El proceso de Obsidian de David (PID 54502 y familia) no
cambió de número ni se reinició; sólo recibió el callback tres veces. (Nota menor: la URI
llega como `obsidian://open/` con una barra final añadida por la normalización de GLib al
pasar por `gio`/`winebrowser`; Obsidian la trata igual que `obsidian://open`.)

### 4.4 Vía más simple, sin tocar el registro: llamar a `winebrowser.exe` directamente

Se borró la clave de registro (`wine reg delete "HKLM\Software\Classes\obsidian" /f`,
confirmado con `wine reg query HKCR\obsidian` → "Unable to find the specified registry
key") y se invocó `winebrowser.exe` **directamente** como el ejecutable a lanzar (sin pasar
por la resolución de tipo de `ShellExecuteW`/`start.exe`):

```
$ wine "C:\windows\system32\winebrowser.exe" "obsidian://open"; echo EXIT=$?
EXIT=0
```

`journalctl --user` (09:19:16–09:19:17): mismo patrón, `Received callback URL
obsidian://open/`. **Esto funciona SIN ningún registro previo**: es la vía más simple para
un addon — no necesita tocar `HKLM\Software\Classes`, sólo lanzar (`CreateProcess` o
`ShellExecuteW` con `lpFile="C:\\windows\\system32\\winebrowser.exe"` y
`lpParameters="obsidian://open"`) el binario `winebrowser.exe` que Wine/Proton ya trae
puesto, pasándole la URI como argumento.

### 4.5 Repetido con el binario de Proton real (el que usa GW2)

`GW2` (appid `1284210`) está configurado para `GE-Proton11-7-x86_64`
(`compatibilitytool.vdf` de `~/.local/share/Steam/compatibilitytools.d/GE-Proton11-7`).
Se repitió §4.3 (con la clave de registro puesta otra vez) usando el `wine` que trae ese
Proton, apuntando al **mismo** prefijo desechable (nunca al `compatdata/1284210/pfx` real):

```
WINEPREFIX=<scratchpad>/h18-27/wineprefix-wine \
WINESERVER=.../GE-Proton11-7/files/bin/wineserver \
.../GE-Proton11-7/files/bin/wine loader.exe
```

Resultado idéntico a §4.3: `handle=0x21` en las tres vías, control negativo en `0x1f`, y
`journalctl` muestra 3 nuevos `Received callback URL obsidian://open/` en la ventana
09:18:39–09:18:42. **Proton y Wine (versión de sistema) se comportan igual en este punto**:
ambos delegan en el mismo `winebrowser.exe`, que a su vez llama a `gio`/`xdg-open` del host.

## 5. Veredicto

**Funciona, con una condición.** Un proceso Windows dentro de Wine/Proton en esta máquina
Fedora **sí puede** hacer que el `obsidian://` del host abra/enfoque el Obsidian real
(flatpak) sin cerrarlo ni reiniciarlo, verificado con `journalctl` mostrando
`Received callback URL obsidian://open` cada vez, en Wine de sistema (11.0) y en el Proton
real del juego (GE-Proton11-7-x86_64). La condición: **`ShellExecuteW`/`start.exe` con la
URI a secas NO sirven** porque el esquema `obsidian` no tiene asociación por defecto dentro
de un prefijo Windows/Wine (nadie lo instaló ahí). Dos formas de resolverlo, ambas
verificadas:

- **(A)** registrar una vez, al arrancar el addon (o en su instalador), la clave
  `HKLM\Software\Classes\obsidian\shell\open\command = "C:\windows\system32\winebrowser.exe" "%1"`
  (mismo patrón que ya trae Wine para `http`), y después usar `ShellExecuteW` normal; o
- **(B, más simple, sin tocar el registro)** invocar directamente
  `C:\windows\system32\winebrowser.exe` con la URI como argumento (vía `CreateProcess` o
  `ShellExecuteW` apuntando a ese ejecutable), que ya viene incluido en cualquier
  prefijo de Wine/Proton.

Cualquiera de las dos hace de puente Windows→xdg-open del host; ninguna requiere instalar
nada nuevo ni tocar el prefijo del juego.

### Límite explícito

El caso Blish HUD en **Windows nativo** (sin Wine/Proton) no se puede probar desde esta
máquina Fedora: no hay un Windows real disponible en este entorno. Ahí el mecanismo sería
distinto (Windows resuelve `obsidian://` de forma nativa vía su propio
`HKCR\obsidian`, si Obsidian para Windows lo registra al instalarse — cosa que no se ha
verificado aquí). Queda como hipótesis sin medir, a comprobar en un Windows real o una VM
si se decide llevar esta vía a Blish HUD.

## 6. Estado del entorno tras la sonda

- El Obsidian real de David (PID base 54502) siguió abierto y sin cambios de bóveda en
  todo momento; `pgrep -af obsidian` devuelve el mismo recuento de procesos (12, incluyendo
  el MCP de Obsidian) antes y después de toda la sonda.
- El prefijo de Wine desechable (`<scratchpad>/h18-27/wineprefix-wine`) y sus binarios
  (`loader.c`, `loader.exe`, `registrar-obsidian.reg`) quedan en el scratchpad de la
  sesión, no en el repo; se puede borrar sin pérdida.
- `wineserver -k` ejecutado al final: no quedan procesos de Wine/Proton huérfanos.
- No se ha instalado ningún paquete del sistema ni tocado la instalación del juego ni del
  plugin.
