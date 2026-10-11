import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { GuildWars2Client, OFFICIAL_GW2_API_URL } from './account/guild-wars-2-client';
import { ResilientHttpTransport, type HttpRequest } from './core/http';
import { DEFAULT_SETTINGS } from './core/settings';
import { HostApiKeyProvider } from './core/secret-provider';
import { loadTyrianSettings } from './runtime/tyrian-runtime';
import { withObsidianHost } from './test/obsidian-host-harness';
import {
	censusNetworkAndCredentialCapabilities,
	isFutureOutboundFile,
	isSensitivePersistenceBoundary,
	persistenceBoundaryHasCredentialCapability,
	productionSourceFiles,
} from '../scripts/security-scan.mjs';

const TOKEN_SENTINEL = ['tyrian-h6', 'token-sentinel', 'not-a-credential'].join('-');
const REVIEWED_FUTURE_OUTBOUND_FILES = [
	// Reviewed 2026-10-10 (DU-13): writes inventory goals and keep exceptions, keyed by the GW2 accountId, into the host
	// settings through the core settings port; Obsidian Sync or Hebra may carry them off-device by design; no transport or
	// credential capability.
	'src/advisor/inventory-preferences-backup.ts',
	'src/inventory/inventory-vault-sync.ts',
	'src/platform/mumble-v2-client.ts',
	'src/platform/mumble-v2-codec.ts',
	'src/platform/mumble-v2-contract.ts',
	'src/platform/mumble-v2-health.ts',
	'src/platform/mumble-v2-launch-contract.ts',
	'src/platform/mumble-v2-launch-plan.ts',
	'src/platform/mumble-v2-observation.ts',
	'src/platform/mumble-v2-presence-policy.ts',
	'src/platform/mumble-v2-process-adapter.ts',
	// Reviewed 2026-10-06: validated anonymous live evidence, create-only local Vault export,
	// full-journal serialization and reread verification; no transport or credential capability.
	'src/sessions/live-session-export.ts',
	'src/sessions/mumble-v2-shadow-proposal.ts',
	// Explicit local Vault export only; the reviewed module has no outbound or credential capability.
	'src/sessions/pilot-metrics-export.ts',
	// Pure UI projection. The filename contains `sync`, but the reviewed module has no outbound or credential capability.
	'src/ui/inventory-sync-panel-view.ts',
	'src/ui/inventory-vault-sync-controller.ts',
	'src/ui/inventory-vault-sync-run-controller.ts',
	// Memory-only preview/apply state machine shared by the wallet and inventory bindings;
	// the reviewed module has no outbound or credential capability.
	'src/ui/vault-sync-controller.ts',
	'src/ui/wallet-vault-sync-controller.ts',
	'src/wallet/wallet-vault-sync.ts',
];
// R1a: Obsidian's request API moved, unchanged, from `src/core/obsidian-http.ts` into the host
// adapter; the core's `HostRequestTransport` (`src/core/http.ts`) reaches it through `TyrianHost.http`.
const REVIEWED_REQUEST_URL_FILES = ['src/host/obsidian/obsidian-http.ts'];
const REVIEWED_FETCH_FILES: readonly string[] = [];
const REVIEWED_WEB_SOCKET_FILES: readonly string[] = [];
// H13.9/H13.15. The only module allowed to open `node:net`: the host's loopback TCP port for
// the in-game alert bridge. Reviewed: `src/alerts/alert-ingame-server.ts` (host-neutral since R1a)
// asks it for `127.0.0.1` only and refuses any other bound address, reads at most one line from a
// client before refusing further input, and neither imports `src/platform/` (H8/Mumble).
const REVIEWED_NET_IMPORT_FILES = ['src/host/obsidian/obsidian-tcp-server.ts'];
const REVIEWED_HTTP_IMPORT_FILES = [
	'src/account/account-service.ts',
	'src/account/guild-wars-2-client.ts',
	'src/account/magic-find-service.ts',
	'src/account/rate-limited-storage-snapshot-service.ts',
	'src/account/storage-snapshot-service.ts',
	// "Actualizar logros de Leyspring". Imports only the `HttpTransportError` class to read the
	// status of a failed call (401/403 = key without `progression`); the requests it makes go through
	// the injected `GuildWars2Client` and public gateway, so it opens no transport of its own.
	'src/achievements/leyspring-capture.ts',
	// «Logros», tracked progress. Same review as the line above: it imports only the
	// `HttpTransportError` class to read the status of a failed call (401/403 = key without
	// `progression`); its two keyed reads go through the injected `GuildWars2Client`, and only from
	// the explicit `refresh` action (docs/PRODUCT.md:9).
	'src/achievements/tracked-progress-service.ts',
	'src/advisor/inventory-advisor-evidence.ts',
	'src/catalog/public-catalog-client.ts',
	'src/catalog/public-catalog-service.ts',
	// H15.2. Imports only the `HttpTransportError` class for an `instanceof` check and its closed
	// `kind`/`status` fields; it opens no transport and makes no call of its own.
	'src/core/local-debug-error-details.ts',
	'src/economy/commerce-listings-capture.ts',
	'src/economy/price-history-capture.ts',
	// H9.1 panel overlay, approved 2026-09-03. Owns `fetchPriceSeed`'s lifecycle for
	// whichever item the price-history panel is showing (`price-seed-source.ts` is
	// the actual outbound call, reviewed below). Deferred to the panel's own load
	// action, cached in `price-seed-cache-store.ts`, and every path is caught: a
	// datawars2 failure is a state on the service, never a thrown error.
	'src/economy/price-seed-panel-service.ts',
	// H13.2. The only outbound call in the plugin that is not to ArenaNet: one
	// unauthenticated GET for the price history the official API does not
	// publish. Reviewed: it sends an item id and nothing else, it carries no
	// key, no account id and no snapshot, and it never runs without a session.
	'src/economy/price-seed-source.ts',
	// Owns that call's lifecycle (once per activation, never retried). It holds
	// the transport it was handed and adds no outbound capability of its own.
	'src/economy/sell-signal-runtime.ts',
	'src/halloween/halloween-evidence-service.ts',
	'src/halloween/halloween-unlocks.ts',
	// Tyrian as an external Hebra plugin, approved 2026-10-03 (Hebra's SPEC-PLUGINS-EXTERNOS.md).
	// Composition only, like `ObsidianHost`: `HebraHost` hands `createTyrianHttpPort(api)` to the
	// core as `TyrianHost.http`; it opens no call itself. `./http` reaches the network only through
	// Hebra's `api.http`, which enforces the two hosts of `hebra.json` and asks the user for the webhook.
	'src/host/hebra/hebra-host.ts',
	// R1a. Composition only: `ObsidianHost` hands `createObsidianHttpPort()` to the core as
	// `TyrianHost.http`; it opens no call itself.
	'src/host/obsidian/obsidian-host.ts',
	// H13.10. Composition only: it names the transport type so it can hand the
	// one the plugin already built to the sell signal. It opens no call itself.
	'src/runtime/assemble-price-history.ts',
	// R1c. The composition that was main.ts: it builds the transports and hands them on.
	'src/runtime/tyrian-companion-core.ts',
	'src/sessions/api-poll-scheduler.ts',
	'src/sessions/assisted-detection-service.ts',
	'src/sessions/manual-session-start-service.ts',
	'src/sessions/session-start-capture.ts',
];
const REVIEWED_SECRET_PROVIDER_IMPORT_FILES = [
	'src/account/guild-wars-2-client.ts',
	// R1c. The composition that was main.ts (`HostApiKeyProvider` over `host.secrets`).
	'src/runtime/tyrian-companion-core.ts',
];
const REVIEWED_SECRET_CAPABILITY_FILES = [
	'src/account/guild-wars-2-client.ts',
	'src/core/secret-provider.ts',
	// Tyrian as an external Hebra plugin, approved 2026-10-03. `TyrianHost.secrets` over Hebra's
	// keychain: ONE `api.secrets` entry (`api-key`, which Hebra aliases to the account the compiled
	// module used) read once at start and written whole behind each `set`; memory where Hebra has no
	// keychain. Nothing leaves it but `get` to the core.
	'src/host/hebra/secrets.ts',
	// Its settings row: the secret picker lists the names and saves a new one typed by the user, the
	// same as Obsidian's `SecretComponent`; the control's value is the NAME, never the secret.
	'src/host/hebra/setting-row.ts',
	// R1a. `TyrianHost.secrets` over Obsidian's `SecretStorage`: list, get and set, nothing else.
	'src/host/obsidian/obsidian-host.ts',
	// R1c. The composition that was main.ts: the in-game bridge token through `host.secrets`.
	'src/runtime/tyrian-companion-core.ts',
];
const PRODUCTION_FILES = productionSourceFiles(process.cwd());

describe('H6.7 credential boundary', () => {
	it('sends one ephemeral SecretStorage value only to the exact official HTTPS endpoint', async () => {
		const settings = { ...DEFAULT_SETTINGS, apiKeySecret: 'gw2-primary' };
		const provider = new HostApiKeyProvider(
			{
				list: () => [settings.apiKeySecret],
				get: (name) => name === settings.apiKeySecret ? TOKEN_SENTINEL : null,
			},
			() => settings.apiKeySecret,
		);
		const requests: HttpRequest[] = [];
		const transport = new ResilientHttpTransport({
			maxRetries: 0,
			request: async (request) => {
				requests.push(request);
				throw new Error(`transport body ${TOKEN_SENTINEL}`);
			},
		});

		const client = new GuildWars2Client(transport, provider);
		const error = await client.beginOperation().request('account').catch((reason: unknown) => reason);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: `${OFFICIAL_GW2_API_URL}/account`,
			method: 'GET',
			headers: { Authorization: `Bearer ${TOKEN_SENTINEL}` },
		});
		expect(new URL(requests[0]!.url)).toMatchObject({ protocol: 'https:', hostname: 'api.guildwars2.com' });
		expect(JSON.stringify(error)).not.toContain(TOKEN_SENTINEL);
		expect(String(error)).not.toContain(TOKEN_SENTINEL);
		expect(error).toMatchObject({ name: 'HttpTransportError', message: 'Network request failed.' });
	});

	it('drops a legacy credential before the production load path calls saveData', async () => {
		const persisted = {
			...DEFAULT_SETTINGS,
			apiKeySecret: 'gw2-primary',
			outputFolder: 'Guild Wars 2/CON',
			apiKey: TOKEN_SENTINEL,
		};
		const saved: unknown[] = [];
		// The production load path is `loadTyrianSettings`, the one `onload` boots through (R1a):
		// it reads and writes `data.json` only through the host's settings port, here the real
		// `ObsidianHost` over `loadData`/`saveData`.
		const { host } = withObsidianHost({
			app: { vault: { configDir: 'test-config-dir' } },
			loadData: async () => persisted,
			saveData: async (value: unknown) => { saved.push(structuredClone(value)); },
		});

		const settings = await loadTyrianSettings(host);

		expect(saved).toHaveLength(1);
		expect(JSON.stringify(settings)).not.toContain(TOKEN_SENTINEL);
		expect(JSON.stringify(saved)).not.toContain(TOKEN_SENTINEL);
		expect(saved[0]).not.toHaveProperty('apiKey');
		expect(saved[0]).toHaveProperty('legacyOutputFolder', persisted.outputFolder);
	});

	it('discovers every current persistence/runtime/note boundary and denies credential capability', () => {
		const boundaries = PRODUCTION_FILES.filter((path) => isSensitivePersistenceBoundary(path));
		expect(boundaries).toEqual(expect.arrayContaining([
			'src/assets/managed-assets-pointer.ts',
			'src/catalog/persistent-catalog-cache.ts',
			// DE-01, step 3e: it writes the session's notes and the summary's saved proof, so its name
			// keeps it inside the persistence guard; a rename that leaves the guard turns this red.
			'src/runtime/session-note-runtime.ts',
			'src/sessions/coordination-store.ts',
			// DE-07: the heartbeat re-saves the active SessionRuntimeRecord (`saveActiveEvidence`), so its
			// name keeps it inside the persistence guard; a rename that leaves the guard turns this red.
			'src/sessions/manual-session-runtime-heartbeat.ts',
			// DE-07: the start, stop, recovery and reclaim save, recover and clear SessionRuntimeRecords
			// (`runtimeStore.save`/`clear`), so the same guard holds their module by name.
			'src/sessions/manual-session-runtime-transitions.ts',
			'src/sessions/pending-proposal-store.ts',
			'src/sessions/session-detection-quality-store.ts',
			'src/sessions/session-note-model.ts',
			'src/sessions/session-note-renderer.ts',
			'src/sessions/session-note-writer.ts',
			'src/sessions/session-runtime-store.ts',
		]));
		for (const path of boundaries) {
			expect(persistenceBoundaryHasCredentialCapability(path), `${path} receives a credential capability`).toBe(false);
		}
	});

	it('detects credential aliases when a future persistent store is added', () => {
		const futureStorePath = 'src/future-credential-store.ts';
		expect(isSensitivePersistenceBoundary(futureStorePath)).toBe(true);
		for (const capability of ['accessToken', 'refreshToken', 'bearerToken', 'credential', 'token']) {
			const source = `export interface FuturePersistentState { ${capability}: string }`;
			expect(CREDENTIAL_CAPABILITY_PATTERN.test(source), `${capability} bypassed the persistent-boundary guard`).toBe(true);
		}
	});

	it('requires explicit review for future outbound, analytics, telemetry, or Mumble modules', () => {
		expect([
			'src/session-exporter.ts',
			'src/supportBundle.ts',
			'src/accountSync.ts',
			'src/native/mumble_link.ts',
			'src/analytics.ts',
			'src/localTelemetry.ts',
			'src/diagnostic-uploader.ts',
		].filter((path) => isFutureOutboundFile(path))).toHaveLength(7);
		expect(isFutureOutboundFile('src/async-queue.ts')).toBe(false);
		const discovered = PRODUCTION_FILES
			.filter((path) => isFutureOutboundFile(path))
			.sort();
		expect(discovered).toEqual(REVIEWED_FUTURE_OUTBOUND_FILES);
	});

	it('keeps every network and credential capability on an exact reviewed census', () => {
		const census = censusNetworkAndCredentialCapabilities(process.cwd());
		expect(census.requestUrl).toEqual(REVIEWED_REQUEST_URL_FILES);
		expect(census.fetch).toEqual(REVIEWED_FETCH_FILES);
		expect(census.webSocket).toEqual(REVIEWED_WEB_SOCKET_FILES);
		expect(census.httpImport).toEqual(REVIEWED_HTTP_IMPORT_FILES);
		expect(census.netImport).toEqual(REVIEWED_NET_IMPORT_FILES);
		expect(census.secretProviderImport).toEqual(REVIEWED_SECRET_PROVIDER_IMPORT_FILES);
		expect(census.secretCapability).toEqual(REVIEWED_SECRET_CAPABILITY_FILES);
	});
});

// H6.7. `GuildWars2Client`'s constructor (src/account/guild-wars-2-client.ts) takes exactly two
// typed parameters, `HttpTransport` and `ApiKeyProvider`: `npx tsc --noEmit` already rejects any
// call site (main.ts's included) that passes a third argument, such as a raw API key alongside the
// provider. A source-text assertion re-checking `new GuildWars2Client(transport, apiKeyProvider)`'s
// exact spelling in main.ts stayed green even while the type checker enforced the same property;
// it read main.ts's characters instead of exercising the constructor. Verified by temporarily adding
// a third argument at the real call site and observing `tsc` report TS2554 "Expected 2 arguments,
// but got 3", then reverting: 2026-09-10.

// H13.9/H13.15/H6.7: the seven capability patterns and the `CREDENTIAL_CAPABILITY_PATTERN` above
// stay in sync with `scripts/security-scan.mjs`, which owns the walk and the exact regex source;
// this suite only carries the reviewed allowlists, which are data, not a text-match on a module.
const CREDENTIAL_CAPABILITY_PATTERN = /from\s+['"][^'"]*secret-provider['"]|\b(?:Authorization|Bearer|SecretStorage|readSelectedApiKey|ApiKeyProvider|apiKey|accessToken|refreshToken|bearerToken|credential|token)\b/u;

// These guards exercise the real authenticated client and production load method, then discover
// persistence and future outbound module names. Computed imports or deliberately obfuscated names
// still require review; the repository scanner and exact-key validators provide independent layers.
