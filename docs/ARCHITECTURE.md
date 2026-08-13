# Arquitectura

## Capas

`src/main.ts` es la composición del plugin. Registra la vista, el comando y los ajustes, y conecta adaptadores de Obsidian con servicios independientes.

- `core`: transporte HTTP, configuración validada y acceso diferido a secretos.
- `account`: cliente de Guild Wars 2 y contrato de cuenta.
- `advisor`: estado de preparación, sin lógica de recomendación todavía.
- `sessions`: modelo y contrato de persistencia de sesiones.
- `objectives`: modelo y contrato de persistencia de objetivos.
- `ui`: vista y pestaña de ajustes de Obsidian.

## Flujo de dependencias

```text
main -> ui -> advisor
  |             |
  +-> account <-+
        |
        +-> core (HTTP + SecretStorage)

sessions ----> contratos puros
objectives --> contratos puros
```

Los módulos de dominio no dependen de la UI. El transporte `ObsidianRequestTransport` es el único punto que llama a `requestUrl`; devuelve `unknown` para que cada frontera de dominio valide su respuesta. `GuildWars2Client` recibe tanto el transporte como el proveedor de clave para poder probarse sin red. `GuildWars2AccountGateway` valida el perfil antes de exponerlo como `AccountProfile`.

## Secretos

`TyrianSettings.apiKeySecret` guarda únicamente el nombre seleccionado por `SecretComponent`. `ObsidianApiKeyProvider` comprueba con `listSecrets` que la referencia siga existiendo, por lo que borrar el secreto devuelve el advisor al estado no configurado. El valor solo se resuelve con `app.secretStorage.getSecret` cuando el cliente va a ejecutar una petición. El cliente rechaza URL absolutas para no reenviar credenciales fuera del host configurado.

`SecretStorage` está disponible desde Obsidian `1.11.4`, que por ello es también `minAppVersion`.

## Contratos pendientes

Antes de activar cuenta, sesiones u objetivos hay que decidir:

- Qué endpoints y permisos mínimos necesita la clave.
- Qué datos son efímeros y cuáles se persisten.
- Qué formato de nota, si alguno, puede escribir el plugin.
- Cómo se explican y auditan las recomendaciones.
