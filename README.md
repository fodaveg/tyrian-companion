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
- A public catalog resolver for localized item, currency, and material-category metadata,
  with bounded batching, coverage per ID, and a persistent local stale-aware cache.
- A pure `storage_delta` comparator that recomputes net ownership from two qualified snapshots,
  separates gains/losses from availability and composition, and never values or classifies activity.
- A pure H2.7 evidence layer that classifies an observed session net as exact, estimated,
  contaminated, or invalid without prices, API calls, persistence, or recommendations.
- A fail-closed H1.4 active-session lease primitive backed by a dedicated IndexedDB database,
  with durable machine identity, fencing, expiry confirmation, and cross-window CAS semantics.
- A pure H3.1 session lifecycle from idle through provisional review to completion or recoverable
  error, with strict runtime validation and fenced, idempotent transitions.

Automatic synchronization, valuation, vault writes, polling, detection,
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

`PublicCatalogService` accepts a snapshot without modifying it and calls only public `/v2/items`,
`/v2/currencies`, and `/v2/materials` endpoints. Requests use `es` or `en`, the same pinned schema,
sorted batches of at most 200 IDs, and at most three simultaneous requests. It never receives an API
key. Positive item/currency metadata remains fresh for seven days, material categories for one day,
and missing IDs for one hour; transient failures may use positive entries up to 30 days old. Cache
keys and records include both GW2 schema and normalizer versions, so formats cannot be mixed.
The default persistent adapter uses a versioned IndexedDB database in Obsidian's application storage,
outside vault notes and without secrets. It opens only when explicitly requested and falls back to
an in-memory cache when IndexedDB is unavailable or cannot be opened.

`compareStorageSnapshots(before, after)` has no network, cache, UI, or vault side effects. It accepts
only stable snapshots from the same account/schema and a non-overlapping window with complete core
and character coverage. It verifies the snapshot aggregate indexes exactly against the normalized
holdings before recomputing the delta. Wallet is optional: incomplete or asymmetric wallet coverage
makes only the currency surface unavailable while item changes remain usable. When delivery is
complete in both snapshots it compares the combined item surface; coins include delivery only when
wallet and delivery are both complete on both sides. Other coverage combinations produce an explicit
limited surface and deterministic warnings instead of extrapolating missing data.

`buildBoundaryEvidence(before, after)` projects delivery items, delivery coins, and wallet totals at
the session boundary with explicit complete/missing/asymmetric coverage. `classifySessionDelta`
combines that evidence with a v1 storage delta, normalized Trading Post events, boundary certainty,
and an explicit user declaration. Observed or declared outside activity always dominates a clean
claim. Its permissions distinguish showing the observed net, provisional valuation, finalization,
and gross-per-hour eligibility; economic recommendations remain disabled. Both functions are pure
and H3.9 still owns questions, acceptance workflow, and persistence.
Residual delivery or wallet data is never interpreted as activity unless that surface is complete
on both boundaries. A wallet increase remains estimated until a manual clean confirmation resolves
the ambiguity; observed wallet decreases and TP buys/sells remain contamination evidence.
The classifier treats delta and context as untrusted runtime input: malformed nested structures,
unknown variants, invalid arithmetic, or a delivery currency other than coin id `1` return an
invalid classification instead of throwing.

`ActiveSessionLeaseCoordinator` lazily opens `tyrian-companion-coordination`, outside vault notes,
settings, `data.json`, and `SecretStorage`. Acquire is single-flight and idempotent for the same
ephemeral instance: a later session intent receives the already persisted effective lease rather
than replacing it. A different owner sees `busy`; an expired owner is replaced only after a
second observation following the configured confirmation delay, and every recovery increments a
durable fence. Renew, assert, and release use exact lease CAS, so an old handle cannot affect a newer
owner. Storage/open/version/corruption and backwards-clock failures close safely without a memory
fallback. Lease timestamps are sampled inside the IndexedDB operation after waits/opening, never
before entering a queue. The primitive exposes no automatic heartbeat timer and is not yet wired to session UI.

`transitionSession` is the pure H3.1 lifecycle boundary. It retains only stable lease authority and
minimal references to qualified boundary snapshots, rejects stale fences and malformed or
out-of-order events, and preserves the last valid in-progress state on error. It performs no API,
IndexedDB, timer, UI, classification, or vault work; H3.2–H3.4 will own that orchestration.

## Project documentation

- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ESTADO.md`](docs/ESTADO.md)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

[MIT](LICENSE)
