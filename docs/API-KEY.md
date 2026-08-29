# Clave API de Guild Wars 2

Tyrian Companion usa la API oficial y de solo lectura de Guild Wars 2. La clave permite leer las
superficies que autoricen sus permisos; no permite vender, destruir, mover ni usar objetos. Aun así,
trátala como un secreto: contiene acceso a datos privados de la cuenta.

## Crear la clave

1. Entra en [Applications, en la cuenta de ArenaNet](https://account.arena.net/applications).
2. Crea una clave con un nombre reconocible, por ejemplo `Tyrian Companion beta`.
3. Elige uno de estos perfiles:

   | Perfil | Permisos | Qué permite en Tyrian Companion |
   | --- | --- | --- |
   | Solo comprobar conexión | `account` | Valida la clave y muestra la cuenta; no puede iniciar una sesión. |
   | Mínimo funcional v1 | `account`, `characters`, `inventories`, `builds` | Capturas estables, inventario principal, personaje y build activo para sesiones manuales/asistidas. |
   | Recomendado para toda la beta actual | Los cuatro anteriores + `wallet`, `tradingpost`, `progression`, `unlocks` | Añade monedas, entregas, órdenes actuales e historial reciente del bazar, además de señales de logros/recetas/skins/minis para mejorar cobertura y revisión. |

   No hacen falta `guilds`, `pvp` ni `wvw`. ArenaNet no deja ampliar los permisos de una clave ya
   creada: para cambiar el perfil, crea otra y revoca la anterior.
4. Copia el valor una sola vez y guárdalo como secreto desde **Ajustes de Obsidian → Tyrian
   Companion → API key**. Selecciona o crea un secreto de Obsidian y pega allí el valor. No lo pegues
   en una nota, en `data.json`, en un issue ni en una captura de pantalla.
5. Pulsa **Check connection / Comprobar conexión**. El plugin consulta primero `/v2/tokeninfo` y solo
   después `/v2/account`; nunca muestra ni persiste el valor de la clave.

La tabla refleja los endpoints que usa el código actual. La referencia pública de permisos y
endpoints está en [API:API key](https://wiki.guildwars2.com/wiki/API_key) y
[API:2/tokeninfo](https://wiki.guildwars2.com/wiki/API%3A2/tokeninfo).

## Por qué se pide cada permiso

- `account`: identidad estable y comprobación inicial. ArenaNet lo exige además para las claves.
- `characters`: lista de personajes y lectura del personaje de la sesión.
- `inventories`: inventario compartido, banco, materiales e inventarios/equipo de personajes.
- `builds`: build activo al iniciar la sesión. Sin él, el inicio falla de forma explícita.
- `wallet`: monedas de la cuenta, usadas por la sincronización de cartera al vault (`Wallet.base`) y
  por la comparación de snapshots; sin él, la captura de cartera falla de forma explícita y esa
  superficie queda no disponible.
- `tradingpost`: entregas pendientes, órdenes actuales e historial reciente de compras y ventas. El
  Asesor usa `/v2/commerce/transactions/current/buys` y `current/sells` para evitar una recomendación
  que choque con una orden activa, únicamente cuando el lado correspondiente tiene cobertura
  completa. El modal de revisión puede consultar `history/buys` y `history/sells` dentro de la
  ventana exacta de la sesión, con un máximo de 90 días, y solo propone marcar actividad para que la
  confirmes. Los precios públicos no usan clave.
- `progression`: logros utilizados como evidencia opcional del Inventory Advisor.
- `unlocks`: recetas, skins y minis como evidencia opcional del Inventory Advisor y de las alertas de Halloween. Halloween consulta `/v2/account/skins` y `/v2/account/minis` solo al estar activado; cada tipo se evalúa con cobertura independiente y nunca afirma que falte un desbloqueo en una dimensión ausente o fallida.

Los cuatro permisos del perfil mínimo son necesarios para el flujo completo de sesión, aunque una
mera comprobación de conexión acepte una clave con solo `account`. Los cuatro adicionales mejoran la
cobertura, pero una ausencia nunca se rellena con suposiciones. Sin `tradingpost`, o con cobertura
parcial, las órdenes no suprimen acciones y el historial no propone contaminación; la revisión
manual sigue disponible.

## Revocar o rotar una clave

1. Si sospechas que el valor se ha expuesto, revoca primero la clave en
   [Applications](https://account.arena.net/applications). La revocación invalida el acceso remoto.
2. Crea otra clave con los permisos necesarios.
3. Sustituye el valor en Obsidian Secret Storage o crea un secreto nuevo y selecciónalo en Tyrian
   Companion.
4. Ejecuta de nuevo **Check connection**. Cambiar el secreto invalida el estado de cuenta comprobado
   y los resultados anteriores no se reutilizan como si pertenecieran a la nueva clave.
5. Elimina la copia local antigua de Secret Storage cuando ya no sea necesaria.

Revocar la clave en ArenaNet y borrar el secreto local son dos acciones distintas. No compartas el
valor antiguo para pedir ayuda: revócalo y describe solo el código de error visible.

## Errores habituales

| Estado visible | Comprobación segura |
| --- | --- |
| Falta la clave | Selecciona un secreto existente o crea uno; no pegues el valor en otro campo. |
| Clave inválida o caducada | Revócala si procede, crea otra y sustituye el secreto. |
| Falta `account` | Crea una clave nueva con `account`; los permisos no se pueden editar. |
| El inicio pide `builds` | Usa el perfil mínimo funcional, que incluye `builds`. |
| La captura indica permisos insuficientes | Comprueba `characters` e `inventories`; para el flujo completo deben acompañar a `account`. |
| Subtoken limitado por URL | Debe permitir todos los endpoints privados que use el flujo; para la beta se recomienda una clave normal con permisos mínimos. |
| Límite de peticiones | Espera al contador de cooldown y vuelve a intentarlo; no repitas clics ni regeneres la clave. |
| Servicio no disponible o respuesta inválida | Conserva la clave en Secret Storage, espera y prueba más tarde. Si persiste, informa solo del estado visible y del contexto redactado. |

Consulta [Soporte y reporte seguro](SUPPORT.md) antes de adjuntar diagnósticos.
