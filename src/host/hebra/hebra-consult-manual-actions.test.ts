// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi, hebraSettingsKey, TYRIAN_KEYCHAIN_ACCOUNT, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { createTyrianRuntime, type TyrianCompanionCore } from '../../runtime/tyrian-companion-core';
import { activateTyrian } from './hebra-runtime';

/**
 * Hebra's report (4 oct 2026, the Mac in consult): "Comprobar conexión" did nothing and the key row
 * kept "Sin comprobar. No se ha realizado ninguna petición de red.". This runs the REAL core over
 * HebraHost (the fake API of `hebra-plugin-fakes.ts`), with the key in Hebra's keychain and the
 * device already in consult when it starts, the way that Mac is.
 */

interface ConsultCore {
	getConnectionState(): { status: string };
	checkConnection(): Promise<{ status: string }>;
	getCollectorMode(): string;
	runInventoryVaultSync(): Promise<void>;
	getInventoryVaultSyncRunState(): { status: string; lastRun: { status: string } | null };
}

const CONSULT_NOTICE = 'Esta instalación está en modo consulta: las sesiones, la detección y los avisos son del recolector. El inventario sí se actualiza a mano. Cámbiala a recolector en Ajustes.';

afterEach(() => {
	document.body.className = '';
});

describe('Tyrian in Hebra, consult mode: the manual connection check and inventory sync', () => {
	it('"Comprobar conexión" asks the key and the account, and a sync nobody prepared ends in success', async () => {
		const requests: string[] = [];
		const test = consultHebra(requests);
		const factory = new IDBFactory();
		// The mode lives on the device: a first start without a key seeds consult (and, being consult,
		// sends nothing, so no request of it can land in what is counted below); the key comes after
		// and the next start keeps consult.
		const first = await activate(test, factory);
		expect(first.core.getCollectorMode()).toBe('consult');
		await first.cleanup();
		saveSettings(test, { apiKeySecret: 'gw2-main', outputFolder: 'Tyrian Companion' });
		test.fake.recorded.notices.length = 0;

		const { core, cleanup } = await activate(test, factory);
		expect(core.getCollectorMode()).toBe('consult');
		expect(core.getConnectionState()).toEqual({ status: 'idle' });
		expect(requests).toEqual([]);

		await expect(core.checkConnection()).resolves.toMatchObject({ status: 'connected' });
		expect(requests.map(endpoint)).toEqual(['tokeninfo', 'account']);
		expect(core.getConnectionState()).toMatchObject({ status: 'connected' });
		expect(test.fake.recorded.notices).not.toContain(CONSULT_NOTICE);

		await core.runInventoryVaultSync();
		expect(core.getInventoryVaultSyncRunState()).toMatchObject({ status: 'idle', lastRun: { status: 'success' } });
		expect(requests.map(endpoint)).toEqual(expect.arrayContaining(['characters', 'account/inventory']));
		expect(test.fake.recorded.notices).not.toContain(CONSULT_NOTICE);
		await cleanup();
	}, 30_000);

	it('the palette command of the inventory sync, with no valid preview, says why in the notice instead of the generic text', async () => {
		const requests: string[] = [];
		const test = consultHebra(requests);
		const factory = new IDBFactory();
		await (await activate(test, factory)).cleanup();
		saveSettings(test, { apiKeySecret: 'gw2-main', outputFolder: 'Tyrian Companion' });
		const { cleanup } = await activate(test, factory);
		test.fake.recorded.notices.length = 0;

		// The first start's commands stay recorded (no key, so another reason); the one that counts is the last registration.
		const command = test.fake.recorded.commands.filter((entry) => entry.id.endsWith('apply-inventory-vault-sync')).at(-1);
		expect(command).toBeDefined();
		await command?.run();
		expect(test.fake.recorded.notices).toEqual(['Haz una vista previa válida primero.']);
		await cleanup();
	}, 30_000);
});

/** A Hebra library with the output folder, settings without a key yet, and the key in the keychain. */
function consultHebra(requests: string[]): TyrianTestApi {
	const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { 'gw2-main': 'KEY' } })]]);
	const test = createTyrianTestApi({
		keychain,
		http: async (request) => {
			requests.push(request.url);
			return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(validAccount(endpoint(request.url))) };
		},
	});
	test.library.addFolder('tc', 'root', 'Tyrian Companion');
	saveSettings(test, { outputFolder: 'Tyrian Companion' });
	return test;
}

/** This device's plugin settings, read on the next start. */
function saveSettings(test: TyrianTestApi, value: unknown): void {
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify(value));
}

async function activate(test: TyrianTestApi, factory: IDBFactory): Promise<{ core: ConsultCore; cleanup: () => Promise<void> }> {
	let core: TyrianCompanionCore | null = null;
	const cleanup = await activateTyrian(test.api, {
		indexedDB: factory,
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
	});
	// The boot's fire-and-forget work (IndexedDB, the collector's warm-up check) settles first.
	await new Promise((resolve) => { window.setTimeout(resolve, 50); });
	return { core: core as unknown as ConsultCore, cleanup: async () => { await cleanup(); } };
}

function endpoint(url: string): string {
	return new URL(url).pathname.replace(/^\/v2\//u, '');
}

/** A valid key on an account with one empty character. */
function validAccount(path: string): unknown {
	if (path === 'tokeninfo') return { id: 'key-1', name: 'main', permissions: ['account', 'inventories', 'characters', 'wallet', 'tradingpost', 'progression', 'unlocks', 'builds'] };
	if (path === 'account') return { id: 'account-1', name: 'Hero.1234', world: 1001, created: '2020-01-01T00:00:00Z', access: ['GuildWars2'], commander: false };
	if (path === 'characters') return ['Hero'];
	if (path.startsWith('characters/')) return { bags: [] };
	if (path === 'commerce/delivery') return { coins: 0, items: [] };
	return [];
}
