import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { walletManagedAssets } from './wallet-base';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { hasCompatibleMarker } from './managed-assets-model';
import { WalletVaultSyncService, type WalletVaultFile, type WalletVaultPort } from '../wallet/wallet-vault-sync';

const CONFIG_DIR = 'vault-config';

describe('wallet Base assets', () => {
	it('packages Wallet once per locale in the single managed bundle', async () => {
		const assets = await walletManagedAssets();
		expect(assets.map(({ id, kind, contentVersion, locale, relativePath }) => ({ id, kind, contentVersion, locale, relativePath }))).toEqual([
			{ id: 'wallet-base', kind: 'base', contentVersion: 1, locale: 'es', relativePath: 'Wallet.base' },
			{ id: 'wallet-base', kind: 'base', contentVersion: 1, locale: 'en', relativePath: 'Wallet.base' },
		]);
		const bundle = await managedAssetsBundle();
		for (const expected of assets) expect(bundle).toContainEqual(expected);
	});

	it('parses both locales as real YAML with an equivalent, closed two-view schema', async () => {
		const assets = await walletManagedAssets();
		const documents = assets.map((asset) => {
			expect(asset.bytes.includes('\r')).toBe(false);
			expect(hasCompatibleMarker(asset.bytes, asset)).toBe(true);
			return parse(asset.bytes) as BaseDocument;
		});
		for (const document of documents) validateDocument(document);
		expect(documents[0]!.views.map((view) => view.name)).toEqual(['Todas', 'Con saldo']);
		expect(documents[1]!.views.map((view) => view.name)).toEqual(['All', 'Owned']);
		expect(baseShape(documents[0]!)).toEqual(baseShape(documents[1]!));
	});

	it('keeps quantity numeric, filters on catalog activity and never on ownership', async () => {
		for (const asset of await walletManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			expect(document.formulas.currency_icon).toBe('if(tc_icon != null, image(tc_icon), null)');
			expect(flatFilters(document.filters)).toContain('tc_active == true');
			expect(flatFilters(document.filters)).not.toContain('tc_quantity > 0');
			const owned = document.views[1]!;
			expect(flatFilters(owned.filters)).toEqual(['tc_quantity > 0']);
			for (const view of document.views) {
				expect(view.order).toContain('formula.currency_icon');
				expect(view.order).not.toContain('tc_icon');
				expect(view.columnSize).toEqual({ 'formula.currency_icon': 52 });
				expect(view.order).toContain('tc_quantity');
			}
		}
	});

	it('names every display property with the canonical Obsidian namespace', async () => {
		for (const asset of await walletManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			const keys = Object.keys(document.properties ?? {});
			expect(keys.filter((key) => !/^(?:note|formula|file)\./u.test(key))).toEqual([]);
			expect(keys.filter((key) => key.startsWith('note.'))).toEqual([
				'note.tc_currency_name', 'note.tc_quantity', 'note.tc_currency_order', 'note.tc_captured_at',
			]);
			expect(keys.filter((key) => key.startsWith('formula.'))).toEqual(['formula.currency_icon']);
		}
	});

	it('adds Wallet.base on the bundle upgrade that introduces it, without touching the rest', async () => {
		const vault = new MemoryBaseVault();
		const bundle = await managedAssetsBundle();
		const withoutWallet = bundle.filter((asset) => asset.id !== 'wallet-base');
		const v5 = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 5, locale: 'es', assets: withoutWallet });
		expect((await v5.apply('Tyrian Companion')).status).toBe('applied');
		expect(vault.contents.has('Tyrian Companion/Bases/Wallet.base')).toBe(false);

		const v6 = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle });
		const preview = await v6.preview('Tyrian Companion', 'upgrade');
		expect(preview.steps.find((step) => step.id === 'wallet-base')).toEqual({
			id: 'wallet-base', path: 'Tyrian Companion/Bases/Wallet.base', status: 'create',
		});
		expect(preview.steps.filter((step) => step.id !== 'wallet-base').every((step) => step.status === 'unchanged')).toBe(true);
		expect((await v6.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		expect(vault.contents.has('Tyrian Companion/Bases/Wallet.base')).toBe(true);
	});

	it('references only fields emitted by a real rendered wallet note', async () => {
		const vault = new EmptyWalletVault();
		const plan = await new WalletVaultSyncService(vault, CONFIG_DIR).preview('Tyrian Companion', {
			schemaVersion: 1,
			capturedAt: '2026-08-25T08:00:00.000Z',
			locale: 'es',
			positions: [{ currencyId: 1, quantity: 100, order: 1, name: 'Coin', icon: null }],
		});
		const rendered = plan.steps[0]?.after;
		if (!rendered) throw new Error('Expected a rendered note in the create preview.');
		const noteFields = new Set(Object.keys(frontmatter(rendered)));
		for (const asset of await walletManagedAssets()) {
			const referencedFields = new Set(asset.bytes.match(/\btc_[a-z0-9_]+\b/gu) ?? []);
			expect([...referencedFields].filter((field) => !noteFields.has(field))).toEqual([]);
		}
	});

	it('has no Vault, writer, filesystem or network dependency in the packaged asset module', async () => {
		const source = await readFile(new URL('./wallet-base.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/\b(?:Vault|fetch|requestUrl|XMLHttpRequest|node:fs|session-note-writer)\b/u);
		expect(source).not.toMatch(/https?:\/\//u);
	});
});

function validateDocument(document: BaseDocument): void {
	expect(Object.keys(document).sort()).toEqual(['filters', 'formulas', 'properties', 'views']);
	expect(flatFilters(document.filters)).toEqual([
		'tc_schema == 1', 'tc_kind == "gw2_wallet_currency"',
		'tc_marker == "tyrian_companion_wallet_currency"', 'tc_active == true',
	]);
	for (const key of Object.keys(document.formulas)) expect(key).toMatch(/^[a-z][a-z0-9_]*$/u);
	for (const key of Object.keys(document.properties)) expect(key).toMatch(/^(?:note|formula|file)\.[a-z][a-z0-9_]*$/u);
	expect(document.views).toHaveLength(2);
	for (const view of document.views) expect(view.type).toBe('table');
}

function flatFilters(filter: Filter | undefined): string[] {
	if (typeof filter === 'string') return [filter];
	return filter?.and.flatMap(flatFilters) ?? [];
}

function baseShape(document: BaseDocument): unknown {
	return {
		filters: document.filters,
		formulas: document.formulas,
		propertyKeys: Object.keys(document.properties),
		views: document.views.map((view) => ({ ...view, name: '$localized' })),
	};
}

type Filter = string | { and: Filter[] };
interface BaseDocument {
	filters: Filter;
	formulas: Record<string, string>;
	properties: Record<string, { displayName: string }>;
	views: Array<{
		type: string;
		name: string;
		filters?: Filter;
		order: string[];
		sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
		columnSize?: Record<string, number>;
	}>;
}

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!match) throw new Error('Missing rendered frontmatter.');
	return parse(match[1]!) as Record<string, unknown>;
}

class EmptyWalletVault implements WalletVaultPort {
	file(_path: string): WalletVaultFile | null { return null; }
	markdownFiles(): readonly WalletVaultFile[] { return []; }
	async read(_file: WalletVaultFile): Promise<string> { throw new Error('read_not_expected'); }
	async createFolder(_path: string): Promise<void> { throw new Error('write_not_expected'); }
	async create(_path: string, _content: string): Promise<WalletVaultFile> { throw new Error('write_not_expected'); }
	async process(_file: WalletVaultFile, _update: (content: string) => string): Promise<string> { throw new Error('write_not_expected'); }
}

class MemoryBaseVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
	async read(file: ManagedAssetFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		if (this.file(path)) throw new Error('exists');
		this.contents.set(path, content);
		return { path };
	}
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not_file');
		const next = update(current);
		this.contents.set(file.path, next);
		return next;
	}
	async trashFile(file: ManagedAssetFile): Promise<void> { this.contents.delete(file.path); }
}
