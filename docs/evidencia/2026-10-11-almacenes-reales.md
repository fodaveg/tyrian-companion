# Almacenes reales en Fedora, 11 oct 2026: DU-15 y DU-14

Máquina: Fedora de David. Código leído: `tyrian-companion` `main` = `4f5136c4` (= `origin/main`, limpio) y
`hebra` `main` 6acdd876 en solo lectura (`origin/main` no resolvía en ese clon; se leyó el árbol local,
limpio salvo `design/` y `vendor/` sin seguimiento).

Marcas: MEDIDO = leído de los ficheros reales; LEÍDO = leído en código; INFERIDO = deducido, no medido.

**Sin datos de la cuenta** (objetos, oro, personajes) en este documento. Los ids de vault y de biblioteca
van acortados a 8 caracteres. **Mac sin mirar.** Hebra web e iOS sin mirar.

## Cómo se aisló

- Obsidian y Hebra estaban **en ejecución** al copiar; las copias son instantáneas y no se operó ninguno de
  los dos. Sin Obsidian MCP y sin `obsidian eval`.
- Obsidian (flatpak): se copió la carpeta `IndexedDB/app_obsidian.md_0.indexeddb.{leveldb,blob}` del perfil
  de la aplicación a un directorio temporal. Un lector LevelDB propio en Python (tablas `.ldb` con snappy
  más `.log`, última versión de cada clave, metadatos de Chromium: nombre de base, versión, almacenes)
  imprimió solo nombres, versiones, recuentos y bytes; de `active-session-v1` solo los nombres de clave.
- Hebra (rpm, WebKitGTK): se copiaron las 19 bases `IndexedDB.sqlite3` (+ `-wal` y `-shm`, una carpeta por
  base, origen `tauri_localhost_0`) y se leyeron con `sqlite3 -readonly` y `python3 -I` sobre la copia
  (`IDBDatabaseInfo`, `ObjectStoreInfo`, `Records`, `IndexRecords`). El nombre de la base está en UTF-16.
- Una sola lectura directa, de solo lectura e inmutable, de la base de la biblioteca de Hebra: seis
  caracteres de `meta.library_id`, para saber si era un id distinto. Sin escritura.
- Código leído: en Tyrian, `session-storage-scope.ts`, `session-runtime-store.ts`,
  `live-session-persistence.ts`, `storage-deadline.ts`, `core/indexed-db-open.ts`,
  `economy/price-history-*.ts`, `core/settings.ts` y `host/hebra/local-storage.ts`; en Hebra,
  `lib/plugins/api/storage.ts`, `plugins/sync/plugin-sync-controller.ts`, `plugins-doc.ts`,
  `library/store.rs`, `sqlite-engine.ts`, `LibraryApp.svelte` y `linux_single_instance.rs`.
- Las copias se borraron al terminar (comprobado con `ls`); se conservaron los scripts, que no contienen
  datos. Ningún repo ni dato de David se escribió.

## DU-15

### 1. ¿Existe `tyrian-companion-session-runtime` sin sufijo y le falta el diario?

| Host | Base | Versión | Almacenes | Clase |
|---|---|---|---|---|
| Obsidian | `tyrian-companion-session-runtime` (sin sufijo) | 3 | `active-session-v1`, `live-inventory-journal-v1` | MEDIDO |
| Hebra | `tyrian-companion-session-runtime:38d12f98…` | 2 | `active-session-v1`, `live-inventory-journal-v1` | MEDIDO |
| Hebra | `tyrian-companion-session-runtime` (sin sufijo) | no existe | n/a | MEDIDO |

**Obsidian: la base vieja existe, está adoptada y completa (no le falta el diario).**
- Las claves de `active-session-v1` son `active-session`, `completed-session-summary` y
  `legacy-vault-owner`. La marca `legacy-vault-owner` existe: un vault (`f313b944…`) adoptó la pareja
  vieja en su sitio (la regla de H18.12) (MEDIDO).
- Es coherente con que no existan en Obsidian `session-runtime:<vault>` ni `coordination:<vault>` con
  sufijo; solo hay `pilot-metrics:f313b944…` y `confirmation-queue:f313b944…` (MEDIDO).
- El diario existe con 0 registros: ahora mismo no hay sesión en vivo con diario (MEDIDO).
- La versión 3 (el mínimo de creación es 2, `SESSION_RUNTIME_DB_VERSION`) es la que deja la ruta de
  reparación de DU-01 (`database.version + 1` cuando falta un almacén). Es decir, esta base se adoptó sin
  el diario y ya se reparó. No se puede demostrar con los ficheros (no hay histórico de versiones); lo
  medido es el estado final, v3 con ambos almacenes (INFERIDO la historia).

**Hebra: no existe la base sin sufijo.**
- Solo `…session-runtime:38d12f98…` v2 con los dos almacenes. Tampoco hay `coordination` sin sufijo; solo
  `coordination:38d12f98…` (MEDIDO).
- No hay `legacy-vault-owner` en la base de Hebra; las claves de `active-session-v1` son
  `active-session`, `completed-session-summary`, `legacy-api-runtime:<uuid>` y `live-session-summary-state`
  (MEDIDO).
- Por tanto el escenario de DU-01 no se da en Hebra: v2 es la versión de creación, sin reparación.

**Resumen:** DU-01 no está activo en ninguno de los dos hosts de Fedora.

### 2. Todas las bases de Tyrian, con versión y almacenes

**Obsidian** (MEDIDO; 21 bases en el origen, de las que se listan las 15 de Tyrian; véase la nota):

| Base | Ver. | Almacenes |
|---|---|---|
| `tyrian-companion-collector` | 1 | instance-v1 |
| `tyrian-companion-confirmation-queue` | 1 | queue-v1 |
| `tyrian-companion-confirmation-queue:f313b944…` | 1 | queue-v1 |
| `tyrian-companion-coordination` | 1 | coordination-v1 |
| `tyrian-companion-detection-quality` | 1 | events-v1 |
| `tyrian-companion-halloween` | 8 | observations-v1, seen-items-v1, notices-v1, notice-episodes-v1, episode-meta-v1, meta-v1, loot-comparisons-v1, price-alert-state-v1, price-notices-v1, emitted-alerts-v1, seed-meta-v1, alert-deliveries-v1 |
| `tyrian-companion-inventory-preferences` | 1 | preferences |
| `tyrian-companion-managed-assets` | 1 | pointer-v1 |
| `tyrian-companion-pilot-metrics:f313b944…` | 2 | profile-v1, observations-v1, verification-v1 |
| `tyrian-companion-price-history` | 1 | snapshots-v1, daily-v1, watch-v1, meta-v1 |
| `tyrian-companion-price-seed-cache` | 1 | seed-v1 |
| `tyrian-companion-price-seed-no-seed-cache` | 1 | no-seed-v1 |
| `tyrian-companion-public-catalog` | 1 | catalog-records-v1 |
| `tyrian-companion-session-runtime` | 3 | active-session-v1, live-inventory-journal-v1 |
| `tyrian-companion-vault-registry` | 1 | marks-v1 |

Nota: la tabla lista 15 bases de Tyrian; el informe de origen hablaba de 18 de Tyrian sobre 21 en total,
cifra que no cuadra con su propia lista (15 de Tyrian más las de Obsidian y otros plugins suman 21). Se
da por buena la lista enumerada, no el 18. Aparte están las bases de Obsidian y de otros plugins
(`<vault>-backup`, `-cache`, `-sync`, dataview, notebooknavigator), que no son de Tyrian. `tyrian-companion-achievements` no está en Obsidian (sí en Hebra) y
`tyrian-companion-vault-registry` está en Obsidian y no en Hebra.

**Hebra** (MEDIDO; 19 bases, 17 con prefijo `tyrian` o `hebra-tyrian`):

| Base | Ver. | Almacenes |
|---|---|---|
| `tyrian-companion-achievements` | 1 | public-v1, progress-v1 |
| `tyrian-companion-collector` | 1 | instance-v1 |
| `tyrian-companion-confirmation-queue` (sin sufijo) | 1 | queue-v1 |
| `tyrian-companion-confirmation-queue:38d12f98…` | 1 | queue-v1 |
| `tyrian-companion-coordination:38d12f98…` | 1 | coordination-v1 |
| `tyrian-companion-detection-quality` (sin sufijo) | 1 | events-v1 |
| `tyrian-companion-detection-quality:38d12f98…` | 1 | events-v1 |
| `tyrian-companion-halloween` | 8 | los mismos 12 almacenes que en Obsidian |
| `tyrian-companion-inventory-preferences` | 1 | preferences |
| `tyrian-companion-managed-assets` | 1 | pointer-v1 |
| `tyrian-companion-pilot-metrics:38d12f98…` | 2 | profile-v1, observations-v1, verification-v1 |
| `tyrian-companion-price-history` | 1 | snapshots-v1, daily-v1, watch-v1, meta-v1 |
| `tyrian-companion-price-seed-cache` | 1 | seed-v1 |
| `tyrian-companion-price-seed-no-seed-cache` | 1 | no-seed-v1 |
| `tyrian-companion-public-catalog` | 1 | catalog-records-v1 |
| `tyrian-companion-session-runtime:38d12f98…` | 2 | active-session-v1, live-inventory-journal-v1 |
| `hebra-tyrian-local-files` | 1 | files |
| `hebra-tyrian-path-index` | 1 | index |

Observaciones (MEDIDO):
- Hebra tiene `detection-quality` y `confirmation-queue` **con y sin sufijo** (DU-03 y DU-08: copias sin
  separar todavía presentes). Cola sin sufijo: 1 registro de 389 B; con sufijo: 1 de 85 B. Calidad de
  detección: 14 eventos de 6.069 B en ambas.
- Obsidian: `detection-quality` y `confirmation-queue` sin sufijo, más la cola con sufijo (1 registro de
  115 B); la sin sufijo tiene 1 registro de unos 10 KB.
- Hebra no tiene `vault-registry`; Obsidian no tiene `achievements` ni `hebra-tyrian-*` (lógico).

### 3. ¿Qué sincroniza Hebra con `api.storage.settings`? (LEÍDO)

Sí, con condiciones:
- `settings` viaja con la biblioteca (decisión de David del 3 oct 2026, según el comentario de
  `lib/plugins/api/storage.ts`). Clave de `localStorage`: `hebra.library-v1.module.<id>.settings:<libraryId>`.
  Cada `save` dispara `onPluginSettingsSaved` y el registro sincronizado lleva la copia; lo recibido se
  escribe con `applySyncedPluginSettings` y avisa a `onChange`.
- `plugin-sync-controller.ts` publica cada `save` solo si la entrada del plugin está en el registro y no
  retirada, si el valor no supera `MAX_SYNCED_SETTINGS_CHARS = 256 * 1024` (`plugins-doc.ts`; por encima
  solo hace `console.error` y **no sincroniza**) y si es distinto de lo ya publicado. Marca de tiempo
  `max(now, previous+1)`: gana el último escritor, sin fusión por campo.
- `syncSettings` aplica lo remoto sobre lo local solo si el plugin está «seguido» en ese dispositivo
  (consentimiento); si el registro no tiene valor, siembra con el local.
- `storage.device` (y por tanto `HEBRA_DEVICE_SETTING_KEYS` de Tyrian, en `host/hebra/local-storage.ts`) y
  los secretos no viajan.
- Consecuencia: lo que Tyrian guarda en `settings` en Hebra de un dispositivo llega al otro con
  last-write-wins; las rutas 2 y 3 de DU-04 (`data.json`) aplican allí. **Las bases IndexedDB no se
  sincronizan** (`indexedDbName` solo da el nombre).
- No medido: que el relé esté activo y los dispositivos conectados de David; solo se leyó código.

### 4. ¿Puede un mismo Hebra abrir dos bibliotecas en el mismo origen?

- En la app de escritorio, **no a la vez** (LEÍDO y MEDIDO): hay un único directorio
  `library-v1/hebra.sqlite3` por perfil, `linux_single_instance.rs` impide dos procesos sobre ese fichero y
  el id (`meta.library_id`) se genera una vez (`library/store.rs`). `LibraryApp.svelte` crea la API de
  plugins con el `libraryId` de la única biblioteca abierta. **Una biblioteca por proceso.**
- El origen de IndexedDB (`tauri_localhost_0`) es el mismo para todo el perfil y las bases viejas no se
  borran. Si el `library_id` cambiara (reset o sustitución de la biblioteca; no se leyó `library_reset`),
  las bases con sufijo de la anterior se quedarían y las **sin** sufijo (cola de confirmaciones, calidad
  de detección) se compartirían entre ambas (INFERIDO). Hoy en Hebra solo hay **un** sufijo (`38d12f98…`),
  así que no ha ocurrido en este host (MEDIDO).
- El sufijo de IndexedDB (`38d12f98…`) no es el `library_id` en bruto (este empieza por otros seis
  caracteres, medido en la lectura directa); es un identificador derivado (vaultId) que no se rastreó
  hasta su origen.

## DU-14: tamaños reales

### Obsidian (MEDIDO)

Carpeta total: LevelDB 36 MB (incluye todas las bases del origen, también las de Obsidian y otros plugins;
LevelDB no permite aislar el tamaño por base) y blob 14 MB. Los valores grandes de IndexedDB se guardan como
ficheros en `.blob/<id de base>/…`. «Bytes en línea» = clave más valor en LevelDB por almacén.

| Base / almacén | Registros | Bytes en línea | Blob |
|---|---|---|---|
| session-runtime / `active-session-v1` | 3 | 512 | 1 fichero, 725.740 B (unos 709 KiB: el registro de sesión) |
| session-runtime / `live-inventory-journal-v1` | 0 | 0 | n/a |
| price-history / `snapshots-v1` | 119 | 760.615 | 4 ficheros para toda la base: 281.202 B |
| price-history / `daily-v1` | 11.106 | 5.350.880 | (ídem) |
| price-history / `watch-v1` | **400** (= tope) | 128.376 | |
| price-history / `meta-v1` | 1 | 309 | |
| price-seed-cache / `seed-v1` | 65 | 1.484.464 | |
| public-catalog / `catalog-records-v1` | 2.742 | 2.555.997 | |
| halloween (conjunto) | observations 166, seen-items 1.408, notices 29, notice-episodes 1.576, episode-meta 25, loot-comparisons 25, emitted-alerts 100 (= tope `EMITTED_ALERT_RETENTION`) | unos 2,3 MB | |
| detection-quality / `events-v1` | 58 | 30.770 | |
| confirmation-queue (sin sufijo) / `queue-v1` | 1 | 10.100 | |
| confirmation-queue:f313 / `queue-v1` | 1 | 115 | |
| coordination, collector, managed-assets, vault-registry | 1-2 | menos de 400 cada uno | |
| pilot-metrics:f313 (3 almacenes), inventory-preferences, no-seed-cache | 0 | 0 | |

El blob `10/` (66.226 B) corresponde por id a `coordination` (153 B en línea); se infiere que es un fichero
huérfano o de otra base, sin verificar (INFERIDO).

### Hebra (MEDIDO)

Tamaño del fichero SQLite más su WAL, no solo datos; «datos» = suma de clave más valor de `Records`.

| Base | Fichero + WAL | Almacenes (registros / bytes de datos) |
|---|---|---|
| session-runtime:38d12f98 | **38.167.184 B** (36,4 MiB; 2.322 de 9.292 páginas libres = 9,5 MB; índices: `IndexRecords` 4,9 MB y `IndexRecordsIndex` 5,2 MB) | `active-session-v1` 4 / **2.917.749** (un registro de 2.903.444 B = el registro de sesión; los otros tres, de 201 a 13.861 B); `live-inventory-journal-v1` **18.763** / **5.107.706** (253-8.495 B por entrada, media 272 B) |
| price-history | 5.765.064 | snapshots-v1 172 / 541.696 (media 3,1 KB); daily-v1 346 / 136.080; watch-v1 69 / 12.351; meta-v1 1 |
| hebra-tyrian-local-files | 14.506.208 | files 39 / 8.517.515 |
| price-seed-cache | 3.407.872 | seed-v1 69 / 3.249.335 |
| halloween | 2.039.808 | seen-items 1.227; notice-episodes 336; observations 41; notices 5; loot-comparisons 6; emitted-alerts 0 |
| public-catalog | 1.789.952 | catalog-records-v1 1.337 / 1.096.453 |
| achievements | 1.302.528 | public-v1 203 / 1.152.218; progress-v1 1 |
| hebra-tyrian-path-index | 476.368 | index 1 / 186.414 |
| detection-quality (x2), coordination, confirmation-queue (x2), pilot-metrics, collector, managed-assets, inventory-preferences, no-seed | 76-102 KB cada una (mínimo de SQLite) | como máximo 14 registros, menos de 6,1 KB |

### Diario de Hebra: 18.763 entradas de 10 sesiones, sin podar

MEDIDO, solo recuentos: **10 sesiones con diario retenido (sin podar)**, de 440 a 4.824 entradas cada una;
la mayor, 4.824 x unos 272 B, ronda 1,3 MB. Entre las 10 suman las 18.763 entradas de la tabla. En el
código no hay una constante de tope de entradas por sesión (una búsqueda de `JOURNAL` no encuentra
ninguna); se acota por poda al sellar la sesión (LEÍDO). Que haya 10 sesiones retenidas sin podar se
**investiga aparte**; este documento no explica por qué.

### Comparación con las constantes

- `PRICE_HISTORY_MAX_WATCH_ITEMS = 400`: Obsidian está **en el tope** (400 filas en `watch-v1`, la ranura
  derivada llena); Hebra, en 69 (MEDIDO).
- Ajustes por defecto (LEÍDO, `settings.ts`): intervalo 15 min, bruto 7 días, diario 180 días, y el
  historial desactivado por defecto (`priceHistoryEnabled: false`). Obsidian: 119 snapshots (unos 6,4 KB
  cada uno) y 11.106 filas diarias (unos 482 B cada una), compatible con unos 27,8 días x 400 ítems.
  Hebra: 172 snapshots de 3,1 KB y 346 diarias (MEDIDO).
- Proyección **INFERIDA, no medida**, con esos tamaños por registro: perfil por defecto = 672 snapshots x
  6,4 KB, unos 4,3 MB brutos, más 400 x 180 días x 482 B, unos 35 MB diarios; máximo permitido por ajuste
  (5 min x 30 días = 8.640 snapshots, unos 55 MB; diario de 365 días x 400 = 146.000 filas, unos 70 MB).
- Registro de sesión: 709 KiB en Obsidian y 2,8 MiB en Hebra (MEDIDO; el contenido no se reproduce).

### ¿Alguna operación podría pasar de 10 s por tamaño?

Umbral: `STORAGE_ANSWER_TIMEOUT_MS = 10_000` (`storage-deadline.ts`), aplicado por llamada en
`indexed-db-open.ts`, `live-session-lifecycle.ts`, `coordination-coordinator.ts`, `session-runtime-store.ts`
y `session-storage-scope.ts` (LEÍDO). El propio código documenta que una llamada IndexedDB sana responde
en milisegundos.

**Respuesta: con los tamaños medidos hoy, ninguna operación está previsiblemente por encima de 10 s. No se
cronometró nada**: no se ejecutó nada en los hosts.

| Operación | Tamaño medido hoy | Estimación | Clase |
|---|---|---|---|
| `readLiveJournal` (`index('session').getAll`) | hasta 4.824 entradas, unos 1,3 MB (Hebra) | lejos del umbral | INFERIDO |
| `saveLive` (una transacción: `get` del registro de sesión, dos `JSON.stringify` para el CAS, `structuredClone`, `put` del registro y `add` de la entrada) | registro de 2,8 MiB (Hebra) | varios MB por guardado, del orden de decenas a pocos cientos de ms | INFERIDO |
| `watch-v1.getAll` y lecturas por día (como mucho 400 filas) | 128 KB | triviales | INFERIDO |
| Lectura de la ventana estadística de precios (hasta 180 días x 400 ítems con `getAll` por índice) | 11.106 filas / 5,3 MB (Obsidian), 346 (Hebra) | hoy no es un riesgo | INFERIDO |
| Aperturas de bases (`openIndexedDb`, 10 s sin evento) | n/a | dependen del bloqueo o antecesor, no del tamaño | LEÍDO |

Peores casos, ambos INFERIDOS:
- El registro de sesión se reescribe entero en cada entrada del diario, así que el coste crece con el
  tamaño del registro y con la ráfaga de guardados, sin amortización. Es la ruta que primero se acercaría
  al umbral, solo si el registro crece de forma notable (más objetos o sesiones largas) o si el motor
  WebKit o Electron se atasca por E/S. Con 2,8 MiB está lejos.
- El historial de precios no pasa por `StorageDeadline` en todos los sitios mirados (el audit ya lo
  decía). A los máximos de ajuste (146.000 filas, 70 MB de diarias, o 8.640 snapshots, 55 MB), un `getAll`
  de decenas de MB puede tardar varios segundos en WebKitGTK.

Para cerrarlo con evidencia haría falta cronometrar `saveLive` y la lectura de la ventana de precios con
estos tamaños en el motor real.

## Qué no se midió

- Tiempos de cualquier operación (todo lo de 10 s es estimación por tamaños).
- El Mac, y Hebra web o iOS.
- Si el relé de Hebra está activo y qué dispositivos hay conectados; lo que se sincroniza con `settings`
  solo se leyó en código.
- El origen del sufijo `38d12f98…` de las bases de Hebra y qué pasa con las bases con y sin sufijo si
  cambia el `library_id` (no se leyó `library_reset`).
- Por qué el diario de Hebra conserva 10 sesiones sin podar (se investiga aparte).
- La historia de versiones de la base de sesión de Obsidian (solo el estado final).
- El tamaño por base en Obsidian, que LevelDB no permite aislar.
- El blob `10/` de Obsidian (si es huérfano).
- El recuento exacto de bases de Tyrian en Obsidian (15 listadas frente a 18 en el informe de origen).
