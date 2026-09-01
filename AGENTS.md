# Release BRAT

Antes de dar por cerrada una release para BRAT:

- El nombre de la GitHub Release, su tag y `manifest.version` deben ser exactamente iguales.
- La release publicada debe pasar `npm run release:brat-verify` sobre la salida real de
  `gh release view`; también debe adjuntar, completamente subidos y no vacíos, exactamente los cinco
  assets documentados en `docs/BETA.md`.
- GitHub puede tardar entre 5 y 15 minutos en servir la release a BRAT; ese margen no demuestra un
  fallo ni una instalación correcta.
- Hasta verificar instalación y carga en el cliente BRAT/Obsidian real, informa únicamente:
  «canal publicado; instalación/runtime pendiente».
