import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { managedAssetsBundle, sha256Text } from './generic-assets';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import type { PackagedAsset } from './managed-assets-model';

// Counts how often the YAML of a PACKAGED asset (not of a Vault file) is parsed. The Vault copies
// below lose their first-line marker, as Obsidian rewrites a .base, so their text never equals the
// packaged bytes and cannot be mistaken for them.
const parsedTexts: string[] = [];
const digested: string[] = [];
vi.mock('yaml', async (importOriginal) => {
	const original = await importOriginal<typeof import('yaml')>();
	return {
		...original,
		parseDocument: (...args: Parameters<typeof original.parseDocument>) => {
			parsedTexts.push(args[0]);
			return original.parseDocument(...args);
		},
	};
});

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';

describe('packaged bundle evidence is computed once (4.4)', () => {
	beforeEach(() => {
		parsedTexts.length = 0;
		digested.length = 0;
		const original = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
			digested.push(new TextDecoder().decode(data));
			return await original(algorithm, data);
		});
	});
	afterEach(() => { vi.restoreAllMocks(); });

	const parsedCount = (asset: PackagedAsset): number => parsedTexts.filter((text) => text === asset.bytes).length;
	const hashedCount = (asset: PackagedAsset): number => digested.filter((text) => text === asset.bytes).length;

	it('hashes and parses each packaged asset once across repeated inspections', async () => {
		const { manager, assets } = await installedManager();
		const bases = assets.filter((asset) => asset.kind === 'base' && (asset.locale === 'neutral' || asset.locale === 'es'));
		await manager.inspect(ROOT);
		await manager.inspect(ROOT);
		await manager.inspect(ROOT);
		for (const asset of bases) {
			expect(hashedCount(asset), `${asset.id} sha256`).toBe(1);
			expect(parsedCount(asset), `${asset.id} yaml`).toBe(1);
		}
	});

	it('recomputes the evidence after setBundle replaces the bundle', async () => {
		const { manager, assets, vault } = await installedManager();
		await manager.inspect(ROOT);
		const [first] = assets.filter((asset) => asset.kind === 'base' && (asset.locale === 'neutral' || asset.locale === 'es'));
		const bytes = first!.bytes.replace(/version=\d+/u, `version=${String(first!.contentVersion + 1)}`);
		const replaced: PackagedAsset = { ...first!, contentVersion: first!.contentVersion + 1, bytes, contentHash: await sha256Text(bytes) };
		manager.setBundle({ bundleVersion: 6, locale: 'es', assets: assets.map((asset) => asset === first ? replaced : asset) });
		parsedTexts.length = 0;
		digested.length = 0;
		const inspection = await manager.inspect(ROOT);
		expect(hashedCount(replaced)).toBe(1);
		expect(parsedCount(replaced)).toBe(1);
		expect(inspection.assets.find((entry) => entry.asset.id === first!.id)?.status).toBe('update');
		expect(vault.contents.size).toBeGreaterThan(0);
	});

	it('still reads the Vault fresh: a Base edited between two inspections is detected', async () => {
		const { manager, assets, vault } = await installedManager();
		const [first] = assets.filter((asset) => asset.kind === 'base' && (asset.locale === 'neutral' || asset.locale === 'es'));
		const path = `${ROOT}/Bases/${first!.relativePath}`;
		const before = await manager.inspect(ROOT);
		expect(before.assets.find((entry) => entry.asset.id === first!.id)?.status).toBe('unchanged');
		vault.contents.set(path, `${vault.contents.get(path)!}\nuser_edit_key: edited\n`);
		const after = await manager.inspect(ROOT);
		expect(after.assets.find((entry) => entry.asset.id === first!.id)?.status).toBe('modified');
	});
});

/** Installs the real bundle, then rewrites every Base as Obsidian does (no first-line marker). */
async function installedManager(): Promise<{ manager: ManagedAssetsManager; assets: PackagedAsset[]; vault: Vault }> {
	const assets = await managedAssetsBundle();
	const vault = new Vault();
	const manager = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets });
	const applied = await manager.apply(ROOT);
	expect(applied.status).toBe('applied');
	for (const [path, content] of vault.contents) {
		if (path.endsWith('.base')) vault.contents.set(path, content.split('\n').slice(1).join('\n'));
	}
	parsedTexts.length = 0;
	digested.length = 0;
	// A fresh manager: nothing computed yet, exactly the state after the plugin starts.
	return { manager: new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets }), assets, vault };
}

class Vault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) ? { path } : null; }
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
	async read(file: ManagedAssetFile): Promise<string> { return this.contents.get(file.path)!; }
	async createFolder(): Promise<void> { /* folders are implicit */ }
	async create(path: string, content: string): Promise<ManagedAssetFile> { this.contents.set(path, content); return { path }; }
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		const next = update(this.contents.get(file.path)!);
		this.contents.set(file.path, next);
		return next;
	}
	async trashFile(): Promise<void> { /* nothing to trash in these tests */ }
}
