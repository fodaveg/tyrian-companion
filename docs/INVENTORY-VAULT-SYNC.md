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
   (`runInventoryVaultSync`, `src/ui/inventory-vault-sync-run-controller.ts`): captura de forma
   estable inventarios de personajes, inventario compartido, banco y materiales; aplica tus
   preferencias guardadas (objetivos y excepciones de conservar); clasifica cada posición; calcula el
   plan de sincronización con el vault; y, si el plan no desactiva ninguna fila y no está bloqueado
   por conflicto, escribe directamente. **Analizar sin escribir** (`advisor.sync.analyze`) es un botón
   distinto: solo vuelve a ejecutar la clasificación del Inventory Advisor (captura + preferencias +
   reglas) para refrescar la vista, sin tocar el vault ni calcular el plan de notas.
2. Si el plan desactivaría alguna fila que ya no aparece en la cuenta, el flujo se detiene antes de
   escribir y muestra **Confirmar cambios antes de escribir** con el recuento de filas nuevas,
   actualizadas, sin cambios, inactivas (a papelera) y en conflicto; nada se escribe hasta que pulsas
   **Confirmar y escribir**. Si el plan solo crea o actualiza filas, sin desactivar ninguna, escribe
   sin pedir confirmación.
3. Al escribir, el plugin relee todos los archivos del plan antes de aplicar. Si una nota cambió,
   pertenece a otra herramienta o usa un schema futuro, la operación falla sin sobrescribirla.
   Una nota escrita por una versión anterior del plugin, a la que le faltan columnas añadidas
   después, no cuenta como modificada: se reconoce y se reescribe con las columnas nuevas.
4. Abre `Bases/Inventory.base`. Comprueba las vistas Todos, Personajes, Compartido, Banco y
   Materiales. Filtra `Personaje` para verificar que la cantidad y el valor corresponden solo a esa
   fila.
5. Abre `Bases/Materials.base` y comprueba la vista agregada por objeto del almacén de materiales.

**Vía alternativa (paleta de comandos).** Fuera del Asesor, la paleta expone por separado
**Previsualizar inventario en el vault** y **Sincronizar inventario con el vault**
(`preview-inventory-vault-sync` / `apply-inventory-vault-sync`, `src/main.ts:1668-1688`): el mismo
`preview()`/`apply()` de `InventoryVaultSyncService`, sin el refresco de clasificación del Asesor y sin
el resumen ni el modal de confirmación de arriba. Sirve para forzar una sincronización sin abrir la
vista; el flujo recomendado para uso normal sigue siendo el botón único del Asesor.

Cada nota representa una combinación de objeto, ubicación y personaje. Varias pilas del mismo objeto
en un personaje se suman. Un objeto presente en dos personajes conserva dos filas. Un objeto que
desaparece de esa posición no queda inactivo: su nota se envía a la papelera al sincronizar (decisión
H14.21, `src/inventory/inventory-vault-sync.ts:709-713,811-815`), para que el vault converja a cero
notas desactivadas en vez de acumularlas. Una nota ya dejada como `tc_active: false` por una versión
anterior del plugin también se envía a la papelera en la siguiente sincronización.

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
