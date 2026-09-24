# QA manual del MVP

## Estado y alcance

Este protocolo cubre H6.8/H6.9 y recoge las dieciséis pruebas de aceptación de la sección 8 de la auditoría final consolidada del 24 de septiembre de 2026.

**Estado: ejecución humana pendiente.** Una guía preparada no acredita una prueba superada. Estas pruebas aún no se han ejecutado.

## Precondiciones comunes

Para todas las pruebas:

1. Crear una bóveda **desechable** nueva. No abrir, copiar ni modificar la bóveda canónica.
2. Instalar el candidato y anotar: versión de Tyrian Companion (de `manifest.json`), SHA-256 del commit, versión de Obsidian, sistema operativo y plataforma (Linux con Proton / macOS con CrossOver / Windows nativo).
3. Crear un secreto de Obsidian con una clave de pruebas (`account`, `characters`, `inventories`, `builds` como mínimo).
4. Configurar una carpeta de salida portable.
5. Registrar timestamps en UTC. Conservar solo: rutas de notas, SHA-256 de ficheros, estado visible, versiones y capturas sin secretos.

Para cada prueba: marcar `PASS` solo tras observar el resultado esperado. Marcar `FAIL` si aparece error inesperado o control bloqueado.

---

## Pruebas de aceptación (año normal)

### Prueba 1: Reservas

Verificar que el inventario y el asesor distinguen cantidad libre de reservada, objetivos solapados y objetivos sin tabla de recursos.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Objeto completamente reservado no aparece para vender.
- Objeto parcialmente reservado muestra cantidad libre vs. reservada por separado.
- Objetivo sin tabla se marca como incompleto, no se inventa capacidad.

---

### Prueba 2: Precios

Verificar que el precio histórico y el de hoy se distinguen por fecha, que una serie plana no se etiqueta como oportunidad, y que precio hundido no obliga a vender sin motivo.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Histórico y precio actual llevan fechas distintas.
- Serie plana puede dar «vender ahora» solo si esperar no tiene ventaja demostrada, nunca como «oportunidad excepcional».
- «Precio desconocido» se muestra como tal, no como cero.
- Precio hundido dentro de ventana de temporada no obliga a vender; es una opción si hay motivo.

---

### Prueba 3: Fallos del cierre

Verificar que una sesión se recupera de fallos antes y después de guardar, y que dos ventanas no crean sesión duplicada ni sobrescriben.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Reintentar cierre genera una sola nota (sin duplicar).
- Segunda ventana recibe error de sesión activa (lease/mutex bloquea).
- No hay sobrescrituras ni corrupción.

---

### Prueba 4: Suspensión

Verificar que suspender equipo durante sesión no mata la sesión al reactivar.

**Plataforma:** Linux con Proton (primaria) o macOS si suspensión disponible.

**Resultado esperado:**
- Sesión no se pierde tras suspensión.
- Recovery aparece si Obsidian se cerró, pero no borra sesión automáticamente.
- Cierre y guardado funcionan sin error.

---

### Prueba 5: Sesión manual año normal

Verificar que una sesión de 60+ minutos en mapa normal se clasifica, aparece en historial y en comparación de rendimiento, separada por calidad.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Nota guardada en `<output>/sessions/<year UTC>/`.
- Historial la cuenta como manual con su calidad.
- Total muestra cuántas sesiones quedan sin valorar si alguna falta valor.

---

### Prueba 6: Dos sesiones con detección rearmada

Verificar que tras completar sesión, detección se reactiva tras comprobar conexión sin requerir comprobar a mano.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Tras guardar sesión, detector se rearma solo al comprobar conexión.
- Proposición de segunda sesión requiere comprobar conexión si no se armó tras primera.
- Sin falsas propuestas de fin fuera del mapa 866.

---

### Prueba 7: Atribución

Verificar que delta no confunde traslado A→B con ganancia, movimiento entre ubicaciones, compra TP/NPC.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Conversión A→B solo cuenta delta neto de B.
- Traslados entre ubicaciones → `estimated`, no `contaminated`.
- Compras TP → observadas y declaradas.
- Compras NPC → resta pero sin contaminar.

---

### Prueba 8: Inventario sin espacio

Verificar que capacidad desconocida se etiqueta, y que materiales por encima de 250 se muestran con mínimo observado.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Capacidad desconocida se etiqueta explícitamente.
- Mínimo observado no bloquea decisiones; se separa lo conocido de lo asumido.

---

### Prueba 9: Resincronizar

Verificar que ejecutar Preview/Sync sin cambios no reescribe notas; precio nuevo sí.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Sin cambios → sin modificación de ficheros.
- Precio nuevo → actualización de notas.
- Texto tuyo se conserva.

---

### Prueba 10: Fronteras de fecha

Verificar que caducidades se declaran (asesor a 12 nov, conocimiento a 1 dic, legendarias a 10 dic) y que sesiones en esas fechas funcionan.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- 13 nov: asesor degrada.
- 1-2 dic: conocimiento caducado marcado.
- Caducidades no rompen flujo.
- Sesiones se guardan con fecha y aviso.

---

## Pruebas de aceptación (Halloween)

### Prueba 11: Drop que se queda frente a consumido

Verificar que delta distingue drop que permanece de drop que se consume **entre dos lecturas de la API**: un objeto que entra y se gasta entre polls no aparece en ninguna captura.

**Plataforma:** Linux con Proton con Laberinto disponible.

**Resultado esperado:**
- Sacos abiertos: se restan si se ven en ambas capturas.
- Sacos que desaparecen entre capturas: se documenta como «no detectado en cambio siguiente».
- Nota declara cobertura y limitación.

---

### Prueba 12: Laberinto

Verificar que al entrar al juego se marca sesión automáticamente, al entrar al mapa 866 se etiqueta Laberinto, se cierra al salir o tras 10 min desconectado, drop >5 oros se ve en juego midiendo retraso real, y reinicio Obsidian no silencia avisos siguientes.

**Plataforma:** Linux con Proton + Nexus (primaria); Windows con Blish para compañeros.

**Resultado esperado:**
- Sesión automática sin clic manual.
- Etiqueta Laberinto en nota.
- Drop >5 oros registrado.
- Cierre tras 10 min desconectado o salida del mapa.
- Reinicio Obsidian no silencia avisos siguientes.
- Retraso de entrega medido (típicamente 5–20 min por caché API).

---

### Prueba 13: Puente

Verificar reinicio del puente/addon, conexión muda, dos addons simultáneos, desconexión sin cerrar juego.

**Plataforma:** Linux con Proton + Nexus; Windows con Blish.

**Resultado esperado:**
- Reinicio addon no pierde sesión.
- Conexión muda no cuenta como entregado.
- Dos addons no duplican sesión.
- Desconexión red se recupera sin bloqueo.

---

### Prueba 14: Windows con Blish

Verificar que compañeros en Windows con Blish HUD ven sesión automática de principio a fin y aviso visible.

**Plataforma:** Windows x64 con Blish HUD.

**Resultado esperado:**
- Sesión automática en Windows igual que Linux.
- Blish muestra aviso con retraso <20 min.
- Nota se genera correctamente.

---

### Prueba 15: Obsidian cerrado

Verificar que al entrar al juego con Obsidian cerrado, addon abre Obsidian automáticamente.

**Plataforma:** Linux con Proton + Nexus (primaria); Windows con Blish (más directo).

**Resultado esperado:**
- Obsidian se abre automáticamente.
- Sesión se marca sin intervención.
- Nota se genera correctamente.

**Nota:** Aún no probado en Linux con Flatpak + Proton.

---

### Prueba 16: Venta del saco

Verificar que recomendación de saco (36038) usa datos frescos, puede dar «sin ventaja para esperar», incluye banda de incertidumbre.

**Plataforma:** Linux con Proton (primaria).

**Resultado esperado:**
- Recomendación lleva fecha de decisión y precio hoy.
- Comparación es cuantificada, no un calendario fijo.
- «Sin ventaja demostrada» es válido, no fecha inventada.
- Se muestra incertidumbre y años en muestra histórica.

---

## Medición de línea base (pendiente)

Estos límites se miden **después** de línea base ejecutada, **no antes**:
- Retraso entre drop en juego y aviso en juego.
- Número de clics para completar sesión.
- Tiempo de carga de vistas.
