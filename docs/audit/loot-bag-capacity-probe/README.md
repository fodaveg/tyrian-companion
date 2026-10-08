# Sonda pasiva de capacidad de las bolsas — candidato del 8 octubre 2026

**El juego no guarda la capacidad total.** El contador `usados/total` de la ventana de
inventario la calcula sumando el tamaño de cada bolsa equipada. Esta sonda lee esas mismas
bolsas y repite la suma. No llama a ninguna función del juego ni escribe nada.

**Nada de esto se ha leído en vivo.** El análisis es estático, sobre el fichero `Gw2-64.exe`
con SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`. No se tocó el
proceso del juego. El número de la sonda es un candidato hasta que coincida con el de la ventana.

David la autorizó el 8 de octubre de 2026 («sonda si», al ampliar la sonda a la capacidad de las
bolsas). Es investigación acotada: no añade una fuente al producto ni se conecta a los addons.

## De dónde sale el total

El contador lo pinta la función de RVA `0x6A2930`, en
`Game/Ui/Widgets/Inventory/InvButtonBar.cpp`. Pide dos números al inventario y los pasa al
texto `0xBCFA`:

| Número | Slot del inventario | Qué hace |
| --- | --- | --- |
| Total | `0x1F0` → RVA `0x11EE520` | Recorre los índices de bolsa y **suma** el tamaño de cada una |
| Usados | `0x1E8` → RVA `0x11EE4E0` | Cuenta las posiciones no nulas de la matriz `+0xC8` (contador `+0xD4`) |

El total no se guarda en ningún campo: la función lo devuelve en un registro y el widget lo
formatea. Los libres son otro slot (`0x1E0` → RVA `0x11EE4A0`), que resta los dos anteriores.

Lo que sí está guardado son los sumandos:

| Dato | Dónde | Evidencia |
| --- | --- | --- |
| Número de huecos de bolsa | DWORD en `inventario+0x440` | Slot `0x148` → RVA `0x11EE300`: `mov eax,[rcx+0x440]; ret`. El setter (RVA `0x1291130`) exige que sea 16 como máximo |
| Bolsa de cada hueco | 16 punteros en `inventario+0x380` | Slot `0x138` → RVA `0x12908E0`, en `ChCliItemStorageBags.cpp` (`m_bags`) |
| Tamaño de una bolsa | DWORD en `carga+0x28` | Slot `0x140` → RVA `0x1290930` |

El tamaño de una bolsa son tres saltos desde su puntero, los mismos que da el slot `0x140`:

1. `objeto+0x40` → definición. Es el getter común de los objetos (slot `8` → RVA `0x13C3E10`),
   el mismo que ya comprueba el lector de inventario.
2. `definición+0x2C` tiene que ser 3 (tipo bolsa) y `definición+0x30` → carga de bolsa.
3. `carga+0x28` → tamaño.

La clase del objeto bolsa es la de `ItCliBag.cpp`: su constructor (RVA `0x13C8CF0`) fija la
vtable `0x225D070`. La sonda exige esa vtable en cada bolsa.

## La matriz de 512 no basta

La matriz que ya recorre el lector sí está ordenada por bolsa: la posición es
`índice de bolsa × 32 + hueco dentro de la bolsa`. Lo respalda la función de RVA `0x1290860`,
que separa los dos con un desplazamiento de 5 bits. Una posición existe solo si el índice de
bolsa es menor que el número de huecos de bolsa **y** el hueco es menor que el tamaño de esa
bolsa (RVA `0x1290AC0`).

Eso no da una tercera vía sin lecturas nuevas: para saber si un hueco existe hace falta el
tamaño de su bolsa, y el tamaño solo está en la definición de la bolsa. Sí sirve para otra cosa:
con los tamaños leídos, el addon puede contar ocupados y libres **por bolsa**.

## Ruta de la sonda

| Paso | Evidencia en este binario |
| --- | --- |
| Contexto `+0x98` → `ChCliContext` | Vtable `0x215CF48` |
| `ChCliContext+0x98` → personaje controlado | Slot `0x68` → RVA `0x11B4480`; bit `0x10` de `personaje+0x178` |
| Personaje `+0x3F0` → inventario | Vtable `0x21601D0` (`personaje+8`), slot `0xC8` → RVA `0x11D74D0` |
| El inventario es de ese personaje | Vtable `0x21621A8`, slot `0x220` → RVA `0x45DD90`: `inventario+0x70` |
| Huecos, bolsas y tamaños | Las tres filas de la tabla anterior |

Los cuatro primeros pasos son los del [lector de inventario](../loot-inventory-probe/), que ya
se validó en vivo el 6 de octubre. Los nuevos son `+0x440`, `+0x380` y los tres saltos por bolsa.

## Sin validar

- Que la suma coincida con el total de la ventana. Es la prueba de abajo.
- Que el tamaño de `carga+0x28` sea el que usa el contador en todos los tipos de bolsa.
- Si alguna bolsa real usa otra clase de objeto: daría `bag_item_vtable`, no un número.
- El inventario compartido de la cuenta y el banco. No entran en este contador y no se leen.
- Windows nativo y el lector dentro del addon.

Las medidas de partida las aportó la sesión raíz, de una captura de David del 8 de octubre: el
diagnóstico del addon decía `positions: 512 / 640` y la ventana del juego `313/414`. Esta carpeta
no las ha comprobado.

## Verificación ejecutada sin juego

```sh
cd docs/audit/loot-bag-capacity-probe
PYTHONDONTWRITEBYTECODE=1 python3 prove_guard_red.py
# Debe terminar con exit 1: el guard de vtable se retira SOLO en la fixture.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_probe.py
# Debe terminar con exit 0: 21 tests con el guard real activo.
PYTHONDONTWRITEBYTECODE=1 python3 check_profile_offline.py
# Debe terminar con exit 0: lee el fichero instalado, nunca el proceso.
```

El control rojo retira las dos comprobaciones de identidad del inventario. Una fixture con
vtable incorrecta devuelve entonces una capacidad, y el test falla al exigir `unknown`.

`profile.json` guarda solo hashes: no hay bytes del juego en el repo. Las fixtures usan
contenidos de guard sintéticos, y `check_profile_offline.py` ata los 11 hashes y los 9 slots al
fichero real. Su control negativo (un hash y un slot alterados en memoria) termina con exit 1.
El [recibo](receipt.json) enlaza los hashes y los logs de [evidence](evidence/).

## Lectura futura mínima

Solo la raíz ejecuta la sonda, después de revisar el candidato, con argumentos recién obtenidos
de la [sonda TEB/TLS](../loot-teb-probe/README.md): PID **Linux**, base del módulo y contexto.

```sh
python3 docs/audit/loot-bag-capacity-probe/check_profile_offline.py
python3 docs/audit/loot-bag-capacity-probe/probe.py \
  --pid "$GW2_LINUX_PID" --module-base "$GW2_MODULE_BASE" --context "$GW2_CONTEXT" \
  --samples 2 --interval 1
```

Antes de abrir `/proc/<pid>/mem` con `O_RDONLY`, la sonda verifica mapas, base, hash del fichero
mapeado y PE AMD64. El presupuesto es de **4096 bytes pedidos por ejecución**, con dos muestras
como máximo. Medido en fixture: 824 bytes de guards y 1028 por muestra con 16 bolsas, 2880 en
total. Cada bolsa cuesta 36 bytes.

Cada muestra relee dueños, vtables, el número de huecos y la lista de bolsas. Cualquier
diferencia da `unknown`. JSONL emite solo la capacidad candidata, el número de huecos de bolsa,
cuántas bolsas hay puestas, timestamps y razones cerradas; no hay punteros ni identificadores
de objeto. Exit 0 significa muestras completas; exit 2, desconocido.

## Prueba discriminante en vivo

1. David abre el inventario y lee el contador `usados/total`.
2. La raíz ejecuta la sonda en ese momento. `candidate_capacity_slots` tiene que ser el total
   (414 en la captura del 8 de octubre, o el que marque entonces).

Segundo control: David cambia a un personaje con otras bolsas y la raíz repite la sonda con un
contexto nuevo. La capacidad tiene que ser la del contador de ese personaje.

Una discrepancia refuta la suma o el campo de tamaño; no autoriza buscar el número por el heap.

## Coste para el lector del addon

Sobre lo que ya valida: una lectura de 4 bytes (`+0x440`), una de 128 (`+0x380`) y, por cada
bolsa puesta, tres saltos y 36 bytes con la vtable. Con 16 bolsas son 708 bytes.

Suposición sin validar: mientras la lista de punteros no cambie, las bolsas son las mismas y no
haría falta releer sus tamaños. Un puntero reutilizado por otra bolsa la rompería.
