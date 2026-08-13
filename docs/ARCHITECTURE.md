# Arquitectura

## Capas

`src/main.ts` es la composición del plugin. Registra la vista, el comando y los ajustes, y conecta adaptadores de Obsidian con servicios independientes.

- `core`: transporte HTTP resiliente, configuración versionada, acceso diferido a secretos y limitación FIFO de concurrencia.
- `account`: cliente de Guild Wars 2, validación runtime, conexión, estado efímero y snapshots de almacenamiento.
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
- Catálogo, caché y valoración; no forman parte de `storage_snapshot`.
