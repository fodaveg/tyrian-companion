import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { GuildWars2Client, OFFICIAL_GW2_API_URL } from './account/guild-wars-2-client';
import { ResilientHttpTransport, type HttpRequest } from './core/http';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import TyrianCompanionPlugin from './main';
import {
	censusNetworkAndCredentialCapabilities,
	isFutureOutboundFile,
	isSensitivePersistenceBoundary,
	persistenceBoundaryHasCredentialCapability,
	productionSourceFiles,
} from '../scripts/security-scan.mjs';
import { readModuleSource } from './test/module-boundary';

const TOKEN_SENTINEL = ['tyrian-h6', 'token-sentinel', 'not-a-credential'].join('-');
const REVIEWED_FUTURE_OUTBOUND_FILES = [
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
const REVIEWED_REQUEST_URL_FILES = ['src/core/obsidian-http.ts'];
const REVIEWED_FETCH_FILES: readonly string[] = [];
const REVIEWED_WEB_SOCKET_FILES: readonly string[] = [];
// H13.9/H13.15. The only module allowed to open `node:net`: a loopback-only TCP
// server for the in-game alert bridge. Reviewed: it binds `127.0.0.1` exclusively,
// reads at most one line from a client before refusing further input, and never
// imports `src/platform/` (H8/Mumble).
const REVIEWED_NET_IMPORT_FILES = ['src/alerts/alert-ingame-server.ts'];
const REVIEWED_HTTP_IMPORT_FILES = [
	'src/account/account-service.ts',
	'src/account/guild-wars-2-client.ts',
	'src/account/rate-limited-storage-snapshot-service.ts',
	'src/account/storage-snapshot-service.ts',
	'src/advisor/inventory-advisor-evidence.ts',
	'src/catalog/public-catalog-client.ts',
	'src/catalog/public-catalog-service.ts',
	'src/core/obsidian-http.ts',
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
	'src/main.ts',
	// H13.10. Composition only: it names the transport type so it can hand the
	// one the plugin already built to the sell signal. It opens no call itself.
	'src/runtime/assemble-price-history.ts',
	'src/sessions/api-poll-scheduler.ts',
	'src/sessions/assisted-detection-service.ts',
	'src/sessions/manual-session-start-service.ts',
	'src/sessions/session-start-capture.ts',
];
const REVIEWED_SECRET_PROVIDER_IMPORT_FILES = [
	'src/account/guild-wars-2-client.ts',
	'src/main.ts',
];
const REVIEWED_SECRET_CAPABILITY_FILES = [
	'src/account/guild-wars-2-client.ts',
	'src/core/secret-provider.ts',
	'src/main.ts',
];
const PRODUCTION_FILES = productionSourceFiles(process.cwd());

describe('H6.7 credential boundary', () => {
	it('sends one ephemeral SecretStorage value only to the exact official HTTPS endpoint', async () => {
		const settings = { ...DEFAULT_SETTINGS, apiKeySecret: 'gw2-primary' };
		const provider = new ObsidianApiKeyProvider(
			{
				secretStorage: {
					listSecrets: () => [settings.apiKeySecret],
					getSecret: (name) => name === settings.apiKeySecret ? TOKEN_SENTINEL : null,
				},
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
		const harness: SettingsLoadHarness = {
			app: { vault: { configDir: 'test-config-dir' } },
			settings: { ...DEFAULT_SETTINGS },
			loadData: async () => persisted,
			saveData: async (value) => { saved.push(structuredClone(value)); },
		};
		const loadSettings = (TyrianCompanionPlugin.prototype as unknown as {
			loadSettings(this: SettingsLoadHarness): Promise<void>;
		}).loadSettings.bind(harness);

		await loadSettings();

		expect(saved).toHaveLength(1);
		expect(JSON.stringify(harness.settings)).not.toContain(TOKEN_SENTINEL);
		expect(JSON.stringify(saved)).not.toContain(TOKEN_SENTINEL);
		expect(saved[0]).not.toHaveProperty('apiKey');
		expect(saved[0]).toHaveProperty('legacyOutputFolder', persisted.outputFolder);
	});

	it('discovers every current persistence/runtime/note boundary and denies credential capability', () => {
		const boundaries = PRODUCTION_FILES.filter((path) => isSensitivePersistenceBoundary(path));
		expect(boundaries).toEqual(expect.arrayContaining([
			'src/assets/managed-assets-pointer.ts',
			'src/catalog/persistent-catalog-cache.ts',
			'src/sessions/coordination-store.ts',
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

	it('keeps the production composition on the fixed authenticated client constructor', () => {
		const source = readModuleSource('src/main.ts');
		expect(source).toContain('new GuildWars2Client(transport, apiKeyProvider)');
		expect(source).not.toMatch(/new GuildWars2Client\([^)]*,[^)]*,/u);
	});
});

// H13.9/H13.15/H6.7: the seven capability patterns and the `CREDENTIAL_CAPABILITY_PATTERN` above
// stay in sync with `scripts/security-scan.mjs`, which owns the walk and the exact regex source;
// this suite only carries the reviewed allowlists, which are data, not a text-match on a module.
const CREDENTIAL_CAPABILITY_PATTERN = /from\s+['"][^'"]*secret-provider['"]|\b(?:Authorization|Bearer|SecretStorage|readSelectedApiKey|ApiKeyProvider|apiKey|accessToken|refreshToken|bearerToken|credential|token)\b/u;

interface SettingsLoadHarness {
	app: { vault: { configDir: string } };
	settings: TyrianSettings;
	loadData(): Promise<unknown>;
	saveData(value: unknown): Promise<void>;
}

// These guards exercise the real authenticated client and production load method, then discover
// persistence and future outbound module names. Computed imports or deliberately obfuscated names
// still require review; the repository scanner and exact-key validators provide independent layers.
