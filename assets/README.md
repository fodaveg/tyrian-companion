# assets

`hebra-icon.png`: the plugin's own icon in Hebra (the monster), 128x128 RGBA PNG, under 32 KiB. The
release packaging (`scripts/release-package.mjs`) embeds it as `iconImage` (`data:image/png;base64,...`)
in the generated `hebra.json`, after checking Hebra's limits on the bytes (PNG, square, 32 to 128 px,
32 KiB). `icon: "sword"` stays as the fallback and is what Obsidian uses.

Source: `~/Descargas/imagenes-tyrian/monstruo-con-borde.png` (2605x2789, about 4 MB, not in the repo).
Made on 8 Oct 2026 with:

```
magick monstruo-con-borde.png -trim +repage -background none -gravity center -resize 120x120 -extent 128x128 -strip -define png:compression-level=9 PNG32:assets/hebra-icon.png
```

The dark outline is part of the drawing; on a dark theme it blends into the background and the pink body is
what shows.
