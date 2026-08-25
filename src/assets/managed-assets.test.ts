import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { genericManagedAssets, managedAssetsBundle, sha256Text } from './generic-assets';
import { halloweenManagedAssets } from './halloween-base';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { ManagedAssetsLifecycle } from './managed-assets-lifecycle';
import { MANAGED_ASSETS_MANIFEST, managedAssetMarker, normalizeManagedAssetPath, planManagedAssets, type PackagedAsset } from './managed-assets-model';
import { MemoryManagedAssetsPointerStore } from './managed-assets-pointer';

const CONFIG_DIR = 'vault-config';

describe('managed asset paths and planning', () => {
	it.each(['A/../B.base', 'A//B.base', '/A.base', 'A\\B.base', 'vault-config/A.base', 'VAULT-CONFIG/A.base', 'A/B?.base', 'A/B. ', `A/\0.base`, 'A/\u0001.base', 'A/e\u0301.base', 'A/CON.base', 'A/LPT1.md', `A/${'b'.repeat(121)}.base`])('rejects unsafe or non-NFC path %s', (path) => {
		expect(normalizeManagedAssetPath(path, CONFIG_DIR)).toBeNull();
	});

	it('allows only managed extensions and blocks unowned occupations in a pure preview', () => {
		expect(normalizeManagedAssetPath('Tyrian Companion/Bases/Sessions.base', CONFIG_DIR)).toBeTruthy();
		expect(normalizeManagedAssetPath(`Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`, CONFIG_DIR)).toBeTruthy();
		expect(normalizeManagedAssetPath('Tyrian Companion/Bases/Sessions.css', CONFIG_DIR)).toBeNull();
		const inspection = {
			root: 'Tyrian Companion', manifestPath: `Tyrian Companion/${MANAGED_ASSETS_MANIFEST}`,
			manifest: null, manifestStatus: 'missing' as const, bundleVersion: 1, locale: 'es' as const,
			assets: [{ asset: fixtureAsset(), path: 'Tyrian Companion/Bases/Sessions.base', status: 'occupied_unowned' as const,
				currentHash: 'a'.repeat(64), currentSemanticHash: null, installedHash: null }],
		};
		expect(planManagedAssets(inspection, 'install')).toMatchObject({ canApply: false, reasons: ['occupied_unowned'] });
	});

	it('keeps Sessions.base scoped to the durable session schema and kind', async () => {
		const [asset] = await genericManagedAssets();
		expect(asset?.bytes).toContain('tc_schema >= 1');
		expect(asset?.bytes).toContain('tc_kind == "gw2_farming_session"');
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

	it('relocates a retained legacy root only through an explicit lifecycle move', async () => {
		const vault = new MemoryAssetVault();
		const instance = await manager(vault, 1);
		await instance.apply('Tyrian Companion');
		const legacyRoot = 'Tyrian/e\u0301';
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
		const legacyRoot = 'Tyrian/e\u0301';
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
