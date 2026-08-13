# Tyrian Companion

Tyrian Companion is a desktop-only Obsidian plugin foundation for bringing Guild Wars 2 account context and planning into a vault.

The current `0.1.0` vertical provides:

- A loadable Obsidian view and the **Open companion** command.
- A secure API-key selector backed by Obsidian `SecretStorage`.
- Module boundaries for account access, advisor readiness, play sessions, and objectives.
- A minimal Guild Wars 2 HTTP client that remains idle until a feature explicitly requests data.

Account synchronization and recommendations are intentionally not implemented yet.

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

Plugin data stores only the selected Obsidian secret name. The API-key value is resolved from the vault-local `SecretStorage` only when an authenticated request is explicitly made. Loading the plugin, opening its view, and checking its readiness do not make network requests.

## Project documentation

- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ESTADO.md`](docs/ESTADO.md)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

[MIT](LICENSE)
