# H18.31 · Boceto de interfaz: ficha

Boceto para que David lo apruebe antes de implementar. No toca `src/`. Abre `boceto.html` en un
navegador: cada lámina sale en el panel lateral (320 px) y en el central (860 px) con el mismo HTML, y
arriba se cambia el tema (claro, oscuro o el del sistema) y el ancho.

- **Base medida:** `main@a2584af` (0.1.35), igual que `origin/main` al empezar.
- **Fuente:** auditoría final consolidada del 24 sep 2026, §3.A, §3.C, §3.D, §3.E, §6 y §9, y las
  decisiones de David de ese día.
- **Modo componente.** Solo se usan variables de Obsidian y piezas de `styles.css`: tarjeta de sesión,
  cifras, cajones, callout nativo, patrón `aria-pressed` y cortes de contenedor 759, 520, 479 y 400. Las
  piezas nuevas van marcadas `NUEVO` en la capa 2 del CSS del boceto. La capa 1 imita a Obsidian y no
  se implementa.

## Pantallas y estados

| Área | Lámina | Estados |
|---|---|---|
| Recorrido | 1 | Tres pestañas con `tablist` funcional (flechas, Inicio, Fin) |
| Sesiones | 2.1 | En curso en el Laberinto, avisos «enviado» frente a «recibido» y «sin confirmación» |
| Sesiones | 2.2 | Espera de cierre de 10 min con progreso y recorrido de 4 pasos |
| Sesiones | 2.3 | Fallo tras la espera con reintento automático y «Reintentar ahora»; variante con la nota sin guardar |
| Sesiones | 2.4 | Sin señal del juego y cierre a los 10 min |
| Sesiones | 2.5 | Sin sesión, historial con «valor conocido de 12» y «2 sin valorar», y comparación separada por calidad y actividad |
| Inventario | 3.1 | Poco espacio con 9 objetos reales: reservas completas, parciales, repartidas e inciertas; sin precio; histórico viejo; materiales por encima de 250; icono caído. «Conservar» por fila |
| Inventario | 3.2 | Espacio de sobra, análisis antiguo, analizando y fallo sin códigos |
| Venta | 4.1 | Saco con la comparación real de 7 temporadas y «sin ventaja demostrada»; barra de caramelo con ventana sugerida; colmillos sin comparación posible; aviso de caducidad |
| Venta | 4.2 | datawars2 caído y reglas de festival caducadas |

## Checklist de 7 ejes

| Eje | Estado | Qué cubre / qué falta |
|---|---|---|
| Tokens | **Cubierto** | Cero colores fijos en la capa 2: todo son variables de Obsidian. Una sola variable propia (`--tyrian-action-mark`), local a la insignia de acción, como `--tyrian-figures`. Contraste medido con los valores por defecto de Obsidian 1.x (aproximados): `--text-muted` 6,69:1 en claro y 7,95:1 en oscuro. Falta probarlo con los temas de David. |
| Componentes y estados | **PARCIAL** (falta la sesión manual iniciada a mano y la corrección de hora abierta) | Fallo tras la espera, nota sin guardar, caducidad (12 nov, 1 dic y 10 dic), desconexión, antigüedad del análisis, analizando, datawars2 caído, sin precio e histórico viejo. «Corregir hora» aparece como enlace, pero su formulario no está dibujado. |
| Responsive | **Cubierto** | Mismo DOM a 320 y a 860 px. La lista de inventario usa `subgrid`: 6 columnas en ancho y bloque apilado por debajo de 760 px, sin tabla y tarjetas a la vez. El historial esconde columnas con `.is-wide`. El gráfico se dibuja a su anchura real en píxeles. |
| Accesibilidad | **PARCIAL** (falta pasar un lector de pantalla real en Obsidian) | `tablist` con tabindex itinerante. Gráfico enfocable, con flechas, lectura en `aria-live` y tabla alternativa. `meter` nativo para el espacio. Calidad y acción con forma y palabra, no solo color. Títulos de callout en color de texto: el naranja por defecto da 2,95:1. Botones de 30 px, por encima del mínimo de 24 px, sin forzar 44 px fuera de `.is-mobile` (SPEC-paneles-sin-prosa). |
| Contenido real | **Cubierto** | IDs y nombres reales (36038, 47909, 36059, 43320 y los materiales de SPEC-recomendacion-por-objeto). Backtest real del saco. Las cifras que son ejemplo van subrayadas en el boceto. Sin códigos crudos. |
| Feedback del sistema | **Cubierto** | Una línea de estado por pestaña. El recorrido de 4 pasos (pedido, recibido, leído, guardado) es el mismo en cierre, avisos y análisis. «Guardado» por fila al conservar. |
| Assets | **PARCIAL** (falta el icono real del CDN) | El boceto no carga red: todos los iconos de objeto son el sustituto con iniciales. El icono caído va con borde discontinuo. Los iconos de interfaz son trazos tipo Lucide, como `setIcon`. |

## Decisiones mías (se pueden tumbar)

1. Pestaña «Venta», no «Oportunidades de venta», porque en 320 px no cabe. Ajustes pasa a icono porque
   abre un modal y no es un panel.
2. Una línea `role="status"` bajo las pestañas: es el único sitio donde el panel dice qué leyó y cuándo.
3. Recorrido de 4 pasos como componente común, sin botón «Cerrar ya» durante la espera.
4. El código de error solo se copia al portapapeles con «Copiar detalle técnico»; en pantalla no aparece.
5. En el Laberinto, «Avisos» es el primer cajón; el resto del año lo es «Botín». Cambia el orden fijo de
   la FICHA de la tarjeta.
6. El historial va debajo de la tarjeta, visible sin sesión y leído al abrir la pestaña (pregunta 2).
7. Acciones con una marca lateral de color y el texto en `--text-normal` (pregunta 4).
8. «Conservar» no mueve la fila hasta el siguiente análisis (pregunta 5).
9. «Poco espacio» son las bolsas de todos los personajes más el banco, con umbral de 20 huecos (pregunta 3).
10. «Renovar las reglas con una versión nueva del plugin» es un supuesto sobre cómo viaja el conocimiento
    curado.

## Lo que el boceto no decide

- La cifra de ventaja de la barra de caramelo es de ejemplo: la auditoría solo midió el saco desde la
  fecha de decisión.
- «Riesgo de no vender» sale como «sin medir» porque no hay datos de profundidad.
- El 47909 se enseña con el nombre de la API en español, «Barra de caramelo»; David lo llama «la
  mazorca».
