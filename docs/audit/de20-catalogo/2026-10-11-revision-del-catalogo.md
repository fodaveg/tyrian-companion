# DE-20 · Revisión automática del catálogo de Obsidian (11 oct 2026)

Sobre `main` = `b0ae2112` (0.6.41). Fuentes leídas el 11 oct 2026.

## Lo verificado

- El envío ya no es un PR a `obsidianmd/obsidian-releases`: se hace desde el dashboard de
  community.obsidian.md, que revisa cada versión y ofrece un «preview scan» de cualquier rama, tag o commit
  (https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin; https://obsidian.md/blog/future-of-plugins/, 12 may 2026).
- Las reglas del revisor no están publicadas. Obsidian solo ofrece `eslint-plugin-obsidianmd` para comprobar en local.
  Un hilo del foro (jul a sep 2026) pide publicarlas, sin respuesta oficial.
- `manifest.json` cumple los requisitos documentados: id sin «obsidian», descripción de 62 caracteres, `minAppVersion`
  1.11.4, `isDesktopOnly: true`. LICENSE MIT y README presentes. Tag `0.6.41` sin `v`.
- Medido en el repo (rg sobre `src/` sin tests): 0 `innerHTML`/`outerHTML`/`insertAdjacentHTML` (solo un comentario),
  0 `console.log`, 0 `fetch(`. 7 usos de `.style.` en `src/ui/live-session-panel.ts`, todos `setProperty`/`removeProperty`
  de variables CSS (`--x`, `--y`, `--w`).
- `hebra-plugin-api` es público y el tag `v1.4.0` existe (`61e327e4`).
- `eslint-plugin-obsidianmd`: 0.4.1 en el lockfile; la última publicada es 0.4.2 (24 ago 2026).
- Tamaño de `main.js` en la release 0.6.41: 2.192.573 bytes. No hay límite documentado.

## Sin verificar

- Si el bot ejecuta eslint, con qué config (la suya o `eslint.config.mts` del repo) y sobre qué ficheros (release o
  fuente entero con tests). Si usa su preset sin los overrides del repo, cuentan los 36 avisos de tests (DE-11),
  `dom-polyfill.ts` (DE-10) y `scripts/` (DE-12).
- Si `minAppVersion` 1.11.4 con los typings de `obsidian` 1.13.1 dispara `no-unsupported-api`.
- La fecha del 30 oct 2026 para plugins ya listados solo aparece en fuentes de terceros; la oficial dice «no deadline set».

## Lint con el preset del catálogo, sin los overrides del repo (medido)

`obsidianmd.configs.recommended` (0.4.1 del lockfile) sobre los 840 ficheros de `src/`, sin overrides por carpeta,
frente a `eslint.config.mts`:

| Regla | Preset solo | Config del repo | En `*.test.ts` | En `dom-polyfill.ts` | Producto |
|---|---|---|---|---|---|
| `obsidianmd/prefer-window-timers` | 37 | 0 | 37 | 0 | 0 |
| `obsidianmd/no-global-this` | 15 | 0 | 15 | 0 | 0 |
| `obsidianmd/prefer-create-el` | 16 | 4 | 11 | 1 | 4 |
| Total (avisos; 0 errores) | 68 | 4 | 63 | 1 | 4 |

No sale ningún `no-unsupported-api` ni otra regla de versión mínima. Los 4 avisos de producto, que el catálogo vería
siempre: `src/ui/farming-declared-build-editor.ts:39`, `src/ui/farming-session-panel.ts:44`,
`src/ui/live-session-comparison-panel.ts:32` y `src/ui/live-session-money.ts:38` (`prefer-create-el`).

## Siguiente

1. Preview scan del dashboard sobre el candidato: es la única medición real del bot (lo hace David con su cuenta, 15 a 30 min).
2. Corregir los 4 avisos de producto (`prefer-create-el`), que salen con cualquier config (menos de 1 h).
3. Si el bot mira los tests: corregir los 63 avisos de tests y el de `dom-polyfill.ts` de forma mecánica (2 a 4 h).
