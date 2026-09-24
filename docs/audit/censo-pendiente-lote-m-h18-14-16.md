# Censo de observabilidad pendiente — lote M (H18.14 / H18.16)

Propuesta sin aplicar. `scripts/action-observability-baseline.json` no se ha tocado: ningún cambio
de baseline entra en `main` sin la revisión de David.

Medido sobre el mismo árbol (`HEAD` = `3430e65`) antes y después del lote, con
`node scripts/action-observability-census.mjs`:

- Antes (copia exacta de `HEAD` exportada con `git archive`): `19 unreviewed or invalid boundary
  change(s)`, todas de lotes anteriores.
- Después: `25`. Las 6 nuevas son de este lote:

```
- src/advisor/inventory-object-result.ts: new_production_file
- src/inventory/inventory-analysis.ts: new_production_file
- src/inventory/inventory-vault-sync.ts: catch_clause (added)
- src/inventory/inventory-vault-sync.ts: catch_clause (removed)
- src/main.ts: catch_clause (added)
- src/main.ts: catch_clause (removed)
```

Ninguna frontera nueva: los dos `catch` son el mismo código que ya estaba revisado, en otro sitio.

| Fichero | Frontera | Clasificación propuesta | Motivo |
|---|---|---|---|
| `src/advisor/inventory-object-result.ts` | fichero nuevo, 0 fronteras | `production_source` | Modelo común del resultado por objeto (vocabulario, combinación de ruta y momento, fusión de objetivos derivados). Funciones puras y constantes congeladas: sin `catch`, sin `Promise`/`.then`/`.catch`, sin `void` suelto ni registro de callback. Misma razón que los ficheros de cero fronteras ya revisados («Reviewed production TypeScript file; zero-boundary files remain in scope so additions cannot bypass the census.»). |
| `src/inventory/inventory-analysis.ts` | fichero nuevo, 0 fronteras | `production_source` | Servicio de análisis (etapa de momento sobre la evidencia del asesor) y adaptador a la entrada de las notas. Sólo `await` sobre puertos inyectados y `Promise.all` sin `.then`/`.catch`; ningún `catch`, `void` ni callback registrado: un fallo de sus puertos se propaga al `refresh` del asesor, que ya lo registra (`inventory_advisor_refresh`, `span.failure`). Misma razón que arriba. |
| `src/inventory/inventory-vault-sync.ts` | `catch_clause` en `classifyInventoryNote` (removed + added) | `allowlisted`, `reviewed_recovery`, `fallback_return`, scope `classifyInventoryNote` | Es el `catch` que ya estaba revisado alrededor del parseo del frontmatter. Ahora envuelve `splitInventoryFrontmatter` (que separa las claves gestionadas de las del usuario) en lugar de `parseYaml`, y cambia de línea. Mismo comportamiento: una nota ilegible es un conflicto de esa nota (`return { status: 'conflict' }`), nunca se reescribe. |
| `src/main.ts` | `catch_clause` en `readLegendaryArmoryCounts` (removed + added) | `allowlisted`, `reviewed_recovery`, `fallback_return`, scope `readLegendaryArmoryCounts` | El mismo `catch` ya revisado (`id 29575a7d…`): el puerto que lee `GET /v2/account/legendaryarmory` devuelve `null` ante cualquier fallo, y el análisis lo trata como «ningún objetivo forjado todavía», la opción segura. Sólo cambia de sitio: de dentro de `previewInventorySync` al puerto de `InventoryAnalysisService`, que ahora se construye una vez y comparten la vista y las notas. |

El `catch` de `create` en `InventoryVaultSyncService.applyInternal` cambió de cuerpo (una colisión
ya no aborta todo el plan, cuenta un conflicto) pero no de sitio: el censo no lo marca.
