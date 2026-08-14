import { HttpTransportError } from '../core/http';
import { createLimiter } from '../core/concurrency';
import type { GuildWars2Client, GuildWars2Operation } from './guild-wars-2-client';
import { parseAccountProfile, parseTokenInfo } from './account-service';
import {
	PINNED_SCHEMA,
	SnapshotCapabilityError,
	type SnapshotCoverage,
	type SourceCoverage,
	type StorageSnapshot,
	type StorageSnapshotPass,
} from './storage-snapshot-model';
import {
	buildStorageSnapshotPass,
	canonicalSnapshotValue,
	finalizeStorageSnapshot,
	qualifyStorageSnapshotPair,
	qualifyStorageSnapshotTriple,
} from './storage-snapshot-pure';
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
		return this.captureWithOperation(operation);
	}

	/** Reuses an already pinned credential for a larger atomic workflow. */
	async captureWithOperation(operation: GuildWars2Operation): Promise<StorageSnapshot> {
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
		const pair = qualifyStorageSnapshotPair(first, second);
		if (pair.status === 'qualified') {
			return finalizeStorageSnapshot(pair.value, {
				accountId: context.accountId,
				snapshotId,
				startedAt,
				completedAt: new Date().toISOString(),
			});
		}

		const third = await this.capturePass(operation, context);
		return finalizeStorageSnapshot(qualifyStorageSnapshotTriple(first, second, third), {
			accountId: context.accountId,
			snapshotId,
			startedAt,
			completedAt: new Date().toISOString(),
		});
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

		return buildStorageSnapshotPass(holdings, currencies, coverage, roster);
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
		key: canonicalSnapshotValue({
			tokenId: tokenInfo.id,
			accountId: account.id,
			permissions: [...permissions],
			urls,
		}),
	};
}

function allowsEndpoint(urls: readonly string[], endpoint: string): boolean {
	return urls.some((url) => {
		const normalized = url.replace(/\/$/u, '');
		return normalized === endpoint;
	});
}
