import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { decideManagedAssetsOnLoad, MANAGED_ASSETS_MANIFEST } from './managed-assets-model';
import { RETIRED_MANAGED_ASSETS } from './retired-assets';
import { legacyRetiredBases } from '../test/managed-asset-fixture';

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
	});

	it('from bundle 6, also creates the summaries Base the manifest lacked', async () => {
		const { vault, next } = await installedBefore({ withoutSummaries: true });
		expect(vault.contents.has(`${BASES}/Session summaries.base`)).toBe(false);
		const inspection = await next.inspect(ROOT);
		expect(inspection.manifestStatus).toBe('ready');
		expect(decideManagedAssetsOnLoad(inspection).created.map((entry) => entry.asset.id)).toEqual(['session-summaries-base']);
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
		expect(decideManagedAssetsOnLoad(inspection)).toEqual({ created: [], retired: [] });
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('unchanged');
		expect(vault.writeCount).toBe(writes);
		expect(vault.trashed).toHaveLength(trashed);
		expect(vault.contents.get(`${ROOT}/${MANAGED_ASSETS_MANIFEST}`)).toBe(manifest);
	});

	it('is decided on load only when nothing else is pending: retirements alone yes, with an update or an edit no', async () => {
		const { vault, next } = await installedBefore();
		const inspection = await next.inspect(ROOT);
		const decision = decideManagedAssetsOnLoad(inspection);
		expect(decision.created).toEqual([]);
		expect(decision.retired.map((entry) => entry.entry.id).sort()).toEqual(['halloween-base', 'materials-base', 'sessions-base']);
		const wallet = `${BASES}/Wallet.base`;
		vault.contents.set(wallet, vault.contents.get(wallet)!.replace('name: "Todas"', 'name: "Mis monedas"'));
		expect(decideManagedAssetsOnLoad(await next.inspect(ROOT))).toEqual({ created: [], retired: [] });
		// A blocked preview writes nothing at all, retirements included.
		const writes = vault.writeCount;
		expect((await next.apply(ROOT, 'upgrade')).status).toBe('conflict');
		expect(vault.writeCount).toBe(writes);
		expect(vault.trashed).toEqual([]);
	});
});

class MemoryVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	writeCount = 0;
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
	async read(file: ManagedAssetFile): Promise<string> {
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
