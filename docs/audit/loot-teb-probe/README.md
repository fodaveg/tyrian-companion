# Sonda aislada TEB/TLS (6 octubre 2026)

Esta herramienta diagnóstica sigue únicamente la ruta de contexto identificada en el binario
GW2 con SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`.
Se ampara en la excepción de investigación de [PLATFORM_POLICY](../../PLATFORM_POLICY.md#excepción-de-investigación--captura-local-de-objetos-6-oct-2026).
No está conectada al plugin ni a los addons distribuidos. Una raíz de loot no prueba ID/cantidad
ni un evento de adquisición. El programa declara siempre `loot_capture_proven: false`.

## Construcción y control antes de leer GW2

Desde la raíz del worktree, con el MinGW existente (sin instalaciones):

```sh
x86_64-w64-mingw32-gcc -std=c11 -O2 -Wall -Wextra -Werror -Wpedantic -static-libgcc \
  docs/audit/loot-teb-probe/probe.c -o /tmp/tyrian-teb-probe.exe
python3 docs/audit/loot-teb-probe/check.py /tmp/tyrian-teb-probe.exe
```

El presupuesto de build es 20 MiB; el ejecutable y los logs son temporales fuera del repo. La
comprobación estática inspecciona las importaciones PE; no ejecuta el programa ni valida su ABI.
No se necesita Node ni el runner del plugin porque esta sonda no modifica el runtime distribuido.

La raíz ejecuta `tyrian-teb-probe.exe --self-test` bajo el **mismo Wine y prefix del GW2 activo**,
sin crear otro prefix. No hay UI. Ese modo no enumera GW2 ni abre handles del juego. Compara
`NtQueryInformationThread(GetCurrentThread(), ThreadBasicInformation)` con `NtCurrentTeb()` y
con una lectura exacta de `NT_TIB.Self`. Hace una RPM deliberadamente inválida a dirección `1`;
exige fallo, cero bytes y error Win32 no cero. La fixture sintética de la misma función de lectura
valida la ruta, el resultado nulo, el límite de índice, el guard de rango y el presupuesto. La
lectura real repite el autocontrol antes de abrir cualquier proceso GW2.

La estructura nativa AMD64 de información de hilo es interna: tamaño 48, TEB en offset 8,
IDs de proceso/hilo en 16/24. El autocontrol exige tamaño devuelto e IDs correctos y detiene
la sonda si Wine/Windows no cumple esa ABI. [Microsoft recomienda resolver la función dinámicamente](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationthread).
`GetModuleHandleW`/`GetProcAddress` la resuelven desde el `ntdll.dll` ya cargado.

## Selección e identidad

```text
tyrian-teb-probe.exe --enumerate
tyrian-teb-probe.exe --confirmed-build-sha256 27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c --pid <PID_WINDOWS> --max-threads 127
```

Los PID son Windows, descubiertos mediante Toolhelp dentro del mismo Wine/prefix; el PID Linux
de `/proc` no sirve como argumento. `--pid` es opcional si hay un único `Gw2-64.exe`; la ambigüedad
detiene la lectura. Los nombres y rutas de otros procesos nunca se emiten.

**La raíz debe comprobar el hash del binario vivo por separado antes de confirmar el perfil.**
`--confirmed-build-sha256` es esa confirmación externa, no un hash calculado por la sonda. La
sonda comprueba proceso, módulo, límites del RVA y arquitectura nativa AMD64; no acredita por
sí sola correspondencia de la imagen cargada con el fichero. Los RVA no sirven para otras builds.

## Lecturas y límites

El proceso se abre con `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ`; cada hilo, solo con
`THREAD_QUERY_INFORMATION`. Toolhelp se usa para procesos, módulo y lista de hilos, nunca heaps.
Todos los handles se cierran, incluidos los caminos de fallo. No hay debugger, suspensión,
escrituras, DLL propia, hooks, `CreateRemoteThread`, privilegios elevados ni escaneos.

| Lectura | Bytes | Condición |
| --- | ---: | --- |
| Módulo + `0x28145C0` | 4 | Índice TLS de esta build; dentro de `modBaseSize`; índice ≤ 4095 |
| TEB + `0x58` | 8 | Puntero `ThreadLocalStoragePointer` |
| TLS array + índice × 8 | 8 | Puntero al bloque TLS del módulo |
| TLS block + `0x10` | 8 | Puntero de contexto observado en `GetContext`, RVA `0x9B1E00` |
| Contexto + `0x198` | 8 | Puntero al contexto de loot; no se lee su contenido |

Se aceptan punteros alineados de ocho bytes, entre `0x10000` y `0x00007FFFFFFFFFFF`.
Cada RPM exige éxito **y** tamaño exacto; una lectura parcial nunca se interpreta como puntero.
`ReadProcessMemory` comprueba que el rango solicitado es accesible, según [su contrato de Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory).
Un puntero nulo termina la cadena con resultado ausente. Una dirección no válida o un error de
lectura termina ese hilo y marca el resumen incompleto. Las rutas no son un snapshot atómico:
el hilo/contexto puede desaparecer o cambiar entre lecturas. No se pausa el juego para evitarlo.

El cap es 127 hilos, con 100 por defecto, y **4096 bytes solicitados al juego** por ejecución;
con 127 rutas completas se solicitan 4068 bytes. `--max-threads` admite 1–127 y la lista sigue contándose tras
alcanzar el cap sin leer los hilos restantes. El resumen incluye total, examinados y límite;
excederlo devuelve cobertura incompleta. No se infiere ausencia global de contexto desde
una lista parcial. El autocontrol usa exclusivamente memoria propia y presupuesto separado.

## Salida y resultado

JSONL por stdout: `self_test`, `gw2_process`, `profile`, `thread_route`, `thread_error`, `error`
y `summary`. Solo IDs, punteros de la ruta, índices, contadores y códigos cerrados. No hay
nombres de personajes, inventario, credenciales ni payloads de loot. La fila de cada ruta indica
la última dirección leída, tamaño solicitado y copiado; los fallos preservan Win32/NTSTATUS.
Los números NTSTATUS se emiten en hexadecimal de 32 bits.

| Exit | Significado |
| --- | --- |
| 0 | Autocontrol válido o todas las rutas de la lista obtenida examinadas sin fallos |
| 1 | Autocontrol/identidad/arquitectura/apertura/índice o snapshot falló |
| 2 | Lista ambigua/ausente en enumeración, cap, cero hilos o una ruta/hilo falló |
| 64 | Argumentos inválidos o modos incompatibles |

Un exit 0 y raíces de loot no cero acreditan acceso a esos punteros durante esa ejecución;
no acreditan semántica ni captura de objetos. Incluso un exit 0 no garantiza que la lista
Toolhelp incluya hilos creados después del snapshot. Guardar stdout, exit code, hash del fuente
y hash del ejecutable junto al candidato revisado; no reutilizar evidencia tras cambiar el código.


## Resultado acreditado de este candidato

La raíz ejecutó el EXE SHA-256 `c388acab8acdfa8cd98b28d7a99d20779a3cdb3703df073fe0f9ca6481ba8543`
bajo GE-Proton11-7 y el prefix activo de GW2. El modo propio terminó con exit 0 y todos los
controles en `true`; la RPM inválida falló con Win32 299 y cero bytes, como exige el control.
La lectura real también terminó con exit 0: **114/114 hilos**, cero fallos, una raíz de loot
no nula y **2748/4096 bytes**. El hilo Windows 508 resolvió el contexto `0x19C8DE0` y la raíz
`0x28B0D0`. Estos punteros son observaciones de esa ejecución, no constantes del programa.

La comprobación PE y la compilación con `-Werror` pasaron. La prueba negativa cambió solo el
cap de una copia temporal a 128: el compilador la rechazó con `thread cap exceeds read budget`.
El cap permitido 127 conserva el presupuesto; la copia negativa no fue ejecutada ni quedó
incluida en el binario utilizado. No se repitió la lectura real para documentar este resultado.

El [recibo](receipt.json) vincula fuente, EXE, checks y los archivos de [evidencia](evidence/).
Incluye las salidas JSONL exactas, stderr vacío y exit codes; el EXE temporal no se publica en
el repo. El hash del juego fue confirmado externamente por la raíz. Las comprobaciones de
acceso no son una observación de ID, cantidad o evento de adquisición: **captura de objetos
pendiente**. Tampoco validan un lector Nexus/Blish HUD ni permiten prometer que la ruta exista
en otra versión, otro momento o durante todas las adquisiciones.

Para reproducir el control negativo sin modificar el candidato, copiar `probe.c` a una ruta
temporal, sustituir una sola vez `#define THREAD_LIMIT 127u` por `#define THREAD_LIMIT 128u`,
y ejecutar `x86_64-w64-mingw32-gcc -std=c11 -Wall -Wextra -Werror -Wpedantic -fsyntax-only`
contra esa copia. Exigir exit distinto de cero y el diagnóstico anterior; retirar la copia.
