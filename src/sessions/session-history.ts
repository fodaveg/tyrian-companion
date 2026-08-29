import { normalizeSessionOutputFolder } from './session-note-model';
import { inspectStoredSessionNote, scrubStoredSessionNote, sha256Text } from './session-note-renderer';

export const SESSION_HISTORY_EXPORT_VERSION = 1 as const;
export const SESSION_HISTORY_JSON_FILE = 'tyrian-companion-sessions-v1.json';
export const SESSION_HISTORY_CSV_FILE = 'tyrian-companion-sessions-v1.csv';

export interface SessionHistoryFile { path: string }

/** Minimal Vault port. Listing happens only after an explicit history action. */
export interface SessionHistoryVault {
	markdownFiles(): readonly SessionHistoryFile[];
	/** True for either a file or folder; reads remain restricted to TFile-like values. */
	exists(path: string): boolean;
	file(path: string): SessionHistoryFile | null;
	read(file: SessionHistoryFile): Promise<string>;
	/** Atomic compare-and-swap surface; implementations must delegate to Vault.process. */
	process(file: SessionHistoryFile, update: (current: string) => string): Promise<void>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<SessionHistoryFile>;
}

export interface DurableSessionHistoryRecord {
	sessionRef: string;
	accountRef: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	classification: string;
	confidence: string;
	scope: string;
	valuationCoverage: string;
	observedImmediateCopper: number | null;
	observedListingCopper: number | null;
	sacks: number | null;
	sacksPerHourMilli: number | null;
	immediateCopperPerHour: number | null;
	listingCopperPerHour: number | null;
	recommendationStatus: string;
	recommendationAction: string | null;
	recommendationQuantity: number | null;
	recommendationRoute: string | null;
}

export interface DurableSessionNoteEvidence {
	schema: 1 | 2 | 3;
	event: 'halloween' | null;
	sessionRef: string;
	accountRef: string;
	endedAt: string;
	positiveItemDeltas: readonly { itemId: number; quantity: number }[] | null;
}

export type DurableSessionNoteInspection =
	| { status: 'ok'; session: DurableSessionHistoryRecord; evidence: DurableSessionNoteEvidence }
	| { status: 'non_candidate' | 'invalid' };

export type SessionHistoryScan =
	| { status: 'ok'; sessions: readonly DurableSessionHistoryRecord[]; ignored: number }
	| { status: 'conflict'; invalid: number; duplicates: number };

export type SessionHistoryExportResult =
	| { status: 'written' | 'unchanged'; sessions: number }
	| { status: 'conflict' | 'unavailable' | 'invalid'; message: string };

export type SessionHistoryScrubPreview =
	| { status: 'ready'; token: string; sessions: number }
	| { status: 'blocked' | 'conflict' | 'unavailable'; message: string };

export type SessionHistoryScrubResult =
	| { status: 'erased' | 'already_absent'; erased: number; alreadyAbsent: number }
	| { status: 'blocked' | 'stale' | 'conflict' | 'unavailable'; erased: number; alreadyAbsent: number; message: string };

/** Runtime state is checked immediately before both preview and the atomic scrub. */
export interface SessionHistoryScrubGate {
	sessionStatus: string;
	recoveryStatus?: string;
	/** Backward-compatible source for callers that cannot expose a detailed recovery state. */
	recoveryPending?: boolean;
	detectorStatus: string;
}

export interface SessionHistoryScrubLease {
	isLive(): boolean;
	release(): void;
}

export interface SessionHistoryRuntimeMutationLease { release(): void }

/** Shared synchronous exclusion between a destructive scrub and runtime transitions. */
export class SessionHistoryRuntimeAuthority {
	private scrubOwner: symbol | null = null;
	private runtimeMutations = 0;

	constructor(private readonly readRuntime: () => SessionHistoryScrubGate) {}

	readGate(): SessionHistoryScrubGate { return this.readRuntime(); }

	runtimeMutationAllowed(): boolean { return this.scrubOwner === null; }

	acquireRuntimeMutation(): SessionHistoryRuntimeMutationLease | null {
		if (this.scrubOwner !== null) return null;
		this.runtimeMutations += 1;
		let released = false;
		return { release: () => {
			if (released) return;
			released = true;
			this.runtimeMutations -= 1;
		} };
	}

	acquireScrub(): SessionHistoryScrubLease | null {
		if (this.scrubOwner !== null || this.runtimeMutations > 0 || !canScrubSessionHistory(this.readRuntime())) return null;
		const owner = Symbol('session-history-scrub');
		this.scrubOwner = owner;
		if (!canScrubSessionHistory(this.readRuntime())) {
			this.scrubOwner = null;
			return null;
		}
		return {
			isLive: () => this.scrubOwner === owner && canScrubSessionHistory(this.readRuntime()),
			release: () => { if (this.scrubOwner === owner) this.scrubOwner = null; },
		};
	}
}

/** A completed, recoverable, or armed local runtime must never be scrubbed around. */
export function canScrubSessionHistory(gate: SessionHistoryScrubGate): boolean {
	const recoveryIdle = gate.recoveryStatus === undefined
		? gate.recoveryPending === false
		: gate.recoveryStatus === 'none';
	return gate.sessionStatus === 'idle' && recoveryIdle && gate.detectorStatus === 'disarmed';
}

const REF = /^[a-f0-9]{64}$/u;
const V1_SESSION_KEYS = [
	'tc_schema', 'tc_kind', 'tc_session_ref', 'tc_account_ref', 'tc_locale', 'tc_started_at', 'tc_ended_at', 'tc_duration_ms',
	'tc_character', 'tc_profession', 'tc_build', 'tc_magic_find', 'tc_detection_mode', 'tc_classification', 'tc_confidence',
	'tc_scope', 'tc_valuation_coverage', 'tc_price_source', 'tc_price_captured_at', 'tc_observed_immediate_copper',
	'tc_observed_listing_copper', 'tc_sacks', 'tc_sacks_per_hour_milli', 'tc_immediate_copper_per_hour',
	'tc_listing_copper_per_hour', 'tc_reservation_status', 'tc_reserved_quantity', 'tc_hold_status', 'tc_held_quantity',
	'tc_recommendation_status', 'tc_execution', 'tc_side_effects',
] as const;
const V2_SESSION_KEYS = [
	...V1_SESSION_KEYS, 'tc_event', 'tc_event_source', 'tc_recommendation_action', 'tc_recommendation_quantity',
	'tc_recommendation_route',
] as const;
const V3_SESSION_KEYS = [...V2_SESSION_KEYS, 'tc_positive_item_deltas_json'] as const;
const CSV_COLUMNS = [
	'session_ref', 'account_ref', 'started_at', 'ended_at', 'duration_ms', 'classification', 'confidence', 'scope',
	'valuation_coverage', 'observed_immediate_copper', 'observed_listing_copper', 'sacks', 'sacks_per_hour_milli',
	'immediate_copper_per_hour', 'listing_copper_per_hour', 'recommendation_status', 'recommendation_action',
	'recommendation_quantity', 'recommendation_route',
] as const;

interface ScrubPlanItem {
	path: string;
	sessionRef: string;
	expectedContent: string;
	expectedHash: string;
	scrubbedContent: string;
}

/** Explicit, Vault-wide export of validated durable session notes. */
export class SessionHistoryService {
	private exportFlight: Promise<SessionHistoryExportResult> | null = null;
	private scrubFlight: Promise<SessionHistoryScrubResult> | null = null;
	private readonly scrubPlans = new Map<string, readonly ScrubPlanItem[]>();

	constructor(private readonly vault: SessionHistoryVault) {}

	async scan(): Promise<SessionHistoryScan> {
		try {
			const sessions: DurableSessionHistoryRecord[] = [];
			let ignored = 0;
			let invalid = 0;
			for (const file of this.vault.markdownFiles()) {
				let content: string;
				try { content = await this.vault.read(file); } catch { invalid += 1; continue; }
				const decoded = await decodeDurableSession(content);
				if (decoded.status === 'ok') sessions.push(decoded.session);
				else if (decoded.status === 'non_candidate') ignored += 1;
				else invalid += 1;
			}
			const refs = new Set<string>();
			let duplicates = 0;
			for (const session of sessions) {
				if (refs.has(session.sessionRef)) duplicates += 1;
				refs.add(session.sessionRef);
			}
			if (invalid > 0 || duplicates > 0) return { status: 'conflict', invalid, duplicates };
			return { status: 'ok', sessions: sessions.sort(compareSessions), ignored };
		} catch { return { status: 'conflict', invalid: 1, duplicates: 0 }; }
	}

	export(outputFolder: unknown): Promise<SessionHistoryExportResult> {
		if (this.exportFlight) return this.exportFlight;
		const flight = this.exportInternal(outputFolder).finally(() => {
			if (this.exportFlight === flight) this.exportFlight = null;
		});
		this.exportFlight = flight;
		return flight;
	}

	/** Builds an in-memory, opaque capability after validating every durable note. */
	async previewScrub(authority: SessionHistoryRuntimeAuthority): Promise<SessionHistoryScrubPreview> {
		this.scrubPlans.clear();
		if (!canScrubSessionHistory(authority.readGate())) return { status: 'blocked', message: 'Session runtime, recovery, or detector is not idle.' };
		if (this.scrubFlight) return { status: 'unavailable', message: 'Another history scrub is in progress.' };
		try {
			const plan = await this.buildScrubPlan();
			if (plan.status !== 'ok') return { status: 'conflict', message: 'Durable session notes are corrupt, unsupported, or duplicated.' };
			if (!canScrubSessionHistory(authority.readGate())) return { status: 'blocked', message: 'Session runtime, recovery, or detector is not idle.' };
			const token = crypto.randomUUID();
			this.scrubPlans.set(token, plan.items);
			return { status: 'ready', token, sessions: plan.items.length };
		} catch { return { status: 'unavailable', message: 'History scrub could not be prepared safely.' }; }
	}

	revokeScrub(token: string): void { this.scrubPlans.delete(token); }

	dispose(): void { this.scrubPlans.clear(); }

	/** Uses only process-local, byte-bound preview capabilities. */
	scrub(token: string, authority: SessionHistoryRuntimeAuthority): Promise<SessionHistoryScrubResult> {
		if (this.scrubFlight) {
			this.scrubPlans.delete(token);
			return this.scrubFlight;
		}
		const flight = this.scrubInternal(token, authority).finally(() => {
			if (this.scrubFlight === flight) this.scrubFlight = null;
		});
		this.scrubFlight = flight;
		return flight;
	}

	private async scrubInternal(token: string, authority: SessionHistoryRuntimeAuthority): Promise<SessionHistoryScrubResult> {
		const progress = { erased: 0, alreadyAbsent: 0 };
		const items = this.scrubPlans.get(token);
		if (!items) return { status: 'stale', ...progress, message: 'The scrub preview is no longer valid.' };
		this.scrubPlans.delete(token);
		const lease = authority.acquireScrub();
		if (lease === null) return { status: 'blocked', ...progress, message: 'Session runtime, recovery, or detector is not idle.' };
		try {
			for (const item of items) {
				if (!lease.isLive()) return { status: 'blocked', ...progress, message: 'Session runtime, recovery, or detector is not idle.' };
				const file = this.vault.file(item.path);
				if (file === null) return { status: 'conflict', ...progress, message: 'A scrub target was deleted, renamed, or is no longer a file.' };
				let before: string;
				try { before = await this.vault.read(file); }
				catch {
					return this.vault.file(item.path) === null
						? { status: 'conflict', ...progress, message: 'A scrub target was deleted, renamed, or is no longer a file.' }
						: { status: 'unavailable', ...progress, message: 'A scrub target could not be read safely.' };
				}
				if (await sha256Text(before) !== item.expectedHash || before !== item.expectedContent) {
					if (before === item.scrubbedContent) { progress.alreadyAbsent += 1; continue; }
					return { status: 'conflict', ...progress, message: 'A scrub target changed after preview.' };
				}
				const outcome: { value: 'erased' | 'changed' } = { value: 'changed' };
				let current = '';
				if (!lease.isLive()) return { status: 'blocked', ...progress, message: 'Session runtime, recovery, or detector is not idle.' };
				try {
					await this.vault.process(file, (value) => {
						current = value;
						if (value !== item.expectedContent) return value;
						outcome.value = 'erased';
						return item.scrubbedContent;
					});
				} catch {
					return this.vault.file(item.path) === null
						? { status: 'conflict', ...progress, message: 'A scrub target was deleted, renamed, or is no longer a file.' }
						: { status: 'unavailable', ...progress, message: 'A scrub target could not be updated safely.' };
				}
				if (outcome.value === 'erased') { progress.erased += 1; continue; }
				if (current === item.scrubbedContent) { progress.alreadyAbsent += 1; continue; }
				return { status: 'conflict', ...progress, message: 'A scrub target changed during the atomic update.' };
			}
			return progress.erased > 0 ? { status: 'erased', ...progress } : { status: 'already_absent', ...progress };
		} finally { lease.release(); }
	}

	private async buildScrubPlan(): Promise<{ status: 'ok'; items: readonly ScrubPlanItem[] } | { status: 'conflict' }> {
		const items: ScrubPlanItem[] = [];
		let invalid = 0;
		for (const file of this.vault.markdownFiles()) {
			let content: string;
			try { content = await this.vault.read(file); } catch { invalid += 1; continue; }
			const decoded = await decodeDurableSession(content);
			if (decoded.status !== 'ok') {
				if (decoded.status === 'invalid') invalid += 1;
				continue;
			}
			const scrubbedContent = await scrubStoredSessionNote(content);
			if (scrubbedContent === null) { invalid += 1; continue; }
			items.push({ path: file.path, sessionRef: decoded.session.sessionRef, expectedContent: content,
				expectedHash: await sha256Text(content), scrubbedContent });
		}
		const refs = new Set<string>();
		const duplicates = items.some((item) => refs.has(item.sessionRef) || !refs.add(item.sessionRef));
		return invalid > 0 || duplicates ? { status: 'conflict' } : { status: 'ok', items };
	}

	private async exportInternal(outputFolder: unknown): Promise<SessionHistoryExportResult> {
		const folder = normalizeSessionOutputFolder(outputFolder);
		if (folder === null) return { status: 'invalid', message: 'The output folder is not portable.' };
		try {
			const scan = await this.scan();
			if (scan.status !== 'ok') return { status: 'conflict', message: 'Durable session notes are corrupt, unsupported, or duplicated.' };
			const json = serializeJson(scan.sessions);
			const csv = serializeCsv(scan.sessions);
			const jsonPath = `${folder}/exports/${SESSION_HISTORY_JSON_FILE}`;
			const csvPath = `${folder}/exports/${SESSION_HISTORY_CSV_FILE}`;
			const preflight = await this.preflightExports(jsonPath, json, csvPath, csv);
			if (preflight === 'conflict') return { status: 'conflict', message: 'An existing history export has different content.' };
			await this.ensureFolder(`${folder}/exports`);
			const jsonResult = await this.createOnly(jsonPath, json);
			if (jsonResult === 'conflict') return { status: 'conflict', message: 'An existing history export has different content.' };
			const csvResult = await this.createOnly(csvPath, csv);
			if (csvResult === 'conflict') return { status: 'conflict', message: 'An existing history export has different content.' };
			return { status: jsonResult === 'unchanged' && csvResult === 'unchanged' ? 'unchanged' : 'written', sessions: scan.sessions.length };
		} catch { return { status: 'unavailable', message: 'History export could not be created safely.' }; }
	}

	private async preflightExports(jsonPath: string, json: string, csvPath: string, csv: string): Promise<'ready' | 'conflict'> {
		for (const [path, content] of [[jsonPath, json], [csvPath, csv]] as const) {
			const existing = this.vault.file(path);
			if (existing !== null && await this.vault.read(existing) !== content) return 'conflict';
			if (existing === null && this.vault.exists(path)) return 'conflict';
		}
		return 'ready';
	}

	private async createOnly(path: string, content: string): Promise<'written' | 'unchanged' | 'conflict'> {
		const existing = this.vault.file(path);
		if (existing) return (await this.vault.read(existing)) === content ? 'unchanged' : 'conflict';
		if (this.vault.exists(path)) return 'conflict';
		try { await this.vault.create(path, content); return 'written'; }
		catch {
			const raced = this.vault.file(path);
			if (!raced) {
				if (this.vault.exists(path)) return 'conflict';
				throw new Error('create_failed');
			}
			return (await this.vault.read(raced)) === content ? 'unchanged' : 'conflict';
		}
	}

	private async ensureFolder(folder: string): Promise<void> {
		let current = '';
		for (const segment of folder.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.vault.exists(current)) {
				try { await this.vault.createFolder(current); }
				catch { if (!this.vault.exists(current)) throw new Error('folder_failed'); }
			}
		}
	}
}

/** Canonical durable-note inspector shared by history and opt-in feature backfills. */
export async function inspectDurableSessionNote(content: string): Promise<DurableSessionNoteInspection> {
	const note = await inspectStoredSessionNote(content);
	if (note === null) return { status: hasTcHint(content) ? 'invalid' : 'non_candidate' };
	const fm = note.frontmatter;
	if (Object.keys(fm).length === 0) return { status: 'non_candidate' };
	if (fm.tc_kind !== 'gw2_farming_session' || (fm.tc_schema !== 1 && fm.tc_schema !== 2 && fm.tc_schema !== 3) ||
		!hasExactKeys(fm, fm.tc_schema === 1 ? V1_SESSION_KEYS : fm.tc_schema === 2 ? V2_SESSION_KEYS : V3_SESSION_KEYS) ||
		!note.managedBlocksValid || note.hasInvalidScalar) return { status: 'invalid' };
	const sessionRef = fm.tc_session_ref;
	const accountRef = fm.tc_account_ref;
	const startedAt = fm.tc_started_at;
	const endedAt = fm.tc_ended_at;
	const durationMs = fm.tc_duration_ms;
	const classification = fm.tc_classification;
	const confidence = fm.tc_confidence;
	const scope = fm.tc_scope;
	if (!isRef(sessionRef) || !isRef(accountRef) || !iso(startedAt) || !iso(endedAt) || !safePositive(durationMs) ||
		Date.parse(endedAt) - Date.parse(startedAt) !== durationMs ||
		!enumValue(classification, ['exact', 'estimated', 'contaminated']) || !enumValue(confidence, ['high', 'medium', 'low']) ||
		scope !== 'observed_storage_net' || !isSessionMetadata(fm)) return { status: 'invalid' };
	const positiveItemDeltas = fm.tc_schema === 3 ? parsePositiveItemDeltas(fm.tc_positive_item_deltas_json) : null;
	if (fm.tc_schema === 3 && positiveItemDeltas === null) return { status: 'invalid' };
	return { status: 'ok', session: {
		sessionRef, accountRef, startedAt, endedAt, durationMs,
		classification, confidence, scope,
		valuationCoverage: stringOr(fm.tc_valuation_coverage), observedImmediateCopper: numberOrNull(fm.tc_observed_immediate_copper),
		observedListingCopper: numberOrNull(fm.tc_observed_listing_copper), sacks: numberOrNull(fm.tc_sacks),
		sacksPerHourMilli: numberOrNull(fm.tc_sacks_per_hour_milli), immediateCopperPerHour: numberOrNull(fm.tc_immediate_copper_per_hour),
		listingCopperPerHour: numberOrNull(fm.tc_listing_copper_per_hour), recommendationStatus: stringOr(fm.tc_recommendation_status),
		recommendationAction: nullableString(fm.tc_recommendation_action), recommendationQuantity: numberOrNull(fm.tc_recommendation_quantity),
		recommendationRoute: nullableString(fm.tc_recommendation_route),
	}, evidence: {
		schema: fm.tc_schema,
		event: fm.tc_schema === 1 ? null : fm.tc_event as 'halloween' | null,
		sessionRef,
		accountRef,
		endedAt,
		positiveItemDeltas,
	} };
}

async function decodeDurableSession(content: string): Promise<DurableSessionNoteInspection> {
	return await inspectDurableSessionNote(content);
}

function isSessionMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	return (fm.tc_locale === 'es' || fm.tc_locale === 'en') && typeof fm.tc_character === 'string' &&
		typeof fm.tc_profession === 'string' && isNullableString(fm.tc_build) && safeNonNegative(fm.tc_magic_find) &&
		fm.tc_detection_mode === null && validClassificationMetadata(fm) && fm.tc_scope === 'observed_storage_net' &&
		validValuationMetadata(fm) && validReservationMetadata(fm) && validHoldMetadata(fm) &&
		enumValue(fm.tc_recommendation_status, ['not_evaluated', 'invalid', 'blocked', 'ready', 'reserved_only']) &&
		fm.tc_execution === 'manual_in_game' && fm.tc_side_effects === 'none' &&
		isV2Metadata(fm);
}

/** The renderer derives confidence from classification; no other pair is durable. */
function validClassificationMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	return (fm.tc_classification === 'exact' && fm.tc_confidence === 'high') ||
		(fm.tc_classification === 'estimated' && (fm.tc_confidence === 'medium' || fm.tc_confidence === 'low')) ||
		(fm.tc_classification === 'contaminated' && fm.tc_confidence === 'high');
}

function validValuationMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	const coverage = fm.tc_valuation_coverage;
	const evidence = [
		fm.tc_observed_immediate_copper, fm.tc_observed_listing_copper, fm.tc_sacks, fm.tc_sacks_per_hour_milli,
		fm.tc_immediate_copper_per_hour, fm.tc_listing_copper_per_hour,
	];
	if (coverage === 'not_evaluated' || coverage === 'invalid') {
		return fm.tc_price_source === null && fm.tc_price_captured_at === null && evidence.every((value) => value === null);
	}
	if ((coverage !== 'complete' && coverage !== 'partial') || fm.tc_price_source !== 'gw2-commerce-prices' ||
		!iso(fm.tc_price_captured_at)) return false;
	if (fm.tc_classification === 'contaminated') return evidence.every((value) => value === null);
	const observed = evidence.slice(0, 3);
	const hourly = evidence.slice(3);
	if (!observed.every(safeNonNegative)) return false;
	return fm.tc_classification === 'estimated'
		? hourly.every((value) => value === null)
		: hourly.every(safeNonNegative);
}

function validReservationMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_reservation_status === 'not_evaluated' || fm.tc_reservation_status === 'invalid') return fm.tc_reserved_quantity === null;
	return enumValue(fm.tc_reservation_status, [
		'complete:met', 'complete:shortfall', 'limited:met', 'limited:shortfall', 'blocked:met', 'blocked:shortfall',
	]) && safeNonNegative(fm.tc_reserved_quantity);
}

function validHoldMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_hold_status === 'not_evaluated' || fm.tc_hold_status === 'invalid') return fm.tc_held_quantity === null;
	return enumValue(fm.tc_hold_status, ['active', 'expired', 'released']) && safeNonNegative(fm.tc_held_quantity);
}

function isV2Metadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_schema === 1) return true;
	return (fm.tc_event === null || fm.tc_event === 'halloween') &&
		(fm.tc_event_source === null || fm.tc_event_source === 'manual_explicit' || fm.tc_event_source === 'assisted') &&
		(fm.tc_event === null ? fm.tc_event_source === null : fm.tc_event_source !== null) &&
		validRecommendationMetadata(fm) && validPositiveItemDeltas(fm);
}

function validPositiveItemDeltas(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_schema !== 3) return true;
	return parsePositiveItemDeltas(fm.tc_positive_item_deltas_json) !== null;
}

function parsePositiveItemDeltas(value: unknown): { itemId: number; quantity: number }[] | null {
	if (typeof value !== 'string') return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return null;
		const gains: { itemId: number; quantity: number }[] = [];
		let previous = 0;
		for (const entry of parsed) {
			if (!Array.isArray(entry) || entry.length !== 2 || !safePositive(entry[0]) || !safePositive(entry[1]) || entry[0] <= previous) return null;
			gains.push({ itemId: entry[0], quantity: entry[1] });
			previous = entry[0];
		}
		return gains;
	} catch { return null; }
}

function validRecommendationMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	const empty = fm.tc_recommendation_action === null && fm.tc_recommendation_quantity === null && fm.tc_recommendation_route === null;
	if (fm.tc_recommendation_status !== 'ready') return empty;
	return (fm.tc_recommendation_action === 'open' && safePositive(fm.tc_recommendation_quantity) && fm.tc_recommendation_route === null) ||
		(fm.tc_recommendation_action === 'sell' && safePositive(fm.tc_recommendation_quantity) &&
			(fm.tc_recommendation_route === 'instant_sell' || fm.tc_recommendation_route === 'vendor'));
}

function serializeJson(sessions: readonly DurableSessionHistoryRecord[]): string {
	return `${JSON.stringify({ format: 'tyrian-companion-session-export', version: SESSION_HISTORY_EXPORT_VERSION, sessions }, null, 2)}\n`;
}
function serializeCsv(sessions: readonly DurableSessionHistoryRecord[]): string {
	const rows = [
		CSV_COLUMNS.map((column) => serializeCsvCell(column)).join(','),
		...sessions.map((session) => CSV_COLUMNS.map((column) => serializeCsvCell(valueForColumn(session, column))).join(',')),
	];
	return `${rows.join('\r\n')}\r\n`;
}
function valueForColumn(session: DurableSessionHistoryRecord, column: typeof CSV_COLUMNS[number]): string | number | null {
	const key = column.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()) as keyof DurableSessionHistoryRecord;
	return session[key];
}
/** RFC-style quoting plus spreadsheet formula protection after invisible prefixes. */
export function serializeCsvCell(value: string | number | null): string {
	const text = value === null ? '' : String(value);
	return `"${(/^[\s\p{Cc}]*[=+\-@]/u.test(text) ? `'${text}` : text).replace(/"/gu, '""')}"`;
}
function compareSessions(a: DurableSessionHistoryRecord, b: DurableSessionHistoryRecord): number {
	return a.startedAt.localeCompare(b.startedAt) || a.endedAt.localeCompare(b.endedAt) || a.sessionRef.localeCompare(b.sessionRef);
}
function hasTcHint(content: string): boolean {
	if (content.startsWith('---\n')) {
		const end = content.indexOf('\n---\n', 4);
		const frontmatter = content.slice(4, end < 0 ? undefined : end);
		if (/(?:^|\n)\s*tc_[A-Za-z0-9_-]*(?:\s*:|\b)/u.test(frontmatter)) return true;
	}
	let fence: '`' | '~' | null = null;
	for (const line of content.split('\n')) {
		const opened = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
		if (opened) {
			const kind = opened[0] as '`' | '~';
			fence = fence === null ? kind : fence === kind ? null : fence;
			continue;
		}
		if (fence === null && /^<!-- tyrian-companion:managed:(?:start:(?:summary|evidence|results|economy|decision|provenance) sha256=[a-f0-9]{64}|end:(?:summary|evidence|results|economy|decision|provenance)) -->$/u.test(line)) return true;
	}
	return false;
}
function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
function enumValue(value: unknown, allowed: readonly string[]): value is string { return typeof value === 'string' && allowed.includes(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function isRef(value: unknown): value is string { return typeof value === 'string' && REF.test(value); }
function safePositive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function safeNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) ? value : null; }
function nullableString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function isNullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function stringOr(value: unknown): string { return typeof value === 'string' ? value : 'not_evaluated'; }
