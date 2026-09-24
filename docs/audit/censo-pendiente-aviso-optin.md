# Censo de observabilidad pendiente — aviso opt-in del histórico de precios (24 sep 2026)

Propuesta sin aplicar. `scripts/action-observability-baseline.json` no se ha tocado y no se ha usado
`--write-baseline`: ningún cambio de baseline entra en `main` sin la revisión de David.

Medido con `node scripts/action-observability-census.mjs`:

- Antes, sobre `24462bb` (el árbol tras `git merge --ff-only main`, sin cambios): `24 unreviewed or
  invalid boundary change(s)`, todas de lotes anteriores.
- Después, sobre `2e19b69`: `28`. Las 4 nuevas son de este lote:

```
- src/ui/inventory-advisor-view.ts: callback_registration (added)
- src/ui/inventory-advisor-view.ts: void_expression (added)
- src/ui/inventory-advisor-view.ts: callback_registration (added)
- src/ui/inventory-advisor-view.ts: void_expression (added)
```

Los ids salen de `collectActionBoundaryCensus` ejecutado sobre este árbol y sobre una exportación
exacta de `24462bb` (`git archive`): son los únicos presentes aquí y ausentes allí. No desaparece
ninguno. El `target` de cada `void` es el que el propio censo deriva del AST
(`reviewActionBoundaryCensus`).

| Fichero | Frontera (id) | Clasificación propuesta | Motivo |
|---|---|---|---|
| `src/ui/inventory-advisor-view.ts` | `callback_registration` `0f891bddbc9ed05e861fe9c813c7185a07679219`, `addEventListener` en `mountInventoryAdvisorView` (botón «Activar histórico de precios») | `allowlisted`, `reviewed_registered_callback`, registration `addEventListener`, scope `mountInventoryAdvisorView` | Igual que los callbacks de clic ya revisados de los botones de sincronización en la misma función (`23b249818deaf71ee13834d344d4620fd7014252` de «Sincronizar inventario», `703c572da7f3e02dc045d412a9df5d94e24a10fc` de «Analizar», `4783209de183b29df657fc9caf42fd87e5453d7d` de «Aplicar»): sólo llama a `interactions.priceHistoryOptIn.onEnable`, que es la frontera siguiente. |
| `src/ui/inventory-advisor-view.ts` | `void_expression` `2cd859dd9c4deb989b40429c284d8ad9a37b2558`, `interactions.priceHistoryOptIn.onEnable` en `mountInventoryAdvisorView` | `allowlisted`, `reviewed_detached_execution`, target `interactions.priceHistoryOptIn.onEnable`, scope `mountInventoryAdvisorView` | Igual que los `void` ya revisados de `interactions.inventorySync.onRun` (`c68574f20462282062ee42a33c82c7cc0a1da1b4`), `onAnalyze` (`97fd163bc7cdb19cb930926f32f66f9ba472d73d`) y `onConfirm` (`b555a47ba61d3563b40a8970dd57826e6768e2f7`): el botón desacopla la operación nombrada. El host (`InventoryAdvisorItemView`) la ejecuta dentro de `runPriceHistoryAction` y llama a `enablePriceHistory`, que es `updateSettings`; `updateSettings` ya corre dentro de `localDebugActions.run` con `component: 'settings'`, `action: 'settings_save'`, que registra su fallo. |
| `src/ui/inventory-advisor-view.ts` | `callback_registration` `81286283cd75b9f98b7d1abf970c7c36448007bc`, `addEventListener` en `mountInventoryAdvisorView` (botón «Ahora no») | `allowlisted`, `reviewed_registered_callback`, registration `addEventListener`, scope `mountInventoryAdvisorView` | Mismo caso que la primera fila: sólo llama a `interactions.priceHistoryOptIn.onDismiss`. |
| `src/ui/inventory-advisor-view.ts` | `void_expression` `5ee19aa48101fdf057037028b5ef52fe7a56eefb`, `interactions.priceHistoryOptIn.onDismiss` en `mountInventoryAdvisorView` | `allowlisted`, `reviewed_detached_execution`, target `interactions.priceHistoryOptIn.onDismiss`, scope `mountInventoryAdvisorView` | Mismo caso que la segunda fila: el host lo ejecuta dentro de `runPriceHistoryAction` y llama a `dismissPriceHistoryOptIn`, que también es `updateSettings` (`settings_save`). |

Ficheros de producción nuevos: ninguno. Los demás cambios (`settings.ts`, `main.ts`,
`inventory-advisor-item-view.ts`, `i18n-runtime-catalog.ts`) no añaden `catch`, `.catch`, `void`
suelto ni registro de callback que el censo cuente. En `main.ts`, `isPriceHistoryOptInOffered` sólo
lee ajustes y `dismissPriceHistoryOptIn` sólo hace `await` sobre `updateSettings`.
