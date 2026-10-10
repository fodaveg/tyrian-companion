// `IDBKeyRange` is a real global in the webview; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, migrateSettings, SETTINGS_SCHEMA_VERSION } from '../../core/settings';
import { VIEW_PLACEMENT_KEY, loadViewPlacement, saveViewPlacement } from '../../runtime/view-placement';
import { createHebraStorage, hebraDeviceKey, hebraSettingsKey } from '../../test/hebra-plugin-fakes';
import {
	abortingIndexedDb, closeUnderneath, emitEngineClose, killStorage, reviveStorage, settlement, trackedIndexedDb,
} from '../../test/indexed-db-connections';
import {
	createIndexedDbFileBackend,
	createLocalFileStorage,
	createMemoryFileBackend,
	createTyrianLocalStoragePort,
	createTyrianSettingsPort,
	HEBRA_DEVICE_SETTING_KEYS,
	hebraDeviceSettingKey,
	type LocalFileBackend,
} from './local-storage';

// Ported from Hebra's `src/lib/modules/tyrian/local-storage.test.ts`. The keys are now Hebra's
// (`api.storage`), so the tests check the plugin lands on the ones the compiled module used.

describe('settings over api.storage.settings', () => {
	it('a library without settings loads null (the core starts in consultation mode)', async () => {
		const settings = createTyrianSettingsPort(createHebraStorage(new Map(), 'tyrian-companion', 'lib-1'));
		expect(await settings.load()).toBeNull();
		expect(settings.latest()).toBeNull();
	});

	it('saves and reads back per library, under the compiled module\'s key, without mixing two libraries', async () => {
		const local = new Map<string, string>();
		const one = createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-1'));
		const two = createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-2'));
		await one.save({ outputFolder: 'GW2' });
		// The device settings it never saved come back as the core's defaults (see the device describe below).
		const loaded = await one.load() as Record<string, unknown>;
		expect(loaded.outputFolder).toBe('GW2');
		expect(one.latest()).toBe(loaded);
		expect(await two.load()).toBeNull();
		expect([...local.keys()]).toEqual(['hebra.library-v1.module.tyrian-companion.settings:lib-1']);
		expect(hebraSettingsKey('tyrian-companion', 'lib-1')).toBe('hebra.library-v1.module.tyrian-companion.settings:lib-1');
	});

	it('a corrupt JSON loads null instead of throwing', async () => {
		const local = new Map([[hebraSettingsKey('tyrian-companion', 'lib-1'), '{broken']]);
		expect(await createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-1')).load()).toBeNull();
	});
});

describe('settings of this device over api.storage.device', () => {
	const settingsKey = hebraSettingsKey('tyrian-companion', 'lib-1');
	const deviceKey = (key: string): string => hebraDeviceKey('tyrian-companion', 'lib-1', hebraDeviceSettingKey(key));
	const receipt = { finishedAt: 1_700_000_000_000, outcome: 'applied' };
	/** What an older build saved: every setting, the device ones included, in the shared scope. */
	const legacy = {
		schemaVersion: 15,
		outputFolder: 'GW2',
		alertWebhookUrl: 'https://hooks.example/abc',
		alertIngameEnabled: true,
		alertIngamePort: 47_123,
		alertIngameSecret: 'tyrian-companion-ingame',
		debugLoggingEnabled: true,
		debugLoggingLevel: 'debug',
		inventorySyncLastRun: receipt,
	};
	const shared = (local: Map<string, string>): Record<string, unknown> =>
		JSON.parse(local.get(settingsKey) ?? 'null') as Record<string, unknown>;
	const deviceDefaults = (): Record<string, unknown> =>
		Object.fromEntries(HEBRA_DEVICE_SETTING_KEYS.map((key) => [key, DEFAULT_SETTINGS[key]]));
	const port = (local: Map<string, string>, report?: (error: unknown, where: string) => void) =>
		createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-1'), { report });

	it('moves the device settings an older build left in settings to device, once, and the core sees the same object', async () => {
		const local = new Map([[settingsKey, JSON.stringify(legacy)]]);

		expect(await port(local).load()).toEqual(legacy);

		expect(shared(local)).toEqual({ schemaVersion: 15, outputFolder: 'GW2', alertWebhookUrl: 'https://hooks.example/abc' });
		for (const key of HEBRA_DEVICE_SETTING_KEYS) {
			expect(JSON.parse(local.get(deviceKey(key)) ?? 'null')).toEqual(legacy[key]);
		}
		// Idempotent: a second load finds them in device and writes nothing.
		const before = new Map(local);
		expect(await port(local).load()).toEqual(legacy);
		expect(local).toEqual(before);
	});

	it('reads the device settings from device when settings no longer has them', async () => {
		const local = new Map([[settingsKey, JSON.stringify({ schemaVersion: 15, outputFolder: 'GW2' })]]);
		local.set(deviceKey('alertIngamePort'), JSON.stringify(47_200));
		local.set(deviceKey('debugLoggingLevel'), JSON.stringify('info'));

		expect(await port(local).load()).toEqual({
			...deviceDefaults(),
			schemaVersion: 15,
			outputFolder: 'GW2',
			alertIngamePort: 47_200,
			debugLoggingLevel: 'info',
		});
		expect(shared(local)).toEqual({ schemaVersion: 15, outputFolder: 'GW2' });
	});

	it('with a value in both, the device one wins and is not overwritten by the shared one', async () => {
		const local = new Map([[settingsKey, JSON.stringify({ ...legacy, alertIngamePort: 47_123 })]]);
		local.set(deviceKey('alertIngamePort'), JSON.stringify(47_999));

		const loaded = await port(local).load() as Record<string, unknown>;

		expect(loaded.alertIngamePort).toBe(47_999);
		expect(JSON.parse(local.get(deviceKey('alertIngamePort')) ?? 'null')).toBe(47_999);
	});

	it('a device write that fails keeps the value in settings and reports it; the next load moves it', async () => {
		const local = new Map([[settingsKey, JSON.stringify(legacy)]]);
		const storage = createHebraStorage(local, 'tyrian-companion', 'lib-1');
		const refusal = new Error('quota');
		const set = storage.device.set.bind(storage.device);
		storage.device.set = (key, value) => {
			if (key === hebraDeviceSettingKey('alertIngamePort')) throw refusal;
			set(key, value);
		};
		const report = vi.fn();

		expect(await createTyrianSettingsPort(storage, { report }).load()).toEqual(legacy);

		expect(shared(local).alertIngamePort).toBe(47_123);
		expect(local.has(deviceKey('alertIngamePort'))).toBe(false);
		expect(report).toHaveBeenCalledWith(refusal, 'settings.device-move');
		// The others did move.
		expect(shared(local).alertIngameEnabled).toBeUndefined();

		storage.device.set = set;
		expect(await createTyrianSettingsPort(storage).load()).toEqual(legacy);
		expect(shared(local).alertIngamePort).toBeUndefined();
		expect(JSON.parse(local.get(deviceKey('alertIngamePort')) ?? 'null')).toBe(47_123);
	});

	it('a shared save that fails after the move still loads, reports it, and loses nothing', async () => {
		const local = new Map([[settingsKey, JSON.stringify(legacy)]]);
		const storage = createHebraStorage(local, 'tyrian-companion', 'lib-1');
		const refusal = new Error('disk');
		storage.settings.save = async () => { throw refusal; };
		const report = vi.fn();

		expect(await createTyrianSettingsPort(storage, { report }).load()).toEqual(legacy);

		expect(report).toHaveBeenCalledWith(refusal, 'settings.device-move');
		expect(JSON.parse(local.get(deviceKey('alertIngamePort')) ?? 'null')).toBe(47_123);
	});

	it('saves the device settings to device and never to settings, and clears one that is null', async () => {
		const local = new Map<string, string>();
		local.set(deviceKey('inventorySyncLastRun'), JSON.stringify(receipt));
		const settings = port(local);

		await settings.save({ ...legacy, alertIngamePort: 47_300, inventorySyncLastRun: null });

		expect(shared(local)).toEqual({ schemaVersion: 15, outputFolder: 'GW2', alertWebhookUrl: 'https://hooks.example/abc' });
		expect(JSON.parse(local.get(deviceKey('alertIngamePort')) ?? 'null')).toBe(47_300);
		expect(local.has(deviceKey('inventorySyncLastRun'))).toBe(false);
		expect(settings.latest()).toEqual({ ...legacy, alertIngamePort: 47_300, inventorySyncLastRun: null });
		expect(await settings.load()).toEqual({ ...legacy, alertIngamePort: 47_300, inventorySyncLastRun: null });
	});

	it('a device setting in neither scope reaches the core as its default: diagnostic logging off, nothing written to device', async () => {
		// Settings that came from another device (or that a downgrade left behind): a schema with explicit
		// debug settings and no device setting anywhere. `migrateSettings` alone reads the absent
		// `debugLoggingEnabled` of such a schema as on.
		const local = new Map([[settingsKey, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, outputFolder: 'GW2' })]]);
		expect(migrateSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION }).debugLoggingEnabled).toBe(true);

		const loaded = await port(local).load();

		expect(migrateSettings(loaded).debugLoggingEnabled).toBe(false);
		expect(loaded).toEqual({ ...deviceDefaults(), schemaVersion: SETTINGS_SCHEMA_VERSION, outputFolder: 'GW2' });
		expect([...local.keys()]).toEqual([settingsKey]);
		expect(shared(local)).toEqual({ schemaVersion: SETTINGS_SCHEMA_VERSION, outputFolder: 'GW2' });
	});

	it('a library without settings still loads null, whatever this device holds', async () => {
		const local = new Map([[deviceKey('alertIngamePort'), JSON.stringify(47_200)]]);
		expect(await port(local).load()).toBeNull();
	});
});

describe('localStorage over api.storage.device', () => {
	it('synchronous load/save per library; null removes the key', () => {
		const local = new Map<string, string>();
		const port = createTyrianLocalStoragePort(createHebraStorage(local, 'tyrian-companion', 'lib-1'));
		expect(port.load('ingame-session')).toBeNull();
		port.save('ingame-session', { ref: 'abc', startedAt: 1 });
		expect(port.load('ingame-session')).toEqual({ ref: 'abc', startedAt: 1 });
		expect(local.has('hebra.library-v1.module.tyrian-companion.local:lib-1:ingame-session')).toBe(true);
		expect(hebraDeviceKey('tyrian-companion', 'lib-1', 'ingame-session')).toBe('hebra.library-v1.module.tyrian-companion.local:lib-1:ingame-session');
		expect(createTyrianLocalStoragePort(createHebraStorage(local, 'tyrian-companion', 'lib-2')).load('ingame-session')).toBeNull();
		port.save('ingame-session', null);
		expect(port.load('ingame-session')).toBeNull();
		expect(local.size).toBe(0);
	});

	it('keeps where this device shows the plugin under the device key, never in the synced settings', () => {
		const local = new Map<string, string>();
		const port = createTyrianLocalStoragePort(createHebraStorage(local, 'tyrian-companion', 'lib-1'));
		expect(loadViewPlacement(port)).toBe('main');

		saveViewPlacement(port, 'sidebar');

		expect([...local.keys()]).toEqual([hebraDeviceKey('tyrian-companion', 'lib-1', VIEW_PLACEMENT_KEY)]);
		expect(local.has(hebraSettingsKey('tyrian-companion', 'lib-1'))).toBe(false);
		expect(loadViewPlacement(port)).toBe('sidebar');
		// A value this build does not know (a later one wrote it, or it is corrupt) reads as the default.
		local.set(hebraDeviceKey('tyrian-companion', 'lib-1', VIEW_PLACEMENT_KEY), JSON.stringify('floating'));
		expect(loadViewPlacement(port)).toBe('main');
	});
});

function adapterContract(name: string, backend: () => LocalFileBackend): void {
	describe(`file adapter over ${name}`, () => {
		it('write, append, read, rename and remove', async () => {
			const storage = createLocalFileStorage(backend(), 'lib-1');
			await storage.write('.hebra/logs/a.jsonl', 'one\n');
			await storage.append('.hebra/logs/a.jsonl', 'two\n');
			expect(await storage.read('.hebra/logs/a.jsonl')).toBe('one\ntwo\n');
			await storage.rename('.hebra/logs/a.jsonl', '.hebra/logs/b.jsonl');
			expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(false);
			expect(await storage.read('.hebra/logs/b.jsonl')).toBe('one\ntwo\n');
			await storage.remove('.hebra/logs/b.jsonl');
			expect(await storage.exists('.hebra/logs/b.jsonl')).toBe(false);
			await expect(storage.read('.hebra/logs/b.jsonl')).rejects.toThrow('does not exist');
		});

		it('a directory exists when made or when it holds something, and is unseen from another library', async () => {
			const files = backend();
			const storage = createLocalFileStorage(files, 'lib-1');
			expect(await storage.exists('.hebra/logs')).toBe(false);
			await storage.mkdir('.hebra/logs');
			expect(await storage.exists('.hebra/logs')).toBe(true);
			await storage.append('.hebra/other/x.txt', 'x');
			expect(await storage.exists('.hebra/other')).toBe(true);
			expect(await createLocalFileStorage(files, 'lib-2').exists('.hebra/other')).toBe(false);
		});
	});
}

adapterContract('memory', () => createMemoryFileBackend());
adapterContract('IndexedDB', () => createIndexedDbFileBackend(new IDBFactory(), 'hebra-tyrian-local-files'));

describe('createIndexedDbFileBackend close()', () => {
	it('closes its connection once, and a later call opens a new one', async () => {
		const tracked = trackedIndexedDb();
		const backend = createIndexedDbFileBackend(tracked.factory, 'hebra-tyrian-local-files');
		backend.close?.();
		await backend.set('a', 'one');
		expect(tracked.connections).toHaveLength(1);
		const closed = vi.spyOn(tracked.connections[0]!, 'close');

		backend.close?.();
		backend.close?.();

		expect(closed).toHaveBeenCalledTimes(1);
		expect(await backend.get('a')).toBe('one');
		expect(tracked.connections).toHaveLength(2);
	});
});

// 8 Oct 2026: `append` read and rewrote the whole file for every line; filling the 2 MiB log wrote
// 6 226 MiB. Chunked, a line costs a bounded write however long the log already is.
describe('appending to a long file', () => {
	function countingBackend(): { backend: LocalFileBackend; written: () => number } {
		const inner = createMemoryFileBackend();
		let written = 0;
		return {
			written: () => written,
			backend: { ...inner, set: async (key, value) => { written += value.length; await inner.set(key, value); } },
		};
	}
	const line = (n: number): string => `{"seq":${String(n)},"padding":"${'x'.repeat(300)}"}\n`;

	it('fills a log file writing a small multiple of its size, and it reads back whole', async () => {
		const { backend, written } = countingBackend();
		const storage = createLocalFileStorage(backend, 'lib-1');
		let expected = '';
		for (let n = 0; expected.length < 512 * 1024; n += 1) {
			await storage.append('.hebra/logs/a.jsonl', line(n));
			expected += line(n);
		}
		// Whole-file rewrites cost ~400 MB here (~800x the file); one 4 KiB chunk per line costs ~6x.
		expect(written()).toBeLessThan(expected.length * 10);
		expect(await storage.read('.hebra/logs/a.jsonl')).toBe(expected);
	});

	it('keeps appending after a file an older build saved whole, and rename, write and remove see all of it', async () => {
		const backend = createMemoryFileBackend();
		await backend.set('lib-1/.hebra/logs/a.jsonl', 'old one\nold two\n');
		const storage = createLocalFileStorage(backend, 'lib-1');
		for (let n = 0; n < 100; n += 1) await storage.append('.hebra/logs/a.jsonl', line(n));
		const text = await storage.read('.hebra/logs/a.jsonl');
		expect(text.startsWith('old one\nold two\n{"seq":0,')).toBe(true);

		await storage.rename('.hebra/logs/a.jsonl', '.hebra/logs/b.jsonl');
		expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(false);
		expect(await storage.read('.hebra/logs/b.jsonl')).toBe(text);
		await storage.append('.hebra/logs/b.jsonl', 'tail\n');
		expect(await storage.read('.hebra/logs/b.jsonl')).toBe(`${text}tail\n`);

		await storage.write('.hebra/logs/b.jsonl', 'fresh\n');
		expect(await storage.read('.hebra/logs/b.jsonl')).toBe('fresh\n');
		await storage.append('.hebra/logs/b.jsonl', 'more\n');
		await storage.remove('.hebra/logs/b.jsonl');
		expect(await storage.exists('.hebra/logs/b.jsonl')).toBe(false);
		expect(await backend.keys()).toEqual([]);
	});

	it('a file that only has chunks exists, and so does the directory that holds it', async () => {
		const storage = createLocalFileStorage(createMemoryFileBackend(), 'lib-1');
		await storage.append('.hebra/logs/a.jsonl', 'one\n');
		expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(true);
		expect(await storage.exists('.hebra/logs')).toBe(true);
	});
});

// 9 Oct 2026: `append`, `exists` and `remove` asked the backend for EVERY key of the database to
// find the few of one file. With a prefix the backend answers with a key range.
describe('listing the keys of one file', () => {
	/** Counts the keys each call hands back, which is what crosses the IndexedDB boundary. */
	function countingKeys(inner: LocalFileBackend): { backend: LocalFileBackend; returned: () => number } {
		let returned = 0;
		return {
			returned: () => returned,
			backend: {
				...inner,
				keys: async (prefix) => {
					const keys = await inner.keys(prefix);
					returned += keys.length;
					return keys;
				},
			},
		};
	}
	const seedOthers = async (backend: LocalFileBackend, count: number): Promise<void> => {
		for (let n = 0; n < count; n += 1) await backend.set(`other-lib/notes/${String(n)}.json`, '{}');
	};

	for (const [name, makeBackend] of [
		['memory', () => createMemoryFileBackend()],
		['IndexedDB', () => createIndexedDbFileBackend(new IDBFactory(), 'keys-by-prefix')],
	] as const) {
		it(`append, exists and remove only read their own keys over ${name} with 5 000 unrelated ones`, async () => {
			const inner = makeBackend();
			await seedOthers(inner, 5000);
			const { backend, returned } = countingKeys(inner);
			const storage = createLocalFileStorage(backend, 'lib-1');
			for (let n = 0; n < 100; n += 1) await storage.append('.hebra/logs/a.jsonl', `line ${String(n)}\n`);
			expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(true);
			expect(await storage.exists('.hebra/logs')).toBe(true);
			expect(await storage.exists('.hebra/missing')).toBe(false);
			await storage.remove('.hebra/logs/a.jsonl');
			// Before: 5 000+ keys per call (~500 000 here). After: only the few chunks of the file.
			expect(returned()).toBeLessThan(500);
			expect((await inner.keys()).length).toBe(5000); // only the unrelated keys stay.
		});
	}
});

// 7 Oct 2026: these files are the diagnostic log. A write that never settled stopped its queue for
// good, and a dead connection was kept for the rest of the plugin's life.
describe('file backend over a dying IndexedDB', () => {
	it('an abort that brings no error event rejects every call instead of leaving it pending', async () => {
		const backend = createIndexedDbFileBackend(abortingIndexedDb(), 'hebra-tyrian-local-files');
		expect(await settlement(backend.set('lib-1/a', 'one'))).toBe('rejected');
		expect(await settlement(backend.get('lib-1/a'))).toBe('rejected');
		expect(await settlement(backend.delete('lib-1/a'))).toBe('rejected');
		expect(await settlement(backend.keys())).toBe('rejected');
	});

	it('opens a new connection after the cached one was closed underneath it or by the engine', async () => {
		const tracked = trackedIndexedDb();
		const backend = createIndexedDbFileBackend(tracked.factory, 'hebra-tyrian-local-files');
		await backend.set('lib-1/a', 'one');
		closeUnderneath(tracked.connections[0]!);
		expect(await backend.get('lib-1/a')).toBe('one');
		expect(tracked.connections).toHaveLength(2);

		emitEngineClose(tracked.connections[1]!);
		await backend.set('lib-1/a', 'two');
		expect(await backend.get('lib-1/a')).toBe('two');
		expect(tracked.connections).toHaveLength(3);
	});

	it('one reopen per call while storage is down, and it works again once storage is back', async () => {
		const tracked = trackedIndexedDb();
		const backend = createIndexedDbFileBackend(tracked.factory, 'hebra-tyrian-local-files');
		await backend.set('lib-1/a', 'one');
		killStorage(tracked);
		const open = vi.spyOn(tracked.factory, 'open');
		expect(await settlement(backend.get('lib-1/a'))).toBe('rejected');
		expect(open).toHaveBeenCalledTimes(1);

		reviveStorage(tracked);
		expect(await backend.get('lib-1/a')).toBe('one');
	});
});
