import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { decideManagedAssetsAutoUpdate, MANAGED_ASSETS_MANIFEST } from './managed-assets-model';
import { RETIRED_MANAGED_ASSETS } from './retired-assets';
import { legacyRetiredBases, publishedRetiredBases } from '../test/managed-asset-fixture';

const CONFIG_DIR = 'vault-config';
const ROOT = 'Tyrian Companion';
const BASES = `${ROOT}/Bases`;
const GONE = ['Sessions.base', 'Halloween.base', 'Materials.base'] as const;
const STAYS = ['Inventory.base', 'Session summaries.base', 'Wallet.base'] as const;

async function installedBefore(options: { withoutSummaries?: boolean } = {}) {
	const vault = new MemoryVault();
	const current = await managedAssetsBundle();
	const previous = [...current.filter((asset) => !options.withoutSummaries || asset.id !== 'session-summaries-base'), ...await legacyRetiredBases()];
	const old = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: options.withoutSummaries ? 6 : 7, locale: 'es', assets: previous });
	expect((await old.apply(ROOT)).status).toBe('applied');
	const next = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: current, retired: RETIRED_MANAGED_ASSETS });
	return { vault, next };
}

const manifestOf = (vault: MemoryVault) => JSON.parse(vault.contents.get(`${ROOT}/${MANAGED_ASSETS_MANIFEST}`)!) as { bundleVersion: number; assets: Array<{ id: string }> };

describe('the bundle retires Sessions, Halloween and Materials', () => {
	it('ships only Inventory, Session summaries and Wallet, and a fresh installation creates none of the three', async () => {
		const bundle = await managedAssetsBundle();
		expect([...new Set(bundle.map((asset) => asset.id))].sort()).toEqual(['inventory-base', 'session-summaries-base', 'wallet-base']);
		const vault = new MemoryVault();
		const fresh = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: bundle, retired: RETIRED_MANAGED_ASSETS });
		expect((await fresh.apply(ROOT)).status).toBe('applied');
		expect([...vault.contents.keys()].filter((path) => path.startsWith(BASES)).map((path) => path.slice(BASES.length + 1)).sort()).toEqual([...STAYS]);
		expect(vault.trashed).toEqual([]);
	});

	it('from bundle 7, trashes the three untouched Bases and leaves the manifest with the three that stay', async () => {
		const { vault, next } = await installedBefore();
		expect(manifestOf(vault).assets.map((entry) => entry.id)).toHaveLength(6);
		const preview = await next.preview(ROOT, 'upgrade');
		expect(preview.canApply).toBe(true);
		expect(preview.steps.filter((step) => step.status === 'retire').map((step) => step.path.slice(BASES.length + 1)).sort()).toEqual([...GONE].sort());
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		for (const name of GONE) expect(vault.contents.has(`${BASES}/${name}`)).toBe(false);
		for (const name of STAYS) expect(vault.contents.has(`${BASES}/${name}`)).toBe(true);
		expect(vault.trashed.map((path) => path.slice(BASES.length + 1)).sort()).toEqual([...GONE].sort());
		expect(manifestOf(vault).assets.map((entry) => entry.id).sort()).toEqual(['inventory-base', 'session-summaries-base', 'wallet-base']);
		// An apply that only retires leaves a manifest that says it is this bundle's, not the previous one's.
		expect(manifestOf(vault).bundleVersion).toBe(8);
		expect(next.retirementReport().trashed.map((path) => path.slice(BASES.length + 1)).sort()).toEqual([...GONE].sort());
	});

	it('from bundle 6, also creates the summaries Base the manifest lacked', async () => {
		const { vault, next } = await installedBefore({ withoutSummaries: true });
		expect(vault.contents.has(`${BASES}/Session summaries.base`)).toBe(false);
		const inspection = await next.inspect(ROOT);
		expect(inspection.manifestStatus).toBe('ready');
		expect(inspection.assets.filter((entry) => entry.status === 'create').map((entry) => entry.asset.id)).toEqual(['session-summaries-base']);
		expect(decideManagedAssetsAutoUpdate(inspection)).toEqual({ action: 'apply' });
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.has(`${BASES}/Session summaries.base`)).toBe(true);
		for (const name of GONE) expect(vault.contents.has(`${BASES}/${name}`)).toBe(false);
		expect(manifestOf(vault).assets.map((entry) => entry.id).sort()).toEqual(['inventory-base', 'session-summaries-base', 'wallet-base']);
	});

	it('keeps an edited one on disk, unregisters it without a conflict, and still trashes the other two', async () => {
		const { vault, next } = await installedBefore();
		const path = `${BASES}/Halloween.base`;
		vault.contents.set(path, vault.contents.get(path)!.replace('name: Sessions', 'name: My sessions'));
		const edited = vault.contents.get(path)!;
		const preview = await next.preview(ROOT, 'upgrade');
		expect(preview.canApply).toBe(true);
		expect(preview.reasons).toEqual([]);
		expect(preview.steps.find((step) => step.path === path)?.status).toBe('release');
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(path)).toBe(edited);
		expect(vault.contents.has(`${BASES}/Sessions.base`)).toBe(false);
		expect(vault.contents.has(`${BASES}/Materials.base`)).toBe(false);
		expect(manifestOf(vault).assets.map((entry) => entry.id)).not.toContain('halloween-base');
		// Unmanaged now: later inspections do not mention it and it blocks nothing.
		const after = await next.inspect(ROOT);
		expect(after.retirements ?? []).toEqual([]);
		expect((await next.preview(ROOT, 'upgrade')).canApply).toBe(true);
	});

	it('only unregisters a Base whose file is already gone', async () => {
		const { vault, next } = await installedBefore();
		vault.contents.delete(`${BASES}/Materials.base`);
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(manifestOf(vault).assets.map((entry) => entry.id)).not.toContain('materials-base');
		expect(vault.trashed.map((path) => path.slice(BASES.length + 1)).sort()).toEqual(['Halloween.base', 'Sessions.base']);
	});

	it('recognises an unedited Base that Obsidian reserialized (marker gone, same meaning) and trashes it', async () => {
		const { vault, next } = await installedBefore();
		const path = `${BASES}/Sessions.base`;
		vault.contents.set(path, stringifyYaml(parseYaml(vault.contents.get(path)!)));
		expect(vault.contents.get(path)).not.toContain('tyrian-companion-managed');
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.has(path)).toBe(false);
	});

	it('does nothing the second time', async () => {
		const { vault, next } = await installedBefore();
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		const writes = vault.writeCount; const trashed = vault.trashed.length; const manifest = vault.contents.get(`${ROOT}/${MANAGED_ASSETS_MANIFEST}`);
		const inspection = await next.inspect(ROOT);
		expect(decideManagedAssetsAutoUpdate(inspection)).toEqual({ action: 'none' });
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('unchanged');
		expect(vault.writeCount).toBe(writes);
		expect(vault.trashed).toHaveLength(trashed);
		expect(vault.contents.get(`${ROOT}/${MANAGED_ASSETS_MANIFEST}`)).toBe(manifest);
	});

	it('is decided like after a sync: retirements alone apply; an edited Base that stays holds everything back and, with only retirements pending, says nothing', async () => {
		const { vault, next } = await installedBefore();
		const inspection = await next.inspect(ROOT);
		expect(decideManagedAssetsAutoUpdate(inspection)).toEqual({ action: 'apply' });
		expect((inspection.retirements ?? []).map((entry) => entry.entry.id).sort()).toEqual(['halloween-base', 'materials-base', 'sessions-base']);
		const wallet = `${BASES}/Wallet.base`;
		vault.contents.set(wallet, vault.contents.get(wallet)!.replace('name: "Todas"', 'name: "Mis monedas"'));
		expect(decideManagedAssetsAutoUpdate(await next.inspect(ROOT))).toEqual({ action: 'none' });
		// A blocked preview writes nothing at all, retirements included.
		const writes = vault.writeCount;
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('conflict');
		expect(vault.writeCount).toBe(writes);
		expect(vault.trashed).toEqual([]);
	});
});

/** The Bases as 0.6.15 really published them, installed by a bundle-7 manager; `next` is the bundle-8 one. */
async function installedPublished() {
	const vault = new MemoryVault();
	const current = await managedAssetsBundle();
	const old = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'es', assets: [...current, ...await publishedRetiredBases()] });
	expect((await old.apply(ROOT)).status).toBe('applied');
	const next = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: current, retired: RETIRED_MANAGED_ASSETS });
	return { vault, next };
}

const setManifest = (vault: MemoryVault, change: (manifest: Record<string, unknown> & { assets: Array<Record<string, unknown>> }) => void): void => {
	const path = `${ROOT}/${MANAGED_ASSETS_MANIFEST}`;
	const manifest = JSON.parse(vault.contents.get(path)!) as Record<string, unknown> & { assets: Array<Record<string, unknown>> };
	change(manifest);
	vault.contents.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
};

describe('retirement against what 0.6.15 really published', () => {
	it('retires the three published files, byte for byte as installed', async () => {
		const { vault, next } = await installedPublished();
		const inspection = await next.inspect(ROOT);
		expect(inspection.retirements?.map((entry) => entry.status)).toEqual(['retire', 'retire', 'retire']);
		expect(decideManagedAssetsAutoUpdate(inspection)).toEqual({ action: 'apply' });
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		for (const name of GONE) expect(vault.contents.has(`${BASES}/${name}`)).toBe(false);
		expect(vault.trashed).toHaveLength(3);
	});

	it('removes a published file that Obsidian reformatted even when the manifest has no semantic hash to compare (schema 1), and Remove does not block on it', async () => {
		const { vault, next } = await installedPublished();
		const path = `${BASES}/Halloween.base`;
		vault.contents.set(path, stringifyYaml(parseYaml(vault.contents.get(path)!)));
		setManifest(vault, (manifest) => {
			manifest.schemaVersion = 1;
			for (const entry of manifest.assets) delete entry.installedSemanticHash;
		});
		// What it is: not the installed bytes and no recorded meaning, but exactly a published version.
		const inspection = await next.inspect(ROOT);
		expect(inspection.manifestStatus).toBe('ready');
		expect(inspection.retirements?.find((entry) => entry.entry.id === 'halloween-base')?.status).toBe('retire');
		// Remove (uninstall) must not call that file «modified» either.
		expect((await next.uninstall(ROOT)).status).toBe('detached');
		expect(vault.contents.has(path)).toBe(false);
	});

	it('keeps a published file that was really edited, however close it is to a published one', async () => {
		const { vault, next } = await installedPublished();
		const path = `${BASES}/Materials.base`;
		vault.contents.set(path, vault.contents.get(path)!.replace(/name: "[^"]+"/u, 'name: "Mía"'));
		const inspection = await next.inspect(ROOT);
		expect(inspection.retirements?.find((entry) => entry.entry.id === 'materials-base')?.status).toBe('release');
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(path)).toContain('name: "Mía"');
		expect(next.retirementReport().kept).toEqual([path]);
	});
});

describe('the removal itself', () => {
	it('re-reads the file inside the apply: an edit that lands after the inspection is not removed', async () => {
		const { vault, next } = await installedPublished();
		const path = `${BASES}/Halloween.base`;
		let reads = 0;
		vault.onRead = (target) => {
			if (target !== path) return;
			reads += 1;
			// Read 1 is the inspection's, read 2 is the retirement's own.
			if (reads === 2) vault.contents.set(path, vault.contents.get(path)!.replace(/name: "[^"]+"/u, 'name: "Mía"'));
		};
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(path)).toContain('name: "Mía"');
		expect(vault.trashed.map((entry) => entry.slice(BASES.length + 1)).sort()).toEqual(['Materials.base', 'Sessions.base']);
		expect(manifestOf(vault).assets.map((entry) => entry.id)).not.toContain('halloween-base');
	});

	it('uses the host\'s conditional removal: an edit between the read and the removal survives and is reported as kept', async () => {
		const { vault, next } = await installedPublished();
		const path = `${BASES}/Sessions.base`;
		vault.beforeConditionalTrash = (target) => { if (target === path) vault.contents.set(path, `${vault.contents.get(path)!}\n# edited in the window\n`); };
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(path)).toContain('edited in the window');
		const report = next.retirementReport();
		expect(report.kept).toEqual([path]);
		expect(report.trashed.map((entry) => entry.slice(BASES.length + 1)).sort()).toEqual(['Halloween.base', 'Materials.base']);
	});

	it('does not announce as removed a retired file that was already gone', async () => {
		const { vault, next } = await installedPublished();
		vault.contents.delete(`${BASES}/Materials.base`);
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		const report = next.retirementReport();
		expect(report.kept).toEqual([]);
		expect(report.trashed.map((entry) => entry.slice(BASES.length + 1)).sort()).toEqual(['Halloween.base', 'Sessions.base']);
	});
});

describe('a retired id an older plugin declared excluded', () => {
	it('is no conflict: the user\'s file is left alone and the id leaves the list', async () => {
		const { vault, next } = await installedPublished();
		const path = `${BASES}/Materials.base`;
		const mine = 'views: []\n# mine\n';
		vault.contents.set(path, mine);
		setManifest(vault, (manifest) => {
			manifest.assets = manifest.assets.filter((entry) => entry.id !== 'materials-base');
			manifest.excluded = ['materials-base'];
		});
		const inspection = await next.inspect(ROOT);
		expect(inspection.manifestStatus).toBe('ready');
		expect(decideManagedAssetsAutoUpdate(inspection)).toEqual({ action: 'apply' });
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(path)).toBe(mine);
		const manifest = JSON.parse(vault.contents.get(`${ROOT}/${MANAGED_ASSETS_MANIFEST}`)!) as { excluded?: string[]; bundleVersion: number };
		expect(manifest.excluded).toBeUndefined();
		expect(manifest.bundleVersion).toBe(8);
		expect((await next.inspect(ROOT)).manifestStatus).toBe('ready');
		expect(next.retirementReport().kept).toEqual([]);
	});

	it('an excluded retired id alone is enough work: it is taken off the list even with nothing else retiring', async () => {
		const vault = new MemoryVault();
		const current = await managedAssetsBundle();
		const old = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'es', assets: current });
		await old.apply(ROOT);
		setManifest(vault, (manifest) => { manifest.excluded = ['halloween-base']; });
		const next = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: current, retired: RETIRED_MANAGED_ASSETS });
		expect((await next.inspect(ROOT)).manifestStatus).toBe('ready');
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('applied');
		expect((JSON.parse(vault.contents.get(`${ROOT}/${MANAGED_ASSETS_MANIFEST}`)!) as { excluded?: string[] }).excluded).toBeUndefined();
	});
});

class MemoryVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	writeCount = 0;
	onRead: ((path: string) => void) | null = null;
	beforeConditionalTrash: ((path: string) => void) | null = null;
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
	/** The host's conditional removal: LF-normalized text compared at the moment of removal. */
	async trashIfUnchanged(file: ManagedAssetFile, expectedContent: string): Promise<{ status: 'trashed' } | { status: 'conflict' }> {
		this.beforeConditionalTrash?.(file.path);
		const current = this.contents.get(file.path);
		if (current === undefined || current.replace(/\r\n?/gu, '\n') !== expectedContent) return { status: 'conflict' };
		this.trashed.push(file.path);
		this.contents.delete(file.path);
		return { status: 'trashed' };
	}
	async read(file: ManagedAssetFile): Promise<string> {
		this.onRead?.(file.path);
		const value = this.contents.get(file.path);
		if (value === undefined) throw new Error('not_file');
		return value;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		if (this.file(path)) throw new Error('exists');
		this.writeCount += 1;
		this.contents.set(path, content);
		return { path };
	}
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not_file');
		const next = update(current);
		if (next !== current) { this.writeCount += 1; this.contents.set(file.path, next); }
		return next;
	}
	async trashFile(file: ManagedAssetFile): Promise<void> {
		this.trashed.push(file.path);
		this.contents.delete(file.path);
	}
}
