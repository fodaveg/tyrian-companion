# Censo de observabilidad pendiente — H18.5 / H18.20

Propuesta sin aplicar. `scripts/action-observability-baseline.json` se restauró a su estado en
`a2584af` (commit `7a4f0e0`) porque ningún cambio de baseline entra en `main` sin la revisión de
David. `node scripts/action-observability-census.mjs` marca ahora mismo `1 unreviewed or invalid
boundary change(s)` sobre el único fichero de producción nuevo de este lote:

```
action observability census: 1 unreviewed or invalid boundary change(s)
- src/economy/models/halloween-festival-anchors.ts: new_production_file
```

Esta tabla es la propuesta de entrada que añadiría al baseline, una línea por fichero, para que
David la acepte o la corrija antes de aplicarla:

| Fichero | Clasificación propuesta | Fronteras (`catch`/`void`/callback) | Motivo |
|---|---|---|---|
| `src/economy/models/halloween-festival-anchors.ts` | `production_source` | 0 | Módulo de datos curados puro (tabla de anclajes reales de Halloween 2019-2026, con fuente y `sha256`); construye una constante en el ámbito del módulo y valida su forma con `isFestivalAnchorsTable`, sin `catch`, sin `Promise`/`.then`/`.catch`, sin `void` suelto ni registro de callback (`addEventListener`, `setTimeout`, etc.). Mismo patrón exacto que el fichero vecino ya revisado `src/economy/models/halloween-season.ts`, cuya entrada en el baseline usa la misma razón («Reviewed production TypeScript file; zero-boundary files remain in scope so additions cannot bypass the census.»). |

No se ha tocado ningún otro fichero de este lote a raíz de este encargo.
