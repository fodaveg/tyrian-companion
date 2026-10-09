# assets

`hebra-icon.png`: the plugin's own icon in Hebra (the monster cut out from the original watercolour, with its
five legs whole and a single black outline), 128x128 RGBA PNG, 21448 bytes, under 32 KiB. The release packaging
(`scripts/release-package.mjs`) embeds it as `iconImage` (`data:image/png;base64,...`) in the generated
`hebra.json`, after checking Hebra's limits on the bytes (PNG, square, 32 to 128 px, 32 KiB). `icon: "sword"`
stays as the fallback and is what Obsidian uses.

Source: a NEW cut-out made from the original watercolour, `~/Descargas/imagenes-tyrian/monstruo-original-acuarela.jpg`
(2896x2931, not in the repo). Variant "T1", chosen by David on 9 Oct 2026 ("deja como icono el recorte con el
borde negro"; before that he had asked for "un borde negro que suavice un poco las aristas"). It replaces
variant "C1" (the colour drawing with a plum outline). The outline is ONE black (`#000000`) border: 24 px at the
cut-out's full resolution, and for the icon it is computed apart, 2.5 px at 128 px (the full-resolution one,
scaled down, would measure 1 px). The file is the output of the scripts in
`~/Descargas/imagenes-tyrian/icono-hebra-patas-20261009/` (not in the repo), bit for bit (sha256
`74745a2608a62340ce04b68fc5a07b6d06020fc2d7c950dbcac16b598f21a78c`): `10-recorte.py` (the cut-out),
`12-icono-t1.py` (the icon, `T1.png`) and `11-comprobacion.py` (the check sheet). Its `LEEME.md`, section
"Ronda 3", has the detail.

Limits:

- The tab's icon box in Hebra measures 16 px (18 px in the header, 20 px in settings), measured in Hebra. At
  16 px the outline is 0.3 px and is not read as a line: the gaps between the legs were kept open rather than
  making the outline read.
- The lower part of legs 4 and 5 is reconstructed paint: the grass covered it in the original, so real paint of
  the same leg was cloned there. In the watercolour those stretches are not visible.
