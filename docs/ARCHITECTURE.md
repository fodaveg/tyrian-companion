# Arquitectura

## Capas

`src/main.ts` es la composición del plugin. Registra la vista, el comando y los ajustes, y conecta adaptadores de Obsidian con servicios independientes.

- `core`: transporte HTTP resiliente, configuración versionada y acceso diferido a secretos.
- `account`: cliente de Guild Wars 2, validación runtime, conexión y estado efímero.
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

## Ajustes y migración

El esquema actual es `2`. `migrateSettings` convierte de forma idempotente los datos sin versión de `0.1.0`, descarta propiedades desconocidas y valida enums e intervalos. La carpeta de salida solo acepta segmentos relativos separados por `/`: rechaza `.`/`..`, NUL, barras inversas, `:*?"<>|`, punto o espacio final, rutas absolutas y el directorio de configuración real del vault. Esta vertical no escribe ningún archivo.

`SecretStorage` está disponible desde Obsidian `1.11.4`, que por ello es también `minAppVersion`.

## Contratos pendientes

Antes de activar sesiones u objetivos hay que decidir:

- Qué datos son efímeros y cuáles se persisten.
- Qué formato de nota, si alguno, puede escribir el plugin.
- Cómo se explican y auditan las recomendaciones.
