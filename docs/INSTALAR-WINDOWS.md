# Instalar Tyrian Companion en Windows

Son dos partes. La primera vale sola. La segunda añade las sesiones y las notas.

Versiones: addon 0.8.6, plugin 0.6.26, Hebra 0.2.3. Esta guía todavía no se ha probado en Windows.
Si un paso no coincide con lo que ves, mira la [guía detallada](INSTALAR-WINDOWS-DETALLE.md).

## Parte 1. Nexus y el addon

1. Instala Nexus desde [raidcore.gg](https://raidcore.gg/) y abre Guild Wars 2.
2. Descarga el fichero `.dll` de la
   [release 0.8.6 del addon](https://github.com/fodaveg/tyrian-companion-nexus/releases/tag/0.8.6).
3. En el juego, abre la lista de addons de Nexus y pulsa **Abrir carpeta de addons**.
4. Copia el `.dll` en esa carpeta.
5. Vuelve al juego. Si el addon no aparece en la lista, pulsa el botón de refrescar o reinicia el
   juego.

Está bien instalado si en las opciones de Nexus hay una sección **Tyrian Companion**.

El addon solo no muestra datos. Las cifras, las sesiones y las notas llegan del plugin (Parte 2).

Desde el addon 0.8.5 Nexus lo actualiza solo (puede tardar hasta 30 minutos en ver una versión nueva). Si tienes la 0.8.4 o anterior, pon la 0.8.5 o posterior a mano una vez: cierra el juego y sustituye el `.dll` por el nuevo.

## Parte 2. Hebra y la conexión con el addon

1. Descarga [Hebra para Windows](https://app.hebra.pro/repo/hebra-latest-x64-setup.exe) e
   instálala. Windows avisará de que no reconoce la app: pulsa **Más información** y después
   **Ejecutar de todas formas**.
2. En Hebra, abre **Ajustes**, entra en **Plugins** y activa **Plugins de terceros**.
3. En **Añadir por URL de GitHub**, escribe `fodaveg/tyrian-companion`, pulsa **Buscar** y después
   **Instalar**.
4. Crea en Hebra una carpeta llamada `Tyrian Companion`. El plugin guarda ahí sus notas.
5. En la ficha de Tyrian Companion, pulsa **Ajustes…**. En **Aviso dentro del juego (opcional)**,
   elige **Activadas**.
6. En **Token del addon**, pulsa **Copiar token**.
7. En el juego, abre las opciones de Nexus y entra en **Tyrian Companion**. Pulsa **Paste** junto a
   **Token** y después **Save**.
8. En esas mismas opciones, en **App to open**, elige **Hebra**.

Está bien conectado si la línea de estado dice **Status: connected**.

## Jugar

1. Abre Hebra.
2. Abre Guild Wars 2 y entra a jugar. La sesión empieza sola.
3. Para ver la sesión en Hebra, pulsa el botón de Tyrian Companion y elige **Abrir acompañante**.
4. Para ver el panel en el juego, pulsa el icono de la calabaza en la barra de Nexus.

Al salir del juego, la sesión se cierra y Hebra guarda una nota resumen en
`Tyrian Companion/summaries`.

## Si algo falla

| Qué ves                                         | Qué hacer                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| El estado no pasa a **connected**               | Hebra abierta, **Aviso dentro del juego** en **Activadas**, token pegado y **Save** otra vez |
| El addon dice que el token fue rechazado        | Copia el token otra vez en Hebra, pégalo en el addon y pulsa **Save**                        |
| «El servidor no pudo iniciarse» en los ajustes  | Otra app usa el puerto 47823. Cierra Obsidian si lo tienes abierto con el plugin             |
| El panel del juego no tiene cifras              | Falta conectar el plugin: haz la Parte 2                                                     |
| `unsupported_build`                             | El juego se actualizó y el addon aún no lee esa versión. Hay que esperar a un addon nuevo    |
| No aparece la fila «Dónde se muestra» en Hebra  | Es lo previsto en Hebra 0.2.3 de Windows. El plugin se ve en la columna derecha              |

Más casos en la [guía detallada](INSTALAR-WINDOWS-DETALLE.md#b-problemas-frecuentes).

## Con Obsidian en vez de Hebra

Instala el plugin con BRAT (`fodaveg/tyrian-companion`) y haz los pasos 5 a 7 de la Parte 2 en los
ajustes del plugin dentro de Obsidian. El paso 8 no hace falta.

## Clave de API

No hace falta para las sesiones. Solo sirve para el inventario y la cartera manuales: ver
[Clave API de Guild Wars 2](API-KEY.md).
