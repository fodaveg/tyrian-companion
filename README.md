# Tyrian Companion

Tyrian Companion is a desktop-only Obsidian plugin foundation for bringing Guild Wars 2 account context and planning into a vault.

The current `0.1.0` vertical provides:

- A loadable, note-independent Obsidian view and the **Open companion** command. Its H5.1 field ledger keeps session phase and elapsed time first, then detector, polling, evidence quality, account and the highest-priority incident; verbose diagnostics remain collapsed.
- H5.2 session controls in the command palette plus one context-sensitive compass ribbon menu: start, finish/retry, review, recover, confirmed discard and confirmed clear reuse the same lifecycle actions as the view.
- H5.3 durable confirmation queue in a dedicated local IndexedDB: assisted proposals survive a closed note or restart, remain data-only in the background, and reappear as a count plus one review summary without notices, notifications, focus changes, or automatic session transitions.
- H5.4 writes a completed session to a vault note before local runtime can be cleared: hashed account/session references, stable `tc_*` frontmatter and verified managed blocks preserve human notes without exposing raw account evidence.
- H5.5 projects completed-session loot once into a data-only bilingual view model shared by the managed note blocks and the responsive Companion ledger; unreliable evidence withholds value and recommendations instead of guessing.
- H5.6 installs a generic Obsidian Base only after an explicit preview/apply action. A versioned manifest and resumable CAS journal distinguish intact, missing, modified, foreign and future assets without scanning or overwriting user files.
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
- A pure H4.9 reservation plan that allocates final owned/available balances across active goals,
  exposes action-specific allowances, and overlays protected gains without changing valuation money.
- A pure H4.10 container disposition engine that protects reservations first, then compares an
  attested opening model with a fresh immediate-sale floor using exact integer thresholds.
- A pure H4.11 user hold-intent allocator that protects a bounded free quantity until a target
  price or deadline and feeds the remaining quantity into H4.10 without performing an operation.
- A strict H4.12 JSON recommendation envelope that labels every decision manual-only and
  side-effect-free, with a mechanical boundary test against I/O dependencies and operations.

Automatic synchronization, persisted valuation/recommendation reports, vault writes, unattended
detection, and recommendation UI or account operations are intentionally not implemented yet. Snapshot capture runs from explicit
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

After committing and before pushing a release, run:

```sh
npm run release:preflight
```

The release preflight requires an attached `HEAD` and an exactly clean
`git status --porcelain`; an upstream is optional. Dirty-state diagnostics expose only counts for
untracked, unstaged, and staged entries, never paths or file contents.
It does not verify semantic change scope or replace the test and CI gates.

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

Pending assisted confirmations use `tyrian-companion-confirmation-queue`, also outside the vault and
without credentials. Enqueue is atomic before polling resumes; claims are fenced by exact operation
and window identity, renewed while the chosen workflow is running, and accepted only after the
existing start/stop workflow succeeds. Pending proposals expire after 24 hours, receipts after 30
days, and background work only refreshes existing status indicators: it never rebuilds the view,
opens a modal, shows a notice, reveals a leaf, focuses a control, or sends an OS notification.

Completed session notes are the only generated vault artifact in this vertical. They live below the
configured output folder in `sessions/<UTC year>/`, use hashed identifiers, and update only `tc_*`
frontmatter plus six hash-verified managed blocks. A collision uses the complete session hash; an
ambiguous or human-modified managed region fails closed and leaves the completed runtime available.

Optional managed assets live below the configured output folder in `Bases/` with ownership recorded
in `Tyrian Companion Assets.json`. Loading the plugin does not inspect or write them. Preview is
read-only; Apply/Repair/Move/Remove are explicit, journaled Vault operations. Modified or foreign
files are preserved, and uninstall moves exact owned files through Obsidian's trash API. A lazy
IndexedDB pointer, namespaced by a SHA-256 vault identity, uses generation and operation state to arbitrate install/move/remove across windows;
settings mirror only the last completed root. H5.6 ships one generic `.base`; themed
Halloween content remains H5.7.

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
and gross-per-hour eligibility. Classification v2 grants recommendation permission only to an
`exact` result with `high` confidence; persisted v1 classifications remain ineligible. Both functions are pure
and H3.9 still owns questions, acceptance workflow, and persistence.
Residual delivery or wallet data is never interpreted as activity unless that surface is complete
on both boundaries. A wallet increase remains estimated until a manual clean confirmation resolves
the ambiguity; observed wallet decreases and TP buys/sells remain contamination evidence.
The classifier treats delta and context as untrusted runtime input: malformed nested structures,
unknown variants, invalid arithmetic, or a delivery currency other than coin id `1` return an
invalid classification instead of throwing.

`createReservationPlan({ goals, balance })` is a pure H4.9 boundary. It considers active goals only,
orders them by priority and stable identifiers, and allocates each item or currency exactly once from
the final owned and available pools. Each allocation retains its `owned|available` basis and can be
revalidated against both pools. Namespace coverage proves a missing ID is zero when its surface is
complete, while unknown evidence blocks the affected allowances instead of inventing a usable
quantity. `buildReservationBalance(snapshot)` accepts only a comparable H2.6 snapshot and preserves
delivery/wallet coverage. The optional H4.5 overlay validates routes, totals and rates before it
partitions gained item quantities into protected and eligible actions, retaining the original
valuation unchanged. Callers provide the exact sorted sack IDs so bags/hour cannot be forged, and
the same authoritative H2.7 delta validator rejects malformed reasons or composition. Its standalone
validator checks internal quantity invariants, but intended-use
provenance must be checked with the reservation plan that created it. Allocations retain goal reason
as well as basis and intended use so a later decision can explain protected quantities. H4.9 has no
persistence, UI, prices or API calls.

`recommendContainerDisposition(input)` is the pure H4.10 policy boundary. It validates the complete
before/after snapshots, delta and derived H3.9 review, derives the final H4.9 balance, rebuilds the
plan from the supplied goals, and then recomputes the overlay from that same delta, plan and sack-ID
set before intersecting the liquidation/open allowances. Account,
session and final-snapshot identity is checked before any
economic calculation; a fully protected gain returns `reserved_only` even when its older session
classification cannot authorize a recommendation. Free units require a v2 exact/high classification,
an approved model review inside its validity/age window and after the model evidence dates, plus a
matching canonical SHA-256 model fingerprint and a single fresh public price batch. The
engine reruns H4.8 from raw quotes, recomputes H4.2 fees over the complete free stack, uses the better
of immediate bid and an eligible vendor floor, and compares opening EV with the versioned margin by
`BigInt`. Equality favors opening. Missing or stale evidence returns typed `blocked`; malformed or
inconsistent evidence returns `invalid`; neither status contains an economic action. The output is an
explanation only: H4.10 performs no API call, persistence, UI, vault write, Trading Post action or item use.

`evaluateHoldIntents(input)` is the pure H4.11 boundary after H4.9 reservations. Only explicit,
versioned user intents can retain units. Active intents consume one exclusive free pool in deadline
then identifier order; a reached target, deadline or cancellation releases its quantity, while an
unavailable price protects it until the deadline instead of guessing. Each allocation keeps its
reason, current/target price, requested/allocated/shortfall quantities and an H4.2 target-net
projection. `recommendContainerDisposition` recomputes the supplied plan from the same reservation
overlay and price batch, validates batch freshness before any hold can consume the free pool,
subtracts held units before economics and preserves their provenance.
H4.11 has no persistence, UI, API calls or automatic sell/open operation.

Every H4.10 result also carries an H4.12 `RecommendationEnvelopeV1`. It is an exact JSON-only
handoff with `execution: manual_in_game`, `sideEffects: none` and `requiresUserAction: true`.
Its decisions partition reserved, held and economically free quantities through internal
explanation references. Sell decisions require `instant_sell|vendor`, holds require
`instant_sell|listing`, and actions without a route reject one; blocked results may request review and invalid results carry an empty
envelope. No public executor exists. A mechanical Vitest guard scans every production
`*recommendation*.ts` module for forbidden clients, transports, stores, secrets, Obsidian imports,
operation inputs and execution/order calls, including side-effect imports plus literal dynamic
`import()` and `require()`. It does not cover computed specifiers, obfuscated property access or
modules outside the named recommendation boundary.

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
