# Audit 3 de 5: durabilidad del almacenamiento local

- Fecha: 2026-10-10
- Repositorio: `/Users/david/code/tyrian-companion`, `main` = `6fbe77e`, árbol limpio al empezar y al terminar.
- Alcance: IndexedDB (todas las bases que abre el plugin en Obsidian y en Hebra), `data.json` (`loadData`/`saveData` y su equivalente en Hebra), reserva de sesión y candado de vida. Solo lectura de código y docs; nada se ha ejecutado en un Obsidian ni en un Hebra reales.
- Punto de partida: los límites que `docs/ESTADO.md` ya declara para la 0.6.24 (líneas 39 a 70). No los repito como hallazgos salvo cuando el código muestra algo que esos límites no dicen.
- Comandos ejecutados (todos en el árbol de arriba):
  - `rg`/`grep`/`sed` sobre `src/` y `docs/` (inventario de `openIndexedDb`, `createObjectStore`, `onClose`, `onVersionChange`, `vaultId`, llamadas a `settings.save`).
  - `git log -S"SESSION_RUNTIME_DB_VERSION = 2"`, `git show 6bb5a2e:src/sessions/session-runtime-store.ts`, `git merge-base --is-ancestor` (fechar H18.12 frente a la versión 2 del esquema).
  - `npx vitest run --maxWorkers=1 src/main-session-vault-isolation.test.ts`: «Tests 1 passed (1)».
  - `npx vitest run --maxWorkers=1 src/core/indexed-db-open.test.ts`: «Tests 17 passed (17)».
  - Una simulación en memoria con `fake-indexeddb` lanzada con `node --input-type=module -e` (sin escribir ningún fichero), que repite la secuencia de aperturas de DU-01 con la misma regla de `applyIndexedDbSchema` (crear solo lo que falta). No importa el código del plugin.
  - Node en esta máquina: v24.19.0 (ESTADO midió con v22).

## Resumen

| Severidad | Hallazgos |
|---|---|
| Alto | DU-01, DU-02 |
| Medio | DU-03, DU-04, DU-05 |
| Bajo | DU-06, DU-07, DU-08, DU-09, DU-10, DU-11 |
| Sin medir | DU-12, DU-13, DU-14, DU-15 |

## 1. Inventario de bases y almacenes

Todas se abren con `openIndexedDb` (`src/core/indexed-db-open.ts:110`). La única migración que existe es `applyIndexedDbSchema` (`indexed-db-open.ts:239-252`): en `onupgradeneeded` crea los almacenes e índices que falten y nada más; ningún almacén lee `oldVersion` ni transforma filas. Los cambios de forma de los registros se resuelven al leer (por ejemplo `normalizeSessionRuntimeRecord`, `migrateInventoryPreferences`).

| Base (nombre) | Versión | Quién la abre | Almacenes, clave e índices | Qué guarda | Tamaño esperado | Separada por vault | Recupera conexión muerta | Test de esquema/migración |
|---|---|---|---|---|---|---|---|---|
| `tyrian-companion-session-runtime:<vaultId>` (o sin sufijo si el vault adoptó la vieja) | 2 | `IndexedDbSessionRuntimeStore` (`session-runtime-store.ts:603-607`) y `resolveSessionStorageNames` (`session-storage-scope.ts:91-95`, solo la vieja) | `active-session-v1` (clave fuera de línea: `active-session`, `completed-session-summary`, `legacy-vault-owner`, archivos legacy); `live-inventory-journal-v1` con índice `session` | Sesión activa o recuperable con instantáneas completas de la cuenta, delta, revisión, precios; diario de la sesión en vivo | Un registro con dos instantáneas de cuenta (decenas a cientos de kB, sin medir) más el diario de la sesión en curso | Sí (H18.12) | Sí (`onClose`, `withIndexedDbReopen`) | `main-session-recovery-migration.test.ts` (registro v2 a v3, no la base); `session-storage-scope.test.ts` siembra la vieja ya en versión 2 |
| `tyrian-companion-coordination:<vaultId>` (o sin sufijo) | 1 | `IndexedDbCoordinationStore` (`coordination-store.ts:58-73`) | `coordination-v1`, clave `active-session-state` | Reserva (lease), valla, ids de máquina e instancia | Un registro de bytes | Sí | Sí | Sin upgrade |
| `tyrian-companion-pilot-metrics:<vaultId>` | 2 | `IndexedDbPilotMetricsStore` (`pilot-metrics-store.ts:403-417`) | `profile-v1`, `observations-v1`, `verification-v1` | Telemetría local del piloto | Hasta 10.000 observaciones | Sí | No (DU-05) | Sin test v1 a v2 |
| `tyrian-companion-confirmation-queue` | 1 | `IndexedDbPendingProposalStore` (`pending-proposal-store.ts:113-125`) | `queue-v1`, clave única `pending-proposals` | Propuestas de la detección asistida y recibos | Propuestas 24 h, recibos 30 días | **No** (DU-03) | No | - |
| `tyrian-companion-detection-quality` | 1 | `IndexedDbDetectionQualityStore` (`session-detection-quality-store.ts:124-135`) | `events-v1` | Eventos de calidad de detección | Sin límite (DU-08) | **No** | No | - |
| `tyrian-companion-price-history` | 1 | `IndexedDbPriceHistoryStore` (`price-history-store.ts:82-106`) | `snapshots-v1` [vaultId, slotStartMs] con `by-vault-captured`; `daily-v1` [vaultId, itemId, dayUtc] con `by-vault-day` y `by-vault-item-day`; `watch-v1` con `by-vault-observed`; `meta-v1` | Precios públicos por franja y por día | Por defecto 96 franjas/día x 7 días x hasta 400 objetos (unas 269.000 tuplas en bruto); máximo configurable 288 x 30 x 400 (unos 3,5 millones); diario hasta 400 x 365 filas | Por clave | No | `price-history-store.test.ts` (futuro) |
| `tyrian-companion-price-seed-cache` | 1 | `IndexedDbPriceSeedCacheStore` (`price-seed-cache-store.ts:45-49`) | `seed-v1` [vaultId, itemId] | Series de datawars2 | Una por objeto consultado | Por clave | No | `price-seed-cache-store.test.ts` |
| `tyrian-companion-price-seed-no-seed-cache` | 1 | `IndexedDbPriceSeedNoSeedStore` (`:155-159`) | `no-seed-v1` [vaultId, itemId] | Respuestas `no_seed` | Pequeño | Por clave | No | idem |
| `tyrian-companion-halloween` | 9 | `IndexedDbHalloweenStore` (`halloween-store.ts:105-145`), abierta por tres dueños (core, runtime, alerta de precio) | 12 almacenes con clave compuesta [vaultId, accountRef, ...]; índices `by-scope-observed` (3) y `by-scope-emitted` (2) | Observaciones, avisos, comparaciones, cola de avisos emitidos (100) | Moderado | Por clave | No (cierre definitivo en cualquier `versionchange`, `:95`) | `halloween-store.test.ts` (futuro) |
| `tyrian-companion-public-catalog` | 1 | `IndexedDbCatalogRecordStore` (`persistent-catalog-cache.ts:207-215`) | `catalog-records-v1` | Catálogo público (JSON); corrupto = fallo de caché | Crece con los objetos vistos | No hace falta | No; cae a memoria si no abre | `indexed-db-catalog-record-store.test.ts` |
| `tyrian-companion-inventory-preferences` | 1 | `IndexedDbInventoryPreferencesStore` (`inventory-preferences-store.ts:153-170`) | almacén único, clave `vaultId\0accountId` (`:256`) | **Objetivos y excepciones de conservar que escribe el usuario**, con CAS por generación | Pequeño | Por clave | Sí | `inventory-preferences.test.ts` (futuro), `main-inventory-preferences-lost-write.test.ts` |
| `tyrian-companion-managed-assets` | 1 | `IndexedDbManagedAssetsPointerStore` (`managed-assets-pointer.ts:95-100`) | `pointer-v1`, clave `managed-assets-pointer:<vaultId>` | Puntero durable de las Bases gestionadas | Un registro | Por clave | No | - |
| `tyrian-companion-collector` | 1 | `readOrSeed` (`collector-instance.ts:85-90`), abre y cierra en cada operación | `instance-v1`, claves `instance:<vaultId>`, `mode:<vaultId>` | Id de instalación y modo recolector/consulta de este equipo | Bytes | Por clave | No hace falta | - |
| Hebra: `hebra-tyrian-path-index` y `hebra-tyrian-local-files` (nombres que da `api.storage.indexedDbName`) | 1 | `path-index-kv.ts:57`, `local-storage.ts:96` | `index` (una clave con un texto), `files` | Índice de rutas por dispositivo; log de diagnóstico y recibos | Pequeño | Por biblioteca (nombre de Hebra) | Sí | `local-storage.test.ts`, `path-index.test.ts` |

En Hebra el core usa las mismas bases de la tabla sobre el `window.indexedDB` de la página de Hebra (`entry.ts:17`), con `vaultId = sha256("hebra-library:<libraryId>")` (`hebra/vault.ts:166`). Obsidian y Hebra no comparten IndexedDB: son aplicaciones y orígenes distintos.

## Alto

### DU-01. La base de sesión adoptada de una versión anterior pierde para siempre el almacén del diario en vivo

Severidad: Alto.

Qué pasa. H18.12 (`6bb5a2e`, 24 sep) dejó que el primer vault que cargara esa versión con una sesión guardada adoptara la base sin sufijo `tyrian-companion-session-runtime`. En esa fecha la base iba en versión 1 con un solo almacén (`git show 6bb5a2e:src/sessions/session-runtime-store.ts`, línea 31: `SESSION_RUNTIME_DB_VERSION = 1`). `6991999` (6 oct) subió la versión a 2 y añadió `live-inventory-journal-v1`. Pero en cada arranque, antes que nadie, `resolveSessionStorageNames` abre la base vieja con la versión nueva y un esquema que solo lista el almacén antiguo:

```
src/sessions/session-storage-scope.ts:91-95
	const database = await openIndexedDb({
		factory,
		databaseName: SESSION_RUNTIME_DB_NAME,
		databaseVersion: SESSION_RUNTIME_DB_VERSION,
		schema: [{ name: SESSION_RUNTIME_STORE_NAME }],
```

Esa apertura es la que hace la subida de 1 a 2, y como el esquema que pasa no incluye el diario, no lo crea. Cuando después el almacén de sesión abre la misma base en versión 2 con los dos almacenes (`session-runtime-store.ts:603-607`), ya no hay `onupgradeneeded` y el diario no aparece nunca. Toda transacción que lo nombra (`live-session-persistence.ts:53`, `:86`, `:106`, `:116`, `:129`, `:158`) lanza `NotFoundError`; `startIndexedDbTransaction` la envuelve como `IndexedDbConnectionLostError` (`indexed-db-open.ts:185-189`), `withIndexedDbReopen` reabre una vez, falla igual y `saveLive` contesta `unavailable` (`session-runtime-store.ts:490-492`). Las sesiones manuales siguen funcionando porque `mutate` solo toca `active-session-v1`.

Evidencia medida (simulación en memoria, misma regla que `applyIndexedDbSchema`, sin código del plugin):

```
release <6991999 (v1): 1 [ 'active-session-v1' ]
scope resolveSessionStorageNames (v2, runtime only): 2 [ 'active-session-v1' ]
runtime store open (v2, both): 2 [ 'active-session-v1' ]
transaction(): NotFoundError
```

Por qué no lo ven los tests: `session-storage-scope.test.ts:175-183` y `main-session-vault-isolation.test.ts` siembran la base vieja ya en la versión actual (2) con `IndexedDbSessionRuntimeStore`, que crea los dos almacenes. Ningún test siembra una base en versión 1.

A quién afecta: al vault (o biblioteca de Hebra, si el core corría allí con los mismos nombres antes de H18.12) que adoptó la pareja vieja; la marca `legacy-vault-owner` hace la adopción permanente. En ese vault la sesión en vivo no puede guardar nada. Si el vault de David es el adoptante no lo sé: es lo primero que hay que comprobar (ver DU-15 y sección 6).

Acción propuesta:
1. Un único esquema exportado desde `session-runtime-store.ts` que usen tanto el almacén como `resolveSessionStorageNames` (1 h).
2. Reparación de las bases ya dañadas: que el almacén compruebe en `accept` que están los dos almacenes y, si falta alguno, abra con versión 3 para que `applyIndexedDbSchema` lo cree (2 h). La alternativa de borrar y recrear queda descartada: la base guarda la sesión.
3. Test de regresión con `fake-indexeddb`: base vieja en versión 1 con una sesión, arranque real por `initializeRuntime`, y un `saveLive` que debe contestar `saved` (2 h).

### DU-02. Mover o renombrar la carpeta del vault deja huérfano todo lo local, en silencio, y puede convertir un equipo en recolector

Severidad: Alto.

Evidencia:
- `src/host/obsidian/obsidian-vault.ts:71`: `canonicalIdentity: () => adapter().getBasePath?.() ?? ...`, es decir, la ruta absoluta del vault.
- `src/runtime/tyrian-companion-core.ts:855`: `const vaultId = await sha256Text(host.vault.canonicalIdentity().normalize('NFC'));`.
- Ese `vaultId` decide el nombre o la clave de: sesión y reserva (`session-storage-scope.ts:60-61`), métricas, historial de precios, semillas, Halloween, preferencias de inventario (`inventory-preferences-store.ts:256`), puntero de Bases y modo recolector (`collector-instance.ts:49-55`).
- `rg -i "previousVaultId|oldVaultId|vault.*renam"` sobre `src/` no encuentra ninguna migración entre identidades.
- `src/core/settings.ts:478-479`: si no hay modo guardado, la semilla es `collector` cuando `apiKeySecret` no está vacío, y `apiKeySecret` viaja en `data.json`, que se sincroniza.

Consecuencias al renombrar el vault (el selector de vaults de Obsidian lo permite) o moverlo de carpeta:
- Se pierden de vista, sin aviso, los objetivos y excepciones de conservar que escribió el usuario (solo existen en IndexedDB de ese equipo), el historial de precios acumulado, el estado de Halloween y la sesión activa o recuperable con su reserva.
- Un equipo configurado en modo consulta vuelve a arrancar como recolector si `data.json` trae una clave de API: dos recolectores escribiendo el mismo vault sincronizado, que es justo lo que R1b quería evitar.
- Los datos viejos siguen ocupando espacio con el `vaultId` anterior y nada los borra.

La documentación lo dice solo de pasada: `docs/ARCHITECTURE.md:489` «SHA-256 de la ruta del vault».

Acción propuesta: decisión de David (sección 7). Como mínimo, detectar el cambio: guardar por equipo, en `loadLocalStorage` del vault, el último `vaultId` usado; si cambia y hay datos con el anterior, avisar y ofrecer adoptarlos (4 a 6 h con test). Una identidad estable que Obsidian conserve al renombrar sería mejor; no he verificado cuál existe en la API y no la cito.

## Medio

### DU-03. La cola de confirmaciones es común a todos los vaults y un vault anula las propuestas de otro

Severidad: Medio.

Evidencia:
- `src/sessions/pending-proposal-store.ts:9-12`: nombre `tyrian-companion-confirmation-queue` sin vault y una sola clave `pending-proposals`.
- `src/sessions/pending-proposal-service.ts:246-251`: en `reconcile`, una propuesta de parada solo es válida si la sesión del contexto es la suya, y una de inicio solo si el contexto está `idle`; si no, `resolve(record, proposal, 'invalidated', ...)`.
- `src/runtime/tyrian-companion-core.ts:5465-5480`: cada vault llama a `reconcile` con SU sesión. Con `accountId === null` (vault sin conexión) la comprobación de cuenta pasa siempre.
- `main-session-vault-isolation.test.ts` solo prueba el registro de sesión, no la cola.
- Además `reconcile` escribe la cola entera en cada llamada aunque no cambie nada (`return { result: undefined, next: record }`).

Efecto: con dos vaults abiertos con el plugin en el mismo Obsidian, el vault B (inactivo, o con otra cuenta sin conectar) marca como `invalidated` la propuesta de parada de la sesión del vault A en cuanto reconcilia. La detección asistida, que David mantiene, pierde propuestas sin que el usuario lo vea como fallo. `tyrian-companion-detection-quality` tampoco está separada por vault (DU-08).

Acción propuesta: nombrar la base por vault como `pilot-metrics` (`<name>:<vaultId>`); las propuestas caducan a las 24 h, así que no hace falta adoptar la vieja (2 h). Test con dos núcleos sobre la misma fábrica, copiando el montaje de `main-session-vault-isolation.test.ts` (2 h). Escribir solo si `changed` (0,5 h).

### DU-04. `data.json` puede perder escrituras: en el mismo proceso, entre equipos sincronizados y entre versiones distintas del plugin

Severidad: Medio.

Qué guarda y cuándo escribe: los ajustes normalizados (`migrateSettings`, `settings.ts:297-360`), incluido `inventorySyncLastRun`, `managedAssetsRoot`, `preferredCharacter`, el nombre del secreto de la API y las preferencias de historial de precios. Escribe al cargar si la normalización cambió algo (`tyrian-runtime.ts:27-29`, `settings.ts:673-675`), en cada `updateSettings` (`tyrian-companion-core.ts:5284`) y al acabar una sincronización de inventario (`:2835-2838`).

Tres rutas de pérdida:
1. Mismo proceso. `updateSettings` calcula el siguiente estado sobre `this.settings` (`:5280`), espera a `save` (`:5284`) y solo entonces asigna (`:5285`). `recordInventorySyncOutcome` hace `this.settings = { ...this.settings, ... }` y guarda, lanzado sin esperar (`:1212-1214`). La única cola de escrituras es la de la pestaña de ajustes (`settings-tab.ts:858-866`); los otros llamadores de `updateSettings` (personaje preferido al iniciar sesión `:5214`, raíz de Bases `:4664`, `:4693`, `:4706`, historial de precios `:2469`, `:2479`, secreto del juego `:4293`) no pasan por ella. Dos escrituras solapadas dejan en disco la última que termine y en memoria la última que asigne; pueden no coincidir.
2. Entre equipos. No hay `onExternalSettingsChange` (`rg` sin resultados). Con Obsidian Sync o iCloud, el equipo B no ve el cambio que trajo la sincronización desde A y su siguiente escritura lo pisa con su copia en memoria.
3. Entre versiones. Un build que lee un `schemaVersion` mayor que el suyo reescribe el fichero en su versión: tira las claves que no conoce (lo dice `ARCHITECTURE.md:499`) y vuelve a los valores por defecto el intervalo de consulta (`settings.ts:314-318`) y el registro de diagnóstico (`:324-327`, `:732`). Como la diferencia hace que se guarde al cargar, el fichero degradado se sincroniza de vuelta al equipo nuevo. Con BRAT cada equipo se actualiza a su ritmo, así que dos versiones a la vez es lo normal durante horas.

Lo que sí está bien: si `loadData` falla, el plugin no arranca y no pisa el fichero (`tyrian-companion-core.ts:735`, `tyrian-runtime.ts:66-74`).

Acción propuesta: una sola cola para todas las escrituras de ajustes en el core, que fusione sobre el último valor (2 h); `onExternalSettingsChange` que recargue y vuelva a normalizar (2 a 3 h); no reescribir al cargar cuando `schemaVersion` es mayor que el conocido, y arrancar en solo lectura de ajustes (1 a 2 h). Tests unitarios con un puerto de ajustes falso (2 h).

### DU-05. Ocho almacenes secundarios no se recuperan si el motor cierra la conexión

Severidad: Medio.

Evidencia:
- `rg -n "onClose"` sobre `src/` sin tests: solo pasan `onClose` el almacén de sesión (`session-runtime-store.ts:616`), el de coordinación (`coordination-store.ts:69`), preferencias (`inventory-preferences-store.ts:168`) y los dos de Hebra (`local-storage.ts:98`, `path-index-kv.ts:59`).
- Historial de precios, semillas, Halloween, catálogo, cola de confirmaciones, calidad de detección, métricas y puntero de Bases siguen usando una conexión que el motor dio por cerrada; cada `transaction()` lanza `InvalidStateError` hasta recargar el plugin.
- `pending-proposal-store.ts:119` y `session-detection-quality-store.ts:130-133` se apagan para siempre en cualquier `versionchange`, también en el de tipo `released` que `openIndexedDb` distingue a propósito (`indexed-db-open.ts:47-54`).
- `pilot-metrics-store.ts:403`: `this.database ??= openIndexedDb(...)` guarda la promesa; si la apertura falla una vez (por ejemplo, el plazo de 10 s), la promesa rechazada se queda y las métricas no vuelven en toda la ejecución.

ESTADO ya declara que estos almacenes no acotan sus transacciones. No dice que tampoco reabren. El arnés de tests recuerda el caso real (7 oct 2026, WebKitGTK dejó de contestar: `src/test/indexed-db-connections.ts`, cabecera). Efecto: tras un fallo del proceso de almacenamiento, el historial de precios deja de capturar, la cola de confirmaciones queda `unavailable` y los avisos de Halloween dejan de guardarse, hasta recargar.

Acción propuesta: pasar los ocho al patrón de `coordination-store.ts` (`connection()` + `discard()` + `withIndexedDbReopen`), aproximadamente 1 h por almacén (8 h), y no guardar la promesa rechazada en métricas (0,5 h). Tests con el `TrackedIndexedDb` existente matando la conexión (3 h).

## Bajo

### DU-06. La única migración disponible no puede añadir un índice ni cambiar una clave de un almacén que ya existe

Severidad: Bajo (latente; hoy no hay ningún caso).

Evidencia: `indexed-db-open.ts:243-244` salta cualquier almacén que ya exista. Revisé el historial (`git log -G"createIndex|indexes:"`): todos los índices se crearon junto con su almacén (`6706d47`, `3dcfbdf`, `42abe23`, `f9ed4fb`, `6991999`), así que hoy no falta ninguno. DU-01 es la misma familia: una apertura con un esquema incompleto deja la base en la versión nueva sin lo nuevo, y nadie lo comprueba después.

Acción propuesta: que `openIndexedDb` verifique, tras abrir, que existen todos los almacenes e índices declarados y falle con un motivo propio (`refused` o uno nuevo) en vez de dejar que cada transacción falle como «conexión perdida» (1,5 h con test).

### DU-07. Una fila ilegible bloquea para siempre la poda del historial de precios

Severidad: Bajo.

Evidencia: `price-history-store.ts:461-470`, en `pruneByCursor`: `try { parse(cursor.value); cursor.delete(); ... } catch (error) { reject(error); transaction.abort(); }`. Una sola fila que no pasa `parse` aborta la transacción entera, no se borra nada y en la siguiente compactación vuelve a pasar lo mismo. Con la retención máxima (sección 1: unos 3,5 millones de tuplas) el almacén crece sin freno. Además la poda usa el reloj de pared (`compactAndPrune(this.options.vaultId, this.now(), ...)`, `price-history-runtime.ts:179`, `:324`, `:369`): un reloj adelantado más de la retención diaria borraría el histórico. No es probable, pero es irreversible.

Acción propuesta: borrar o apartar la fila ilegible y seguir, con un contador en el diagnóstico (1,5 h con test); no podar si `now` está por delante del último `capturedAtMs` guardado más de un margen (1 h).

### DU-08. La calidad de detección no tiene límite, no está separada por vault y una fila corrupta la apaga entera

Severidad: Bajo.

Evidencia: `session-detection-quality-store.ts:13-15` (nombre sin vault), `:82` y `:162` (`getAll()` sin rango ni límite), `:84` (una sola fila que no valida devuelve `corrupt` para todo); `docs/THREAT-MODEL.md:79` «No tiene expiración ni borrado/exportación integral». No hay `delete`, `prune` ni retención en el almacén (`rg` sin resultados).

Acción propuesta: retención por edad o por número, nombre por vault y apartar filas ilegibles (3 h).

### DU-09. Un paso atrás del reloj de pared deja la sesión en error hasta que el reloj vuelve a pasar `renewedAt`

Severidad: Bajo (diseño a prueba de fallos, efecto visible).

Evidencia: `coordination-coordinator.ts:242`, `:263`, `:282`, `:330` (`now < renewedAt` da `clock_anomaly`) y `:527` (`now < this.lastNow` da `clock_anomaly` para toda la instancia). Un fallo de latido lleva a `failFromAuthority` (`manual-session-start-service.ts:1545-1550`) y a reintentos con 5, 30, 60, 120 y 300 s (`:164`, `:1673-1679`). Un salto atrás de N segundos tiene la sesión en error unos N segundos más el reintento que toque. Los tests unitarios lo cubren (`coordination-coordinator.test.ts:190`). El caso del salto adelante con la regla de los 15 s ya está en ESTADO.

Acción propuesta: medir en cliente si macOS o chrony dan pasos atrás al despertar; si los dan, comparar dentro de la instancia con `monotonicNowMs` (ya existe en `storage-deadline.ts:88`) y dejar el reloj de pared solo para lo que se guarda (2 a 3 h con tests).

### DU-10. `THREAT-MODEL.md` no lista nueve de las bases

Severidad: Bajo.

Evidencia: `grep -c` en `docs/THREAT-MODEL.md` da 0 para `inventory-preferences`, `halloween`, `public-catalog`, `price-seed`, `collector`, `managed-assets`, `path-index` y `local-files`. La tabla de las líneas 77 a 83 solo cubre sesión, coordinación, calidad, métricas, cola y precios. Las preferencias de inventario son las únicas que guardan datos escritos por el usuario y no aparecen.

Acción propuesta: completar la tabla con la de la sección 1 de este informe (1 h, documentación).

### DU-11. Desde H18.12 nada impide dos sesiones activas de la misma cuenta a la vez

Severidad: Bajo (consecuencia de diseño, no pérdida).

Evidencia: la reserva vive por vault (`session-storage-scope.ts:57-63`). Antes de H18.12 era una para todo Obsidian; ahora dos vaults del mismo Obsidian, Obsidian y Hebra, o dos equipos, pueden tener cada uno una sesión activa de la misma cuenta de GW2. Cada sesión mide por diferencia de instantáneas de la misma cuenta, así que las dos ven el mismo botín.

Acción propuesta: decisión de David (sección 7). Si se quiere impedir, solo es posible dentro de un mismo almacenamiento (mismo Obsidian): una reserva por cuenta además de la de vault (3 a 4 h).

## Sin medir

### DU-12. Candados de vida por sistema operativo: el código no distingue plataforma

Evidencia: Obsidian entrega siempre `navigator.locks` (`obsidian-host.ts:31-35`) y Hebra también (`hebra/entry.ts:19`), en macOS, Linux y Windows por igual; no hay ninguna comprobación de plataforma. Lo único que cubre a dos procesos que no se ven los candados es la regla de los 15 s (`coordination-coordinator.ts:82`, `:355-366`), que no protege a la sesión manual (renueva cada 100 s, `ttl/3` en `manual-session-start-service.ts:1520`). En Obsidian, dos procesos con el mismo directorio de datos son poco probables (Chromium bloquea la base del perfil), y dos instalaciones distintas (Flatpak y AppImage) tienen IndexedDB separadas, así que no comparten reserva y nada impide que las dos escriban en el mismo vault. Nada de esto está medido.

Cómo medirlo: en cada host, abrir la consola y comprobar `navigator.locks.query()` desde dos procesos; matar uno con sesión en vivo y leer `life_lock_*` y `taken` en el registro local, como propone ESTADO.

### DU-13. IndexedDB es de «mejor esfuerzo» y lo que escribe el usuario no tiene copia

Evidencia: no hay ninguna llamada a `navigator.storage.persist` ni `estimate` en `src/` (`rg` sin resultados fuera de textos). Las preferencias de inventario existen solo en IndexedDB de cada equipo (no viajan a otros equipos ni tienen exportación). Si el motor desaloja el origen por falta de disco, o el usuario reinstala Obsidian o borra datos de Hebra, se pierden. Cómo se comporta el desalojo en Electron (`app://obsidian.md`) y en WKWebView/WebKitGTK no lo he medido.

Acción propuesta: pedir `persist()` donde exista (0,5 h) y exportar las preferencias a una nota o a `data.json` (decisión de David).

### DU-14. Tamaños reales

No he medido el tamaño del registro de sesión (dos instantáneas completas de la cuenta), del diario en vivo ni del historial de precios en una cuenta real. Las cifras de la sección 1 salen de las constantes (`PRICE_HISTORY_MAX_WATCH_ITEMS = 400`, intervalos 5 a 60 min, retenciones 2 a 30 y 42 a 365 días). Una operación sobre el historial que tarde más de 10 s no responde fallo (el historial no está acotado); sí lo haría una del almacén de sesión, que ESTADO ya declara.

### DU-15. Si el vault de David adoptó la base vieja, y qué sincroniza Hebra

- No sé si en el Mac o en Fedora existe `tyrian-companion-session-runtime` sin sufijo ni si le falta el diario (DU-01). Se comprueba en la consola de Obsidian y de Hebra: `(await indexedDB.databases()).map(d => [d.name, d.version])`, y abriendo esa base para ver `objectStoreNames`. Es lectura, no escribe.
- En Hebra, `api.storage.settings` se guarda bajo una clave por biblioteca (`hebra/local-storage.ts:6-7`); si Hebra la sincroniza entre dispositivos, DU-04 rutas 2 y 3 aplican también allí. Tampoco sé si un mismo Hebra puede abrir dos bibliotecas en el mismo origen, en cuyo caso la cola de confirmaciones y la calidad de detección se compartirían como en DU-03.

## 2. Migraciones: resumen de comportamiento

- Subir de versión: `applyIndexedDbSchema` crea lo que falta. Correcto mientras cada apertura de una base pase el esquema completo (falla en DU-01) y nadie necesite índices nuevos en almacenes viejos (DU-06).
- Bajar (plugin viejo sobre datos nuevos): la apertura con versión menor da `VersionError`. Sesión: `unavailable`. Halloween y preferencias lo traducen a `future_schema`. Ningún almacén borra la base (`deleteDatabase` no aparece en `src/`), así que no hay pérdida, solo función parada hasta actualizar. Halloween subió a 9 sin cambiar nada solo para provocar ese error en la 0.6.16 (`halloween-store.ts:36-43`). Para `data.json` el caso es distinto y sí pierde (DU-04, ruta 3).
- Datos corruptos o parciales: sesión, preferencias y Halloween fallan cerrados (`corrupt`) sin borrar; el catálogo borra la entrada y la trata como fallo de caché (`persistent-catalog-cache.ts:55-60`, `:98`); la sesión ofrece `forceClear` solo como salida explícita. La calidad de detección se apaga entera con una fila (DU-08) y la poda de precios se atasca (DU-07).
- Leer, modificar y escribir: todas las rutas que miré hacen la lectura y la escritura dentro de la misma transacción `readwrite` (sesión `mutate`, coordinación, cola, preferencias con CAS por generación, historial de precios, colector, reclamación de la base vieja). No he encontrado ninguna escritura perdida dentro de IndexedDB. Las pérdidas están en `data.json` (DU-04) y en la cola compartida, donde la escritura es atómica pero la decisión es de otro vault (DU-03).

## 3. Aislamiento

- Dos vaults en el mismo Obsidian: comparten origen y toda la IndexedDB. Separados por nombre: sesión, coordinación, métricas. Separados por clave: precios, semillas, Halloween, preferencias, puntero, colector. Sin separar: cola de confirmaciones (DU-03), calidad de detección (DU-08), catálogo (público, no importa).
- Dos Obsidian abiertos: en macOS no ocurre. Con dos instalaciones distintas cada una tiene su IndexedDB y su reserva; nada coordina sus escrituras en el mismo vault (DU-11, DU-12).
- Obsidian y Hebra a la vez: almacenamiento separado del todo; las dos pueden tener sesión de la misma cuenta (DU-11).
- Mismo vault sincronizado entre máquinas: IndexedDB no viaja; `data.json` sí (DU-04). El modo recolector vive en IndexedDB por eso mismo (`collector-instance.ts`, cabecera), pero vuelve a la semilla si cambia la ruta (DU-02).

## 4. Candados y reserva

Leído en `coordination-coordinator.ts` completo. La toma anticipada exige marca `wl1:`, candado propio demostrado, candado del dueño libre en menos de 1 s y 15 s sin renovar medidos con el reloj de pared (`:337-366`); la segunda transacción compara la reserva exacta y sube la valla (`:377-401`). Las escrituras tardías tras el plazo de 10 s se neutralizan comparando la reserva exacta (`sameLease`, `:581-583`). Suspensión: al despertar, si la reserva caducó, el dueño recibe `lost` y su reintento la recupera por valla (`manual-session-start-service.ts:1582-1584`); en un solo proceso con candados el candado sigue tomado y nadie la roba. Lo que el código no hace por sí mismo: distinguir sistema operativo (DU-12) y tolerar pasos atrás del reloj (DU-09).

## 5. `data.json`

Ver DU-04. Orden de escritura en carga: solo si la normalización cambió algo. Escrituras posteriores: `updateSettings` y el resultado de la sincronización de inventario. En Hebra el puerto equivalente es `createTyrianSettingsPort` (`hebra/local-storage.ts:28-41`), sin cola tampoco.

## 6. Qué se puede medir con `fake-indexeddb` y qué solo en un host real

Con `fake-indexeddb` y los arneses que ya hay (`src/test/indexed-db-connections.ts`, `obsidian-host-harness`):
- DU-01: sembrar la base vieja en versión 1 con una sesión, arrancar por `initializeRuntime` y comprobar `objectStoreNames` y un `saveLive`.
- DU-02: arrancar con una ruta, guardar preferencias y modo `consult`, arrancar con otra ruta y comprobar que se pierden y que el modo vuelve a `collector`.
- DU-03: dos núcleos sobre la misma fábrica (como `main-session-vault-isolation.test.ts`), una propuesta de parada en A y `reconcile` en B.
- DU-05: matar la conexión de cada almacén secundario con `TrackedIndexedDb` y contar si reabre.
- DU-06, DU-07, DU-08: unitarios directos.
- DU-04: con un puerto de ajustes falso que tarde en `save` y dos llamadas solapadas; y con un `data.json` de `schemaVersion` 15.
- DU-09: ya hay unitarios; falta uno de extremo a extremo con un reloj que retrocede durante una sesión activa.

Solo en host real: si los candados mueren con el proceso y qué procesos los comparten (DU-12); desalojo de almacenamiento (DU-13); tamaños reales (DU-14); si existe ya la base vieja sin diario en los equipos de David (DU-15); pasos de reloj al despertar en macOS y Fedora (DU-09); sincronización de ajustes en Hebra (DU-15).

## 7. Decisiones de David

1. DU-02: qué identifica a un vault. Opciones: seguir con la ruta y avisar cuando cambie ofreciendo adoptar los datos; o una identidad estable guardada por equipo. Y si un cambio de identidad debe dejar el modo en `consult` en vez de recolector.
2. DU-11: si se quiere una sola sesión activa por cuenta dentro del mismo Obsidian (dos vaults), o se acepta que cada vault sea independiente como hoy.
3. DU-13: si las preferencias de inventario (lo único que escribe el usuario a mano) deben tener copia fuera de IndexedDB, y dónde (una nota del vault o `data.json`, que se sincronizan).
4. DU-04, ruta 3: qué debe hacer un build viejo ante un `data.json` más nuevo: ¿arrancar sin tocarlo y en solo lectura de ajustes, o negarse a arrancar?

Lo técnico de DU-01, DU-03, DU-05 a DU-10 no necesita decisión suya.

## Límites de este audit

- Nada se ejecutó en Obsidian ni en Hebra. DU-01 se apoya en lectura de código, en el historial de git y en una simulación en memoria con la misma regla de esquema; no he corrido el código real del plugin sobre una base en versión 1.
- Ejecuté 2 ficheros de test de los 5 permitidos; no corrí la suite, el gate, `tsc` ni la build.
- No leí entero `halloween-store.ts` (1.040 líneas), `price-history-store.ts` ni `pilot-metrics-store.ts`: solo apertura, esquema, `run`/`transaction` y poda. Tampoco `src/inventory/` en profundidad: no usa IndexedDB; su durabilidad es la de las notas del vault y queda para otro audit.
- No verifiqué la API de Obsidian sobre identidades de vault, `onExternalSettingsChange` ni `loadData` con JSON corrupto más allá de lo que hace el código.
- No inspeccioné los datos reales de IndexedDB de ninguna máquina.
- Las cifras de tamaño son cotas calculadas desde constantes, no mediciones.
