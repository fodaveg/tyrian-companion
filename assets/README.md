# assets

`hebra-icon.png`: the plugin's own icon in Hebra (the monster with a dark outline and a light rim), 128x128
RGBA PNG, 20063 bytes, under 32 KiB. The release packaging (`scripts/release-package.mjs`) embeds it as
`iconImage` (`data:image/png;base64,...`) in the generated `hebra.json`, after checking Hebra's limits on the
bytes (PNG, square, 32 to 128 px, 32 KiB). `icon: "sword"` stays as the fallback and is what Obsidian uses.

Source: `~/Descargas/imagenes-tyrian/monstruo-recorte-limpio.png` (2553x2739, the cut-out without the drawn
line, not in the repo). Variant "B: black + light rim", chosen by David on 8 Oct 2026 because the 1 px drawn line
of the 0.6.11 icon was not visible at icon size and blended into a dark theme. Made with:

```
magick monstruo-recorte-limpio.png -trim +repage -background none -gravity center -resize 100x100 -extent 128x128 PNG32:base.png
magick base.png -alpha extract -morphology Dilate Disk:5 negro.mask.png
magick base.png -alpha extract -morphology Dilate Disk:8 blanco.mask.png
magick -size 128x128 xc:'#141414' negro.mask.png  -alpha off -compose CopyOpacity -composite PNG32:negro.png
magick -size 128x128 xc:'#f4f1ea' blanco.mask.png -alpha off -compose CopyOpacity -composite PNG32:blanco.png
magick blanco.png negro.png -compose Over -composite base.png -compose Over -composite -strip -define png:compression-level=9 PNG32:hebra-icon.png
```

That is: the monster at 100 px, a black (`#141414`) 5 px outline and a light (`#f4f1ea`) 3 px rim outside it,
centred in a transparent 128x128.
