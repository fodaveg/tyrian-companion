# Sonda pasiva de hallazgo mágico — candidato del 8 octubre 2026

**El juego no guarda el total.** El panel de héroe lo calcula cada vez que pinta, sumando tres
datos que sí están guardados. Esta sonda lee esos tres datos y repite la suma. No llama a
ninguna función del juego ni escribe nada.

**Nada de esto se ha leído en vivo.** El análisis es estático, sobre el fichero `Gw2-64.exe`
con SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`. No se tocó el
proceso del juego, que estaba abierto. El número que da la sonda es un candidato hasta que
coincida con el del panel de héroe.

David la autorizó el 8 de octubre de 2026 («sonda si»). Es investigación acotada: no añade una
fuente al producto ni se conecta al helper o a los addons. La regla de
[SPEC-live-loot](../../SPEC-live-loot.md) sigue vigente: no hay MF verificado hasta la prueba en
vivo de más abajo.

## Qué calcula el juego

El widget de atributos (`Game/Ui/Widgets/Attributes/AtAttribute.cpp`) calcula el valor en la
función de RVA `0x3E42F0`. El atributo de interfaz 13 es el hallazgo mágico; su caso está en
RVA `0x3E47F8` y hace esto:

```text
total = min(tope, nivel_de_suerte + modificadores(0x71) + [modificadores(0x72) si hay una bendición])
```

| Sumando | Dónde está guardado | Quién lo escribe |
| --- | --- | --- |
| Nivel de suerte de la cuenta | DWORD en `ChCliPlayerStats+0x24` | RVA `0x1208B40`, al cambiar la suerte |
| Modificadores que manda el servidor | Tabla ordenada en el gestor de efectos `+0xD8`, contador `+0xE4` | Solo los manejadores de mensajes `0x12C4730` y `0x12C47D0` |
| Modificadores de los efectos activos | Tabla hash de efectos en el gestor `+0x20`; cada definición trae sus registros | El cliente los evalúa al pintar |

`modificadores(tipo)` es la función de RVA `0x12C0540` (`Game/Combat/CombatBuff.cpp`). Empieza
con la suma de la tabla del servidor (slot `0x20` del gestor, RVA `0x12C2520`) y recorre los
efectos activos (slot `0x28`, RVA `0x12C28D0`) sumando los registros del tipo pedido.

Por qué 13 es el hallazgo mágico:

- La tabla de nombres de tipos de modificador está en RVA `0x2612C60`. El índice 113 (`0x71`) es
  `RewardCreatureAll` y el 114 (`0x72`) es `RewardCreatureAllBoon`.
- La función de RVA `0x3E3E00` asigna `0x71` al atributo 13. La de RVA `0x3E3F30` no le asigna
  ningún atributo de personaje.
- La base sale de `ChCliPlayerStats.cpp`, que nombra `accountMagicFindTable` y
  `accountMagicFindProgress`. La función de RVA `0x1475560` busca la suerte en esa tabla y deja
  el nivel en `+0x24`.
- Los mismos índices cuadran con los demás atributos: `0x5A` y `0x5B` (`MaximumHealth`) en el
  caso de la vida, `0x26` (`Defense`) en la armadura, `0x16` (`AttributeFishingPower`) en la pesca.

Por qué no hay total guardado:

- `ChCliCoreStats.cpp` guarda matrices solo para los 11 atributos de personaje (índices 1 a 11;
  el último es poder de pesca). El hallazgo mágico no está entre ellos.
- El único código que pide los tipos `0x71` o `0x72` es este widget. Nadie más los calcula ni
  los guarda.
- El widget conserva su último valor pintado en `+0x114`, pero solo existe con el panel abierto
  y no hay ruta fija hasta él. No sirve.

## Ruta respaldada por código estático

| Paso | Evidencia en este binario |
| --- | --- |
| Contexto general `+0x98` → `ChCliContext` | Vtable `0x215CF48`, la misma de las sondas de inventario y cartera |
| `ChCliContext+0x98` → personaje controlado | Slot `0x68` → RVA `0x11B4480`; exige el bit `0x10` de `personaje+0x178` |
| `ChCliContext+0xA0` → jugador local | Slot `0x70` → RVA `0x498860`: `mov rax,[rcx+0xA0]; ret` |
| El jugador es el del personaje | Slot `0x118` → RVA `0x11B6D60`: matriz `+0x80`, contador `+0x8C`, índice = id de jugador |
| Id de jugador del personaje | Vtable `0x21601D0` (`personaje+8`), slot `0x18` → RVA `0x11D7A50`: `personaje+0x220`, o `personaje+0xA0 - 0x30000000` |
| Jugador `+0x9700` → estadísticas | Vtable `0x215D958`, slot `0x320` → RVA `0x11BA730`: `lea rax,[rcx+0x9700]; ret` |
| Estadísticas `+0x24` → nivel de suerte | Vtable `0x2168138`, slot `0x30` → RVA `0x402AE0`: `mov eax,[rcx+0x24]; ret` |
| Personaje `+0x40` → interfaz de combate | Vtable `0x215FB60`, slot `0x100` → RVA `0x11D6A20`: `lea rax,[rcx+0x40]` |
| Interfaz `+0x90` → gestor de efectos | Vtable `0x2160498`, slot `0x38` → RVA `0x400060`: `mov rax,[rcx+0x90]; ret`. Es `personaje+0xD0` |
| Gestor de efectos | Constructor de `CmbtCliBuff.cpp` (RVA `0x12C1A50`) fija la vtable `0x2183118` |
| Tabla del servidor | Registros de 12 bytes: tipo DWORD, valor float, origen DWORD. Ordenada por tipo |
| Tabla de efectos | Capacidad DWORD `+0x20`, contador `+0x24`, puntero `+0x28`. Buckets de 24 bytes: clave `+0`, nodo `+8`, hash `+0x10` |
| Nodo → efecto → definición | `nodo+0x10` efecto, `nodo+0x18` clave; `efecto+0x28` id, `+0x58` estado, `+0x60` definición |
| Definición | Banderas `+0x4`, apilado `+0xC`, categoría `+0x18`, grupo `+0x20`; `grupo+0x10` registros, `+0x18` contador |
| Registro de modificador (72 bytes) | Tipo `+0`, fórmula `+4`, valor float `+8`, modo de juego `+0x14`, condiciones `+0x18` a `+0x40`, banderas `+0x28` |

La tabla de efectos usa el mismo hash de clave que la cartera (RVA `0x251E20`, tabla estática en
RVA `0x1B8FDB0`). La sonda comprueba el hash de cada bucket ocupado.

## Qué repite la sonda y qué rechaza

La sonda aplica las mismas reglas que el cliente para los registros de tipo `0x71` y `0x72`:

- Un efecto cuenta una vez por id, salvo que su apilado sea 4 (por intensidad): entonces cuenta
  cada instancia.
- El tipo `0x72` solo entra si algún efecto activo tiene categoría 0.
- Un registro con condición de objetivo (`+0x18`) se salta: el widget no pasa objetivo.
- La bandera `0x1` de un registro corta la definición tras él.
- Con el gestor en modo 1 (`+0xF0`), las definiciones con bandera `0x40` no cuentan.

Solo sabe evaluar la fórmula 6, que es una constante. Devuelve `unknown`, sin ningún valor, si
un registro de hallazgo mágico que contaría tiene:

- otra fórmula (dependen del nivel o de atributos, y exigen llamar al juego);
- modo de juego distinto de 0 (PvE, PvP o McM: depende del mapa);
- una condición de rasgo o de estado.

Los registros de otros tipos se ignoran sin evaluarlos.

## Unidades y codificación

- El nivel de suerte es un entero: puntos de porcentaje.
- Los modificadores son `float` de 32 bits, también en puntos de porcentaje. El caso los suma
  directamente al entero y compara el resultado con el tope.
- La sonda suma en precisión simple, como el cliente, y emite el total con tres decimales.
- **El tope no se lee.** Es un número de contenido que el juego pide con la función de RVA
  `0x12DD120`. La sonda emite el total sin recortar y `game_cap_applied: false`.

## Sin validar

- Que el número del modo normal coincida con el del panel de héroe. El 8 de octubre coincidió
  (333) el recorrido relajado del diagnóstico; el modo normal con la regla nueva no se ha
  ejecutado todavía.
- Que el resto 4 de los punteros de contenido se mantenga en otra sesión o tras un parche.
- Que el panel use el personaje de `ChCliContext+0x98`. La sonda sí comprueba que ese personaje
  es del jugador local.
- Que los efectos reales de hallazgo mágico usen la fórmula 6 y no lleven condiciones. Si no es
  así, la sonda dará `unknown` y habrá que decidir si se amplía.
- Las definiciones con bandera `0x80`. El cliente las oculta si el dueño del gestor no es el
  personaje local; la sonda lee el gestor del personaje local y las cuenta.
- Cuántos efectos tiene un personaje real y si caben en el presupuesto.
- Si el panel redondea o trunca el decimal.
- Windows nativo y el lector dentro del addon.

## Verificación ejecutada sin juego

Python 3.11 o superior; solo stdlib:

```sh
cd docs/audit/loot-mf-probe
PYTHONDONTWRITEBYTECODE=1 python3 prove_guard_red.py
# Debe terminar con exit 1: retira dos guards, de uno en uno y SOLO en la fixture.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_probe.py
# Debe terminar con exit 0: 51 tests con los guards reales activos.
PYTHONDONTWRITEBYTECODE=1 python3 check_profile_offline.py
# Debe terminar con exit 0: lee el fichero instalado, nunca el proceso.
```

El control rojo retira dos guards, cada uno por separado:

1. Las dos comprobaciones de identidad del gestor de efectos. Una fixture con vtable incorrecta
   devuelve entonces un total, y el test falla al exigir `unknown`.
2. La alineación de los punteros de contenido. Fixtures con el contenido en resto 0, 1, 2 y 6
   devuelven entonces un total, y los cuatro casos fallan.

Sale con exit 1 solo si los dos guards retirados hicieron fallar su test. Exit 3 significa que
se quitó un guard y su test siguió pasando.

`profile.json` guarda solo hashes: no hay bytes del juego en el repo. Por eso las fixtures usan
contenidos de guard sintéticos, y `check_profile_offline.py` es quien ata los 19 hashes y los 12
slots al fichero real. Su control negativo (un hash y un slot alterados en memoria) termina con
exit 1. El [recibo](receipt.json) enlaza los hashes y los logs de [evidence](evidence/).

## Lectura futura mínima

Solo la raíz ejecuta la sonda, después de revisar el candidato, con argumentos recién obtenidos
de la [sonda TEB/TLS](../loot-teb-probe/README.md). Hace falta el PID **Linux**, la base del
módulo y el contexto actual. No se reutilizan punteros de otra ejecución.

```sh
python3 docs/audit/loot-mf-probe/check_profile_offline.py
python3 docs/audit/loot-mf-probe/probe.py \
  --pid "$GW2_LINUX_PID" --module-base "$GW2_MODULE_BASE" --context "$GW2_CONTEXT" \
  --samples 1
```

Antes de abrir `/proc/<pid>/mem` con `O_RDONLY`, la sonda verifica mapas, base, hash del fichero
mapeado y PE AMD64. Después comprueba los 19 rangos fijos (6054 bytes) y, en cada muestra, las
vtables y los 12 slots de la ruta.

El presupuesto es de **65536 bytes pedidos por ejecución** y no se ha subido. Es 16 veces el de
la cartera porque aquí no hay un campo que leer: hay que recorrer la tabla de efectos. Límites:
512 buckets, 32 registros por definición y 256 registros del servidor. Pasarse da `byte_budget`,
nunca un valor.

**Una ejecución es una pasada completa.** La pasada de diagnóstico del 8 de octubre pidió 33234
bytes con 91 efectos y 75 definiciones: 6054 de guards, 728 de la lectura extra del diagnóstico
y unos 26,5 KiB de la muestra, que ya incluye su relectura de consistencia (dueños, vtables,
cabeceras, suerte y las dos tablas enteras). Dos muestras así suman unos 59 KiB: caben por
poco y dejan de caber con más efectos.

Por eso el uso previsto es `--samples 1`, y el segundo control se hace con una segunda
ejecución. `--samples 2` sigue existiendo, pero si la segunda pasada no cabe en lo que queda,
la sonda lo dice con `byte_budget` **antes de leer nada**, en vez de quedarse a medias.

Cada muestra relee dueños, vtables, cabeceras, el nivel de suerte y las dos tablas enteras.
Cualquier diferencia da `unknown`. JSONL emite solo el total candidato, sus tres sumandos,
timestamps y razones cerradas; no hay punteros, nombres ni identificadores de efectos. Exit 0
significa muestras completas; exit 2, desconocido.

## Prueba discriminante en vivo

1. David abre el panel de héroe (H), pestaña de equipamiento, y lee «Hallazgo mágico».
2. La raíz ejecuta la sonda en ese momento, sin que David cambie nada.
3. `candidate_total_percent` tiene que ser ese número, con menos de un punto de diferencia.
   Si el panel marca el tope, la sonda puede dar más: ese caso no discrimina.

Segundo control, para separar el total de la base de cuenta:

1. Muestra con la comida o el potenciador activos.
2. David quita ese efecto (clic derecho sobre el icono) o toma uno nuevo.
3. Segunda muestra. `candidate_total_percent` tiene que moverse lo mismo que el panel, y
   `account_luck_percent` tiene que quedarse igual.

`account_luck_percent` sola es la base de suerte, la misma que da la API. No resuelve la
petición de David y no debe presentarse como el hallazgo mágico.

Una discrepancia refuta la suma o alguna regla; no autoriza buscar el número por el heap. Un
`unknown` por fórmula o condición dice qué falta por entender, no que el valor sea cero.

## Primera ejecución en vivo, 8 octubre 2026: `unknown`

La ejecutó la sesión raíz, con David mirando 333 % en el panel de héroe. Esta carpeta no leyó
el proceso; los datos son los que la raíz informó.

- Dos muestras, exit 2, las dos `unknown` con `null_or_invalid_pointer`.
- 31286 bytes pedidos y leídos, 0 efectos leídos, 0 escrituras.
- Los 19 guards y todas las vtables y slots de la ruta pasaron: el fallo llegó después.

De los bytes sale dónde paró. Son 12616 por muestra, y en fixture ese número solo se reproduce
con una tabla de efectos de 512 buckets y el rechazo en el **primer efecto ocupado**: o el
puntero del nodo (con 5 registros del servidor) o el puntero `nodo+0x10` (con 4). La suerte,
la tabla del servidor y la tabla de efectos se leyeron enteras.

Hipótesis, sin validar: el nodo sale del asignador general (objeto de `0x78` bytes, constructor
en RVA `0x12C1890`) y debería estar alineado. Lo que cuelga de `nodo+0x10` es contenido del
juego, y el contenido puede no estar alineado a 8 bytes. El `Reader` heredado de la cartera
rechaza cualquier puntero no alineado a 8; esa regla no sale del código del juego.

Los punteros que el juego trata como vacíos ya contaban como 0 y no como `unknown`:

- Tabla del servidor vacía: RVA `0x12C2520` compara inicio y fin y devuelve 0 sin leer.
- Sin efectos: RVA `0x12C28D0` devuelve nulo si el contador `+0x24` es 0.

La tabla resultó ser de 256 buckets, no de 512: la inferencia de los bytes acertó el sitio
(`nodo+0x10`, con 4 registros del servidor) y falló el tamaño.

## Diagnóstico en vivo, 8 octubre 2026: la alineación

Lo ejecutó la sesión raíz con `--diagnose`, una muestra, 33234 bytes, exit 2.

- Veredicto estricto: `unknown`, `stage: buff_instance`, `pointer_fault: unaligned`.
- Suerte 300; 4 registros del servidor, 13,0 de hallazgo mágico.
- Tabla de 256 buckets con 91 efectos; 0 hashes que no cuadran; 91 de 91 nodos con la vtable
  `0x21830D0`; 75 definiciones.
- Un solo registro de hallazgo mágico: tipo `0x71`, fórmula 6, modo 0, sin condiciones, valor
  20,0, apilado 4.
- El recorrido relajado llegó al final: 300 + 13,0 + 20,0 = **333,0**, lo que marcaba el panel
  de héroe de David. Es un número de diagnóstico, no una muestra del modo normal.

## Dos alineaciones, una por tipo de puntero

El `Reader` heredado de la cartera exigía todo puntero alineado a 8 bytes. Esa regla no salía
del código del juego y era falsa para el contenido. Ahora hay dos:

| Puntero | Regla | De dónde sale |
| --- | --- | --- |
| Objetos del montículo: contexto, personaje, jugador, gestor, tablas, nodos | Resto 0 módulo 8 | 91 de 91 nodos en vivo; el nodo es un objeto de `0x78` bytes del asignador general (RVA `0x12C1890`); la cartera y el inventario ya pasaron así |
| Contenido del juego: referencia del efecto, definición, grupo y registros | Resto 4 módulo 8 | 278 de 278 punteros en vivo. Por los contadores de la pasada son 91 referencias, 75 definiciones, 75 grupos y 37 listas de registros; el desglose es deducido |

La regla del contenido es **observada, no derivada del binario**. Elegí «resto 4» y no «múltiplo
de 4» porque es la más estrecha que cumplen los 278 casos: un puntero de contenido alineado a
8 sería tan anómalo como uno impar, y así se rechazan los dos.

Explicación posible, sin verificar: el contenido se quedaría en el búfer del fichero del que
se cargó, detrás de una cabecera cuyo tamaño fuera 4 módulo 8. Es un recuerdo mío del formato,
no un dato de este binario: busqué la comprobación de esa cabecera en el código con un patrón
simple, no apareció y no seguí.

Si otra versión o otra sesión coloca el contenido en otro resto, la sonda dará `unknown` con
`pointer_fault: unaligned` en el diagnóstico. No dará un valor.

## Modo `--diagnose`

Mismo `Reader`, mismos guards y mismo presupuesto. Añade a cada muestra:

- `stage`: el paso donde se rechazó, y `passed`: los que pasaron.
- `pointer_fault`: `null`, `unaligned`, `out_of_user_range` o `unmapped`. Nunca el valor.
- `observed_rva` y `observed_in_module`, si lo rechazado fue una vtable o un slot.
- `partial`: lo que sí se leyó. Incluye `account_luck_percent`, `pushed_magic_find_percent`,
  el tamaño de la tabla de efectos, cuántos efectos se recorrieron y:
  - `bucket_survey`: buckets ocupados, hashes que no cuadran y los tres bits bajos de cada
    puntero de nodo, sin el puntero.
  - `node_vtables`: cuántos nodos tienen la vtable `0x21830D0` que fija su constructor. Es la
    única lectura añadida: 8 bytes por efecto.
  - `magic_find_records`: fórmula, modo de juego, condiciones y valor de cada registro de
    hallazgo mágico de los efectos activos. Es forma del contenido, sin identificadores.

Solo relaja una comprobación: la alineación. Anota el primer puntero no alineado y sigue, para
que una sola ejecución enseñe hasta dónde llega el recorrido. **El veredicto sigue siendo el
estricto**: `unknown`, con `stage` en ese primer puntero. Lo que encuentre el recorrido relajado
va aparte, en `relaxed_alignment`, con `diagnostic_only: true`.

```sh
python3 docs/audit/loot-mf-probe/probe.py \
  --pid "$GW2_LINUX_PID" --module-base "$GW2_MODULE_BASE" --context "$GW2_CONTEXT" \
  --samples 1 --diagnose
```

Una sola muestra: con 512 buckets, dos pueden no caber.

La salida normal no cambia: un test fija sus campos.

## Recibos

El vigente es [`receipt.json`](receipt.json): cubre los ficheros tal como están hoy.
[`receipt-diagnose-2026-10-08.json`](receipt-diagnose-2026-10-08.json) y los logs de `evidence/`
son historia: describen el modo de diagnóstico y el primer candidato (commit `9d6703a`), cuyos
ficheros han cambiado desde entonces.
