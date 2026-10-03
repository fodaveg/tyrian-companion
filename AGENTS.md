# Release BRAT

Antes de dar por cerrada una release para BRAT:

- El nombre de la GitHub Release, su tag y `manifest.version` deben ser exactamente iguales.
- La release publicada debe pasar `npm run release:brat-verify` sobre la salida real de
  `gh release view`; también debe adjuntar, completamente subidos y no vacíos, exactamente los ocho
  assets documentados en `docs/BETA.md` (los cinco de Obsidian y los tres del plugin de Hebra:
  `hebra.json`, `hebra-main.mjs` y `hebra-styles.css`).
- GitHub puede tardar entre 5 y 15 minutos en servir la release a BRAT; ese margen no demuestra un
  fallo ni una instalación correcta.
- Hasta verificar instalación y carga en el cliente BRAT/Obsidian real, informa únicamente:
  «canal publicado; instalación/runtime pendiente».
