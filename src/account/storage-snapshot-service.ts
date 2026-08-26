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

export type StorageSnapshotCaptureScope = 'complete' | 'inventory_advisor';

/**
 * A real, request-counted snapshot of one capture pass in progress. Every `total` is
 * either a fixed constant (`roster`) or known the moment the roster response lands
 * (`accountStores` from the pinned token's own permissions, `characters` from the
 * roster length itself) — never an estimate. Optional end to end: only the inventory
 * advisor's one-click sync observes it today.
 */
export interface StorageSnapshotCaptureProgress {
	readonly roster: { readonly completed: number; readonly total: number };
	readonly accountStores: { readonly completed: number; readonly total: number };
	readonly characters: { readonly completed: number; readonly total: number };
}

const REQUIRED_SCOPES = ['account', 'characters', 'inventories'] as const;

/** Captures a consistency-qualified storage snapshot without writing or valuing assets. */
export class StorageSnapshotService {
	private readonly inFlight = new Map<string, Promise<StorageSnapshot>>();
	private readonly globalLimit = createLimiter(6);
	private readonly characterLimit = createLimiter(4);
	private readonly inventoryAdvisorCharacterLimit = createLimiter(1);

	constructor(private readonly client: Pick<GuildWars2Client, 'beginOperation'>) {}

	async capture(): Promise<StorageSnapshot> {
		const operation = this.client.beginOperation();
		return this.captureWithOperation(operation);
	}

	/** Reuses an already pinned credential for a larger atomic workflow. */
	async captureWithOperation(operation: GuildWars2Operation): Promise<StorageSnapshot> {
		return this.captureScopedWithOperation(operation, 'complete');
	}

	/**
	 * Captures only character bags and shared inventory for the Inventory Advisor.
	 * `onProgress` is optional and observed only by callers that want a live status
	 * (today, the one-click sync); it never changes what is captured.
	 */
	async captureInventoryWithOperation(
		operation: GuildWars2Operation,
		onProgress?: (progress: StorageSnapshotCaptureProgress) => void,
	): Promise<StorageSnapshot> {
		return this.captureScopedWithOperation(operation, 'inventory_advisor', onProgress);
	}

	private async captureScopedWithOperation(
		operation: GuildWars2Operation,
		scope: StorageSnapshotCaptureScope,
		onProgress?: (progress: StorageSnapshotCaptureProgress) => void,
	): Promise<StorageSnapshot> {
		const context = await verifySnapshotContext(operation, this.globalLimit);
		const key = `${context.key}:${scope}`;
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = this.captureInternal(operation, context, scope, onProgress).finally(() => {
			if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}

	private async captureInternal(
		operation: GuildWars2Operation,
		context: VerifiedSnapshotContext,
		scope: StorageSnapshotCaptureScope,
		onProgress?: (progress: StorageSnapshotCaptureProgress) => void,
	): Promise<StorageSnapshot> {
		const startedAt = new Date().toISOString();
		const snapshotId = crypto.randomUUID();
		const first = await this.capturePass(operation, context, scope, onProgress);
		if (scope === 'inventory_advisor') {
			return finalizeStorageSnapshot({
				pass: first,
				quality: advisorPassComplete(first.coverage) ? 'unstable' : 'partial',
				coveragePasses: [first],
				passes: [first],
			}, {
				accountId: context.accountId,
				snapshotId,
				startedAt,
				completedAt: new Date().toISOString(),
			});
		}
		const second = await this.capturePass(operation, context, scope);
		const pair = qualifyStorageSnapshotPair(first, second);
		if (pair.status === 'qualified') {
			return finalizeStorageSnapshot(pair.value, {
				accountId: context.accountId,
				snapshotId,
				startedAt,
				completedAt: new Date().toISOString(),
			});
		}

		const third = await this.capturePass(operation, context, scope);
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
		scope: StorageSnapshotCaptureScope,
		onProgress?: (progress: StorageSnapshotCaptureProgress) => void,
	): Promise<StorageSnapshotPass> {
		const coverage = emptyCoverage(context.permissions, context.urls, scope);
		const holdings: StorageSnapshotPass['holdings'] = [];
		const currencies: StorageSnapshotPass['currencies'] = [];
		// Every store this token can even reach is already known from its permissions
		// and URL restrictions above; only the character count still needs the roster.
		const accountStoresTotal = 1
			+ (coverage.sources.bank.status === 'complete' ? 1 : 0)
			+ (coverage.sources.materials.status === 'complete' ? 1 : 0)
			+ (scope === 'complete' && coverage.sources.wallet.status === 'complete' ? 1 : 0)
			+ (coverage.sources.commerce_delivery.status === 'complete' ? 1 : 0);
		let accountStoresCompleted = 0;
		let charactersCompleted = 0;

		const rosterResult = await captureSource(
			() => this.globalLimit(() => operation.requestDetailed(withSchema('characters'))),
			parseRoster,
			false,
			true,
		);
		coverage.sources.characters = rosterResult.coverage;
		const roster = rosterResult.value ?? [];
		if (context.urls.length > 0) {
			const unavailable = roster
				.map((character) => `/v2/characters/${encodeURIComponent(character)}/inventory`)
				.filter((endpoint) => !allowsEndpoint(context.urls, endpoint));
			if (unavailable.length > 0) throw new SnapshotCapabilityError(unavailable.map((url) => `url:${url}`));
		}

		// The roster response is the first moment every total in this pass is known
		// (the character count included), so it is also the first progress tick.
		const charactersTotal = roster.length;
		const reportProgress = (): void => onProgress?.({
			roster: { completed: 1, total: 1 },
			accountStores: { completed: accountStoresCompleted, total: accountStoresTotal },
			characters: { completed: charactersCompleted, total: charactersTotal },
		});
		reportProgress();
		const reportAccountStore = (): void => { accountStoresCompleted += 1; reportProgress(); };
		const reportCharacter = (): void => { charactersCompleted += 1; reportProgress(); };

		const accountTasks: Array<Promise<void>> = [
			this.captureItems(
				operation,
				this.globalLimit,
				coverage,
				holdings,
				'shared_inventory',
				'account/inventory',
				(value) => parseSlotArray(value, 'shared_inventory'),
				true,
			).finally(reportAccountStore),
		];
		if (coverage.sources.bank.status === 'complete') accountTasks.push(
			this.captureItems(
				operation,
				this.globalLimit,
				coverage,
				holdings,
				'bank',
				'account/bank',
				(value) => parseSlotArray(value, 'bank'),
				scope === 'complete',
			).finally(reportAccountStore),
		);
		if (coverage.sources.materials.status === 'complete') accountTasks.push(
			this.captureItems(
				operation,
				this.globalLimit,
				coverage,
				holdings,
				'materials',
				'account/materials',
				parseMaterials,
				scope === 'complete',
			).finally(reportAccountStore),
		);

		const optionalTasks: Array<Promise<void>> = [];
		if (scope === 'complete' && coverage.sources.wallet.status === 'complete') {
			optionalTasks.push(
				this.captureCurrencies(operation, this.globalLimit, coverage, currencies, 'wallet', 'account/wallet').finally(reportAccountStore),
			);
		}
		if (coverage.sources.commerce_delivery.status === 'complete') {
			optionalTasks.push(
				this.captureDelivery(operation, this.globalLimit, coverage, holdings, currencies).finally(reportAccountStore),
			);
		}

		const characterLimit = scope === 'inventory_advisor'
			? this.inventoryAdvisorCharacterLimit
			: this.characterLimit;
		const characterTasks = roster.map((character) =>
			characterLimit(() =>
				this.globalLimit(async () => {
					const result = await captureSource(
						() => operation.requestDetailed(withSchema(`characters/${encodeURIComponent(character)}/inventory`)),
						(value) => parseCharacterInventory(value, character),
						true,
						true,
					);
					coverage.characters[character] = result.coverage;
					if (result.value) holdings.push(...result.value);
				}),
			).finally(reportCharacter),
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
		forbiddenIsFatal: boolean,
	): Promise<void> {
		const result = await captureSource(
			() => limit(() => operation.requestDetailed(withSchema(path))),
			parser,
			false,
			forbiddenIsFatal,
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
			true,
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
			false,
		);
		coverage.sources.commerce_delivery = result.coverage;
		if (result.value) {
			holdings.push(...result.value.holdings);
			currencies.push(...result.value.currencies);
		}
	}
}

function advisorPassComplete(coverage: SnapshotCoverage): boolean {
	return coverage.sources.characters.status === 'complete'
		&& coverage.sources.shared_inventory.status === 'complete'
		&& Object.values(coverage.characters).every((entry) => entry.status === 'complete');
}

function withSchema(path: string): string {
	return `${path}?v=${encodeURIComponent(PINNED_SCHEMA)}`;
}

async function captureSource<T>(
	request: () => Promise<{ status: number; body: unknown }>,
	parse: (value: unknown) => T,
	isCharacter: boolean,
	forbiddenIsFatal: boolean,
): Promise<{ value: T | null; coverage: SourceCoverage }> {
	try {
		const response = await request();
		const value = parse(response.body);
		return {
			value,
			coverage:
				response.status === 206
					? {
						status: 'partial',
						reason: 'partial_response',
						diagnostic: { kind: 'http', status: 206, retryAfterMs: null },
					}
					: { status: 'complete' },
		};
	} catch (error) {
		if (!(error instanceof HttpTransportError)) throw error;
		// A 401 invalidates the pinned credential for the whole capture. A 403 is
		// fatal only for required sources; optional stores retain the core snapshot
		// and expose their own redacted partial coverage instead.
		if (error.status === 401 || (error.status === 403 && forbiddenIsFatal)) throw error;
		return {
			value: null,
			coverage: {
				status: 'partial',
				reason: isCharacter && error.status === 404 ? 'missing_character' : 'unavailable',
				diagnostic: {
					kind: error.kind,
					status: error.status,
					retryAfterMs: error.retryAfterMs,
				},
			},
		};
	}
}

function emptyCoverage(
	permissions: ReadonlySet<string>,
	urls: readonly string[],
	scope: StorageSnapshotCaptureScope,
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
			// The advisor reads the optional stores too, but never as a requirement: a missing
			// scope, a restricted URL or a failure degrades only its own coverage.
			bank: source('inventories', '/v2/account/bank', scope === 'complete'),
			materials: source('inventories', '/v2/account/materials', scope === 'complete'),
			wallet: scope === 'complete' ? source('wallet', '/v2/account/wallet', false) : { status: 'skipped', reason: 'not_requested' },
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

export function allowsEndpoint(urls: readonly string[], endpoint: string): boolean {
	return urls.some((url) => {
		const normalized = url.replace(/\/$/u, '');
		return normalized === endpoint;
	});
}
