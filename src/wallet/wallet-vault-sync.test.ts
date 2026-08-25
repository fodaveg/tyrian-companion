import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import {
	WalletVaultCaptureService,
	WalletVaultSyncService,
	type WalletVaultFile,
	type WalletVaultPort,
	type WalletVaultSyncInput,
} from './wallet-vault-sync';

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const CAPTURED_AT = '2026-08-25T08:00:01.000Z';

describe('wallet Vault capture', () => {
	it('merges the wallet against the full currency catalog and defaults unseen currencies to zero', async () => {
		const client = { beginOperation: vi.fn(() => ({
			request: vi.fn(async (path: string) => {
				expect(path).toBe('account/wallet');
				return [{ id: 1, value: 12_345 }, { id: 3, value: 7 }];
			}),
		})) };
		const gateway = { requestDetailed: vi.fn(async (path: string) => {
			expect(path).toBe('currencies?ids=all&lang=es');
			return { status: 200, headers: {}, body: currencyCatalogFixture() };
		}) };
		const service = new WalletVaultCaptureService(client as never, gateway, () => Date.parse(CAPTURED_AT));
		const input = await service.capture('es');
		expect(input.capturedAt).toBe(CAPTURED_AT);
		expect(input.positions.map(({ currencyId, quantity, order }) => ({ currencyId, quantity, order }))).toEqual([
			{ currencyId: 1, quantity: 12_345, order: 1 },
			{ currencyId: 2, quantity: 0, order: 2 },
			{ currencyId: 3, quantity: 7, order: 3 },
		]);
	});

	it('does no account capture until the explicit capture action is invoked', async () => {
		const client = { beginOperation: vi.fn(() => ({ request: vi.fn(async () => []) })) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, headers: {}, body: [] })) };
		const service = new WalletVaultCaptureService(client as never, gateway);
		expect(client.beginOperation).not.toHaveBeenCalled();
		await service.capture('es');
		expect(client.beginOperation).toHaveBeenCalledOnce();
	});

	it('fails closed when the public catalog endpoint does not answer with a fresh document', async () => {
		const client = { beginOperation: vi.fn(() => ({ request: vi.fn(async () => []) })) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 503, headers: {}, body: null })) };
		const service = new WalletVaultCaptureService(client as never, gateway);
		await expect(service.capture('es')).rejects.toThrow('wallet_catalog_unavailable');
	});
});

describe('wallet Vault preview and apply', () => {
	it('keeps preview read-only and converges through explicit idempotent apply', async () => {
		const vault = new MemoryWalletVault();
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const input = threeCurrencyInput();
		const preview = await service.preview(ROOT, input);
		expect(preview.steps).toHaveLength(3);
		expect(preview.steps.every((entry) => entry.status === 'create')).toBe(true);
		expect(vault.mutations).toBe(0);
		expect(await service.apply(preview)).toEqual({ status: 'applied', created: 3, updated: 0, deactivated: 0 });
		const second = await service.preview(ROOT, input);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		const writes = vault.mutations;
		expect(await service.apply(second)).toEqual({ status: 'unchanged', created: 0, updated: 0, deactivated: 0 });
		expect(vault.mutations).toBe(writes);
	});

	it('writes deterministic opaque filenames per currency id without leaking raw account payloads', async () => {
		const vault = new MemoryWalletVault();
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const input = threeCurrencyInput();
		await service.apply(await service.preview(ROOT, input));
		const paths = vault.markdownFiles().map((file) => file.path).sort();
		expect(paths).toEqual([
			`${ROOT}/Wallet/Currencies/1.md`,
			`${ROOT}/Wallet/Currencies/2.md`,
			`${ROOT}/Wallet/Currencies/3.md`,
		]);
		const bytes = [...vault.contents.values()].join('\n');
		expect(bytes).not.toContain('account-private');
		expect(bytes).not.toContain('token-private');
		expect(bytes).not.toContain('payload');
	});

	it('deactivates a currency dropped from the catalog while preserving its last known balance, not zeroing it', async () => {
		const vault = new MemoryWalletVault();
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const current = threeCurrencyInput();
		await service.apply(await service.preview(ROOT, current));
		const dropped = { ...current, capturedAt: '2026-08-25T08:01:00.000Z', positions: current.positions.filter((position) => position.currencyId !== 2) };
		const preview = await service.preview(ROOT, dropped);
		const droppedPath = `${ROOT}/Wallet/Currencies/2.md`;
		expect(preview.steps.find((entry) => entry.path === droppedPath)?.status).toBe('deactivate');
		expect(await service.apply(preview)).toMatchObject({ status: 'applied', deactivated: 1 });
		const fields = frontmatter(vault.contents.get(droppedPath)!);
		// This is the divergent-from-inventory property under test: deactivation must not
		// collapse the balance to zero, only flip tc_active. A currency losing its catalog
		// entry does not mean the account spent its balance.
		expect(fields).toMatchObject({ tc_active: false, tc_quantity: 500 });
		expect(vault.contents.has(droppedPath)).toBe(true);
	});

	it.each([
		['foreign target', (content: string) => '# foreign\n'],
		['human modification', (content: string) => `${content}\nhuman edit\n`],
		['future schema', (content: string) => content.replace('schema=1', 'schema=2')],
	])('blocks %s without mutating Vault', async (_label, corrupt) => {
		const input = oneCurrencyInput();
		const cleanVault = new MemoryWalletVault();
		const cleanService = new WalletVaultSyncService(cleanVault, CONFIG_DIR);
		const cleanPlan = await cleanService.preview(ROOT, input);
		const path = cleanPlan.steps[0]!.path;
		if (_label === 'foreign target') cleanVault.contents.set(path, corrupt(''));
		else {
			await cleanService.apply(cleanPlan);
			cleanVault.contents.set(path, corrupt(cleanVault.contents.get(path)!));
		}
		const mutations = cleanVault.mutations;
		const blocked = await cleanService.preview(ROOT, input);
		expect(blocked.canApply).toBe(false);
		expect(blocked.steps.some((entry) => entry.status === 'conflict')).toBe(true);
		expect(await cleanService.apply(blocked)).toMatchObject({ status: 'invalid' });
		expect(cleanVault.mutations).toBe(mutations);
	});

	it('blocks an unrelated foreign note inside the owned currency folder', async () => {
		const foreignPath = `${ROOT}/Wallet/Currencies/manual.md`;
		const foreign = '# Manual note\n';
		const vault = new MemoryWalletVault([[foreignPath, foreign]]);
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const plan = await service.preview(ROOT, oneCurrencyInput());
		expect(plan.canApply).toBe(false);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: foreignPath, status: 'conflict' }));
		const mutations = vault.mutations;
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.mutations).toBe(mutations);
	});

	it('blocks duplicate owned identity without changing either collision', async () => {
		const vault = new MemoryWalletVault();
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const input = oneCurrencyInput();
		await service.apply(await service.preview(ROOT, input));
		const originalPath = vault.markdownFiles()[0]!.path;
		const duplicatePath = `${ROOT}/Wallet/Currencies/duplicate.md`;
		vault.contents.set(duplicatePath, vault.contents.get(originalPath)!);
		const before = new Map(vault.contents);
		const plan = await service.preview(ROOT, input);
		expect(plan.canApply).toBe(false);
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.contents).toEqual(before);
	});

	it('preflights every CAS before writing when a file changes after preview', async () => {
		const vault = new MemoryWalletVault();
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const initial = threeCurrencyInput();
		await service.apply(await service.preview(ROOT, initial));
		const changed = {
			...initial,
			capturedAt: '2026-08-25T08:02:00.000Z',
			positions: initial.positions.map((position) => ({ ...position, quantity: position.quantity + 1 })),
		};
		const plan = await service.preview(ROOT, changed);
		const last = plan.steps.at(-1)!;
		vault.contents.set(last.path, `${vault.contents.get(last.path)!}\nraced\n`);
		const before = new Map(vault.contents);
		expect(await service.apply(plan)).toMatchObject({ status: 'conflict' });
		expect(vault.contents).toEqual(before);
	});

	it('leaves legacy gw2 currency notes untouched and creates separate owned notes', async () => {
		const legacyPath = '02 - Areas/Guild Wars 2/Wiki/Wallet/legacy.md';
		const legacy = '---\ngw2_super_type: currency\ngw2_id: 1\ngw2_amount: 7\n---\n# Legacy\n';
		const vault = new MemoryWalletVault([[legacyPath, legacy]]);
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		const input = oneCurrencyInput();
		const plan = await service.preview(ROOT, input);
		expect(plan.canApply).toBe(true);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', created: 1 });
		expect(vault.contents.get(legacyPath)).toBe(legacy);
		expect(vault.markdownFiles()).toHaveLength(2);
	});

	it('rejects non-portable roots before any mutation', async () => {
		const vault = new MemoryWalletVault();
		const service = new WalletVaultSyncService(vault, CONFIG_DIR);
		for (const root of ['/absolute', '../escape', 'Bad:Root', `${CONFIG_DIR}/Wallet`, 'CON']) {
			await expect(service.preview(root, oneCurrencyInput())).rejects.toThrow('invalid_wallet_sync_input');
		}
		expect(vault.mutations).toBe(0);
	});
});

function currencyCatalogFixture(): unknown[] {
	return [
		{ id: 1, name: 'Coin', description: 'Standard gold currency.', order: 1, icon: 'https://example.test/coin.png' },
		{ id: 2, name: 'Karma', description: 'Earned through events.', order: 2, icon: 'https://example.test/karma.png' },
		{ id: 3, name: 'Gems', description: 'Premium currency.', order: 3, icon: 'https://example.test/gems.png' },
	];
}

function threeCurrencyInput(): WalletVaultSyncInput {
	return {
		schemaVersion: 1,
		capturedAt: CAPTURED_AT,
		locale: 'es',
		positions: [
			{ currencyId: 1, quantity: 100, order: 1, name: 'Coin', icon: 'https://example.test/coin.png' },
			{ currencyId: 2, quantity: 500, order: 2, name: 'Karma', icon: 'https://example.test/karma.png' },
			{ currencyId: 3, quantity: 0, order: 3, name: 'Gems', icon: null },
		],
	};
}

function oneCurrencyInput(): WalletVaultSyncInput {
	return {
		schemaVersion: 1,
		capturedAt: CAPTURED_AT,
		locale: 'es',
		positions: [{ currencyId: 1, quantity: 100, order: 1, name: 'Coin', icon: 'https://example.test/coin.png' }],
	};
}

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!match) throw new Error('Missing test frontmatter.');
	return parseYaml(match[1]!) as Record<string, unknown>;
}

class MemoryWalletVault implements WalletVaultPort {
	readonly contents: Map<string, string>;
	readonly folders = new Set<string>();
	mutations = 0;

	constructor(entries: Iterable<readonly [string, string]> = []) { this.contents = new Map(entries); }
	file(path: string): WalletVaultFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	markdownFiles(): readonly WalletVaultFile[] {
		return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path }));
	}
	async read(file: WalletVaultFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	async createFolder(path: string): Promise<void> {
		if (this.file(path)) throw new Error('exists');
		this.mutations += 1;
		this.folders.add(path);
	}
	async create(path: string, content: string): Promise<WalletVaultFile> {
		if (this.file(path)) throw new Error('exists');
		this.mutations += 1;
		this.contents.set(path, content);
		return { path };
	}
	async process(file: WalletVaultFile, update: (content: string) => string): Promise<string> {
		const current = await this.read(file);
		const next = update(current);
		if (next !== current) {
			this.mutations += 1;
			this.contents.set(file.path, next);
		}
		return next;
	}
}
