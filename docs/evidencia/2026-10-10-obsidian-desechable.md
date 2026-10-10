# Obsidian desechable, 10 oct 2026 (lote H): evidencia parcial y parada

Máquina: Fedora 44 (Linux 7.2.9-200.fc44.x86_64). Base: `52fa782c` (= `origin/main` al empezar).
Release medida: la GitHub Release `0.6.35` publicada.

**Resultado: medición PARCIAL, detenida a mitad.** La primera apertura salió bien (RT-03 primera
carga, RT-13 completo, y la mitad de RT-15 antes del `kill -9`), pero la segunda instancia flatpak
**no queda aislada de la de David**: comparte el directorio de ejecución por aplicación de flatpak y,
al arrancar, sustituyó el socket del CLI de Obsidian de David por el suyo. Por eso no se reabrió y
quedan sin medir la reapertura de RT-03 y la comprobación de RT-15 tras reabrir.

## Versiones

`curl http://127.0.0.1:9333/json/version` sobre la instancia desechable:

```
"Browser": "Chrome/150.0.7871.250",
"User-Agent": "... obsidian/1.14.4 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36",
"V8-Version": "15.0.245.31",
```

Flatpak `md.obsidian.Obsidian` 1.14.4 (instalación de sistema, runtime `org.freedesktop.Platform` 26.08).

## Instalación de la release

```
gh release download 0.6.35 -R fodaveg/tyrian-companion -D <scratch>/lote-h/release
sha256sum -c tyrian-companion-0.6.35.zip.sha256
  -> tyrian-companion-0.6.35.zip: La suma coincide
node scripts/install-beta.mjs install --archive <release>/tyrian-companion-0.6.35.zip \
  --vault <scratch>/lote-h/boveda --confirm-obsidian-closed
  -> beta channel v1: PASS (installed none -> 0.6.35; files=manifest.json,main.js,styles.css)
```

`scripts/install-beta.mjs` sirve tal cual para una bóveda arbitraria (solo pide que exista
`<bóveda>/.obsidian`). Los tres ficheros instalados tienen el mismo sha256 que los assets sueltos de
la release (`main.js` 26eefb8f…, `manifest.json` c4d05175…, `styles.css` cf8eaa04…). El plugin se
activó con `community-plugins.json` = `["tyrian-companion"]`.

## Cómo se lanzó la instancia desechable

Se saltó el wrapper `obsidian.sh` del flatpak porque, con `OBSIDIAN_CLEAN_CACHE=1` (valor del
flatpak), borra `${XDG_CONFIG_HOME}/obsidian/GPUCache`, que es el perfil de David, y rehace symlinks de
Discord en el runtime compartido:

```
systemd-run --user --scope -q -p MemoryMax=2G --unit=lote-h-obsidian-run1 \
  flatpak run --command=zypak-wrapper --filesystem=<scratch>/lote-h \
    --env=XDG_CONFIG_HOME=... --env=XDG_DATA_HOME=... --env=XDG_CACHE_HOME=... --env=XDG_STATE_HOME=... \
    --unset-env=TMPDIR \
    md.obsidian.Obsidian /app/obsidian --ozone-platform-hint=auto \
    --enable-features=WaylandWindowDecorations \
    --user-data-dir=<scratch>/lote-h/perfil --remote-debugging-port=9333
```

- Un primer intento con `TMPDIR` dentro del scratchpad murió al arrancar:
  `FATAL:...process_singleton_posix.cc:335] Socket path too long: .../lote-h/tmp/scoped_dirAI99tk/SingletonSocket`.
- flatpak saca los procesos del scope de `systemd-run`: los mete en sus propios scopes
  (`app-flatpak-md.obsidian.Obsidian-2529281331.scope` y, para el zigoto lanzado por el portal,
  `...-679178436.scope`). Se les puso `MemoryMax=2G` con `systemctl --user set-property --runtime`.
  Los de David están en scopes distintos (`...-3059415801` y `...-1804665798`).
- Las `--env=XDG_*` **no surtieron efecto**: los directorios `xdg/*` del scratchpad quedaron vacíos.

La evaluación de código fue por CDP con un script de Node propio (`fetch` a `/json/list` y
`Runtime.evaluate` por `WebSocket`), nunca con `~/.local/bin/obsidian`.

## Aislamiento: lo que sí se demostró

- Proceso distinto: árbol propio `bwrap(245311)` → `obsidian(245629)` con renderer `245948`, todos
  con `--user-data-dir=<scratch>/lote-h/perfil`; los PID de David (`3999198 … 3999612`) siguieron
  vivos y con la misma hora de inicio (12:03:30–32) antes, durante y después.
- Perfil propio: Obsidian creó `id`, `obsidian.json`, `obsidian.log`, `IndexedDB`, `Local Storage`,
  `GPUCache` y `SingletonLock/Socket/Cookie` dentro de `<scratch>/lote-h/perfil`. La bóveda abierta por
  CDP: `app.vault.adapter.basePath` = `<scratch>/lote-h/boveda`, `app.appId` = `10ade1a0b0ed0a0e`.
- Sin reenvío: `obsidian.log` de David contiene 0 apariciones de `lote-h`; su `obsidian.json` sigue
  con su única bóveda. La salida de la instancia desechable no contiene `Received command line`
  (lo que el servidor de CLI escribe al recibir una orden), así que no le llegó ninguna orden por CLI
  durante su vida.

## Aislamiento: lo que FALLÓ (motivo de la parada)

1. **Socket del CLI de David sustituido.** El servidor de CLI de Obsidian hace, sin mirar el ajuste
   `cli`, `unlinkSync(T)` y `listen(T)` con
   `T = join(process.env.XDG_RUNTIME_DIR || homedir(), ".obsidian-cli.sock")`. Dentro del flatpak,
   ese directorio es el `xdg-run` POR APLICACIÓN, compartido por todas las instancias de
   `md.obsidian.Obsidian`:

   ```
   antes : 16228 1791626613 1791626613 /run/user/1000/.flatpak/md.obsidian.Obsidian/xdg-run/.obsidian-cli.sock
   después: 18517 1791660523 1791660523 (mismo path; nacido a las 21:28:43, el arranque de la desechable)
   ```

   `ss -xlp` después de matar la desechable: el proceso de David (`pid=3999244, fd=49`) sigue
   escuchando en `/run/user/1000/.obsidian-cli.sock`, pero ese fichero ya no es el suyo: ahora es el
   socket muerto de la desechable. **El CLI de Obsidian de David, y con él el MCP `obsidian` que lo
   invoca (`obsidian-mcp/dist/cli.js` hace `spawn("obsidian", …)`), no llega a su instancia hasta que
   David recargue el servidor de CLI (desactivar y activar el CLI en Ajustes) o reinicie Obsidian.**
   Entre las 21:28:43 y las 21:30:32 (de 19:28:43 a 19:30:32 UTC) ese CLI apuntaba a la instancia desechable.
2. **Caché por aplicación compartida.** Mesa tocó `~/.var/app/md.obsidian.Obsidian/cache/mesa_shader_cache/marker`
   (21:27:59, intento fallido) y `.../radv_builtin_shaders/marker` (21:28:43, arranque bueno). Son
   marcadores de caché de shaders, sin datos de David, pero es una escritura en su `~/.var/app`.
   En `~/.var/app/.../config/obsidian/` cambiaron también `GPUCache/data_1` y `Dawn*Cache/data_1` a las
   21:28:52; la desechable escribió los suyos en su perfil (21:28:43 y 21:29:36), así que lo más
   probable es que los de David sean de su propia instancia, pero no se puede atribuir con certeza.
   `Cache_Data` y `TransportSecurity` siguieron cambiando después de matar la desechable: son de David.

Conclusión: **`flatpak run` del mismo app-id no da una instancia desechable segura mientras la de
David está abierta.** Para repetir, la instancia tiene que tener su propio `XDG_RUNTIME_DIR` de
verdad (por ejemplo, el binario fuera del flatpak con `XDG_RUNTIME_DIR` y `XDG_CACHE_HOME` propios y
`WAYLAND_DISPLAY` absoluto), demostrando antes con `stat` que el socket de David no cambia; o
medirse con la instancia de David cerrada. Ninguna de las dos se probó aquí.

## RT-03 · Carga y reapertura — PARCIAL

Primera apertura: la bóveda abre en modo restringido, como haría con cualquier usuario:

```
{"enabled":false,"enabledPlugins":["tyrian-companion"],"loaded":[],"manifests":["tyrian-companion"]}
```

Tras `await app.plugins.setEnable(true)` y pulsar «Confiar en el autor y activar complementos» en el
modal «¿Confía en el autor de esta bóveda?»:

```
{"modals":[],"enabled":true,"loaded":["tyrian-companion"],"ver":"0.6.35","ls":"true"}
```

`app.plugins.plugins['tyrian-companion']._loaded === true` y `manifest.version === "0.6.35"`. El plugin
escribió su `data.json` (`schemaVersion` 15, `vaultMark` nuevo).

**Sin medir:** la reapertura (no se volvió a lanzar, por lo explicado arriba).

`scripts/verify-beta-runtime.mjs` y `scripts/smoke-live.mjs` dependen del CLI (`spawnSync('obsidian', …)`,
`obsidian eval`): no se ejecutaron. Con la instancia de David abierta hablarían con ella.

## RT-13 · `navigator.locks` — MEDIDO

```
{"locksType":"object","query":{"held":[{"clientId":"1CA52C0F59AF2D2C048AAB2F39C51650","mode":"exclusive",
 "name":"tyrian-companion-lease:wl1:12758d76-56be-4335-9739-e2efc10d5c51"}],"pending":[]}}
```

`typeof navigator.locks === "object"` y `navigator.locks.query()` responde. Además, el plugin 0.6.35
ya tiene su candado de vida tomado nada más cargar (`tyrian-companion-lease:wl1:<uuid>`, del
`ActiveSessionLeaseCoordinator` construido en el arranque), sin clave de API.

## RT-15 · El candado muere con el proceso — MITAD

Tomado y comprobado justo antes de matar (21:30:29):

```
navigator.locks.request("tc-probe", () => new Promise(() => {}))
-> {"held":[{"clientId":"1CA5…","mode":"exclusive","name":"tc-probe"},
            {"clientId":"1CA5…","mode":"exclusive","name":"tyrian-companion-lease:wl1:12758d76-…"}],"pending":[]}
```

`kill -9` (21:30:32) de los 12 procesos propios: 245629, 245793, 245867, 245918, 245931, 245948,
245859, 245816, 245488, 245311, 245806, 245807 (245799 y el proxy D-Bus 245421/245433 ya habían
muerto con ellos). Después, `ps` no muestra ningún proceso con `lote-h`.

**Sin medir:** reabrir con el mismo perfil y comprobar que ni `tc-probe` ni
`tyrian-companion-lease:wl1:12758d76-…` aparecen en `navigator.locks.query()`. El perfil
(`<scratch>/lote-h/perfil`) queda intacto para hacerlo en cuanto haya un lanzamiento aislado.

## Extra · `life_lock_*` en el registro de diagnóstico — SIN MEDIR

No se llegó a poner el registro en «Depuración». Por el código, `life_lock_proven/unmarked/absent`
solo se registra en la primera adquisición de la reserva de sesión (`acquireInternal`), no al cargar,
así que al arrancar sin iniciar una sesión no debería aparecer; está sin comprobar en un cliente real.

## Procesos

- David, antes y después (vivos, misma hora de inicio): 3999198, 3999243, 3999244, 3999433,
  3999440, 3999508, 3999509, 3999587, 3999597, 3999612.
- Propios, todos muertos con `kill -9` por PID guardado, comprobado con `kill -0` y `ps`.
