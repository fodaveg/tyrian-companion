import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { GuildWars2Client } from '../account/guild-wars-2-client';
import type { ItemHolding, StorageSnapshot } from '../account/storage-snapshot-model';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';
import { captureInventoryPrices } from '../advisor/inventory-advisor-evidence';
import type { InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import { sha256Text } from '../assets/managed-asset-hash';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogLocale, CatalogResolution } from '../catalog/public-catalog-model';
import type { PublicCatalogService } from '../catalog/public-catalog-service';
import { normalizeVaultRelativePath } from '../core/vault-path';

export const INVENTORY_NOTE_SCHEMA_VERSION = 1 as const;
export const INVENTORY_NOTE_KIND = 'gw2_inventory_position' as const;
export const INVENTORY_NOTE_MARKER = 'tyrian_companion_inventory_position' as const;

export type InventoryPositionSource = 'character' | 'shared_inventory' | 'bank' | 'materials';

export interface InventoryVaultFile { path: string }

/** Vault-only port. It deliberately exposes neither filesystem paths nor adapter writes. */
export interface InventoryVaultPort {
	file(path: string): InventoryVaultFile | null;
	markdownFiles(): readonly InventoryVaultFile[];
	read(file: InventoryVaultFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<InventoryVaultFile>;
	process(file: InventoryVaultFile, update: (content: string) => string): Promise<string>;
}

export interface InventoryVaultPosition {
	positionId: string;
	itemId: number;
	source: InventoryPositionSource;
	character: string | null;
	quantity: number;
	unitSellCopper: number | null;
	totalSellCopper: number | null;
	name: string;
	type: string | null;
	rarity: string | null;
	icon: string | null;
}

export interface InventoryVaultSyncInput {
	schemaVersion: typeof INVENTORY_NOTE_SCHEMA_VERSION;
	capturedAt: string;
	locale: CatalogLocale;
	positions: InventoryVaultPosition[];
}

export type InventoryVaultSyncStepStatus =
	| 'create'
	| 'update'
	| 'unchanged'
	| 'deactivate'
	| 'conflict';

export interface InventoryVaultSyncStep {
	positionId: string;
	path: string;
	status: InventoryVaultSyncStepStatus;
	before: string | null;
	after: string | null;
}

export interface InventoryVaultSyncPlan {
	schemaVersion: typeof INVENTORY_NOTE_SCHEMA_VERSION;
	root: string;
	capturedAt: string;
	positions: number;
	canApply: boolean;
	steps: InventoryVaultSyncStep[];
}

export type InventoryVaultSyncResult =
	| { status: 'applied' | 'unchanged'; created: number; updated: number; deactivated: number }
	| { status: 'conflict' | 'invalid' | 'unavailable'; message: string };

interface InventoryNoteFields {
	tc_schema: typeof INVENTORY_NOTE_SCHEMA_VERSION;
	tc_kind: typeof INVENTORY_NOTE_KIND;
	tc_marker: typeof INVENTORY_NOTE_MARKER;
	tc_position_id: string;
	tc_item_id: number;
	tc_source: InventoryPositionSource;
	tc_character: string | null;
	tc_quantity: number;
	tc_unit_sell_copper: number | null;
	tc_total_sell_copper: number | null;
	tc_active: boolean;
	tc_captured_at: string;
	tc_item_name: string;
	tc_item_type: string | null;
	tc_item_rarity: string | null;
	tc_icon: string | null;
	descripcion: string;
}

interface OwnedInventoryNote {
	fields: InventoryNoteFields;
	content: string;
}

const SOURCE_CODES: Record<InventoryPositionSource, string> = {
	character: 'c',
	shared_inventory: 's',
	bank: 'b',
	materials: 'm',
};
const INVENTORY_FOLDER = 'Inventory/Positions';
const MARKER_PREFIX = '<!-- tyrian-companion-inventory';

/**
 * Captures a stable account-wide snapshot and resolves the same public catalog and
 * instant-sale quote model used by the Inventory Advisor. Construction is inert.
 */
export class InventoryVaultCaptureService {
	constructor(
		private readonly client: Pick<GuildWars2Client, 'beginOperation'>,
		private readonly snapshots: Pick<StorageSnapshotService, 'captureWithOperation'>,
		private readonly catalog: Pick<PublicCatalogService, 'resolve'>,
		private readonly publicGateway: PublicCatalogGateway,
		private readonly now: () => number = Date.now,
	) {}

	async capture(locale: CatalogLocale): Promise<InventoryVaultSyncInput> {
		const operation = this.client.beginOperation();
		const snapshot = await this.snapshots.captureWithOperation(operation);
		if (!inventorySnapshotComplete(snapshot)) throw new Error('inventory_capture_incomplete');
		const [catalog, prices] = await Promise.all([
			this.catalog.resolve(snapshot, locale),
			captureInventoryPrices(snapshot, this.publicGateway, this.now()),
		]);
		return await prepareInventoryVaultSyncInput(snapshot, catalog, prices, locale);
	}
}

/**
 * Converts account-bound evidence into the identity-free rows allowed in Vault.
 * Only loose holdings from the four supported inventory locations are retained.
 */
export async function prepareInventoryVaultSyncInput(
	snapshot: StorageSnapshot,
	catalog: CatalogResolution,
	prices: InventoryPriceSnapshotV1,
	locale: CatalogLocale,
): Promise<InventoryVaultSyncInput> {
	assertCaptureRelations(snapshot, catalog, prices, locale);
	const grouped = new Map<string, { itemId: number; source: InventoryPositionSource; character: string | null; quantity: number }>();
	for (const holding of snapshot.holdings) {
		if (holding.kind !== 'item' || holding.state !== 'loose') continue;
		const location = inventoryLocation(holding);
		if (location === null) continue;
		const groupKey = JSON.stringify([holding.itemId, location.source, location.character]);
		const current = grouped.get(groupKey);
		if (current) current.quantity = safeAdd(current.quantity, holding.quantity);
		else grouped.set(groupKey, { itemId: holding.itemId, ...location, quantity: holding.quantity });
	}

	const priceById = new Map(prices.items.map((price) => [price.itemId, price]));
	const positions = await Promise.all([...grouped.values()].map(async (group): Promise<InventoryVaultPosition> => {
		const item = catalog.items[String(group.itemId)];
		const price = priceById.get(group.itemId);
		const unitSellCopper = price?.whitelisted === true && price.bid !== null ? price.bid.unitCopper : null;
		return {
			positionId: await positionId(group.itemId, group.source, group.character),
			itemId: group.itemId,
			source: group.source,
			character: group.character,
			quantity: group.quantity,
			unitSellCopper,
			totalSellCopper: unitSellCopper === null ? null : safeMultiply(unitSellCopper, group.quantity),
			name: cleanText(item?.name ?? (locale === 'es' ? `Objeto ${String(group.itemId)}` : `Item ${String(group.itemId)}`)),
			type: item?.type ? cleanText(item.type) : null,
			rarity: item?.rarity ? cleanText(item.rarity) : null,
			icon: item?.icon ?? null,
		};
	}));
	positions.sort(comparePositions);
	return {
		schemaVersion: INVENTORY_NOTE_SCHEMA_VERSION,
		capturedAt: snapshot.completedAt,
		locale,
		positions,
	};
}

/** Plans and applies only versioned Tyrian inventory notes below one portable Vault root. */
export class InventoryVaultSyncService {
	private flight: Promise<InventoryVaultSyncResult> | null = null;

	constructor(
		private readonly vault: InventoryVaultPort,
		private readonly configDir: string,
	) {}

	async preview(root: string, input: InventoryVaultSyncInput): Promise<InventoryVaultSyncPlan> {
		const normalizedRoot = normalizeInventoryRoot(root, this.configDir);
		if (normalizedRoot === null || !isInventoryVaultSyncInput(input)) throw new Error('invalid_inventory_sync_input');
		const folder = inventoryFolder(normalizedRoot);
		const desired = new Map<string, { position: InventoryVaultPosition; path: string; content: string }>();
		for (const position of input.positions) {
			if (position.positionId !== await positionId(position.itemId, position.source, position.character)) {
				throw new Error('invalid_inventory_sync_input');
			}
			const path = `${folder}/${position.positionId}.md`;
			const content = await renderInventoryNote(position, input.capturedAt, input.locale, true);
			desired.set(position.positionId, { position, path, content });
		}

		const steps: InventoryVaultSyncStep[] = [];
		const seenOwned = new Set<string>();
		for (const file of this.inventoryFiles(folder)) {
			const content = normalizeLf(await this.vault.read(file));
			const classified = await classifyInventoryNote(content);
			if (classified.status === 'foreign') {
				steps.push(step(file.path, file.path, 'conflict', content, null));
				continue;
			}
			if (classified.status === 'conflict') {
				steps.push(step(classified.positionId ?? file.path, file.path, 'conflict', content, null));
				continue;
			}
			const owned = classified.note;
			const expectedPath = `${folder}/${owned.fields.tc_position_id}.md`;
			if (file.path !== expectedPath || seenOwned.has(owned.fields.tc_position_id)) {
				steps.push(step(owned.fields.tc_position_id, file.path, 'conflict', content, null));
				continue;
			}
			seenOwned.add(owned.fields.tc_position_id);
			const target = desired.get(owned.fields.tc_position_id);
			if (target) {
				steps.push(step(target.position.positionId, file.path,
					content === target.content ? 'unchanged' : 'update', content, target.content));
				continue;
			}
			if (!owned.fields.tc_active && owned.fields.tc_quantity === 0) {
				steps.push(step(owned.fields.tc_position_id, file.path, 'unchanged', content, content));
				continue;
			}
			const inactive = await renderInventoryNote(positionFromFields(owned.fields), input.capturedAt, input.locale, false);
			steps.push(step(owned.fields.tc_position_id, file.path, 'deactivate', content, inactive));
		}

		for (const target of desired.values()) {
			if (seenOwned.has(target.position.positionId)) continue;
			const occupied = this.vault.file(target.path);
			if (occupied) {
				const content = normalizeLf(await this.vault.read(occupied));
				steps.push(step(target.position.positionId, target.path, 'conflict', content, null));
			} else {
				steps.push(step(target.position.positionId, target.path, 'create', null, target.content));
			}
		}
		steps.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
		return {
			schemaVersion: INVENTORY_NOTE_SCHEMA_VERSION,
			root: normalizedRoot,
			capturedAt: input.capturedAt,
			positions: input.positions.length,
			canApply: steps.every((entry) => entry.status !== 'conflict'),
			steps,
		};
	}

	apply(plan: InventoryVaultSyncPlan): Promise<InventoryVaultSyncResult> {
		if (this.flight) return this.flight;
		const flight = this.applyInternal(plan).finally(() => {
			if (this.flight === flight) this.flight = null;
		});
		this.flight = flight;
		return flight;
	}

	private async applyInternal(plan: InventoryVaultSyncPlan): Promise<InventoryVaultSyncResult> {
		if (!isInventoryVaultSyncPlan(plan, this.configDir) || !plan.canApply) {
			return { status: 'invalid', message: 'The inventory preview is invalid or blocked.' };
		}
		try {
			for (const entry of plan.steps) {
				const file = this.vault.file(entry.path);
				if (entry.before === null) {
					if (file !== null) return { status: 'conflict', message: 'An inventory note appeared after preview.' };
				} else {
					if (file === null || normalizeLf(await this.vault.read(file)) !== entry.before) {
						return { status: 'conflict', message: 'An inventory note changed after preview.' };
					}
				}
			}
			const writes = plan.steps.filter((entry) => entry.status !== 'unchanged');
			if (writes.length === 0) return { status: 'unchanged', created: 0, updated: 0, deactivated: 0 };
			await ensureFolders(this.vault, inventoryFolder(plan.root));
			let created = 0;
			let updated = 0;
			let deactivated = 0;
			for (const entry of writes) {
				if (entry.after === null) return { status: 'invalid', message: 'The inventory plan contains an empty write.' };
				if (entry.status === 'create') {
					try { await this.vault.create(entry.path, entry.after); }
					catch {
						const raced = this.vault.file(entry.path);
						if (!raced || normalizeLf(await this.vault.read(raced)) !== entry.after) {
							return { status: 'conflict', message: 'An inventory note occupied a planned path.' };
						}
					}
					created += 1;
					continue;
				}
				const file = this.vault.file(entry.path);
				if (!file || entry.before === null) return { status: 'conflict', message: 'An inventory note disappeared during apply.' };
				let applied = false;
				await this.vault.process(file, (current) => {
					if (normalizeLf(current) !== entry.before) return current;
					applied = true;
					return entry.after!;
				});
				const verified = this.vault.file(entry.path);
				if (!applied || !verified || normalizeLf(await this.vault.read(verified)) !== entry.after) {
					return { status: 'conflict', message: 'An inventory note changed during apply.' };
				}
				if (entry.status === 'deactivate') deactivated += 1;
				else updated += 1;
			}
			return { status: 'applied', created, updated, deactivated };
		} catch {
			return { status: 'unavailable', message: 'Inventory notes could not be written safely.' };
		}
	}

	private inventoryFiles(folder: string): InventoryVaultFile[] {
		const prefix = `${folder}/`;
		return this.vault.markdownFiles().filter((file) => file.path.startsWith(prefix) && file.path.endsWith('.md'))
			.sort((left, right) => left.path.localeCompare(right.path));
	}
}

function inventoryLocation(holding: ItemHolding): { source: InventoryPositionSource; character: string | null } | null {
	if (holding.location.source === 'character' && holding.location.container === 'bag') {
		return { source: 'character', character: holding.location.character.normalize('NFC') };
	}
	if (holding.location.source === 'shared_inventory' || holding.location.source === 'bank' || holding.location.source === 'materials') {
		return { source: holding.location.source, character: null };
	}
	return null;
}

async function positionId(itemId: number, source: InventoryPositionSource, character: string | null): Promise<string> {
	const suffix = character === null ? 'account' : (await sha256Text(character.normalize('NFC'))).slice(0, 24);
	return `${String(itemId)}-${SOURCE_CODES[source]}-${suffix}`;
}

function inventoryFolder(root: string): string { return `${root}/${INVENTORY_FOLDER}`; }

function normalizeInventoryRoot(value: unknown, configDir: string): string | null {
	return normalizeVaultRelativePath(value, { forbiddenPathPrefixes: [configDir], maxPathLength: 128 });
}

function assertCaptureRelations(
	snapshot: StorageSnapshot,
	catalog: CatalogResolution,
	prices: InventoryPriceSnapshotV1,
	locale: CatalogLocale,
): void {
	if ((locale !== 'es' && locale !== 'en') || catalog.locale !== locale || catalog.snapshotId !== snapshot.snapshotId ||
		catalog.schemaVersion !== snapshot.schemaVersion || prices.accountId !== snapshot.accountId ||
		prices.snapshotId !== snapshot.snapshotId || prices.schemaVersion !== snapshot.schemaVersion ||
		!Number.isFinite(Date.parse(snapshot.completedAt))) throw new Error('inventory_capture_identity_mismatch');
}

function inventorySnapshotComplete(snapshot: StorageSnapshot): boolean {
	return snapshot.quality === 'stable' &&
		(['characters', 'shared_inventory', 'bank', 'materials'] as const)
			.every((source) => snapshot.coverage.sources[source].status === 'complete') &&
		Object.values(snapshot.coverage.characters).every((coverage) => coverage.status === 'complete');
}

function comparePositions(left: InventoryVaultPosition, right: InventoryVaultPosition): number {
	return left.itemId - right.itemId || left.source.localeCompare(right.source) ||
		(left.character ?? '').localeCompare(right.character ?? '') || left.positionId.localeCompare(right.positionId);
}

function fieldsFor(
	position: InventoryVaultPosition,
	capturedAt: string,
	locale: CatalogLocale,
	active: boolean,
): InventoryNoteFields {
	const quantity = active ? position.quantity : 0;
	return {
		tc_schema: INVENTORY_NOTE_SCHEMA_VERSION,
		tc_kind: INVENTORY_NOTE_KIND,
		tc_marker: INVENTORY_NOTE_MARKER,
		tc_position_id: position.positionId,
		tc_item_id: position.itemId,
		tc_source: position.source,
		tc_character: position.character,
		tc_quantity: quantity,
		tc_unit_sell_copper: position.unitSellCopper,
		tc_total_sell_copper: position.unitSellCopper === null ? null : safeMultiply(position.unitSellCopper, quantity),
		tc_active: active,
		tc_captured_at: capturedAt,
		tc_item_name: position.name,
		tc_item_type: position.type,
		tc_item_rarity: position.rarity,
		tc_icon: position.icon,
		descripcion: locale === 'es' ? 'Existencia de inventario gestionada por Tyrian Companion.' : 'Inventory holding managed by Tyrian Companion.',
	};
}

async function renderInventoryNote(
	position: InventoryVaultPosition,
	capturedAt: string,
	locale: CatalogLocale,
	active: boolean,
): Promise<string> {
	const fields = fieldsFor(position, capturedAt, locale, active);
	const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd();
	const heading = cleanText(position.name).replace(/^[#]/u, '\\$&');
	const body = `# ${heading}\n\n${fields.descripcion}\n`;
	const markerBase = markerLine(position.positionId, null);
	const unsigned = `---\n${frontmatter}\n---\n${markerBase}\n${body}`;
	const hash = await sha256Text(unsigned);
	return `---\n${frontmatter}\n---\n${markerLine(position.positionId, hash)}\n${body}`;
}

function markerLine(position: string, hash: string | null): string {
	const base = `${MARKER_PREFIX} schema=${String(INVENTORY_NOTE_SCHEMA_VERSION)} marker=${INVENTORY_NOTE_MARKER} position=${position}`;
	return hash === null ? `${base} -->` : `${base} hash=${hash} -->`;
}

async function classifyInventoryNote(content: string): Promise<
	| { status: 'owned'; note: OwnedInventoryNote }
	| { status: 'foreign' }
	| { status: 'conflict'; positionId: string | null }
> {
	const marker = content.match(/<!-- tyrian-companion-inventory schema=(\d+) marker=([^\s]+) position=([^\s]+)(?: hash=([a-f0-9]{64}))? -->/u);
	if (!marker) return content.includes(MARKER_PREFIX) ? { status: 'conflict', positionId: null } : { status: 'foreign' };
	const positionId = marker[3] ?? null;
	if (marker[1] !== String(INVENTORY_NOTE_SCHEMA_VERSION) || marker[2] !== INVENTORY_NOTE_MARKER || !positionId || !marker[4]) {
		return { status: 'conflict', positionId };
	}
	const markerWithHash = marker[0];
	const unsigned = content.replace(markerWithHash, markerLine(positionId, null));
	if (await sha256Text(unsigned) !== marker[4]) return { status: 'conflict', positionId };
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!frontmatter) return { status: 'conflict', positionId };
	let parsed: unknown;
	try { parsed = parseYaml(frontmatter[1]!); }
	catch { return { status: 'conflict', positionId }; }
	if (!isInventoryNoteFields(parsed) || parsed.tc_position_id !== positionId) return { status: 'conflict', positionId };
	return { status: 'owned', note: { fields: parsed, content } };
}

function positionFromFields(fields: InventoryNoteFields): InventoryVaultPosition {
	return {
		positionId: fields.tc_position_id,
		itemId: fields.tc_item_id,
		source: fields.tc_source,
		character: fields.tc_character,
		quantity: fields.tc_quantity,
		unitSellCopper: fields.tc_unit_sell_copper,
		totalSellCopper: fields.tc_total_sell_copper,
		name: fields.tc_item_name,
		type: fields.tc_item_type,
		rarity: fields.tc_item_rarity,
		icon: fields.tc_icon,
	};
}

function step(
	positionId: string,
	path: string,
	status: InventoryVaultSyncStepStatus,
	before: string | null,
	after: string | null,
): InventoryVaultSyncStep {
	return { positionId, path, status, before, after };
}

function isInventoryVaultSyncInput(value: unknown): value is InventoryVaultSyncInput {
	if (!record(value) || value.schemaVersion !== INVENTORY_NOTE_SCHEMA_VERSION ||
		(value.locale !== 'es' && value.locale !== 'en') || !iso(value.capturedAt) || !Array.isArray(value.positions)) return false;
	return value.positions.every(isInventoryPosition) && new Set(value.positions.map((entry) => entry.positionId)).size === value.positions.length;
}

function isInventoryPosition(value: unknown): value is InventoryVaultPosition {
	return record(value) && typeof value.positionId === 'string' && /^[1-9]\d*-[csbm]-(?:account|[a-f0-9]{24})$/u.test(value.positionId) &&
		positive(value.itemId) && inventorySource(value.source) && (value.character === null || nonEmptyText(value.character)) &&
		(value.source === 'character' ? value.character !== null : value.character === null) && positive(value.quantity) &&
		nullableNonNegative(value.unitSellCopper) && nullableNonNegative(value.totalSellCopper) && nonEmptyText(value.name) &&
		(value.type === null || nonEmptyText(value.type)) && (value.rarity === null || nonEmptyText(value.rarity)) &&
		(value.icon === null || nonEmptyText(value.icon)) &&
		(value.unitSellCopper === null ? value.totalSellCopper === null : value.totalSellCopper === safeMultiply(value.unitSellCopper, value.quantity));
}

function isInventoryNoteFields(value: unknown): value is InventoryNoteFields {
	if (!record(value) || !exactKeys(value, [
		'tc_schema', 'tc_kind', 'tc_marker', 'tc_position_id',
		'tc_item_id', 'tc_source', 'tc_character', 'tc_quantity',
		'tc_unit_sell_copper', 'tc_total_sell_copper', 'tc_active',
		'tc_captured_at', 'tc_item_name', 'tc_item_type',
		'tc_item_rarity', 'tc_icon', 'descripcion',
	])) return false;
	return value.tc_schema === INVENTORY_NOTE_SCHEMA_VERSION && value.tc_kind === INVENTORY_NOTE_KIND &&
		value.tc_marker === INVENTORY_NOTE_MARKER && typeof value.tc_position_id === 'string' &&
		positive(value.tc_item_id) && inventorySource(value.tc_source) &&
		(value.tc_character === null || nonEmptyText(value.tc_character)) &&
		(value.tc_source === 'character' ? value.tc_character !== null : value.tc_character === null) &&
		nonNegative(value.tc_quantity) && nullableNonNegative(value.tc_unit_sell_copper) &&
		nullableNonNegative(value.tc_total_sell_copper) && typeof value.tc_active === 'boolean' &&
		value.tc_active === (value.tc_quantity > 0) && iso(value.tc_captured_at) &&
		nonEmptyText(value.tc_item_name) && (value.tc_item_type === null || nonEmptyText(value.tc_item_type)) &&
		(value.tc_item_rarity === null || nonEmptyText(value.tc_item_rarity)) &&
		(value.tc_icon === null || nonEmptyText(value.tc_icon)) && nonEmptyText(value.descripcion);
}

function isInventoryVaultSyncPlan(value: unknown, configDir: string): value is InventoryVaultSyncPlan {
	return record(value) && value.schemaVersion === INVENTORY_NOTE_SCHEMA_VERSION && normalizeInventoryRoot(value.root, configDir) === value.root &&
		iso(value.capturedAt) && nonNegative(value.positions) && typeof value.canApply === 'boolean' && value.canApply && Array.isArray(value.steps) &&
		value.steps.every((entry) => record(entry) && exactKeys(entry, ['positionId', 'path', 'status', 'before', 'after']) &&
			typeof entry.positionId === 'string' && typeof entry.path === 'string' && normalizeVaultRelativePath(entry.path, { forbiddenPathPrefixes: [configDir] }) === entry.path &&
			['create', 'update', 'unchanged', 'deactivate'].includes(String(entry.status)) &&
			(entry.before === null || typeof entry.before === 'string') && (entry.after === null || typeof entry.after === 'string'));
}

async function ensureFolders(vault: InventoryVaultPort, path: string): Promise<void> {
	const segments = path.split('/');
	for (let index = 1; index <= segments.length; index += 1) {
		const folder = segments.slice(0, index).join('/');
		if (vault.file(folder)) continue;
		try { await vault.createFolder(folder); }
		catch { if (!vault.file(folder)) throw new Error('inventory_folder_unavailable'); }
	}
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) throw new Error('inventory_quantity_overflow');
	return result;
}

function safeMultiply(left: number, right: number): number {
	const result = left * right;
	if (!Number.isSafeInteger(result) || result < 0) throw new Error('inventory_value_overflow');
	return result;
}

function cleanText(value: string): string {
	return value.normalize('NFC').replace(/[\p{Cc}\p{Cs}]+/gu, ' ').trim().slice(0, 256) || 'Unknown item';
}

function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, '\n'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { const expected = new Set(keys); return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key)); }
function inventorySource(value: unknown): value is InventoryPositionSource { return ['character', 'shared_inventory', 'bank', 'materials'].includes(String(value)); }
function nonEmptyText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.normalize('NFC'); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function nullableNonNegative(value: unknown): value is number | null { return value === null || nonNegative(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
