# Censo de observabilidad pendiente — «Copiar token» del puente con el juego, 0.2.1 (24 sep 2026)

Propuesta aplicada en esta misma entrega: David autorizó cerrarla sin más consultas. Se fusionó en
`scripts/action-observability-baseline.json` por id, con el procedimiento de `09bf701` y sin
`--write-baseline`.

Medido con `node scripts/action-observability-census.mjs`:

- Antes, sobre `d16f751` (el árbol tras `git merge --ff-only main`, sin cambios): `PASS`.
- Después de los cambios de código y antes de tocar el baseline: `4 unreviewed or invalid boundary
  change(s)`, las 4 de este lote:

```
- src/main.ts: catch_clause (added)
- src/main.ts: catch_clause (added)
- src/main.ts: void_expression (added)
- src/ui/alert-ingame-secret-modal.ts: new_production_file
```

Los ids salen de `collectActionBoundaryCensus` ejecutado sobre este árbol: son los únicos de los
ficheros tocados que el baseline de `d16f751` no conocía. No desaparece ninguno. El `callee`, el
`target` y el `scope` de cada fila son los que el propio censo deriva del AST
(`reviewActionBoundaryCensus`).

| Fichero | Frontera (id) | Clasificación propuesta | Motivo |
|---|---|---|---|
| `src/main.ts` | `catch_clause` `8ffd63fd85f8d623760a5fd62f8ca777a394080c`, `catch` de `deliver` en `copyAlertIngameSecret` (el portapapeles rechaza la escritura) | `observed`, `direct_observability_call`, callee `this.localDebugActions.event` | Igual que los `catch` ya observados por la misma llamada en `main.ts` (`383ca882609399c8b6c9fd252df942b03f7e14c5`, `bc19fdc56fad8844121580d0613f6ec3555a5dbb`, `e4b8418d4208d9e253dd918649efd374644ebb6f`): registra el rechazo (`command_execute`, `ingame_secret_copy`, `warn`, `unavailable`) con la clase del error y nada más, y abre el modal de respaldo. |
| `src/main.ts` | `catch_clause` `2bea4f2df49619389e4c32b990977291cbba62a2`, `catch` de `copyAlertIngameSecretFromCommand` | `observed`, `direct_observability_call`, callee `this.emitNotice` | Igual que los `catch` ya observados por `this.emitNotice` (`7618764ce65f9160a87ee4828ec64a99be16cb6d`, `3a1e16d3194bb5f3bf073e9ef671d20de868bd08`): el aviso es fijo («No se pudo copiar el token.»), y el fallo ya lo registra `copyAlertIngameSecret` dentro de `localDebugActions.run`, lo mismo que asume el `catch` del botón en `src/ui/settings-tab.ts` (`eb533c800eabc8d12da19019e34a0e7c7a30e0ca`). |
| `src/main.ts` | `void_expression` `b5a0a22c17b99ae33a507b285567573814f3ca25`, `this.copyAlertIngameSecretFromCommand` en el `callback` del comando | `allowlisted`, `reviewed_detached_execution`, target `this.copyAlertIngameSecretFromCommand`, scope `callback` | Misma plantilla que el `void` ya revisado de `this.ingameSessionMarker.reconcile` (`f210ad400edaf7ee949b637a49491c31f1ffc81b`), cuya operación nunca rechaza: `copyAlertIngameSecretFromCommand` atrapa todo fallo de `copyAlertIngameSecret` y lo avisa con `emitNotice`, la frontera de la fila anterior. |
| `src/ui/alert-ingame-secret-modal.ts` | `new_production_file`, 0 fronteras | `production_source` con el motivo estándar de fichero sin fronteras | Igual que `src/economy/sell-or-wait.ts` en `b69d99a`: el modal no registra callbacks, no desacopla nada y no tiene `catch`. |

Los demás cambios (`settings-tab.ts`, `i18n.ts`, `i18n-runtime-catalog.ts`, `styles.css`) no añaden
`catch`, `.catch`, `void` suelto ni registro de callback que el censo cuente. El registro del comando
(`this.addCommand({ callback })`) no aparece como `callback_registration`: el censo no lo cuenta
cuando el callback va como propiedad de un objeto, y su único efecto es el `void` de la tercera fila.

Aplicación: en `src/main.ts` y `src/ui/settings-tab.ts` (los ficheros tocados con fronteras) la
entrada se reconstruye desde el AST, con la decisión de cada id ya conocido copiada tal cual y solo
los localizadores actualizados; `settings-tab.ts` no gana ni pierde ninguna frontera, solo se
desplazan sus líneas. El resto de ficheros se copia verbatim del baseline. Totales recalculados:
`catch_clause` 464 → 466, `void_expression` 94 → 95. Después: `node
scripts/action-observability-census.mjs` da `PASS` y `node
scripts/tests/probar-action-observability-census.mjs` también.
