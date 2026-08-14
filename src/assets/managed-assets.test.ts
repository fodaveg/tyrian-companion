import { describe, expect, it } from 'vitest';

import { genericManagedAssets } from './generic-assets';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { MANAGED_ASSETS_MANIFEST, normalizeManagedAssetPath, planManagedAssets } from './managed-assets-model';

const CONFIG_DIR = 'vault-config';

describe('managed asset paths and planning', () => {
	it.each(['A/../B.base', 'A//B.base', '/A.base', 'A\\B.base', 'vault-config/A.base', 'VAULT-CONFIG/A.base', 'A/B?.base', 'A/B. ', `A/\0.base`, 'A/e\u0301.base'])('rejects unsafe or non-NFC path %s', (path) => {
		expect(normalizeManagedAssetPath(path, CONFIG_DIR)).toBeNull();
	});

	it('allows only managed extensions and blocks unowned occupations in a pure preview', () => {
		expect(normalizeManagedAssetPath('Tyrian Companion/Bases/Sessions.base', CONFIG_DIR)).toBeTruthy();
		expect(normalizeManagedAssetPath(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`, CONFIG_DIR)).toBeTruthy();
		expect(normalizeManagedAssetPath('Tyrian Companion/Bases/Sessions.css', CONFIG_DIR)).toBeNull();
		const inspection = {
			root: 'Tyrian Companion', manifestPath: `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`,
			manifest: null, manifestStatus: 'missing' as const, bundleVersion: 1, locale: 'es' as const,
			assets: [{ asset: fixtureAsset(), path: 'Tyrian Companion/Bases/Sessions.base', status: 'occupied_unowned' as const, currentHash: 'a'.repeat(64), installedHash: null }],
		};
		expect(planManagedAssets(inspection, 'install')).toMatchObject({ canApply: false, reasons: ['occupied_unowned'] });
	});
});

describe('ManagedAssetsManager', () => {
	it('installs explicitly, is byte-idempotent, and upgrades only intact owned bytes', async () => {
		const vault = new MemoryAssetVault();
		const first = await manager(vault, 1);
		expect((await first.preview('Tyrian Companion')).steps[0]?.status).toBe('create');
		expect((await first.apply('Tyrian Companion')).status).toBe('applied');
		const writes = vault.writeCount;
		expect((await first.apply('Tyrian Companion')).status).toBe('unchanged');
		expect(vault.writeCount).toBe(writes);

		const second = await manager(vault, 2);
		expect((await second.preview('Tyrian Companion', 'upgrade')).steps[0]?.status).toBe('update');
		expect((await second.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		expect(vault.contents.get('Tyrian Companion/Bases/Sessions.base')).toContain('version=2');
	});

	it('preserves human-modified and marker-only foreign files', async () => {
		const vault = new MemoryAssetVault();
		const assets = await genericManagedAssets();
		vault.contents.set('Tyrian Companion/Bases/Sessions.base', `${assets[0]!.bytes}\nhuman edit`);
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 1, locale: 'es', assets });
		expect(await instance.preview('Tyrian Companion')).toMatchObject({ canApply: false, reasons: ['occupied_unowned'] });
		expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
		expect(vault.contents.get('Tyrian Companion/Bases/Sessions.base')).toContain('human edit');
	});

	it('detects modification after install and never overwrites it', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const path = 'Tyrian Companion/Bases/Sessions.base';
		vault.contents.set(path, `${vault.contents.get(path)!}\nhuman edit`);
		expect((await instance.inspect('Tyrian Companion')).assets[0]?.status).toBe('modified');
		expect((await instance.apply('Tyrian Companion', 'repair')).status).toBe('conflict');
		expect(vault.contents.get(path)).toContain('human edit');
	});

	it('keeps future and malformed manifests read-only', async () => {
		for (const manifest of [{ schemaVersion: 2 }, { schemaVersion: 1, pluginId: 'foreign' }]) {
			const vault = new MemoryAssetVault();
			vault.contents.set(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`, JSON.stringify(manifest));
			const instance = await manager(vault, 1);
			const before = vault.contents.get(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`);
			expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
			expect(vault.contents.get(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`)).toBe(before);
		}
	});

	it('repairs a crash from the durable applying journal and rejects a different operation', async () => {
		const vault = new MemoryAssetVault();
		vault.failAfterWrites = 1; // manifest written, asset write fails
		const first = await manager(vault, 1);
		expect((await first.apply('Tyrian Companion')).status).toMatch(/conflict|unavailable/u);
		expect(vault.contents.get(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`)).toContain('"state": "applying"');
		vault.failAfterWrites = null;
		const second = await manager(vault, 1);
		expect((await second.apply('Tyrian Companion', 'upgrade')).status).toBe('busy');
		expect((await second.apply('Tyrian Companion')).status).toBe('applied');
		expect((await second.inspect('Tyrian Companion')).manifestStatus).toBe('ready');
	});

	it('uses a tombstone CAS before trash and leaves a detached manifest', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		expect((await instance.uninstall('Tyrian Companion')).status).toBe('detached');
		expect(vault.contents.has('Tyrian Companion/Bases/Sessions.base')).toBe(false);
		expect(vault.trashed).toEqual(['Tyrian Companion/Bases/Sessions.base']);
		expect(vault.contents.get(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`)).toContain('"state": "detached"');
	});

	it('converges concurrent instances through manifest CAS', async () => {
		const vault = new MemoryAssetVault();
		const [a, b] = await Promise.all([manager(vault, 1), manager(vault, 1)]);
		const results = await Promise.all([a.apply('Tyrian Companion'), b.apply('Tyrian Companion')]);
		expect(results.map((result) => result.status).sort()).toEqual(['applied', 'unchanged']);
		expect((await a.inspect('Tyrian Companion')).assets[0]?.status).toBe('unchanged');
	});

	it('coalesces only the exact flight and reports a different root busy', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		const a = instance.apply('Root A');
		const same = instance.apply('Root A');
		const other = instance.apply('Root B');
		expect(same).toBe(a);
		expect(await other).toMatchObject({ status: 'busy' });
		expect((await a).status).toBe('applied');
		expect(vault.contents.has('Root B/Bases/Sessions.base')).toBe(false);
	});

	it('rejects a journal whose step escapes the canonical root or whose operation id was forged', async () => {
		for (const mutate of [
			(manifest: MutableJournal) => { manifest.pendingOperation.steps[0]!.path = 'Other/Bases/Sessions.base'; },
			(manifest: MutableJournal) => { manifest.pendingOperation.operationId = 'f'.repeat(64); },
		]) {
			const vault = new MemoryAssetVault();
			vault.failAfterWrites = 1;
			const instance = await manager(vault, 1);
			await instance.apply('Tyrian Companion');
			const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
			const parsed = JSON.parse(vault.contents.get(path)!) as MutableJournal;
			mutate(parsed);
			vault.contents.set(path, `${JSON.stringify(parsed, null, 2)}\n`);
			vault.failAfterWrites = null;
			expect((await instance.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
			expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
		}
	});

	it('resumes uninstall after trash succeeded but journal marking crashed', async () => {
		const vault = new MemoryAssetVault();
		const first = await manager(vault, 1);
		await first.apply('Tyrian Companion');
		vault.failAfterTrash = true;
		expect((await first.uninstall('Tyrian Companion')).status).toBe('unavailable');
		expect(vault.contents.has('Tyrian Companion/Bases/Sessions.base')).toBe(false);
		vault.failAfterTrash = false;
		const resumed = await manager(vault, 1);
		expect((await resumed.uninstall('Tyrian Companion')).status).toBe('detached');
	});

	it('resumes uninstall from an exact tombstone left before trash', async () => {
		const vault = new MemoryAssetVault();
		const first = await manager(vault, 1);
		await first.apply('Tyrian Companion');
		vault.failBeforeTrash = true;
		expect((await first.uninstall('Tyrian Companion')).status).toBe('unavailable');
		expect(vault.contents.get('Tyrian Companion/Bases/Sessions.base')).toContain('tombstone operation=');
		vault.failBeforeTrash = false;
		expect((await (await manager(vault, 1)).uninstall('Tyrian Companion')).status).toBe('detached');
	});

	it('uninstalls intact prior-version ownership using the manifest rather than the current bundle', async () => {
		const vault = new MemoryAssetVault();
		await (await manager(vault, 1)).apply('Tyrian Companion');
		const newer = await manager(vault, 2);
		expect((await newer.inspect('Tyrian Companion')).assets[0]?.status).toBe('update');
		expect((await newer.uninstall('Tyrian Companion')).status).toBe('detached');
		expect(vault.contents.has('Tyrian Companion/Bases/Sessions.base')).toBe(false);
	});
});

async function manager(vault: MemoryAssetVault, version: number): Promise<ManagedAssetsManager> {
	const [asset] = await genericManagedAssets();
	if (!asset) throw new Error('missing fixture');
	const bytes = asset.bytes.replace('version=1', `version=${version}`);
	const contentHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
	const hash = [...new Uint8Array(contentHash)].map((part) => part.toString(16).padStart(2, '0')).join('');
	return new ManagedAssetsManager(vault, CONFIG_DIR, {
		bundleVersion: version, locale: 'es', assets: [{ ...asset, contentVersion: version, bytes, contentHash: hash }],
	});
}

function fixtureAsset() {
	return { id: 'sessions-base', kind: 'base' as const, contentVersion: 1, locale: 'neutral' as const,
		relativePath: 'Sessions.base', bytes: '# marker\n', contentHash: 'b'.repeat(64) };
}

class MemoryAssetVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	writeCount = 0;
	failAfterWrites: number | null = null;
	failAfterTrash = false;
	failBeforeTrash = false;
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	async read(file: ManagedAssetFile): Promise<string> {
		const value = this.contents.get(file.path); if (value === undefined) throw new Error('not_file'); return value;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		this.fail();
		if (this.file(path)) throw new Error('exists');
		this.writeCount += 1; this.contents.set(path, content); return { path };
	}
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		this.fail();
		const current = this.contents.get(file.path); if (current === undefined) throw new Error('not_file');
		const next = update(current); if (next !== current) { this.writeCount += 1; this.contents.set(file.path, next); } return next;
	}
	async trashFile(file: ManagedAssetFile): Promise<void> {
		if (this.failBeforeTrash) throw new Error('injected_before_trash');
		this.contents.delete(file.path); this.trashed.push(file.path);
		if (this.failAfterTrash) throw new Error('injected_after_trash');
	}
	private fail(): void { if (this.failAfterWrites !== null && this.writeCount >= this.failAfterWrites) throw new Error('injected'); }
}

interface MutableJournal {
	pendingOperation: { operationId: string; steps: Array<{ path: string }> };
	[key: string]: unknown;
}
