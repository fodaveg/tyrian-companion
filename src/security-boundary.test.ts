import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GuildWars2Client, OFFICIAL_GW2_API_URL } from './account/guild-wars-2-client';
import { ResilientHttpTransport, type HttpRequest } from './core/http';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import TyrianCompanionPlugin from './main';

const TOKEN_SENTINEL = ['tyrian-h6', 'token-sentinel', 'not-a-credential'].join('-');
const CREDENTIAL_CAPABILITY_PATTERN = /from\s+['"][^'"]*secret-provider['"]|\b(?:Authorization|Bearer|SecretStorage|readSelectedApiKey|ApiKeyProvider|apiKey|accessToken|refreshToken|bearerToken|credential|token)\b/u;
const FUTURE_OUTBOUND_TOKEN_PATTERN = /(?:^|[-_.])(?:analytics|backup|diagnostic|export|mumble|report|share|support|sync|telemetry|uploader)[a-z]*(?=[-_.]|$)/iu;
const FUTURE_OUTBOUND_CAMEL_PATTERN = /(?:Analytics|Backup|Diagnostic|Export|Mumble|Report|Share|Support|Sync|Telemetry|Uploader)/u;
const REQUEST_URL_CAPABILITY_PATTERN = /\brequestUrl\b/u;
const FETCH_CAPABILITY_PATTERN = /\bfetch\b/u;
const WEB_SOCKET_CAPABILITY_PATTERN = /\bWebSocket\b/u;
const HTTP_IMPORT_PATTERN = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)['"](?:(?:node:)?https?|axios|undici|[^'"]*\/(?:http|obsidian-http))['"]/mu;
const SECRET_PROVIDER_IMPORT_PATTERN = /from\s+['"][^'"]*(?:^|\/)secret-provider['"]/u;
const SECRET_CAPABILITY_PATTERN = /\b(?:ApiKeyProvider|ObsidianApiKeyProvider|readSelectedApiKey|secretStorage)\b/u;
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
	// Pure UI projection. The filename contains `sync`, but the reviewed module has no outbound or credential capability.
	'src/ui/inventory-sync-panel-view.ts',
	'src/ui/inventory-vault-sync-controller.ts',
	'src/ui/inventory-vault-sync-run-controller.ts',
	'src/ui/wallet-vault-sync-controller.ts',
	'src/wallet/wallet-vault-sync.ts',
];
const REVIEWED_REQUEST_URL_FILES = ['src/core/obsidian-http.ts'];
const REVIEWED_FETCH_FILES: readonly string[] = [];
const REVIEWED_WEB_SOCKET_FILES: readonly string[] = [];
const REVIEWED_HTTP_IMPORT_FILES = [
	'src/account/account-service.ts',
	'src/account/guild-wars-2-client.ts',
	'src/account/rate-limited-storage-snapshot-service.ts',
	'src/account/storage-snapshot-service.ts',
	'src/advisor/inventory-advisor-evidence.ts',
	'src/catalog/public-catalog-client.ts',
	'src/catalog/public-catalog-service.ts',
	'src/core/obsidian-http.ts',
	'src/economy/price-history-capture.ts',
	'src/main.ts',
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
const PRODUCTION_FILES = sourceFiles('src');

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
			const source = readFileSync(path, 'utf8');
			expect(source, `${path} receives a credential capability`).not.toMatch(CREDENTIAL_CAPABILITY_PATTERN);
		}
	});

	it('detects credential aliases when a future persistent store is added', () => {
		const futureStorePath = 'src/future-credential-store.ts';
		expect(isSensitivePersistenceBoundary(futureStorePath)).toBe(true);
		for (const capability of ['accessToken', 'refreshToken', 'bearerToken', 'credential', 'token']) {
			const source = `export interface FuturePersistentState { ${capability}: string }`;
			expect(source, `${capability} bypassed the persistent-boundary guard`).toMatch(CREDENTIAL_CAPABILITY_PATTERN);
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
		expect(filesMatching(REQUEST_URL_CAPABILITY_PATTERN)).toEqual(REVIEWED_REQUEST_URL_FILES);
		expect(filesMatching(FETCH_CAPABILITY_PATTERN)).toEqual(REVIEWED_FETCH_FILES);
		expect(filesMatching(WEB_SOCKET_CAPABILITY_PATTERN)).toEqual(REVIEWED_WEB_SOCKET_FILES);
		expect(filesMatching(HTTP_IMPORT_PATTERN)).toEqual(REVIEWED_HTTP_IMPORT_FILES);
		expect(filesMatching(SECRET_PROVIDER_IMPORT_PATTERN)).toEqual(REVIEWED_SECRET_PROVIDER_IMPORT_FILES);
		expect(filesMatching(SECRET_CAPABILITY_PATTERN)).toEqual(REVIEWED_SECRET_CAPABILITY_FILES);
		for (const source of [
			"import { request } from 'node:https';",
			"import axios from 'axios';",
			"import 'node:http';",
			"await import(\n  'undici'\n);",
			"const https = require( 'node:https' );",
		]) {
			expect(HTTP_IMPORT_PATTERN.test(source), `${source} bypassed the HTTP import census`).toBe(true);
		}
		expect(HTTP_IMPORT_PATTERN.test("const moduleName = 'node:http'; await import(moduleName);")).toBe(false);
	});

	it('keeps the production composition on the fixed authenticated client constructor', () => {
		const source = readFileSync('src/main.ts', 'utf8');
		expect(source).toContain('new GuildWars2Client(transport, apiKeyProvider)');
		expect(source).not.toMatch(/new GuildWars2Client\([^)]*,[^)]*,/u);
	});
});

interface SettingsLoadHarness {
	app: { vault: { configDir: string } };
	settings: TyrianSettings;
	loadData(): Promise<unknown>;
	saveData(value: unknown): Promise<void>;
}

function sourceFiles(root: string): string[] {
	return walk(root)
		.map((path) => relative('.', path).replaceAll('\\', '/'))
		.filter((path) => path.endsWith('.ts') && !/(?:^|\/)(?:__fixtures__|test)(?:\/|$)/u.test(path))
		.filter((path) => !/\.(?:spec|test)\.ts$/u.test(path))
		.sort();
}

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
}

function isSensitivePersistenceBoundary(path: string): boolean {
	const name = basename(path);
	if (/(?:session-note|session-runtime)/u.test(name)) return true;
	if (/(?:store|writer|cache|pointer)(?:[-_.]|$)/iu.test(name)) return true;
	const source = readFileSync(path, 'utf8');
	return /\b(?:IDBDatabase|IDBFactory|SessionNoteVault)\b|\.objectStore\s*\(/u.test(source);
}

function isFutureOutboundFile(path: string): boolean {
	const name = basename(path);
	return FUTURE_OUTBOUND_TOKEN_PATTERN.test(name) || FUTURE_OUTBOUND_CAMEL_PATTERN.test(name);
}

function filesMatching(pattern: RegExp): string[] {
	return PRODUCTION_FILES.filter((path) => pattern.test(readFileSync(path, 'utf8')));
}

// These guards exercise the real authenticated client and production load method, then discover
// persistence and future outbound module names. Computed imports or deliberately obfuscated names
// still require review; the repository scanner and exact-key validators provide independent layers.
