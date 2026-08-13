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
- An explicit H3.2 manual start flow that captures a stable baseline, active character build,
  manual Magic Find, and timestamps before exposing an active farming session.
- An explicit H3.3 manual stop flow that captures a stable final snapshot, computes the physical
  account delta, rechecks the fence, and leaves the session provisional for later review.
- H3.4 crash/restart recovery backed by a second fail-closed IndexedDB store that preserves the
  full baseline, optional final snapshot, canonical delta, and fenced runtime state.
- H3.8 assisted detection with an explicit arm/disarm control, a stable baseline before polling,
  and visible start/stop proposals that always require a user action.
- H3.9 contamination review for provisional sessions, with explicit activity declarations,
  conservative H2.7 classification, crash-safe local persistence, and a completed-session state.
- H3.10 local detection-quality measurement: each accepted boundary keeps its manual or assisted
  mode, uncertainty and cause, while dismissed proposals keep a structured correction cause.
- A pure H4.1 copper contract for gross, instant-sale, listing, vendor and non-liquid values,
  with explicit liquidity and overflow-safe integer arithmetic.
- A versioned H4.2 Guild Wars 2 fee policy that applies the 5% listing and 10% exchange fees
  to the total stack sale, plus conservative vendor eligibility from validated catalog metadata.
- A strict H4.3 per-stack liquidity classifier that keeps bound, unpriced, embedded, equipped,
  or malformed holdings out of unsupported Trading Post value while retaining proven vendor value.
- H4.4 close-time public Trading Post quotes for gained item IDs, persisted with bid, ask,
  timestamp, source, gained quantity, and explicit missing/unavailable coverage.
- A pure H4.5 session valuation that combines those quotes with catalog and binding evidence,
  keeps non-liquid quantities explicit, and reproduces bags/hour and copper/hour safely.
- A strict H4.6 versioned container-model schema with cited source, dated sample, canonical
  outcomes, integer-millionth expected units, uncertainty, and explicit valuation policy.
- A conservative H4.7 Trick-or-Treat Bag model pinned to a 106,264-bag GW2 Wiki sample;
  every super-rare jackpot and unsupported long-tail outcome is excluded from its future EV.
- A pure H4.8 conservative opening EV with separate instant-sale and listing estimates,
  micro-copper precision, explicit route coverage, and zero liquid value for excluded rewards.

Automatic synchronization, persisted valuation reports, vault writes, unattended detection,
and recommendations are intentionally not implemented yet. Snapshot capture runs from explicit
**Start session**, **Stop session**, or **Arm assisted detection** actions; it describes observed
storage, not total account wealth.

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

Plugin settings store only the selected Obsidian secret name. Recoverable session evidence is kept
machine-locally in IndexedDB, outside settings and vault notes, and contains no API key. The API-key
value is resolved from the vault-local `SecretStorage` only when **Check connection**, **Start
session**, **Stop session**, or **Arm assisted detection** is explicitly selected. Loading the plugin
or opening its view reads only local recovery state and does not make network requests. Assisted
detection always reloads disarmed, pauses offline or after sleep, and never starts or stops a session
without confirmation.
At **Stop session**, the plugin sends only gained numeric item IDs to the official public
`/v2/commerce/prices` endpoint; it does not attach the API key, account, character, or quantities.

The contamination review asks whether containers were opened, items were salvaged or consumed,
crafting/conversion occurred, purchases or sales happened through the Trading Post or vendors,
transfers occurred, or other account activity took place. A declared activity always produces a
contaminated result. “Not sure” remains estimated and provisional. Trading Post history is not queried
yet, so the user declaration is explicit rather than inferred.

Detection-quality observations use a separate local IndexedDB database. They contain session and
proposal identifiers, boundary window and uncertainty, evidence quality, decision and correction cause, but no
API key, item payload or free-text note. If this optional measurement store is unavailable, session
start, stop and proposal dismissal continue to work and the view reports the missing telemetry.

The connection check pins one ephemeral SecretStorage value for the complete operation, calls `/v2/tokeninfo` first, and calls `/v2/account` only after the key grants account access. Changing the selected secret resets prior account state and invalidates any older check still in flight. The UI shows the account name, API-key name, and granted permissions as text, but never shows the token or token ID.

`account` is required for the initial connection; `characters`, `inventories`, `builds`, `wallet`, `tradingpost`, `progression`, and `unlocks` are recommended capabilities and appear as warnings rather than invalidating a key. URL-limited subtokens work when both connection endpoints are allowed, with a warning that future modules remain restricted.

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
before entering a queue. The primitive itself exposes no automatic timer. The H3.2 start workflow
owns a non-overlapping heartbeat while starting and active, checks the current fence immediately
before committing the baseline, and releases the lease on a failed start. H3.3 keeps that heartbeat
through stop and provisional review, captures the final boundary under a new pinned operation, and
checks the current fence immediately before committing it. A transient final-capture or invalid-delta
failure leaves the state at `stopping`, retains the original full baseline in memory, and can be retried
without recapturing the start. A lost fence moves the preserved stopping evidence to `error`.

H3.4 persists every successfully fenced `active`, `stopping`, or `provisional` boundary in the
dedicated `tyrian-companion-session-runtime` IndexedDB database. A later authority error leaves the
last durable boundary available instead of attempting an unfenced write. The record includes the full
baseline and, once available, the full final snapshot plus its recomputed canonical delta. On plugin
load this database is read locally without acquiring a lease or contacting GW2. The view then offers
an explicit **Recover session** action or a confirmed destructive discard. Both must first acquire the
same session lease; recovery requires a strictly newer fence and stale owners cannot save or clear a
newer record. Corruption, unavailable storage, a live owner in another window, and `versionchange`
all fail closed without a memory fallback.

`transitionSession` is the pure H3.1 lifecycle boundary. It retains stable lease authority,
qualified boundary references, and the manual start context, rejects stale fences and malformed or
out-of-order events, and preserves the last valid in-progress state on error. H3.2 orchestrates
`idle → starting → active`; H3.3 continues through `stopping → provisional`; H3.4 restores those
recoverable states after a restart. H3.9 owns contamination review, acceptance, finalization, and
durable session history.

## Project documentation

- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ESTADO.md`](docs/ESTADO.md)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

[MIT](LICENSE)
