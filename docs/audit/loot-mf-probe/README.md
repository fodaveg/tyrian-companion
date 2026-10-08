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

- Que el número coincida con el del panel de héroe. Es la prueba de abajo.
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
# Debe terminar con exit 1: el guard de vtable se retira SOLO en la fixture.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_probe.py
# Debe terminar con exit 0: 35 tests con el guard real activo.
PYTHONDONTWRITEBYTECODE=1 python3 check_profile_offline.py
# Debe terminar con exit 0: lee el fichero instalado, nunca el proceso.
```

El control rojo retira las dos comprobaciones de identidad del gestor de efectos. Una fixture
con vtable incorrecta devuelve entonces un total, y el test falla al exigir `unknown`.

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
  --samples 2 --interval 1
```

Antes de abrir `/proc/<pid>/mem` con `O_RDONLY`, la sonda verifica mapas, base, hash del fichero
mapeado y PE AMD64. Después comprueba los 19 rangos fijos (6054 bytes) y, en cada muestra, las
vtables y los 12 slots de la ruta.

El presupuesto es de **65536 bytes pedidos por ejecución**, con dos muestras como máximo. Es 16
veces el de la cartera porque aquí no hay un campo que leer: hay que recorrer la tabla de
efectos. Límites: 512 buckets, 32 registros por definición y 256 registros del servidor. Una
muestra con 40 efectos debería pedir unos 17 KiB; es una estimación, no una medida. Pasarse da
`byte_budget`, nunca un valor.

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
