# QA manual del MVP

## Estado y alcance

Este protocolo cubre H6.8/H6.9. La ejecución humana está **pendiente**: una guía
preparada no acredita una prueba superada.

Procedencia: se escribió el 14 de agosto de 2026 en el worktree `test/h6-manual-qa` y nunca
llegó a un commit. Se recuperó a `main` el 18 de agosto de 2026 sin cambiar el protocolo. Las
cifras de gate verde que citaba (1.085 tests el 14 de agosto) se han quitado a propósito: hay
que volver a medirlas sobre el candidato que se pruebe de verdad, porque un número de hace
cuatro días no acredita este binario.

La instalación y la actualización desde el artifact beta son H7.5 y tienen su propio
procedimiento en [la guía beta](BETA.md). La fila «Updater/reopen» de la matriz de abajo no la
sustituye: comprueba que el plugin recarga, no que el instalador transaccional haga bien su
trabajo.

No se prueba Mumble Link, automatización del juego, H7 ni una actualización del plugin en
esta ejecución. La comprobación de updater/reopen es una prueba separada del recovery de
sesión.

## Prerrequisitos y evidencia

1. Crear una bóveda **desechable** nueva. No abrir, copiar ni modificar la bóveda canónica.
2. Instalar el candidato y anotar versión de Tyrian Companion, SHA, versión de Obsidian,
   sistema operativo y, cuando aplique, Steam/Proton o CrossOver.
3. Crear en la bóveda desechable un secreto de Obsidian con una clave de pruebas con permisos
   mínimos. No pegar el token, su ID ni el `accountId` en notas, logs, capturas o informes.
4. Configurar una carpeta de salida portable, por ejemplo `Tyrian Companion QA`, y seleccionar
   el secreto por su nombre no sensible.
5. Registrar timestamps en UTC y conservar solo: ruta y SHA-256 de la nota generada, resultado
   visible, versiones y capturas sin secretos. Recortar u ocultar nombre de cuenta, claves,
   IDs y rutas personales antes de compartir una captura.

Para cada fila, conservar una evidencia mínima y marcar `PASS` solo tras observar el resultado
esperado. Si aparece un error saneado, un estado distinto o un control bloqueado fuera de lo
previsto, marcar `FAIL`, anotar el paso y no forzar la operación.

## Recorrido manual de sesión

Ejecutar una sola sesión limpia en la bóveda desechable:

1. En Ajustes, ejecutar **Check connection**. Debe quedar `connected` o `warning`; con ese
   estado y runtime `idle` queda disponible **Iniciar sesión de farmeo**.
2. Abrir **Iniciar sesión de farmeo**, completar el modal con personaje y Magic Find manual y
   confirmar. Esperar a que la bitácora muestre `active`.
3. Ejecutar **Finalizar sesión de farmeo**. Tras la captura final, esperar el estado
   `provisional` y la disponibilidad de **Revisar sesión**.
4. Abrir **Revisar sesión**, responder la declaración de actividad y confirmar. Una revisión
   limpia confirmada debe llevar a `complete`; una declaración contaminada o dudosa puede
   conservar el resultado provisional según la revisión visible.
5. Ejecutar **Limpiar sesión completada** y confirmar. Debe generarse o reutilizarse una nota
   completa antes de limpiar el runtime. Verificar que existe una única nota bajo
   `Tyrian Companion QA/sessions/<año UTC>/`, calcular su SHA-256 y confirmar el retorno a
   `idle`.
6. Abrir `Tyrian Companion QA/Bases/Sessions.base`. Debe cargarse y mostrar solo sesiones que
   cumplan sus filtros `tc_schema` y `tc_kind`; no editar sus consultas para hacer que pase.

## Assets gestionados

En Ajustes, usar **Preview** para la raíz de assets y comprobar que no crea ni modifica archivos.
Después usar **Apply** una sola vez y verificar `Sessions.base` y el manifiesto bajo la raíz
gestionada configurada. Si Preview informa conflicto, asset modificado/ajeno o formato futuro,
el resultado esperado es bloqueo sin sobrescritura; no usar Repair, Move o Remove como atajo.

## Recovery, concurrencia y sincronización

### Cierre forzado y reinicio

Con una sesión `active`, cerrar Obsidian de forma forzada y volver a abrir la misma bóveda
desechable. Debe aparecer recovery y permitir recuperar o descartar explícitamente; no debe
empezar, terminar ni borrar una sesión de forma automática. Repetir desde `stopping` o
`provisional` si el entorno permite llegar a ellos, verificando que Recovery no recaptura la
evidencia de frontera.

### Dos ventanas del mismo dispositivo

Abrir dos ventanas del mismo vault/origin. Iniciar desde una y pulsar el mismo inicio o un
inicio competidor en la otra. Debe existir una única sesión activa: el lease/mutex bloquea o
rechaza al competidor sin crear una segunda nota ni sobrescribir runtime. Repetir Preview/Apply
de assets desde ambas ventanas: solo una operación puede quedar en curso.

### Dos dispositivos: Linux y macOS

Usar dos bóvedas locales desechables sincronizadas, una en Linux y otra en macOS. IndexedDB y
SecretStorage son locales a cada dispositivo: seleccionar por separado un secreto de pruebas y
no esperar que token, runtime o lease se sincronicen por el vault. Sincronizar únicamente los
archivos de la bóveda y comprobar que las notas y assets portables convergen sin sobrescribir un
archivo modificado o ajeno. No ejecutar sesiones simultáneas suponiendo exclusión entre
dispositivos: el lease es por máquina.

### Updater/reopen

Con runtime `idle` y sin operación de assets en curso, actualizar o reinstalar el mismo
candidato y reabrir Obsidian. Verificar por separado que el plugin carga y que la selección del
secreto sigue siendo una referencia, no un valor visible. Esta fila no acredita recovery; el
recovery se valida con el cierre forzado anterior.

## H13.1 — Primera ejecución humana

Esta sección documenta el protocolo de validación de H13.1 en la bóveda desechable creada por
David. La bóveda está preparada con el build de producción `0.1.21` verificado por SHA-256, y
aguarda ejecución humana.

### Recorrido de la sesión

1. Abrir la bóveda desechable en Obsidian.
2. En Ajustes, verificar que el secreto de API está seleccionado y ejecutar **Check connection**;
   debe marcar `connected` o `warning`.
3. Ejecutar **Iniciar sesión de farmeo**, introducir personaje y Magic Find manual, confirmar y
   esperar a que el estado pase a `active`.
4. Farmear un mapa durante al menos 15 minutos. La API de cuenta sirve desde caché de 5 a 10
   minutos, así que un recorrido más corto puede dar delta vacío y hacer fallar la prueba por el
   instrumento en vez de por el plugin.
5. Ejecutar **Finalizar sesión de farmeo** y esperar a `provisional`.
6. Abrir **Revisar sesión**, responder la declaración de contaminación y confirmar.
7. Ejecutar **Limpiar sesión completada**.
8. Abrir la nota generada bajo `Tyrian Companion QA/sessions/<año UTC>/` y verificar que contiene
   valores económicos y no dice `valuation: null`.
9. Esta ejecución NO prueba el aviso nuevo de drop valioso (H13.3/H13.4, posterior). Si la detección
   asistida estuvo armada, abrir la bandeja de Halloween en Ajustes y verificar que no hay errores
   en el histórico de propuestas presentadas.

### Datos que anotarás

Conserva solo estos datos; nunca incluyas token ni `accountId`:

- Versión del plugin: `0.1.21` (de `manifest.json`).
- SHA del commit de `main` con el que se construyó el build.
- Versión de Obsidian (Ajustes > About).
- Sistema operativo (Linux/macOS/Windows, con distribución/versión).
- Hora UTC de inicio y fin de la sesión (formato ISO 8601).
- Ruta relativa de la nota generada, por ejemplo `Tyrian Companion QA/sessions/2026/2026-09-03.md`.
- SHA-256 de la nota generada (comando `sha256sum <fichero>` o `shasum -a 256 <fichero>`).
- ¿Se vio el aviso en la pantalla (para drops valiosos)? (sí/no/no aplicable).
- ¿Se vio una entrada en la bandeja de Halloween? (sí/no/no aplicable).
- Observaciones: cualquier diferencia notable, error o comportamiento inesperado.

### Secreto de API y privacidad

- El secreto se crea como un secreto de Obsidian directamente en la bóveda desechable, no en la
  bóveda real.
- La clave de API debe tener los permisos descritos en [API-KEY.md](API-KEY.md).
- Nunca pegues la clave, su ID ni el `accountId` en notas, capturas, logs o informes.
- Recorta cualquier captura de pantalla de forma que oculte el nombre de cuenta, rutas personales
  y valores de configuración.

### Recarga del plugin

Importante: si ejecutas esta prueba sobre la bóveda real de David en lugar de una desechable,
antes de empezar recarga el plugin en Obsidian (Ajustes > Community plugins > Tyrian Companion >
reload, o Ctrl+P > "Reload app without saving"). Esto garantiza que ejecutas `0.1.21` y no la
versión anterior que estaba en memoria al instalar el build.

### Matriz de validación

Ejecutada el 2026-09-03 sobre la `0.1.21`, en Linux y en la bóveda **real**, no en la desechable que
pide el protocolo. Personaje Rinopopo, Guardian, build Power Willbender, Magic Find 333. De
`2026-09-03T05:30:49Z` a `2026-09-03T06:24:40Z`, 53 minutos y 51 segundos. Precios capturados a las
`2026-09-03T06:35:16Z`, fuente `gw2-commerce-prices`. Nota generada bajo
`42 Guild Wars 2/42.31 Wiki/sessions/2026/`, 11.712 bytes, SHA-256
`c88707937efc11fecef7aaa72b4adf1edd59e64a4d8753d6c0b31d648d74a02a`.

| Paso | Criterio PASS | Resultado (PASS/FAIL) |
| --- | --- | --- |
| Check connection | `connected` o `warning` | PASS |
| Iniciar sesión | Modal de personaje y Magic Find aceptado; estado → `active` | PASS |
| Farmeo en vivo | Sin errores en la bitácora durante al menos 15 minutos de actividad | PASS, 53 min 51 s |
| Finalizar sesión | Captura sin error; estado → `provisional` | PASS |
| Revisar sesión | Confirmación sin error; estado → `complete` | PASS |
| Nota generada | Existe la nota; contiene valores económicos (no `valuation: null`) | **FAIL** |
| Aviso (si aplica) | No aplicable: la `0.1.21` no incluye el aviso nuevo (H13.3/H13.4). Si la detección asistida está armada, verificar que no hay errores en el histórico de propuestas. | NO APLICABLE |

El resto del protocolo de arriba (bóveda desechable, `Sessions.base`, Preview y Apply de assets,
cierre forzado, recovery, dos ventanas, matriz por plataforma) **no se ejecutó** en esta sesión.

### Por qué falla la fila de la nota

La nota existe y está completa de forma, pero no trae ni una cifra económica.
`tc_observed_immediate_copper`, `tc_observed_listing_copper`, `tc_immediate_copper_per_hour`,
`tc_listing_copper_per_hour`, `tc_sacks` y `tc_sacks_per_hour_milli` salieron `null`,
`tc_recommendation_status` quedó en `not_evaluated` y las 40 filas de botín dicen «Oculto por
fiabilidad», con `tc_classification: "contaminated"` y `tc_confidence: "high"`.

La causa medida, contra `/v2/currencies` y `/v2/items`:

- **Monedero**: bajaron la moneda `37` (Exalted Key) y la `42` (Vial of Chak Acid), una unidad cada
  una, que es lo que cuesta abrir un cofre con su llave. La moneda `1` (Coin) **subió 46.083 cobre**.
- **Almacenamiento**: el objeto `84731` (Piece of Unidentified Gear) bajó 239, por abrir contenedores.
- **Precios**: parte del botín sin cotización y sin profundidad de bazar suficiente.

Lo que sí quedó verificado: la tubería entera responde y las junturas de la `0.1.21` funcionan
(`tc_reservation_status: "complete:met"`, `tc_hold_status: "released"`). El arreglo del veredicto
suprimido es el ticket H13.6.

## Matriz de resultados

| Caso | Criterio PASS | Evidencia mínima | Resultado (PASS/FAIL) |
| --- | --- | --- | --- |
| Conexión y start | `connected` o `warning` → modal → `active` | Timestamp UTC y captura saneada | PENDIENTE |
| Finish, review y complete | `active` → `provisional` → revisión → `complete` cuando corresponda | Respuestas no sensibles y captura saneada | PENDIENTE |
| Nota antes de clear | Nota única escrita/inalterada antes de `idle` | Ruta relativa y SHA-256 de la nota | PENDIENTE |
| `Sessions.base` | Abre y filtra por `tc_schema` y `tc_kind` | Captura saneada de la Base | PENDIENTE |
| Preview/Apply | Preview sin I/O; Apply instala assets gestionados | Ruta relativa, hash de `Sessions.base` y manifiesto | PENDIENTE |
| Recovery | Recovery visible tras cierre forzado; decisión explícita | Timestamp, estado previo/posterior y captura saneada | PENDIENTE |
| Dos ventanas | Un lease de sesión y una operación de assets; competidor bloqueado/rechazado | Timestamps de ambas ventanas y capturas saneadas | PENDIENTE |
| Linux/macOS con Sync | Estado local no se comparte; vault converge sin sobrescritura | Versiones, hashes/rutas relativas y capturas saneadas | PENDIENTE |
| Updater/reopen | Carga correcta y secreto nunca visible | Versiones, SHA y captura saneada | PENDIENTE |

Al cerrar la ejecución, adjuntar el informe al candidato probado con la fecha absoluta de la
prueba. No incluir tokens, `accountId` crudo, payloads de inventario, snapshots ni capturas que
los contengan.
