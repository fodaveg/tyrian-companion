# Inventario durable y Bases

Tyrian Companion puede generar notas de inventario que consumen `Inventory.base` y `Materials.base`.
La operación es manual: abrir el plugin o el Inventory Advisor no consulta la cuenta ni modifica el
vault.

## Activar

1. Configura una clave API mediante Obsidian Secret Storage. Debe incluir `account`, `characters` e
   `inventories`.
2. En Ajustes de Tyrian Companion, elige una carpeta de salida portable.
3. En **Assets gestionados**, ejecuta **Vista previa** y después **Aplicar**. El bundle instala
   `Bases/Inventory.base` y `Bases/Materials.base` en el idioma activo.
4. Abre **Asesor de inventario** y localiza **Inventario durable**.

## Sincronizar

1. Pulsa **Previsualizar sincronización**. Esta acción captura de forma estable inventarios de
   personajes, inventario compartido, banco y materiales; después resuelve catálogo, precios de
   venta instantánea y notas existentes.
2. Revisa el recuento de filas nuevas, actualizadas e inactivas. Todavía no se ha escrito nada.
3. Pulsa **Sincronizar con el vault**. El plugin relee todos los archivos del plan antes de escribir.
   Si una nota cambió, pertenece a otra herramienta o usa un schema futuro, la operación falla sin
   sobrescribirla.
   Una nota escrita por una versión anterior del plugin, a la que le faltan columnas añadidas
   después, no cuenta como modificada: se reconoce y se reescribe con las columnas nuevas.
4. Abre `Bases/Inventory.base`. Comprueba las vistas Todos, Personajes, Compartido, Banco y
   Materiales. Filtra `Personaje` para verificar que la cantidad y el valor corresponden solo a esa
   fila.
5. Abre `Bases/Materials.base` y comprueba la vista agregada por objeto del almacén de materiales.

Cada nota representa una combinación de objeto, ubicación y personaje. Varias pilas del mismo objeto
en un personaje se suman. Un objeto presente en dos personajes conserva dos filas. Los objetos que
desaparecen no se borran: quedan inactivos y con cantidad cero, y las Bases los ocultan.

## Migrar desde los scripts `gw2_*`

La integración no importa, adopta ni elimina notas creadas por scripts anteriores. Pueden convivir
mientras se comprueba el resultado nuevo.

1. Conserva el script y sus notas actuales.
2. Instala las Bases gestionadas y completa una sincronización desde el plugin.
3. Compara cantidades, personajes, banco, materiales y algunos precios representativos.
4. Haz una segunda previsualización. Un inventario sin cambios debe mostrar las notas como sin
   cambios.
5. Solo después, desactiva o retira manualmente el script antiguo. No borres sus notas hasta tener la
   copia de seguridad y la comparación que necesites.

Quitar los assets gestionados no elimina las notas dinámicas de inventario. Se conservan para evitar
pérdida de datos y se pueden revisar o retirar manualmente.
