# SPEC: puente de avisos dentro del juego (Nexus y Blish HUD)

Escrito el 2026-09-03 a partir del análisis de arquitectura de esa fecha. Cubre H13.9 (addon de
Nexus) y H13.15 (módulo de Blish HUD). Esta es la especificación que lee la sesión que implementa;
no arrastra la conversación de diseño. El lote de avisos por API ya está publicado en la `0.1.22`;
esto añade un sexto canal al emisor existente.

## Lo que David pidió, con sus palabras

«Quiero que se vea mientras juego, por lo que el aviso tiene que saltar por encima de la ventana.»
«Voy a necesitar tanto nexus como blishhud.»

## Qué son los dos anfitriones

| | Nexus (Raidcore) | Blish HUD |
|---|---|---|
| Qué es | Cargador de addons de terceros. Se pone como `d3d11.dll` junto a `Gw2-64.exe` y carga DLL nativas **dentro del proceso del juego** | Aplicación .NET **aparte** que dibuja una ventana transparente encima del juego. Lee Mumble Link; no se inyecta |
| Addon = | Una `.dll` nativa (C/C++ o Rust con el crate `nexus`, API v6) en `<GW2>/addons/` | Un `.bhm` (ZIP con `manifest.json` + DLL de C#) en `Documents\Guild Wars 2\addons\blishhud\modules` |
| Cómo pinta un aviso | `AddonAPI_t.GUI_SendAlert(const char*)`; para algo mayor, `GUI_Register(RT_Render, cb)` con ImGui | `ScreenNotification.ShowNotification(mensaje, tipo, icono, duración)` |
| Estado en la máquina de David | **Instalado y corriendo**, medido: `Nexus 2026.2.17.1210`, API v6, 9 addons cargados, sesión de las 07:37 a las 08:24 del 3 sep 2026, bajo `GE-Proton11-5` con `WINEDLLOVERRIDES="d3d11=n,b"` | **No instalado.** No hay .NET ni mono en el host |
| Linux | Funciona (medido arriba). Un addon en Rust ya carga ahí: TaimiHUD aparece en su log | Su mantenedor, por escrito: «I am not actively pursuing any form of Linux support». Usa llamadas WinAPI para la transparencia y para que el teclado siga llegando al juego que Wine no implementa. Funciona con apaños de compositor, con teclado que a veces deja de pasar al juego |

No comparten un solo byte de binario. Lo que se comparte es **el emisor del plugin** y el contrato
del mensaje; cada anfitrión lleva su cliente delgado.

## Política de ArenaNet

La política de programas de terceros no distingue por anfitrión. El texto que aplica: «we are aware
that some utilities help players without affecting others… While, in general, we will not take
action on an account for the use of such a utility program or modification, action is subject to
ArenaNet's discretion», y «ArenaNet does not review, approve, or endorse any third-party program».

Consecuencia normativa, y es lo que fija el contrato: **el canal es de una sola dirección**. El
addon solo dibuja. Cualquier mensaje del addon hacia el plugin que pudiera desencadenar una acción
sacaría esto de «utility» y no se admite.

## Hechos medidos el 2026-09-03 en la máquina de David

| Qué | Resultado |
|---|---|
| TCP loopback desde dentro del contenedor de Proton al host | **OK.** Sonda C compilada con mingw, lanzada con `protontricks-launch --appid 1284210`, contra un listener de Node en el host: `reply=ack-from-host` con pressure-vessel activo |
| Listener dentro del sandbox Flatpak de Obsidian, alcanzable desde el host | **OK.** Servidor Python dentro del Flatpak, cliente fuera, puerto 47312: `HOST recibió: ack-from-flatpak` |
| Permisos del Flatpak de Obsidian (`md.obsidian.Obsidian` 1.13.7) | `shared=ipc;network`, `filesystems=home;…` |
| `/tmp` del host visto desde el Flatpak | **NO visible** (tmp privado). Ningún diseño puede usar `/tmp` |
| `$HOME` visto desde Proton | `Z:\home\…` OK |
| Node en el renderer de Obsidian, en producción | Plugins de su bóveda real ya hacen `require` de `fs`, `child_process`, `os`, `path` y `electron`. `tyrian-companion` ya hace `require("electron")` |
| Named pipes de Wine y AF_UNIX | **No cruzan.** Los pipes viven en wineserver y no salen del prefijo; AF_UNIX solo en Wine Staging 11.16, no en Proton estable |

**No medido todavía** (M0 del plan): `require('net').createServer` dentro de Obsidian. Se ha medido
`fs`, `child_process` y `electron`, que son la misma familia (nodeIntegration), pero `net` no se ha
ejecutado. Prueba de un minuto en la consola de desarrollador de Obsidian:

```js
require('net').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address()) })
```

Tampoco se ha medido Blish HUD bajo Proton en su máquina: exige instalar `dotnet48` en el prefijo
real del juego con winetricks más reglas de opacidad y foco del compositor.

## Decisiones tomadas

| Decisión | Valor |
|---|---|
| Anfitriones | Los dos. Nexus primero porque se puede verificar hoy en Linux; Blish después |
| Transporte | **TCP loopback, el plugin escucha y los addons conectan.** Un servidor, N clientes, sin ficheros en disco, sin polling, sin traducir rutas Linux→Wine. Puerto fijo configurable |
| Dirección | Una sola. Tras el `hello` del cliente, el plugin **deja de leer**; cualquier byte más cierra la conexión |
| Dos clientes a la vez | Broadcast: los dos lo pintan. Si molesta, el usuario desinstala uno |
| Secreto compartido | No en la v1. Loopback y datos mínimos |
| Lenguaje del addon de Nexus | Rust (crate `nexus` 0.12, `cdylib`), coherente con H8.3 y con TaimiHUD, que ya le funciona bajo Proton |
| Dónde viven los addons | Repos aparte: `tyrian-companion-nexus` y `tyrian-companion-blish`. Los guardarraíles de este repo rechazan binarios |
| `src/platform/` (H8) | **No se importa.** Se copia la *idea* del framer, no los módulos |

Plan de reserva si David prefiere que Obsidian no abra ningún puerto: fichero «outbox» JSON Lines
bajo `$HOME` que el addon sondea. Cuesta polling, rotación, dedupe y traducir rutas en cada
anfitrión, y deja los avisos en reposo en disco. Solo si él lo pide.

## Contrato del mensaje

Plugin → addon, una línea JSON por aviso, UTF-8, 512 bytes como máximo:

```json
{ "v": 1, "seq": 17, "kind": "valuable_loot",
  "name": "Mystic Coin", "quantity": 3, "totalCopper": 123456,
  "content": "Mystic Coin ×3 · 123456 copper" }
```

Addon → plugin, **exactamente una línea** al conectar, 128 bytes como máximo, y después el plugin
deja de leer:

```json
{ "v": 1, "client": "nexus", "clientVersion": "0.1.0" }
```

Reglas:

- `v` cerrado a `1`. El addon que reciba una versión mayor muestra «actualiza el addon» y no
  interpreta el resto.
- `kind` toma los cuatro valores de `AlertV1`: `valuable_loot`, `always_alert`, `sell_signal`,
  `hold_signal`. Solo elige color y título.
- `content` es la cadena que pintan **los dos** anfitriones tal cual, para que el usuario vea el
  mismo aviso y no dos productos.
- `seq` es un contador por proceso del plugin. **No** es `alertId`, que pertenece a la cola durable
  y lleva `accountRef` en su registro. Sirve al addon para deduplicar reconexiones.
- Claves de más o de menos: se descarta la línea, no se cierra la conexión.
- Sin cliente conectado, el canal falla en el informe del emisor; no encola ni reenvía. La cola
  durable de Obsidian ya guarda el histórico. No hay replay al conectar.

## Privacidad

**Viaja:** `v`, `seq`, `kind`, `name`, `quantity`, `totalCopper`, `content`.

**No viaja:** clave de API, `accountId`, `accountRef`, `alertId`, `reason`, `itemId`, snapshots,
`vaultId`, idioma, ni el texto del toast. El texto del toast (`alertBodyText` en `main.ts`)
incorpora `reason` traducido, que es exactamente la fuga que tuvo el webhook de la `0.1.22`.

Lo que lo impide estructuralmente, calcado del arreglo del webhook:

1. `alertIngamePayload(alert: AlertV1)` es la única función que construye el cuerpo y recibe
   **solo** `AlertV1`. Sin parámetro de cadena, un llamante con la frase del toast no tiene dónde
   ponerla.
2. Test de serialización sobre el cuerpo real: `Object.keys` exactas, y un fixture con
   `reason: 'skin_not_unlocked'` cuyo JSON no contiene `skin`, `unlock`, `account` ni el propio
   `reason`. Con control positivo: el test asevera primero que la frase compuesta **sí** contiene el
   dato sensible, para que la sonda no pase por no encontrar nada.
3. `listen` solo en `127.0.0.1`; en otra interfaz falla cerrado, como el `https:` del webhook.
4. `kind` sí viaja: distingue botín de precio y no describe la colección del jugador
   (`always_alert` no dice por qué). Es el único campo negociable si David quiere el mínimo
   absoluto.

## Hueco de cobertura que hay que cerrar a propósito

`src/security-boundary.test.ts` censa `requestUrl`, `fetch`, `WebSocket` e imports HTTP, pero
`HTTP_IMPORT_PATTERN` solo casa `node:https?`, axios y undici: **`node:net` no lo casa ningún
patrón**, y un fichero llamado `alert-ingame-*.ts` tampoco cae en las listas `FUTURE_OUTBOUND_*`
(analytics, backup, diagnostic, export, mumble, report, share, support, sync, telemetry, uploader).

El canal nuevo tiene que **entrar en el censo a propósito** (un `REVIEWED_NET_IMPORT_FILES` con
patrón `node:net|net`), no colarse por el hueco. Si el implementador no lo añade a mano, el
guardarraíl queda en verde sin cubrirlo.

## Reparto

**En este repo:** un sexto canal `ingame` en `src/alerts/`, mismo patrón que `alert-webhook.ts`.

- `alert-ingame.ts` (puro): `alertIngamePayload(alert)` y `alertIngameContent(alert)`.
- `alert-ingame-server.ts` (E/S): `createServer` en `127.0.0.1:<puerto>`, framer de línea (`\n`),
  broadcast a todos los clientes, reintento de `listen` si el puerto está ocupado.
- Cableado en `buildAlertEmitter` (`src/main.ts:1977`): `id: 'ingame'`; `deliver` lanza si hay cero
  clientes conectados, para que el informe diga `failed` y el usuario sepa que el juego no estaba
  escuchando. Ajustes: interruptor y puerto. `ALERT_CHANNEL_IDS` pasa a seis.
- Docs: `PLATFORM_POLICY.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `THREAT-MODEL.md`.

**En cada repo de addon:** conectar, reconectar con backoff saturado (`[250, 500, 1000, 2000,
5000]` ms, la tabla de H8 sirve), parsear, mostrar. Nada más: cero llamadas a la API de GW2, cero
lectura de Mumble, cero escritura hacia el plugin salvo el `hello`.

**Sobre `src/platform/` (H8):** reutilizable como referencia el framer incremental
`MumbleV2RecordFramer`, la tabla de backoff y la disciplina de claves exactas. No reutilizable como
módulos: `mumble-v2-codec.ts` importa el contrato Mumble, el cliente H8.6 modela los roles al revés
(helper servidor, plugin cliente) con bootstrap, token, nonce y heartbeat a 500 ms, y cualquier
import desde ahí arrastraría el canal nuevo al censo `mumble` del test de frontera y al modelo de
amenazas de H8. Framer de línea nuevo, unas 60 líneas, y H8 no se toca.

## Milestones

| M | Pieza | Criterio de cierre | Estimación (mi reloj: limpio / con una vuelta más) |
|---|---|---|---|
| M0 | Medir `net` en la consola de Obsidian | Una línea de resultado escrita aquí | 10 min / 30 min |
| M1 | `alert-ingame.ts` puro + test de privacidad + censo en `security-boundary.test.ts` | `tsc --noEmit` limpio, gate verde, test negativo que mete `reason` y falla | 2 h / 4 h |
| M2 | Servidor loopback, canal `ingame` en `buildAlertEmitter`, ajustes, test de cableado, docs | Gate verde; con `nc 127.0.0.1 <puerto>` se ve la línea al disparar un aviso | 3 h / 6 h |
| M3 | Addon de Nexus en Rust (repo nuevo) | Compila a PE; su Nexus lo carga (línea en el log); un aviso lanzado desde Obsidian se ve dentro del juego bajo Proton | 1 día / 2 días |
| M4 | Módulo de Blish HUD en C# (repo nuevo) | Compila; la verificación en Linux depende del riesgo 1 | 0,5 día de código / 1 a 3 días de instalación y QA en su máquina, sin garantía |
| M5 | QA humana: ventana sin bordes y pantalla completa, reconexión al reiniciar Obsidian, juego arrancado antes que Obsidian | Protocolo en `docs/QA-MVP.md` | 1 h / 2 h |

## Riesgos, por orden

1. **Blish HUD en Linux no lo soporta su autor.** Exige tocar el prefijo real del juego (dotnet48)
   más reglas de compositor, y el teclado puede dejar de llegar al juego. Un cliente que no se puede
   verificar en la plataforma primaria no debería bloquear el lote: M4 va detrás de M3 y su QA se
   hace donde se pueda.
2. **Puerto ocupado o cambiado**: sin descubrimiento, un puerto distinto en cada lado es silencio.
   Lo tapa que el informe del emisor marque `failed` y que los ajustes muestren «clientes
   conectados: nexus».
3. **Cualquier proceso local puede conectar** al puerto y leer los avisos. Los datos son mínimos
   (nombre, cantidad, valor). Un secreto compartido cuesta teclearlo dentro del juego.
4. **El censo de red del repo no ve `node:net`** (sección de arriba).
5. **Toolchain**: no hay .NET ni mono en la Fedora; el módulo de Blish se compila en el Mac o en
   Windows. Rust para Windows necesita `rustup target add x86_64-pc-windows-gnu` (mingw ya está).
6. **Nexus se actualiza solo** y la API v6 puede subir. El addon declara su `APIVersion` y Nexus lo
   rechaza limpiamente si cambia.
7. Steam puede aislar `/tmp` distinto que protontricks. Ningún diseño usa `/tmp`.

## Lo que este lote NO hace

No lee Mumble Link ni NexusLink. No inspecciona memoria ni proceso del juego. No manda nada del
addon al plugin salvo el `hello`. No automatiza ninguna acción dentro del juego. No saca la capa H8
del árbol. No mete binarios en este repo.

## Fuentes

- [Nexus.h, API v6 (`GUI_SendAlert`, `GUI_Register`)](https://raw.githubusercontent.com/RaidcoreGG/RCGG-lib-nexus-api/main/Nexus.h)
- [Plantilla oficial de addon de Nexus](https://github.com/RaidcoreGG/GW2Nexus-AddonTemplate)
- [`nexus-rs`, bindings de Rust](https://github.com/Zerthox/nexus-rs)
- [Blish HUD, discusión 873 sobre Linux](https://github.com/blish-hud/Blish-HUD/discussions/873)
- [Blish HUD, cómo funciona](https://blishhud.com/docs/user/faqs/how-does-bhud-work/) y
  [el paquete `.bhm`](https://blishhud.com/docs/modules/overview/bhm/)
- [Blish HUD con Proton en Linux (gist)](https://gist.github.com/martinlabate/c4e6f08880a009f88dc1edaa4c6cd87a)
- [ArenaNet, Policy: Third-Party Programs](https://help.guildwars2.com/hc/en-us/articles/360013625034-Policy-Third-Party-Programs)
- [Obsidian, Node y Electron solo en escritorio](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
