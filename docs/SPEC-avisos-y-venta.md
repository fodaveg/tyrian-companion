# SPEC: aviso de drop valioso y señal de venta del saco

Escrito el 2026-09-03 tras la revisión de dominio y de arquitectura de esa fecha. Esta es la
especificación que lee la sesión que implementa; no arrastra la conversación de diseño. Las tareas
viven en Lumbre, lista «GW2 - Plugin Obsidian», sección «H13 — Avisos y venta del saco».

## Lo que David quiere, con sus palabras

«Me interesa sobre todo de cara al farmeo del laberinto en halloween. Quiero que me salten avisos si
me cae algo gordo. También que me diga cuándo es buen momento para vender las bolsas de trick or
treat.» «Tengo que activar demasiadas cosas... solo quiero un aviso si el plugin detecta algo gordo
de halloween o en general algún drop de mucho valor.» «Quiero que se vea mientras juego, por lo que
el aviso tiene que saltar por encima de la ventana.» «Yo pondría todos los avisos.»

## Decisiones tomadas el 2026-09-03 (no se reabren aquí)

| Decisión | Valor |
|---|---|
| Cuándo vigila el plugin | Solo con sesión activa (manual o asistida). Sin sesión no hay red. Se mantiene «ninguna llamada de red al cargar». |
| Interruptores | Ninguno. El aviso viene encendido. Halloween se activa solo por calendario (ventana del pack, 1 oct a 15 nov UTC). |
| Umbral de «gordo» por valor | 5 oros (50_000 cobre), editable. Independiente: raro ligado o sin precio, primera vez visto, skin o mini no desbloqueados avisan siempre. |
| Canales | Todos a la vez: toast de Obsidian, notificación del sistema, sonido, webhook opcional. El aviso dentro del juego va por Nexus, lote aparte (H13.9). |
| Histórico de precios | datawars2 como semilla, una descarga sin clave; el plugin sigue capturando lo suyo. Toca `docs/PLATFORM_POLICY.md` (H13.8). |
| Nexus | Autorizado, después del aviso por API. Toca «no inspecciona el proceso del juego» (H13.8). |

## Hechos medidos que gobiernan el diseño

- La API de cuenta sirve desde caché de 5 a 10 minutos. El aviso llega entre 5 y 20 minutos después
  del drop y la interfaz lo dice. Poll a 5 minutos durante la sesión es el máximo útil.
- Mumble Link y NexusLink no exponen inventario. El aviso sale siempre del delta de la API.
- La API oficial no da histórico en los endpoints probados (`/v2/commerce/prices/36038` devuelve solo
  el precio actual; `/v2/commerce/history` da 404). No se localizó endpoint público de
  gw2efficiency. datawars2 responde: `https://api.datawars2.ie/gw2/v1/history?itemID=36038`, 200,
  serie diaria desde 2012-10-24 con `buy_price_max/min`, `sell_price_max/min`, cantidades y `date`.
- Ciclo anual del saco (mejor puja media mensual): suelo en noviembre (3,2 a 3,6 plata), techo en
  abril y mayo (4,2 a 4,9) y en septiembre; deriva anual a la baja (2024: 5,8; 2025: 4,7; 2026:
  4,0). Amplitud máximo/mínimo 1,35x: con 500 sacos la diferencia son unos 5 oros.

## Alcance del lote de octubre, en orden

1. **H13.1** Primera ejecución humana en bóveda desechable. Antes de nada.
2. **H13.2** Alerta de venta: semilla datawars2, modelo anual, armada fuera de temporada, tercera
   salida «guardar» en el kernel de 36038, ganancia absoluta en la interfaz.
3. **H13.3** Aviso único de drop valioso en toda sesión activa, dos criterios en OR, poll a 5 min,
   test de cableado sobre `main.ts`.
4. **H13.4** Canales: `new Notification()` con urgencia `critical`, sonido embebido, webhook
   opcional. Medir en la máquina de David con GW2 en ventana sin bordes y en pantalla completa.
5. **H13.5** Detector: `36038` al alza como señal necesaria; bajada en el mismo delta invalida.
6. **H13.7** `validUntil` del pack y del bundle después del 15 de noviembre.
7. **H13.8** Política y PRODUCT reescritos con las dos decisiones.
8. **H13.6** Des-mezclar aperturas: sesión `estimada` con banda en vez de `contaminada`.
9. **H13.14** Sacos/h como banda y contador en vivo.

Después, la deuda (H13.10 a H13.13) y el addon de Nexus (H13.9).

## Contrato del aviso

- Un solo punto de salida, `emitAlert`, que reparte a todos los canales. Sustituye el uso directo de
  `emitNotice` para avisos de loot y de precio; `emitNotice` sigue para mensajes operativos.
- Entrada: `{ kind: 'valuable_loot' | 'always_alert' | 'sell_signal' | 'hold_signal', itemId,
  name, quantity, totalCopper | null, reason }`.
- Ningún canal recibe la clave de API, el account id ni snapshots. El webhook manda nombre,
  cantidad y valor.
- Cada aviso se persiste en la cola existente de Halloween para que el panel lo muestre aunque la
  notificación se pierda.

## Contrato de la señal de venta

- Serie diaria de `36038` sembrada desde datawars2 al primer arranque con sesión, y luego la
  captura propia del plugin la extiende. Si datawars2 falla, se declara «sin semilla» y se usa lo
  capturado; nunca se inventa un día.
- `sell_signal`: puja de hoy ≥ 90 % del máximo de los 365 días anteriores, fuera de la ventana de
  temporada. `hold_signal`: dentro de la ventana, puja ≤ mínimo de los 365 días anteriores.
  El porcentaje es un dato del pack, no una constante.
- Enfriamiento de 24 horas entre avisos del mismo tipo, reutilizando el existente.
- El advisor añade la salida `hold` y recomienda fuera de temporada.

## Lo que este lote NO hace

No abre «qué me falta para X». No opera sobre la cuenta ni el bazar. No vigila sin sesión. No
saca la capa H8 del árbol. No convierte datawars2 en fuente continua.
