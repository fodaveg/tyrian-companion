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

1. Pulsa **Sincronizar inventario** (`advisor.sync.button`). Es un flujo de un solo clic
   (`runInventoryVaultSync`, `src/ui/inventory-vault-sync-run-controller.ts`): el Inventory Advisor
   captura inventarios de personajes, inventario compartido, banco y materiales; aplica tus
   preferencias guardadas (objetivos, excepciones de conservar y los legendarios elegidos en
   Ajustes); clasifica cada objeto y le pone momento (vender ya, esperar a temporada, esperar mejor
   precio); calcula el plan de sincronización con el vault; y, si el plan no desactiva ninguna fila,
   escribe directamente. **Analizar sin escribir** (`advisor.sync.analyze`) es un botón distinto:
   hace el mismo análisis para refrescar la vista, sin tocar el vault ni calcular el plan de notas.

   Las notas se escriben desde ese mismo análisis (H18.16, `src/inventory/inventory-analysis.ts`):
   una sola captura por análisis, y la vista, las notas y la Base muestran la misma decisión por
   objeto (H18.14). Si esa captura no sirve para reescribir notas (instantánea inestable, un almacén
   incompleto o más de 15 minutos de antigüedad), la sincronización hace **un** análisis más, que la
   vista también pasa a mostrar; nunca una segunda captura privada de las notas.
2. Si el plan desactivaría alguna fila que ya no aparece en la cuenta, el flujo se detiene antes de
   escribir y muestra **Confirmar cambios antes de escribir** con el recuento de filas nuevas,
   actualizadas, sin cambios, inactivas (a papelera) y en conflicto; nada se escribe hasta que pulsas
   **Confirmar y escribir**. Si el plan solo crea o actualiza filas, sin desactivar ninguna, escribe
   sin pedir confirmación.
3. Al escribir, el plugin relee cada nota que va a cambiar. Una nota que cambió entre la vista
   previa y la escritura, que pertenece a otra herramienta, que usa un schema futuro o cuyo bloque
   gestionado se editó a mano es un **conflicto de esa nota**: no se toca y se cuenta en el resumen,
   pero el resto del plan se escribe igual (H18.16). Una nota escrita por una versión anterior del
   plugin, a la que le faltan columnas añadidas después, no cuenta como modificada: se reconoce y se
   reescribe con las columnas nuevas.
4. Abre `Bases/Inventory.base`. Comprueba las vistas Todos, Personajes, Compartido, Banco y
   Materiales. Filtra `Personaje` para verificar que la cantidad y el valor corresponden solo a esa
   fila.
5. Abre `Bases/Materials.base` y comprueba la vista agregada por objeto del almacén de materiales.

**Vía alternativa (paleta de comandos).** Fuera del Asesor, la paleta expone por separado
**Previsualizar inventario en el vault** y **Sincronizar inventario con el vault**
(`preview-inventory-vault-sync` / `apply-inventory-vault-sync`): el mismo `preview()`/`apply()` de
`InventoryVaultSyncService`, sin el resumen ni el modal de confirmación de arriba. La vista previa usa
el análisis que ya muestra el Asesor si sigue vigente, o hace uno. Sirve para forzar una
sincronización sin abrir la vista; el flujo recomendado para uso normal sigue siendo el botón único
del Asesor.

Cada nota representa una combinación de objeto, ubicación y personaje. Varias pilas del mismo objeto
en un personaje se suman. Un objeto presente en dos personajes conserva dos filas. Un objeto que
desaparece de esa posición no queda inactivo: su nota se envía a la papelera al sincronizar (decisión
H14.21), para que el vault converja a cero notas desactivadas en vez de acumularlas. Una nota ya
dejada como `tc_active: false` por una versión anterior del plugin también se envía a la papelera en
la siguiente sincronización. La excepción (H18.16) es una nota en la que escribiste algo tuyo: no se
borra; se reescribe inactiva (`tc_active: false`, cantidad 0, fuera de todas las vistas de la Base)
con tu texto intacto.

## Qué es tuyo en una nota

Desde H18.16 cada nota separa lo que gestiona el plugin de lo que escribes tú:

- **Gestionado:** las propiedades `tc_*` y `descripcion`, y el bloque entre la línea
  `<!-- tyrian-companion-inventory … -->` y `<!-- /tyrian-companion-inventory -->` (título,
  descripción y, en los cuatro objetos piloto, el gráfico de precios).
- **Tuyo:** cualquier otra propiedad del frontmatter (por ejemplo `tags`) y todo el texto antes de la
  línea de marca o después de la línea de cierre. Se conserva byte a byte en cada reescritura.

Si los datos no cambian, sincronizar no reescribe ninguna nota (0 escrituras). La fecha de la
cotización (`tc_price_quoted_at`) y la vigencia de un veredicto de precio (`tc_recommendation_until`
cuando no es una ventana de temporada) nacen del instante de la captura; por sí solas no cuentan como
cambio, así que en una nota sin cambios de datos indican cuándo se estableció el veredicto actual,
no cuándo se comprobó por última vez (eso lo dice el resumen de la última sincronización). Un precio,
una cantidad o una decisión nuevos sí reescriben la nota, y con ellos esas dos fechas.

## Migrar desde los scripts `gw2_*`

La integración no importa, adopta ni elimina notas creadas por scripts anteriores. Pueden convivir
mientras se comprueba el resultado nuevo.

1. Conserva el script y sus notas actuales.
2. Instala las Bases gestionadas y completa una sincronización desde el plugin.
3. Compara cantidades, personajes, banco, materiales y algunos precios representativos.
4. Vuelve a pulsar **Sincronizar inventario** sin que la cuenta haya cambiado. El plan resultante debe
   mostrar todas las filas como sin cambios y no pedir confirmación.
5. Solo después, desactiva o retira manualmente el script antiguo. No borres sus notas hasta tener la
   copia de seguridad y la comparación que necesites.

Quitar los assets gestionados no elimina las notas dinámicas de inventario. Se conservan para evitar
pérdida de datos y se pueden revisar o retirar manualmente.
