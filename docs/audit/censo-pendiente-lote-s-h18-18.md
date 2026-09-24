# Censo de observabilidad pendiente — lote S (H18.18 y la parte visual de H18.15)

Propuesta sin aplicar. `scripts/action-observability-baseline.json` no se ha tocado y no se ha usado
`--write-baseline`: ningún cambio de baseline entra en `main` sin la revisión de David.

Medido con `node scripts/action-observability-census.mjs`:

- Antes, sobre `a41c1d4` (el árbol tras `git merge --ff-only main`, sin cambios): `31 unreviewed or
  invalid boundary change(s)`, todas de lotes anteriores.
- Después, sobre `5556245`: `34`. Las 3 nuevas son de este lote:

```
- src/main.ts: catch_clause (added)
- src/ui/inventory-advisor-view.ts: void_expression (added)
- src/ui/inventory-advisor-view.ts: callback_registration (added)
```

Los ids salen de `collectActionBoundaryCensus` ejecutado sobre este árbol y sobre una exportación
exacta de `a41c1d4` (`git archive`): son los únicos presentes aquí y ausentes allí. No desaparece
ninguno.

| Fichero | Frontera (id) | Clasificación propuesta | Motivo |
|---|---|---|---|
| `src/main.ts` | `catch_clause` `25c4c5dddc12c0ee0c95c6f50f3f6fdb23ae8831`, en `perform` de `updateManagedAssetsAfterInventorySync` | `allowlisted`, `reviewed_recovery`, `fallback_return`, scope `perform` | Mismo patrón que el `catch` ya revisado de `previewManagedAssets` (`id 1d5f78d2…`): si `managedAssets.inspect` falla (manifiesto corrupto, lectura del Vault), no se escribe nada y devuelve un resultado de fallo cerrado (`unknown_failure` con `unmappedErrorLogDetails`) para que el `localDebugActions.run` que lo envuelve (`managed_assets_apply`, estado `after_inventory_sync`) lo registre. La sincronización de inventario ya terminó y su resultado no cambia. |
| `src/ui/inventory-advisor-view.ts` | `void_expression` `9aefaa2cb7e216b4534fd541c6cd48599eb3d741`, `interactions.onKeepItem` en `mountInventoryAdvisorView` | `allowlisted`, `reviewed_detached_execution`, target `interactions.onKeepItem`, scope `onKeep` | Igual que los `void` ya revisados de `interactions.onUpsertKeepException` y `onLoadPreferences`: el botón «Conservar» de la fila desacopla la operación nombrada. El host (`InventoryAdvisorItemView.keepItem`) la ejecuta dentro de `runPreferenceAction` y las escrituras pasan por `InventoryPreferencesRuntime`, cuyo `write` ya abre el span `inventory_preferences_write` y registra su fallo. |
| `src/ui/inventory-advisor-view.ts` | `callback_registration` `ddbcca46da5b0b2b2fff9d4ad1ea524b2d3b073f`, `addEventListener` en `keepControl` | `allowlisted`, `reviewed_registered_callback`, registration `addEventListener`, scope `keepControl` | Callback de clic del botón «Conservar», como los ya revisados de `renderRecommendationSummary` y `renderPreferenceEntries`: sólo llama a `onKeep` del contexto de la fila, que es la frontera anterior. |

Ficheros de producción nuevos: ninguno. Los demás cambios (`storage-space.ts`,
`material-storage-deposit-validation.ts`, `inventory-analysis.ts`, `inventory-object-result.ts`,
`inventory-advisor-presentation.ts`, `managed-assets-model.ts`, `inventory-advisor-item-view.ts`)
no añaden `catch`, `.catch`, `void` suelto ni registro de callback que el censo cuente. En
`inventory-advisor-item-view.ts`, `keepItem` sólo hace `await` sobre la sesión de preferencias.
