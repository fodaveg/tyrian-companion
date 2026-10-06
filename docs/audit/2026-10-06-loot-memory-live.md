# Captura directa de objetos — prueba dinámica del 6 octubre 2026

**Prueba conseguida: dos recogidas reales de Champiñón, ID 12147, +2 unidades cada una, sin DRF.**

Esta continuación sustituye el veredicto de viabilidad pendiente de la primera etapa. No cambia
su evidencia histórica: aquella solo demostró acceso a constantes. Ahora se leyó el inventario
transportado del personaje controlado, se observaron cambios de cantidad y David los confirmó.

## Resultado observado

| Recogida | ID | Total anterior | Total posterior | Incremento | Contraste |
| --- | ---: | ---: | ---: | ---: | --- |
| 07:52:01, hora de Madrid | 12147 | 0 | 2 | +2 | David respondió que sí recogió dos champiñones |
| 07:54:24, hora de Madrid | 12147 | 2 | 4 | +2 | Captura del juego: 2 Champiñones y 6 magia volátil |

La captura posterior de DRF también muestra esas dos recogidas (07:52:00 y 07:54:24),
cada una con 2 champiñones y 6 magia volátil; su resumen acumula 4 champiñones. Es contraste
externo, no la fuente de nuestra sonda. DRF seguía instalado: no se realizó un control con el
addon desactivado, aunque el lector no consulta sus APIs, exportaciones ni eventos.

El catálogo público `GET https://api.guildwars2.com/v2/items?ids=12147&lang=es` identifica
12147 como **Champiñón**, material de artesanía básico. No se usó una API key ni una consulta
API de inventario para detectar estas adquisiciones. La API se usó después para poner nombre al ID.

La segunda observación valida un aumento del total de un tipo ya presente. La referencia interna
cambió de 20328 a 39543; **no se afirma que fuera la misma instancia ni un callback de stack merge**.
Ambos eventos se aceptaron tras dos muestras consecutivas con las mismas cantidades.

La observación v2 terminó por su límite de 300 segundos, con exit 0: **507 muestras válidas,
cero rechazos y 31.203.621 bytes leídos**. Su referencia inicial contenía 307 objetos y cantidades
interpretables para 180 tipos; 73 tipos quedaron explícitamente sin cantidad soportada.

Una ampliación v3 separada, revisada y ejecutada durante 2 segundos, obtuvo tres muestras válidas,
308 objetos, 254 tipos con cantidad y cero tipos con cantidad desconocida **en ese inventario**.
Sus 19 controles sintéticos pasan. Esta ejecución valida los perfiles adicionales observados;
las dos adquisiciones se capturaron con **v2**, no con v3. No demuestra cobertura universal.

## Fuente y corrección necesaria

La sonda Win64 identificó la ruta TEB → TLS → contexto. El autocontrol y la lectura real del
candidato final pasaron: 114/114 hilos, cero errores y una raíz de botín. El lector externo Linux
siguió después campos concretos del personaje controlado y comprobó que este posee el inventario.

La primera interpretación del inventario fue incorrecta: es una estructura con varias secciones.
La matriz `+0xA8`, contador `+0xB4`, contiene ubicación tipo 4. La sección transportada tipo 3
usa matriz `+0xC8`, capacidad `+0xD0` y contador `+0xD4`. El getter y el switch del binario, más
las lecturas puntuales reales, acreditan esa diferencia. El filtro excluyó correctamente la sección
anterior, aunque aquello produjo un resultado vacío que no certificaba captura útil.

Se verifica ubicación tipo 3, propietario, referencia interna, getters, vtables, límites y estabilidad
de punteros/contadores. El ID sale de la definición del objeto; la cantidad, de los getters de
Stackable. Un player ID de la lista de loot no se interpreta como cantidad. Los perfiles desconocidos
se excluyen; no se les inventa cantidad 1. Los controles distinguen baseline, movimiento entre huecos,
cambio de personaje/inventario, aumento real de cantidad y lecturas rechazadas.

## Viabilidad y límites antes de un MVP

La lectura directa de ID y cantidad es **viable en el GW2 abierto bajo Fedora/GE-Proton11-7**, para
el binario SHA-256 `27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`.
No hace falta DRF como fuente para estos objetos. No se escribió ni pausó el juego; no hubo ptrace,
hooks, DLL inyectada ni modificación del runtime de Tyrian. Es una prueba externa y aislada,
amparada por la excepción de investigación de PLATFORM_POLICY, no un addon Nexus terminado.

La sonda observa **diferencias de inventario**, no un evento con causa certificada. Las acciones de
David y la captura corroboran estas dos recogidas. Ventas, depósitos, aperturas, consumo y otras
operaciones necesitan reglas y pruebas propias antes de anunciar cada aumento como drop.

Los 6 de magia volátil de la captura no fueron leídos: las monedas requieren una fuente aparte.
Tampoco se probó un objeto caro, un aviso visual/sonoro, precios, desconexiones ni una sesión completa
del laberinto. Faltan el addon Nexus, el transporte local y el consumidor de sesiones de Tyrian.
Los contratos de producción vigentes deben reconciliarse antes de implementar esa nueva fuente.

La dirección planteada en conversación es obtener las sesiones automáticas desde Nexus y reservar
la API de cuenta para consultas manuales de inventario. El catálogo público de nombres, iconos y
precios sigue siendo una función distinta. No se ha implementado esa transición.

Los límites son 640 posiciones, 131072 bytes por muestra, 400 MiB totales y 300 segundos. El intervalo
solicitado de 100 ms **no es la resolución real**: la primera ejecución obtuvo 507 muestras en
300 segundos. Los RVA y perfiles corresponden únicamente a esta build; hay que rechazar versiones
incompatibles. El éxito observado no promete que cualquier adquisición rápida sobreviva al muestreo.

## Evidencia

- `loot-inventory-probe/receipt.json`: hashes, comandos, candidaturas y resultados.
- En esa carpeta: fuentes v2/v3, controles, corrección de ruta, catálogo y trazas proyectadas.
- `loot-teb-probe/receipt.json`: sonda WinAPI y su evidencia completa de acceso.

Las trazas proyectadas conservan controles, resumen inicial, cantidades del ID contrastado, cambios
y cierre; omiten el listado completo del inventario. El recibo también guarda hashes de los originales
locales en /tmp: son evidencia complementaria temporal, que otra máquina puede no conservar.

La evidencia y las fuentes permanecen en la rama aislada de investigación. No se publicaron ni se
integraron en main; no se generó una release de este experimento.

## Requisito de interfaz de Hebra solicitado por David

Referencia: las dos capturas de Drop Research Facilities aportadas a las 07:59 del 6 octubre:
`Timeline View` y `Session Summary`. David pidió registrarlo como tarea o parte del audit.
Se incorpora aquí como comportamiento pendiente de implementar, no como pantalla ya construida.

- **Cronología:** hora de cada adquisición, icono/nombre/ID/cantidad de objetos, monedas recibidas
  y valor estimado. Debe actualizarse con el futuro flujo local de Nexus. La referencia inicial
  nunca se muestra como loot nuevo; una moneda aún no soportada no se presenta como cero.
- **Resumen de sesión:** totales por objeto y moneda, duración activa, valor estimado acumulado,
  valor por hora y gráfica temporal. Cronología y resumen deben reconciliar sus cantidades.
- **Valoración:** distinguir el valor estimado del loot del oro efectivamente recibido/gastado;
  indicar el criterio de precio utilizado. No copiar los importes de DRF como datos de Tyrian.
- **Exportación:** exportar cronología y resumen, conservando fecha, fuente y criterio de valoración.
- **Estado de conexión:** sesión activa/pausada y conexión con Nexus visibles; mostrar errores o
  datos incompletos sin fingir un flujo en tiempo real. Mostrar descubrimiento mágico solo si
  una fuente verificada lo aporta.

Criterio de aceptación para estas recogidas: cronología con dos entradas de Champiñón +2,
resumen de 4, y magia volátil +6/+6 y total12 solo cuando el lector de monedas lo haya capturado.
El total22 de la captura de DRF incluye eventos anteriores, por lo que no se atribuye entero a
estas dos recogidas. La UI debe representar correctamente el alcance de la sesión.

Dependencias: addon Nexus y transporte local, definición de eventos y sus causas, lectura de
monedas, consumidor de sesiones de Tyrian y valoración con catálogo/precios públicos. La API de
cuenta se reserva para las consultas manuales de inventario en la dirección planteada por David.
No se ha sustituido todavía la fuente de sesiones ni implementado esta interfaz.
