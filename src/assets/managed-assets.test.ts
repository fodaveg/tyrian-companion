import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { genericManagedAssets, managedAssetsBundle, sha256Text } from './generic-assets';
import { halloweenManagedAssets } from './halloween-base';
import { baseSemanticHash, ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { ManagedAssetsLifecycle } from './managed-assets-lifecycle';
import {
	decideManagedAssetsAutoUpdate,
	MANAGED_ASSETS_MANIFEST,
	managedAssetMarker,
	normalizeManagedAssetPath,
	planManagedAssets,
	type PackagedAsset,
} from './managed-assets-model';
import { MemoryManagedAssetsPointerStore } from './managed-assets-pointer';

const CONFIG_DIR = 'vault-config';

describe('managed asset paths and planning', () => {
	it.each(['A/../B.base', 'A//B.base', '/A.base', 'A\\B.base', 'vault-config/A.base', 'VAULT-CONFIG/A.base', 'A/B?.base', 'A/B. ', `A/\0.base`, 'A/\u0001.base', 'A/CON.base', 'A/LPT1.md', `A/${'b'.repeat(121)}.base`])('rejects unsafe path %s', (path) => {
		expect(normalizeManagedAssetPath(path, CONFIG_DIR)).toBeNull();
	});

	it('accepts an NFD-decomposed asset path and normalizes it to NFC', () => {
		expect(normalizeManagedAssetPath('A/e\u0301.base', CONFIG_DIR)).toBe('A/\u00e9.base');
	});

	it('allows only managed extensions and lists unowned occupations without blocking the rest in a pure preview', () => {
		expect(normalizeManagedAssetPath('Tyrian Companion/Bases/Sessions.base', CONFIG_DIR)).toBeTruthy();
		expect(normalizeManagedAssetPath(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`, CONFIG_DIR)).toBeTruthy();
		expect(normalizeManagedAssetPath('Tyrian Companion/Bases/Sessions.css', CONFIG_DIR)).toBeNull();
		const inspection = {
			root: 'Tyrian Companion', manifestPath: `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`,
			manifest: null, manifestStatus: 'missing' as const, bundleVersion: 1, locale: 'es' as const,
			assets: [{ asset: fixtureAsset(), path: 'Tyrian Companion/Bases/Sessions.base', status: 'occupied_unowned' as const,
				currentHash: 'a'.repeat(64), currentSemanticHash: null, installedHash: null }],
		};
		expect(planManagedAssets(inspection, 'install')).toMatchObject({
			canApply: true, reasons: [], steps: [{ path: 'Tyrian Companion/Bases/Sessions.base', status: 'occupied_unowned' }],
		});
	});

	it('keeps Sessions.base scoped to the durable session schema and kind', async () => {
		const [asset] = await genericManagedAssets();
		expect(asset?.bytes).toContain('tc_schema >= 1');
		expect(asset?.bytes).toContain('tc_kind == "gw2_farming_session"');
	});
});

describe('manifest compare-and-swap under a host that re-runs the update (R1a)', () => {
	it('reports the swap as not applied when the run the host wrote found another manifest', async () => {
		const vault = new MemoryAssetVault();
		const assets = await manager(vault, 1);
		await assets.apply('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const before = JSON.parse(vault.contents.get(path)!) as { generation: number };
		const after = { ...before, generation: before.generation + 1 };
		const concurrent = { ...before, generation: before.generation + 2 };
		vault.staleOnce = () => { vault.contents.set(path, `${JSON.stringify(concurrent, null, 2)}\n`); };
		const casManifest = (assets as unknown as {
			casManifest(before: unknown, after: unknown): Promise<unknown>;
		}).casManifest.bind(assets);

		// A latched `applied` from the discarded first run handed back the concurrent manifest as if
		// this swap had landed; the caller must see that it did not.
		await expect(casManifest(before, after)).resolves.toBeNull();
		expect(JSON.parse(vault.contents.get(path)!)).toMatchObject({ generation: before.generation + 2 });
	});
});

describe('automatic Base update behind the inventory sync (H18.18)', () => {
	const ROOT = 'Tyrian Companion';
	const PATH = 'Tyrian Companion/Bases/Sessions.base';

	it('applies a newer bundle on its own only when nothing the user touched is in the way', async () => {
		const vault = new MemoryAssetVault();
		// Never installs by itself: without a manifest there is nothing to follow.
		expect(decideManagedAssetsAutoUpdate(await (await manager(vault, 1)).inspect(ROOT))).toEqual({ action: 'none' });
		await (await manager(vault, 1)).apply(ROOT);
		expect(decideManagedAssetsAutoUpdate(await (await manager(vault, 1)).inspect(ROOT))).toEqual({ action: 'none' });

		const newer = await manager(vault, 2);
		expect(decideManagedAssetsAutoUpdate(await newer.inspect(ROOT))).toEqual({ action: 'apply' });
		expect((await newer.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(decideManagedAssetsAutoUpdate(await newer.inspect(ROOT))).toEqual({ action: 'none' });
	});

	it('holds an update back for the manual preview when the user edited or deleted a Base', async () => {
		const edited = new MemoryAssetVault();
		await (await manager(edited, 1)).apply(ROOT);
		edited.contents.set(PATH, `${edited.contents.get(PATH)!}\nhuman edit`);
		// Customised but already current: nothing pending, so no warning on every sync.
		expect(decideManagedAssetsAutoUpdate(await (await manager(edited, 1)).inspect(ROOT))).toEqual({ action: 'none' });
		// A newer bundle over that edit: the preview's own conflict rule holds it.
		expect(decideManagedAssetsAutoUpdate(await (await manager(edited, 2)).inspect(ROOT)))
			.toEqual({ action: 'manual', reasons: ['modified'] });

		const deleted = new MemoryAssetVault();
		await (await managerAtContentVersion(deleted, 1, 1)).apply(ROOT);
		deleted.contents.delete(PATH);
		const withNewBase = await managerWithAdditionalAsset(deleted);
		expect(decideManagedAssetsAutoUpdate(await withNewBase.inspect(ROOT)))
			.toEqual({ action: 'manual', reasons: ['missing'] });
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
		expect(await instance.preview('Tyrian Companion')).toMatchObject({
			canApply: true, reasons: [], steps: [{ status: 'occupied_unowned' }],
		});
		// Nothing of ours to create or adopt: the folder must not become "managed" over the user's file.
		expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
		expect(vault.contents.has(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`)).toBe(false);
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

	it('accepts an Obsidian-reserialized Base when its YAML value is unchanged', async () => {
		const vault = new MemoryAssetVault();
		const [asset] = (await halloweenManagedAssets()).filter((candidate) => candidate.locale === 'es');
		if (!asset) throw new Error('missing Halloween Base fixture');
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 2, locale: 'es', assets: [asset] });
		await instance.apply('Tyrian Companion');
		const path = 'Tyrian Companion/Bases/Halloween.base';
		const reserialized = stringifyYaml(parseYaml(vault.contents.get(path)!));
		expect(reserialized).not.toContain('tyrian-companion-managed');
		expect(reserialized).not.toBe(asset.bytes);
		vault.contents.set(path, reserialized);

		expect((await instance.inspect('Tyrian Companion')).assets[0]?.status).toBe('unchanged');
		expect((await instance.preview('Tyrian Companion')).canApply).toBe(true);
		expect((await instance.uninstall('Tyrian Companion')).status).toBe('detached');
		expect(vault.contents.has(path)).toBe(false);
	});

	it('keeps invalid YAML and semantic Base changes blocked after Obsidian serialization', async () => {
		const vault = new MemoryAssetVault();
		const [asset] = (await halloweenManagedAssets()).filter((candidate) => candidate.locale === 'es');
		if (!asset) throw new Error('missing Halloween Base fixture');
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 2, locale: 'es', assets: [asset] });
		await instance.apply('Tyrian Companion');
		const path = 'Tyrian Companion/Bases/Halloween.base';
		const changed = parseYaml(asset.bytes) as { filters: { and: string[] } };
		changed.filters.and = changed.filters.and.filter((filter) => filter !== 'tc_kind == "gw2_farming_session"');
		vault.contents.set(path, stringifyYaml(changed));
		expect((await instance.inspect('Tyrian Companion')).assets[0]?.status).toBe('modified');
		expect((await instance.apply('Tyrian Companion', 'repair')).status).toBe('conflict');

		vault.contents.set(path, 'filters: [unterminated\n');
		expect((await instance.inspect('Tyrian Companion')).assets[0]?.status).toBe('modified');
		expect((await instance.uninstall('Tyrian Companion')).status).toBe('conflict');
	});

	it('keeps templates on exact bytes plus their marker', async () => {
		const vault = new MemoryAssetVault();
		const draft = { id: 'note-template', kind: 'template', contentVersion: 1, locale: 'neutral', relativePath: 'Note.md' } as const;
		const bytes = `${managedAssetMarker(draft)}\n# Managed note\n`;
		const asset: PackagedAsset = { ...draft, bytes, contentHash: await sha256Text(bytes) };
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 1, locale: 'es', assets: [asset] });
		await instance.apply('Tyrian Companion');
		const path = 'Tyrian Companion/Templates/Note.md';
		vault.contents.set(path, '# Managed note\n');
		expect((await instance.inspect('Tyrian Companion')).assets[0]?.status).toBe('modified');
		expect((await instance.uninstall('Tyrian Companion')).status).toBe('conflict');
	});

	it('migrates an equivalent legacy v1 Base fingerprint before a future semantic upgrade', async () => {
		const vault = new MemoryAssetVault();
		const legacy = await manager(vault, 1);
		await legacy.apply('Tyrian Companion');
		const manifestPath = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const legacyManifest = JSON.parse(vault.contents.get(manifestPath)!) as MutableJournal;
		legacyManifest.schemaVersion = 1;
		for (const entry of legacyManifest.assets) delete entry.installedSemanticHash;
		vault.contents.set(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
		const assetPath = 'Tyrian Companion/Bases/Sessions.base';
		const reserialized = stringifyYaml(parseYaml(vault.contents.get(assetPath)!));
		vault.contents.set(assetPath, reserialized);

		expect((await legacy.inspect('Tyrian Companion')).assets[0]?.status).toBe('unchanged');
		expect((await legacy.apply('Tyrian Companion')).status).toBe('applied');
		expect(vault.contents.get(assetPath)).toBe(reserialized);
		const migrated = JSON.parse(vault.contents.get(manifestPath)!) as MutableJournal;
		expect(migrated.schemaVersion).toBe(2);
		expect(migrated.assets[0]?.installedSemanticHash).toMatch(/^[a-f0-9]{64}$/u);

		const future = await manager(vault, 2);
		expect((await future.preview('Tyrian Companion', 'upgrade')).steps[0]?.status).toBe('update');
		expect((await future.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
	});

	it('resumes a progressed v1 install journal after adding assets before a registered missing Base', async () => {
		const vault = new MemoryAssetVault();
		const retained = await baseAsset('a-retained', 'Retained.base', 'filters:\n  and: [retained]\n');
		const missing = await baseAsset('z-missing', 'Missing.base', 'filters:\n  and: [missing]\n');
		const old = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 1, locale: 'es', assets: [retained, missing] });
		expect((await old.apply('Tyrian Companion')).status).toBe('applied');
		const manifestPath = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const legacyManifest = JSON.parse(vault.contents.get(manifestPath)!) as MutableJournal;
		legacyManifest.schemaVersion = 1;
		for (const entry of legacyManifest.assets) delete entry.installedSemanticHash;
		vault.contents.set(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
		const retainedPath = 'Tyrian Companion/Bases/Retained.base';
		vault.contents.set(retainedPath, stringifyYaml(parseYaml(vault.contents.get(retainedPath)!)));
		vault.contents.delete('Tyrian Companion/Bases/Missing.base');

		const addedB = await baseAsset('b-added', 'Added B.base', 'filters:\n  and: [added-b]\n');
		const addedC = await baseAsset('c-added', 'Added C.base', 'filters:\n  and: [added-c]\n');
		const upgraded = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 2, locale: 'es', assets: [retained, addedB, addedC, missing],
		});
		expect((await upgraded.preview('Tyrian Companion')).steps).toEqual([
			{ id: 'a-retained', path: retainedPath, status: 'unchanged' },
			{ id: 'b-added', path: 'Tyrian Companion/Bases/Added B.base', status: 'create' },
			{ id: 'c-added', path: 'Tyrian Companion/Bases/Added C.base', status: 'create' },
			{ id: 'z-missing', path: 'Tyrian Companion/Bases/Missing.base', status: 'missing' },
		]);
		vault.writeCount = 0;
		vault.failAfterWrites = 5; // begin + create/mark-done for both added assets; fail before recreating missing
		expect((await upgraded.apply('Tyrian Companion')).status).toBe('conflict');
		expect(vault.contents.has('Tyrian Companion/Bases/Added B.base')).toBe(true);
		expect(vault.contents.has('Tyrian Companion/Bases/Added C.base')).toBe(true);
		const progressedLegacyJournal = JSON.parse(vault.contents.get(manifestPath)!) as MutableJournal;
		const initialSteps = progressedLegacyJournal.pendingOperation.steps.map((step) => ({
			...step, state: step.id === 'a-retained' ? 'done' as const : 'pending' as const,
		}));
		progressedLegacyJournal.pendingOperation.operationId = await legacyJournalOperationId(progressedLegacyJournal, initialSteps);
		vault.contents.set(manifestPath, `${JSON.stringify(progressedLegacyJournal, null, 2)}\n`);
		const interrupted = await upgraded.inspect('Tyrian Companion');
		expect(interrupted.manifestStatus).toBe('applying');
		expect(interrupted.manifest?.pendingOperation?.steps.map(({ id, state, beforeHash }) => ({ id, state, beforeHash }))).toEqual([
			{ id: 'a-retained', state: 'done', beforeHash: retained.contentHash },
			{ id: 'b-added', state: 'done', beforeHash: null },
			{ id: 'c-added', state: 'done', beforeHash: null },
			{ id: 'z-missing', state: 'pending', beforeHash: null },
		]);

		vault.failAfterWrites = null;
		const resumed = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 2, locale: 'es', assets: [retained, addedB, addedC, missing],
		});
		expect((await resumed.apply('Tyrian Companion')).status).toBe('applied');
		expect((await resumed.inspect('Tyrian Companion')).manifestStatus).toBe('ready');
		expect(JSON.parse(vault.contents.get(manifestPath)!)).toMatchObject({ schemaVersion: 2, bundleVersion: 2, state: 'ready' });
		expect(vault.contents.get(retainedPath)).not.toContain('tyrian-companion-managed');
		expect(vault.contents.get('Tyrian Companion/Bases/Missing.base')).toBe(missing.bytes);
	});

	it('keeps future and malformed manifests read-only', async () => {
		for (const manifest of [{ schemaVersion: 3 }, { schemaVersion: 1, pluginId: 'foreign' }]) {
			const vault = new MemoryAssetVault();
			vault.contents.set(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`, JSON.stringify(manifest));
			const instance = await manager(vault, 1);
			const before = vault.contents.get(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`);
			expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
			expect(vault.contents.get(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`)).toBe(before);
		}
	});

	it('rejects a schema v2 Base entry without its semantic ownership hash', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const manifest = JSON.parse(vault.contents.get(path)!) as MutableJournal;
		delete manifest.assets[0]!.installedSemanticHash;
		vault.contents.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
		expect((await instance.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
		expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
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

	it('rejects a ready manifest that transplants an asset id onto another path', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const parsed = JSON.parse(vault.contents.get(path)!) as MutableJournal;
		parsed.assets[0]!.path = 'Tyrian Companion/Bases/Other.base';
		vault.contents.set(path, `${JSON.stringify(parsed, null, 2)}\n`);
		expect((await instance.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
		expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
	});

	it('requires the exact current selected asset set for ready manifests', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const parsed = JSON.parse(vault.contents.get(path)!) as MutableJournal;
		parsed.assets = [];
		vault.contents.set(path, `${JSON.stringify(parsed, null, 2)}\n`);
		expect((await instance.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
	});

	it.each(['ready', 'detached'] as const)('rejects %s manifests whose localized entry differs from the manifest locale', async (state) => {
		const vault = new MemoryAssetVault();
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 2, locale: 'es', assets: await managedAssetsBundle() });
		await instance.apply('Tyrian Companion');
		if (state === 'detached') await instance.uninstall('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const parsed = JSON.parse(vault.contents.get(path)!) as MutableJournal;
		parsed.locale = 'en';
		const localized = parsed.assets.find((entry) => entry.id === 'halloween-base');
		if (!localized) throw new Error('missing localized fixture');
		localized.locale = 'es';
		vault.contents.set(path, `${JSON.stringify(parsed, null, 2)}\n`);
		expect((await instance.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
	});

	it('keeps a compatible prior bundle manifest readable when the current bundle adds an asset', async () => {
		const vault = new MemoryAssetVault();
		await (await manager(vault, 1)).apply('Tyrian Companion');
		const newer = await managerWithAdditionalAsset(vault);
		expect((await newer.inspect('Tyrian Companion')).manifestStatus).toBe('ready');
	});

	it('rejects an install journal with an arbitrary before hash', async () => {
		const vault = new MemoryAssetVault();
		vault.failAfterWrites = 1;
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const parsed = JSON.parse(vault.contents.get(path)!) as MutableJournal;
		parsed.pendingOperation.steps[0]!.beforeHash = 'a'.repeat(64);
		parsed.pendingOperation.operationId = await journalOperationId(parsed);
		vault.contents.set(path, `${JSON.stringify(parsed, null, 2)}\n`);
		vault.failAfterWrites = null;
		expect((await instance.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
		expect((await instance.apply('Tyrian Companion')).status).toBe('conflict');
	});

	it('relocates a complete reserialized destination only with the exact v2 origin authority', async () => {
		const vault = new MemoryAssetVault();
		const bundle = await managedAssetsBundle();
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle });
		const pointer = new MemoryManagedAssetsPointerStore();
		const lifecycle = new ManagedAssetsLifecycle(instance, pointer);
		expect(await lifecycle.install('Previous root')).toMatchObject({ status: 'applied', root: 'Previous root' });
		const sourceManifestPath = `Previous root/${MANAGED_ASSETS_MANIFEST}`;
		const sourceManifest = JSON.parse(vault.contents.get(sourceManifestPath)!) as MutableJournal;
		expect(sourceManifest).toMatchObject({ schemaVersion: 2, bundleVersion: 6, state: 'ready' });
		expect(sourceManifest.assets).toHaveLength(5);

		const destinationBytes = new Map<string, string>();
		for (const entry of sourceManifest.assets) {
			const source = vault.contents.get(entry.path);
			if (source === undefined) throw new Error(`missing source fixture: ${entry.path}`);
			const destination = entry.path.replace(/^Previous root\//u, 'Configured output/');
			const reserialized = stringifyYaml(parseYaml(source));
			expect(reserialized).not.toContain('tyrian-companion-managed');
			vault.contents.set(destination, reserialized);
			vault.contents.delete(entry.path);
			destinationBytes.set(destination, reserialized);
		}

		expect(await lifecycle.move('Configured output')).toMatchObject({ status: 'relocated', root: 'Configured output' });
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Configured output' });
		expect(vault.contents.get(sourceManifestPath)).toContain('"state": "detached"');
		for (const [path, bytes] of destinationBytes) expect(vault.contents.get(path)).toBe(bytes);
		const destinationManifest = JSON.parse(vault.contents.get(`Configured output/${MANAGED_ASSETS_MANIFEST}`)!) as MutableJournal;
		expect(destinationManifest).toMatchObject({ schemaVersion: 2, bundleVersion: 6, state: 'ready' });
		expect(destinationManifest.assets).toHaveLength(5);
	});

	it('adopts the same markerless Bases on ordinary install by their published semantic hash, but relocation inspection stays strict', async () => {
		const vault = new MemoryAssetVault();
		const { instance } = await stageReserializedRelocation(vault);

		expect((await instance.inspect('Configured output', { adoptPublished: false })).assets.map((entry) => entry.status))
			.toEqual(Array(5).fill('occupied_unowned'));
		expect(await instance.apply('Configured output', 'install')).toMatchObject({ status: 'applied' });
		expect(vault.contents.has(`Configured output/${MANAGED_ASSETS_MANIFEST}`)).toBe(true);
	});

	it.each(['missing', 'extra', 'changed'] as const)(
		'refuses relocation adoption when the destination set is %s',
		async (scenario) => {
			const vault = new MemoryAssetVault();
			const { lifecycle, destinationPaths, sourceManifestPath } = await stageReserializedRelocation(vault);
			const first = destinationPaths[0];
			if (!first) throw new Error('missing destination fixture');
			if (scenario === 'missing') vault.contents.delete(first);
			else if (scenario === 'extra') vault.contents.set('Configured output/Bases/Foreign.base', 'filters:\n  and: []\n');
			else vault.contents.set(first, `${vault.contents.get(first)!}\ninvalid: [unterminated\n`);
			const before = new Map(vault.contents);

			expect(await lifecycle.move('Configured output')).toMatchObject({ status: 'conflict' });
			expect(vault.contents).toEqual(before);
			expect(vault.contents.get(sourceManifestPath)).toContain('"state": "ready"');
			expect(vault.contents.has(`Configured output/${MANAGED_ASSETS_MANIFEST}`)).toBe(false);
		},
	);

	it('refuses destination adoption when the owned origin has conflicting live bytes', async () => {
		const vault = new MemoryAssetVault();
		const { lifecycle, sourceManifestPath } = await stageReserializedRelocation(vault);
		const sourceManifest = JSON.parse(vault.contents.get(sourceManifestPath)!) as MutableJournal;
		const sourcePath = sourceManifest.assets[0]?.path;
		if (!sourcePath) throw new Error('missing source path fixture');
		vault.contents.set(sourcePath, 'filters:\n  and: [human-change]\n');
		const before = new Map(vault.contents);

		expect(await lifecycle.move('Configured output')).toMatchObject({ status: 'conflict' });
		expect(vault.contents).toEqual(before);
		expect(vault.contents.get(sourceManifestPath)).toContain('"state": "ready"');
		expect(vault.contents.has(`Configured output/${MANAGED_ASSETS_MANIFEST}`)).toBe(false);
	});

	it('resumes relocation after the adoption journal was persisted but not finalized', async () => {
		const vault = new MemoryAssetVault();
		const { bundle, lifecycle, pointer, destinationBytes } = await stageReserializedRelocation(vault);
		vault.failAfterWrites = vault.writeCount + 1;

		expect(await lifecycle.move('Configured output')).toMatchObject({ status: 'unavailable' });
		expect(await pointer.read()).toMatchObject({ status: 'moving', root: 'Previous root', targetRoot: 'Configured output' });
		expect(vault.contents.get(`Configured output/${MANAGED_ASSETS_MANIFEST}`)).toContain('"state": "applying"');
		for (const [path, bytes] of destinationBytes) expect(vault.contents.get(path)).toBe(bytes);

		vault.failAfterWrites = null;
		const resumed = new ManagedAssetsLifecycle(
			new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle }),
			pointer,
		);
		expect(await resumed.move('Configured output')).toMatchObject({ status: 'relocated', root: 'Configured output' });
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Configured output' });
		expect(vault.contents.get(`Configured output/${MANAGED_ASSETS_MANIFEST}`)).toContain('"state": "ready"');
		for (const [path, bytes] of destinationBytes) expect(vault.contents.get(path)).toBe(bytes);
	});

	it('adopts a reserialized destination whose origin manifest is an older contentVersion, then a later upgrade completes it', async () => {
		const vault = new MemoryAssetVault();
		const pointer = new MemoryManagedAssetsPointerStore();
		// bundleVersion stays fixed (as it does in production, currently a hardcoded manifest-
		// format constant) while only this Base's own contentVersion advances, exactly as measured:
		// bundleVersion 6, inventory/materials at contentVersion 4 inside a manifest still at 2.
		const originManager = await managerAtContentVersion(vault, 6, 2);
		const originLifecycle = new ManagedAssetsLifecycle(originManager, pointer);
		expect(await originLifecycle.install('Previous root')).toMatchObject({ status: 'applied', root: 'Previous root' });
		const sourceManifestPath = `Previous root/${MANAGED_ASSETS_MANIFEST}`;
		const sourceManifest = JSON.parse(vault.contents.get(sourceManifestPath)!) as MutableJournal;
		const originEntry = sourceManifest.assets[0];
		if (!originEntry) throw new Error('missing origin asset fixture');
		const originalBytes = vault.contents.get(originEntry.path);
		if (originalBytes === undefined) throw new Error('missing origin file fixture');
		// Obsidian reserializes the Base and drops the plugin's ownership marker, exactly as
		// measured in the vault; the destination now holds only bare, markerless YAML.
		const reserialized = stringifyYaml(parseYaml(originalBytes));
		const destinationPath = originEntry.path.replace(/^Previous root\//u, 'Configured output/');
		vault.contents.set(destinationPath, reserialized);
		vault.contents.delete(originEntry.path);

		// The plugin bundle has since moved this Base to contentVersion 3, while the origin
		// manifest still records the contentVersion 2 the user actually has installed.
		const upgradedManager = await managerAtContentVersion(vault, 6, 3);
		const upgradedLifecycle = new ManagedAssetsLifecycle(upgradedManager, pointer);

		expect(await upgradedLifecycle.move('Configured output')).toMatchObject({ status: 'relocated', root: 'Configured output' });

		const destinationManifest = JSON.parse(vault.contents.get(`Configured output/${MANAGED_ASSETS_MANIFEST}`)!) as MutableJournal;
		const destinationEntry = destinationManifest.assets[0];
		expect(destinationEntry).toMatchObject({ id: originEntry.id, contentVersion: 2 });
		expect(vault.contents.get(destinationPath)).toBe(reserialized);

		expect(await upgradedManager.apply('Configured output', 'upgrade')).toMatchObject({ status: 'applied' });
		const upgradedManifest = JSON.parse(vault.contents.get(`Configured output/${MANAGED_ASSETS_MANIFEST}`)!) as MutableJournal;
		expect(upgradedManifest.assets[0]?.contentVersion).toBe(3);
		expect(vault.contents.get(destinationPath)).not.toBe(reserialized);
	});

	it('confirms authority over a durably owned root whose entire tracked footprint went missing, without recreating any file there', async () => {
		const vault = new MemoryAssetVault();
		const pointer = new MemoryManagedAssetsPointerStore();
		const instance = await manager(vault, 2);
		const lifecycle = new ManagedAssetsLifecycle(instance, pointer);
		expect(await lifecycle.install('Real root')).toMatchObject({ status: 'applied', root: 'Real root' });
		const manifestPath = `Real root/${MANAGED_ASSETS_MANIFEST}`;
		const manifest = JSON.parse(vault.contents.get(manifestPath)!) as MutableJournal;
		const entry = manifest.assets[0];
		if (!entry) throw new Error('missing asset fixture');
		// The manifest is left exactly as installed; only the file itself is gone, the same
		// signature Obsidian leaves behind when it moves the folder that held it.
		vault.contents.delete(entry.path);
		const before = new Map(vault.contents);

		// The durable pointer names an unrelated root that never held any manifest or file at
		// all — the measured "Tyrian Companion" ghost pointer.
		const emptyPointer = await pointer.read();
		await pointer.compareAndSet(emptyPointer, { status: 'ready', root: 'Ghost root', targetRoot: null });

		const result = await lifecycle.install('Real root');

		expect(result.status).not.toBe('conflict');
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Real root' });
		expect(vault.contents).toEqual(before);
	});

	it('still refuses install when the durable pointer names a root that genuinely still owns files', async () => {
		const vault = new MemoryAssetVault();
		const pointer = new MemoryManagedAssetsPointerStore();
		const instance = await manager(vault, 2);
		const lifecycle = new ManagedAssetsLifecycle(instance, pointer);
		expect(await lifecycle.install('Root A')).toMatchObject({ status: 'applied', root: 'Root A' });

		expect(await lifecycle.install('Root B')).toMatchObject({ status: 'conflict' });
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Root A' });
	});

	it('relocates a retained legacy root only through an explicit lifecycle move', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const legacyRoot = 'Tyrian/CON';
		const sourceManifestPath = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const legacyManifestPath = `${legacyRoot}/${MANAGED_ASSETS_MANIFEST}`;
		const sourceAssetPath = 'Tyrian Companion/Bases/Sessions.base';
		const legacyAssetPath = `${legacyRoot}/Bases/Sessions.base`;
		const manifest = JSON.parse(vault.contents.get(sourceManifestPath)!) as MutableJournal & { root: string };
		manifest.root = legacyRoot;
		manifest.assets[0]!.path = legacyAssetPath;
		vault.contents.set(legacyAssetPath, vault.contents.get(sourceAssetPath)!);
		vault.contents.set(legacyManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		vault.contents.delete(sourceAssetPath);
		vault.contents.delete(sourceManifestPath);
		const pointer = new MemoryManagedAssetsPointerStore();
		const result = await new ManagedAssetsLifecycle(instance, pointer).move('Tyrian Companion Safe', legacyRoot);
		expect(result).toMatchObject({ status: 'relocated', root: 'Tyrian Companion Safe' });
		expect(vault.contents.has(legacyAssetPath)).toBe(false);
		expect(vault.contents.has('Tyrian Companion Safe/Bases/Sessions.base')).toBe(true);
	});

	it('retries a response-lost legacy Remove from its detached manifest without another write', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const legacyRoot = 'Tyrian/CON';
		const sourceManifestPath = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const legacyManifestPath = `${legacyRoot}/${MANAGED_ASSETS_MANIFEST}`;
		const sourceAssetPath = 'Tyrian Companion/Bases/Sessions.base';
		const legacyAssetPath = `${legacyRoot}/Bases/Sessions.base`;
		const manifest = JSON.parse(vault.contents.get(sourceManifestPath)!) as MutableJournal;
		manifest.root = legacyRoot;
		manifest.assets[0]!.path = legacyAssetPath;
		vault.contents.set(legacyAssetPath, vault.contents.get(sourceAssetPath)!);
		vault.contents.set(legacyManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		vault.contents.delete(sourceAssetPath);
		vault.contents.delete(sourceManifestPath);
		const pointer = new ResponseLossPointer();
		pointer.loseNextReadyNull = true;
		const lifecycle = new ManagedAssetsLifecycle(instance, pointer);
		await expect(lifecycle.remove(legacyRoot)).rejects.toThrow('response_lost');
		expect(vault.contents.get(legacyManifestPath)).toContain('"state": "detached"');
		const writes = vault.writeCount;
		const trashed = [...vault.trashed];
		await expect(lifecycle.remove(legacyRoot)).resolves.toMatchObject({ status: 'removed', root: null });
		expect(vault.writeCount).toBe(writes);
		expect(vault.trashed).toEqual(trashed);
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

/**
 * H14.8: reproduces the real 0.1.30 → HEAD jump with the actual production bundle, not a synthetic
 * fixture. `git show 0.1.30:src/assets/inventory-bases.ts` proved the ONLY asset content that
 * changed since that release is `Inventory.base`/`Materials.base`'s `file.mtime` column (it used to
 * read `note.tc_captured_at`), and it shipped WITHOUT a `contentVersion` bump — so this is exactly
 * the case where a stale vault relies entirely on the semantic-hash comparison in `inspect()`
 * (not the version number) to notice the update. `managed_assets_apply` must still come back
 * `applied`, never `conflict`/`validation_failed`, against a manifest a real prior release wrote.
 */
describe('H14.8 · upgrading a vault a real prior release (0.1.30) left behind', () => {
	it('upgrades to the current bundle without conflict and writes the new column', async () => {
		const vault = new MemoryAssetVault();
		const pointer = new MemoryManagedAssetsPointerStore();
		const legacy = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 6, locale: 'es', assets: await release0130Bundle(),
		});
		const legacyLifecycle = new ManagedAssetsLifecycle(legacy, pointer);
		await expect(legacyLifecycle.install('Tyrian Companion')).resolves.toMatchObject({ status: 'applied' });
		expect(vault.contents.get('Tyrian Companion/Bases/Inventory.base')).toContain('note.tc_captured_at');

		const current = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 6, locale: 'es', assets: await managedAssetsBundle(),
		});
		const currentLifecycle = new ManagedAssetsLifecycle(current, pointer);

		const upgraded = await currentLifecycle.install('Tyrian Companion');

		expect(upgraded.status).not.toBe('conflict');
		expect(upgraded).toMatchObject({ status: 'applied' });
		expect(vault.contents.get('Tyrian Companion/Bases/Inventory.base')).toContain('file.mtime');
		expect(vault.contents.get('Tyrian Companion/Bases/Inventory.base')).not.toContain('tc_captured_at');
		expect(vault.contents.get('Tyrian Companion/Bases/Materials.base')).toContain('file.mtime');
	});

	it('still fails closed if the manifest a prior release wrote is sabotaged', async () => {
		const vault = new MemoryAssetVault();
		const pointer = new MemoryManagedAssetsPointerStore();
		const legacy = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 6, locale: 'es', assets: await release0130Bundle(),
		});
		await new ManagedAssetsLifecycle(legacy, pointer).install('Tyrian Companion');
		const path = `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`;
		const parsed = JSON.parse(vault.contents.get(path)!) as MutableJournal;
		parsed.assets = parsed.assets.filter((entry) => entry.id !== 'inventory-base');
		vault.contents.set(path, `${JSON.stringify(parsed, null, 2)}\n`);

		const current = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 6, locale: 'es', assets: await managedAssetsBundle(),
		});
		const upgraded = await new ManagedAssetsLifecycle(current, pointer).install('Tyrian Companion');

		expect(upgraded.status).toBe('conflict');
	});
});

/**
 * Reproduces exactly what 0.1.30 wrote for `Inventory.base`/`Materials.base`: same id and locale,
 * `contentVersion: 4` (0.1.30's real number; HEAD bumped it to 5 once H14.8 caught the missing
 * bump below) and the pre-H14.12 bytes (`note.tc_captured_at` instead of `file.mtime`), the one
 * real content drift between that tag and HEAD (verified against
 * `git show 0.1.30:src/assets/inventory-bases.ts`).
 */
describe('markerless vault: adoption by published semantic hash and files the user owns', () => {
	const ROOT = 'Tyrian Companion';
	const MANIFEST = `${ROOT}/${MANAGED_ASSETS_MANIFEST}`;
	const pathOf = (asset: PackagedAsset) => `${ROOT}/Bases/${asset.relativePath}`;
	/** What Obsidian leaves behind: same meaning, first-line marker gone. */
	const markerless = (bytes: string) => stringifyYaml(parseYaml(bytes));
	const statuses = (inspection: Awaited<ReturnType<ManagedAssetsManager['inspect']>>) =>
		Object.fromEntries(inspection.assets.map((entry) => [entry.asset.id, entry.status]));

	async function stage(mutate: (bundle: PackagedAsset[], vault: MemoryAssetVault) => void = () => undefined) {
		const bundle = (await managedAssetsBundle()).filter((asset) => asset.locale === 'neutral' || asset.locale === 'es');
		const vault = new MemoryAssetVault();
		for (const asset of bundle) vault.contents.set(pathOf(asset), markerless(asset.bytes));
		mutate(bundle, vault);
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle });
		return { bundle, vault, instance };
	}

	it('recovers every markerless Base of the current bundle, writes manifest and markers, then is idempotent', async () => {
		const { vault, instance, bundle } = await stage();
		expect(Object.values(statuses(await instance.inspect(ROOT)))).toEqual(Array(5).fill('recoverable'));
		expect(await instance.preview(ROOT, 'install')).toMatchObject({ canApply: true, reasons: [] });
		expect(decideManagedAssetsAutoUpdate(await instance.inspect(ROOT))).toEqual({ action: 'apply' });

		expect((await instance.apply(ROOT, 'install')).status).toBe('applied');
		const manifest = JSON.parse(vault.contents.get(MANIFEST)!) as MutableJournal;
		expect(manifest).toMatchObject({ state: 'ready' });
		expect(manifest.assets).toHaveLength(5);
		expect(manifest.excluded).toBeUndefined();
		for (const asset of bundle) expect(vault.contents.get(pathOf(asset))).toBe(asset.bytes);

		const writes = vault.writeCount;
		expect((await instance.apply(ROOT, 'upgrade')).status).toBe('unchanged');
		expect(vault.writeCount).toBe(writes);
	});

	it('registers a Base equal to an older publication at that contentVersion and reads it as an update', async () => {
		const older = await stage();
		const current = older.bundle.find((asset) => asset.id === 'materials-base')!;
		const oldPath = pathOf(current);
		const newBytes = `${current.bytes.replace(`version=${String(current.contentVersion)}`, `version=${String(current.contentVersion + 1)}`)}tcTestExtra: 1\n`;
		const newer: PackagedAsset = { ...current, contentVersion: current.contentVersion + 1, bytes: newBytes, contentHash: await sha256Text(newBytes) };
		const published = [{ assetId: current.id, locale: current.locale, contentVersion: current.contentVersion,
			semanticHash: (await baseSemanticHash(current.bytes))! }];
		const assets = older.bundle.map((asset) => asset.id === current.id ? newer : asset);
		const instance = new ManagedAssetsManager(older.vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets }, published);

		expect(statuses(await instance.inspect(ROOT))['materials-base']).toBe('update');
		expect(await instance.preview(ROOT, 'install')).toMatchObject({ canApply: true });
		expect((await instance.apply(ROOT, 'install')).status).toBe('applied');
		expect(older.vault.contents.get(oldPath)).toBe(newBytes);
		const manifest = JSON.parse(older.vault.contents.get(MANIFEST)!) as MutableJournal;
		expect(manifest.assets.find((entry) => entry.id === 'materials-base')?.contentVersion).toBe(newer.contentVersion);
	});

	it('leaves a Base that matches no publication alone: excluded from the journal and the manifest, everything else applied', async () => {
		const { vault, instance, bundle } = await stage((assets, memory) => {
			const inventory = assets.find((asset) => asset.id === 'inventory-base')!;
			memory.contents.set(pathOf(inventory), markerless(inventory.bytes).replace(/^views:/mu, 'tcUser: true\nviews:'));
		});
		const inventory = bundle.find((asset) => asset.id === 'inventory-base')!;
		const mine = vault.contents.get(pathOf(inventory))!;
		expect(statuses(await instance.inspect(ROOT))['inventory-base']).toBe('occupied_unowned');
		const plan = await instance.preview(ROOT, 'install');
		expect(plan.canApply).toBe(true);
		expect(plan.steps.find((step) => step.id === 'inventory-base')?.status).toBe('occupied_unowned');
		// Adoptable files prove the folder is ours: recover by itself, the foreign one stays untouched.
		expect(decideManagedAssetsAutoUpdate(await instance.inspect(ROOT))).toEqual({ action: 'apply' });

		expect((await instance.apply(ROOT, 'install')).status).toBe('applied');
		const manifest = JSON.parse(vault.contents.get(MANIFEST)!) as MutableJournal;
		expect(manifest.assets.map((entry) => entry.id)).not.toContain('inventory-base');
		expect(manifest.assets).toHaveLength(4);
		expect(manifest.excluded).toEqual(['inventory-base']);
		expect(vault.contents.get(pathOf(inventory))).toBe(mine);

		const after = await instance.inspect(ROOT);
		expect(after.manifestStatus).toBe('ready');
		expect(statuses(after)['inventory-base']).toBe('occupied_unowned');
		const writes = vault.writeCount;
		expect((await instance.apply(ROOT, 'upgrade')).status).toBe('unchanged');
		expect((await instance.apply(ROOT, 'repair')).status).toBe('unchanged');
		expect(vault.writeCount).toBe(writes);
		expect(decideManagedAssetsAutoUpdate(after)).toEqual({ action: 'none' });
	});

	it('registers the excluded Base once the user deletes their file, and uninstall never touches an excluded file', async () => {
		const stageForeign = async () => await stage((assets, memory) => {
			const inventory = assets.find((asset) => asset.id === 'inventory-base')!;
			memory.contents.set(pathOf(inventory), markerless(inventory.bytes).replace(/^views:/mu, 'tcUser: true\nviews:'));
		});
		const restored = await stageForeign();
		const inventoryPath = pathOf(restored.bundle.find((asset) => asset.id === 'inventory-base')!);
		await restored.instance.apply(ROOT, 'install');
		restored.vault.contents.delete(inventoryPath);
		expect(statuses(await restored.instance.inspect(ROOT))['inventory-base']).toBe('create');
		expect((await restored.instance.apply(ROOT, 'upgrade')).status).toBe('applied');
		const manifest = JSON.parse(restored.vault.contents.get(MANIFEST)!) as MutableJournal;
		expect(manifest.assets).toHaveLength(5);
		expect(manifest.excluded).toBeUndefined();

		const removed = await stageForeign();
		await removed.instance.apply(ROOT, 'install');
		const mine = removed.vault.contents.get(inventoryPath)!;
		expect((await removed.instance.uninstall(ROOT)).status).toBe('detached');
		expect(removed.vault.contents.get(inventoryPath)).toBe(mine);
		expect(removed.vault.trashed).toHaveLength(4);
		expect((await removed.instance.inspect(ROOT)).manifestStatus).toBe('detached');
	});

	it('keeps failing closed when a ready manifest omits an asset without declaring it excluded', async () => {
		const { vault, instance } = await stage();
		await instance.apply(ROOT, 'install');
		const manifest = JSON.parse(vault.contents.get(MANIFEST)!) as MutableJournal;
		manifest.assets = manifest.assets.filter((entry) => entry.id !== 'inventory-base');
		vault.contents.set(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
		expect((await instance.inspect(ROOT)).manifestStatus).toBe('conflict');
		manifest.excluded = ['inventory-base'];
		vault.contents.set(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
		expect((await instance.inspect(ROOT)).manifestStatus).toBe('ready');
		manifest.excluded = ['inventory-base', 'sessions-base'];
		vault.contents.set(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
		expect((await instance.inspect(ROOT)).manifestStatus).toBe('conflict');
	});

	it('resumes a crashed adoption journal without unowned files and finalizes it', async () => {
		const { vault, instance, bundle } = await stage((assets, memory) => {
			const inventory = assets.find((asset) => asset.id === 'inventory-base')!;
			memory.contents.set(pathOf(inventory), markerless(inventory.bytes).replace(/^views:/mu, 'tcUser: true\nviews:'));
		});
		vault.failAfterWrites = 2;
		expect((await instance.apply(ROOT, 'install')).status).toBe('unavailable');
		vault.failAfterWrites = null;
		expect((await instance.inspect(ROOT)).manifestStatus).toBe('applying');
		expect((await instance.apply(ROOT, 'install')).status).toBe('applied');
		const manifest = JSON.parse(vault.contents.get(MANIFEST)!) as MutableJournal;
		expect(manifest).toMatchObject({ state: 'ready', excluded: ['inventory-base'] });
		expect(manifest.assets).toHaveLength(4);
		expect(vault.contents.get(pathOf(bundle.find((asset) => asset.id === 'sessions-base')!))).toBe(bundle.find((asset) => asset.id === 'sessions-base')!.bytes);
	});

	it('auto-applies without a manifest only when some file is adoptable; create and foreign files do not matter', async () => {
		const partial = await stage((assets, memory) => memory.contents.delete(pathOf(assets.find((asset) => asset.id === 'wallet-base')!)));
		const inspection = await partial.instance.inspect(ROOT);
		expect(statuses(inspection)['wallet-base']).toBe('create');
		expect(decideManagedAssetsAutoUpdate(inspection)).toEqual({ action: 'apply' });

		const onlyForeign = await stage((assets, memory) => {
			for (const asset of assets) memory.contents.set(pathOf(asset), `tcUser: ${asset.id}\n`);
		});
		expect(Object.values(statuses(await onlyForeign.instance.inspect(ROOT)))).toEqual(Array(5).fill('occupied_unowned'));
		expect(decideManagedAssetsAutoUpdate(await onlyForeign.instance.inspect(ROOT))).toEqual({ action: 'none' });

		const empty = await stage((assets, memory) => { for (const asset of assets) memory.contents.delete(pathOf(asset)); });
		expect(decideManagedAssetsAutoUpdate(await empty.instance.inspect(ROOT))).toEqual({ action: 'none' });
	});

	it('does not adopt by hash when the caller asks for strict evidence (relocation)', async () => {
		const { instance } = await stage();
		expect(Object.values(statuses(await instance.inspect(ROOT, { adoptPublished: false }))))
			.toEqual(Array(5).fill('occupied_unowned'));
	});
});

/**
 * Measured 30 sep 2026: the durable pointer names an old root that still owns a manifest and files,
 * while the root the settings name has no manifest (Obsidian stripped the markers) but holds Bases
 * that match published hashes. The settings root wins; the old root is never touched.
 */
describe('a settings root with adoptable Bases takes over a pointer that names another live root', () => {
	const OLD = 'Old root';
	const NEW = 'Configured root';
	const NEW_MANIFEST = `${NEW}/${MANAGED_ASSETS_MANIFEST}`;
	const markerless = (bytes: string) => stringifyYaml(parseYaml(bytes));

	async function stage(adoptable: boolean) {
		const base = (await managedAssetsBundle()).filter((asset) => asset.locale === 'neutral' || asset.locale === 'es');
		const materials = base.find((asset) => asset.id === 'materials-base')!;
		const newBytes = `${materials.bytes.replace(`version=${String(materials.contentVersion)}`, `version=${String(materials.contentVersion + 1)}`)}tcTestExtra: 1\n`;
		const newer: PackagedAsset = { ...materials, contentVersion: materials.contentVersion + 1, bytes: newBytes, contentHash: await sha256Text(newBytes) };
		const published = [{ assetId: materials.id, locale: materials.locale, contentVersion: materials.contentVersion,
			semanticHash: (await baseSemanticHash(materials.bytes))! }];
		const bundle = base.map((asset) => asset.id === materials.id ? newer : asset);
		const vault = new MemoryAssetVault();
		const pointer = new MemoryManagedAssetsPointerStore();
		const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle }, published);
		const lifecycle = new ManagedAssetsLifecycle(instance, pointer);
		expect(await lifecycle.install(OLD)).toMatchObject({ status: 'applied', root: OLD });
		const oldRoot = new Map([...vault.contents].filter(([path]) => path.startsWith(`${OLD}/`)));
		const pathOf = (id: string) => `${NEW}/Bases/${bundle.find((asset) => asset.id === id)!.relativePath}`;
		if (adoptable) {
			for (const asset of base) vault.contents.set(pathOf(asset.id), markerless(asset.bytes));
			vault.contents.set(pathOf('inventory-base'), markerless(base.find((asset) => asset.id === 'inventory-base')!.bytes).replace(/^views:/mu, 'tcUser: true\nviews:'));
		} else {
			for (const asset of base) vault.contents.set(pathOf(asset.id), `tcUser: ${asset.id}\n`);
		}
		return { vault, pointer, lifecycle, bundle, oldRoot, pathOf, newer };
	}

	it('adopts the configured root, leaves the old root byte for byte and points the pointer at the new one', async () => {
		const { vault, pointer, lifecycle, bundle, oldRoot, pathOf, newer } = await stage(true);
		const inventoryBefore = vault.contents.get(pathOf('inventory-base'))!;

		const result = await lifecycle.install(NEW);

		expect(result).toMatchObject({ status: 'applied', root: NEW });
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: NEW, targetRoot: null });
		const manifest = JSON.parse(vault.contents.get(NEW_MANIFEST)!) as MutableJournal;
		expect(manifest).toMatchObject({ state: 'ready', excluded: ['inventory-base'] });
		expect(manifest.assets.map((entry) => entry.id).sort()).toEqual(['halloween-base', 'materials-base', 'sessions-base', 'wallet-base']);
		for (const id of ['halloween-base', 'sessions-base', 'wallet-base']) {
			expect(vault.contents.get(pathOf(id))).toBe(bundle.find((asset) => asset.id === id)!.bytes);
		}
		expect(vault.contents.get(pathOf('materials-base'))).toBe(newer.bytes);
		expect(vault.contents.get(pathOf('inventory-base'))).toBe(inventoryBefore);
		for (const [path, bytes] of oldRoot) expect(vault.contents.get(path)).toBe(bytes);
		expect([...vault.contents.keys()].filter((path) => path.startsWith(`${OLD}/`)).sort()).toEqual([...oldRoot.keys()].sort());
		expect(vault.trashed).toEqual([]);

		const writes = vault.writeCount;
		expect(await lifecycle.install(NEW)).toMatchObject({ status: 'unchanged', root: NEW });
		expect(vault.writeCount).toBe(writes);
	});

	it('keeps the conflict and writes nothing when the configured root holds nothing adoptable', async () => {
		const { vault, pointer, lifecycle } = await stage(false);
		const before = new Map(vault.contents);
		const pointerBefore = await pointer.read();

		expect(await lifecycle.install(NEW)).toMatchObject({ status: 'conflict', message: 'Another managed-assets root is active.' });

		expect(vault.contents).toEqual(before);
		expect(await pointer.read()).toEqual(pointerBefore);
	});
});

async function release0130Bundle(): Promise<PackagedAsset[]> {
	const current = await managedAssetsBundle();
	return await Promise.all(current.map(async (asset) => {
		if (asset.id !== 'inventory-base' && asset.id !== 'materials-base') return asset;
		const contentVersion = 4;
		const bytes = asset.bytes
			.replace(`version=${String(asset.contentVersion)}`, `version=${String(contentVersion)}`)
			.replaceAll('file.mtime', 'note.tc_captured_at');
		return { ...asset, contentVersion, bytes, contentHash: await sha256Text(bytes) };
	}));
}

async function stageReserializedRelocation(vault: MemoryAssetVault): Promise<{
	bundle: PackagedAsset[];
	instance: ManagedAssetsManager;
	lifecycle: ManagedAssetsLifecycle;
	pointer: MemoryManagedAssetsPointerStore;
	destinationBytes: Map<string, string>;
	destinationPaths: string[];
	sourceManifestPath: string;
}> {
	const bundle = await managedAssetsBundle();
	const instance = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle });
	const pointer = new MemoryManagedAssetsPointerStore();
	const lifecycle = new ManagedAssetsLifecycle(instance, pointer);
	expect(await lifecycle.install('Previous root')).toMatchObject({ status: 'applied', root: 'Previous root' });
	const sourceManifestPath = `Previous root/${MANAGED_ASSETS_MANIFEST}`;
	const sourceManifest = JSON.parse(vault.contents.get(sourceManifestPath)!) as MutableJournal;
	const destinationBytes = new Map<string, string>();
	for (const entry of sourceManifest.assets) {
		const source = vault.contents.get(entry.path);
		if (source === undefined) throw new Error(`missing source fixture: ${entry.path}`);
		const destination = entry.path.replace(/^Previous root\//u, 'Configured output/');
		const reserialized = stringifyYaml(parseYaml(source));
		vault.contents.set(destination, reserialized);
		vault.contents.delete(entry.path);
		destinationBytes.set(destination, reserialized);
	}
	return {
		bundle, instance, lifecycle, pointer, destinationBytes,
		destinationPaths: [...destinationBytes.keys()], sourceManifestPath,
	};
}

async function manager(vault: MemoryAssetVault, version: number): Promise<ManagedAssetsManager> {
	const [asset] = await genericManagedAssets();
	if (!asset) throw new Error('missing fixture');
	const bytes = asset.bytes.replace(/version=\d+/u, `version=${version}`);
	const contentHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
	const hash = [...new Uint8Array(contentHash)].map((part) => part.toString(16).padStart(2, '0')).join('');
	return new ManagedAssetsManager(vault, CONFIG_DIR, {
		bundleVersion: version, locale: 'es', assets: [{ ...asset, contentVersion: version, bytes, contentHash: hash }],
	});
}

/** Like `manager()`, but holds `bundleVersion` fixed while only the asset's own
 * contentVersion moves, matching the real shape: a stable manifest-format bundleVersion
 * with individual assets (inventory-base, materials-base) advancing independently. */
async function managerAtContentVersion(vault: MemoryAssetVault, bundleVersion: number, contentVersion: number): Promise<ManagedAssetsManager> {
	const [asset] = await genericManagedAssets();
	if (!asset) throw new Error('missing fixture');
	const bytes = asset.bytes.replace(/version=\d+/u, `version=${contentVersion}`);
	return new ManagedAssetsManager(vault, CONFIG_DIR, {
		bundleVersion, locale: 'es', assets: [{ ...asset, contentVersion, bytes, contentHash: await sha256Text(bytes) }],
	});
}

async function managerWithAdditionalAsset(vault: MemoryAssetVault): Promise<ManagedAssetsManager> {
	const [asset] = await genericManagedAssets();
	if (!asset) throw new Error('missing fixture');
	const bytes = asset.bytes.replace(/version=\d+/u, 'version=2');
	const current = { ...asset, contentVersion: 2, bytes, contentHash: await sha256Text(bytes) };
	const draft = { id: 'later-base', kind: 'base', contentVersion: 1, locale: 'neutral', relativePath: 'Later.base' } as const;
	const addedBytes = `${managedAssetMarker(draft)}\nfilters:\n  and: []\n`;
	const added: PackagedAsset = { ...draft, bytes: addedBytes, contentHash: await sha256Text(addedBytes) };
	return new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 2, locale: 'es', assets: [current, added] });
}

async function baseAsset(id: string, relativePath: string, body: string): Promise<PackagedAsset> {
	const draft = { id, kind: 'base', contentVersion: 1, locale: 'neutral', relativePath } as const;
	const bytes = `${managedAssetMarker(draft)}\n${body}`;
	return { ...draft, bytes, contentHash: await sha256Text(bytes) };
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
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
	async read(file: ManagedAssetFile): Promise<string> {
		const value = this.contents.get(file.path); if (value === undefined) throw new Error('not_file'); return value;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		this.fail();
		if (this.file(path)) throw new Error('exists');
		this.writeCount += 1; this.contents.set(path, content); return { path };
	}
	/**
	 * Hebra's `process` (R1a): the update runs, the write comes back `stale` because the file
	 * changed, and the update runs AGAIN on a fresh read; only that last result is written.
	 */
	staleOnce: ((path: string) => void) | null = null;
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		this.fail();
		if (this.staleOnce) {
			const first = this.contents.get(file.path);
			if (first !== undefined) update(first);
			this.staleOnce(file.path);
			this.staleOnce = null;
		}
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

class ResponseLossPointer extends MemoryManagedAssetsPointerStore {
	loseNextReadyNull = false;
	override async compareAndSet(expected: Parameters<MemoryManagedAssetsPointerStore['compareAndSet']>[0], next: Parameters<MemoryManagedAssetsPointerStore['compareAndSet']>[1]) {
		const result = await super.compareAndSet(expected, next);
		if (this.loseNextReadyNull && next.status === 'ready' && next.root === null) {
			this.loseNextReadyNull = false;
			throw new Error('response_lost');
		}
		return result;
	}
}

interface MutableJournal {
	schemaVersion: 1 | 2;
	root: string;
	generation: number;
	locale: 'es' | 'en';
	assets: Array<{ id: string; kind: 'base' | 'template'; contentVersion: number; locale: 'neutral' | 'es' | 'en'; path: string; installedHash: string; installedSemanticHash?: string }>;
	pendingOperation: {
		operationId: string;
		kind: 'install' | 'upgrade' | 'repair' | 'relocate' | 'uninstall';
		fromGeneration: number;
		targetBundleVersion: number;
		steps: Array<{ id: string; path: string; beforeHash: string | null; afterHash: string | null; state: 'pending' | 'done' }>;
	};
	[key: string]: unknown;
}

async function journalOperationId(manifest: MutableJournal): Promise<string> {
	return await sha256Text(JSON.stringify([
		manifest.root,
		manifest.pendingOperation.fromGeneration,
		manifest.pendingOperation.targetBundleVersion,
		manifest.locale,
		manifest.pendingOperation.kind,
		manifest.pendingOperation.steps.map(({ id, path, beforeHash, afterHash }) => ({ id, path, beforeHash, afterHash })),
	]));
}

async function legacyJournalOperationId(manifest: MutableJournal, steps: MutableJournal['pendingOperation']['steps']): Promise<string> {
	return await sha256Text(JSON.stringify([
		manifest.root,
		manifest.pendingOperation.fromGeneration,
		manifest.pendingOperation.targetBundleVersion,
		manifest.locale,
		manifest.pendingOperation.kind,
		steps,
	]));
}
