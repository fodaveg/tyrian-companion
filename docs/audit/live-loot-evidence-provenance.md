# Procedencia de la evidencia histórica de lectura de inventario

El [audit del 6 de octubre de 2026](2026-10-06-loot-memory-live.md) y los directorios
`loot-inventory-probe/` y `loot-teb-probe/` se copian **sin cambios de bytes** desde el commit
`5341767f81ae7e3d27c73f9016f11ec3338f17c1` de Tyrian Companion. Fuentes, fixtures y recibos
son documentación de investigación, no código productivo ni parte del paquete. No se copia la
excepción de política de aquella rama: la autorización posterior está en
[PLATFORM_POLICY](../PLATFORM_POLICY.md) y [SPEC-live-loot](../SPEC-live-loot.md).

Los recibos de [inventario](loot-inventory-probe/receipt.json) y [TEB](loot-teb-probe/receipt.json)
conservan sus árboles, comandos, hashes y límites originales. Rutas temporales/worktrees dentro de
esas copias son procedencia histórica que puede no existir en otra máquina; fuentes y salidas
incluidas aquí son evidencia durable. «No integrado» o «contrato pendiente» describen aquel momento,
no una autorización actual. Los recibos no certifican el nuevo árbol documental.

La evidencia es una sonda externa en Fedora con GE-Proton 11-7 sobre el ejecutable SHA-256
`27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c`. Se conservan adquisiciones
observadas con lector v2 y la corrección/baseline v3 con 254 tipos conocidos; no se atribuye al v3 una
adquisición observada con v2. No prueba bootstrap dentro de Nexus, carga del addon, cobertura de
todas las clases de objetos, cartera/MF ni Windows. El lector/transporte y sus consumidores están
implementados en el código candidato según [ESTADO](../ESTADO.md); sus checks y revisiones tienen
evidencia propia. Esta sonda histórica no certifica ese árbol integrado, el gate conjunto ni la QA
real del addon, que siguen pendientes de acreditar.

Esta reconciliación no ejecuta sondas ni accede al juego. Comprueba identidad de bytes frente al
commit de origen y hashes de recibos cuando sus archivos están incluidos. No añade inventario
privado completo ni nuevas capturas. Aceptación productiva: contrato live1 y [QA-MVP](../QA-MVP.md).
