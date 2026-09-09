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
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';

interface VerifiedSnapshotContext {
	accountId: string;
	permissions: ReadonlySet<string>;
	urls: readonly string[];
	key: string;
}

export type StorageSnapshotCaptureScope = 'complete' | 'inventory_advisor';

/**
 * Real request counts for a capture in progress. Every `total` is either fixed
 * (`roster`) or known when its pass roster lands (`accountStores` from the pinned
 * token's permissions, `characters` from the roster length itself) — never an
 * estimate. The Inventory Advisor totals include both required observations.
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

	async capture(actionContext?: ResolvedLocalDebugActionContext): Promise<StorageSnapshot> {
		const operation = this.client.beginOperation(actionContext);
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
		const advisorProgress = scope === 'inventory_advisor' && onProgress !== undefined
			? createAdvisorProgressReporter(onProgress)
			: null;
		const sharedInventoryLastModified: { value: string | null } = { value: null };
		const first = await this.capturePass(operation, context, scope,
			advisorProgress?.first ?? onProgress,
			scope === 'complete' ? (value) => { sharedInventoryLastModified.value = value; } : undefined);
		if (scope === 'inventory_advisor') {
			if (!advisorPassComplete(first.coverage) || hasIncompleteCoverage(first.coverage)) {
				if (shouldRetryAdvisorPass(first.coverage)) {
					const second = await this.capturePass(operation, context, scope,
						advisorProgress?.second);
					const secondCoreComplete = advisorPassComplete(second.coverage);
					return finalizeStorageSnapshot({
						pass: second,
						// Only one complete observation exists, so a recovered refresh can
						// support manual routes but never a curated recommendation.
						quality: secondCoreComplete ? 'unstable' : 'partial',
						coveragePasses: secondCoreComplete ? [second] : [first, second],
						passes: [first, second],
					}, {
						accountId: context.accountId,
						snapshotId,
						startedAt,
						completedAt: new Date().toISOString(),
					});
				}
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
			const second = await this.capturePass(operation, context, scope,
				advisorProgress?.second);
			if (!advisorPassComplete(second.coverage) || hasIncompleteCoverage(second.coverage)) {
				return finalizeStorageSnapshot({
					pass: second,
					quality: advisorPassComplete(second.coverage) ? 'unstable' : 'partial',
					coveragePasses: [first, second],
					passes: [first, second],
				}, {
					accountId: context.accountId,
					snapshotId,
					startedAt,
					completedAt: new Date().toISOString(),
				});
			}
			const pair = qualifyStorageSnapshotPair(first, second);
			if (pair.status === 'qualified') {
				return finalizeStorageSnapshot(pair.value, {
					accountId: context.accountId,
					snapshotId,
					startedAt,
					completedAt: new Date().toISOString(),
				});
			}
			// Unlike a session boundary, one explicit Advisor refresh is capped at two
			// observations. A disagreement remains useful for manual inspection but can
			// never be upgraded into a curated recommendation inside the same refresh.
			return finalizeStorageSnapshot({
				pass: second,
				quality: 'unstable',
				coveragePasses: [first, second],
				passes: [first, second],
			}, {
				accountId: context.accountId,
				snapshotId,
				startedAt,
				completedAt: new Date().toISOString(),
			});
		}
		// H14.10: a capture whose only gap sits inside a single character (never an account-wide
		// source, and never the roster read itself) already gave that character one retry inside
		// `capturePass`. The GW2 API serves `/v2/account`, `/v2/account/bank` and
		// `/v2/account/materials` from one shared cached instant, so a matching `last-modified` on
		// a second, single lightweight request already proves nothing else in the account moved
		// either: no need to repeat the whole roster and every store just to confirm stability.
		if (!hasAccountWideCoverageGap(first.coverage)) {
			const anchorMatched = await this.tryAnchorSkip(operation, sharedInventoryLastModified.value);
			if (anchorMatched) {
				return finalizeStorageSnapshot({
					pass: first,
					quality: 'stable',
					coveragePasses: [first],
					passes: [first],
				}, {
					accountId: context.accountId,
					snapshotId,
					startedAt,
					completedAt: new Date().toISOString(),
				});
			}
		}
		// A transient hole already makes this pass unusable as a session boundary.
		// Returning it now preserves exact coverage while the single poll scheduler
		// owns the only retry/backoff; repeating the whole roster here creates bursts.
		if (hasTransientCoverageFailure(first.coverage)) {
			return finalizeStorageSnapshot({
				pass: first,
				quality: 'partial',
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
		if (hasTransientCoverageFailure(second.coverage)) {
			return finalizeStorageSnapshot({
				pass: second,
				quality: 'partial',
				coveragePasses: [first, second],
				passes: [first, second],
			}, {
				accountId: context.accountId,
				snapshotId,
				startedAt,
				completedAt: new Date().toISOString(),
			});
		}
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
		onSharedInventoryLastModified?: (value: string | null) => void,
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
				onSharedInventoryLastModified,
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
					const path = withSchema(`characters/${encodeURIComponent(character)}/inventory`);
					const parse = (value: unknown): StorageSnapshotPass['holdings'] =>
						parseCharacterInventory(value, character);
					let result = await captureSource(() => operation.requestDetailed(path), parse, true, true);
					// H14.10: `GW2_CHARACTER_OPERATION_POLICIES` deliberately gives a character
					// inventory 0 transport-level retries ("capture/scheduler own recovery"). This is
					// that one patient retry, scoped to the single character that actually timed out
					// instead of the whole roster — only for the session-boundary capture, never the
					// Advisor refresh, which already recovers a transient hole with its own second pass.
					if (
						scope === 'complete'
						&& result.coverage.status === 'partial'
						&& isRetryableCharacterFailure(result.coverage.diagnostic)
					) {
						result = await captureSource(() => operation.requestDetailed(path), parse, true, true);
					}
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
		/** H14.10: only supplied for `shared_inventory`, the one required store that always
		 * runs — used as the anchor for the last-modified skip in `captureInternal`. */
		onLastModified?: (value: string | null) => void,
	): Promise<void> {
		const result = await captureSource(
			() => limit(() => operation.requestDetailed(withSchema(path))).then((response) => {
				onLastModified?.(readHeader(response.headers, 'last-modified'));
				return response;
			}),
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

	/**
	 * H14.10: one lightweight recheck of the shared-inventory endpoint. `null` (no header, or a
	 * mismatch) always falls back to the existing two/three-pass logic below unchanged; a fixture
	 * or gateway that never returns `last-modified` behaves exactly as it did before this method
	 * existed.
	 */
	private async tryAnchorSkip(
		operation: GuildWars2Operation,
		firstLastModified: string | null,
	): Promise<boolean> {
		if (firstLastModified === null) return false;
		try {
			const response = await this.globalLimit(() =>
				operation.requestDetailed(withSchema('account/inventory')));
			const recheckLastModified = readHeader(response.headers, 'last-modified');
			return recheckLastModified !== null && recheckLastModified === firstLastModified;
		} catch {
			return false;
		}
	}
}

function advisorPassComplete(coverage: SnapshotCoverage): boolean {
	return coverage.sources.characters.status === 'complete'
		&& coverage.sources.shared_inventory.status === 'complete'
		&& Object.values(coverage.characters).every((entry) => entry.status === 'complete');
}

function hasIncompleteCoverage(coverage: SnapshotCoverage): boolean {
	return [...Object.values(coverage.sources), ...Object.values(coverage.characters)]
		.some((entry) => entry.status === 'partial');
}

function shouldRetryAdvisorPass(coverage: SnapshotCoverage): boolean {
	const incomplete = [...Object.values(coverage.sources), ...Object.values(coverage.characters)]
		.filter((entry) => entry.status === 'partial');
	if (incomplete.some((entry) => entry.diagnostic?.status === 429)) return false;
	const core = [coverage.sources.characters, coverage.sources.shared_inventory, ...Object.values(coverage.characters)].filter((entry) => entry.status === 'partial');
	const candidates = core.length > 0 ? core : incomplete;
	return candidates.length > 0 && candidates.every((entry) => entry.reason === 'partial_response'
		|| entry.diagnostic?.kind === 'timeout'
		|| entry.diagnostic?.kind === 'network'
		|| (entry.diagnostic?.status ?? 0) >= 500);
}

function createAdvisorProgressReporter(
	report: (progress: StorageSnapshotCaptureProgress) => void,
): {
	first: (progress: StorageSnapshotCaptureProgress) => void;
	second: (progress: StorageSnapshotCaptureProgress) => void;
} {
	let firstLatest: StorageSnapshotCaptureProgress | null = null;
	return {
		first: (progress) => {
			firstLatest = progress;
			report(progress);
		},
		second: (progress) => {
			const first = firstLatest;
			if (first === null) return;
			report({
				roster: { completed: 1 + progress.roster.completed, total: 2 },
				accountStores: {
					completed: first.accountStores.completed + progress.accountStores.completed,
					total: first.accountStores.total + progress.accountStores.total,
				},
				characters: {
					completed: first.characters.completed + progress.characters.completed,
					total: first.characters.total + progress.characters.total,
				},
			});
		},
	};
}

function hasTransientCoverageFailure(coverage: SnapshotCoverage): boolean {
	return [...Object.values(coverage.sources), ...Object.values(coverage.characters)].some((entry) => {
		if (entry.status !== 'partial' || entry.diagnostic === undefined) return false;
		return entry.diagnostic.kind === 'timeout'
			|| entry.diagnostic.kind === 'network'
			|| entry.diagnostic.status === 429
			|| (entry.diagnostic.status !== null && entry.diagnostic.status >= 500);
	});
}

/**
 * H14.10: gates the last-modified anchor skip in `captureInternal`. A single character's own
 * hole (any reason, including a persisted transient one that survived the one retry above) never
 * counts here: `hasTransientCoverageFailure` below still catches it on the old fallback path when
 * the anchor is unavailable, exactly as before this method existed. Only a gap in an
 * account-wide source, or the roster read itself coming back empty, disqualifies the fast path.
 */
function hasAccountWideCoverageGap(coverage: SnapshotCoverage): boolean {
	const rosterFetchFailed = coverage.sources.characters.status === 'partial'
		&& Object.keys(coverage.characters).length === 0;
	if (rosterFetchFailed) return true;
	return (['shared_inventory', 'bank', 'materials', 'wallet', 'commerce_delivery'] as const)
		.some((source) => coverage.sources[source].status === 'partial');
}

/** A character-inventory failure worth one immediate retry: never a 429 (shared rate limit,
 * already the single poll scheduler's job to back off from) or a permanent 403/404. */
function isRetryableCharacterFailure(diagnostic: SourceCoverage['diagnostic']): boolean {
	if (diagnostic === undefined) return false;
	return diagnostic.kind === 'timeout'
		|| diagnostic.kind === 'network'
		|| (diagnostic.status !== null && diagnostic.status >= 500);
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
	return entry?.[1] ?? null;
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
