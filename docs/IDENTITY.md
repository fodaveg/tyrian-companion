# Identidad de release

## Decisión H7.1

La identidad estable del MVP es:

| Campo | Valor |
| --- | --- |
| ID de plugin | `tyrian-companion` |
| Nombre visible | **Tyrian Companion** |
| Autor público | **David** |
| Repositorio elegido | `fodaveg/tyrian-companion` |
| Licencia | MIT |
| Superficie | Plugin de Obsidian solo para escritorio |

El repositorio de GitHub permanece **PRIVATE** durante la preparación del candidato. H7.1 fija su
identidad, pero no lo publica: cambiar la visibilidad o crear una release pertenece al gate humano de
H7.9. `package.json`, `manifest.json`, `LICENSE`, el encabezado del README y esta decisión quedan
ligados por `npm run release:identity-contract`.

## Comprobación de colisión

Comprobación realizada el **2026-08-16** con comparación exacta, case-insensitive, tanto del ID
`tyrian-companion` como del nombre `Tyrian Companion`:

- Registro activo oficial `community-plugins.json`, commit
  [`4ddd58d8a2f092365a818b528a7cfe0e0d380373`](https://github.com/obsidianmd/obsidian-releases/blob/4ddd58d8a2f092365a818b528a7cfe0e0d380373/community-plugins.json): **0 coincidencias**.
- Registro oficial de retirados `community-plugins-removed.json`, commit
  [`6f8608b75d7800a861b05765d3e34a56b5342c37`](https://github.com/obsidianmd/obsidian-releases/blob/6f8608b75d7800a861b05765d3e34a56b5342c37/community-plugins-removed.json): **0 coincidencias**.

El resultado demuestra ausencia de colisión en esas revisiones, no reserva futura del nombre. La
comprobación debe repetirse inmediatamente antes de H7.9 y H7.10, porque los registros cambian.

## Licencia y privacidad del repositorio

MIT permite usar, copiar, modificar, fusionar, publicar y distribuir el código conservando el aviso
de copyright y la licencia. GitHub detecta el fichero `LICENSE` actual como **MIT License**.

El repositorio no contiene claves API, identidad de cuenta o personaje, inventarios/snapshots reales,
rutas personales ni contenido del vault. El gate ejecuta `npm run security:scan` sobre ficheros
tracked y untracked no ignorados, además de los guards de fixtures, soporte y paquete. Este control es
obligatorio pero no sustituye la revisión del historial Git ni autoriza publicar: esa auditoría y el
cambio de visibilidad pertenecen a H7.9.
