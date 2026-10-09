# assets

`hebra-icon.png`: the plugin's own icon in Hebra (the colour drawing of the monster with a single plum
outline), 128x128 RGBA PNG, 23803 bytes, under 32 KiB. The release packaging (`scripts/release-package.mjs`)
embeds it as `iconImage` (`data:image/png;base64,...`) in the generated `hebra.json`, after checking Hebra's
limits on the bytes (PNG, square, 32 to 128 px, 32 KiB). `icon: "sword"` stays as the fallback and is what
Obsidian uses.

Source: `~/Descargas/imagenes-tyrian/monstruo-recorte-limpio.png` (2553x2739, the cut-out without the drawn
line, not in the repo). Variant "C1", chosen by David on 9 Oct 2026 from a sheet of 8 variants; it replaces
variant "B" (black outline + light rim, 8 Oct 2026). At the roughly 18 px at which Hebra's tab bar paints the
icon (estimated from a screenshot, not measured) B's 5 px outline and 3 px rim shrank to about 0.7 px and
0.4 px and were not told apart; David: "creo que la versión con doble borde no funciona". C1 is the drawing in
colour, closer-cropped (120/128), with +45 % saturation, sigmoidal contrast and ONE plum (`#3a1430`) outline of
about 3.5 px. The file is the output of the commands below, bit for bit (sha256
`6a478bd5cd4e1b894c590ecd6f27bf6826476a938ec632c0c1da03fe032fb84e`). Made with (the C1 chain of
`01-base.sh` and `03-variantes.sh` in `~/Descargas/imagenes-tyrian/icono-hebra-variantes-20261009/`, not in
the repo):

```
magick monstruo-recorte-limpio.png -channel A -threshold 40% +channel -trim +repage -resize x1024 base.png
magick base.png -modulate 100,145,100 -sigmoidal-contrast 3x50% -filter Lanczos -resize 120x120 -gravity center -background none -extent 128x128 -strip tmp-C.png
magick tmp-C.png -alpha extract -threshold 30% -morphology Dilate Disk:3.5 -blur 0x0.6 tmp-Cout.png
magick -size 128x128 "xc:#3a1430" tmp-Cout.png -alpha off -compose CopyOpacity -composite tmp-Cplum.png
magick tmp-Cplum.png tmp-C.png -compose Over -composite -strip C1.png
magick C1.png -strip -define png:compression-level=9 C1.png
```

`C1.png` is `hebra-icon.png`. That is: the monster at 120 px, centred in a transparent 128x128, with a plum
outline about 3.5 px wide behind it.
