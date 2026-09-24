# Censo de observabilidad pendiente — lote T (H18.19)

Propuesta sin aplicar. `scripts/action-observability-baseline.json` no se ha tocado: ningún cambio
de baseline entra en `main` sin la revisión de David.

Medido sobre el mismo árbol (`HEAD` = `a41c1d4`) antes y después del lote, con
`node scripts/action-observability-census.mjs`:

- Antes (el árbol limpio en `a41c1d4`, antes del primer cambio): `31 unreviewed or invalid boundary
  change(s)`, todas de lotes anteriores.
- Después: `32`. La nueva es de este lote:

```
- src/economy/sell-or-wait.ts: new_production_file
```

Ninguna frontera nueva. El cambio de `main.ts` (la semilla de datawars2 de un objeto del calendario
guarda todo su histórico) está dentro del callback `fetchSeed` que ya existía y el censo no lo marca.

| Fichero | Frontera | Clasificación propuesta | Motivo |
|---|---|---|---|
| `src/economy/sell-or-wait.ts` | fichero nuevo, 0 fronteras | `production_source` | Comparación vender ahora frente a esperar (H18.19): ejecuta el experimento de `sell-timing-experiment.ts` con la distancia de hoy al festival y convierte su veredicto fuera de muestra en cobre neto para la cantidad libre. Funciones puras y constantes congeladas: sin `catch`, sin `Promise`/`.then`/`.catch`, sin `void` suelto ni registro de callback, sin red ni almacenamiento. Misma razón que los ficheros de cero fronteras ya revisados («Reviewed production TypeScript file; zero-boundary files remain in scope so additions cannot bypass the census.»). |
