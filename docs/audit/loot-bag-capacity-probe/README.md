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

**Corrección del 8 de octubre.** La primera versión decía que la clase del objeto bolsa tenía
la vtable `0x225D070`. Era un error de este análisis: esa vtable es la de los consumibles
(`ItCliConsumable.cpp`). La ejecución en vivo lo destapó al rechazar la primera bolsa.

La fábrica de objetos (RVA `0x13C6E03`) elige la clase por el tipo de la definición, con una
tabla de 25 entradas. Para el tipo 3 llama al constructor de RVA `0x13C8C10`, que fija la
vtable **`0x225CD18`**; en esa vtable, el slot `0x2A8` es la única función de `ItCliBag.cpp`.
Como el juego exige tipo 3 en cada hueco de bolsa, no hay otra clase posible: bolsas invisibles,
de caja fuerte, de equipo o la mochila inicial son la misma clase con otra definición.

La vtable correcta está **activa desde el 8 de octubre**: el diagnóstico en vivo devolvió
`0x225CD18` (36031768) en las 16 bolsas. `check_profile_offline.py` comprueba además su cadena
sobre el fichero: tabla → caso → constructor → vtable → getter de definición.

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
- Que el modo normal dé el total. El 8 de octubre lo dio (414) la suma de diagnóstico; el modo
  normal con la clase y la alineación corregidas no se ha ejecutado todavía.
- Que los punteros de definición y de carga terminen en 4. En esta sonda solo consta que no
  estaban alineados a 8; el resto exacto lo midió la sonda de hallazgo mágico en otro contenido.
- El inventario compartido de la cuenta y el banco. No entran en este contador y no se leen.
- Windows nativo y el lector dentro del addon.

Las medidas de partida las aportó la sesión raíz, de una captura de David del 8 de octubre: el
diagnóstico del addon decía `positions: 512 / 640` y la ventana del juego `313/414`. Esta carpeta
no las ha comprobado.

## Verificación ejecutada sin juego

```sh
cd docs/audit/loot-bag-capacity-probe
PYTHONDONTWRITEBYTECODE=1 python3 prove_guard_red.py
# Debe terminar con exit 1: retira dos guards, de uno en uno y SOLO en la fixture.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_probe.py
# Debe terminar con exit 0: 34 tests con los guards reales activos.
PYTHONDONTWRITEBYTECODE=1 python3 check_profile_offline.py
# Debe terminar con exit 0: lee el fichero instalado, nunca el proceso.
```

El control rojo retira dos guards, cada uno por separado:

1. Las dos comprobaciones de identidad del inventario. Una fixture con vtable incorrecta
   devuelve entonces una capacidad, y el test falla al exigir `unknown`.
2. La alineación de los punteros de contenido. Fixtures con el contenido en resto 0, 1, 2 y 6
   devuelven entonces una capacidad, y los cuatro casos fallan.

Sale con exit 1 solo si los dos guards retirados hicieron fallar su test. Exit 3 significa que
se quitó un guard y su test siguió pasando.

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

## Primera ejecución en vivo, 8 octubre 2026: `unknown`

La ejecutó la sesión raíz, con la ventana de inventario en `313/414`. Esta carpeta no leyó el
proceso; los datos son los que la raíz informó.

- Dos muestras, exit 2, las dos `unknown` con `bag_item_vtable`.
- 1368 bytes pedidos y leídos, 0 bolsas leídas, 0 escrituras.

Son 824 de guards y 272 por muestra: exactamente la ruta hasta la vtable de la primera bolsa.
Los 11 guards, las vtables, los 9 slots, el dueño del inventario, el número de huecos y la
lista de punteros pasaron. Lo único rechazado fue la clase del primer objeto, por el error
descrito arriba.

## Diagnóstico en vivo, 8 octubre 2026: clase y alineación

Lo ejecutó la sesión raíz con `--diagnose`, una muestra, 1860 bytes, exit 2.

- Veredicto estricto: `unknown`, `bag_item_vtable`, `observed_rva` 36031768.
- 16 huecos de bolsa, 16 bolsas, una sola clase: `ItCliBag`, con el getter guardado en su
  slot `8` y definición de tipo 3 en todas.
- Tamaños 18, 32, 24, 20, 20, 20, 20, 20, 20, 28, 32, 32, 32, 32, 32, 32. Suman **414**, el
  total de la ventana de David. Es la suma de diagnóstico, no una muestra del modo normal.
- Los 16 punteros de objeto pasaron la alineación a 8. Los 16 de definición y los 16 de carga
  no: activar la clase no bastaba.

## Dos alineaciones, una por tipo de puntero

| Puntero | Regla | De dónde sale |
| --- | --- | --- |
| Objetos del montículo: contexto, personaje, inventario, objeto bolsa | Resto 0 módulo 8 | Los 16 objetos bolsa en vivo; son objetos de `0x98` bytes del asignador general (caso de la fábrica en RVA `0x13C6F4A`) |
| Contenido del juego: definición del objeto y carga de bolsa | Resto 4 módulo 8 | Los 32 fallaron la alineación a 8 en vivo; la sonda de hallazgo mágico midió resto 4 en 278 de 278 punteros de contenido |

La regla del contenido es **observada, no derivada del binario**, y aquí además es prestada: el
diagnóstico de esta sonda decía «no alineado a 8» sin decir el resto. Desde hoy el sondeo
añade `definition_low_bits` y `payload_low_bits`. Si una bolsa real no termina en 4, el modo
normal dará `unknown` con `null_or_invalid_pointer` y el diagnóstico dirá el resto.

Elegí «resto 4» y no «múltiplo de 4» porque es la regla más estrecha que cumple lo medido: un
puntero de contenido alineado a 8 sería tan anómalo como uno impar.

## Modo `--diagnose`

Mismo `Reader`, mismos guards y mismo presupuesto. Añade a cada muestra:

- `stage`: el paso donde se rechazó (por ejemplo `bag_item_vtable[0]`), y `passed`.
- `pointer_fault`: `null`, `unaligned`, `out_of_user_range` o `unmapped`. Nunca el valor.
- `observed_rva` y `observed_in_module`, si lo rechazado fue una vtable o un slot.
- `survey`: el número de huecos de bolsa y una fila por cada uno de los 16 punteros, con:
  si hay bolsa, el RVA de su vtable, si es la activa, qué clase candidata es, si su slot `8`
  despacha al getter de definición guardado, el tipo de la definición, el tamaño y si los
  punteros de definición y de carga están alineados.
- `hypothetical_capacity_if_dispatch_accepted`: la suma, **solo** si todas las bolsas contadas
  despachan al getter guardado, son de tipo 3 y no pasan de 32. Es un número de diagnóstico:
  el veredicto sigue siendo `unknown` mientras la clase no esté aceptada.

```sh
python3 docs/audit/loot-bag-capacity-probe/check_profile_offline.py
python3 docs/audit/loot-bag-capacity-probe/probe.py \
  --pid "$GW2_LINUX_PID" --module-base "$GW2_MODULE_BASE" --context "$GW2_CONTEXT" \
  --samples 1 --diagnose
```

Coste medido en fixture con 16 bolsas rechazadas: 1860 bytes una muestra, 2896 dos. Con las
16 aceptadas, dos muestras agotan el presupuesto en el segundo sondeo; por eso una sola.

La salida normal no cambia: un test fija sus campos.

## Recibos

El vigente es [`receipt.json`](receipt.json): cubre los ficheros tal como están hoy.
[`receipt-diagnose-2026-10-08.json`](receipt-diagnose-2026-10-08.json) y `evidence/` son
historia: describen el modo de diagnóstico y el primer candidato (commit `236cdce`), cuyos
ficheros han cambiado desde entonces. Lo que `evidence/static-findings.json` dice de la clase
de la bolsa es el error ya corregido arriba.

## Coste para el lector del addon

Sobre lo que ya valida: una lectura de 4 bytes (`+0x440`), una de 128 (`+0x380`) y, por cada
bolsa puesta, tres saltos y 36 bytes con la vtable. Con 16 bolsas son 708 bytes.

Suposición sin validar: mientras la lista de punteros no cambie, las bolsas son las mismas y no
haría falta releer sus tamaños. Un puntero reutilizado por otra bolsa la rompería.
