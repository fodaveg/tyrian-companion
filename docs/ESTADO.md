# Estado

## Vertical activa

**Foundation, conexión GW2, H1.4 coordinación, H3.1–H3.10 lifecycle/detección/revisión/calidad local, `storage_snapshot`, H2.4 `PublicCatalog`, H2.6 `storage_delta`, H2.7 contaminación y economía H4.1–H4.10: implementados.**

Incluye scaffold oficial, selección segura y estable por operación, ajustes versionados, conexión explícita `tokeninfo → account`, validación runtime, concurrencia latest-wins, cooldown real, estados accesibles, transporte resiliente, límites modulares, tests y CI. H1.4 aporta coordinación fail-closed de una sola sesión activa por máquina mediante lease/fence en IndexedDB dedicada. H3.1 define el lifecycle puro `idle → starting → active → stopping → provisional → complete|error`. H3.2 conecta su primer tramo a una acción explícita: un modal pide personaje y Magic Find manual, adquiere el lease, mantiene heartbeat, captura un baseline A/B/C estable y lee el build activo con la misma clave efímera; solo entonces confirma `active`. H3.3 captura el final estable, calcula H2.6 y confirma `provisional`. H3.4 conserva runtime y evidencia en IndexedDB cercada. H3.5–H3.8 conectan scheduler, detectores y armado explícito sin iniciar ni detener sesiones silenciosamente; la regla Halloween inicial usa el id oficial `36038`. H3.9 muestra una revisión de actividad real, deriva H2.7 y persiste el resultado en runtime v3. H3.10 conserva en una IndexedDB separada el modo, incertidumbre y causa de cada frontera, además de los falsos positivos corregidos con causa cerrada. La vista muestra el resumen por sesión y el estado de la medición; si el store opcional falla, los controles de sesión siguen funcionando. H4.1 añade el contrato puro: todos los importes son cobre entero, cada vía conserva fuente y liquidez, el listado no se presenta como efectivo inmediato y no líquido es `null`, no cero. H4.2 aplica la política GW2 v1 de 5% + 10% sobre la venta total, con redondeo y mínimos explícitos, y limita el mercader a metadatos válidos con `vendorValue > 0` y sin `NoSell`. H4.3 clasifica cada pila por disponibilidad, binding, catálogo y estado de precio: el bazar falla cerrado, el mercader probado queda separado y lo engastado/equipado no es realizable en su estado actual. H4.4 consulta el endpoint público oficial al cerrar, solo para los IDs ganados, y conserva bid, ask, timestamp, fuente y cobertura; un fallo de red no bloquea la sesión ni se convierte en precio cero. H4.5 produce líneas y totales reproducibles de venta inmediata, listado, mercader y no líquido, suma moneda observada y calcula sacos/h y cobre/h con aritmética segura; binding, catálogo o precio incompletos degradan cobertura en vez de inflar valor. H4.9 asigna objetivos activos sobre los pools finales `owned|available`, conserva shortfall/cobertura y deriva allowances por intención; su overlay protege cantidades ganadas sin tocar dinero, fees ni tasas H4.5. H4.10 enlaza clasificación v2 exacta/alta, review de modelo, batch fresco y plan/overlay para recomendar solo sobre unidades libres; recomputa fees por pila y usa `BigInt` para el margen. La salida es explicación pura: no hay persistencia/UI de recomendaciones, operación sobre la cuenta, escritura en el vault ni notas libres. El historial de múltiples sesiones sigue pendiente.

## Evidencia de cierre

- `npm run lint`: verde, sin errores ni avisos.
- `npm run test`: 39 ficheros y 676 tests verdes.
- `npm run build`: TypeScript y bundle de producción verdes.

## Pendientes de producto

1. Diseñar el historial durable de sesiones finalizadas y la persistencia de objetivos.
2. Especificar reglas y trazabilidad del advisor antes de implementar recomendaciones.
3. Decidir recovery avanzado ante cambio de roster o `404` entre pasadas; hoy queda como cobertura parcial.
4. Coordinar un cooldown `429` global del snapshot además de los reintentos acotados del transporte.
5. Probar la carga, conexión e IndexedDB manualmente en una bóveda de desarrollo; no forma parte de este worktree.
6. Consultar en una fase posterior el historial TP para complementar la declaración manual H3.9.
7. Hacer QA manual de H3.2–H3.4 en dos ventanas y, si Obsidian comparte el origin, dos procesos reales: doble clic, stop/retry, reload, cierre forzado, recuperación/descarte y pérdida del lease.
