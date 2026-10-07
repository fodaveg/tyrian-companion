# Sonda pasiva de cartera — candidato del 6 octubre 2026

La sonda lee únicamente la clave **candidata** 45 del gestor que utiliza la interfaz de cartera.
El catálogo público identifica 45 como [Magia volátil](https://api.guildwars2.com/v2/currencies/45?lang=es).
**La correspondencia entre esa clave nativa y el ID público, el saldo y una adquisición real
siguen sin validar.** El juego estaba cerrado: no se abrió, no se consultó su memoria ni se
ejecutó QA. Esta carpeta diagnóstica no registra una nueva fuente del producto ni se conecta
al helper o a los addons distribuidos.

La excepción de [PLATFORM_POLICY](../../PLATFORM_POLICY.md#excepción-de-investigación--captura-local-de-objetos-6-oct-2026)
permite la investigación acotada. La identidad del binario analizado es SHA-256
`27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`.

## Ruta respaldada por código estático

| Paso                                         | Evidencia en este binario                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Contexto general + `0x98` → ChCliContext     | `InvWalletPage.cpp`, RVA `0x6A9225`, consume este campo                            |
| ChCliContext + `0xA0` → personaje de cartera | Vtable `0x215CF48`, slot `0x70` → getter `0x498860`: `mov rax,[rcx+0xA0]; ret`     |
| Personaje + `0x1878` → gestor embebido       | Vtable `0x215D958`, slot `0x250` → getter `0x11BA5E0`: `lea rax,[rcx+0x1878]; ret` |
| Gestor de monedas                            | Constructor/destructor de `ChCliCurrency.cpp` fijan vtable `0x21720F8`             |
| Getter por ID                                | Slot 0 → RVA `0x1271810`; `InvWalletListEntry.cpp` le pasa `CurrencyDef+0x28`      |
| Mapa de claves                               | Capacidad DWORD `+0x08`, count DWORD `+0x0C`, puntero QWORD `+0x10`                |
| Bucket de 12 bytes                           | Clave DWORD `+0`, saldo candidato DWORD `+4`, hash ocupado DWORD `+8`              |

La ruta de inventario controlado previamente probada utiliza **ChCliContext+0x98** y un wrapper
con otra vtable. No se intercambian ambos campos. Si la clase observada en vivo difiere de las
vtables listadas, la sonda devuelve `unknown`; ampliar una allowlist exige verificar su dispatch.

La búsqueda abierta con sondeo lineal está en RVA `0x2397F0`. Usa una tabla estática de 256 DWORD
en RVA `0x1B8FDB0`, comprobada junto con el código del getter. Para la clave candidata 45 produce
hash `0xC0DA54D6`. Se consulta `hash & (capacidad-1)`, avanzando con la misma máscara. Estos
datos son hallazgos estáticos, no campos observados de la cartera de una cuenta.

## Verificación ejecutada sin juego

Python 3.11 o superior; únicamente stdlib, sin bootstrap ni dependencias adicionales:

```sh
cd docs/audit/loot-wallet-probe
PYTHONDONTWRITEBYTECODE=1 python3 prove_guard_red.py
# Debe terminar con exit 1: el guard de vtable se retira SOLO en la fixture.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_probe.py
# Debe terminar con exit 0: 22 tests con el guard real activo.
```

El control rojo elimina las comprobaciones inicial y final de identidad del gestor. Una fixture
con vtable incorrecta devuelve indebidamente `candidate_balance`, y el test falla al exigir
`unknown`. El archivo de prueba no modifica `probe.py` ni corre contra memoria real.

La suite verde valida una variación sintética 100→106, saldo cero con clave/hash acreditados,
clave ausente, hash/ID erróneos, vtable/getter incorrectos, capacidad y count mal formados,
punteros nulos/no mapeados, lecturas parciales, límite de bytes, colisiones y cambio de
header/propietario/saldo. Cambiar el propietario entre dos muestras impide calcular su delta.
El [recibo](receipt.json) enlaza los hashes del mismo candidato y los logs en [evidence](evidence/).
Los logs de tests conservan el resultado y normalizan únicamente la ruta absoluta del worktree.

## Lectura futura mínima

Solo la raíz ejecutará la sonda después de revisar el candidato, con el GW2 abierto y argumentos
recién obtenidos de la sonda TEB/TLS fiable. Se necesita el PID **Linux**, la base del módulo y
el contexto actual; no reutilizar punteros de una ejecución anterior. La sonda verifica mapas,
base suministrada, hash del fichero mapeado y PE AMD64 antes de abrir `/proc/<pid>/mem` con
`O_RDONLY`. El entorno ya acreditó que esa apertura requiere la vía de permiso apropiada;
no repetirla dentro de un sandbox que oculta el proceso.

```sh
python3 docs/audit/loot-wallet-probe/probe.py \
  --pid "$GW2_LINUX_PID" --module-base "$GW2_MODULE_BASE" --context "$GW2_CONTEXT" \
  --samples 2 --interval 1
```

Primero se comprobarán únicamente los cinco rangos fijos de código/tabla y las vtables/getters
de la ruta. La capacidad debe ser una potencia de dos entre 1 y 4096, y count no excederla.
Después se leen como máximo **15 buckets de búsqueda y una relectura del elegido**: 16 lecturas
de 12 bytes, **192 bytes por muestra**. Todo el proceso admite hasta dos muestras y **4096 bytes
solicitados** en total, incluidos guards y relecturas. No se barre el mapa completo ni el heap.
Las regiones han de ser legibles, las lecturas exactas y los punteros válidos/alineados de x64.

La sonda relee el contexto propietario, personaje, header, bucket elegido y vtables. Cualquier
inconsistencia da `unknown`. Una clave ausente, un mapa vacío o un límite de colisiones también
dan `unknown`, nunca saldo cero. Solo una entrada ocupada con clave y hash esperados permite
emitir `candidate_value: 0`; todavía no acredita que sea el cero de magia volátil real.

JSONL emite exclusivamente el ID candidato, su valor/delta, timestamps y razones cerradas;
no vuelca la cartera, nombres, punteros o datos de otras monedas. Exit 0 significa muestras
candidatas completas; exit 2 indica desconocido/lectura incompleta. Los flags
`native_key_mapping_proven` y `acquisition_proven` siguen siendo `false`, incluso con fixture verde.

La prueba discriminante pendiente es comparar ese único saldo con magia volátil mostrada al
usuario y, con la ruta estable, contrastar una adquisición explícita y su aumento visible de seis.
Una discrepancia refuta la identidad o semántica candidata; no autoriza buscar coincidencias por
todo el heap. Dos muestras prueban una diferencia neta, no la causa ni todos los eventos.
Para ampliar soporte harán falta además cero real, gastos, otros ingresos, ráfagas, cambio de
personaje/contexto y límites numéricos. Hasta entonces las monedas de producto permanecen
sin soporte conocido; este candidato no se publica como perfil nativo validado.

## Validación en vivo del 7 octubre 2026

Esta sección supera lo dicho arriba sobre "sin validar", "runtime_wallet_attempted: false" y
"monedas de producto sin soporte conocido" para los 55 IDs de moneda indicados más abajo. Las
secciones anteriores y `receipt.json` se conservan sin cambios como historia.

David pidió añadir las monedas a la sesión y eligió como fuente el lector de cartera del addon
de Nexus, no la API. Autorizó ese día una sonda externa de solo lectura contra el juego abierto.
Se midió en Fedora con GE-Proton11-7 sobre el `Gw2-64.exe` instalado, cuyo SHA-256
(`27d179bf...10802c`) coincide con el del perfil.

- La sonda TEB obtuvo el contexto desde el hilo 508. Leyó 114 de 114 hilos, sin fallos, con una
  raíz de loot no nula y 2748 de 4096 bytes. Su autocontrol terminó con exit 0.
- `probe.py`, sin modificar, tomó dos muestras separadas por un segundo. Terminó con exit 0.
  Las dos dieron el mismo saldo para la clave 45 y un cambio neto de 0. Pidió y leyó 1736 bytes,
  4 buckets y no escribió nada. Ese saldo coincidió exactamente con el de la moneda 45 en
  `/v2/account/wallet`, consultada justo después.
- `full_map_compare.py` es una variante de diagnóstico. Reutiliza `Reader`, los guards y
  `currency_hash` de `probe.py` y solo sube el presupuesto a 64 KiB para leer una vez la tabla
  de la cartera (capacidad por 12 bytes). No barre el heap ni escribe. Resultado: capacidad 128,
  55 entradas, 55 buckets ocupados, 4088 bytes pedidos y leídos, 0 claves con hash incorrecto
  y 0 claves inalcanzables por sondeo lineal.
- Comparado con `/v2/account/wallet`: la API tiene 55 monedas y las 55 claves nativas son
  exactamente esos IDs. Ninguna está solo en la API ni solo en el mapa nativo. 54 saldos son
  idénticos. La moneda 45 (magia volátil) tiene 11 más en el juego, porque la API responde desde
  una caché de 5 a 10 minutos y David estaba jugando.
- IDs comparados: 1, 2, 3, 4, 7, 15, 16, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 32, 34,
  35, 37, 38, 41, 42, 43, 44, 47, 49, 50, 51, 54, 58, 60, 61, 62, 63, 65, 66, 67, 68, 69, 70,
  71, 72, 73, 75, 76, 78, 79, 80, 81, 82, 83.

Queda acreditado que, para esos 55 IDs y en ese binario, la clave nativa es el ID público de la
moneda y el saldo es el DWORD en `+4` del bucket. Los detalles y los hashes de cada pieza
(sonda TEB, `probe.py`, `profile.json`, `full_map_compare.py`) están en
[`receipt-live-2026-10-07.json`](receipt-live-2026-10-07.json). El recibo no contiene saldos.

Sigue sin acreditar:

- La causa de una adquisición.
- El cero real de una moneda gastada del todo.
- El cambio de personaje o de contexto.
- Las ráfagas de cambios.
- Los límites numéricos.
- Windows nativo.
- El funcionamiento del lector dentro del addon, que es otro trabajo en el repo
  `tyrian-companion-nexus`.

Límite de producto: el mapa nativo es disperso. Una moneda que la cuenta nunca ha tenido no
tiene clave, así que su primera aparición es una línea base local sin delta y su primera
ganancia no se cuenta.
