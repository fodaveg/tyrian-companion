# Changelog

## Candidato sin publicar - H6.26 y H12.4

- H6.26 limita cada Refresh del Inventory Advisor a dos observaciones dentro de la misma operación y
  credencial. Solo dos capturas completas con ownership y placement equivalentes producen `stable`;
  relocation, divergencia o recuperación transitoria siguen limitadas y bloquean rutas curadas. Un
  primer `429` termina sin segunda pasada para que el cooldown compartido gobierne el reintento.
- Banco y materiales siguen siendo fuentes opcionales: su parcialidad se conserva sin descartar un
  núcleo personaje+compartido completo. El progreso cuenta lecturas reales y no inventa un total
  estable cuando el roster cambia entre observaciones.
- H12.4 convierte Companion en un HUD priorizado. Las 16 acciones se pliegan bajo un disclosure único
  por debajo de 1050 px, conservan feedback y devuelven el foco al toggle si un resize oculta la acción
  enfocada. La página ordena sesión, detección del saco `#36038`, confirmaciones, historial,
  botín/Halloween y cuenta.
- La detección presenta última consulta, resultado y próxima como datos semánticos. La única CTA
  primaria se recalcula con el estado vivo y no promueve propuestas obsoletas; Halloween permanece
  compacto salvo alerta no leída o error de store.
- Commits candidatos: `71c562a`, `3bf3250`, `cd1a0d0`, `95e9381`, `bca8a9d` y `e449df5`. Los gates
  focales y las revisiones independientes están verdes; el gate combinado se ejecuta antes del cierre.
  La QA con cuenta grande y la QA visual/teclado en Obsidian real siguen pendientes. Nada está en
  `main` ni publicado.

## Candidato sin publicar - H6.23, H6.24 y H6.25

- H6.23 corrige la divergencia live entre manifiesto v2 en la raíz anterior y cinco Bases ya
  reserializadas en la nueva carpeta de salida. La relocation exige origen owned/ready/current,
  destino completo y semánticamente exacto, sin extras, y escribe un journal durable antes del
  cambio de puntero y del cleanup; install ordinario no adopta ficheros markerless. QA con filesystem
  y vault desechable: positivo `relocated` con bytes preservados y negativo con `Human.base` ajena
  `conflict` sin una sola escritura.
- H6.24 evita que un timeout parcial de personaje dispare hasta tres fan-outs account-wide. El primer
  `timeout|network|429|5xx` parcial corta las pasadas restantes, conserva cobertura incompleta y no
  publica snapshot; el scheduler mantiene el único timer/backoff y recupera sin duplicar polling.
  `character_inventory|character_build` usan una política explícita de un intento y 30 segundos;
  el calendario ya corregido por H6.19 no cambia.
- H6.25 separa lectura, proyección y publicación del cache de loot. El TypeError histórico queda en
  un único terminal `session_projection/precondition_failed`; lectura real conserva
  `storage_failure`, otro bug de proyección usa `internal_failure` y `runtime_initialize` continúa
  con terminal success. El paquete de soporte excluye texto libre, stack, errorName, state y details.
- Commits candidatos: `446ae51` (assets), `cf0f7c0` (polling), `7732485` (atribución) y `463d367`
  (baseline combinada). El gate queda verde con lint, 167 ficheros/2.269 tests, scanner,
  observabilidad (644 fronteras, 0 pendientes), contratos y build. Nada está en `main` ni publicado.

## Candidato sin publicar - H8.8 y H7.13

- H8.8 queda reconciliada como política shadow pura y aislada: presencia de 5 s o ausencia de 60 s
  en el mapa 866 producen como máximo un DTO efímero sujeto a revisión humana. No hay composición,
  cola, persistencia, UI ni cambio del lifecycle; H8.9–H8.15 y la congelación por H8.2 permanecen.
- H7.13 incorpora un journal local opt-in, lazy y separado por vault. Toda propuesta presentada se
  reconcilia con una decisión o con `expired|superseded|invalidated`; desarmar una propuesta viva
  inicia el cierre fail-open sin retrasar producto, mientras una propuesta nunca mostrada no crea
  fila. Recoveries sin clasificación permanecen visibles y hacen el resultado inconcluso.
- La agregación publica por plataforma y estratos recuentos, cobertura, Wilson 95 %, precisión,
  recoveries, sesiones y `pass|fail|inconclusive`. La revisión de pérdidas silenciosas queda ligada
  al entorno y a `sampleRevision`: cada mutación real la incrementa e invalida la revisión en la
  misma transacción; una carrera devuelve `stale` y no certifica evidencia no vista.
- La revisión final detectó y `82c0b94` cerró cuatro fallos: el modal instrumental ya no puede
  cancelar aceptar/iniciar/parar; un primer `accepted_workflow_failed` queda sellado ante reintentos
  o exclusiones posteriores; la clasificación de recovery se rehidrata y bloquea contradicciones
  tras recargar; estadísticas y export rechazan revisiones legacy o de otra revisión de muestra.
- La revisión de seguridad detectó un ABA al desactivar y reactivar el mismo perfil. `686194b`
  conserva únicamente un contador generacional no personal, lo avanza durante el borrado y prueba
  que una revisión anterior nunca vuelva a ser válida sobre evidencia nueva.
- La rerevisión detectó que un cambio concurrente de perfil comparaba antes el entorno y degradaba
  un store sano. `4902bf5` prioriza la revisión transaccional: una muestra anterior devuelve `stale`;
  solo una discrepancia de entorno dentro de la revisión vigente es `inconsistent`.
- El último control de seguridad encontró que perfil corrupto y revisión cambiada podían ocultar
  temporalmente la corrupción como `stale`. `f64a06c` valida primero la forma presente, falla
  cerrado y mantiene la carrera legítima de perfil como `stale`.
- Ajustes añade perfil ES/EN, preview, revisión, cuatro exports JSON/CSV deterministas create-only,
  clear de muestra+revisión y disable del journal completo. No hay Sync propio ni telemetría remota;
  los exports del Vault sobreviven a clear/disable y pueden entrar en Obsidian Sync. Los hashes de
  propuestas son seudónimos, no anonimización.
- Los commits candidatos son `25a1057` para la reconciliación H8.8 y `e267ae4`, `ab321a9`,
  `c2981ba`, `388dc86`, `8c7f343`, `221862a`, `82c0b94`, `ba77b95`, `686194b`, `e765b5c`,
  `4902bf5`, `f64a06c` y `e70fb66` para H7.13. Los hallazgos contractuales, de seguridad y de
  revisión independiente quedan cubiertos; 108 tests focales y el gate completo quedan verdes con
  lint, 167 ficheros/2.250 tests, scanner, observabilidad, contratos y build. El dry run real en
  las tres plataformas, QA visual/IndexedDB y la muestra H7.7 siguen pendientes; nada de este lote
  está en `main` ni publicado.

## Reconciliación candidata - H6.19 y H6.20

- Ambos hallazgos de QA real estaban corregidos en producción desde `6c6e2cd`, incluido ya en las
  releases `0.1.16` y `0.1.17`; este lote documenta la causa y añade cobertura, sin cambiar de nuevo
  el comportamiento productivo.
- H6.19 no era un doble calendario de detección. Los deadlines observados pertenecían al histórico
  de precios y a detección, pero el primero heredaba erróneamente la identidad `detection_poll`.
  Ahora se distinguen como `price_history_poll` y `detection_poll`; `40d1678` añade una regresión con
  reloj falso que cruza ambos deadlines y exige una ejecución y un timer por consumidor.
- H6.20 reserva `session_start` al gesto humano y etiqueta la persistencia periódica de autoridad
  como `session_lease`, con el saneado positivo habitual y sin datos del lease o de la sesión. La
  sesión live de veinte minutos continúa como aceptación manual no ejecutada desde el repositorio.
- El gate combinado del candidato queda verde con lint, 162 ficheros y 2.178 tests, seguridad,
  observabilidad, contratos de release/beta/soporte y build.

## Candidato sin publicar - H9.7 y H6.21

- H9.7 añade a Companion un panel ES/EN de historial durable. Abrir o repintar la vista no lee el
  vault: el escaneo completo solo parte de **Cargar historial**, coalesce dobles activaciones y
  conserva en memoria los estados `idle`, `loading`, `empty`, `ready`, `conflict` y `unavailable`.
- La agregación elimina referencias de cuenta y sesión, ordena las sesiones finalizadas, compara las
  dos más recientes y presenta tabla o tarjetas responsive. Totales y diferencias desconocidos
  permanecen `null`; una nota inválida o duplicada bloquea toda la presentación sin modificar notas.
- H6.21 incorpora copy accionable ES/EN para los ocho motivos de fallo de inicio y los seis de
  cierre. Los mapas tipados son exhaustivos y el mensaje/cooldown de conexión conserva su circuito
  independiente.
- Los dos commits están combinados únicamente en `codex/parallel-integration`: no se han integrado
  en `main`, publicado ni desplegado. La revisión independiente hizo corregir el orden por cierre y
  la pérdida de segundos en duraciones/deltas subminuto. El gate combinado final queda verde con
  lint, 162 ficheros y 2.178 tests, seguridad, observabilidad, contratos de release/beta/soporte y
  build. La QA visual de H9.7 y H6.21 y la comprobación de un `429` real dentro de Obsidian siguen
  pendientes.

## Release beta 0.1.17 - Hotfix de inicialización

- Publicada el 2026-08-30 la
  [GitHub Release `0.1.17`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.17) desde el
  tag y commit `214362e2e7bc037befdaf81ac7a201ce9aaab37c`.
- Corregido el bloqueo del runtime diferido al restaurar una sesión completada persistida: la
  dependencia usada para reconstruir su presentación se compone ahora antes de refrescarla.
- Añadido un guardarraíl ejecutable que persiste una sesión terminal y exige que la inicialización
  alcance el estado listo. El caso reproducía el fallo en rojo antes del fix y queda verde junto al
  control sin sesión persistida; los datos del log local permanecen redactados.
- Los runs de CI de `main` `33311829149` y del tag `33311981029` terminaron en verde.
- La release contiene exactamente `manifest.json`, `main.js`, `styles.css`,
  `tyrian-companion-0.1.17.zip` y `tyrian-companion-0.1.17.zip.sha256`. El ZIP reproducible tiene
  SHA-256 `dd06a408b771d9fc4b2bb76ff34d31740ea099d0accb24ac20e3cc4976f99386`.
- El canal BRAT está publicado. La actualización efectiva y la restauración de una sesión completada
  dentro de Obsidian siguen pendientes de QA humana.

## Release beta 0.1.16 - H12 y canal BRAT

- Publicada el 2026-08-30 la
  [GitHub Release `0.1.16`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.16) desde el
  tag y commit `18312cd00888851ca382fe4f185bb1d53d4f5cc2`.
- H12.1 incorpora el panel visible con paridad completa para las 16 acciones de paleta. H12.2 publica
  la auditoría y el mockup navegable de Sesión, Inventario y Ajustes como dirección pendiente de QA
  visual dentro de Obsidian.
- Los runs de CI de `main` `33305605914` y del tag `33305740475` terminaron en verde.
- La release contiene exactamente `manifest.json`, `main.js`, `styles.css`,
  `tyrian-companion-0.1.16.zip` y `tyrian-companion-0.1.16.zip.sha256`. El ZIP reproducible tiene
  SHA-256 `b0c2efc7861b01ebb2d5f6d280095e21d6a92952be56a3fbf72defd8ccdf293c`.
- El canal BRAT está publicado. La instalación o actualización efectiva en Obsidian, la QA visual
  con sus temas y la comprobación con datos reales de Guild Wars 2 siguen pendientes de QA humana.

## H12.2 - Auditoría y dirección UI/UX del plugin

- Censadas las tres superficies principales —Sesión, Inventario y Ajustes—, el panel común de 16
  acciones y los nueve modales/confirmaciones existentes. La propuesta conserva los contratos
  funcionales actuales y corrige la composición, la jerarquía y el feedback antes de tocar
  producción.
- Companion separa sesión, detección, inventario general, Halloween y cuenta. La detección deja de
  presentarse como una capacidad general: el ruleset actual observa específicamente la Bolsa de
  truco o trato `#36038`, mientras el Advisor se actualiza mediante una acción manual distinta y el
  histórico de precios mantiene su propio intervalo.
- La señal asistida muestra el triplete temporal completo —última comprobación, resultado y
  próxima—, incluido el caso normal «consulta correcta, sin señal». El botín de otros objetos solo
  aparece tras la frontera final y la revisión; Halloween queda como módulo opcional y no como
  identidad de toda la página.
- Inventario organiza actualización, análisis, filtros, preferencias e histórico como tareas
  diferenciadas. Ajustes usa navegación local entre cuatro categorías y separa mantenimiento
  destructivo de la configuración ordinaria.
- El sistema compartido documenta tokens, piezas, estados, feedback y responsive por componente.
  El mockup navegable cubre siete escenarios reales, claro/oscuro, 16 acciones, las cuatro
  categorías de Ajustes y anchos desde 390 hasta 1.440 px; en móvil el panel de acciones se pliega
  sin perder ninguna operación.
- La QA standalone midió targets de 44 px y contraste: texto secundario claro 5,09:1, estados claros
  al menos 6,25:1 y texto secundario oscuro 7,82:1. Las capturas Firefox validaron escritorio,
  tablet y móvil. La auditoría y el mockup están publicados en `0.1.16`; su aprobación visual dentro
  de temas reales de Obsidian y la implementación completa de esa dirección siguen pendientes.

## H6.17 - Diagnóstico local exhaustivo

- Añadido logging JSONL local, append-only y fail-open bajo el directorio de configuración del
  plugin. La rotación conserva como máximo cinco shards de 2 MiB y recupera de forma acotada una
  cola truncada y la secuencia monotónica después de reiniciar.
- El contrato cerrado registra versión, UTC, secuencia, nivel, componente, acción, fase, código,
  `actionId/correlationId`, duración, intento y estado técnico. Errores conservan nombre, mensaje y
  stack saneados; HTTP usa solo endpoint lógico, status y `Retry-After`.
- Un serializador positivo por componente elimina secretos, auth/cookies, URL raw, cuerpos,
  payloads, identidades y rutas. Canarios hostiles cubren credenciales, errores anidados, getters,
  ciclos, `BigInt` y valores enormes; copy/export vuelve a sanear cada línea.
- Settings v11 activa `debug` por defecto durante la beta interna. Ajustes muestra salud, ruta,
  tamaño, shards, último evento y descartes, y permite abrir, copiar, exportar fuera de la rotación y
  limpiar con confirmación. Companion enlaza a Ajustes cuando el writer se degrada.
- Lifecycle, settings, comandos/UI, GW2/HTTP/reintentos, sesiones, detección, Asesor, histórico de
  precios, Halloween, assets, persistencia, avisos y errores globales usan spans o puertos cerrados.
  La isla H8/Mumble conserva sus diagnósticos contractuales propios y sigue sin composición, raw log
  ni retención en el plugin.
- Un censo AST exacto mantiene un inventario de `catch`, `.catch`, `void` y callbacks registrados.
  Cada ocurrencia conserva clasificación y motivo; cambios, ficheros nuevos o un baseline mutilado
  fallan en pruebas de sabotaje.
- El gate final cubre 155 suites y 2.106 tests, los contratos de seguridad/release y el build. El
  benchmark H6 queda dentro de presupuesto y su control negativo determinista vuelve rojo.
- La QA real en Obsidian y la reproducción live de un fallo antes silencioso siguen siendo una
  aceptación manual separada; no se acreditan solo con tests de repositorio.

## H9.16/H9.3 - Comparación manual de reciclaje de equipo

- H9.16 añade al Asesor una comparación source-backed para equipo Rare de nivel 68 o superior. La
  EV es un límite inferior basado solo en 0,9 ectoplasmas esperados por objeto; materiales base,
  suerte y mejoras recuperadas quedan excluidos de forma visible, no valorados a cero.
- La venta inmediata del ectoplasma consume la profundidad real de pujas y falla cerrado si no cubre
  toda la salida esperada. El anuncio usa el ask actual como referencia, sin tratarlo como demanda ni
  garantizar ejecución. La mejor alternativa del objeto conserva venta inmediata, anuncio y mercader
  con sus comisiones reales.
- H9.3 sube los ajustes a schema v10. Permite elegir kit, estrategia de venta y, opcionalmente, segundos
  por objeto y coste de oportunidad por hora. Sin kit se declara el coste conservador del kit de
  maestro; sin estrategia se usa la menor cotización neta disponible. El tiempo entra solo cuando
  ambos campos están presentes; si falta uno, queda excluido y la UI muestra la limitación.
- Exotic de nivel 68 o superior permanece en revisión porque la política no inventa una tasa de
  resultados. `NoSalvage`, snapshot no estable, catálogo o precios incompletos, política inválida o
  stale, y profundidad parcial bloquean la recomendación. El kit místico queda en revisión porque su
  coste no incluye las Piedras de la Forja Mística.
- La política v1 compilada conserva las fuentes codificadas de la API oficial para el ectoplasma y
  revisiones fijadas de GW2 Wiki para resultados y kits. Su SHA-256 forma parte del contrato;
  `salvageProof` liga objeto, snapshot de catálogo, política y regla en reporte y envelope.
- Las acciones siguen siendo manuales, sin executor ni operación de reciclaje. Implementado y
  aprobado mediante `1d04b61`, `bc1d8ed` y `b4b79ba`; todavía no está integrado en `main`, no forma
  parte de `0.1.13` ni acredita QA visual o ejecución dentro de Obsidian.

## H9.6/H9.15 - Decisiones sobre clan y cambio oro-gemas

- H9.6 descarta el benchmarking de clan en el producto actual. Requeriría intercambio de datos o un
  backend compartido y, con ello, reabrir privacidad y RGPD.
- Solo podrá reconsiderarse como iniciativa separada y opt-in, con agregación local previa, cohorte
  mínima y sin claves API, account IDs ni identificadores persistentes.
- H9.15 descarta una feature independiente de cambio oro-gemas. Aunque
  `/v2/commerce/exchange/coins` y `/v2/commerce/exchange/gems` son públicos, una cotización aislada
  no permite recomendar bolsa frente a banco.
- Únicamente `/v2/commerce/exchange/coins` podrá reconsiderarse dentro de un futuro planificador
  explícito de capacidad, con cotización temporal, acción humana y sin persistencia.

## H9.2 - Profundidad real del bazar en el Asesor

- Cada Refresh explícito consulta la API oficial pública `/v2/commerce/listings`, sin clave, para los
  ids positivos ya incluidos en la valoración. Deduplica y ordena ids, usa lotes secuenciales de hasta
  200 y comparte el enfriamiento global ante `429`.
- El contrato conserva cobertura por objeto y falla cerrado ante niveles duplicados, desordenados o
  corruptos. La venta instantánea recorre las pujas reales de mejor a peor y solo valora la cantidad
  cubierta; la profundidad disponible se consume una única vez por objeto agregado.
- Publicar valora la pila completa al mejor precio vendedor observado. La cantidad de anuncios en ese
  nivel no se interpreta como demanda, capacidad de ejecución ni promesa de venta futura.
- La presentación ES/EN distingue profundidad completa, parcial, sin mercado y error, con cantidad
  cubierta, cantidad sin cubrir y neto demostrado. Si la captura falta o es incompleta, conserva el
  fallback anterior de `/v2/commerce/prices`, pero fuerza el resultado público a `limited`.
- El helper común de fronteras sustituye el parser por regex por el AST de TypeScript. Cubre imports y
  exports estáticos, imports laterales, `import = require`, tipos `import()`, `import()` dinámico y
  `require()` literales; no pretende resolver specifiers computados u ofuscados. La regresión se
  verificó con sabotaje rojo y restauración verde.
- Integrado en `main` mediante `8569139`, `2234d5f`, `8c280bb`, `e743405` y `f28e063`. La revisión
  final no encontró hallazgos y el gate completo quedó verde con 151 ficheros y 2.015 tests, además
  de seguridad, contratos, build y paquete. No forma parte de `0.1.13` ni acredita llamadas live, QA
  visual o ejecución en Obsidian.

## H9.17/H9.18 - Capacidad y depósito manual de materiales

- H9.17 sube los ajustes a schema v9 y añade una capacidad global opcional por material entre 250 y
  3.000, en pasos de 250. `null` usa el mínimo garantizado de 250 y la UI distingue la procedencia
  `minimum_guaranteed` de una capacidad `configured`.
- H9.18 añade `deposit_material` como recomendación manual sin efectos laterales. Solo usa posiciones
  `loose` de personaje o inventario compartido después de proteger reservas y excepciones.
- La ruta exige snapshot estable, materiales completos, pertenencia inequívoca a una categoría y
  catálogo completo y fresco. Capacidad llena, cobertura parcial, dato stale o membresía ambigua no
  producen recomendación.
- Clasificador, reporte, envelope y guards validan en conjunto que la suma de depósitos de cada
  objeto no supere `capacity - stored`; no existe executor ni operación sobre la cuenta.
- Integrado en `main` mediante `d86c526`, `88d2322` y `eb54e02`. La revisión final no encontró
  hallazgos y el gate completo quedó verde con 149 ficheros y 1.999 tests, además de seguridad,
  contratos, build y paquete. No forma parte de `0.1.13` ni acredita QA visual o ejecución en
  Obsidian.

## H9.8/H9.14 - Evidencia personal del bazar

- H9.14 captura las órdenes actuales de compra y venta durante el Refresh explícito del Asesor y las
  agrega por lado y objeto sin conservar IDs de transacción. Una compra activa suprime solo la acción
  coincidente de vender al instante y una venta activa suprime solo la acción de publicar.
- La supresión exige cobertura `complete` del endpoint correspondiente. Permiso ausente, restricción
  de URL, respuesta parcial o captura no disponible son neutrales y no eliminan recomendaciones.
- H9.8 consulta compras y ventas completadas dentro de la ventana exacta de la sesión, acotada a 90
  días. La evidencia completa prepara una propuesta en el modal de revisión; aplicarla, ignorarla y
  editar las respuestas siguen bajo confirmación humana.
- Los IDs crudos de transacción no salen de la captura, el historial no se persiste y ninguna ruta
  opera sobre el bazar. La evidencia ausente, parcial o inválida no infiere contaminación.
- Integrado en `main` mediante `3e84514`, `ed7f8b8` y el fix `f825621`. La revisión final no encontró
  hallazgos y el gate completo quedó verde con 149 ficheros y 1.988 tests, además de seguridad,
  contratos, build y paquete. No forma parte de `0.1.13` ni acredita QA visual o llamadas reales a
  la API desde Obsidian.

## H9.10-H9.13 - Prioridades visibles del inventario

- H9.10 distingue peso muerto retenido y posiciones pendientes sin clasificar, conserva la
  procedencia de cada hueco ocupado y ordena primero por espacio liberable agregado por objeto y
  después por valor demostrado.
- H9.11 muestra qué porcentaje del valor conocido visible representa cada fila y su porcentaje
  acumulado, con cálculo determinista y fallo cerrado ante sumas fuera del rango seguro.
- H9.12 detalla las reservas por objetivo y las excepciones para conservar con cantidad, motivo, base
  y destino previsto; esas posiciones protegidas no se presentan como carga liberable.
- H9.13 compara el neto de vender al instante con el neto de publicar, incluida su diferencia en
  cobre y porcentaje. Consume una sola vez la profundidad finita de las pujas y deja como no
  disponible cualquier contraparte no demostrada.
- Tabla y tarjetas muestran el nuevo contexto en ES/EN y conservan la procedencia al filtrar por
  ubicación. Integrado en `main` mediante `06919f4` y `762d67f`; la revisión final no encontró
  hallazgos y el gate completo quedó verde con 147 ficheros y 1.968 tests, además de seguridad,
  contratos, build y paquete. No forma parte de `0.1.13` ni acredita QA visual o instalación en
  Obsidian.

## Release beta 0.1.13

- Publicada el 2026-08-29 la
  [GitHub Release `0.1.13`](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.13) desde el
  tag y commit `1fe6c4ca2e0b0713f7c71e27a6f24c8f425fa42a`.
- BRAT dispone de `manifest.json`, `main.js` y `styles.css` como assets individuales. El ZIP
  reproducible tiene SHA-256
  `133cb03e5b8bbcd694065360fce37620bf1bc8cfa208d69908d5c73e864ba9f2`.
- La publicación hace instalable la beta, pero no acredita todavía instalación, actualización, QA
  visual ni entrega real de avisos en Obsidian.

## H11.6 - Valoración personal de resultados no líquidos de Halloween

- Añadido un overlay manual separado del modelo y de sus hashes para valorar en cobre los diez
  resultados explícitos no líquidos de la bolsa de Halloween. El cero es un valor conocido; una fila
  vacía sigue siendo ausencia de valoración.
- La resolución usa `BigInt`, distingue cobertura `none`, `partial` y `complete`, y falla cerrada ante
  claves desconocidas o no elegibles, duplicados, campos extra y desbordamientos. El EV y la decisión
  líquidos no cambian; una cobertura parcial solo presenta el límite inferior conocido y la decisión
  personal requiere los diez valores.
- Ajustes sube a schema v8 con migración cerrada, orden canónico, valores por defecto aislados y un
  editor ES/EN para guardar o retirar cada valor. La escritura durable precede a la publicación del
  nuevo overlay en memoria, por lo que un fallo de `saveData` conserva el último estado persistido.
- Guardar intenta reclasificar la captura fresca del Asesor en memoria y sin red. El editor diferencia
  `reclassified` de `next_refresh`, conserva el feedback por fila y restaura el foco después de cada
  operación.
- Integrado en `main` y `origin/main` mediante `17da38f`, con revisión independiente sin hallazgos y
  `npm run check` verde con 147 ficheros y 1.961 tests, además de seguridad, contratos y build. No se
  afirman valores introducidos por David, QA visual, publicación, release ni instalación.

## H11-B - Comparación de botín y aviso de precio de Halloween

- H11.3 solo conserva una comparación desde un delta `session_final` cuya revisión terminó como
  `finalized`. Corregido el caso en que `reviewed`, una revisión guardada pero no finalizada, podía
  sellar el episodio como final.
- La elegibilidad exige sesión Halloween, delta comparable, certeza confirmada, `open=true`, todas las
  demás actividades falsas y descenso neto del item `36038`. La UI dice **bolsas desaparecidas netas**
  porque el cambio de inventario no demuestra aperturas.
- Cada comparación persiste atómicamente los 18 outcomes del modelo, incluidos los ceros. La criba
  reproducible usa `BigInt` y exige `n>=1100`, `E>=20`, diferencia mínima del 10% y `|z|>=3,45`.
  `modelId` y `modelVersion` resuelven un registry histórico; legacy conserva su interpretación y una
  versión desconocida falla cerrada.
- El panel diferencia todavía no finalizada, ignorada con razón, recopilando, muestra suficiente sin
  desviación, desviación y fallo de almacenamiento, y presenta los 18 resultados.
- H11.5 usa la puja actual del item `36038` y el p90 nearest-rank, posición 27, de los 30 días UTC
  completos inmediatamente anteriores. Cualquier hueco, puja nula, captura futura, dato inválido o
  cierre actual ausente produce `insufficient_history`.
- El anti-spam durable y multiwindow solo emite en un cruce `below→high`, como máximo una vez por día
  UTC y tras el cooldown. Solo un `below` válido rearma; `lastValidCapturedAtMs` hace monotónica la
  decisión y evita que una evaluación antigua pise otra más nueva. Apagar H9.1 deja el runtime
  `disabled` y cerca activaciones y callbacks anteriores para que no reabran el store ni emitan.
- Ajustes sube a schema v7 con el aviso desactivado, margen mínimo configurable y cooldown
  6/12/24/48 h. El panel comparte bandeja y reconocimiento de Halloween; `Notice` pertenece al
  adaptador foreground.
- Candidato `5ce118b` de `codex/h11b-comparison-price-alerts` apto tras revisión independiente y
  `npm run check` verde con 144 ficheros y 1.912 tests, incluidas seguridad, paquete, contratos y
  build. H11.3 necesita acumular 1.100 bolsas netas y H11.5 necesita 30 cierres UTC completos. Quedan
  pendientes la QA visual y de contraste y la entrega live de `Notice` en Obsidian; no se afirma
  publicación, release ni instalación.

## H11-A - Alertas de Halloween, lista empírica y catálogo de desbloqueos

- Añadido un runtime opt-in que acepta solo deltas positivos de sesiones Halloween y clasifica
  alertas por umbral de valor, rareza, primera observación y desbloqueo de skin o mini. Rare+ solo
  alerta con ausencia de cotización demostrada o vinculación. El inbox/outbox deduplica cada objeto
  dentro del episodio; el polling puede emitir avisos provisionales y el cierre los reconcilia con el
  delta final, sustituyéndolos por una alerta final o eliminándolos cuando ya no aplica ninguna señal.
- La lista empírica se aprende de forma incremental y canónica. El backfill se ejecuta antes del vivo
  sobre notas Halloween válidas: schema v3 aporta deltas exactos; v1 no tiene `tc_event` y no se usa
  para `seen`; v2 sin deltas exactos queda `partial` y no habilita `first_seen`.
- El catálogo normalizado v3 conserva `details.skins[]` y transforma el `minipet_id` de la API cruda
  en `details.minipetId`. La señal de unlock exige cobertura completa de skins o minis y distingue
  una skin aplicable de una ya desbloqueada.
- Ajustes sube a schema v6 con Halloween desactivado, umbral configurable y lectura autenticada de
  unlocks opcional. La IndexedDB dedicada falla cerrada y separa vault y cuenta; tanto `seen` como el
  inbox son locales al dispositivo y no se sincronizan entre instalaciones.
- Si H9.1 está activo, el bridge incorpora al watch los ids positivos observados y los del backfill
  reciente, sin activar el histórico de precios automáticamente.
- Candidato `c867488` apto tras revisión independiente y `npm run check` verde con 138 ficheros y
  1.877 tests, incluidas seguridad, paquete, contratos y build. Quedan sin verificar el aspecto en
  temas reales de Obsidian, la entrega real de `Notice` y las llamadas live a la API; no se afirma
  publicación, release ni instalación.

## H9.1 - Histórico local de precios

- Añadido muestreo opt-in de la API oficial pública `/v2/commerce/prices`, sin clave ni dependencia
  de GW2Efficiency. Las peticiones se agrupan de forma secuencial en lotes de hasta 200 ids y
  comparten el enfriamiento global ante `429`.
- Una IndexedDB dedicada conserva snapshots compactos por slot y agregados diarios UTC por objeto.
  La compactación ocurre antes de la poda, es idempotente y limita el trabajo incremental; las
  retenciones raw y diarias son configurables y ampliar una retención no reconstruye datos podados.
- Los percentiles se calculan de forma reproducible sobre cierres UTC observados, sin inventar días
  ausentes. Antes de 42 días la serie informa historial insuficiente.
- El panel del Asesor de inventario permite cargar la serie local, seleccionar compra o venta y elegir
  una ventana de 42, 90 o 180 días. La construcción del runtime y el render desactivado no abren
  IndexedDB ni consultan la red.
- Candidato `982d5f7` listo para integrar tras revisión independiente y `npm run check` verde con 130
  ficheros y 1.804 tests, incluidas las suites de seguridad, paquete y contratos, además del build. El
  repo no tiene harness Playwright/e2e; quedan pendientes de QA manual el contraste en temas reales
  de Obsidian y la coordinación multiwindow sobre IndexedDB real.

## H10 - Asesor de inventario más claro y seguro

- **Analizar sin escribir** vuelve a estar disponible junto a la acción principal: actualiza las
  recomendaciones sin modificar ninguna nota del vault y evita reentradas mientras trabaja.
- El flujo automático diferencia los fallos de captura de los de escritura, rechaza un segundo plan
  distinto mientras existe otro en curso y vuelve a comprobar que la operación siga habilitada justo
  antes de escribir y de guardar la última ejecución.
- La tabla muestra menos contabilidad interna: combina lo poseído y lo disponible, elimina el número
  de pilas y traduce la cobertura incompleta a estados comprensibles. El desglose técnico queda en el
  modo avanzado.
- El panel de sincronización vive en su propio módulo y toda la vista usa el mismo formateador de
  dinero.
- Integrado en `main` y `origin/main` mediante `21285d1`, sin afirmar publicación ni instalación. La
  revisión independiente y el gate base quedaron verdes con 124 suites y 1.742 tests. El repo no tiene
  harness Playwright/e2e; la QA manual de H10.4 y H10.7 y la medición de contraste AA en temas reales
  siguen pendientes.

## Bundle gestionado v5

- `Inventory.base` y `Materials.base` registran los nombres visibles de campos de frontmatter con
  claves `properties.note.tc_*`, tal como las serializa Obsidian 1.13.7. Las claves `formula.*` se
  conservan y filtros, orden y sort siguen usando los campos `tc_*` originales.
- Ambos assets suben a contentVersion 2. Un manifiesto bundle v4 intacto los clasifica como `update`
  y el upgrade termina en bundle v5 sin reemplazar otros Bases sin cambios.

## Inventario durable y Bases gestionadas

- Añadido un flujo explícito Preview/Apply dentro del Inventory Advisor. Abrir la vista permanece
  inerte; Preview captura inventarios de personajes, compartido, banco y materiales, catálogo y
  precios; Apply solo ejecuta el plan retenido tras releer el vault.
- Cada nota representa un objeto, una ubicación y, cuando aplica, un personaje. Las pilas del mismo
  personaje se agregan; el valor usa el bid unitario por la cantidad de esa fila. Filenames opacos y
  portables no contienen cuenta ni personaje.
- El writer Vault-only verifica marker/schema/hash y falla cerrado ante archivos ajenos, modificados,
  duplicados o futuros. Las posiciones stale pasan a inactivas con cantidad cero, nunca se borran.
- Bundle gestionado v4 con `Inventory.base` y `Materials.base` ES/EN. Las vistas Todos, Personajes,
  Compartido, Banco y Materiales filtran claves estables y ordenan por valor numérico.
- Añadida guía de activación y migración. Los scripts y notas `gw2_*` no se importan, adoptan ni
  eliminan automáticamente.

## H8.2 — QA humana del spike ejecutada en Linux/Steam/Proton

- Ejecutado por primera vez el PE del spike durante una sesión real de Guild Wars 2 (2026-08-19).
  Host Fedora Linux 44, `mingw64-gcc` 16.1.1, `protontricks` 1.14.0 y prefijo `compatdata/1284210`
  sobre GE-Proton11-5. El binario se compiló y se lanzó desde `/tmp`, fuera del prefijo, sin instalar
  ni copiar nada dentro de él.
- Veinte muestras en dos tandas devolvieron una sola línea JSON con `sequence:0` y
  `activity:"link_advancing"`, cada una con nonce distinto y devuelto intacto, y `uiTick`
  estrictamente creciente sin ninguna pareja de lecturas idéntica.
- `mapId` siguió el cambio de zona (`1442`→`1595`, Seitung Province y Shipwreck Strand contra la API
  pública) y el `uiTick` se reinició de 16.962 a 572 al reabrir el juego, atando la señal al proceso
  vivo. Ningún frame trajo identidad, personaje, coordenadas, PID ni contexto crudo.
- Control negativo cerrado: con el juego cerrado, diez ejecuciones no emitieron frame y una corrida
  con stderr y código de salida visibles devolvió `exit=2` (`TC_MUMBLE_PROBE_VIEW_TOO_SMALL`, el
  retorno cuando `OpenFileMappingW` da `NULL`), con el loader de wine iniciado en esa misma salida.
  El mismo PE lanzado sin argumentos devolvió `exit=1` (`TC_MUMBLE_PROBE_INVALID_ARGUMENT`), lo que
  demuestra que `protontricks-launch` propaga el código del PE y que el `2` no es del lanzador.
- macOS/CrossOver, Windows nativo y Proton estable siguen sin ejecución de PE. La señal permanece
  shadow, la API continúa autoritativa y no se ha tocado `src/`, el allowlist del scanner ni el
  paquete de release.

## H6.16 — Guardarraíles léxicos de advisor/economy sustituidos por tests de comportamiento

- Cuatro suites de test de `src/advisor/` y `src/economy/` leían el texto fuente con expresiones
  regulares en vez de ejecutar el código: una regex que busca una palabra se rompe con su propio
  comentario y nunca llega a afirmar la propiedad. Cada aserción se clasificó y se convirtió en
  test de comportamiento, se descartó por redundante o se conservó cuando era genuinamente
  estructural (fronteras de import, censos de módulo, allowlists de llamadas por puerto,
  operaciones irreversibles y declaraciones de capacidad, ninguna observable en runtime).
- Convertidas, cada una probada rompiendo producción y viendo el test nuevo ponerse rojo: la
  ausencia de capacidades ambiente (`fetch`, timers, storage, globals del plugin) se afirma ahora
  ejecutando presentación, view model, controller, renderer, `ItemView`, workflow y preferencias
  bajo globals atrapados; los campos de entrada que portan capacidad se rechazan por los
  validadores reales; `open()`/`current()` se mantienen memory-only con cada puerto cableado y
  contado; las explicaciones se indexan una sola vez, contando lecturas reales, no un substring
  del fuente.
- Añadidos `src/test/module-boundary.ts` y `src/test/ambient-capabilities.ts`. Los ficheros de
  test bajaron de 430 a 374 líneas; el recuento de tests de este árbol subió de 1.544 a 1.553.
- Hallazgo: en el sabotaje S14 (meter `this.ports.invalidate?.()` dentro de `current()` del
  controller del Inventory Advisor), la regex conservada no se puso roja y el test de
  comportamiento nuevo sí. Es la prueba de que los guardarraíles léxicos declaraban más cobertura
  de la que tenían.

## H6.13 — Recuperación de sesión cuando un personaje devuelve 404 entre pasadas

- El diagnóstico inicial era falso, y el fallo real era el contrario y más grave: un personaje que
  devolvía `404` entre la pasada base y la de cierre clasificaba el resultado como `invalid` y
  perdía el delta entero de la cuenta, justo lo que el criterio de cierre de H6.13 prohíbe.
  `src/sessions/manual-session-start-service.ts` exigía además una referencia de snapshot estable
  antes de calcular el delta, el 404 la marcaba `partial`, y `stop()` fallaba dejando la sesión
  colgada en `stopping`.
- `src/account/storage-snapshot-pure.ts`: una pasada cuyo único hueco es `missing_character` deja
  de descalificarse, porque ningún reintento llena un 404.
- `src/account/storage-delta.ts`: el personaje ilegible se excluye de las dos proyecciones y el
  delta pasa a `limited` con el aviso nuevo `character_unobserved`, en vez de invalidarse.
- `src/account/contamination.ts`: ese aviso degrada la clasificación a `estimated`, no a
  `contaminated`. `src/core/i18n-runtime-catalog.ts` añade el motivo en ES y EN.
- Tres sabotajes con su test en rojo nombrado, restaurados y verificados por hash.
- Decisión de producto asumida: solo el 404 (`missing_character`) es excusable; un 500
  (`unavailable`) sigue invalidando el delta entero, con test que lo fija. Pendiente de ratificar
  por David si entra en el gate de v1 (H7.8) o se aparta a post-MVP.

## H8.2 — Paso 1 de 2 cerrado: el PE del spike compila y su import census es limpio

- Instalado `zig` 0.16.0 por Homebrew (arrastra `llvm@21` y `lld@21`, ~1,8 GB; se quita con
  `brew uninstall zig llvm@21 lld@21`), usado como driver de C con `-target x86_64-windows-gnu`.
- El PE compila a la primera con `-Werror` sin warnings: `PE32+ executable (console) x86-64`,
  58.880 bytes, reproducible (dos builds, mismo SHA-256
  `4de947c08c2ef31cd3fcd9430dda693852e1a53a25bdf788c4799110b4a898cc`).
- Censo de la tabla de importación con `llvm-readobj --coff-imports`: de `KERNEL32` solo entran
  `OpenFileMappingW`, `MapViewOfFile`, `UnmapViewOfFile` y `CloseHandle` para el trabajo del
  probe, más arranque del runtime de C. Ni `OpenProcess`, ni `ReadProcessMemory`, ni Toolhelp, ni
  `CreateFileW`, ni registro, ni sockets, ni input.
- El binario vive en `/tmp/tyrian-h8-probe/tyrian-mumble-probe.exe`, fuera del repo a propósito:
  `scripts/h8-native-decision-contract.mjs` rechaza cualquier `.exe` commiteado.
- Fallo encontrado y corregido: el comando de QA del README pasaba una ruta Unix a `--cx-app`; el
  wrapper `wine` de CrossOver solo reenvía valores que empiezan por letra de unidad y el resto los
  busca dentro del `drive_c` de la botella. Ahora usa
  `Z:\tmp\tyrian-h8-probe\tyrian-mumble-probe.exe`, que llega al mismo fichero sin copiar nada en
  la botella.
- No se lanzó CrossOver ni GW2 ni se modificó la botella. Paso 2 de 2, pendiente y exclusivamente
  humano: con GW2 corriendo en la botella, ejecutar el comando corregido y demostrar lectura
  estable de `mapId`, incluido el mapa 866 del Laberinto, en transiciones y tras reiniciar la
  botella.

## H6.12 — Un solo enfriamiento 429 para todas las capturas

- El transporte ya reintentaba un 429 por petición, pero no había estado compartido: un rate limit
  visto por la detección asistida no frenaba la captura de sesión ni el Refresh del Inventory
  Advisor, así que con la detección armada durante una sesión real el límite reaparecía en la
  pasada siguiente y cada consumidor lo descubría por su cuenta.
- `src/core/rate-limit-coordinator.ts` es una clase pura con reloj inyectado: registra el 429 con su
  `Retry-After`, usa un respaldo acotado de 60 s cuando falta la cabecera y nunca acorta un
  enfriamiento ya activo. `src/account/rate-limited-storage-snapshot-service.ts` envuelve los puntos
  de captura y no llega a la red mientras el enfriamiento está activo. `src/main.ts` crea una sola
  instancia dentro de `initializeRuntime` y envuelve los dos `StorageSnapshotService`.
- Cada consumidor reporta una razón tipada para que un 429 no se lea como un 401: `rate_limited` en
  el estado de error de la detección y en los fallos de inicio y fin de sesión,
  `capture_rate_limited` en el workflow del Advisor, con copy ES y EN donde ya existía un mecanismo
  por razón. Los reintentos por petición siguen siendo del transporte.
- `captureSource()` solo relanza 401 y 403 de fuentes requeridas, así que un 429 de una fuente
  opcional se convertía en cobertura parcial de una captura que resuelve y dejaba el enfriamiento
  sin armar, que es el caso más probable en producción. Ahora se recorren `coverage.sources` y
  `coverage.characters` tras cada captura resuelta y se arma el enfriamiento por cada 429, con el
  más largo ganando. El snapshot que recibe el consumidor no cambia: la cobertura parcial sigue
  siendo parcial, no un error.
- Límite conocido: `failureLabel()` de `src/ui/companion-status-model.ts` sigue dando el mensaje
  genérico para los fallos de inicio y fin de sesión, porque distinguir el 429 ahí pide una cuenta
  atrás propia como la que ya tiene la conexión, no una etiqueta nueva. Va con la QA visual de H6.9.

## Estabilidad del gate — presupuesto de tiempo en dos suites

- `src/eslint-default-project-config.test.ts` lanza `node` importando `eslint.config.mts`, que
  arrastra typescript-eslint y el plugin de Obsidian: su primer caso tarda 3,8 s contra el
  presupuesto por defecto de 5.000 ms. `src/platform/mumble-v2-shadow-architecture.test.ts` releía
  los 134 ficheros de producción de `src/` en cada caso y rehace el escaneo del árbol varias veces
  por caso.
- Las dos hacían caer `npm run check` al azar, en dos máquinas distintas, sin que cambiara ninguna
  aserción. Se les fija un presupuesto explícito de 30 s y se memoiza la lectura del árbol con copia
  por llamada, porque los casos mutan el mapa que reciben. Los controles negativos de ambas suites
  siguen poniéndose en rojo.

## Arranque del plugin diferido a `onLayoutReady`

- `onload()` esperaba el bundle de assets gestionados, el hash del vaultId, varias aperturas
  de IndexedDB, `sessions.initialize()` y `refreshLootPresentation()` antes de llegar a
  `registerView`. Un leaf guardado de tipo `tyrian-companion-*` podía restaurarse contra un
  view type todavía sin registrar, y todo eso bloqueaba el arranque de Obsidian.
- Dividido el arranque en dos fases: `onload()` carga los ajustes y, antes de cualquier otro
  `await`, registra las dos vistas, el setting tab, los cinco comandos, los comandos de sesión
  y los listeners de DOM, y termina con `workspace.onLayoutReady`. El resto se movió sin
  cambiar el orden a `initializeRuntime()`.
- Entre ambas fases, una guarda `runtimeReady` hace que cada getter devuelva un valor neutro
  con la misma forma que el estado recién construido de su servicio, y que cada acción salga
  sin efecto mostrando el aviso nuevo `notices.pluginStarting` (ES y EN, en
  `src/core/i18n-runtime-catalog.ts`). `onunload()` marca `unloaded` antes que nada e
  `initializeRuntime()` lo comprueba antes de repintar.
- Añadido test de la propiedad de orden, verificado en rojo con sabotaje moviendo las llamadas
  de `registerView` de vuelta a la fase diferida.

## Worktrees de agente fuera del gate del repo

- Un worktree de agente colgando de `.claude/` dentro del repo es una segunda copia entera de
  `src/`. Medido con uno presente: `vitest list --filesOnly` devolvía 226 ficheros de test,
  113 de ellos bajo `.claude/`; tras el cambio devuelve 113 y ninguno bajo `.claude/`. `eslint .`
  lintaba esa copia también.
- `scripts/h8-native-decision-contract.mjs`, que recorre el sistema de ficheros y por eso no lo
  tapaba `.gitignore`, ponía `npm run check` en rojo con 20 hallazgos
  `forbidden-product-artifact`, todos dentro de `.claude/worktrees/`.
- Excluido `.claude` en `vitest.config.mts`, `eslint.config.mts`,
  `scripts/h8-native-decision-contract.mjs` y `scripts/security-scan.mjs`, más
  `/.claude/worktrees/` en `.gitignore`. Verificado que el contrato sigue mordiendo: una copia
  no revisada de un fichero de producto bajo `src/platform/` lo pone en rojo nombrándola, y
  quitarla lo vuelve a poner en verde.

## `tsconfig.json` — resolución de módulos `bundler`

- `moduleResolution` pasa de `node` (modo node10 retirado) a `bundler`. TypeScript 5.9.3, la
  versión fijada aquí, todavía acepta el valor viejo, pero un `tsc` más nuevo rechaza la config
  con `TS5108` antes de compilar nada; el build ya pasa por esbuild, así que `bundler` es el
  modo que corresponde a cómo se construye el plugin de verdad.

## Recuperado el protocolo de QA manual del MVP

- `docs/QA-MVP.md`, escrito el 14 de agosto de 2026 dentro del worktree `test/h6-manual-qa`
  para H6.8/H6.9, nunca llegó a un commit del repo. Recuperado a `main` tal cual salvo la
  cabecera de alcance: se quitan las cifras de gate del 14 de agosto, que hay que volver a
  medir sobre el candidato instalado de verdad, y se apunta la instalación/actualización a
  H7.5 y `docs/BETA.md` en vez de la fila Updater/reopen.

## H8.8 — Política shadow de presencia y ausencia

- Añadida una política pura y aislada para el mapa objetivo fijo `866`: 5.000 ms de crédito de
  presencia en idle y 60.000 ms de crédito de ausencia durante una sesión ligada, con un máximo de
  500 ms aportado por record.
- Gaps, heartbeat/source unavailable, `link_stalled`, caída de canal y recovery reinician o degradan
  la ventana; no cuentan como ausencia ni permiten catch-up tras sleep.
- Cada latch puede producir como máximo un DTO efímero con evidencia `limited` y review
  `human_required`. Repetir el mismo estado no reemite el DTO; cambiar el `accountId` del contexto
  efímero reinicia ventana y latch para evitar atribuciones cruzadas.
- Shadow no encola una propuesta H5.3, no persiste, no muestra UI y no modifica captura ni lifecycle
  de sesión. La API continúa autoritativa y no se han tocado `main`, settings ni composición.
- Añadidas 25 pruebas H8.8 —17 funcionales y ocho arquitectónicas—; el gate completo combinado queda
  en 113 ficheros y 1.544 tests Vitest, además de lanes C/Rust/release/scanner y build.
- H8.8 queda cerrada en su alcance shadow aislado: la integración con el runtime, las métricas
  comparativas y la QA humana multiplataforma pertenecen a H8.9–H8.15. Esta reconciliación no
  descongela H8 ni autoriza composición, salida de shadow o release.

## H8.7 — Frontera segura de lanzamiento sin executor

- Añadidos contrato, builder de plan y adapter inyectado para las rutas cerradas Windows nativo,
  macOS/CrossOver y Linux/Steam/Proton. AppID `1284210` y `MumbleLink` son fijos; no se admiten
  `args`, `env`, `shell`, `command` ni `mapping` configurables.
- Package/bottle/compat-data estrictos y efímeros producen CrossOver `wine` y Proton
  `protontricks-launch` con argv/env exactos, `shell:false` y tres pipes. No se han tocado
  settings, UI, `main` ni `onload`, y no existe import Node, executor host, spawn real o autoarranque.
- El adapter abre el paquete H8.5 canónico de cinco ficheros antes de cada intento, valida manifest
  y cuatro checksums, y delega solo una capability opaca ligada a bytes/digests, nunca un helper path.
  Drena stderr, limita el callback prematuro a un chunk de 516 bytes y falla ante overflow/segundo/exit;
  stop es idempotente. El gate prueba solo `integrity_checked` /
  `unsigned_qa_only`, no autenticidad; el executor futuro exige trust anchor y revalidación inmediata.
- Diagnósticos cerrados omiten secretos, frames, identidad, PID, exit code, paths, botella y SO raw.
  Guards/scanner v13 incluyen sabotajes de shell indirecto, `process` directo/computed/global/alias,
  delivery canónica, único call-site de capability, hash canónico del adaptador completo,
  host PID/path/token, mapping, args/env,
  diagnóstico raw, segundo módulo, onload y trust overclaim. H8.7 sigue `@wip`: faltan executor,
  composición, firma/publicación y QA real.
- Añadidas 25 pruebas H8.7 —16 funcionales y nueve arquitectónicas—; el gate completo combinado queda
  en 110 ficheros y 1.519 tests Vitest, además de lanes C/Rust/release/scanner y build.

## H7.1 — Identidad de release

- Fijados `tyrian-companion`, **Tyrian Companion**, autor público **David**, repositorio
  `fodaveg/tyrian-companion` y licencia MIT como identidad estable del MVP.
- La comprobación case-insensitive contra revisiones fijas de los registros oficial activo y retirado
  de Obsidian devuelve cero colisiones; deberá repetirse antes de publicar porque no reserva el nombre.
- Añadido contrato ejecutable con veinticuatro sabotajes para impedir deriva silenciosa entre manifest, paquete,
  repositorio, licencia, README y evidencia de identidad. El repo permanece privado y no se creó
  release, tag ni canal BRAT.

## H4.18/H4.19 — Activación humana de la recomendación para 36038

- David aprobó el `2026-08-16T05:22:24.000Z` la regla source-backed de apertura y el pack económico de **Trick-or-Treat Bag**. RulePack V2 pasa a `human_reviewed`, la capability `open` queda habilitada y el pack H4.19 usa activación `enabled` ligada al nuevo SHA-256.
- Con el batch completo y fresco del saco y sus ocho outcomes, el kernel puede recomendar manualmente `open`, `sell` o `vendor` aplicando el margen mínimo fijo del 10%. Evidencia parcial, stale, incoherente, revocada o fuera de la ventana temporal sigue devolviendo revisión.
- El instante de aprobación es el límite inferior inclusivo del provider y de la evaluación económica; `validUntil` sigue siendo exclusivo. No se añadió executor, background, listing automático ni descarte.

## Inventory Advisor — alcance por personaje y lectura honesta del valor

- Un 403 específico de banco, materiales o delivery ya no derriba la captura del Advisor: conserva
  bolsas y compartido y marca únicamente esa fuente como parcial. Un 401 sigue fallando globalmente.
  La cobertura saneada llega al recibo y a la vista; cada checkbox opcional indica «Leído», permiso
  ausente, restricción, lectura parcial o indisponibilidad, y no confunde una fuente inaccesible con
  una fuente leída sin objetos.
- Un mismo objeto con una ruta valorada y otra sin precio conserva el subtotal conocido, pero cuenta
  como no valorado; el resumen ya no puede afirmar que todos sus objetos tienen precio.
- La captura del Advisor vuelve a leer banco, materiales y entrega del bazar, pero como fuentes
  **opcionales**: su permiso ausente, URL restringida o fallo degrada solo su propia cobertura y nunca
  invalida bolsas ni inventario compartido. La cartera sigue fuera del Advisor. Los tres controles
  «Incluir además» dejan de estar deshabilitados y muestran datos reales.
- Nuevo filtro de **Personaje**: acota la vista a las bolsas de un personaje concreto, con la lista
  derivada de lo observado en la captura. Mientras hay un personaje seleccionado, banco, materiales y
  entrega quedan fuera del alcance y sus casillas se deshabilitan; un personaje que ya no aparece en la
  captura vuelve automáticamente a «Todas las bolsas y compartido». La vista declara ese alcance en
  texto en lugar de dejarlo implícito.
- Nuevo control de **Orden** (valor, cantidad o nombre) aplicado *después* de acotar, para que el orden
  visible corresponda a las cantidades y valores visibles y no al ranking previo al filtro.
- El resumen «Qué hacer ahora» separa unidades y pilas de los objetos distintos, y declara cuántos
  objetos **no tienen precio demostrado** en lugar de sumarlos como cero al valor conocido. Cada botón
  de acción arrastra su propio recuento sin precio.
- La tabla añade **Pilas** y **Valor por unidad**, cierra cada grupo con un subtotal exacto de sus
  filas y colorea la acción y el nivel de evidencia. La evidencia deja de resumirse en una palabra:
  nombra los ejes concretos que no están completos, por ejemplo «Limitada (precios, reglas)».

## Hotfix — Inventory Advisor con datos reales

- La clasificación deja de usar la completitud global de catálogo/precios como interruptor para todas
  las filas. Con un batch 206 parcial, cada objeto con catálogo resuelto y precio presente u omisión
  demostrada puede mostrar su ruta manual de listing, venta o mercader. El pack curado pendiente solo
  retiene sus propias capacidades; ya no convierte en `rule_stale` las rutas líquidas independientes.
- Añadido un recibo diagnóstico local reemplazable por Refresh con resultado, duración y cobertura
  por pasada/fuente. Permite diagnosticar el fallo real sin capturas de pantalla ni consola y excluye
  secretos, identidad, personajes, objetos, URLs y cuerpos de respuesta. Las fuentes no disponibles
  conservan únicamente clase de transporte, código HTTP y espera acotada para distinguir 429/5xx,
  timeout y red.
- Antes de H6.26, el Advisor dejó de intentar estabilizar el inventario mediante tres lecturas completas.
  Cada intento realizaba una sola pasada acotada y una pasada completamente cubierta se conservaba como evidencia
  `unstable/limited`: puede mostrar rutas manuales líquidas, pero no autoriza uso, apertura, reciclaje
  ni acciones irreversibles. Solo una pasada parcial transitoria provoca un segundo intento completo.
- Refresh usa un transporte separado con timeout de 30 segundos por petición; las capturas completas de
  sesión conservan el transporte y la estabilización de dos/tres pasadas originales.
- Las lecturas de inventario de personajes del Advisor se serializan para evitar que varios personajes
  compitan por el transporte de Obsidian y agoten simultáneamente el timeout. Las capturas completas de
  sesión conservan su límite de concurrencia independiente.
- Refresh deja de depender del snapshot account-wide: captura y estabiliza exclusivamente inventarios
  de personaje + compartido. Banco, materiales, wallet y delivery quedan `not_requested`, no pueden
  invalidar el inventario básico y sus controles permanecen deshabilitados hasta una captura separada.
- La vista deja de ser un volcado account-wide de filas sin acción: por defecto enseña bolsas de
	personaje e inventario compartido y prioriza una cola «Qué hacer ahora» con verbos directos,
	cantidades y valor en oro/plata/cobre. Las filas `keep|review|discard_review` quedan como contexto
	opt-in; banco, materiales y delivery siguen como ámbitos futuros deshabilitados. Cada fila puede
	mostrar el icono oficial del catálogo.
- Los items sin conocimiento curado pueden comparar de forma manual venta instantánea, listing y
  mercader con evidencia completa; uso, apertura y reciclaje siguen retenidos hasta tener regla
  curada. La explicación declara que no se ejecuta ni compara esas rutas.
- La cobertura del Advisor ya se calcula sobre sus fuentes reales —personajes + inventario compartido—,
  no sobre los ámbitos opcionales. Si una lectura completa cambia entre pasadas, conserva el estado
  `limited` pero puede mostrar rutas manuales de venta/mercader sobre la última pasada; usar, abrir y
  reciclar continúan en revisión hasta obtener una lectura estable.
- Refresh muestra progreso indeterminado honesto, reintenta una vez una captura parcial transitoria
  y conserva el último resultado válido con aviso saneado solo si un Refresh devuelve
  `capture_unavailable`; identidad, preferencias y reclassify fallan cerrados.
- La captura `unavailable|invalid` deja de alcanzar composición o preferencias y devuelve un
  motivo bloqueado cerrado. El controlador conserva ese enum hasta la vista, que distingue de forma
  segura clave ausente, captura no disponible/no válida, almacenamiento local, reglas y fallo inesperado
  sin mostrar token, identidad de cuenta, bóveda ni excepciones internas.
- El catálogo omite propiedades opcionales ausentes, invalida nombres que no pueden entrar en el
  contrato de presentación y sube su versión de normalización para no reutilizar caché antigua.
- La captura de precios acepta la respuesta parcial HTTP 206 de la API oficial y conserva los
  precios presentes, marcando únicamente los IDs omitidos como no disponibles.
- El runtime transmite al capture los nueve IDs económicos pedidos por el bundle H4.19 y la capa
  de allowlist acepta y valida ese contexto económico opcional en vez de invalidar el informe.
- Verificación de solo lectura contra la cuenta real: snapshot estable, seis fuentes de almacenamiento
  completas, 1.206 objetos/1.701 posiciones y presentación `limited` con 1.701 filas de revisión;
  ninguna acción automática, económica o irreversible queda habilitada.
- La QA visual en Obsidian sigue siendo obligatoria: el diagnóstico externo no sustituye la ejecución
  con SecretStorage e IndexedDB reales de la aplicación.

## H8.6 — Núcleo aislado del cliente Mumble

- Añadidos `mumble-v2-codec.ts`, `mumble-v2-client.ts`, `mumble-v2-health.ts` y
  `mumble-v2-observation.ts` como módulos TS puros, sin imports Node ni I/O ambiente.
- El codec incremental aplica `uint32` big-endian + UTF-8 fatal + JSON cerrado 1..512, high-water
  máximo 516, schemas exactos, duplicados escapados, BOM/trailing y secretos base64url canónicos.
- El cliente usa puertos fakeables de proceso, TCP, reloj y CSPRNG; rota token por proceso y nonce
  por conexión, exige secuencia `0,+1`, deadlines y generaciones, y aísla throws/reentrada de
  callbacks externos. Restart y reconnect comparten `[250,500,1000,2000,5000]`, con reset solo al
  alcanzar `healthy`.
- Salud mantiene canal, fuente y actividad como tres ejes; la observación shadow retiene solo
  `mapId + activity` en memoria bajo `enabled && armed`, sin callbacks de sesión, propuesta, captura
  o persistencia.
- Añadidas 42 pruebas H8.6 —33 funcionales y nueve de arquitectura— y guardas dinámicos con allowlist exacta y sabotajes de módulo,
  helper, imports `fs`/`net`, sesión, captura, store, logger, timers globales y scanner always-green.
  No hay launcher, adapters reales, wiring en `main`, settings/UI, packaging ni QA de plataforma.

## H8.4 — Protocolo IPC local cerrado

- Fijados helper servidor/plugin cliente sobre TCP IPv4 `127.0.0.1`, bind port `0`, bootstrap por
  stdin, discovery `ready` por stdout y handshake TCP `hello → welcome`; todos los records comparten
  longitud `uint32` big-endian y JSON UTF-8 de 1–512 bytes.
- Cerrados seis schemas exactos: bootstrap, ready, hello, welcome, heartbeat de control y el sample
  H8.1 sin cambios. Longitud cero/513+, truncado, UTF-8 inválido, BOM, JSON inválido/no objeto,
  duplicados, trailing y claves extra/missing fallan cerrados.
- Fijados token CSPRNG por proceso de 32 bytes/43 caracteres solo stdin+hello, comparación en tiempo
  constante y prohibición en argv/env/fichero/log/stdout/stderr/discovery/settings/IndexedDB/Vault/
  telemetría; nonce CSPRNG por conexión de 16 bytes/22 caracteres desde welcome. Solo se admiten una
  conexión autenticada y una pendiente.
- Heartbeat y sample comparten secuencia `0,+1` sin gaps, replay, regresión, overflow ni wrap. Tick
  conserva rollover `uint32`; cada llamada debida de 500 ms emite un record y el sample derivado de
  tick/map raw sustituye heartbeat y satisface liveness. El primer válido tras
  start/recovery/discontinuidad emite `warming_up` sin historia; el segundo abre época advancing y
  cualquier source-status borra tick/startedAt. 1.499/1.500 ms fijan advancing/stalled sin tick stale.
  Lateness emite como máximo uno, agenda desde now y no hace catch-up; 2 s sin record válido fallan
  `heartbeat_timeout`. Stalled 1.500 ms, discovery 5.000 ms y
  connect/hello/primer-secuenciado/heartbeat 2.000 ms quedan fijados junto al backoff
  `[250,500,1000,2000,5000]`.
- Añadidos los cinco `sourceStatus` y catorce errores de canal exactos, separando lifecycle del canal,
  salud de fuente y `link_stalled`. API v1 permanece autoritativa, rollout shadow, confirmación
  humana y retención `none`.
- Añadido ADR 0002 con bloque JSON de igualdad completa, orden y hashes cerrados; lifecycle de fases,
  deadlines, EOF y reconnect determinista; y tests causales para framing, validators, secuencia,
  fake clock, reset healthy, token constant-time y vectores. H8.5/H8.6 implementan después los dos
  lados en aislamiento; launcher, adapters del cliente, composición y packaging siguen ausentes.
- Endurecido el contrato tras revisión: hello queda ligado al token capturado de bootstrap; reconnect
  del mismo proceso lo conserva, mientras fallo pre-ready, `helper_exited`, restart y EOF lo invalidan.
  Solo post-ready permite volver a conectar; cada conexión rota nonce y reinicia secuencia en cero.
  El framer test-only drena chunks coalesced arbitrarios con high-water máximo de 516 bytes y solo un
  record completamente válido renueva el deadline.
- Cerrada la ruta `helper_exited` para todos los estados no terminales, incluido `reconnect_wait`:
  invalida token/puerto/nonce/secuencia y bloquea `reconnect_due`. El framer mide memoria simultánea
  real y transfiere el payload tras liberar su referencia, sin duplicarlo durante el callback.
- Añadida referencia de cadencia con fake clock, raw tick/map/status, recovery con tick stale,
  umbral 1.499/1.500 ms y salto de 60 s; sabotajes causales cubren catch-up, dos records o ninguno,
  `warming_up` infinito, sample sin calentamiento previo y heartbeat `healthy` inventado.

## H8.2 — Spike read-only dentro de CrossOver

- Añadido bajo `spikes/` un decoder C portable del layout oficial y un wrapper Windows que abre
  únicamente el mapping `MumbleLink` con `FILE_MAP_READ`; no enumera procesos, inyecta, automatiza,
  abre red ni persiste datos.
- La proyección queda cerrada a versión/tick/context_len/mapId y a un único frame H8.1 por stdout;
  hasta ocho intentos exigen dos candidatos completos idénticos antes de aceptar. Es best-effort,
  no un seqlock ni garantía de coherencia del writer; el activity solo deriva avance/stall.
- Añadidos fixtures adversariales de tick igual con map híbrido/word tearing, versión, tamaño,
  contexto, map id, nonce, secuencia y frame. Cinco sabotajes causales fijan offset, 5.460 bytes,
  512 bytes, ocho pares y el máximo JSON seguro `9007199254740991`; la lane ejecuta además
  ASan/UBSan.
- Añadido guard de censo exacto del spike: exige una sola llamada a `OpenFileMappingW` y otra a
  `MapViewOfFile`, ambas con argumentos `FILE_MAP_READ`; cierra las llamadas y sumideros permitidos,
  incluye el stub y el script host, rechaza `0x0002`, write/all, Toolhelp/proceso/memoria,
  identidad/coordenadas, red, persistencia/logs y ejecución de Wine/CrossOver o copias fuera del
  temporal durante `npm run check`. Las llamadas C se extraen léxicamente ignorando comentarios y
  literales —incluido el permiso decimal `2u`—, y el script host queda bajo un contrato positivo
  byte a byte con destinos temporales exactos; sabotajes con código malo y decoys buenos, `open`,
  `/bin/cp`, `command cp`, `eval`, `rsync` e `install` demuestran la vía roja. El scanner productivo
  no amplía su allowlist.
- Cerrado también el preprocesador del wrapper: su censo positivo permite solo
  `WIN32_LEAN_AND_MEAN` y los cinco includes esperados. `#undef`/redefiniciones de
  `FILE_MAP_READ`, `MUMBLE_MAPPING_NAME`, `TC_MUMBLE_LINK_VIEW_BYTES` o aliases nuevos fallan;
  sabotajes cubren permisos `2u` y `(1u << 1)`, nombre y tamaño.
- La lane preprocesa ahora el wrapper real con el mismo compilador y stub (`-E -P`) y valida el
  resultado expandido: acceso `0x0004u`, nombre `MumbleLink` y view `5460u`. Hashes contractuales
  cierran wrapper, core header, stub y validador. Sabotajes en `windows.h`, `core.h`, directivas
  digraph `%:` y line-splicing preprocesan correctamente pero son rechazados por su semántica.
- Inventario read-only confirmado en macOS ARM: CrossOver 26.3.0 y botella win64 `Guild Wars 2`
  existen; Apple Clang está disponible, pero no un cross-compiler Windows. No se instaló toolchain,
  no se modificó la botella y no se abrió ni ejecutó CrossOver/GW2.
- Quedan pendientes compilar el PE y demostrar lectura estable en una sesión real. El spike no se
  importa desde `src`, no entra en el release y no relaja el scanner productivo.

## H8.5 — Helper/servidor Mumble nativo

- El verifier de supply-chain lee `Cargo.toml`/`Cargo.lock` directamente y ya no invoca Cargo ni
  instala toolchains desde jobs Node. El target MSVC añade `/Brepro` para eliminar metadata variable
  del linker entre los dos builds de reproducibilidad, conservando CRT estático.
- CI permite el PDB efímero que MSVC deja bajo `target`, pero construye un stage de artifact cerrado
  que admite solo el marker durante un día; tests causales rechazan PDB/DLL/LIB/OBJ/RLIB en el stage
  futuro del helper y cualquier output nativo en el artifact CI.
- Añadido el crate Rust único `native/mumble-helper`, toolchain 1.85.1, target
  `x86_64-pc-windows-msvc` y CRT estático, sin Tokio ni `build.rs` propio.
- Implementados framing big-endian 1..512, JSON exacto con duplicados escapados, token bootstrap
  comparado constant-time y zeroized, nonce por conexión y secuencia heartbeat/sample conjunta.
- Portado el reader H8.2: exactamente cuatro words, ocho pares estables y adapter Win32
  `OpenFileMappingW`/`MapViewOfFile` solo `FILE_MAP_READ`.
- El servidor inicia el primer slot a 500 ms y emite exactamente un record por slot: primera lectura
  válida `warming_up` sin historia, la siguiente abre época/sample advancing; ausencia/layout/
  tearing/invalidez producen heartbeat y reinician la actividad. Tick igual cambia en 1.499/1.500
  ms, una llamada tardía agenda desde `now+500` y 2 s sin record cierran sin catch-up.
- Añadidos lifecycle tests de EOF, slowloris, cliente extra, auth y reconnect, guard positivo,
  supply-chain/staging sintético y CI Windows para PE x64/static CRT/reproducibilidad.
- El EOF previo al bootstrap publica `shutdown` con orden Release antes de desconectar el canal;
  el receptor Acquire ya no puede confundir un cierre limpio con un fallo según el scheduler de
  Windows, y el guard v17 sabotea causalmente el orden inverso.
- CI solo conserva el marker corto `UNSIGNED-NOT-FOR-RELEASE`; el ZIP del plugin sigue con tres
  ficheros. H8.6 añade el cliente core aislado, pero Authenticode, publicación, launcher/wiring del
  plugin, firma y QA real siguen pendientes.

## H8.3 — ADR del helper nativo Mumble

- Comparados Rust y C# NativeAOT; ambos pueden producir una aplicación nativa self-contained y
  single-file sin runtime instalado. Rust se acepta provisionalmente por su frontera pequeña sin GC
  administrado y su zona `unsafe` Win32 explícita; C# conserva tradeoffs reales de trimming/AOT,
  runtime mínimo embebido, tamaño, toolchain y símbolos/PDB, y sigue como opción de reapertura.
- Fijados la raíz futura `native/mumble-helper`, target único `x86_64-pc-windows-msvc`, flag
  `-C target-feature=+crt-static` y salida única `tyrian-mumble-helper.exe`.
- Definido un ZIP separado, fuera del paquete del plugin, con EXE, manifest, `SHA256SUMS`, licencia y
  avisos de terceros. Authenticode y la firma siguen pendientes; un helper sin firma no sale a release.
- Registrada la matriz Linux/Steam/Proton primaria, macOS/CrossOver secundaria y Windows x64 beta,
  toda `qa=pending`, junto a los seis entornos exactos fuera de soporte.
- Añadidos riesgos/reopen triggers y un guard documental de schema exacto con sabotajes causales. El
  censo positivo global cubre fuente Rust/C#, configuración Cargo/toolchain exacta, paths helper y
  cualquier señal de prefijo `mumble-link`/`mumble_link`/`MumbleLink`, además de
  EXE/DLL/PDB/LIB/OBJ/RLIB/RMETA y symlinks fuera de las superficies no productivas exactas;
  `bridge` genérico queda permitido. Parsing y hashes gobiernan bloque JSON, ADR y la política de
  plataforma completa. No se crea runtime.

## H8.1 — Contrato Mumble Link v2

- Añadido el contrato declarativo previo al helper: opt-in, defaults revisables `shadow` y
  `on_when_armed`, API v1 autoritativa, confirmación humana y retención raw/frame `none`.
- Fijada la allowlist de lectura a `uiVersion`, `uiTick`, `context_len` y `context.mapId`; el payload
  IPC mínimo conserva solo versión/nonce/secuencia/tick/mapId/actividad derivada, sin identidad,
  coordenadas ni PID.
- Verificado el id oficial `866` para **Mad King's Labyrinth / Laberinto del Rey Loco** y fijadas las
  fuentes de layout Mumble/GW2 Wiki/ArenaNet por revisión/commit, incluido `uiVersion=2`.
- Definido transporte futuro solo loopback `127.0.0.1`, puerto efímero, nonce mínimo de 128 bits,
  `initialSequence:0`, frame JSON UTF-8 de 512 bytes máximo y rechazo fail-closed de
  versión/campos/orden/layout.
- Scanner v4 reabre únicamente el fichero contractual exacto; su allowlist AST recursiva y
  sabotajes mantienen en rojo helpers fuera de censo, exports alternativos, sintaxis ejecutable,
  inyección, proceso, memoria, logs, tráfico, entrada, automatización, red, persistencia y timers.
- No se ha implementado helper productivo, IPC runtime ni composición. QA real Linux/Steam/Proton,
  macOS/CrossOver y Windows queda explícitamente pendiente.

## H4.19 — Economía manual fail-closed para 36038

- Extraído de H4.10 un kernel económico puro e independiente de sesión que compara apertura conservadora con el mejor suelo inmediato entre bid y mercader usando margen exacto del 10%.
- Refresh captura como evidencia hermana fresca el saco y los ocho outcomes líquidos H4.7 (`36041`, `36059`, `36060`, `36061`, `79673`, `79677`, `79679`, `89002`), ligados a cuenta, snapshot, schema y TTL.
- Añadido un pack hasheado que liga modelo, regla, knowledge pack, cobertura, binding, reservas y excepciones. Solo evidencia completa permite recomendar manualmente `open`, `sell` o `vendor`; parcial, revocada, vencida o incoherente termina en `review`.
- El built-in permanece `pending_human_review`: no se ha fingido aprobación ni activado ninguna recomendación. No existen listing, executor, background ni descarte en esta ruta.
- Añadidos tests causales y guard arquitectónico. Siguen pendientes la aprobación humana del pack/economía y la QA manual ES/EN en Obsidian.

## H7.2/H7.3/H7.6 — Onboarding, clave API y soporte seguro

- Añadido onboarding desde cero al README: artifact manual verificado, Secret Storage, conexión,
  apertura real de Companion y lifecycle state-dependent de start → finish → review → save/clear.
- Documentados modo asistido y límites de exactitud, valoración e Inventory Advisor sin convertir una
  observación, propuesta o revisión irreversible en una acción automática.
- Añadida guía de clave con scopes reales: `account` solo conecta; sesiones completas requieren
  `account`, `characters`, `inventories` y `builds`; wallet/TP/progression/unlocks amplían cobertura.
- Añadidos revocación/rotación, errores saneados y soporte con lista cerrada de diagnóstico permitido y
  prohibición explícita de secretos, identidad, rutas, inventario/snapshots, IndexedDB y salida cruda.
- Añadido issue form obligatorio y un contrato ejecutable fail-closed: esquema top-level exacto,
  allowlist exacta de IDs/tipos y SHA-256 semántico canónico de todo el formulario —incluidos
  nombre, descripción, título, prompts y atributos visibles—, un único Markdown seguro,
  diagnóstico opcional y sabotajes causales de campos hostiles o benignos,
  redacción, permisos, acción de finalización e issues en blanco. BRAT/publicación y QA humana no se
  activan ni se declaran completados.

## H7.4/H7.5 — Paquete reproducible y preparación del canal beta

- Añadido build causal y stage cerrado a `manifest.json`, `main.js` y `styles.css`, con validación cruzada de manifest/package/versions y tag exacto.
- Añadidos ZIP determinista, SHA-256 y revalidación interna de cabeceras, orden, CRC y contenido; los sabotajes de build, secreto y bytes alterados prueban la vía roja.
- El scanner v4 cubre también los bytes finales de release, incluido `main.js`, sin exponer valores encontrados.
- CI genera un artifact temporal para pushes de rama o tag después del gate; mantiene permisos read-only y no publica releases.
- CI recrea y enumera un staging separado con ZIP, checksum e instalador guardado; el upload
  inmediatamente posterior nunca incluye el stage interno de build.
- Añadido un instalador/actualizador manual transaccional: revalida checksum, ZIP, manifest, versión y
  symlinks, usa lock e identidad de directorio/estado, sustituye únicamente los tres ficheros
  gestionados, preserva datos locales y revierte desde bytes originales incluso si el backup o el
  cierre del lock fallan. El staging vuelve a comparar los tres bytes persistidos y el contrato censa
  cualquier variante adicional de upload. Su contrato estructural de CI y
  matrices hostiles de ZIP, concurrencia, TOCTOU y staging quedan en el gate.
- Documentado el procedimiento manual y la preparación BRAT fail-closed. Publicación, instalación y actualización reales quedan explícitamente pendientes de QA humana.

## H4.18 — Curación segura inicial del Inventory Advisor

- Añadida la capability source-backed de abrir el item 36038; `use` y `salvage` permanecen explícitamente `not_applicable`.
- RulePack V2 queda en `pending_human_review` con `reviewedAt: null`; la recomendación permanece retenida por comparación económica ausente.
- Se preserva el hash legacy de V1 y V2 usa SHA-256 estándar; las ventanas `publishedAt`/`validUntil` fallan cerradas.
- No existen acciones automáticas ni descarte. QA y revisión humana siguen pendientes.

## H5.12 — Preferencias locales del Inventory Advisor

- Añade objetivos de reserva y excepciones de conservación locales, editables dentro del Advisor tras una acción explícita.
- Las claves persistidas combinan hash de vault y cuenta probada por la evidencia; el ItemView no expone identificadores ni generación CAS.
- Las escrituras usan CAS entre ventanas, preservan el borrador ante conflicto y reclasifican sólo evidencia aún fresca, sin segunda captura.
- Corrupción, schema futuro, indisponibilidad y evidencia obsoleta fallan cerrados; no se crean recomendaciones con defaults.
- QA visual real en Obsidian permanece pendiente.

## H5.11 — Vista manual del Inventory Advisor

- Añadida una vista Obsidian independiente, responsive y bilingüe con filtros, agrupación, cantidad,
  ubicación, acción, valor neto H4.2, cobertura y explicación por fila; abrirla solo lee memoria local.
- Añadidos workflow y comandos separados Open/Refresh: el refresh explícito compone H4.14 → H4.15 →
  H4.16 una sola vez, comparte vuelo, usa generación latest-wins y se invalida al cambiar clave o locale.
- `discard_candidate` cruza la frontera de presentación únicamente como `discard_review`, con proof H4.16
  exacto y aviso irreversible; no existe CTA, executor, operación de juego ni filtro de descarte.
- El puerto H5.12 de objetivos/excepciones queda reemplazable y vacío. H4.17 aporta un bundle built-in
  inmutable, solo revisión y sin rutas curadas: antes de su expiración todos los resultados permanecen
  `review`; desde el límite exclusivo 2026-11-12 falla como `blocked/missing_rules` antes de capturar.
- Gate automatizado completo en verde; la QA visual de la vista dentro de Obsidian queda pendiente.

## H0.4/H0.6 — Plataformas, integraciones y piloto

- Fijada la matriz de soporte: Linux con Steam/Proton como primaria, macOS con CrossOver como secundaria y Windows en beta.
- Cerrado el MVP a la API oficial de Guild Wars 2; Mumble Link queda para v2 como helper IPC opcional, separado y limitado a mapa/actividad.
- Prohibidas la inyección, inspección del proceso o de su memoria, interceptación, simulación de entrada y cualquier operación desatendida.
- Definidas tasas medibles de falso inicio/parada, recuperación y precisión temporal, con cobertura, muestras mínimas y umbrales de salida del piloto.

## H6.6 — Rendimiento reproducible de cuenta grande

- Añadido benchmark Node con GC explícito para parser → construcción y estabilización productivas de tres pasadas → delta → clasificación → valoración sobre 48 personajes, 5.132 holdings y 4.840 ganancias.
- Fijados warmup, 21 muestras, mediana/p95 nearest-rank y heap acumulado post-GC contra un baseline único. Los presupuestos fail-closed detectan colapsos y CI prueba la vía roja con retención explícita posterior al baseline en Node 22 y 24.
- El benchmark excluye explícitamente HTTP, caches, persistencia, Vault y UI: no simula I/O ni usa tiempo de Vitest como métrica.

## H5.10 — Exportación de historial durable

- Añadido escaneo manual vault-wide de notas `gw2_farming_session` schema 1/2, con integridad de referencias y seis bloques gestionados. Corrupción, schema futuro o `tc_session_ref` duplicada bloquean la exportación completa.
- Export JSON v1 determinista y CSV fijo CRLF create-only bajo `exports/`, sin IDs crudos, rutas, campos personales ni Markdown humano; el CSV cita todos los campos y neutraliza fórmulas.
- `Sessions.base` exige ahora `tc_schema` y `tc_kind`; el bundle gestionado sube a v3 para actualizar de forma CAS el asset v2 y una instalación más nueva queda read-only para un plugin antiguo. Ajustes ES/EN ofrece la acción explícita sin I/O al cargar.
- Añadido scrub warning en Ajustes con preview previa y confirmación ES/EN. El token opaco se consume o revoca en toda salida; una autoridad compartida excluye transiciones de sesión/recovery/detector y relee el gate antes de cada `Vault.process`. Solo elimina metadata `tc_*` y seis bloques verificados, conserva el fichero, frontmatter humano y cuerpo exterior, y trata borrado/renombrado como conflicto.
- Endurecido el codec del historial con YAML Core real, tipos/estilos escalares y claves únicas; el CSV serializa también su cabecera y cero sesiones no añade una fila vacía.

## H6.1/H6.2 — Movimientos y contaminación

- Añadida una matriz parser → snapshot → delta para los seis movimientos entre personaje, banco y materiales, con holdings/composición exactos y cero loot o disponibilidad falsos.
- Verificada la revisión durable de apertura, reciclaje, compra en bazar y compra a mercader mediante una segunda instancia del servicio; la clasificación y sus permisos sobreviven al reinicio.
- Fijado que la actividad del bazar de este flujo procede de declaración explícita: no se inventan eventos TP observados.

## H6.3–H6.5 — Economía, recuperación y red

- Fijado que los jackpots excluidos no cambian EV ni recomendación, y que un precio TP cero degrada a evidencia parcial sin convertirse en cobre cero.
- Añadida recuperación tras reinicio desde `stopping` y `provisional` sin recapturar baseline, final, delta ni precios; cancelar el modal no llama al backend ni muta runtime.
- Completada la matriz HTTP: 500/502/503/504 reintentan; 401/403/501 fallan; un 5xx persistente agota reintentos con error saneado.

## H5.9 — Internacionalización ES/EN

- Añadido catálogo pequeño, tipado y exhaustivo para ajustes, Companion, estados, acciones, notices, confirmaciones y modales; las claves y placeholders ES/EN se comprueban estructuralmente y la interpolación permanece en texto plano.
- Localizadas las notas de sesión, la presentación de botín, los Markdown y las Bases sin cambiar IDs de comandos, enums, `tc_*`, marcadores/hash, rutas ni las propiedades/fórmulas con las que Bases filtra y ordena.
- El cambio de idioma redibuja las superficies abiertas y actualiza el bundle de assets gestionados. Los nombres de comandos ya registrados en la paleta se actualizan al recargar el plugin, por una limitación de registro de Obsidian.

## H5.8 — Portabilidad de rutas Vault

- Centralizada la validación fail-closed de las rutas generadas o aceptadas para settings, notas de sesión y assets gestionados.
- Rechazados rutas absolutas/UNC, separadores de Windows, segmentos vacíos o de navegación, controles y surrogates sin emparejar, caracteres ilegales, nombres de dispositivo Windows —incluidos `COM/LPT` con superíndices—, variantes no NFC y longitudes no portables.
- Subido settings a v4: una carpeta pre-H5.8 que ahora no sea portable se retiene read-only en los únicos campos legacy autorizados; la reescritura canónica elimina propiedades desconocidas y no altera el puntero durable. Move/Remove inspeccionan siempre esa raíz y solo aceptan manifiesto owned exacto; un puntero divergente falla en conflicto. Move exige `ready` incluso si el puntero ya la nombraba. Un Remove reintentado reconoce el manifiesto exacto ya detached con puntero vacío sin volver a escribir y permite terminar la limpieza legacy.
- Ligados manifiesto y journal a la identidad empaquetada `id/kind/locale/path` y a hashes previos permitidos. Los manifiestos ready/detached exigen el locale y conjunto exacto del bundle actual —sin impedir bundles anteriores compatibles—; un trasplante de ruta o `beforeHash` arbitrario queda en conflicto.
- Las rutas de sesión conservan el diseño UTC + hash estable, sin incorporar cuenta, personaje, evento ni ruta personal.

## H5.7 — Halloween Base

- Migrado el frontmatter de notas a schema v2 con `tc_event`/`tc_event_source` y campos estables de recomendación `ready`; la procedencia manual o asistida es cerrada, durable y correlacionada, sin aceptar prefijos ni inferencias por fecha, nombre, texto o loot.
- Añadido `Halloween.base` ES/EN al bundle gestionado v2, conservando la Base genérica y el mismo manifiesto, hash, CAS y protección de modificaciones humanas.
- Añadidas cinco tablas para sesiones Halloween: recientes, por build, mejor rendimiento cualificado, contaminadas y abrir/vender histórico manual; `null` permanece vacío y cero permanece cero.
- Añadidas pruebas con parser YAML real para estructura, referencias, filtros, fórmulas, locales, hashes, upgrade y ausencia de I/O en el asset.

## H5.6 — Managed assets foundation

- Añadido motor Vault-only para inspección y plan puro de assets `.base`/`.md`, con rutas NFC seguras, colisiones case-insensitive y una Base genérica neutral.
- Añadidos manifiesto v1, generación CAS y journal durable reanudable para instalación, upgrade y repair explícitos entre ventanas.
- Añadidos uninstall mediante tombstone verificado + papelera de Obsidian y relocate cercado, siempre preservando bytes modificados o ajenos.
- Añadida autoridad IndexedDB lazy con root/generación/estado para serializar Apply/Move/Remove entre ventanas; settings v3 refleja el último root completo sin ser la autoridad CAS.
- Migrados settings a v3 con `managedAssetsRoot:null` sin escaneo/escritura y añadida UI compacta de Preview/Apply/Repair/Move/Remove.

Todos los cambios notables del proyecto se documentan aquí.

## [0.1.0] - Unreleased

### Added

- Scaffold de plugin Obsidian TypeScript/esbuild con ESLint, Vitest y CI.
- Vista **Tyrian Companion** y comando **Open companion**.
- Bitácora H5.1 status-first con fase/duración, detector, polling, calidad, cuenta e incidencia priorizada; detalles secundarios plegables, layout responsive, foco visible y controles táctiles de 44 px.
- Comandos H5.2 de sesión con disponibilidad revalidada y un único ribbon de compás contextual; start, finish/retry, review, recovery, discard y clear reutilizan H3 y las dos acciones destructivas requieren confirmación.
- Cola H5.3 durable de confirmaciones asistidas en IndexedDB dedicada, con proposals/receipts v1, dedupe/coalescing, TTL, límites, reconcile e intención/claim exactos y renovables entre ventanas.
- Entrega H5.3 sin interrupciones: el fondo actualiza indicadores in-place sin reconstruir UI ni robar foco; vista, paleta y ribbon proyectan un contador y la siguiente propuesta, y solo un Start/Stop iniciado desde esa propuesta puede aceptarla tras el éxito del workflow existente.
- Notas H5.4 de sesión completa con ruta UTC e identidades SHA-256, frontmatter `tc_*` estable, seis bloques gestionados verificables y merge que preserva contenido humano.
- Barrera H5.4 write-before-clear mediante Obsidian Vault: conflictos, colisiones no resolubles o fallo de escritura conservan el runtime completo para reintento.
- Presentación H5.5 data-only de botín compartida por nota y Companion, bilingüe, responsive y accesible, con destino exclusivo, valoración total/subtotal y recomendaciones ocultas cuando la evidencia no las permite.
- Selección de clave con `SecretComponent` y resolución mediante `SecretStorage`.
- Cliente mínimo de Guild Wars 2 inactivo hasta una petición explícita.
- Verificación de referencias borradas en `SecretStorage` y validación del perfil de cuenta.
- Migración idempotente a settings v2 con idioma, carpeta segura, personaje, intervalo y modo de detección.
- Comprobación explícita `tokeninfo → account`, permisos requeridos/recomendados y estados de conexión accesibles.
- Transporte resiliente con errores saneados, timeout y reintentos acotados con `Retry-After` o backoff.
- Operaciones que fijan un único secreto efímero, reset A→B y concurrencia deduplicada/latest-wins.
- Cooldown real de rate limit con último estado bueno, countdown y limpieza de timers.
- Validación estricta de carpetas y soporte seguro de subtokens limitados a los endpoints de conexión.
- Modelo `storage_snapshot` discriminado con identidad temporal, ubicaciones, bindings abiertos, metadatos, contenedores equipados, hijos engastados y entregas pendientes.
- Captura GW2 con secreto, identidad y schema fijados, allowlist de subtoken por ruta, fuentes obligatorias/opcionales, cobertura por pasada y límites de concurrencia globales al servicio.
- Consistencia A/B/C con fingerprints canónicos, calidad estable, movimiento de colocación, parcial o inestable.
- Totales separados de objetos disponibles, objetos propios y divisas agregadas con desglose wallet/delivery, sin catálogo, precios ni valoración patrimonial.
- `PublicCatalog` separado del snapshot con cliente sin credenciales para items, currencies y materials, schema/locale fijados, enums abiertos y details útiles para Advisor.
- Batching deduplicado y ordenado de hasta 200 ids, máximo tres peticiones simultáneas, single-flight, parsing aislado y cobertura/avisos semánticos `200/206/404` por id.
- Categorías deduplicadas y warning trazable cuando su membership contradice un holding observado, sin mutar snapshot ni quality.
- Contrato de cache versionado por schema/normalizer y adapter en memoria con TTL por recurso, negativos de una hora y fallback positivo stale de hasta 30 días ante fallos transitorios.
- Clonado estructural de records de cache para impedir que una resolución mutada envenene hits posteriores.
- Fidelidad de suffixes del catálogo: `suffix_item_id` numérico y `secondary_suffix_item_id` string con vacío ausente.
- Persistencia local JSON en IndexedDB versionado, con claves completas, transacciones por operación, limpieza de corrupción, `dispose()` y fallback explícito a memoria.
- Validators normalizados completos para impedir hits con entidades truncadas o tipos/anidados corruptos, y pruebas reales del store con `fake-indexeddb`.
- Comparador puro H2.6 con salida v1, validación runtime e invariantes exactos entre holdings/divisas y sus tres índices agregados.
- Validación relacional de holdings para roster/cobertura, cantidades unitarias y raíces de hijos engastados en la misma ubicación.
- Superficies independientes para items y divisas (`wallet_and_delivery|wallet_only|unavailable`), conservando el delta de items cuando wallet no es comparable.
- Cambios separados de items, currencies, disponibilidad y composición; claims de delivery neutrales y razones/warnings deterministas de cobertura, roster, colocación y límites semánticos.
- Evidencia de frontera H2.7 con proyecciones canónicas de delivery/wallet, cobertura explícita y validación de identidad, ventana y aritmética.
- Clasificador puro de sesión `exact|estimated|contaminated|invalid`, evidencia TP/declarada, prioridad conservadora y permisos de uso del neto.
- Actividad de delivery/wallet condicionada a cobertura completa, compra/venta TP diferenciadas y aumento de wallet resoluble mediante confirmación limpia manual.
- Frontera runtime H2.7 defensiva sobre argumentos `unknown`, variantes estrictas y rechazo del namespace delivery con currency id distinto de `1`.
- Invariantes completas de composición H2.6 en el guard: lados no vacíos/distintos/ordenados, suma conservada segura y estados compatibles con ubicación.
- Coordinador H1.4 de sesión activa con machine id durable, lease cercado, adquisición atómica, recuperación expirada confirmada y CAS exacto en IndexedDB dedicada.
- Fallo cerrado de coordinación sin fallback a memoria ante corrupción, reloj regresivo, overflow, abort, apertura o `versionchange`.
- Idempotencia H1.4 por instancia aunque cambie la intención de sesión, y reloj muestreado dentro de cada operación IndexedDB tras cualquier espera.
- Validación temprana de `instanceId` antes de cualquier apertura/escritura y creación simétrica de identidades de lease.
- Máquina de estados H3.1 pura y versionada para `idle → starting → active → stopping → provisional → complete|error`, con redelivery idempotente y reset terminal.
- Fencing estable en cada transición, referencias comparables a snapshots de frontera, invariantes temporales y preservación del último estado válido en errores recuperables.
- Guards runtime estrictos para estados/eventos de sesión: datos corruptos, captura parcial/inestable, autoridad antigua o transición ilegal fallan sin mutación ni excepción.
- Inicio manual H3.2 desde la vista con personaje, Magic Find declarado, baseline estable y build activo capturados bajo una única clave efímera.
- Heartbeat cercado durante el inicio y la sesión activa, comprobación final del fence y rollback a `idle` con liberación del lease ante cualquier fallo de arranque.
- Estado accesible de sesión en la vista, formulario nativo de Obsidian, mensajes saneados y recomendación del permiso `builds`.
- Cierre manual H3.3 desde la vista con snapshot final estable, delta H2.6, comprobación cercada y transición a `provisional`.
- Reintento seguro de parada tras fallos de captura o delta, conservando baseline y frontera inicial; pérdida de autoridad preservada como error recuperable.
- Recovery H3.4 tras reinicio con record runtime JSON cercado en IndexedDB dedicada, snapshots completos y delta canónico verificable.
- Vista de sesión recuperable con estados busy/error accesibles, acción explícita de recuperación y descarte destructivo confirmado.
- CAS de persistencia por machine/session/fence/instance y `assertOwned` previo a save/clear, sin fallback a memoria en producción.
- Scheduler H3.5 explícito y single-flight para polling API futuro, con intervalo configurable, pausa offline/sleep, `Retry-After`, backoff acotado y descarte de ticks perdidos.
- Adaptación conservadora de errores HTTP saneados a política de scheduler; errores de programación o autenticación fallan cerrados y no generan bucles infinitos.
- Detector H3.6 puro de inicio por items relevantes: dos deltas positivos contiguos producen una propuesta idempotente con intervalo temporal, evidencia completa/limitada y reglas de IDs versionadas.
- Detector H3.7 puro de inactividad: mide silencio contiguo por tiempo, reinicia ante ganancias y solo propone una ventana de fin con incertidumbre y calidad de evidencia.
- Controlador H3.8 de detección asistida: armado/desarmado explícitos, baseline estable previo al polling, estado visible y propuestas de inicio/fin que pausan la captura y requieren acción humana.
- Regla Halloween v1 por id público oficial `36038` (**Trick-or-Treat Bag**), sin depender de nombres localizados ni metadatos de catálogo.
- Integración segura de H3.5–H3.8 con pausa offline/wake, deduplicación de armado, invalidación de capturas tardías y reinicio desarmado al recargar.
- Rebase automático al entrar o salir de una sesión y desarmado al cambiar la credencial, evitando mezclar evidencia anterior al inicio o snapshots de cuentas distintas.
- Contigüidad corregida en H3.6/H3.7: los deltas comparten snapshot fronterizo y admiten el tiempo real no solapado que tarda la captura A/B/C, en lugar de exigir timestamps imposiblemente idénticos.
- Revisión H3.9 de contaminación con preguntas explícitas para aperturas, reciclaje, consumo, fabricación/conversión, bazar, mercader, transferencias y otra actividad.
- Clasificación H2.7 conectada al cierre: limpio confirmado, estimado pendiente o contaminado, sin inferir actividad TP que todavía no se consulta.
- Runtime de sesión v2 con revisión derivada y terminal completo persistentes; migración segura de v1 a `review:null` y rechazo de clasificaciones manipuladas.
- Recarga local de la última sesión completa y borrado explícito antes de empezar otra, sin prometer todavía historial multiparte ni notas.
- Medición H3.10 local e idempotente de fronteras manuales/asistidas con incertidumbre, evidencia y causa en IndexedDB dedicada.
- Corrección explícita de falsos positivos mediante causas cerradas; los descartes de inicio sin sesión también se conservan localmente.
- Resumen visible por sesión con modo manual/asistido/mixto, incertidumbre y correcciones, sin bloquear el motor si la telemetría local falla.
- Contrato H4.1 puro y versionado en cobre para bruto, venta inmediata, listado, mercader y no líquido, con fuente y liquidez explícitas.
- Aritmética monetaria de enteros seguros con rechazo de overflow, tasas inválidas o mayores que el bruto; no líquido usa `null` y no falsos ceros.
- Política H4.2 versionada del bazar: 5% de publicación y 10% de intercambio calculados por separado sobre el total de la pila, con redondeo y mínimo de un cobre por tasa.
- Valor de mercader H4.2 solo para `CatalogItem` válido, `vendorValue` positivo y sin `NoSell`; el binding aislado no se interpreta como prohibición.
- Clasificador H4.3 por pila con rutas TP/mercader separadas, binding observado o derivado, estado de precio explícito y ausencia de valor líquido representada con `null`.
- Pilas account/character-bound, binding desconocido, precio ausente y objetos engastados/equipados nunca reciben valor TP; el mercader solo conserva su suelo probado.
- Captura H4.4 de bid/ask al cierre para cada item ganado mediante `/v2/commerce/prices`, sin credencial, en lotes ordenados de hasta 200 ids.
- Snapshot de precios durable con timestamp, fuente, cantidad ganada y cobertura `complete|partial|unavailable`; errores u omisiones nunca se convierten en precio cero ni bloquean el cierre.
- Runtime de sesión v3 con migración segura de v1/v2 y validación cruzada entre sesión, delta físico e ids/cantidades del snapshot de precios.
- Valoración H4.5 por item con rutas separadas de venta inmediata, listado y mercader, eligiendo el mejor suelo demostrado sin convertir ausencias en cero.
- Totales de sesión reproducibles con moneda neta observada, cantidad no líquida, sacos/h en milésimas y cobre/h; pérdidas, catálogo, binding o precios incompletos quedan como warnings explícitos.
- Esquema H4.6 versionado para modelos de contenedor con fuente, muestra, fechas, resultados, incertidumbre y política de valoración obligatorias.
- Unidades muestrales y esperadas por saco en millonésimas enteras, con orden canónico, claves separadas por namespace y validación reproducible sin floats.
- Modelo H4.7 conservador de Bolsa de truco o trato, fijado a 106.264 aperturas de la revisión wiki `3161313`, con 18 resultados identificados por item id.
- Exclusión explícita de todos los superraros y de la cola rara no respaldada para que ningún jackpot observado infle el valor esperado.
- EV H4.8 conservador por saco en microcobre, separando venta inmediata y listado tras tasas separadas de 5% y 10% con redondeo a cobre, con cobertura independiente por ruta.
- Resultados ligados o excluidos aportan exactamente cero oro líquido; una cotización ausente deja EV total `null` y conserva solo el subtotal conocido.
- Plan de reservas H4.9 puro y versionado sobre objetivos activos y balance final, con asignación exclusiva/determinista, bases `owned|available` revalidables, shortfall y cobertura por namespace explícitos.
- Recomendación H4.10 pura para contenedores: reserva primero, exige clasificación H2.7 v2 exacta/alta, modelo atestado y precios frescos, recompone EV/fees desde evidencia cruda y decide abrir/vender con umbral `BigInt` explicado sin ejecutar ninguna operación.
- Endurecimiento H4.10 contra evidencia trasplantada: recompone review y overlay desde los mismos snapshots/delta, valida identidad antes de `reserved_only` y liga la aprobación al SHA-256 canónico completo del modelo; reviews H2.7 v1 históricos siguen cargables pero no autorizan recomendar.
- Recomputación integral H4.10 de balance y plan desde objetivos + snapshot final, cronología cerrada y coherencia semántica de severidades/solicitudes en clasificaciones H2.7 v2.
- Intenciones H4.11 puras y versionadas: asignación exclusiva por deadline/id sobre la cantidad libre posterior a reservas, liberación por objetivo/cancelación/expiración, protección explícita sin precio y proyección neta H4.2.
- Integración H4.10 de planes H4.11 recomputados contra el mismo overlay y batch: las unidades retenidas conservan procedencia y se excluyen de la economía sin ejecutar ninguna operación.
- Frescura H4.10 validada antes de interpretar intenciones cuando H4.9 deja unidades libres; un batch stale/futuro bloquea y no puede ocultarse como `reserved_only`.
- Envelope H4.12 JSON-only para todos los estados H4.10, marcado siempre manual, sin efectos laterales y con refs internas a reserva, retención, economía o revisión; no existe executor público.
- Guard arquitectónico H4.12 sobre todos los módulos productivos de recomendación, probado en rojo mediante sabotaje con un import de `GuildWars2Client` y restaurado después con contenido/modo exactos.
- Matriz action/route H4.12 cerrada por acción y guard ampliado a imports side-effect, `import()` y `require()` literales, con regresiones de las cuatro sintaxis.
- Contrato H4.13 del Inventory Advisor limitado a `supported_storage_v1`, con inputs identity-bound, catálogo/precios/señales/reglas estrictos, partición cuantitativa por posición y resultado fail-closed.
- Envelope H4.13 específico de inventario, siempre manual y sin efectos laterales; expone `discard_candidate` solo como revisión irreversible ligada a regla curada y no contiene `destroy` ni executor.
- Guard arquitectónico causal sobre la frontera H4.13 contra clientes, red, secretos, stores, Obsidian, capacidades de operación e imports estáticos/dinámicos prohibidos.
- H4.14 captura explícita de evidencia del Inventory Advisor: catálogo para todos los `ownedByItem`,
  cotizaciones públicas H4.4 para todos los `availableByItem`, señales account-wide y wrapper con
  identidad, cobertura y TTL independientes; no añade UI, persistencia ni decisiones.
- Endurecida H4.14: fingerprint SHA-256 sensible al orden físico, TTL de snapshot y timestamps
  canónicos, endpoints privados `requestDetailed`/HTTP 200, `cache_stale` y delivery limitado
  degradados, y guard dinámico contra persistencia, UI, temporizadores u operaciones irreversibles.
- Extraído el parser público de precios H4.4 para que sesiones y evidencia account-wide compartan
  tratamiento de lotes, duplicados, omisiones y bid/ask nulos.
- H4.15 añade el clasificador puro del Inventory Advisor: particiona todas las posiciones propias,
  respeta reservas/excepciones, revisa evidencia desconocida o contradictoria y limita TP a bid depth
  demostrada con tasas H4.2. Knowledge packs V1 hasheados distinguen afirmación positiva de
  `not_applicable`; no se emite `discard_candidate` ni se realizan efectos laterales.
- El contrato H4.13 ahora exige que las decisiones y cantidades de una línea particionen propiedad,
  no solo disponibilidad; sus reglas expresan `applicable|not_applicable`.
- Nuevo guard dinámico H4.15 contra red, UI, Vault, persistencia, temporizadores y operaciones
	irreversibles en todos los módulos productivos del clasificador.
- H4.16 añade una allowlist de descarte pura y separada: reproduce H4.15 de forma canónica, enlaza
	reglas y assertions a fuentes no vacías, y solo emite `discard_candidate` review-only con proof SHA.
- Allowances por intención para items y divisas: una reserva solo habilita de nuevo su uso declarado; evidencia desconocida permanece `null` y nunca se interpreta como cantidad utilizable.
- Builder desde snapshots H2.6 comparables y overlay cuantitativo sobre evidencia H4.5 validada contra delta, política de fees, binding y procedencia de sack IDs, sin mutar ni prorratear valoración, importes, tasas o cobertura.
- Módulos `core`, `account`, `advisor`, `sessions` y `objectives`.
- Fixtures anonimizadas y tests de migración, seguridad, parsers, agregados, cobertura, concurrencia y consistencia.
