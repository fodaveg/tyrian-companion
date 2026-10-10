# QA corta de Tyrian Companion en Hebra

Guion de unos 30 minutos para comprobar, en un Hebra real, que una release de Tyrian Companion se
instala, carga y enseña lo esencial. Escrito contra el código de `52fa782c` (canal 0.6.35); los
nombres de botones y textos son los de `src/core/i18n*.ts` en español. Si cambian, el código manda.

Hasta que alguien lo ejecute, nada de esto está probado en un Hebra real: la formulación correcta de una
release sigue siendo «canal publicado; instalación/runtime pendiente» (ver [ESTADO](ESTADO.md) y
[BETA](BETA.md)). Un paso sin ejecutar se anota como «sin comprobar», no como correcto.

Qué necesitas: Hebra con **Plugins de terceros** activado y una carpeta `Tyrian Companion` en la
biblioteca. Sin el juego solo se pueden hacer los pasos 1 a 6 y 9; el 7 y el 8 piden Guild Wars 2 con el
addon de Nexus.

Para cada paso: anota la versión que probaste y marca **OK**, **FALLA** o **SIN COMPROBAR**. No pegues
claves, tokens ni capturas con datos de cuenta ([soporte seguro](SUPPORT.md)).

## 1. Instalar desde la release

1. En Hebra, abre **Ajustes**, entra en **Plugins** y activa **Plugins de terceros**.
2. En **Añadir por URL de GitHub**, escribe `fodaveg/tyrian-companion`, pulsa **Buscar** y después
   **Instalar**. Para actualizar, repite el paso sobre la versión nueva.

Debe verse: Tyrian Companion en la lista de plugins, con el icono del monstruo (el de la espada es Hebra
anterior a `iconImage`) y activado.

Si no: confirma que la release es la normal más reciente (el instalador de Hebra omite las
prereleases) y espera de 5 a 15 minutos si acaba de publicarse. Si sigue sin salir, anota el texto
exacto del error.

## 2. Comprobar la versión cargada

1. En la ficha de Tyrian Companion (**Ajustes**, **Plugins**), mira la versión.
2. Compárala con la de la [release](https://github.com/fodaveg/tyrian-companion/releases) que querías
   probar.

Debe verse: la misma versión. Que el plugin aparezca instalado no prueba que esté cargado: la carga se
da por buena cuando abren los pasos 3 a 7.

Si no coincide: apaga y enciende el plugin en Hebra, o reinicia Hebra, y vuelve a mirar. Si sigue
distinta, anota las dos versiones y para aquí.

## 3. Abrir Sesión

1. Pulsa el botón de Tyrian Companion en la barra y elige **Abrir acompañante**.
2. Entra en **Sesión**.

Debe verse: la vista principal con las secciones **Sesión**, **Inventario**, **Venta** y **Logros**. En
Sesión, «Sin sesión» o «Juego desconectado» si el juego está cerrado, y «Abre Guild Wars 2 con el addon
de Nexus para poder iniciar.» Sin errores en pantalla.

Si no: si la vista sale en una columna y no en la pantalla principal, anótalo (Hebra sin la vista
principal). Si queda en blanco o en «arrancando», anota la hora y mira el paso 9.

## 4. Abrir Inventario

1. Entra en **Inventario**.

Debe verse: el título «Asesor de inventario» y el texto de introducción. Sin clave API no hay datos de
cuenta: es lo previsto, no un fallo. Los iconos de objetos, si los hay, se comprueban en el paso 6.

Si no: si el panel no responde o sale un error, anota el texto.

## 5. Abrir Venta, Logros y Ajustes

1. Entra en **Venta**. Debe verse «Venta de Halloween» con «Leyendo precios del bazar…» y después los
   objetos de temporada, o «No hay objetos de temporada en el inventario todavía.» En el pie, el botón
   **Actualizar**.
2. Entra en **Logros**. Debe verse «Logros», el buscador «Buscar logro por nombre» («Escribe 2 letras o
   más») y el botón **Actualizar progreso**. El buscador y **Seguir** no piden clave API; el progreso sí.
3. Abre los ajustes de Tyrian Companion desde su ficha (**Ajustes…**). Debe verse la lista de ajustes
   del plugin, con **Modo de esta instalación**, **Aviso dentro del juego (opcional)** y, más abajo,
   **Registros de diagnóstico**.

Si no: una sección que no abre o se queda cargando, con la hora y el texto del error.

## 6. Imágenes remotas (`render.guildwars2.com`)

Los paneles cargan iconos con `<img>` desde `render.guildwars2.com`. `hebra.json` solo declara los
hosts de `api.guildwars2.com` y `api.datawars2.ie` para las peticiones del plugin; no se ha comprobado
que el webview de Hebra deje cargar imágenes de otro host.

1. En **Logros**, busca un logro con recompensa (por ejemplo, escribe tres letras de un logro conocido) y
   pulsa **Seguir**. Mira la lista de seguidos y sus elementos.
2. En **Inventario** o **Venta**, abre una fila con objeto.
3. Si tienes una sesión en vivo, mira la tabla de objetos de **Sesión**.

Debe verse: los iconos de los objetos, recompensas y monedas junto al nombre.

Si no: si solo ves el nombre y un hueco o nada, anota en cuál de los tres sitios falla. Es la señal de
que el webview bloquea el host y hay que decidir qué hacer; no es un fallo de red del juego.

## 7. Portapapeles (**Copiar token**)

1. En los ajustes, en **Aviso dentro del juego (opcional)**, elige **Activadas**.
2. En **Token del addon**, pulsa **Crear token** (si ya hay uno, **Copiar token**).
3. Pega en otro sitio (el campo de búsqueda de Hebra sirve; bórralo después).

Debe verse: el aviso «Token copiado.» (o «Token nuevo creado y copiado.») y, al pegar, una cadena larga.
No la guardes ni la compartas.

Si no: si sale «El portapapeles no respondió. Cópialo con Ctrl+C (Cmd+C en macOS).» o «No se pudo copiar el
token.», el webview no deja usar el portapapeles: anótalo. El texto de ayuda sigue siendo útil para copiar
a mano.

## 8. Sonido de avisos

El sonido es uno de los canales de un aviso de drop (**Avisarme de un drop desde**, en los ajustes). No
hay botón de prueba: solo suena con un aviso real, así que este paso necesita el juego conectado.

1. Con Hebra abierta y el juego conectado, consigue un drop que supere el umbral.
2. Escucha.

Debe verse y oírse: el aviso y un tono corto.

Si no suena: anótalo junto a si el aviso visual sí salió. Hebra puede dejar el audio en espera hasta que
el usuario interactúa con la ventana; pulsa algo en Hebra y repite con otro drop.

Sin el juego, marca este paso como **SIN COMPROBAR**.

## 9. Un comando no disponible

1. Abre la paleta de comandos de Hebra y busca «Terminar sesión de farmeo».
2. Ejecútalo sin ninguna sesión activa.

Debe verse: un aviso corto y no un error. O el motivo concreto de la acción, o «Terminar sesión de
farmeo» no está disponible ahora.

Si no: si no pasa nada, o sale un error técnico, anota el texto.

---

## Lista corta por release: candados y tomas (GR-08)

Toda la evidencia de almacenamiento y candados de [ESTADO](ESTADO.md) sale de dobles de test (IndexedDB
falso, gestor de candados en memoria, reloj simulado). Esta lista pone a un motor real a contrastarlos.
Se rellena una vez por release, en Obsidian y en Hebra. La ejecución es de una persona con la app abierta.

1. **Activar el registro y el nivel.** En los ajustes, bajo **Registros de diagnóstico**, activa
   **Activar registros de diagnóstico** y en **Nivel mínimo** elige **Depuración**. El nivel por
   defecto es **Avisos** y el registro viene apagado: con ese ajuste no se escriben `life_lock_proven`,
   `life_lock_absent` ni `taken`, que se guardan a nivel de depuración; solo `life_lock_unmarked` y
   `refused` llegan a avisos.
2. **Empezar una sesión.** El evento de instancia no sale al arrancar: se emite en la primera
   adquisición de la reserva, o sea, cuando una sesión empieza o se recupera. Con el juego conectado,
   pulsa **Iniciar sesión** en Sesión (o deja que empiece sola).
3. **Provocar una recuperación (para `taken`).** Con la sesión en curso, cierra Hebra u Obsidian a la
   fuerza (sin cerrar el plugin), reabre y espera a que la sesión se recupere.
4. **Leer el registro.**
   - En Hebra no hay carpeta de registros (**Abrir carpeta de registros** sale deshabilitado, con «Aquí no
     hay carpeta de registros. Copia un extracto o crea un paquete de soporte.»). En **Registros de
     diagnóstico**: pulsa **Copiar extracto saneado** (copia hasta 50 entradas al portapapeles) o
     **Crear paquete de soporte**, revisa la lista que enseña y confirma con **Crear paquete de soporte**.
     El mensaje final dice el fichero creado.
   - En Obsidian, **Abrir carpeta de registros** abre los JSONL.
5. **Buscar los eventos** en el extracto (componente de coordinación; el nombre va en el campo `state` o
   `result`):

   | Evento                | Qué dice                                                                 |
   | --------------------- | ------------------------------------------------------------------------ |
   | `life_lock_proven`    | El motor concedió el candado de vida y lo vio tomado: es la buena señal  |
   | `life_lock_unmarked`  | No se vio tomado: `reason` es `lock_not_granted` o `lock_not_seen_held`  |
   | `life_lock_absent`    | Sin gestor de candados (`navigator.locks`): el host no lo da             |
   | `taken` (`result`)    | Se tomó la reserva de otra instancia cuyo candado estaba libre           |
   | `refused` (`result`)  | No se tomó; `reason` dice por qué                                        |

Anota por host: cuál de los tres `life_lock_*` salió, si hubo `taken` tras el cierre forzado y si el
extracto cabe en el nivel elegido. Un host que da `life_lock_absent` o `life_lock_unmarked` es justo el
dato que los dobles no pueden dar. No copies el extracto entero en ningún sitio: el extracto va saneado,
pero se revisa antes de compartirlo.

Al terminar, vuelve a poner **Nivel mínimo** en **Avisos** y, si no los necesitas, **Limpiar registros**.

---

## Anexo técnico

- **Qué cubre este guion y qué no.** Es la instalación y carga en un cliente real (HP-03) y las
  capacidades del webview (HP-15). La verificación automática de la release es aparte: `npm run
  release:brat-verify` sobre la salida de `gh release view`, con los ocho assets de [BETA](BETA.md).
- **Qué está medido en tests y no en un cliente.** Todo el comportamiento anterior sale de pruebas con el
  fake de la librería de Hebra. En particular no está medido que el webview dé `navigator.locks` a los
  plugins (sin él, la reserva huérfana tarda hasta 5 minutos), que cargue imágenes remotas ni que
  `navigator.clipboard` o WebAudio funcionen sin gesto del usuario.
- **Dónde está cada cosa en el código.** Imágenes: `src/ui/live-session-panel.ts`,
  `src/ui/achievements-view.ts`, `src/ui/inventory-advisor-view.ts`, `src/ui/price-history-panel-view.ts`.
  Portapapeles de Hebra: `clipboard.writeText` en `src/host/hebra/hebra-host.ts`. Sonido:
  `src/alerts/alert-sound.ts`. Comandos: `registerCommand` en `src/host/hebra/hebra-host-ui.ts`
  (prefijo `tyrian-companion:`; texto de no disponible: `hebra.command.unavailable`).
- **Nombres de sección.** Los ids son estables (`session`, `inventory`, `sale`, `achievements`,
  `src/ui/mounted-views.ts`); los textos salen de `shell.nav.*`.
- **Dónde nacen los eventos de candado.** `src/sessions/coordination-coordinator.ts`
  (`settleLife`, `reportLifeAbsent`, `reportRefusal` y la toma tras `confirmAndTake`). El nivel con el que
  se escriben lo decide `src/core/local-debug-persistence.ts`: fallo a `error`, `skip` con código
  distinto de `skipped` a `warn`, `cancelled` a `info`, el resto a `debug`. Valores por defecto en
  `src/core/settings.ts` (`debugLoggingEnabled: false`, `debugLoggingLevel: 'warn'`). Un cambio técnico
  que subiese `taken` y los `life_lock_*` a `info` haría innecesario el paso 1 de la lista de arriba.
- **Hebra guarda el registro en una base IndexedDB** (`src/host/hebra/local-storage.ts`), no en un
  fichero: solo se lee con el extracto o el paquete de soporte de los ajustes.
- **Instalación en disco.** Hebra deja la versión instalada en su `installed.json` y los ficheros del
  plugin en `plugins/tyrian-companion/<versión>/`; comparar sus hashes con los de `gh release view` es la
  comprobación de instalación que se puede automatizar (clase a de la matriz de [QA-MVP](QA-MVP.md)). Las
  rutas exactas dependen del sistema y no las verifica este documento.
