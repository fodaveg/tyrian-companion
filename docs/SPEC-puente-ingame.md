# SPEC: puente con los addons del juego (Nexus y Blish HUD), protocolo v2

Escrito el 2026-09-03 para H13.9 (addon de Nexus) y H13.15 (módulo de Blish HUD); reescrito el
2026-09-24 para H18.22 (validar el saludo) y H18.23 (protocolo bidireccional y autenticado). Esta es
la especificación que lee quien implementa un cliente: con este documento se puede escribir el addon
de Nexus (Rust) o el módulo de Blish HUD (C#) sin leer el plugin. El lado del plugin vive en
`src/alerts/alert-ingame-protocol.ts` (contrato ejecutable), `alert-ingame-server.ts` (sockets) y
`alert-ingame-presence.ts` (presencia).

## Lo que David pidió y decidió, con sus palabras

3 sep 2026: «Quiero que se vea mientras juego, por lo que el aviso tiene que saltar por encima de la
ventana.» «Voy a necesitar tanto nexus como blishhud.»

24 sep 2026 (auditoría final, §9, decisiones aceptadas que no se reabren):

- **Marca solo.** El complemento marca el inicio y el fin de sesión sin confirmación; la hora se
  corrige después.
- **El contexto de juego lo leen los addons**, Nexus y Blish HUD con el **mismo** protocolo. El
  helper H8 se queda en `main` sin tocar y no es la vía viva.
- **El puente pasa a ser bidireccional y autenticado.**
- **Fuera del Laberinto, una sesión es toda la conexión al juego**; una desconexión de más de
  10 minutos la cierra.
- **Windows con Blish HUD tiene que funcionar** para los compañeros del clan.

## Qué cambia respecto a la v1

| | v1 (0.1.22 a 0.1.35) | v2 (este documento) |
|---|---|---|
| Dirección | Plugin → addon; del addon solo un `hello` | Las dos: avisos hacia el addon, contexto de juego hacia el plugin |
| Autenticación | Ninguna; cualquier proceso local podía conectar y leer avisos | Secreto compartido obligatorio en el `hello` |
| Cuándo cuenta un cliente | Al completar el TCP, antes de validar nada (H18.22) | Solo tras un `hello` válido y autenticado |
| Conexión muda | Contaba como «entregado» y no caducaba | No cuenta y se cierra a los 5 s |
| Líneas del plugin | Solo avisos, sin `type` | `welcome`, `alert` y `error`, todas con `type` |
| Reinicio de Obsidian | El addon deduplicaba por `seq` y descartaba avisos nuevos | Deduplicar por `(server, seq)`; `server` cambia en cada arranque |

Un addon v1 que conecte recibe `{"v":2,"type":"error","code":"version_unsupported"}` y la conexión
se cierra. Su propio contrato v1 ya le obliga a mostrar «actualiza el addon» ante una versión mayor.

## Qué son los dos anfitriones

| | Nexus (Raidcore) | Blish HUD |
|---|---|---|
| Qué es | Cargador de addons de terceros. Se pone como `d3d11.dll` junto a `Gw2-64.exe` y carga DLL nativas **dentro del proceso del juego** | Aplicación .NET **aparte** que dibuja una ventana transparente encima del juego |
| Addon = | Una `.dll` nativa (Rust con el crate `nexus`, API v6) en `<GW2>/addons/` | Un `.bhm` (ZIP con `manifest.json` + DLL de C#) en `Documents\Guild Wars 2\addons\blishhud\modules` |
| Cómo pinta un aviso | `AddonAPI_t.GUI_SendAlert(const char*)`; para algo mayor, `GUI_Register(RT_Render, cb)` con ImGui | `ScreenNotification.ShowNotification(mensaje, tipo, icono, duración)` |
| De dónde saca el contexto | `NexusLink.IsGameplay` y los datos de Mumble Link que Nexus comparte (`DL_MUMBLE_LINK`, identidad con el nombre del personaje) | `GameService.Gw2Mumble` (mapa y personaje) y `GameService.GameIntegration.Gw2Instance` (juego en marcha) |
| Plataformas | Linux con Proton: **medido** que funciona (3 sep 2026) | Windows: **tiene que funcionar** (decisión 5 del 24 sep). Linux: compatibilidad no acreditada en la plataforma de David (su mantenedor no persigue el soporte; transparencia y entrada con problemas bajo Wine, discusión 873) |

Los nombres de API de la fila «de dónde saca el contexto» son la referencia para empezar; se
comprueban contra la versión del SDK que se compile. Lo que fija este documento es **qué** se envía
y **cuándo**, no cómo lo obtiene cada anfitrión.

No comparten un solo byte de binario. Lo que se comparte es el servidor del plugin y este contrato;
cada anfitrión lleva su cliente delgado.

## Política de ArenaNet

La política de programas de terceros no distingue por anfitrión: «we are aware that some utilities
help players without affecting others… While, in general, we will not take action on an account for
the use of such a utility program or modification, action is subject to ArenaNet's discretion», y
«ArenaNet does not review, approve, or endorse any third-party program».

La v1 se quedaba dentro de «utility» haciendo que el addon solo dibujara. La v2 sigue dentro por lo
que el addon **no** hace, que es lo que ArenaNet mira:

- no simula entrada, no pulsa teclas, no automatiza nada dentro del juego;
- no lee memoria del proceso: solo los datos que su anfitrión ya expone a todos los addons (mapa,
  personaje, si hay gameplay), los mismos que usan los overlays habituales;
- lo que el plugin hace con ese contexto ocurre **fuera** del juego: marcar una sesión en las notas
  del usuario. Nada del plugin vuelve al juego salvo el texto de un aviso.

Un mensaje del addon que pidiera una acción (un comando, una consulta, un «empieza la sesión») no
existe en el protocolo: las claves son cerradas y cualquier campo de más cierra la conexión.

## Hechos medidos el 2026-09-03 en la máquina de David

| Qué | Resultado |
|---|---|
| TCP loopback desde dentro del contenedor de Proton al host | **OK.** Sonda C compilada con mingw, lanzada con `protontricks-launch --appid 1284210`, contra un listener de Node en el host: `reply=ack-from-host` con pressure-vessel activo |
| Listener dentro del sandbox Flatpak de Obsidian, alcanzable desde el host | **OK.** Servidor Python dentro del Flatpak, cliente fuera, puerto 47312: `HOST recibió: ack-from-flatpak` |
| Permisos del Flatpak de Obsidian (`md.obsidian.Obsidian` 1.13.7) | `shared=ipc;network`, `filesystems=home;…` |
| `/tmp` del host visto desde el Flatpak | **NO visible** (tmp privado). Ningún diseño puede usar `/tmp` |
| `$HOME` visto desde Proton | `Z:\home\…` OK |
| Named pipes de Wine y AF_UNIX | **No cruzan.** Los pipes viven en wineserver y no salen del prefijo; AF_UNIX solo en Wine Staging 11.16, no en Proton estable |

**Sin medir todavía:** abrir la app de Obsidian (Flatpak) desde un addon que corre dentro de Proton
(decisión 1 del 24 sep, «si empiezo a jugar y está cerrado, que se abra»). Hace falta una prueba
corta antes de prometerlo; este protocolo no depende de ello.

## Transporte

| Qué | Valor |
|---|---|
| Quién escucha | El plugin. Servidor TCP en `127.0.0.1` exclusivamente; nunca otra interfaz |
| Puerto | El de los ajustes del plugin, 1024-65535, por defecto **47823**. El addon lo tiene en sus propios ajustes con el mismo valor por defecto |
| Quién conecta | El addon, en cuanto carga, y de nuevo tras cada desconexión |
| Reintento | Backoff saturado `[250, 500, 1000, 2000, 5000]` ms; tras el último, cada 5 s. Se reinicia al recibir un `welcome`. **No se reintenta** tras `auth_rejected` o `version_unsupported` hasta que el usuario cambie los ajustes del addon |
| Codificación | Cada mensaje es **un objeto JSON en UTF-8 en una sola línea** terminada en `\n` |
| Tamaño | **512 bytes como máximo por línea, sin contar el terminador**, en las dos direcciones |
| Tolerancia | El plugin acepta `\r\n` (un `StreamWriter.WriteLine` de C# en Windows escribe eso). No acepta BOM, UTF-8 inválido, algo que no sea un objeto, contenido tras el objeto ni claves repetidas |

## Autenticación

**Mecanismo:** un secreto compartido por instalación del plugin, que el usuario copia una vez en los
ajustes de cada addon.

- En los ajustes del plugin, fila «Token del addon»: el botón **Copiar token** copia al portapapeles
  el secreto elegido; si no hay ninguno utilizable, genera uno (32 bytes de un CSPRNG, 43 caracteres
  base64url) y lo guarda en el **SecretStorage de Obsidian** con el nombre `tyrian-companion-ingame`.
  El usuario también puede elegir otra entrada del SecretStorage.
- El plugin acepta secretos de **32 a 128 caracteres ASCII imprimibles, sin espacios**. Uno más corto
  o vacío equivale a «sin secreto», y entonces **todos** los `hello` se rechazan: no hay modo abierto.
- El addon guarda el valor en su configuración (Nexus: un fichero en su carpeta de addon; Blish: un
  `SettingEntry` del módulo) y lo envía en el campo `token` del `hello`, nada más.
- El plugin lo compara en tiempo constante y no lo guarda en ajustes (`data.json` solo tiene el
  nombre de la entrada), ni en logs, ni en la bóveda. **El addon no debe escribirlo en su log.**
- Rotar el secreto: borrar o cambiar la entrada en el SecretStorage y volver a pulsar «Copiar token»;
  los addons con el valor anterior reciben `auth_rejected`.

Por qué este y no otro, contra [`THREAT-MODEL.md`](THREAT-MODEL.md):

- **Fichero compartido en disco:** descartado. Exige traducir rutas Linux→Wine en cada anfitrión, el
  `/tmp` del Flatpak no es el del host, y deja el secreto en reposo en un fichero que cualquier
  proceso del usuario lee.
- **Token por proceso como H8.4:** imposible aquí. En H8 el plugin lanza el helper y le pasa el token
  por stdin; aquí el addon lo carga el anfitrión del juego y el plugin no tiene ningún canal previo
  hacia él.
- **Secreto por instalación en SecretStorage:** el mismo almacén que la clave de API, por dispositivo
  y fuera de `data.json` (que Obsidian Sync podría copiar). Pegarlo una vez es el coste; cambia la
  amenaza «cualquier proceso local lee los avisos y, ahora, inyecta contexto» por «un proceso local que
  ya lee la configuración del addon o la memoria del usuario». Es el mismo límite que declara el
  modelo de amenazas frente a malware local.

## Mensajes del addon al plugin

Toda línea lleva `"v": 2` y un `type`. Las claves de cada tipo son **exactas**: ni una más ni una
menos, o el plugin cierra la conexión.

### `hello`: la primera línea, en menos de 5 s

```json
{"v":2,"type":"hello","client":"nexus","clientVersion":"0.2.0","instance":"q8Hq3n2t0dQyYf0nJ1p0Aw","token":"<token>"}
```

| Campo | Regla |
|---|---|
| `client` | `"nexus"` o `"blish"` |
| `clientVersion` | 1 a 32 caracteres de `[0-9A-Za-z.+-]` |
| `instance` | 16 bytes aleatorios en base64url sin relleno (22 caracteres), generados **una vez por proceso del addon** y reutilizados en cada reconexión de ese proceso |
| `token` | El secreto copiado desde Obsidian, tal cual (en los ejemplos, `<token>`) |

Sin `hello` válido y autenticado en 5 s, el plugin cierra con `hello_timeout`. Mientras tanto la
conexión **no cuenta** como cliente y no recibe avisos.

### `context`: el estado del juego, completo

```json
{"v":2,"type":"context","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":0,"state":"gameplay","mapId":866,"character":"Astra Uno"}
```

| Campo | Regla |
|---|---|
| `nonce` | El del `welcome` de **esta** conexión |
| `seq` | Empieza en `0` tras cada `welcome` y sube exactamente de 1 en 1, compartido entre `context`, `heartbeat` y `bye` |
| `state` | `"gameplay"` (personaje en el mundo), `"loading"` (pantalla de carga), `"character_select"` (selección de personaje o login) |
| `mapId` | Entero 1-2147483647 del mapa actual, o `null` si el anfitrión no tiene mapa. **866** es el Laberinto del Rey Loco |
| `character` | Nombre del personaje, 1-32 caracteres, sin espacios al principio ni al final ni caracteres de control, o `null` |

Es una **foto completa**, no un delta: repetirla no cambia nada (idempotente). Se envía justo después
del `welcome` y cada vez que cambie alguno de los tres campos. No se envía nada más del juego:
ni coordenadas, ni cámara, ni combate, ni cuenta, ni botín.

### `heartbeat`: sigo aquí

```json
{"v":2,"type":"heartbeat","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":5}
```

Si en `heartbeatIntervalMs` (5000, llega en el `welcome`) no se ha enviado ninguna línea, se envía un
`heartbeat`. Un `context` también cuenta. Tras **15 s** sin ninguna línea válida el plugin cierra con
`liveness_timeout` y lo trata como pérdida de presencia.

### `bye`: me voy, y por qué

```json
{"v":2,"type":"bye","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":9,"reason":"game_exit"}
```

| `reason` | Cuándo |
|---|---|
| `game_exit` | **Solo** con evidencia positiva de que el juego se cierra. Nexus: el callback de `WndProc` ve `WM_CLOSE` o `WM_DESTROY` de la ventana del juego. Blish: el proceso de Guild Wars 2 ha terminado |
| `addon_unload` | El usuario desactiva el addon o el módulo, o se descarga sin saber si el juego sigue |

Tras un `bye` el addon cierra la conexión. Si no puede enviarlo (cuelgue, crash), no pasa nada: el
plugin lo trata como una pérdida con gracia.

## Mensajes del plugin al addon

### `welcome`

```json
{"v":2,"type":"welcome","server":"Pq0v4c3Wm9Xs1Ya7Tb2NeQ","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","heartbeatIntervalMs":5000}
```

`nonce` identifica esta conexión (época); cambia en cada conexión. `server` identifica este arranque
del servidor del plugin; cambia al reiniciar Obsidian o cambiar el puerto.

### `alert`

```json
{"v":2,"type":"alert","seq":17,"kind":"valuable_loot","name":"Mystic Coin","quantity":3,"totalCopper":123456,"content":"Mystic Coin ×3 · 12g 34s 56c"}
```

- `kind` toma uno de `valuable_loot`, `always_alert`, `sell_signal`, `hold_signal`; solo elige color y
  título.
- `content` se pinta **tal cual** en los dos anfitriones, para que el usuario vea el mismo aviso.
- `totalCopper` puede ser `null` (sin cotización).
- `seq` es un contador del plugin, independiente del `seq` del addon. **Deduplicar por
  `(server, seq)`**, no por `seq` solo: tras reiniciar Obsidian el contador vuelve a 1 con otro
  `server`. Este es el fallo del módulo de Blish 0.1.0, que descartaba los avisos siguientes.
- No hay replay: un aviso emitido sin ningún addon autenticado queda como fallido en el informe del
  emisor y en la cola durable de Obsidian, no se reenvía al conectar.

### `error`

```json
{"v":2,"type":"error","code":"auth_rejected"}
```

Es la última línea antes de que el plugin cierre. Lleva solo el código, nunca eco de lo recibido.

| `code` | Qué hacer en el addon |
|---|---|
| `auth_rejected` | Mostrar «token incorrecto: cópialo de nuevo desde Obsidian» y no reintentar hasta que cambie el ajuste |
| `version_unsupported` | Mostrar «actualiza el addon» y no reintentar |
| `hello_timeout`, `liveness_timeout` | Reintentar con backoff |
| `capacity` | Reintentar con backoff (ya hay 4 conexiones autenticadas). Aparte, con 4 conexiones sin `hello` pendientes, la siguiente se corta sin respuesta |
| `frame_length`, `frame_utf8`, `frame_json`, `frame_schema`, `nonce_mismatch`, `sequence_mismatch`, `unexpected_message` | Es un fallo del addon: registrarlo en el log del addon (sin el token) y reintentar |

### Tolerancia del addon

El addon **ignora** líneas del plugin con un `type` que no conozca y descarta las de `type`
conocido con claves de más o de menos, **sin cerrar**. Si recibe `"v"` mayor que 2, muestra
«actualiza el addon».

## Ejemplo completo

```text
addon  → {"v":2,"type":"hello","client":"blish","clientVersion":"0.2.0","instance":"q8Hq3n2t0dQyYf0nJ1p0Aw","token":"<token>"}
plugin → {"v":2,"type":"welcome","server":"Pq0v4c3Wm9Xs1Ya7Tb2NeQ","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","heartbeatIntervalMs":5000}
addon  → {"v":2,"type":"context","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":0,"state":"character_select","mapId":null,"character":null}
addon  → {"v":2,"type":"context","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":1,"state":"loading","mapId":50,"character":"Astra Uno"}
addon  → {"v":2,"type":"context","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":2,"state":"gameplay","mapId":50,"character":"Astra Uno"}
addon  → {"v":2,"type":"heartbeat","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":3}
addon  → {"v":2,"type":"context","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":4,"state":"gameplay","mapId":866,"character":"Astra Uno"}
plugin → {"v":2,"type":"alert","seq":1,"kind":"valuable_loot","name":"Mystic Coin","quantity":3,"totalCopper":123456,"content":"Mystic Coin ×3 · 12g 34s 56c"}
addon  → {"v":2,"type":"bye","nonce":"Zk3m1Qw9Lr0aT7yUc2Vb5g","seq":5,"reason":"game_exit"}
```

## Presencia: qué hace el plugin con el contexto

El plugin reduce todas las conexiones a **una sola presencia** por máquina
(`alert-ingame-presence.ts`), y la expone como estado (`getIngamePresence()`) y como eventos
(`onIngamePresence()`). No inicia ni cierra sesiones: eso es H18.26, que consume estos eventos.

| Evento | Cuándo |
|---|---|
| `started` | El primer `context` con `state: "gameplay"`. Una conexión en login o selección de personaje no empieza nada |
| `context` | Cambia el contexto efectivo: estado, mapa, personaje o anfitrión que lo aporta |
| `lost` | Se cierra la **última** conexión sin `bye game_exit` (timeout, reset, error de protocolo, `addon_unload`, plugin que se apaga). Empieza la gracia de **10 minutos** desde la última línea válida |
| `restored` | Cualquier addon se autentica antes de que venza la gracia; es la **misma** presencia |
| `ended` | Vence la gracia (`grace_expired`, fechado en la última línea válida) o la última conexión se va con `bye game_exit` (`game_exit`). Si otra conexión dijo `game_exit` hasta 15 s antes, esa hora fecha el fin |

Reglas:

- **Dos addons, una presencia.** Si Nexus y Blish están conectados a la vez, hay un solo `started`.
  El contexto efectivo sale del anfitrión de mayor prioridad (**Nexus sobre Blish**, porque lee
  `IsGameplay` dentro del proceso), y entre iguales de la conexión más antigua. Si se va uno, el
  contexto pasa al otro sin `lost`.
- **Una conexión cerrada no es el juego cerrado.** Puede ser un fallo del addon o del puente; por eso
  es pérdida con gracia y no fin.
- **Identificadores idempotentes.** Cada presencia tiene un `presenceId` aleatorio y cada evento una
  `revision` creciente. Un `started` y un `ended` con el mismo `presenceId` describen el mismo tramo
  de juego, lleguen como lleguen.
- **Laberinto.** El contexto efectivo lleva `labyrinth: true` con `mapId: 866` fuera de la selección
  de personaje. Es una etiqueta para la sesión, no la definición de «jugar».
- **Dos clientes del juego a la vez** (dos cuentas): cada proceso del addon tiene su `instance`; la
  presencia sigue siendo una y `instances` dice cuántos procesos hay. El protocolo no transporta la
  cuenta, así que el plugin no puede saber de cuál es cada uno.
- **Lo que no se deduce.** Las fuentes soportadas y auditadas no acreditan un flujo completo de
  botín ni una señal fiable de AFK. La ausencia de combate, una desconexión o un cambio de mapa no
  son por sí solos prueba de inactividad.
- El contexto vive solo en memoria mientras el plugin está cargado; esta capa no lo persiste.

## Privacidad

**Plugin → addon:** `v`, `type`, `seq`, `kind`, `name`, `quantity`, `totalCopper`, `content` en los
avisos; `server`, `nonce` y `heartbeatIntervalMs` en el `welcome`; un código en el `error`. Nunca la
clave de API, `accountId`, `accountRef`, `alertId`, `reason`, `itemId`, snapshots, `vaultId`, idioma
ni el texto del toast (que incorpora `reason` traducido: la fuga que tuvo el webhook de la `0.1.22`).

**Addon → plugin:** el secreto (una vez, en el `hello`), el anfitrión, su versión, un id aleatorio de
proceso, y `state`/`mapId`/`character`. Nada más.

Lo que lo impide estructuralmente:

1. `alertIngamePayload(alert: AlertV1)` construye el aviso y recibe **solo** `AlertV1`; sin parámetro
   de cadena, un llamante con la frase del toast no tiene dónde ponerla. Test de serialización con
   `Object.keys` exactas y control positivo sobre el compositor real del toast.
2. Claves exactas y tamaño máximo en las dos direcciones; los parsers del plugin rechazan cualquier
   campo de más.
3. `listen` solo en `127.0.0.1`; en otra interfaz falla cerrado.
4. `src/security-boundary.test.ts` censa `alert-ingame-server.ts` como el único módulo con `net`.

## Reparto

**En este repo:**

- `alert-ingame-protocol.ts` (puro): constantes, parsers de `hello` y de mensajes con secuencia,
  líneas `welcome`/`error`, generación y comparación del secreto.
- `alert-ingame-server.ts` (E/S): servidor loopback, conexiones pendientes y autenticadas, plazos,
  difusión de avisos solo a autenticadas.
- `alert-ingame-presence.ts`: reductor puro de presencia y su envoltorio con el temporizador de gracia.
- `alert-ingame.ts` (puro): el cuerpo del aviso.
- Cableado en `main.ts`: canal `ingame` del emisor (`deliver` falla con cero clientes
  **autenticados**), secreto desde el SecretStorage, `getIngamePresence()`/`onIngamePresence()`.
- `src/platform/` (H8) **no se importa**: se reutiliza su disciplina (nonce, secuencia, 512 bytes,
  claves exactas), no sus módulos, para que el canal no entre en el censo ni el modelo de amenazas de H8.

**En cada repo de addon** (`tyrian-companion-nexus`, Rust; `tyrian-companion-blish`, C#): ajustes
de puerto y token; conectar y reconectar; `hello`; leer líneas; pintar `alert`; enviar `context`
al cambiar, `heartbeat` en los silencios y `bye` al irse. Cero llamadas a la API de GW2, cero
escritura hacia el plugin fuera de estos cuatro tipos, cero acciones dentro del juego.

## Aceptación (auditoría del 24 sep, pruebas 12 a 15)

Automatizado en este repo, con sockets reales: conexión muda que no cuenta y se cierra; secreto
inválido; mensaje mal formado; clave de más; hueco de secuencia; dos clientes simultáneos; `bye`;
timeout de vida; desconexión que es pérdida y no fin; reconexión que restaura la misma presencia;
dos addons, una presencia.

Pendiente de QA humana en la plataforma real, y no acreditado por lo anterior:

- **Prueba 13** en Fedora con Nexus: reinicio del puente y del addon, conexión muda, dos addons,
  desconexión sin cerrar el juego.
- **Prueba 14** en Windows con Blish HUD: sesión automática de un compañero de principio a fin y
  aviso visible.
- **Prueba 12** (Laberinto) y **15** (Obsidian cerrado) dependen además de H18.26 y de la prueba de
  abrir Obsidian desde el juego.
- Reconstruir y publicar los binarios de los dos addons con v2.

## Riesgos, por orden

1. **Blish HUD en Linux** no lo soporta su autor; Windows es la plataforma que tiene que funcionar
   para Blish, Linux con Nexus para David.
2. **Puerto o token distintos en cada lado** son silencio. Lo tapan el `error` con código en el
   addon, que el informe del emisor marque `failed` sin clientes autenticados y el error de arranque
   en la fila del puerto.
3. **El secreto en la configuración del addon** está en claro en disco, como cualquier ajuste de un
   addon. Un proceso local que la lea puede suplantar al addon.
4. **Nexus se actualiza solo** y la API v6 puede subir. El addon declara su `APIVersion` y Nexus lo
   rechaza limpiamente si cambia.
5. Steam puede aislar `/tmp` distinto que protontricks. Ningún diseño usa `/tmp`.

## Lo que este protocolo NO hace

El plugin no lee Mumble Link ni NexusLink: lo leen los addons a través de su anfitrión. No
inspecciona memoria ni proceso del juego. No automatiza ninguna acción dentro del juego. No
transporta la cuenta, el botín ni la actividad. No saca la capa H8 del árbol. No mete binarios en
este repo.

## Fuentes

- [Nexus.h, API v6 (`GUI_SendAlert`, `GUI_Register`, `DataLink`, `WndProc`)](https://raw.githubusercontent.com/RaidcoreGG/RCGG-lib-nexus-api/main/Nexus.h)
- [Plantilla oficial de addon de Nexus](https://github.com/RaidcoreGG/GW2Nexus-AddonTemplate)
- [`nexus-rs`, bindings de Rust](https://github.com/Zerthox/nexus-rs)
- [Blish HUD, discusión 873 sobre Linux](https://github.com/blish-hud/Blish-HUD/discussions/873)
- [Blish HUD, cómo funciona](https://blishhud.com/docs/user/faqs/how-does-bhud-work/) y
  [el paquete `.bhm`](https://blishhud.com/docs/modules/overview/bhm/)
- [Blish HUD con Proton en Linux (gist)](https://gist.github.com/martinlabate/c4e6f08880a009f88dc1edaa4c6cd87a)
- [ArenaNet, Policy: Third-Party Programs](https://help.guildwars2.com/hc/en-us/articles/360013625034-Policy-Third-Party-Programs)
- [Obsidian, Node y Electron solo en escritorio](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
