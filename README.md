# Tyrian Companion

Tyrian Companion is a desktop-only Obsidian plugin foundation for bringing Guild Wars 2 account context and planning into a vault.

The current `0.1.0` vertical provides:

- A loadable Obsidian view and the **Open companion** command.
- A secure API-key selector backed by Obsidian `SecretStorage`.
- Module boundaries for account access, advisor readiness, play sessions, and objectives.
- An explicit connection check against Guild Wars 2 `/v2/tokeninfo` and `/v2/account`.
- Validated account and permission summaries without displaying or persisting the token.
- Versioned settings for language, safe output folder, preferred character, polling interval, and detection mode.
- A domain-only `storage_snapshot` capture for characters, account storage, bank, materials,
  and optional wallet/delivery data, qualified by consistency and source coverage.

Automatic synchronization, catalog/cache enrichment, valuation, vault writes, polling, detection,
and recommendations are intentionally not implemented yet. The snapshot service is not wired to UI
or plugin load; it describes observed storage, not total account wealth.

## Requirements

- Obsidian `1.11.4` or newer.
- Desktop Obsidian.
- Node.js `22.20.0` or newer within the Node 22 line, or Node.js `24.12.0` or newer. This matches the engines declared by the locked toolchain.

## Development

```sh
npm install
npm run dev
```

Run the complete local gate with:

```sh
npm run check
```

The production build creates `main.js` in the project root. A distributable release contains `manifest.json`, `main.js`, and `styles.css`.

## Privacy and network behavior

Plugin data stores only the selected Obsidian secret name. The API-key value is resolved from the vault-local `SecretStorage` only when **Check connection** is explicitly selected. Loading the plugin or opening its view does not make network requests.

The connection check pins one ephemeral SecretStorage value for the complete operation, calls `/v2/tokeninfo` first, and calls `/v2/account` only after the key grants account access. Changing the selected secret resets prior account state and invalidates any older check still in flight. The UI shows the account name, API-key name, and granted permissions as text, but never shows the token or token ID.

`account` is required for the initial connection; `characters`, `inventories`, `wallet`, `tradingpost`, `progression`, and `unlocks` are recommendations for future modules and appear as warnings rather than invalidating a key. URL-limited subtokens work when both connection endpoints are allowed, with a warning that future modules remain restricted.

Rate limits create a real cooldown: both connection controls remain disabled and show a live countdown until retry is allowed. Transient failures preserve the last verified account with an explicit stale-data warning.

The storage snapshot service reuses one pinned secret for its complete A/B/C capture and pins every
request to GW2 schema `2024-07-20T01:00:00.000Z`. It requires `account`, `characters`, and
`inventories`; `wallet` and `tradingpost` add optional sources when granted. Embedded upgrades and
infusions and equipped bags count as owned but not as independently available items. Wallet and
delivery currency are aggregated by currency id while retaining source subtotals.

## Project documentation

- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ESTADO.md`](docs/ESTADO.md)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

[MIT](LICENSE)
