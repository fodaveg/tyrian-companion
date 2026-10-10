# M4: perfil de arrancar y cerrar una sesión en vivo de 3 h

Medido en `6fbe77e` (0.6.24), 10 oct 2026, Node v22.23.1, Fedora, 24 hilos con la máquina cargada por
otros agentes (load average entre 2 y 17 durante las medidas). Apóyate en los porcentajes.

## Comando

```
node docs/audit/m4-profile/run.mjs <dir de salida> --name=realista
node docs/audit/m4-profile/run.mjs <dir de salida> --name=pesado --items=400 --drops=5 --change-permille=500
```

`run.mjs` empaqueta `measure.ts` con esbuild (con mapa de fuentes, para que el perfil diga líneas de
`src/`) y lo lanza una vez por formato de nota (1 y 2), un proceso tras otro. Escribe
`<name>-format1.md` y `<name>-format2.md`; las salidas de esta medida están en `results/`.
No hace falta `npm install`; usa `esbuild` y `source-map-js` del `node_modules` existente.

Por cada formato: se construye una sesión de 10 800 muestras (3 h a 1 muestra/s) con el ciclo de vida
real sobre `MemorySessionRuntimeStore`; luego, 7 repeticiones medidas sin perfilador y 5 con el
perfilador del inspector (100 µs) que envuelve solo la operación. Cada repetición parte de una copia
del almacén. A = `LiveSessionLifecycle.initialize()`; B = `stop()` + `SessionNoteWriter.writeLive`
(render, validación y escritura en un vault en memoria).

- `realista`: 40 objetos distintos, 1,46 % de muestras con cambio (158 de 10 800; el dato real era
  75 de 4 609 = 1,6 %), un objeto por cambio.
- `pesado`: la forma del audit (400 objetos, 5 por cambio, 50 % de muestras con cambio).

Para un `.cpuprofile` completo: `node --cpu-prof --cpu-prof-dir=<dir> <dir de salida>/measure.mjs --variant=1`
(el `.cpuprofile` no se commitea).

Añadido el 11 oct 2026 (ver `2026-10-11-perfil.md`):

- `--store=idb`: el diario vive en el `IndexedDbSessionRuntimeStore` de producción sobre fake-indexeddb, no en
  `MemorySessionRuntimeStore`.
- `--marks=1`: escribe la ventana (µs, mismo reloj que `--cpu-prof`) de cada A y B sin perfilar;
  `analyze-cpuprofile.mjs <cpuprofile> <marks.json> <measure.mjs> --label=A` recorta esas ventanas del perfil del
  proceso entero y da tiempo propio y acumulado con líneas de `src/`. Con `--cpu-prof`, pasa `--prof-reps=0`.
- `--dump-journal=1`: vuelca el diario construido; `idb-probe.mjs <journal.json> <dir> --playwright=<playwright-core>`
  lo carga en el IndexedDB real de un Chromium headless (perfil en disco, navegador nuevo por lectura) y mide la
  lectura como la hace `readLiveJournal` y con `index.getAll`. WebKit no arranca en Fedora (faltan dependencias).

## Resultado (mediana de 7, mín–máx, ms)

| Escenario | Op | Formato 1 | Formato 2 |
|---|---|---|---|
| realista | A arrancar | 51 (49–61) | 6 (5–8) |
| realista | B cerrar+nota | 291 (255–324) | 40 (36–64) |
| pesado | A arrancar | 528 (480–607) | 1294 (522–1505), 1.ª rep. 522 |
| pesado | B cerrar+nota | 5794 (5708–6293) | 13757 (6227–14479), 1.ª rep. 6227 |

El formato 2 del escenario pesado se midió cuando la máquina subió a load 15: usar la primera
repetición (522 y 6227 ms, igual que el formato 1) como la medida fiable; con 50 % de muestras con
cambio el formato 2 no quita casi nada (5 418 de 10 801 entradas).

## Qué NO mide

- IndexedDB real: el almacén es en memoria. El `structuredClone` que domina A es el de
  `MemorySessionRuntimeStore.readLiveJournal`; el coste real del cliente (lectura y deserialización
  de IDB) no está medido.
- El resto de `runtimeReady` de `tyrian-companion-core.ts` (otros servicios, capa de Obsidian).
- El vault real, Obsidian, Hebra, ni el renderizado.
- Sin economía de precios corriendo: las entradas con botín quedan con alerta `awaiting_price`, así
  que en el escenario pesado `stop()` reescribe más entradas (`replaceLiveJournal`) que en una
  sesión real con precios resueltos.
- Rep. 1 de cada proceso no es arranque en frío de verdad: el JIT ya se calentó al construir la sesión.
