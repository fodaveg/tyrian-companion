import { HttpTransportError } from '../core/http';
import { createLimiter } from '../core/concurrency';
import type { GuildWars2Client, GuildWars2Operation } from './guild-wars-2-client';
import { parseAccountProfile, parseTokenInfo } from './account-service';
import {
	PINNED_SCHEMA,
	SnapshotCapabilityError,
	type CurrencyTotal,
	type SnapshotCoverage,
	type SnapshotQuality,
	type SourceCoverage,
	type StorageSnapshot,
	type StorageSnapshotPass,
} from './storage-snapshot-model';
import {
	parseCharacterInventory,
	parseDelivery,
	parseMaterials,
	parseRoster,
	parseSlotArray,
	parseWallet,
} from './storage-snapshot-parsers';

interface VerifiedSnapshotContext {
	accountId: string;
	permissions: ReadonlySet<string>;
	urls: readonly string[];
	key: string;
}

const REQUIRED_SCOPES = ['account', 'characters', 'inventories'] as const;

/** Captures a consistency-qualified storage snapshot without writing or valuing assets. */
export class StorageSnapshotService {
	private readonly inFlight = new Map<string, Promise<StorageSnapshot>>();
	private readonly globalLimit = createLimiter(6);
	private readonly characterLimit = createLimiter(4);

	constructor(private readonly client: Pick<GuildWars2Client, 'beginOperation'>) {}

	async capture(): Promise<StorageSnapshot> {
		const operation = this.client.beginOperation();
		const context = await verifySnapshotContext(operation, this.globalLimit);
		const existing = this.inFlight.get(context.key);
		if (existing) return existing;
		const promise = this.captureInternal(operation, context).finally(() => {
			if (this.inFlight.get(context.key) === promise) this.inFlight.delete(context.key);
		});
		this.inFlight.set(context.key, promise);
		return promise;
	}

	private async captureInternal(
		operation: GuildWars2Operation,
		context: VerifiedSnapshotContext,
	): Promise<StorageSnapshot> {
		const startedAt = new Date().toISOString();
		const snapshotId = crypto.randomUUID();
		const first = await this.capturePass(operation, context);
		const second = await this.capturePass(operation, context);
		if (sameOwnership(first, second)) {
			return finalize(
				second,
				classifyConsecutive(first, second),
				[first, second],
				context,
				snapshotId,
				startedAt,
			);
		}

		const third = await this.capturePass(operation, context);
		return finalize(
			third,
			isPartial(first.coverage) || isPartial(second.coverage) || isPartial(third.coverage)
				? 'partial'
				: sameOwnership(second, third)
					? classifyConsecutive(second, third)
					: 'unstable',
			[first, second, third],
			context,
			snapshotId,
			startedAt,
		);
	}

	private async capturePass(
		operation: GuildWars2Operation,
		context: VerifiedSnapshotContext,
	): Promise<StorageSnapshotPass> {
		const coverage = emptyCoverage(context.permissions, context.urls);
		const holdings: StorageSnapshotPass['holdings'] = [];
		const currencies: StorageSnapshotPass['currencies'] = [];

		const rosterResult = await captureSource(
			() => this.globalLimit(() => operation.requestDetailed(withSchema('characters'))),
			parseRoster,
			false,
		);
		coverage.sources.characters = rosterResult.coverage;
		const roster = rosterResult.value ?? [];
		if (context.urls.length > 0) {
			const unavailable = roster
				.map((character) => `/v2/characters/${encodeURIComponent(character)}/inventory`)
				.filter((endpoint) => !allowsEndpoint(context.urls, endpoint));
			if (unavailable.length > 0) throw new SnapshotCapabilityError(unavailable.map((url) => `url:${url}`));
		}

		const accountTasks = [
			this.captureItems(
				operation,
				this.globalLimit,
				coverage,
				holdings,
				'shared_inventory',
				'account/inventory',
				(value) => parseSlotArray(value, 'shared_inventory'),
			),
			this.captureItems(
				operation,
				this.globalLimit,
				coverage,
				holdings,
				'bank',
				'account/bank',
				(value) => parseSlotArray(value, 'bank'),
			),
			this.captureItems(
				operation,
				this.globalLimit,
				coverage,
				holdings,
				'materials',
				'account/materials',
				parseMaterials,
			),
		];

		const optionalTasks: Array<Promise<void>> = [];
		if (coverage.sources.wallet.status === 'complete') {
			optionalTasks.push(
				this.captureCurrencies(operation, this.globalLimit, coverage, currencies, 'wallet', 'account/wallet'),
			);
		}
		if (coverage.sources.commerce_delivery.status === 'complete') {
			optionalTasks.push(
				this.captureDelivery(operation, this.globalLimit, coverage, holdings, currencies),
			);
		}

		const characterTasks = roster.map((character) =>
			this.characterLimit(() =>
				this.globalLimit(async () => {
					const result = await captureSource(
						() => operation.requestDetailed(withSchema(`characters/${encodeURIComponent(character)}/inventory`)),
						(value) => parseCharacterInventory(value, character),
						true,
					);
					coverage.characters[character] = result.coverage;
					if (result.value) holdings.push(...result.value);
				}),
			),
		);

		const tasks = [...accountTasks, ...optionalTasks, ...characterTasks];
		const settled = await Promise.allSettled(tasks);
		const rejected = settled.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (rejected) throw rejected.reason;
		const characterFailure = Object.values(coverage.characters).find(
			(entry) => entry.status === 'partial',
		);
		if (characterFailure) {
			coverage.sources.characters = { ...characterFailure };
		}

		return buildPass(holdings, currencies, coverage, roster);
	}

	private async captureItems(
		operation: GuildWars2Operation,
		limit: ReturnType<typeof createLimiter>,
		coverage: SnapshotCoverage,
		holdings: StorageSnapshotPass['holdings'],
		source: 'shared_inventory' | 'bank' | 'materials',
		path: string,
		parser: (value: unknown) => StorageSnapshotPass['holdings'],
	): Promise<void> {
		const result = await captureSource(
			() => limit(() => operation.requestDetailed(withSchema(path))),
			parser,
			false,
		);
		coverage.sources[source] = result.coverage;
		if (result.value) holdings.push(...result.value);
	}

	private async captureCurrencies(
		operation: GuildWars2Operation,
		limit: ReturnType<typeof createLimiter>,
		coverage: SnapshotCoverage,
		currencies: StorageSnapshotPass['currencies'],
		source: 'wallet',
		path: string,
	): Promise<void> {
		const result = await captureSource(
			() => limit(() => operation.requestDetailed(withSchema(path))),
			parseWallet,
			false,
		);
		coverage.sources[source] = result.coverage;
		if (result.value) currencies.push(...result.value);
	}

	private async captureDelivery(
		operation: GuildWars2Operation,
		limit: ReturnType<typeof createLimiter>,
		coverage: SnapshotCoverage,
		holdings: StorageSnapshotPass['holdings'],
		currencies: StorageSnapshotPass['currencies'],
	): Promise<void> {
		const result = await captureSource(
			() => limit(() => operation.requestDetailed(withSchema('commerce/delivery'))),
			parseDelivery,
			false,
		);
		coverage.sources.commerce_delivery = result.coverage;
		if (result.value) {
			holdings.push(...result.value.holdings);
			currencies.push(...result.value.currencies);
		}
	}
}

function withSchema(path: string): string {
	return `${path}?v=${encodeURIComponent(PINNED_SCHEMA)}`;
}

async function captureSource<T>(
	request: () => Promise<{ status: number; body: unknown }>,
	parse: (value: unknown) => T,
	isCharacter: boolean,
): Promise<{ value: T | null; coverage: SourceCoverage }> {
	try {
		const response = await request();
		const value = parse(response.body);
		return {
			value,
			coverage:
				response.status === 206
					? { status: 'partial', reason: 'partial_response' }
					: { status: 'complete' },
		};
	} catch (error) {
		if (!(error instanceof HttpTransportError)) throw error;
		if (error.status === 401 || error.status === 403) throw error;
		return {
			value: null,
			coverage: {
				status: 'partial',
				reason: isCharacter && error.status === 404 ? 'missing_character' : 'unavailable',
			},
		};
	}
}

function emptyCoverage(
	permissions: ReadonlySet<string>,
	urls: readonly string[],
): SnapshotCoverage {
	const complete = (): SourceCoverage => ({ status: 'complete' });
	const source = (scope: string, endpoint: string, required: boolean): SourceCoverage => {
		if (!permissions.has(scope)) return { status: 'skipped', reason: 'missing_scope' };
		if (urls.length > 0 && !allowsEndpoint(urls, endpoint)) {
			if (required) throw new SnapshotCapabilityError([`url:${endpoint}`]);
			return { status: 'skipped', reason: 'url_restricted' };
		}
		return complete();
	};
	return {
		sources: {
			characters: complete(),
			shared_inventory: source('inventories', '/v2/account/inventory', true),
			bank: source('inventories', '/v2/account/bank', true),
			materials: source('inventories', '/v2/account/materials', true),
			wallet: source('wallet', '/v2/account/wallet', false),
			commerce_delivery: source('tradingpost', '/v2/commerce/delivery', false),
		},
		characters: {},
	};
}

function buildPass(
	holdings: StorageSnapshotPass['holdings'],
	currencies: StorageSnapshotPass['currencies'],
	coverage: SnapshotCoverage,
	roster: string[],
): StorageSnapshotPass {
	const availableByItem: Record<string, number> = {};
	const ownedByItem: Record<string, number> = {};
	const currencyById: Record<string, CurrencyTotal> = {};
	for (const holding of holdings) {
		add(ownedByItem, holding.itemId, holding.quantity);
		if (holding.state === 'loose' || holding.state === 'pending_claim') {
			add(availableByItem, holding.itemId, holding.quantity);
		}
	}
	for (const currency of currencies) {
		const key = String(currency.currencyId);
		const total = (currencyById[key] ??= { total: 0, wallet: 0, delivery: 0 });
		total.total += currency.quantity;
		total[currency.namespace] += currency.quantity;
	}
	return {
		holdings,
		currencies,
		availableByItem,
		ownedByItem,
		currencyById,
		coverage,
		roster: [...roster].sort(),
	};
}

function add(target: Record<string, number>, key: string | number, quantity: number): void {
	const normalized = String(key);
	target[normalized] = (target[normalized] ?? 0) + quantity;
}

function sameOwnership(left: StorageSnapshotPass, right: StorageSnapshotPass): boolean {
	return (
		canonical(left.ownedByItem) === canonical(right.ownedByItem) &&
		canonical(currencyOwnership(left)) === canonical(currencyOwnership(right)) &&
		canonical(left.roster) === canonical(right.roster)
	);
}

function classifyConsecutive(
	left: StorageSnapshotPass,
	right: StorageSnapshotPass,
): SnapshotQuality {
	if (isPartial(left.coverage) || isPartial(right.coverage)) return 'partial';
	return placementFingerprint(left) === placementFingerprint(right)
		? 'stable'
		: 'stable_owned_placement_changed';
}

function placementFingerprint(pass: StorageSnapshotPass): string {
	return canonical({ holdings: pass.holdings, currencies: pass.currencies, roster: pass.roster });
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function isPartial(coverage: SnapshotCoverage): boolean {
	return [...Object.values(coverage.sources), ...Object.values(coverage.characters)].some(
		(entry) => entry.status === 'partial',
	);
}

function finalize(
	pass: StorageSnapshotPass,
	quality: SnapshotQuality,
	allPasses:
		| [StorageSnapshotPass, StorageSnapshotPass]
		| [StorageSnapshotPass, StorageSnapshotPass, StorageSnapshotPass],
	context: VerifiedSnapshotContext,
	snapshotId: string,
	startedAt: string,
): StorageSnapshot {
	return {
		...pass,
		coverage: mergeCoverages(allPasses.map((entry) => entry.coverage)),
		snapshotId,
		accountId: context.accountId,
		startedAt,
		completedAt: new Date().toISOString(),
		passCoverages: allPasses.map((entry) => entry.coverage),
		quality,
		passes: allPasses.length,
		schemaVersion: PINNED_SCHEMA,
	};
}

async function verifySnapshotContext(
	operation: GuildWars2Operation,
	limit: ReturnType<typeof createLimiter>,
): Promise<VerifiedSnapshotContext> {
	const tokenInfo = parseTokenInfo(
		await limit(() => operation.request('tokeninfo', new Set([401, 403]))),
	);
	const permissions = new Set(tokenInfo.permissions);
	const missing = REQUIRED_SCOPES.filter((scope) => !permissions.has(scope));
	if (missing.length > 0) throw new SnapshotCapabilityError(missing);
	if (tokenInfo.expiresAt && Date.parse(tokenInfo.expiresAt) <= Date.now()) {
		throw new SnapshotCapabilityError(['key_expired']);
	}
	const urls = [...(tokenInfo.urls ?? [])].sort();
	if (urls.length > 0 && !allowsEndpoint(urls, '/v2/account')) {
		throw new SnapshotCapabilityError(['url:/v2/account']);
	}
	if (urls.length > 0 && !allowsEndpoint(urls, '/v2/characters')) {
		throw new SnapshotCapabilityError(['url:/v2/characters']);
	}
	const account = parseAccountProfile(
		await limit(() => operation.request('account', new Set([401]))),
	);
	return {
		accountId: account.id,
		permissions,
		urls,
		key: canonical({
			tokenId: tokenInfo.id,
			accountId: account.id,
			permissions: [...permissions],
			urls,
		}),
	};
}

function currencyOwnership(pass: StorageSnapshotPass): Record<string, number> {
	return Object.fromEntries(
		Object.entries(pass.currencyById).map(([currencyId, value]) => [currencyId, value.total]),
	);
}

function mergeCoverages(coverages: SnapshotCoverage[]): SnapshotCoverage {
	const merged: SnapshotCoverage = { sources: { ...coverages[0]!.sources }, characters: {} };
	for (const coverage of coverages) {
		for (const [source, entry] of Object.entries(coverage.sources)) {
			if (entry.status === 'partial') {
				merged.sources[source as keyof SnapshotCoverage['sources']] = { ...entry };
			}
		}
		for (const [character, entry] of Object.entries(coverage.characters)) {
			const current = merged.characters[character];
			if (!current || entry.status === 'partial') merged.characters[character] = { ...entry };
		}
	}
	return merged;
}

function allowsEndpoint(urls: readonly string[], endpoint: string): boolean {
	return urls.some((url) => {
		const normalized = url.replace(/\/$/u, '');
		return normalized === endpoint;
	});
}
