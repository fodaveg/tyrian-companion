import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { GuildWars2Client } from '../account/guild-wars-2-client';
import { parseWallet } from '../account/storage-snapshot-parsers';
import { sha256Text } from '../assets/managed-asset-hash';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import { parseCatalogCurrencies } from '../catalog/public-catalog-parsers';
import { normalizeVaultRelativePath } from '../core/vault-path';

export const WALLET_NOTE_SCHEMA_VERSION = 1 as const;
export const WALLET_NOTE_KIND = 'gw2_wallet_currency' as const;
export const WALLET_NOTE_MARKER = 'tyrian_companion_wallet_currency' as const;

export interface WalletVaultFile { path: string }

/** Vault-only port. It deliberately exposes neither filesystem paths nor adapter writes. */
export interface WalletVaultPort {
	file(path: string): WalletVaultFile | null;
	markdownFiles(): readonly WalletVaultFile[];
	read(file: WalletVaultFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<WalletVaultFile>;
	process(file: WalletVaultFile, update: (content: string) => string): Promise<string>;
}

export interface WalletVaultPosition {
	currencyId: number;
	quantity: number;
	order: number;
	name: string;
	icon: string | null;
}

export interface WalletVaultSyncInput {
	schemaVersion: typeof WALLET_NOTE_SCHEMA_VERSION;
	capturedAt: string;
	locale: CatalogLocale;
	positions: WalletVaultPosition[];
}

export type WalletVaultSyncStepStatus =
	| 'create'
	| 'update'
	| 'unchanged'
	| 'deactivate'
	| 'conflict';

export interface WalletVaultSyncStep {
	currencyId: number;
	path: string;
	status: WalletVaultSyncStepStatus;
	before: string | null;
	after: string | null;
}

export interface WalletVaultSyncPlan {
	schemaVersion: typeof WALLET_NOTE_SCHEMA_VERSION;
	root: string;
	capturedAt: string;
	positions: number;
	canApply: boolean;
	steps: WalletVaultSyncStep[];
}

export type WalletVaultSyncResult =
	| { status: 'applied' | 'unchanged'; created: number; updated: number; deactivated: number }
	| { status: 'conflict' | 'invalid' | 'unavailable'; message: string };

interface WalletNoteFields {
	tc_schema: typeof WALLET_NOTE_SCHEMA_VERSION;
	tc_kind: typeof WALLET_NOTE_KIND;
	tc_marker: typeof WALLET_NOTE_MARKER;
	tc_currency_id: number;
	tc_currency_order: number;
	tc_quantity: number;
	tc_active: boolean;
	tc_captured_at: string;
	tc_currency_name: string;
	tc_icon: string | null;
	descripcion: string;
}

interface OwnedWalletNote {
	fields: WalletNoteFields;
	content: string;
}

const WALLET_FOLDER = 'Wallet/Currencies';
const MARKER_PREFIX = '<!-- tyrian-companion-wallet';
const CURRENCY_CATALOG_PATH = 'currencies?ids=all';

/**
 * Captures the account wallet together with the public currency catalog. It never touches
 * characters, bags, bank or materials, so the `wallet` permission alone is enough.
 */
export class WalletVaultCaptureService {
	constructor(
		private readonly client: Pick<GuildWars2Client, 'beginOperation'>,
		private readonly publicGateway: PublicCatalogGateway,
		private readonly now: () => number = Date.now,
	) {}

	async capture(locale: CatalogLocale): Promise<WalletVaultSyncInput> {
		const operation = this.client.beginOperation();
		const [walletBody, catalogResponse] = await Promise.all([
			operation.request('account/wallet', new Set([401, 403])),
			this.publicGateway.requestDetailed(`${CURRENCY_CATALOG_PATH}&lang=${locale}`),
		]);
		if (catalogResponse.status !== 200) throw new Error('wallet_catalog_unavailable');
		const owned = new Map(parseWallet(walletBody).map((currency) => [currency.currencyId, currency.quantity]));
		const catalog = parseCatalogCurrencies(catalogResponse.body);
		const positions = catalog.map((currency): WalletVaultPosition => ({
			currencyId: currency.id,
			quantity: owned.get(currency.id) ?? 0,
			order: currency.order,
			name: cleanText(currency.name),
			icon: currency.icon.length > 0 ? currency.icon : null,
		}));
		positions.sort(comparePositions);
		return {
			schemaVersion: WALLET_NOTE_SCHEMA_VERSION,
			capturedAt: new Date(this.now()).toISOString(),
			locale,
			positions,
		};
	}
}

/** Plans and applies only versioned Tyrian wallet notes below one portable Vault root. */
export class WalletVaultSyncService {
	private flight: Promise<WalletVaultSyncResult> | null = null;

	constructor(
		private readonly vault: WalletVaultPort,
		private readonly configDir: string,
	) {}

	async preview(root: string, input: WalletVaultSyncInput): Promise<WalletVaultSyncPlan> {
		const normalizedRoot = normalizeWalletRoot(root, this.configDir);
		if (normalizedRoot === null || !isWalletVaultSyncInput(input)) throw new Error('invalid_wallet_sync_input');
		const folder = walletFolder(normalizedRoot);
		const desired = new Map<number, { position: WalletVaultPosition; path: string; content: string }>();
		for (const position of input.positions) {
			const path = `${folder}/${String(position.currencyId)}.md`;
			const content = await renderWalletNote(position, input.capturedAt, input.locale, true);
			desired.set(position.currencyId, { position, path, content });
		}

		const steps: WalletVaultSyncStep[] = [];
		const seenOwned = new Set<number>();
		for (const file of this.walletFiles(folder)) {
			const content = normalizeLf(await this.vault.read(file));
			const classified = await classifyWalletNote(content);
			if (classified.status === 'foreign') {
				steps.push(step(-1, file.path, 'conflict', content, null));
				continue;
			}
			if (classified.status === 'conflict') {
				steps.push(step(classified.currencyId ?? -1, file.path, 'conflict', content, null));
				continue;
			}
			const owned = classified.note;
			const expectedPath = `${folder}/${String(owned.fields.tc_currency_id)}.md`;
			if (file.path !== expectedPath || seenOwned.has(owned.fields.tc_currency_id)) {
				steps.push(step(owned.fields.tc_currency_id, file.path, 'conflict', content, null));
				continue;
			}
			seenOwned.add(owned.fields.tc_currency_id);
			const target = desired.get(owned.fields.tc_currency_id);
			if (target) {
				steps.push(step(target.position.currencyId, file.path,
					content === target.content ? 'unchanged' : 'update', content, target.content));
				continue;
			}
			if (!owned.fields.tc_active) {
				steps.push(step(owned.fields.tc_currency_id, file.path, 'unchanged', content, content));
				continue;
			}
			const inactive = await renderWalletNote(positionFromFields(owned.fields), input.capturedAt, input.locale, false);
			steps.push(step(owned.fields.tc_currency_id, file.path, 'deactivate', content, inactive));
		}

		for (const target of desired.values()) {
			if (seenOwned.has(target.position.currencyId)) continue;
			const occupied = this.vault.file(target.path);
			if (occupied) {
				const content = normalizeLf(await this.vault.read(occupied));
				steps.push(step(target.position.currencyId, target.path, 'conflict', content, null));
			} else {
				steps.push(step(target.position.currencyId, target.path, 'create', null, target.content));
			}
		}
		steps.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
		return {
			schemaVersion: WALLET_NOTE_SCHEMA_VERSION,
			root: normalizedRoot,
			capturedAt: input.capturedAt,
			positions: input.positions.length,
			canApply: steps.every((entry) => entry.status !== 'conflict'),
			steps,
		};
	}

	apply(plan: WalletVaultSyncPlan): Promise<WalletVaultSyncResult> {
		if (this.flight) return this.flight;
		const flight = this.applyInternal(plan).finally(() => {
			if (this.flight === flight) this.flight = null;
		});
		this.flight = flight;
		return flight;
	}

	private async applyInternal(plan: WalletVaultSyncPlan): Promise<WalletVaultSyncResult> {
		if (!isWalletVaultSyncPlan(plan, this.configDir) || !plan.canApply) {
			return { status: 'invalid', message: 'The wallet preview is invalid or blocked.' };
		}
		try {
			for (const entry of plan.steps) {
				const file = this.vault.file(entry.path);
				if (entry.before === null) {
					if (file !== null) return { status: 'conflict', message: 'A wallet note appeared after preview.' };
				} else {
					if (file === null || normalizeLf(await this.vault.read(file)) !== entry.before) {
						return { status: 'conflict', message: 'A wallet note changed after preview.' };
					}
				}
			}
			const writes = plan.steps.filter((entry) => entry.status !== 'unchanged');
			if (writes.length === 0) return { status: 'unchanged', created: 0, updated: 0, deactivated: 0 };
			await ensureFolders(this.vault, walletFolder(plan.root));
			let created = 0;
			let updated = 0;
			let deactivated = 0;
			for (const entry of writes) {
				if (entry.after === null) return { status: 'invalid', message: 'The wallet plan contains an empty write.' };
				if (entry.status === 'create') {
					try { await this.vault.create(entry.path, entry.after); }
					catch {
						const raced = this.vault.file(entry.path);
						if (!raced || normalizeLf(await this.vault.read(raced)) !== entry.after) {
							return { status: 'conflict', message: 'A wallet note occupied a planned path.' };
						}
					}
					created += 1;
					continue;
				}
				const file = this.vault.file(entry.path);
				if (!file || entry.before === null) return { status: 'conflict', message: 'A wallet note disappeared during apply.' };
				let applied = false;
				await this.vault.process(file, (current) => {
					if (normalizeLf(current) !== entry.before) return current;
					applied = true;
					return entry.after!;
				});
				const verified = this.vault.file(entry.path);
				if (!applied || !verified || normalizeLf(await this.vault.read(verified)) !== entry.after) {
					return { status: 'conflict', message: 'A wallet note changed during apply.' };
				}
				if (entry.status === 'deactivate') deactivated += 1;
				else updated += 1;
			}
			return { status: 'applied', created, updated, deactivated };
		} catch {
			return { status: 'unavailable', message: 'Wallet notes could not be written safely.' };
		}
	}

	private walletFiles(folder: string): WalletVaultFile[] {
		const prefix = `${folder}/`;
		return this.vault.markdownFiles().filter((file) => file.path.startsWith(prefix) && file.path.endsWith('.md'))
			.sort((left, right) => left.path.localeCompare(right.path));
	}
}

function walletFolder(root: string): string { return `${root}/${WALLET_FOLDER}`; }

function normalizeWalletRoot(value: unknown, configDir: string): string | null {
	return normalizeVaultRelativePath(value, { forbiddenPathPrefixes: [configDir], maxPathLength: 128 });
}

function comparePositions(left: WalletVaultPosition, right: WalletVaultPosition): number {
	return left.order - right.order || left.currencyId - right.currencyId;
}

/**
 * Unlike an inventory position, a currency's balance can legitimately be zero while the
 * currency stays active: `tc_active` tracks whether the currency still exists in the public
 * catalog, never whether the account owns any of it. Deactivation preserves the last known
 * quantity instead of zeroing it, because it reports a lost identity, not a spent balance.
 */
function fieldsFor(
	position: WalletVaultPosition,
	capturedAt: string,
	locale: CatalogLocale,
	active: boolean,
): WalletNoteFields {
	return {
		tc_schema: WALLET_NOTE_SCHEMA_VERSION,
		tc_kind: WALLET_NOTE_KIND,
		tc_marker: WALLET_NOTE_MARKER,
		tc_currency_id: position.currencyId,
		tc_currency_order: position.order,
		tc_quantity: position.quantity,
		tc_active: active,
		tc_captured_at: capturedAt,
		tc_currency_name: position.name,
		tc_icon: position.icon,
		descripcion: locale === 'es' ? 'Moneda de cartera gestionada por Tyrian Companion.' : 'Wallet currency managed by Tyrian Companion.',
	};
}

async function renderWalletNote(
	position: WalletVaultPosition,
	capturedAt: string,
	locale: CatalogLocale,
	active: boolean,
): Promise<string> {
	const fields = fieldsFor(position, capturedAt, locale, active);
	const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd();
	const heading = cleanText(position.name).replace(/^[#]/u, '\\$&');
	const body = `# ${heading}\n\n${fields.descripcion}\n`;
	const markerBase = markerLine(position.currencyId, null);
	const unsigned = `---\n${frontmatter}\n---\n${markerBase}\n${body}`;
	const hash = await sha256Text(unsigned);
	return `---\n${frontmatter}\n---\n${markerLine(position.currencyId, hash)}\n${body}`;
}

function markerLine(currencyId: number, hash: string | null): string {
	const base = `${MARKER_PREFIX} schema=${String(WALLET_NOTE_SCHEMA_VERSION)} marker=${WALLET_NOTE_MARKER} currency=${String(currencyId)}`;
	return hash === null ? `${base} -->` : `${base} hash=${hash} -->`;
}

async function classifyWalletNote(content: string): Promise<
	| { status: 'owned'; note: OwnedWalletNote }
	| { status: 'foreign' }
	| { status: 'conflict'; currencyId: number | null }
> {
	const marker = content.match(/<!-- tyrian-companion-wallet schema=(\d+) marker=([^\s]+) currency=(-?\d+)(?: hash=([a-f0-9]{64}))? -->/u);
	if (!marker) return content.includes(MARKER_PREFIX) ? { status: 'conflict', currencyId: null } : { status: 'foreign' };
	const currencyId = marker[3] ? Number(marker[3]) : null;
	if (marker[1] !== String(WALLET_NOTE_SCHEMA_VERSION) || marker[2] !== WALLET_NOTE_MARKER || currencyId === null || !marker[4]) {
		return { status: 'conflict', currencyId };
	}
	const markerWithHash = marker[0];
	const unsigned = content.replace(markerWithHash, markerLine(currencyId, null));
	if (await sha256Text(unsigned) !== marker[4]) return { status: 'conflict', currencyId };
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!frontmatter) return { status: 'conflict', currencyId };
	let parsed: unknown;
	try { parsed = parseYaml(frontmatter[1]!); }
	catch { return { status: 'conflict', currencyId }; }
	if (!isWalletNoteFields(parsed) || parsed.tc_currency_id !== currencyId) return { status: 'conflict', currencyId };
	return { status: 'owned', note: { fields: parsed, content } };
}

function positionFromFields(fields: WalletNoteFields): WalletVaultPosition {
	return {
		currencyId: fields.tc_currency_id,
		quantity: fields.tc_quantity,
		order: fields.tc_currency_order,
		name: fields.tc_currency_name,
		icon: fields.tc_icon,
	};
}

function step(
	currencyId: number,
	path: string,
	status: WalletVaultSyncStepStatus,
	before: string | null,
	after: string | null,
): WalletVaultSyncStep {
	return { currencyId, path, status, before, after };
}

function isWalletVaultSyncInput(value: unknown): value is WalletVaultSyncInput {
	if (!record(value) || value.schemaVersion !== WALLET_NOTE_SCHEMA_VERSION ||
		(value.locale !== 'es' && value.locale !== 'en') || !iso(value.capturedAt) || !Array.isArray(value.positions)) return false;
	return value.positions.every(isWalletPosition) && new Set(value.positions.map((entry) => entry.currencyId)).size === value.positions.length;
}

function isWalletPosition(value: unknown): value is WalletVaultPosition {
	return record(value) && positive(value.currencyId) && nonNegative(value.quantity) && nonNegative(value.order) &&
		nonEmptyText(value.name) && (value.icon === null || nonEmptyText(value.icon));
}

function isWalletNoteFields(value: unknown): value is WalletNoteFields {
	if (!record(value) || !exactKeys(value, [
		'tc_schema', 'tc_kind', 'tc_marker', 'tc_currency_id', 'tc_currency_order',
		'tc_quantity', 'tc_active', 'tc_captured_at', 'tc_currency_name', 'tc_icon', 'descripcion',
	])) return false;
	return value.tc_schema === WALLET_NOTE_SCHEMA_VERSION && value.tc_kind === WALLET_NOTE_KIND &&
		value.tc_marker === WALLET_NOTE_MARKER && positive(value.tc_currency_id) && nonNegative(value.tc_currency_order) &&
		nonNegative(value.tc_quantity) && typeof value.tc_active === 'boolean' && iso(value.tc_captured_at) &&
		nonEmptyText(value.tc_currency_name) && (value.tc_icon === null || nonEmptyText(value.tc_icon)) && nonEmptyText(value.descripcion);
}

function isWalletVaultSyncPlan(value: unknown, configDir: string): value is WalletVaultSyncPlan {
	return record(value) && value.schemaVersion === WALLET_NOTE_SCHEMA_VERSION && normalizeWalletRoot(value.root, configDir) === value.root &&
		iso(value.capturedAt) && nonNegative(value.positions) && typeof value.canApply === 'boolean' && value.canApply && Array.isArray(value.steps) &&
		value.steps.every((entry) => record(entry) && exactKeys(entry, ['currencyId', 'path', 'status', 'before', 'after']) &&
			positive(entry.currencyId) && typeof entry.path === 'string' && normalizeVaultRelativePath(entry.path, { forbiddenPathPrefixes: [configDir] }) === entry.path &&
			['create', 'update', 'unchanged', 'deactivate'].includes(String(entry.status)) &&
			(entry.before === null || typeof entry.before === 'string') && (entry.after === null || typeof entry.after === 'string'));
}

async function ensureFolders(vault: WalletVaultPort, path: string): Promise<void> {
	const segments = path.split('/');
	for (let index = 1; index <= segments.length; index += 1) {
		const folder = segments.slice(0, index).join('/');
		if (vault.file(folder)) continue;
		try { await vault.createFolder(folder); }
		catch { if (!vault.file(folder)) throw new Error('wallet_folder_unavailable'); }
	}
}

function cleanText(value: string): string {
	return value.normalize('NFC').replace(/[\p{Cc}\p{Cs}]+/gu, ' ').trim().slice(0, 256) || 'Unknown currency';
}

function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, '\n'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { const expected = new Set(keys); return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key)); }
function nonEmptyText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.normalize('NFC'); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
