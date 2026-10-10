import { describe, expect, it, vi } from 'vitest';

import type { TyrianVaultChange } from '../tyrian-host';
import { createLocalFileStorage, createMemoryFileBackend } from './local-storage';
import { TyrianPathIndex } from './path-index';
import { createMemoryPathIndexKv } from './path-index-kv';
import { createHebraTyrianVault, HEBRA_TYRIAN_CONFIG_DIR, relativeToOutputFolder } from './vault';
import type { TyrianVaultPort } from './vault-port';

// Ported from Hebra's `src/lib/modules/tyrian/vault.test.ts`: the translation between the core's
// vault paths (`Tyrian Companion/…`) and the R3 port's relative ones, against a recording double.

function fakePort() {
	let emit: (change: TyrianVaultChange) => void = () => undefined;
	const port = {
		markdownFiles: () => [{ path: 'Inventory/Positions/1.md', mtime: 5 }],
		file: (path: string) => (path === 'Inventory/Positions/1.md' ? { path, mtime: 5 } : null),
		exists: (path: string) => path === 'Inventory' || path === 'Inventory/Positions/1.md',
		read: vi.fn(async () => 'body'),
		process: vi.fn(async (_file: unknown, update: (current: string) => string) => update('before')),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string) => ({ path, mtime: 7 })),
		trashFile: vi.fn(async () => undefined),
		trashIfUnchanged: vi.fn(async () => ({ status: 'trashed' as const, guarantee: 'checked' as const })),
		saveNote: vi.fn(async () => undefined),
		onChange: vi.fn((_root: string, listener: (change: TyrianVaultChange) => void) => {
			emit = listener;
			return () => undefined;
		}),
	} satisfies TyrianVaultPort;
	return { port, emit: (change: TyrianVaultChange) => emit(change) };
}

async function vaultWith(port: TyrianVaultPort | null, outputFolder = 'Tyrian Companion', writeBlockedReason?: () => string | null) {
	const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
	return createHebraTyrianVault({
		port,
		index,
		outputFolder,
		libraryId: 'lib-1',
		adapter: createLocalFileStorage(createMemoryFileBackend(), 'lib-1'),
		...(writeBlockedReason === undefined ? {} : { writeBlockedReason }),
	});
}

describe('createHebraTyrianVault', () => {
	it('adds the output folder prefix to what it reads and removes it from what it asks', async () => {
		const { port } = fakePort();
		const vault = await vaultWith(port);
		expect(vault.markdownFiles()).toEqual([{ path: 'Tyrian Companion/Inventory/Positions/1.md', mtime: 5 }]);
		expect(vault.file('Tyrian Companion/Inventory/Positions/1.md')).toEqual({ path: 'Tyrian Companion/Inventory/Positions/1.md', mtime: 5 });
		expect(vault.exists('Tyrian Companion/Inventory')).toBe(true);
		expect(vault.exists('Tyrian Companion')).toBe(true);
		expect(vault.file('Tyrian Companion')).toEqual({ path: 'Tyrian Companion' });
		expect(await vault.read({ path: 'Tyrian Companion/Inventory/Positions/1.md' })).toBe('body');
		expect(port.read).toHaveBeenCalledWith({ path: 'Inventory/Positions/1.md' });
		expect(await vault.process({ path: 'Tyrian Companion/Inventory/Positions/1.md' }, (text) => `${text}+`)).toBe('before+');
		expect(await vault.create('Tyrian Companion/Wallet/Currencies/2.md', '#')).toEqual({ path: 'Tyrian Companion/Wallet/Currencies/2.md', mtime: 7 });
		expect(port.create).toHaveBeenCalledWith('Wallet/Currencies/2.md', '#');
		await vault.createFolder('Tyrian Companion/Wallet');
		expect(port.createFolder).toHaveBeenCalledWith('Wallet');
		await vault.createFolder('Tyrian Companion');
		expect(port.createFolder).toHaveBeenCalledTimes(1);
	});

	it('outside the output folder there is nothing and writing refuses with the reason', async () => {
		const { port } = fakePort();
		const vault = await vaultWith(port);
		expect(vault.file('Other/thing.md')).toBeNull();
		expect(vault.exists('Tyrian Companion 2/x.md')).toBe(false);
		await expect(vault.create('Other/thing.md', '')).rejects.toThrow('outside the output folder');
		await expect(vault.createFolder('Other')).rejects.toThrow('outside the output folder');
		expect(port.create).not.toHaveBeenCalled();
	});

	it('with a nested output folder its parents exist, and ensuring them segment by segment writes nothing', async () => {
		// What the core's inventory writer does: from the vault ROOT, `file(segment)` and, when null,
		// `createFolder(segment)`, which must not throw.
		const { port } = fakePort();
		const vault = await vaultWith(port, 'Games/GW2/Tyrian');
		const ensureFolders = async (path: string): Promise<void> => {
			const segments = path.split('/');
			for (let index = 1; index <= segments.length; index += 1) {
				const folder = segments.slice(0, index).join('/');
				if (vault.file(folder)) continue;
				await vault.createFolder(folder);
			}
		};
		expect(vault.file('Games')).toEqual({ path: 'Games' });
		expect(vault.file('Games/GW2/')).toEqual({ path: 'Games/GW2' });
		await vault.createFolder('Games');
		await ensureFolders('Games/GW2/Tyrian/Inventory/Positions');
		expect(port.createFolder.mock.calls).toEqual([['Inventory'], ['Inventory/Positions']]);
		expect(vault.file('Gam')).toBeNull();
		expect(vault.file('Games/GW')).toBeNull();
		expect((await vaultWith(null, 'Games/GW2/Tyrian')).file('Games')).toBeNull();
	});

	it('onChange translates the watched root and each change\'s paths; a foreign root delivers nothing', async () => {
		const { port, emit } = fakePort();
		const vault = await vaultWith(port);
		const listener = vi.fn();
		vault.onChange('Tyrian Companion/sessions', listener);
		expect(port.onChange).toHaveBeenCalledWith('sessions', expect.any(Function));
		emit({ kind: 'modify', path: 'sessions/2026/a.md' });
		expect(listener).toHaveBeenCalledWith({ kind: 'modify', path: 'Tyrian Companion/sessions/2026/a.md' });
		expect(vault.onChange('Outside', vi.fn())).toBeTypeOf('function');
		expect(port.onChange).toHaveBeenCalledTimes(1);
	});

	it("onChange('') and a root that contains the output folder both watch the whole output folder", async () => {
		const { port, emit } = fakePort();
		const vault = await vaultWith(port, 'Games/GW2/Tyrian');
		const listener = vi.fn();
		vault.onChange('', listener);
		vault.onChange('Games', listener);
		vault.onChange('Games/GW2', listener);
		expect(port.onChange.mock.calls.map(([root]) => root)).toEqual(['', '', '']);
		emit({ kind: 'create', path: 'Inventory/1.md' });
		expect(listener).toHaveBeenCalledWith({ kind: 'create', path: 'Games/GW2/Tyrian/Inventory/1.md' });
		expect(vault.onChange('Games/GW', vi.fn())).toBeTypeOf('function');
		expect(port.onChange).toHaveBeenCalledTimes(3);
	});

	it('without an output folder the vault is empty and writing refuses', async () => {
		const vault = await vaultWith(null);
		expect(vault.markdownFiles()).toEqual([]);
		expect(vault.listFiles()).toEqual([]);
		expect(vault.exists('Tyrian Companion')).toBe(false);
		await expect(vault.createFolder('Tyrian Companion')).rejects.toThrow('is not in the library');
		await expect(vault.create('Tyrian Companion/a.md', '')).rejects.toThrow('is not in the library');
	});

	it('saveNote removes the prefix and refuses outside the output folder', async () => {
		const { port } = fakePort();
		const vault = await vaultWith(port);
		await vault.saveNote?.('Tyrian Companion/diagnostics/x.md', '# x');
		expect(port.saveNote).toHaveBeenCalledWith('diagnostics/x.md', '# x');
		await expect(vault.saveNote?.('Other/x.md', '# x')).rejects.toThrow('outside the output folder');
	});

	it('trashIfUnchanged removes the prefix, delegates, and refuses outside or while writes are blocked', async () => {
		const { port } = fakePort();
		const vault = await vaultWith(port);
		expect(await vault.trashIfUnchanged({ path: 'Tyrian Companion/Inventory/Positions/1.md', mtime: 5 }, 'text\n'))
			.toEqual({ status: 'trashed', guarantee: 'checked' });
		expect(port.trashIfUnchanged).toHaveBeenCalledWith({ path: 'Inventory/Positions/1.md', mtime: 5 }, 'text\n');
		await expect(vault.trashIfUnchanged({ path: 'Other/1.md' }, 'x')).rejects.toThrow(/outside the output folder/u);
		const blocked = fakePort();
		const blockedVault = await vaultWith(blocked.port, 'Tyrian Companion', () => 'restart pending');
		await expect(blockedVault.trashIfUnchanged({ path: 'Tyrian Companion/Inventory/Positions/1.md' }, 'x')).rejects.toThrow(/refused: restart pending/u);
		expect(blocked.port.trashIfUnchanged).not.toHaveBeenCalled();
	});

	it('identity and system paths: the same on every device, no disk of its own', async () => {
		const vault = await vaultWith(null);
		expect(vault.canonicalIdentity()).toBe('hebra-library:lib-1');
		expect(vault.configDir).toBe(HEBRA_TYRIAN_CONFIG_DIR);
		expect(vault.basePath()).toBeNull();
		expect(vault.fullPath('x')).toBeNull();
	});
});

describe('relativeToOutputFolder', () => {
	it('tells the folder, what is inside and what is outside apart (without confusing prefixes)', () => {
		expect(relativeToOutputFolder('GW2', 'GW2')).toBe('');
		expect(relativeToOutputFolder('GW2', 'GW2/a.md')).toBe('a.md');
		expect(relativeToOutputFolder('GW2', 'GW22/a.md')).toBeNull();
		expect(relativeToOutputFolder('/GW2/', '/GW2/a.md')).toBe('a.md');
	});
});

describe('createHebraTyrianVault linkTarget', () => {
	async function vaultWithIndex() {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		const vault = createHebraTyrianVault({ port: fakePort().port, index, outputFolder: 'Tyrian Companion', libraryId: 'lib-1',
			adapter: createLocalFileStorage(createMemoryFileBackend(), 'lib-1') });
		return { index, vault };
	}

	it('names an indexed note by its id, because Hebra resolves a wikilink by title or id, not by file name', async () => {
		const { index, vault } = await vaultWithIndex();
		await index.setNote('sessions/2026/2026-10-09 064207Z - 5cf90cda42c067ed.md', 'f27d387d-7245-430a-bb8d-ffda023154c4', 1);
		expect(vault.linkTarget?.('Tyrian Companion/sessions/2026/2026-10-09 064207Z - 5cf90cda42c067ed.md')).toBe('id:f27d387d-7245-430a-bb8d-ffda023154c4');
	});

	it('answers null for a path it cannot name: unindexed, a file that is not a note, a folder, or outside the output folder', async () => {
		const { index, vault } = await vaultWithIndex();
		await index.setFile('Inventory/export.json', 'file-1', 1);
		expect(vault.linkTarget?.('Tyrian Companion/sessions/unknown.md')).toBeNull();
		expect(vault.linkTarget?.('Tyrian Companion/Inventory/export.json')).toBeNull();
		expect(vault.linkTarget?.('Tyrian Companion')).toBeNull();
		expect(vault.linkTarget?.('Elsewhere/a.md')).toBeNull();
	});
});

// David, 10 Oct 2026 («si no existe, se crea»): without an output folder the vault creates it only when asked.
describe('createHebraTyrianVault createOutputFolder', () => {
	async function missingFolderVault(create: () => Promise<{ port: TyrianVaultPort; index: TyrianPathIndex }>, blocked?: () => string | null) {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1/-');
		const failures: unknown[] = [];
		const vault = createHebraTyrianVault({
			port: null, index, outputFolder: 'Tyrian Companion', libraryId: 'lib-1',
			adapter: createLocalFileStorage(createMemoryFileBackend(), 'lib-1'),
			createOutputFolder: create,
			onCreateOutputFolderFailure: (error) => { failures.push(error); },
			...(blocked === undefined ? {} : { writeBlockedReason: blocked }),
		});
		return { vault, failures };
	}

	it('creates it once for concurrent calls, then writes there and hands it the subscriptions made before', async () => {
		const { port, emit } = fakePort();
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1/folder-1');
		const create = vi.fn(async () => ({ port, index }));
		const { vault, failures } = await missingFolderVault(create);
		const seen: string[] = [];
		vault.onChange('Tyrian Companion', (change) => { seen.push(change.path); });
		await expect(vault.createFolder('Tyrian Companion')).rejects.toMatchObject({ code: 'output_folder_missing' });
		expect(await Promise.all([vault.createOutputFolder?.(), vault.createOutputFolder?.()])).toEqual([true, true]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(failures).toEqual([]);
		await vault.createFolder('Tyrian Companion/Bases');
		expect(port.createFolder).toHaveBeenCalledWith('Bases');
		emit({ kind: 'modify', path: 'Bases/Inventory.base' });
		expect(seen).toEqual(['Tyrian Companion/Bases/Inventory.base']);
		await vault.createOutputFolder?.();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('never rejects: a failure goes to the diagnostics, the writes keep refusing and a later call retries', async () => {
		const { port } = fakePort();
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1/folder-1');
		const create = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('folder_name_taken'), { code: 'folder_name_taken' }))
			.mockResolvedValueOnce({ port, index });
		const { vault, failures } = await missingFolderVault(create);
		await expect(vault.createOutputFolder?.()).resolves.toBe(false);
		expect(failures).toHaveLength(1);
		await expect(vault.create('Tyrian Companion/a.md', '#')).rejects.toMatchObject({ code: 'output_folder_missing' });
		await expect(vault.createOutputFolder?.()).resolves.toBe(true);
		expect(create).toHaveBeenCalledTimes(2);
		await vault.create('Tyrian Companion/a.md', '#');
		expect(port.create).toHaveBeenCalledWith('a.md', '#');
	});

	it('creates nothing while the vault is blocked for a restart: the write says why', async () => {
		const create = vi.fn();
		const { vault } = await missingFolderVault(create, () => 'the plugin restarts');
		await expect(vault.createOutputFolder?.()).resolves.toBe(true);
		expect(create).not.toHaveBeenCalled();
		await expect(vault.createFolder('Tyrian Companion')).rejects.toMatchObject({ code: 'host_refused' });
	});

	it('still resolves, and lets a later call through, when a waiting subscription fails to attach', async () => {
		const { port } = fakePort();
		port.onChange.mockImplementationOnce(() => { throw new Error('attach failed'); });
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1/folder-1');
		const create = vi.fn(async () => ({ port, index }));
		const { vault, failures } = await missingFolderVault(create);
		vault.onChange('Tyrian Companion', () => undefined);
		await expect(vault.createOutputFolder?.()).resolves.toBe(true);
		expect(failures).toEqual([expect.objectContaining({ message: 'attach failed' })]);
		// The folder and its port exist: the writes go there and nothing is created again.
		await vault.create('Tyrian Companion/a.md', '#');
		expect(port.create).toHaveBeenCalledWith('a.md', '#');
		await expect(vault.createOutputFolder?.()).resolves.toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
	});
});
