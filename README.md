# Tyrian Companion

Tyrian Companion is a desktop-only Obsidian plugin for reviewing Guild Wars 2 farming sessions and
account inventory context inside a vault. Every recommendation and session boundary remains under
human control: the plugin never operates the game account.

The MVP is API-only. Linux with Steam/Proton is the primary platform, macOS with CrossOver is
secondary, and Windows support is beta. Mumble Link is not part of the MVP; it is reserved for an
optional v2 map/activity IPC helper under the documented no-injection and no-automation boundary.
H8.1 fixes that future contract and its guards. H8.2 adds only a non-production, read-only CrossOver
probe spike under `spikes/`; no helper, IPC runtime or plugin integration is shipped.
H8.3 provisionally accepts Rust and H8.4 fixes the executable local IPC protocol. H8.5 implements
the isolated helper/server under `native/mumble-helper`: portable framing/auth/source logic, the
read-only Win32 mapping adapter and the loopback server. H8.6 adds an isolated, port-injected
TypeScript client core, strict codec, health projection and memory-only shadow observation. The
H8.7 safe-launch island adds closed platform routes, strict ephemeral paths, an injected process
adapter and an unsigned integrity gate, but no host executor. The plugin still has no real launcher,
composition, settings or UI integration. H8.8 adds only an isolated pure shadow policy for the
target map and an ephemeral, human-reviewed proposal DTO; it is not connected to the product
proposal queue or session lifecycle. Neither side
is wired from `main`, the helper is not included in the plugin ZIP, and firma y QA real siguen pendientes.

> [!WARNING]
> `0.1.13` is a public beta distributed through its GitHub Release and the active BRAT channel.
> Installation, update, and runtime QA in Obsidian are still pending across the platform matrix, so
> use a disposable vault while validating it.

The fixed plugin name, ID, author, repository and MIT license are recorded in the
[Release identity](docs/IDENTITY.md). The repository and the
[`0.1.13` beta release](https://github.com/fodaveg/tyrian-companion/releases/tag/0.1.13) are public,
and its three plugin assets are available to BRAT.

## Install a beta candidate

Requirements: desktop Obsidian `1.11.4` or newer. For BRAT, add
`fodaveg/tyrian-companion`; BRAT installs the individual `manifest.json`, `main.js`, and `styles.css`
assets from release `0.1.13`. For the guarded manual path, Node.js 22 and the ZIP, `.sha256`, and
`install-beta.mjs` files must come from the same named CI artifact.

1. Confirm the artifact belongs to the commit you intend to test. The checksum proves integrity, not
   who produced the artifact.
2. Close Obsidian and run the guarded installer from the extracted artifact directory:

   ```sh
   node install-beta.mjs install \
     --vault "/path/to/disposable-vault" \
     --archive "tyrian-companion-0.1.13.zip" \
     --confirm-obsidian-closed
   ```

   It verifies the checksum, ZIP and manifest, writes only the three managed plugin files and rolls
   back a detected write or swap failure. Use `--config-dir <name>` only when that vault deliberately
   uses a non-default Obsidian config directory.
3. Open Obsidian, go to **Settings → Community plugins**, enable Tyrian Companion, and then open its
   settings page.
   Before accepting install or update QA, run
   `npm run beta:verify-runtime -- --vault "/path/to/disposable-vault"` from this checkout while
   Obsidian and the plugin are running. The result must be `PASS`; the disk version alone is not
   evidence that Obsidian loaded that version.
4. [Create a Guild Wars 2 API key](docs/API-KEY.md) and select or create an Obsidian secret in the
   **API key** setting. Paste the value only into Obsidian Secret Storage; the plugin setting keeps
   only the secret name.
5. Select **Check connection**. A successful connection check proves only `account` access; starting
   a farming session also requires `characters`, `inventories`, and `builds`.
6. Open the command palette and run **Open companion**. This opens the Companion view, not Settings.

The full BRAT, manual install, update, and rollback procedure is in the [beta guide](docs/BETA.md).

## First farming session

The manual flow is state-dependent. The palette and the Companion view show only the action that is
valid for the current state.

1. With the connection checked, run **Start farming session**. Choose the character and enter the
   total Magic Find shown in the game. Wait until Companion says the baseline is captured and the
   session is active.
2. Farm normally. Avoid opening, salvaging, crafting, buying, selling, moving account items from
   another device, or otherwise changing the tracked account outside the run if you need an exact net
   result.
3. When the session is active, **Start farming session** is replaced by **Finish farming session**;
   the Companion view also shows **Finish session**. If the view still says `idle`, no session was
   started and there is nothing to finish.
4. After the final snapshot, run **Review session** and declare any outside activity. “Not sure” stays
   estimated; declaring an activity marks the result contaminated instead of guessing its cause.
5. When review is complete, **Clear completed session** first writes or updates the managed session
   note and only then clears the local runtime.

Assisted detection is optional. Set **Detection mode → Assisted**, check the connection, and run
**Arm assisted detection**. Arming captures a baseline and may later propose a start or finish, but
every proposal still needs an explicit review action. It always reloads disarmed and never starts or
stops a session automatically.

Pilot metrics are also optional and local. After a tester configures a platform profile in Settings,
the plugin keeps a vault-scoped, unsynchronized journal used to aggregate the H0.6 pilot criteria.
Every human silent-loss review is bound to the journal's monotonic sample revision; a concurrent
profile or evidence change makes that review stale instead of attaching it to unseen data. The
non-personal revision counter also advances across disable/re-enable, so an old review cannot become
valid again after the journal data has been erased. Assisted
start/stop controls never open or wait for a metrics-only modal and proceed with a nullable timing
correction when the optional journal is absent or unavailable.
Reviewing and exporting is explicit and creates four deterministic JSON/CSV files without overwriting
existing files. **Clear metrics** removes observations and the silent-loss review but keeps the local
profile; **Disable and delete** also removes that profile while retaining only the non-personal
monotonic generation counter. Previously created Vault exports remain and
may be synchronized by Obsidian, and their proposal references are pseudonyms rather than anonymous
identifiers. This instrumentation never gates a session action and sends no remote telemetry.

## Inventory advisor

Run **Open inventory advisor**, then use **Refresh inventory** to make the one explicit account
capture. Opening the view never reads the GW2 account; visible catalog icons may load from ArenaNet's
official `https://render.guildwars2.com` CDN. Filters and explanations help
review owned positions, reservations, keep exceptions, evidence coverage, and any supported manual
route. The default surface leads with **What to do now**, shows only direct actions ordered by the
prepared value ranking, and formats their value as gold, silver, and copper. **Items to keep** and
**Pending without recommendation** remain available as explicit context toggles instead of diluting
the actionable queue.

The scope starts at carried bags plus the shared inventory. **Character** narrows the view to one
character's bags, and **Bank**, **Materials** and **Trading Post delivery** add those stores when you
ask for them; the capture reads all of them, but a failure there degrades only that store and never
the basic inventory. **Sort by** reorders what you are actually looking at, each group closes with its
own subtotal, and items without a demonstrated price are counted apart instead of being added to the
known value as if they were worth zero.

Settings lets you declare the account-wide capacity of each material in steps of 250, from 250 to
3,000. Leaving it unknown uses only the guaranteed minimum of 250 and labels that source explicitly.
With stable, complete, and fresh material evidence, the advisor can recommend **Deposit material**
for loose items in character bags or shared inventory after reservations and keep exceptions. The
total recommendation never exceeds the demonstrated free capacity for that material.

Coverage is deliberately conservative. A row can remain **Review** because prices, unlock evidence,
binding, a curated rule, or an economic comparison is incomplete. `discard_review` is never an
instruction to destroy an item, and the plugin has no sell, vendor, salvage, open, use, deposit, or
destroy executor. Check every action in Guild Wars 2 yourself.

### Durable inventory Bases

The Inventory Advisor also exposes a separate explicit **Preview sync → Sync to Vault** flow. Preview
captures a stable account-wide inventory, resolves catalog and current instant-sale prices, and builds
a read-only plan. Sync rereads that plan and writes one managed note per item, location, and character
below the configured portable output root. Opening the view performs neither action.

Managed assets bundle v4 introduced localized `Inventory.base` and `Materials.base`; bundle v5 writes
frontmatter display labels under Obsidian's canonical `note.tc_*` property namespace. Their filters
still use stable `tc_*` marker/schema keys instead of a folder predicate, and their value formula
remains numeric so sorting is based on copper rather than formatted text. See the [activation and migration guide](docs/INVENTORY-VAULT-SYNC.md).

## What the result means

- A session is an observed net change between stable account snapshots, not a drop log and not total
  account wealth. Transfers and unrelated account activity can change that net.
- **Exact** requires qualified snapshots, high-confidence boundaries, and a clean human review.
  Missing or contradictory evidence is shown as estimated, contaminated, limited, or invalid.
- Trading Post values use public quotes captured at close time. They are estimates after the modeled
  fees, not proof that an item sold at that price.
- Assisted detection is a polling heuristic. Offline periods, sleep, API cooldowns, and activity
  between polls widen uncertainty; no background signal is accepted silently.
- The installed MVP has no active or packaged Mumble Link integration, game-process inspection,
  input automation, automatic account operation, or unattended session finalization. The repository
  contains only the isolated H8.5/H8.6 server/client core and H8.7 safe-launch plan for future v2 wiring.

## Local beta diagnostics

Internal beta builds enable local `debug` diagnostics by default. Settings lets you disable capture,
raise the minimum level, inspect writer health and retained size, open the local directory, copy a
bounded recent extract, create a reviewed support package, or clear retained logs with confirmation.
Capture failures are fail-open: they remain visible in the Companion and Settings surfaces but never
block the product action being diagnosed.

Records are append-only JSONL under
`<config-dir>/plugins/tyrian-companion/logs/`, rotated across at most five 2 MiB files (10 MiB total).
Each action has one local random `actionId`, a reusable `correlationId`, UTC time, monotonic sequence,
version, closed component/action/phase/code fields and bounded safe metadata. A central allowlist
removes credentials, authorization, cookies, bodies, raw URLs, vault paths, account/character identity
and unreviewed payload fields; local errors retain only sanitized name, message and stack. The explicit
support package performs a second parse/sanitization and emits only structural fields: it omits free
message, stack, error name, state and details while preserving component, action, code and correlation.
Logs are never uploaded or shared automatically.

The static action-observability census inventories production `catch`, `.catch`, detached `void` and
registered callback boundaries. `npm run test:action-observability` proves additions turn the gate red
until the reviewed baseline is updated.

For a problem, follow the [safe support and bug-reporting guide](docs/SUPPORT.md). Never include an API
key, account or character identity, an absolute vault path, raw inventory/snapshot data, IndexedDB
contents, or unredacted screenshots/logs in a report.

The current `0.1.4` vertical provides:

- A loadable, note-independent Obsidian view and the **Open companion** command. Its H5.1 field ledger keeps session phase and elapsed time first, then detector, polling, evidence quality, account and the highest-priority incident; verbose diagnostics remain collapsed.
- H5.2 session controls in the command palette plus one context-sensitive compass ribbon menu: start, finish/retry, review, recover, confirmed discard and confirmed clear reuse the same lifecycle actions as the view.
- H5.3 durable confirmation queue in a dedicated local IndexedDB: assisted proposals survive a closed note or restart, remain data-only in the background, and reappear as a count plus one review summary without notices, notifications, focus changes, or automatic session transitions.
- H5.4 writes a completed session to a vault note before local runtime can be cleared: hashed account/session references, stable `tc_*` frontmatter and verified managed blocks preserve human notes without exposing raw account evidence.
- H5.5 projects completed-session loot once into a data-only bilingual view model shared by the managed note blocks and the responsive Companion ledger; unreliable evidence withholds value and recommendations instead of guessing.
- H5.6 installs a generic Obsidian Base only after an explicit preview/apply action. A versioned manifest and resumable CAS journal distinguish intact, missing, modified, foreign and future assets without scanning or overwriting user files.
- H5.8 keeps all accepted and generated Vault paths portable across macOS, Linux, Windows, and Obsidian Sync; session filenames remain UTC plus hashes, never account or character names.
- H5.9 provides a typed, exhaustive ES/EN catalogue for visible settings, Companion state, actions, notices, confirmations, generated notes, loot and managed Bases while retaining stable command IDs, `tc_*` properties and Base query keys.
- H5.10 manually scans durable H5.4/H5.7 session notes and creates deterministic, create-only JSON/CSV history exports below `exports/`; malformed, future, or duplicate notes fail closed and no vault read occurs on plugin load.
- H5.10 also exposes a warning-style Settings scrub with preview and explicit confirmation; it preserves files and human content, removes only validated `tc_*` metadata and managed blocks, and blocks around live session, recovery, or detector state.
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
  and visible start/stop proposals that always require a user action. Character inventory/build reads
  use one 30-second attempt; the first transient partial pass stops the account-wide fan-out and lets
  the single scheduler own the bounded backoff and recovery.
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
- H4.19 extracts that economic comparison into a session-independent kernel and binds it to the
  Inventory Advisor through an explicit, hashed and human-controlled activation pack.
- A pure H4.11 user hold-intent allocator that protects a bounded free quantity until a target
  price or deadline and feeds the remaining quantity into H4.10 without performing an operation.
- A strict H4.12 JSON recommendation envelope that labels every decision manual-only and
  side-effect-free, with a mechanical boundary test against I/O dependencies and operations.
- A strict H4.13 Inventory Advisor contract over `supported_storage_v1`: account-wide catalog,
  prices, reservations, keep exceptions, unlock evidence and reviewed rules remain identity-bound,
  while every output is manual-only and an irreversible candidate is review-only, never `destroy`.
- H4.14 explicit account-wide evidence capture: every owned item receives catalog coverage and every
  available item receives one fresh public price result, while TP/unlock/recipe/skin/mini/achievement
  signals retain identity, coverage and TTL facts without adding UI, persistence or recommendations.
- H4.15 pure Inventory Advisor classification: every owned physical position is partitioned once,
	with reservations and keep exceptions first and non-loose positions reviewed. Fresh complete
	character/shared-inventory, catalog, price, reservation and account evidence can still show manual
	vendor/TP routes when the latest fully covered pass is changing; curated use/open/salvage remains
	review-only until the snapshot is stable and its exact rule authority is available.
- H4.16 pure discard allowlist: it canonically reproduces the H4.15 producer result before changing
	only a demonstrated `keep/no_supported_route` into review-only `discard_candidate`, with cited rule
	and knowledge sources; it has no executor, I/O, persistence, or UI.
- H5.11 adds a separate responsive **Inventory advisor** view and explicit Open/Refresh commands.
  Opening is memory-only; Refresh is the sole capture trigger and composes H4.14 → H4.15 → H4.16
  through a latest-wins single-flight cache. H4.18 supplies an immutable, source-backed built-in v2 bundle
  with one curated capability for item 36038 (**Trick-or-Treat Bag**): `open` is known, while `use` and
  `salvage` are explicitly not applicable. H4.19 adds a fresh sibling batch for the bag plus its eight liquid
  outcomes and a 10% manual open-versus-sell/vendor comparison. Items without curated use/open/salvage
  knowledge can still show their independently reproduced manual liquid route (instant sell, listing or
  vendor). David approved the source-backed rule and economic pack on 2026-08-16: complete fresh evidence
  can now recommend manual `open`, `sell` or `vendor` for 36038 with the fixed 10% margin. Partial or
  incoherent evidence still returns review, and discard remains unavailable.
	The view captures character bags plus shared inventory with at most two observations per explicit
	Refresh. A complete first observation is checked once more under the same pinned operation and is
	stable only when ownership and placement agree. A transient `206`/timeout/network/`5xx` may consume
	the second observation, but recovery remains unstable; `429` stops immediately so the shared
	cooldown owns the retry. Each private request has a 30-second timeout and no third or external retry.
	Bank, materials and Trading Post delivery are captured as optional stores and remain unchecked by
	default. Each control reports whether its source was read, restricted, missing permission, partial or
	unavailable; a source-specific 403 degrades only that store, while a 401 still rejects the pinned
	credential. Plain review rows are opt-in; item rows render trusted official catalog icons.
	At the bundle's exclusive expiry,
  Refresh fails closed with
  `missing_rules` before any API request.
- H5.12 adds an explicit, foldable Inventory Advisor editor for local reservation goals and keep
  exceptions. It derives a hashed vault/account scope only after capture, uses IndexedDB CAS across
  windows, preserves drafts on conflict, and reclassifies only fresh cached evidence without a second capture.
- H9.16/H9.3 adds a source-backed, manual Rare level 68+ equipment salvage comparison. Its lower-bound
  EV includes only the documented 0.9 ectoplasm per item, real bid depth for instant sale, Trading Post
  fees, kit cost, and optional configured time cost; base materials, luck, and recovered upgrades stay
  explicitly excluded. A listing uses the current ask, not buyer depth or an execution guarantee.
  Exotic equipment remains review-only without an invented rate. `NoSalvage`, unstable snapshots,
  incomplete evidence, stale policy, and partial required depth fail closed. Settings schema v10 keeps
  kit, sale strategy, seconds per item, and hourly opportunity cost optional; missing time inputs are
  disclosed and excluded. Every Rare salvage recommendation carries a catalog/item/policy-bound proof,
  remains manual-only, and has no salvage executor.
- H8.1 defines a declarative, opt-in Mumble Link v2 boundary: recommended revisable defaults are
  disabled/shadow/on-when-armed, API v1 remains authoritative, every lifecycle change still needs
  human confirmation, and the future loopback frame is limited to version/nonce/sequence/tick,
  map id and derived link activity with `initialSequence:0`. Raw data and frames may not be persisted.
- H8.2 provides an isolated C spike for the secondary macOS/CrossOver path. Its portable core pins
  the official byte layout, accepts only a best-effort pair of identical complete samples and
  renders one minimal frame;
  the Windows probe opens only the existing named mapping read-only. It is not imported, packaged
  or connected to the plugin, and real-session QA remains pending.
- H8.3 records the `accepted_for_implementation`, provisional Rust decision for one x64 Windows PE.
  H8.5 now implements its source under `native/mumble-helper`; a future separate ZIP will carry the
  EXE, manifest, checksums and licenses. Linux/Steam/Proton, macOS/CrossOver and Windows x64 QA, plus
  Authenticode signing, remain pending; the repository contains the native helper but no release
  package, launcher or plugin wiring.
- H8.4 closes the protocol to TCP IPv4 `127.0.0.1` with bind port `0`, framed JSON records shared by
  stdin/stdout/TCP, a 32-byte per-process token and 16-byte per-connection nonce, exact
  bootstrap/ready/hello/welcome, shared heartbeat/sample sequencing and fail-closed deadlines. Its
  due 500 ms cadence emits one sequenced record: after warm-up, a sample derived from raw tick/map
  replaces that slot's heartbeat and satisfies liveness; otherwise the heartbeat carries the exact
  source status. The first valid read after start, recovery or discontinuity emits one `warming_up`
  without retaining a tick; the next establishes a fresh advancing epoch. A source-status heartbeat
  clears tick/time history. Late calls emit at most once from current state and reschedule from now;
  they never catch up missed slots, and 2 s without a valid record fails with `heartbeat_timeout`. Its
  exact lifecycle admits records only in their phase, binds hello to the process bootstrap token,
  restarts discovery after any pre-ready/helper-exit failure, and reconnects in-process only after a
  valid ready port. Sequenced records refresh health/reset backoff, stdin EOF is terminal, and its
  incremental framer transfers payload ownership before callbacks and retains at most 516 bytes
  simultaneously regardless of input chunk size. Product remains API-authoritative, shadow,
  human-confirmed and non-persistent. H8.5/H8.6 implement the two sides in isolation and H8.7 the
  closed launch plan/adapter without a host executor, plugin composition or release packaging.
- H8.5 implements only the Rust helper/server projection of that protocol. Every 500 ms it emits
  exactly one shared-sequence record: a stable warmed source produces `sample`; unavailable,
  unsupported, unstable or invalid source produces the exact heartbeat status; the first valid
  read after start/recovery produces `warming_up` without retaining tick history, and the next valid
  read establishes the activity epoch. Late calls schedule from now, never catch up, and 2 s without
  an emitted record closes the channel before emitting. It reads only the four H8.2 fields through
  `FILE_MAP_READ`, and has no plugin launcher, persistence, logs or external network.
- H8.6 implements the isolated TypeScript client core with injected process, TCP, clock and CSPRNG
  ports and no productive Node imports or ambient I/O. Its incremental codec enforces the same
  `uint32` big-endian + fatal UTF-8/closed JSON boundary and 516-byte high-water mark; lifecycle
  state rotates a process token and connection nonce, enforces exact sequence/deadlines and uses
  the same saturated `[250,500,1000,2000,5000]` restart/reconnect backoff, reset only after
  `healthy`. Health keeps channel, source and activity as three independent axes. Shadow observation
  retains only `mapId` and activity in memory behind `enabled + armed`, with no session, proposal,
  capture or persistence callback. There is still no launcher, real process/TCP adapter, wiring,
  settings, UI, packaging or platform QA.
- H8.7 adds closed launch config/route/diagnostic contracts and exact plans for native Windows,
  CrossOver `wine` and Steam/Proton `protontricks-launch`. AppID `1284210`, `MumbleLink` and launcher
  authorities are fixed; package/compat paths are strict and ephemeral, `shell:false`, stdio is
  piped and there are no free command/args/env/mapping fields. An injected adapter opens the exact
  H8.5 five-file package before every attempt, checks the canonical manifest plus four non-circular
  checksum entries and delegates only a byte-bound opaque capability—never a re-resolvable helper
  path. Premature stdout is limited to one 516-byte chunk; overflow, a second event or early exit
  fails closed. This proves only `integrity_checked` /
  `unsigned_qa_only`, never authenticity: no Node executor or real spawn exists, and future
  execution must require a release trust anchor plus immediate revalidation. H8.7 remains `@wip`.
- H8.8 adds an isolated pure shadow policy for map `866`: five seconds of accepted presence credit
  while idle or sixty seconds of accepted absence credit during a bound session can latch at most
  one ephemeral DTO per latch. Its evidence remains `limited` and its review `human_required`. Gaps, heartbeat/source
  degradation, `link_stalled` and channel recovery reset or degrade the current window rather than
  inventing evidence. Its ephemeral context binds the signal to `accountId`; an account change
  resets the latch instead of reattributing prior evidence. The DTO is not enqueued, persisted,
  displayed or allowed to start/stop a session; API evidence remains authoritative. Composition and
  human QA are still pending.

Automatic or periodic inventory synchronization, persisted recommendation reports, unattended
detection, and account operations are intentionally not implemented. The sole curated capability is
human-reviewed
and may emit only a manual recommendation when its H4.19 evidence is complete and fresh. Vault writes are
limited to H5.4 completed-session notes, H5.6 explicit managed assets, H5.10 explicit history export
and scrub, and the explicit inventory preview/apply workflow; no background or free-form vault write is performed.
Snapshot capture runs from explicit **Start session**, **Stop session**, or **Arm assisted
detection** actions; it describes observed storage, not total account wealth.

## Requirements

- Obsidian `1.11.4` or newer.
- Desktop Obsidian.
- Node.js `22.20.0` or newer within the Node 22 line, or Node.js `24.12.0` or newer. This matches the engines declared by the locked toolchain.
- A C11 host compiler for the development-only H8.2 spike lane included in `npm run check`; it is
  not a runtime or installation dependency of the plugin.
- Rust 1.85.1 for the H8.5 helper development gate. End users do not need Rust, and no signed helper
  is currently published.

## Development

```sh
npm install
npm run dev
```

Run the complete local gate with:

```sh
npm run check
```

The native focal gate runs from `native/mumble-helper` with `cargo fmt --all -- --check`,
`cargo test --all-targets --locked`, `cargo clippy --all-targets --all-features --locked -- -D warnings`
and `cargo metadata --format-version 1 --locked`. Windows PE/static-CRT/reproducibility evidence is
produced only by CI as a short-lived `UNSIGNED-NOT-FOR-RELEASE` marker, never a release ZIP.
The only native build target is `x86_64-pc-windows-msvc` with the static CRT flag fixed in Cargo config.
MSVC may leave an ephemeral PDB under `target`; staging and uploaded artifacts remain marker-only.

Create a reproducible local candidate with:

```sh
npm run release:package
```

The command rebuilds `main.js`, stages only `manifest.json`, `main.js`, and `styles.css`, scans the
staged bytes, and writes a deterministic ZIP plus SHA-256 under `.release/`. `versions.json` remains
repository metadata and is not part of the installable archive. See the [beta and manual QA
guide](docs/BETA.md); no GitHub Release or BRAT channel is published by this command or by CI.

After committing and before a release owner pushes a release, run:

```sh
npm run release:preflight
```

The release preflight requires an attached `HEAD` and an exactly clean
`git status --porcelain`; an upstream is optional. Dirty-state diagnostics expose only counts for
untracked, unstaged, and staged entries, never paths or file contents.
It does not verify semantic change scope or replace the test and CI gates.

The production build creates `main.js` in the project root. Installation and update inside Obsidian
remain human QA even when the package and CI gates are green.

## Privacy and network behavior

Plugin settings store only the selected Obsidian secret name. Recoverable session evidence is kept
machine-locally in IndexedDB, outside settings and vault notes, and contains no API key. The API-key
value is resolved from the vault-local `SecretStorage` only when **Check connection**, **Start
session**, **Stop session**, **Review session**, **Arm assisted detection**, **Refresh inventory advisor**, or
**Preview inventory Vault sync**
is explicitly selected. Loading the plugin or opening a non-inventory view reads only local recovery
state and does not make network requests. The Inventory Advisor may load visible public item icons
from the exact official `https://render.guildwars2.com` origin; no API key, account identifier or
inventory quantity is sent. Each explicit Refresh also replaces one local
`<config-dir>/plugins/tyrian-companion/inventory-advisor-capture-receipt.json` diagnostic receipt.
For unavailable snapshot sources it records only the transport class, HTTP status and bounded retry
delay; it never records the credential, account, character, item, URL or response body.
It contains only closed outcome/coverage codes, duration, quality and per-pass source summaries;
it never contains the API key, account/snapshot identifiers, character names, item data, URLs or
response bodies, and it is never uploaded. Assisted
detection always reloads disarmed, pauses offline or after sleep, and never starts or stops a session
without confirmation.
At **Stop session**, the plugin sends only gained numeric item IDs to the official public
`/v2/commerce/prices` endpoint; it does not attach the API key, account, character, or quantities.

An explicit Inventory Advisor Refresh also reads current Trading Post buys and sells when the key
allows it. Complete buy-side evidence suppresses only a conflicting sell-now action, and complete
sell-side evidence suppresses only a conflicting listing action. Missing or partial coverage is
neutral. Raw transaction IDs never leave capture, and the plugin never creates, changes, or cancels
an order.

The contamination review asks whether containers were opened, items were salvaged or consumed,
crafting/conversion occurred, purchases or sales happened through the Trading Post or vendors,
transfers occurred, or other account activity took place. A declared activity always produces a
contaminated result. “Not sure” remains estimated and provisional. The review modal may query up to
90 days of completed Trading Post history within the exact session window. Complete evidence can
only propose purchase or sale answers; the user must apply or dismiss the proposal and may edit every
answer before saving. Missing, partial, or invalid history remains neutral, raw transaction IDs are
not retained, and the evidence never operates on the Trading Post.

Detection-quality observations use a separate local IndexedDB database. The permitted set is the
event/session/proposal identifiers, phase, outcome, mode, cause, boundary window, uncertainty,
evidence quality and metric timestamps. When an assisted-start provenance is required, it may
retain only the complete `RelevantStartProposal`: `version`, `proposalId`, `accountId`, `ruleSet`
id/version, `firstSignal` and `confirmationSignal` with boundary snapshot refs, intervals/windows,
`itemId`/`quantity` gains and `deltaStatus`, plus `possibleStart`, `evidenceQuality` and
`confirmedAt`. The store never contains an API key, raw snapshots, raw inventory payloads or a
free-text note. If this optional measurement store is unavailable, session start, stop and proposal
dismissal continue to work and the view reports the missing telemetry.

Pending assisted confirmations use `tyrian-companion-confirmation-queue`, also outside the vault and
without credentials. Enqueue is atomic before polling resumes; claims are fenced by exact operation
and window identity, renewed while the chosen workflow is running, and accepted only after the
existing start/stop workflow succeeds. Pending proposals expire after 24 hours, receipts after 30
days, and background work only refreshes existing status indicators: it never rebuilds the view,
opens a modal, shows a notice, reveals a leaf, focuses a control, or sends an OS notification.

Completed session notes are the generated H5.4 Vault notes in this vertical. They live below the
configured output folder in `sessions/<UTC year>/`, use hashed identifiers, and update only `tc_*`
frontmatter plus six hash-verified managed blocks. H5.6 managed assets, H5.10 JSON/CSV exports and
scrub, and explicit inventory sync are the only other allowed Vault writes. A collision uses the complete
session hash; an ambiguous or human-modified managed region fails closed and leaves the completed
runtime available.
The configured folder and every managed asset path are NFC-relative paths with `/` separators and
portable segments only; absolute, personal, Windows-reserved, or Sync-incompatible paths fail closed.
Settings are canonically rewritten after normalization: unknown properties are removed and only the
authorized `legacyOutputFolder` and `legacyManagedAssetsRoot` fields preserve a pre-H5.8 path for
explicit replacement, move or removal. Those legacy paths cannot become current output roots or
alter the durable managed-assets pointer.

Optional managed assets live below the configured output folder in `Bases/` with ownership recorded
in `Tyrian Companion Assets.json`. Loading the plugin does not inspect or write them. Preview is
read-only; Apply/Repair/Move/Remove are explicit, journaled Vault operations. Modified or foreign
files are preserved, and uninstall moves byte-exact templates or semantically equivalent owned YAML Bases through Obsidian's trash API. A lazy
IndexedDB pointer, namespaced by a SHA-256 vault identity, uses generation and operation state to arbitrate install/move/remove across windows;
settings mirror only the last completed root. Relocation can recover the observed split topology only
when the old ready v2 manifest proves ownership and the new root contains the exact complete,
semantically equivalent set with no foreign file; a durable relocation journal is written before the
pointer changes or the origin is detached. Ordinary install remains unable to adopt markerless files.
Bundle v5 keeps the generic `.base`, localized
`Halloween.base`, and localized `Inventory.base`/`Materials.base` through the same manifest/CAS path. The Halloween Base reads only session-note schema v2
fields, preserves literal zeroes, and excludes incomplete evidence from performance views.

Durable-history export is an explicit Settings action. It considers only Markdown notes whose
`tc_kind` is `gw2_farming_session`, validates supported schemas 1/2, hashed references, and all six
managed blocks before writing fixed JSON and CRLF CSV files below `exports/`. It never exports raw
account/session IDs, vault paths, frontmatter character/build fields, or human Markdown. Existing
export files are never overwritten; an exact previous partial result is reused only to finish the
missing sibling file. CSV quotes every field and prefixes spreadsheet formula starters. The action
is single-flight and opening Settings does not list or read vault notes.

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
Its economic core now lives in `calculateContainerDispositionKernel(input)`: a session-independent,
data-only function reused by H4.10 and H4.19. The kernel accepts only catalog/binding, the attested model,
one market batch and policy; it has no session, account capture, persistence or execution capability.

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
`import()` and `require()`. The shared helper uses the TypeScript AST and also covers static imports
and exports, `import = require` and `import()` type nodes when their specifier is literal. It does not
cover computed or obfuscated specifiers, obfuscated property access or modules outside the named
recommendation boundary.

H4.13 defines the next Inventory Advisor boundary without claiming complete account coverage.
`supported_storage_v1` is limited to the holdings already observed by `StorageSnapshot`: character
inventories, shared inventory, bank, materials and optional commerce delivery. The input contract
binds snapshot, catalog, public prices, reservation goals, explicit keep exceptions, account unlock
signals and a dated, content-hashed rule pack. The report must partition every available quantity
exactly into reserved, exception-kept, manual action or review. Its sibling
`InventoryRecommendationEnvelopeV1` preserves `manual_in_game`, `sideEffects: none` and explicit
user action without widening the session-envelope schema. It has no `destroy` action; the only
irreversible classification is `discard_candidate`, which requires a reviewed rule and remains a
manual review item. H4.13 performs no scan, network request, persistence, Vault write or UI work;
evidence capture and classification belong to H4.14-H4.16.

H4.14 now captures that evidence only when invoked explicitly. It reuses the public catalog resolver
for all positive `ownedByItem` IDs and the H4.4 commerce-price parser/batch semantics for all positive
`availableByItem` IDs; a null bid/ask remains demonstrated absence, never zero. One authenticated
operation verifies account identity and reads permitted unlock/progression signals. Missing scope,
URL restriction, malformed data and transient failure remain coverage, never empty unlock arrays.
Its wrapper carries snapshot/catalog/price/signal TTLs, canonical completion timestamps and an
array-order-preserving SHA-256 fingerprint; it composes into H4.13 only after freshness and identity
validation. The same explicit Refresh also requests public `/v2/commerce/listings` depth without an
API key, in sequential batches of at most 200 IDs. Instant sell consumes real buy levels from best to
worst and values only covered quantity; a manual listing uses the current best ask for the whole stack
without treating existing sell-listing quantity as buyer capacity or a fill guarantee. Missing or
partial depth preserves the previous `/v2/commerce/prices` fallback while marking the public result
as limited. H4.15 now performs the next pure step: it consumes that evidence plus a dated, hashed
knowledge pack whose per-capability assertions are positive or explicitly `not_applicable`. It
partitions every owned physical position after reservations and keep exceptions, routes non-loose or
unknown/contradictory evidence to review, caps instant sales to demonstrated top-bid depth and never
emits `discard_candidate`. Its dynamic guard rejects network, UI, persistence, timers and irreversible
operations. H4.16 now applies the separate, proof-bound discard allowlist; only persistence and UI remain pending.
For H4.19, the same explicit Refresh may additionally capture one identity-bound sibling price batch with
exactly `36038, 36041, 36059, 36060, 36061, 79673, 79677, 79679, 89002`. The advisor validates exact
coverage, TTL, hashes, rule/model bindings, reservations and keep exceptions before calling the kernel.
Complete evidence and a 10% margin can produce only manual `open`, `sell` or `vendor`; partial, revoked,
expired or incoherent evidence produces `review`. The shipped pack was human-approved on 2026-08-16.

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

- [`docs/BETA.md`](docs/BETA.md)
- [`docs/API-KEY.md`](docs/API-KEY.md)
- [`docs/SUPPORT.md`](docs/SUPPORT.md)
- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/PLATFORM_POLICY.md`](docs/PLATFORM_POLICY.md)
- [`docs/ESTADO.md`](docs/ESTADO.md)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

[MIT](LICENSE)
