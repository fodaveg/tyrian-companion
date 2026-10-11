# HP-02: candado de vida con dos procesos de Hebra en Fedora, 11 oct 2026

Máquina: Fedora 44 (Linux 7.2.9). Hebra rpm `0.2.0-21` (compilada el 10 oct a las 22:57),
libwebkit2gtk-4.1 2.54.1. Tyrian Companion 0.6.45 (los tres ficheros del build atestado `88f1ff4b`; sus
SHA-256 coinciden con los de su `hebra.json`). Medición del 11 oct, 09:44 a 09:54. Solo medición: no se
escribió en ningún repo. Lo LEÍDO viene del `88f1ff4b` local de Tyrian y de `6acdd876` del repo `hebra`
(solo lectura).

**Resultado: MEDIDO.** Los Web Locks no cruzan procesos de Hebra en Linux, pero la rpm 0.2.0-21 ya no deja
dos Hebras vivas sobre la misma biblioteca (`flock` de instancia), y tras un SIGKILL la Hebra reabierta
tiene libre el candado de la muerta en 0,6 s. El candado de vida se queda (no hace falta `locks: null`).

Convención: MEDIDO es lo observado en un proceso real; LEÍDO, lo que dice el código; INFERIDO, lo que se
deduce de ambos.

## 1. ¿Dos procesos de Hebra sobre la misma carpeta ven el Web Lock del otro?

**No: el candado es de cada proceso (MEDIDO).**

| Montaje | Resultado |
|---|---|
| Hebra real, dos procesos sobre la misma biblioteca (candado de instancia forzado a fallar) | A toma `tyrian-companion-lease:wl1:hp02-hebra-real`. A, mismo proceso (control positivo): `held`. B con `ifAvailable`: `free`, y `query().held` = `[]` |
| Mismo montaje, IndexedDB | Sí es el mismo: B lee la marca que acaba de escribir A |
| Tyrian 0.6.45 cargado de verdad en los dos | Cada uno tiene su candado de vida (`wl1:85f2958d…` y `wl1:e78199bf…`); ve el suyo `held` (control positivo) y el del otro `free`. Los dos tienen abiertas las mismas bases `tyrian-companion-session-runtime:*` |
| Sonda mínima en Python con gi sobre la misma libwebkit2gtk-4.1 2.54.1, dos procesos sobre la misma carpeta | El que mira ve `free` |
| Misma sonda, dos vistas en un solo proceso (cada una con su `WebKitWebProcess`) | `held` |

WebKitGTK comparte los candados dentro de un proceso de interfaz y no entre procesos.

### Pero Hebra 0.2.0-21 no deja dos procesos sobre la misma carpeta (MEDIDO)

Hebra trae su propio candado de instancia: un `flock` en `<datos>/instancia.lock`, del commit `4ffba0d5` de
`fodaveg/hebra`. Está en el binario (`strings` da `instancia.lock` y «Ya hay otra Hebra abierta con esta
biblioteca.»). Con la primera viva, el segundo arranque:

- no abre `hebra.sqlite3` y no crea ningún proceso de WebKit;
- pasados 8 s de espera, enseña el diálogo y escribe «Ya hay otra Hebra abierta con esta biblioteca. No se abre
  otra.».

Esto se midió con el bus de D-Bus roto, que es el caso en que el plugin de instancia única falla. Con un bus
que funciona, el segundo arranque le pasa los argumentos al primero y sale (LEÍDO en `linux_single_instance.rs`;
no se midió para no hablar con la Hebra de David).

Dos procesos vivos solo son posibles si el candado de instancia no se puede usar (`Claim::Unavailable`: el
fichero no se abre o el `flock` da un error que no es «ocupado»). Entonces Hebra arranca igual y lo dice por
`stderr` (LEÍDO). Se provocó haciendo de `instancia.lock` un directorio: los dos logs dicen «No se pudo usar
el candado de instancia (is a directory): sigue el arranque sin él.» Las medidas de los dos procesos de arriba
son con ese candado anulado.

## 2. SIGKILL al proceso que tiene el candado

**El otro lo toma enseguida (MEDIDO).** Todas las marcas salen de la concesión o de `/proc`, no de un
temporizador de la página. Ventanas visibles en todas las medidas (`document.visibilityState` = `visible`; las
de la sonda en Python son `Gtk.OffscreenWindow` y también dicen `visible`).

| Paso tras el SIGKILL de la Hebra que tiene la biblioteca | Tiempo |
|---|---|
| Mueren sus hijos (red, web, glycin) | hasta 103 ms |
| Una segunda Hebra que esperaba en el `flock` abre `hebra.sqlite3` | +171 ms (`b2`), +228 ms (`t2`), +207 ms (`t6`) |
| Nace la página de la nueva Hebra (`performance.timeOrigin`) | +323 ms |
| `navigator.locks.request(<candado de la Hebra muerta>)` bloqueante, sin `ifAvailable` | concedido a +597 ms, 0 ms de espera desde que se pidió |
| Tyrian de la nueva Hebra tiene su propio candado de vida | hasta +834 ms (cota superior por sondeo) |

La primera y la última fila son de `t6`; la medida de `t2` es la anterior. La nueva Hebra empieza con un
registro de candados vacío: el candado de la muerta no existe en ella, así que nunca está «tomado».

Dentro de un mismo proceso, al matar con SIGKILL el `WebKitWebProcess` de la vista que tiene el candado, la
petición bloqueante que esperaba en la otra vista se concede **+5 ms** después (sonda en Python).

**No medido:** que Tyrian TOME el arriendo de la sesión, ni los eventos `life_lock_*`, `taken` y `refused` del
registro local. El candado se pide al construir el coordinador, al activar el plugin y sin clave: se midió que
aparece `tyrian-companion-lease:wl1:<uuid>` sin clave. Pero `life_lock_proven`/`unmarked` se apunta en
`settleLife()`, que solo corre en la primera adquisición de un arriendo, y para eso hace falta una sesión; las
sesiones piden la API de GW2 con clave y no se usó la de David. Por el código (LEÍDO), el que reabre tomaría el
arriendo cuando el dueño lleve 15 s sin renovar (`DEAD_OWNER_SILENCE_MS`) y no al vencer el TTL, porque
encuentra libre el candado del dueño marcado (INFERIDO).

## 3. ¿Hay que pasar `locks: null`?

**No (INFERIDO de las medidas 1 y 2).** El caso peor que temía el código («two live Hebras would each see the
other's lock free») es real, pero Hebra no lo deja ocurrir en Linux en un uso normal: el `flock` mantiene un
solo proceso por carpeta de datos, haya o no bus de D-Bus; con la Hebra anterior saliendo o colgada, el segundo
arranque espera hasta 8 s y, si no muere, no abre la biblioteca. Matar la Hebra y reabrirla es justo el caso
que el candado de vida quiere acelerar, y funciona.

Riesgo residual, real pero estrecho:

- Si el `flock` no se puede usar (`Unavailable`), Hebra arranca sin él y dos procesos comparten IndexedDB sin
  verse los candados: solo protege la regla de los 15 s.
- Lo mismo con las Hebras de Linux anteriores a `4ffba0d5`, que Tyrian no puede distinguir porque su API no
  expone la versión de Hebra. No comprobado.
- **Windows:** sin medir.

El comentario de `src/host/hebra/hebra-host.ts` (`HebraHostDeps.locks`) decía que solo en macOS se descarta un
segundo proceso; se reescribe con esto. Decisión del coordinador: el candado de vida se queda.

## Cómo se aisló la Hebra de prueba

Un script de lanzamiento arrancaba `/usr/bin/hebra` así:

- dentro de `systemd-run --user --scope -p MemoryMax=3G`;
- con `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` y `XDG_STATE_HOME` bajo una carpeta de pruebas propia
  (una por Hebra);
- con `DBUS_SESSION_BUS_ADDRESS` apuntando a un socket que no existe, para que ningún arranque llegara por D-Bus
  a la Hebra de David ni le trajera la ventana al frente;
- con `NO_AT_BRIDGE=1` y `GTK_USE_PORTAL=0`.

Guardaba el PID y los procesos se mataron con `kill -KILL` sobre el PID guardado, comprobando antes que
`/proc/<pid>/comm` fuera `hebra`.

- Arranque corto de comprobación: todo lo que escribió cayó en la carpeta de pruebas (`library-v1/hebra.sqlite3`,
  `localstorage`, `instancia.lock`…); los descriptores abiertos de Hebra y de sus hijos no apuntaban fuera de
  ella salvo `/dev`, `/usr` y dmabuf; ningún fichero de Hebra en `$HOME` cambió.
- Inspector: `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:948x` en cada Hebra de prueba. Un script de Node propio
  evaluaba JS en su página por el protocolo de WebKit (`Target.sendMessageToTarget`, luego `Runtime.evaluate` y
  `Runtime.awaitPromise`). No se instaló ninguna herramienta.
- Tyrian en la Hebra de prueba: se copiaron los tres ficheros a `<datos>/plugins/tyrian-companion/0.6.45/` y se
  escribió `plugins/installed.json` con la forma de `record_for` (`source.listed: true`), sin red. Por el
  inspector se puso `hebra.plugins.third-party-enabled = true` y `hebra.library-v1.modules =
  {"tyrian-companion": true}`; en el documento `hebra.library-v1.plugins-sync:*` se puso `enabled: true` (sin
  eso la conciliación lo dejaba en `false`). Tras recargar la página, Tyrian se activó con su candado de vida.
- Sonda propia en Python (roles `holder`, `watcher` y `both`, ventanas fuera de pantalla), lanzada con el mismo
  scope y el mismo bus roto.

## Constancia: la Hebra de David no se tocó

- Su PID 158277 (`/usr/bin/hebra`, arrancado a las 07:14:55) estaba vivo al empezar, durante y al cerrar.
- `~/.local/share/net.fodaveg.hebra/library-v1/hebra.sqlite3` tenía el mismo mtime y tamaño antes y después
  (`08:45:58.668731349`, 146673664), y también `-wal` (09:41:58.407674858, 43161152) y `-shm`
  (09:41:58.410674941). Al cerrar, solo el 158277 la tenía abierta.
- Su puerto 127.0.0.1:47823 siguió siendo del 158277. `~/.config/mimeapps.list` y
  `~/.local/share/applications` no cambiaron.
- En su carpeta solo cambió `diagnostico.jsonl` (mtime 09:54:00), después de morir todos los procesos de la
  prueba (09:53:55), así que lo escribió su propio proceso (INFERIDO). Ningún proceso de la prueba tuvo abierto
  nada fuera de su carpeta.
- Todos los PID de la prueba están muertos y no queda ningún scope `hp02-*`.
- Ventanas: las de prueba salieron en el escritorio de David, y la de `b1B` enseñó unos 15 s el diálogo «Ya hay
  otra Hebra…» antes de matarla. A la ventana de David no se le mandó nada: bus roto en todos los arranques.

## Limpieza y límites

Se borraron las carpetas de datos de prueba (17 MB en tmpfs, con las copias de los ficheros de Tyrian). No se
hizo el aprovisionamiento del árbol de Tyrian (sin `fetch`, `merge` ni `npm install`): es una medición de solo
lectura que no compila nada. No medido: Windows, Hebras de Linux anteriores a `4ffba0d5`, y la toma del arriendo
de sesión por Tyrian con clave.
