# Arquitectura

## Capas

`src/main.ts` es la composición del plugin. Registra la vista, el comando y los ajustes, y conecta adaptadores de Obsidian con servicios independientes.

- `core`: transporte HTTP resiliente, configuración versionada, acceso diferido a secretos y limitación FIFO de concurrencia.
- `account`: cliente de Guild Wars 2, validación runtime, conexión, estado efímero y snapshots de almacenamiento.
- `catalog`: cliente público, parsers de metadatos, resolución por snapshot y contrato de caché.
- `advisor`: estado de preparación, sin lógica de recomendación todavía.
- `sessions`: modelo y contrato de persistencia de sesiones.
- `objectives`: modelo y contrato de persistencia de objetivos.
- `ui`: vista y pestaña de ajustes de Obsidian.

## Flujo de dependencias

```text
main -> ui -> connection service -> account gateway -> GW2 client
                                                   |
                                                   +-> core (HTTP + SecretStorage)

main -> advisor

storage snapshot service -> GW2 operation fijada -> core concurrency

storage delta comparator -> dos StorageSnapshot (puro, sin I/O)

public catalog service -> public GW2 client -> core HTTP
	                  -> cache adapter

sessions ----> contratos puros
objectives --> contratos puros
```

Los módulos de dominio no dependen de la UI. `ObsidianRequestTransport` es el adaptador que conecta `requestUrl` con `ResilientHttpTransport`; la política pura aplica timeout lógico, reintentos acotados para `429/500/502/503/504` —no `501`—, `Retry-After`, backoff y jitter inyectables. Los errores transportan solo tipo, estado y espera: nunca URL, cabeceras, cuerpo ni autorización.

`GuildWars2AccountGateway` ejecuta la comprobación atómica `tokeninfo → account` y valida ambos payloads antes de publicarlos. Un `401` se reintenta una vez; `403` en `tokeninfo` también se reintenta y no destruye el último estado bueno, mientras que `403` en `account` representa falta de permiso. Errores offline, timeout y `5xx` conservan el último estado conectado como aviso.

`ConnectionService` nace en `idle`; ni su construcción ni leer el estado ejecutan red. Solo `check()` cambia a `checking` y llama al gateway. Las llamadas simultáneas de una misma generación comparten promesa. `reset()` incrementa el run-id, borra `lastGood` e invalida resultados pendientes; por eso una comprobación antigua no puede sobrescribir una nueva aunque termine después. Los estados de UI son `idle`, `checking`, `connected`, `warning` y `error`.

Un `429` se convierte en `retryAt` usando `Retry-After` o el backoff calculado. Mientras no venza, `ConnectionService.check()` devuelve el estado actual sin tocar red. Vista y ajustes muestran un countdown y deshabilitan la acción; sus intervalos se limpian al cerrar u ocultar cada superficie.

## Secretos

`TyrianSettings.apiKeySecret` guarda únicamente el nombre seleccionado por `SecretComponent`. `ObsidianApiKeyProvider` comprueba con `listSecrets` que la referencia siga existiendo, por lo que borrar el secreto impide la conexión. `GuildWars2Client.beginOperation()` lee el valor una única vez y devuelve una operación que reutiliza esa copia efímera en `tokeninfo`, `account` y sus reintentos. Nunca se persiste. Cambiar o quitar la referencia llama inmediatamente a `ConnectionService.reset()` antes del guardado.

La clave exige `account`. Los permisos `characters`, `inventories`, `wallet`, `tradingpost`, `progression` y `unlocks` forman una matriz de capacidades futuras: su ausencia genera aviso, no una clave inválida. Una clave expirada bloquea la conexión. Si un subtoken declara `urls`, se aceptan las restricciones que incluyan exactamente `/v2/tokeninfo` y `/v2/account`; se avisa de la limitación para módulos futuros. Omitir cualquiera de ambos endpoints bloquea.

Los warnings tienen causa explícita: `future_capabilities` describe una conexión actual válida con capacidades incompletas; `stale_connection` dice que se muestra la última cuenta verificada porque la comprobación actual falló.

## Snapshot de almacenamiento

`StorageSnapshotService` es un servicio de dominio puro y todavía no está conectado a la UI ni al ciclo de carga. Cada invocación abre una `GuildWars2Operation`, fija el valor efímero del secreto y verifica `tokeninfo → account` con esa misma operación antes de capturar. Cuenta, permisos y restricciones quedan copiados en un contexto inmutable; identidad y capacidades nunca proceden del caller. La operación elegida se reutiliza para todos los endpoints y reintentos del snapshot. Todas las rutas de almacenamiento incluyen `?v=2024-07-20T01:00:00.000Z` mediante `PINNED_SCHEMA`; fijar el esquema evita que un cambio de forma de la API altere silenciosamente una captura.

Las fuentes obligatorias son roster de personajes, inventario codificado de cada personaje, inventario compartido, banco y materiales. `wallet` y `commerce/delivery` se consultan solo con `wallet` y `tradingpost`; sin permiso o sin la URL opcional autorizada quedan como `skipped`, no como error. La falta de capacidades obligatorias o de cualquiera de sus URLs exactas —incluidas las rutas dinámicas resueltas después del roster— produce `SnapshotCapabilityError` antes de lanzar el lote. Una respuesta `206`, fuente inaccesible o personaje ausente marca cobertura `partial` y nunca puede producir calidad estable. Payloads inválidos, fallos desconocidos y respuestas `401/403` se propagan: no se disfrazan como un snapshot parcial vacío.

Los parsers aceptan campos futuros desconocidos, incluidos nuevos valores textuales de binding, pero exigen ids enteros seguros positivos y cantidades enteras seguras no negativas. Las cantidades cero se validan y omiten del modelo normalizado. Cada objeto distingue `loose`, `equipped_container`, `embedded_upgrade`, `embedded_infusion` y `pending_claim`. Las bolsas equipadas cuentan como propiedad pero no como disponibilidad; las mejoras e infusiones engastadas también cuentan en `ownedByItem` y se excluyen de `availableByItem`. Skin, stats, atributos, charges y binding quedan como metadatos de colocación.

Cada resultado conserva holdings y divisas con desglose, además de `availableByItem`, `ownedByItem` y `currencyById`. Esta última agrega wallet y delivery por id de divisa y conserva ambos subtotales, sin colisionar con ids de objeto. El snapshot incluye id propio, id estable de cuenta, marcas de inicio y fin y cobertura de cada pasada. La cobertura final fusiona conservadoramente cualquier parcial histórico para que la calidad siempre tenga evidencia visible. No es una valoración de patrimonio total: no consulta catálogo, precios, equipamiento fuera de estas superficies ni otras fuentes de cuenta.

La consistencia usa dos pasadas y una tercera como máximo. Los fingerprints canónicos son independientes del orden de respuesta. Dos pasadas con la misma propiedad dan `stable` si también coinciden colocación y detalles o `stable_owned_placement_changed` si cambian ubicación, binding, cargas o configuración; si cambia la propiedad, B y C deben ser consecutivamente iguales o el resultado es `unstable`. Mover moneda entre delivery y wallet conserva propiedad y cambia colocación. Los límites compartidos por el servicio son seis peticiones globales y cuatro inventarios de personaje, también entre cuentas o claves distintas. Tras verificar por separado sus secretos, capturas simultáneas con el mismo token, cuenta, permisos y restricciones comparten el mismo lote; contextos diferentes nunca se coalescen. Todos los trabajos hermanos se drenan antes de liberar un lote fallido, evitando solapar un reintento con peticiones huérfanas.

## Catálogo público

`PublicCatalogService` recibe un `StorageSnapshot` y devuelve una `CatalogResolution` separada, correlacionada por `snapshotId`; no modifica el snapshot ni mezcla metadatos públicos con la observación de cuenta. Deduplica y ordena ids de objetos, divisas y categorías de materiales, consulta `/v2/items`, `/v2/currencies` y `/v2/materials` en lotes de hasta 200 e incluye `lang=es|en` y el mismo `PINNED_SCHEMA`. `GuildWars2PublicCatalogClient` carece deliberadamente de proveedor de secretos y nunca añade `Authorization`.

El modelo normaliza campos mínimos y conserva enums como strings abiertos. Los items retienen tipo/subtipo y un resumen de `details`: bolsas, consumibles, cargas, mini, sufijos, elecciones de stats y datos desconocidos validados para evolución. `suffix_item_id` conserva su id numérico; el campo legacy `secondary_suffix_item_id` conserva su representación string y `""` significa ausente. Las categorías deduplican sus `itemIds`. Wallet y delivery pueden resolver el mismo id público, pero la salida mantiene claves separadas como `wallet:1` y `delivery:1`.

La cobertura se publica por id como `resolved`, `missing`, `invalid`, `malformed` o `unavailable`, con causa y origen de red/cache. El parsing es por entrada: un válido no se descarta por otro malformado o extra. Duplicados idénticos se toleran; un conflicto invalida solo ese id. Una omisión en `200` es `missing_response`; `206` conserva válidos y registra omitidos como `partial_response`; `404` registra el lote como `not_found`. Warnings estructurados identifican extras, duplicados, malformados y categorías que no incluyen un item observado en material storage; estos avisos no modifican snapshot ni quality.

`CatalogCacheAdapter` separa la política de resolución del almacenamiento. Tanto la clave como el record contienen `schemaVersion` y `normalizerVersion`, evitando mezclar payloads incompatibles. `PersistentCatalogCache` guarda únicamente envelopes JSON en `IndexedDbCatalogRecordStore`; la base `tyrian-companion-public-catalog`, su versión y el store `catalog-records-v1` son explícitos. IndexedDB pertenece al almacenamiento local de la aplicación, fuera de notas/vault y sin secretos. Cada `get`/`set` usa su propia transacción. Antes de devolver un hit, los validators normalizados comprueban de forma completa key, envelope, record, timestamps, causa negativa y cada entidad por kind —campos obligatorios/opcionales, arrays, detalles anidados y `unknownDetails` JSON—; cualquier truncado, tipo corrupto o formato incompatible se trata como miss y se elimina sin romper la resolución. El adapter expone `dispose()` para cerrar la base, acepta un store inyectable y la factory cae explícitamente a `MemoryCatalogCache` si IndexedDB no está disponible o falla al abrir. No se abre ninguna base durante import, carga del plugin o construcción del servicio.

Ambos adapters clonan estructuralmente en sus fronteras: una resolución mutable nunca comparte arrays u objetos con el estado cacheado. Objetos y divisas tienen TTL de siete días, categorías de 24 horas y negativos de una hora. Ante `429/500/502/503/504`, timeout o red, un positivo de hasta 30 días puede responder como `cache_stale`; payloads inválidos y fallos no transitorios no usan stale. Resoluciones idénticas comparten promesa y el límite de tres peticiones simultáneas es global a la instancia del servicio.

Las pruebas del store usan `fake-indexeddb` sobre la implementación real para upgrade/store, commits, delete, reapertura, persistencia, blocked/late-success, versionchange y errores de apertura. Solo el callback `transaction.onabort` usa un harness mínimo de eventos: `fake-indexeddb` no expone una vía pública determinista para abortar el `put` interno entre su creación y el commit.

## Delta de almacenamiento

`compareStorageSnapshots(before, after)` es una función pura con contrato de salida v1. Valida que `ownedByItem`, `availableByItem` y `currencyById` coincidan exactamente con una recomputación completa desde holdings y currencies: ids positivos canónicos, enteros seguros, sin ceros ni campos extra y `total = wallet + delivery`. Una segunda pasada comprueba relaciones que un holding aislado no puede demostrar: toda ubicación de personaje pertenece al roster con cobertura completa, bolsas equipadas e hijos engastados tienen cantidad uno, y cada hijo tiene un root no embebido con el `parentItemId` esperado en la misma ubicación canónica. Delivery admite hijos porque el normalizador vivo los produce bajo su root `pending_claim`; una bolsa equipada no es root apto. Una divergencia de índices produce `aggregate_invariant_failed`; el álgebra del delta se vuelve a calcular desde las entidades normalizadas, no desde los índices. Antes de comparar exige ids distintos, misma cuenta y schema fijado, ventanas válidas no solapadas, quality `stable|stable_owned_placement_changed` y core/personajes completos. Un incumplimiento estructural produce `status: invalid` con razones estructuradas y sin cambios parciales.

Items y divisas se cualifican por separado. La superficie de items suma core y delivery solo cuando `commerce_delivery` está completa en ambos snapshots; si no, excluye delivery simétricamente como `core_only`. La divisa usa `wallet_and_delivery` solo cuando wallet y delivery están completas a ambos lados, `wallet_only` cuando wallet es comparable pero delivery no, y `unavailable` cuando wallet falta, es parcial o asimétrica. En este último caso `currencyChanges` y la composición de divisas quedan vacíos, pero el delta de items se conserva. Solo ambas superficies completas producen `status: comparable`; cualquier dimensión limitada o no disponible produce `limited`. Así, reclamar un item o mover monedas de delivery a wallet permanece neutral cuando existe evidencia suficiente, sin extrapolar datos ausentes.

`itemChanges` y `currencyChanges` contienen únicamente netos no nulos. `availabilityChanges` explica cambios de disponibilidad con propiedad neta cero. `compositionChanges` conserva, en orden canónico, movimientos, estado, binding, charges, skin, stats y split/merge sin convertirlos en loot. Warnings deterministas hacen visibles cobertura asimétrica, wallet no observada, cambio de roster, colocación inestable durante captura, límites de superficie y que el neto no revela turnover bruto. El comparador no aplica heurísticas de sesión/contaminación, catálogo, precios ni recomendaciones; esas decisiones pertenecen a H2.7 o verticales posteriores. El delta no se persiste ni está conectado a UI.

## Evidencia y contaminación de sesión

H2.7 añade dos funciones puras sin I/O. `buildBoundaryEvidence(before, after)` valida identidad, cuenta y ventana, y proyecta totales de items/monedas en delivery y divisas de wallet. Cada superficie conserva cobertura `complete_both|missing_both|asymmetric`, ids de snapshot, cuenta y ventana. Los totales se ordenan y llevan `before`, `after` y `delta` comprobable con enteros seguros.

`classifySessionDelta(delta, context)` acepta ambos argumentos como datos no confiables y aplica guards estructurales estrictos antes de acceder a ellos: identidad, ventanas, superficies, razones, warnings, cambios, composición, evidencia TP, frontera y cada variante de declaración. `null`, campos anidados ausentes, variantes desconocidas, propiedades extra incoherentes o aritmética corrupta devuelven `invalid` sin lanzar. Una composición solo es válida si ambos lados son no vacíos, distintos y canónicamente ordenados, conservan suma por id dentro de enteros seguros y respetan estado/ubicación: bolsa equipada solo en `equipped_bag`, root pending solo en delivery e hijos unitarios con relación embebida válida fuera de una bolsa equipada. Las composiciones de divisa conservan igualmente el total. Después valida que la frontera coincida con ids, cuenta, ventana y superficies del delta. El contexto aporta evidencia TP `complete|partial|unavailable` con eventos normalizados dentro de ventana, declaración explícita del usuario y certeza de fronteras. La prioridad es `invalid > contaminated > estimated > exact`: cambios de delivery con cobertura completa, compra/venta TP, descenso de wallet observado completamente, roster cambiado o actividades declaradas contaminan. Datos residuales bajo cobertura ausente/asimétrica no se interpretan como actividad. Un aumento de wallet es ambiguo mientras falte confirmación, pero una declaración limpia con fronteras manuales puede resolverlo dejando razón informativa. La evidencia observada siempre domina una declaración limpia en conflicto.

La evidencia representa monedas de delivery explícitamente como currency id `1`, el namespace de monedas de GW2. Tanto el parser de snapshots de frontera como el guard de `BoundaryEvidence` rechazan cualquier otro id bajo namespace `delivery`; los ids de wallet permanecen abiertos.

`exact` exige delta completo/comparable, fronteras confirmadas manualmente, declaración limpia y ausencia de contaminación. Esa declaración puede suplir TP no disponible dejando una razón informativa. La salida v1 usa scope `observed_storage_net`, razones y solicitudes de revisión deduplicadas/canónicas, confianza y permisos explícitos. Un resultado contaminado puede finalizar y mostrar solo el neto; uno estimado permite valoración provisional pero no rendimiento bruto, y solo finaliza si la aceptación ya está reflejada como frontera manual y declaración limpia; uno inválido bloquea todo. Las recomendaciones permanecen deshabilitadas incluso en exacto hasta que existan motores económicos. H3.9 conserva ownership de preguntas, aceptación y persistencia.

## Ajustes y migración

El esquema actual es `2`. `migrateSettings` convierte de forma idempotente los datos sin versión de `0.1.0`, descarta propiedades desconocidas y valida enums e intervalos. La carpeta de salida solo acepta segmentos relativos separados por `/`: rechaza `.`/`..`, NUL, barras inversas, `:*?"<>|`, punto o espacio final, rutas absolutas y el directorio de configuración real del vault. Esta vertical no escribe ningún archivo.

`SecretStorage` está disponible desde Obsidian `1.11.4`, que por ello es también `minAppVersion`.

## Contratos pendientes

Antes de activar sesiones u objetivos hay que decidir:

- Qué datos son efímeros y cuáles se persisten.
- Qué formato de nota, si alguno, puede escribir el plugin.
- Cómo se explican y auditan las recomendaciones.
- Cómo recuperar automáticamente cambios de roster/`404` durante una captura sin ocultar cobertura parcial.
- Cómo coordinar un cooldown `429` global entre las peticiones paralelas de una captura.
- Precios y valoración; no forman parte de `storage_snapshot` ni de `PublicCatalog`.
- Flujo H3.9 de preguntas, aceptación y persistencia para consumir la clasificación pura H2.7.
