import { inspectLiveSessionNote, type LiveSessionNoteInspection } from './live-session-note-renderer';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { canonicalJson } from '../core/canonical-sha256';
import { isFarmingGoal, isFarmingGoalProgress, type FarmingGoalV1, type FarmingGoalProgress } from './farming-goal';
import { parseDurableSessionComparison, parseSessionSackObservation, type DurableSessionComparisonMetadata, type SessionSackObservation } from './session-comparison-metadata';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import { INVENTORY_NOTE_KIND } from '../inventory/inventory-vault-sync';
import { COLLECTOR_STATUS_NOTE_KIND } from '../runtime/collector-status';
import { WALLET_NOTE_KIND } from '../wallet/wallet-vault-sync';
import { normalizeSessionOutputFolder } from './session-note-model';
import { SESSION_ABANDON_REASONS } from './session';
import {
	inspectStoredSessionLootSummary,
	inspectStoredSessionNote,
	scrubStoredSessionNote,
	sha256Text,
	type StoredSessionLootSummary,
} from './session-note-renderer';

export const SESSION_HISTORY_EXPORT_VERSION = 1 as const;
export const SESSION_HISTORY_JSON_FILE = 'tyrian-companion-sessions-v1.json';
export const SESSION_HISTORY_CSV_FILE = 'tyrian-companion-sessions-v1.csv';

/** `mtime` is present only when the host reports it (a real file); a scan may remember an inspection against it. */
export interface SessionHistoryFile { path: string; readonly mtime?: number }

/** One note the host says was created, modified, deleted or renamed (`oldPath` only on a rename). */
export interface SessionHistoryNoteChange { readonly path: string; readonly oldPath?: string }

/**
 * Where a scan takes each note's inspection from.
 *
 * - `vault`: every Markdown note is read, and nothing is remembered. The export uses it.
 * - `index`: a note inspected before is not read again until the host names it in a change.
 *   Without `SessionHistoryVault.onNoteChange` it is the same as `vault`.
 * - `rebuild`: forgets every remembered inspection first, then scans as `index`.
 */
export type SessionHistoryScanSource = 'vault' | 'index' | 'rebuild';

/** Minimal Vault port. Listing happens only after an explicit history action. */
export interface SessionHistoryVault {
	markdownFiles(): readonly SessionHistoryFile[];
	/**
	 * Present ONLY on a host that reports every create, modify, delete and rename of a note while
	 * the runtime runs, whoever made the change. It is what lets a scan keep an inspection instead
	 * of reading the note again; a host that cannot promise it leaves this out, and every scan
	 * reads the whole vault as before.
	 */
	onNoteChange?(listener: (change: SessionHistoryNoteChange) => void): () => void;
	/** True for either a file or folder; reads remain restricted to TFile-like values. */
	exists(path: string): boolean;
	file(path: string): SessionHistoryFile | null;
	read(file: SessionHistoryFile): Promise<string>;
	/** Atomic compare-and-swap surface; implementations must delegate to Vault.process. */
	process(file: SessionHistoryFile, update: (current: string) => string): Promise<void>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<SessionHistoryFile>;
}

/** One already-rendered gains line, read back from the note's own results table (H18.10): the
 *  durable history has no runtime to revalue from, only the strings the session already wrote. */
export interface DurableSessionLootLine {
	readonly name: string;
	readonly netQuantity: number;
	readonly immediateLabel: string;
}

export interface DurableSessionHistoryRecord {
	/** Vault path of the note this record was read from; set by `scan` only, absent on a decoded or fixture record. */
	notePath?: string;
	farmingGoal?: FarmingGoalV1;
	farmingGoalResult?: FarmingGoalProgress;
	comparisonMetadata?: DurableSessionComparisonMetadata;
	sackObservation?: SessionSackObservation;
	/** A validated legacy positive 36038 delta, never reconstructed from `tc_sacks` or absence. */
	legacyPositiveNetSacks?: number | null;
	sessionRef: string;
	accountRef: string;
	/** Declared comparison dimensions are available only to the explicit local history view. */
	activity: 'halloween' | null;
	build: string | null;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	/** `abandoned` (schema 6): the player gave the session up; it measured nothing. Absent means completed. */
	outcome?: 'completed' | 'abandoned';
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
	/** Empty when the results table could not be read back; never blocks the rest of the record. */
	lootRows: readonly DurableSessionLootLine[];
}

export interface DurableSessionNoteEvidence {
	schema: 1 | 2 | 3 | 4 | 5 | 6;
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

export type DurableSessionLookup =
	| { status: 'found'; path: string; session: DurableSessionHistoryRecord; loot: StoredSessionLootSummary | null }
	| { status: 'missing' | 'unavailable' | 'conflict' };

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
// H17.1 derives magic find from the API instead of asking for it, so the total alone no longer
// says where it came from: the source and the manually declared consumables part travel with it.
const V4_SESSION_KEYS = [...V3_SESSION_KEYS, 'tc_magic_find_source', 'tc_magic_find_consumables'] as const;
// H18.11: the duration is the active time, and the time nobody observed (a suspend, Obsidian
// closed) travels next to it, so the end stays the player's stop.
const V5_SESSION_KEYS = [...V4_SESSION_KEYS, 'tc_unobserved_ms'] as const;
// The player may abandon a session whose stop cannot finish (David, 2026-09-24): the note says
// whether the session completed or was abandoned, and why.
const V6_SESSION_KEYS = [...V5_SESSION_KEYS, 'tc_outcome', 'tc_abandon_reason'] as const;
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

/** What the live history makes of one note; `ignored` is a note that is neither a live session nor a broken durable one. */
export type LiveHistoryNoteOutcome = { kind: 'invalid' } | { kind: 'unsupported' } | { kind: 'ignored' } | { kind: 'live'; session: StoredLiveSessionPayloadV1 };

/** One read of a note, inspected for both histories at once (Z24). `liveBytes` is the text the live history counts against its cache. */
export interface SharedNoteRead {
	readonly content: string;
	readonly durable: DurableSessionNoteInspection;
	readonly live: LiveHistoryNoteOutcome;
	readonly liveBytes: number;
}

/**
 * Hands a history every note another history of the same run read. `stale` is true when the host named the note in a change
 * after the read began: the text may already be the old one, and a history that trusts change events must not keep it.
 */
export type SharedNoteReadPeer = (file: SessionHistoryFile, read: SharedNoteRead, stale: boolean) => void;

/** A note's text, read; `inspect` inspects it for both histories, once however many callers ask, and hands it to the peers. */
export interface SharedNoteText {
	readonly content: string;
	inspect(): Promise<SharedNoteRead>;
}

/**
 * How a read is shared:
 * - `join`: a read of the same note already under way is reused, and the result is handed to every peer;
 * - `fresh`: the note is read again even when a read is under way, and the result is still handed to the peers;
 * - `private`: a plain read, handed to nobody and following no change (the export's whole-vault read).
 */
export type SharedNoteReadMode = 'join' | 'fresh' | 'private';

/**
 * The reads of session notes in one run, shared by the durable history and the live one (Z24). Before it, opening the history
 * and listing the saved live sessions each read every note of the vault: twice the vault on the first open. Each read is now
 * inspected for both, and the other history keeps the result under its own rule (the durable one by change events, the live
 * one by mtime), so neither reads the note again. Nothing here decides which notes count: every listed note is still read
 * once, wherever it is, and corrupt or duplicated notes are found exactly as before.
 *
 * A read under way is only joined on a host that reports every change (`SessionHistoryVault.onNoteChange`), because a change
 * drops it: a note edited while it was being read is read again by whoever asks next.
 */
export class SessionNoteReads {
	private readonly peers = new Set<SharedNoteReadPeer>();
	private readonly changeFollowers = new Set<(change: SessionHistoryNoteChange) => void>();
	private readonly flights = new Map<string, { token: object; read: Promise<SharedNoteText> }>();
	private stopListening: (() => void) | null = null;
	/** Counts every change the host has reported; a read compares it when it ends. */
	private changes = 0;
	/** The count at which each note last changed, kept only while some read is under way. */
	private readonly lastChange = new Map<string, number>();
	private pending = 0;
	/** Moves on every `dispose`: a read that outlives one is handed to nobody. */
	private generation = 0;
	private disposed = false;

	constructor(private readonly vault: SessionHistoryVault) {}

	/** True on a host that reports every change, and from the first call on those changes are followed. */
	listen(): boolean {
		if (this.disposed || this.vault.onNoteChange === undefined) return false;
		this.stopListening ??= this.vault.onNoteChange((change) => { this.noteChanged(change); });
		return true;
	}

	/** True while the host's changes are followed: an inspection kept since then is current until a change names its note. */
	listening(): boolean { return this.stopListening !== null; }

	/** `peer` receives every shared read from now on, its own included. */
	share(peer: SharedNoteReadPeer): void { this.peers.add(peer); }

	/** `follower` hears every change the host reports while the reads listen. */
	followChanges(follower: (change: SessionHistoryNoteChange) => void): void { this.changeFollowers.add(follower); }

	/**
	 * Reads one note. It rejects only when the READ fails; inspecting the text is the caller's next step (`inspect`), so a
	 * decoder that throws is told apart from a note that could not be read.
	 */
	read(file: SessionHistoryFile, mode: SharedNoteReadMode): Promise<SharedNoteText> {
		if (mode === 'private') return this.readOnce(file, null);
		const shareable = this.listen();
		const flying = shareable && mode === 'join' ? this.flights.get(file.path) : undefined;
		if (flying !== undefined) return flying.read;
		const token = { done: false };
		const read = this.readOnce(file, token);
		// A read that failed before its first await has already finished: it is never offered to a later caller.
		if (shareable && !token.done) this.flights.set(file.path, { token, read });
		return read;
	}

	/** Stops following changes for good: a read or a scan that ends after this neither subscribes again nor hands anything on. */
	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.stopListening?.();
		this.stopListening = null;
		this.flights.clear();
		this.lastChange.clear();
	}

	/**
	 * Reads one note; `token` is null for a private read, which nobody else sees. The read counts as under way, for `stale`,
	 * until its text has been inspected and handed to the peers (`settle`), or until the read itself failed.
	 */
	private async readOnce(file: SessionHistoryFile, token: { done: boolean } | null): Promise<SharedNoteText> {
		const generation = this.generation;
		const since = this.changes;
		this.pending += 1;
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			if (token !== null) {
				token.done = true;
				if (this.flights.get(file.path)?.token === token) this.flights.delete(file.path);
			}
			this.pending -= 1;
			if (this.pending === 0) this.lastChange.clear();
		};
		let handedOver = false;
		try {
			const content = await this.vault.read(file);
			let inspection: Promise<SharedNoteRead> | null = null;
			handedOver = true;
			// Inspected on the first ask only, so a caller awaits it as soon as it starts and every joiner shares it.
			return { content, inspect: () => inspection ??= this.inspectAndShare(file, content, token, generation, since, settle) };
		} finally {
			if (!handedOver) settle();
		}
	}

	private async inspectAndShare(file: SessionHistoryFile, content: string, token: object | null, generation: number, since: number,
		settle: () => void): Promise<SharedNoteRead> {
		try {
			const read = await inspectNoteForHistories(content);
			if (token !== null && generation === this.generation) {
				const stale = (this.lastChange.get(file.path) ?? 0) > since;
				for (const peer of this.peers) peer(file, read, stale);
			}
			return read;
		} finally {
			settle();
		}
	}

	private noteChanged(change: SessionHistoryNoteChange): void {
		this.changes += 1;
		for (const path of change.oldPath === undefined ? [change.path] : [change.path, change.oldPath]) {
			if (this.pending > 0) this.lastChange.set(path, this.changes);
			this.flights.delete(path);
		}
		for (const follower of this.changeFollowers) follower(change);
	}
}

/** Both histories' inspection of one note text, the live one computed once and handed to the durable one. */
async function inspectNoteForHistories(content: string): Promise<SharedNoteRead> {
	const live = await inspectLiveSessionNote(content);
	const durable = await inspectDurableSessionNote(content, live);
	const outcome: LiveHistoryNoteOutcome = live.status === 'invalid' ? { kind: 'invalid' }
		: live.status === 'unsupported' ? { kind: 'unsupported' }
			: live.status === 'non_candidate' ? (durable.status === 'invalid' ? { kind: 'invalid' } : { kind: 'ignored' })
				: { kind: 'live', session: live.session };
	return { content, durable, live: outcome, liveBytes: outcome.kind === 'live' ? content.length : 0 };
}

/** The live history's inspection of one note, for a live history that shares no reads. */
export async function inspectLiveHistoryNote(content: string): Promise<{ outcome: LiveHistoryNoteOutcome; bytes: number }> {
	const read = await inspectNoteForHistories(content);
	return { outcome: read.live, bytes: read.liveBytes };
}

/** Explicit, Vault-wide export of validated durable session notes. */
export class SessionHistoryService {
	private exportFlight: Promise<SessionHistoryExportResult> | null = null;
	private scrubFlight: Promise<SessionHistoryScrubResult> | null = null;
	private readonly scrubPlans = new Map<string, readonly ScrubPlanItem[]>();
	/**
	 * What the last read of each note decoded to, by path (audit 2.2). It covers the whole vault,
	 * never one folder: a moved session note still counts, and corrupt and duplicated ones are
	 * still found. Only what `decodeDurableSession` answered is kept, never the note's text.
	 *
	 * Nothing here is trusted by date. An entry is reused for one reason only: the host promised
	 * to name every note it changes (`onNoteChange`), and it has not named this one since it was
	 * read. A modification date is not even carried by the port, so a note edited without its date
	 * moving cannot be taken for unchanged. The index lives in memory and dies with the runtime, so
	 * an edit made while the host was closed is read on the next start; an edit a running host
	 * fails to report is the one case it cannot see, and `rebuild` (the explicit "refresh history")
	 * reads past it.
	 *
	 * Since Z24 the index also keeps what the live history read (`noteReads`), under the same rule: a note named in a change
	 * while it was being read is not kept, and nothing read before a `dispose` is.
	 */
	private readonly index = new Map<string, DurableSessionNoteInspection>();
	/** Every read of a note this history makes, shared with the live history of the same run (Z24). */
	readonly noteReads: SessionNoteReads;

	constructor(
		private readonly vault: SessionHistoryVault,
		private readonly diagnostics?: LocalDebugActionPort,
	) {
		this.noteReads = new SessionNoteReads(vault);
		this.noteReads.followChanges((change) => { this.forgetNote(change); });
		this.noteReads.share((file, read, stale) => { this.keepRead(file, read, stale); });
	}

	/**
	 * Records the only local trace a durable-Vault rejection leaves here: every catch below
	 * already has its own closed status to return (H15.15, 2026-09-10 incident), so this never
	 * changes that outcome, only whether the local debug log learns it happened at all.
	 */
	private logFailure(action: 'vault_read' | 'vault_write', state: string, error: unknown): void {
		this.diagnostics?.event({
			component: 'vault', action, level: 'error', phase: 'failure', code: 'storage_failure',
			state, details: unmappedErrorLogDetails(error),
		});
	}

	/**
	 * Validates every durable note of the vault. `source` only decides how many are READ to do it
	 * (`SessionHistoryScanSource`); the answer is the one a scan that reads them all gives.
	 */
	async scan(source: SessionHistoryScanSource = 'vault'): Promise<SessionHistoryScan> {
		try {
			const index = source === 'vault' ? null : this.openIndex();
			if (source === 'rebuild') index?.clear();
			const sessions: DurableSessionHistoryRecord[] = [];
			let ignored = 0;
			let invalid = 0;
			const files = this.vault.markdownFiles();
			if (index !== null) {
				// Create, delete and rename are settled from the listing itself, with or without their
				// event: a path the host no longer lists is forgotten, and one never seen is read below.
				const listed = new Set(files.map((file) => file.path));
				for (const path of index.keys()) if (!listed.has(path)) index.delete(path);
			}
			for (const file of files) {
				let decoded = index?.get(file.path);
				if (decoded === undefined) {
					// The export reads on its own; the history's loads share the read with the live history, which keeps it too.
					// What is remembered is decided in `keepRead`, never here.
					let text: SharedNoteText;
					try { text = await this.noteReads.read(file, source === 'vault' ? 'private' : source === 'rebuild' ? 'fresh' : 'join'); }
					catch { invalid += 1; continue; }
					// A decoder that throws leaves the note invalid, as it blocks the history, and the scan goes on; unlike a read the
					// host refused, it is a fault of this build, so it reaches the log.
					try { decoded = (await text.inspect()).durable; }
					catch (error) { invalid += 1; this.logFailure('vault_read', 'scan', error); continue; }
				}
				// The path is where the note is NOW, so it is stamped on the way out and never kept in the index.
				if (decoded.status === 'ok') sessions.push({ ...decoded.session, notePath: file.path });
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
		} catch (error) {
			this.logFailure('vault_read', 'scan', error);
			return { status: 'conflict', invalid: 1, duplicates: 0 };
		}
	}

	/**
	 * The index, listening for changes from its first use; `null` on a host that does not promise
	 * to report them (`SessionHistoryVault.onNoteChange`), where nothing may be kept between scans.
	 */
	private openIndex(): Map<string, DurableSessionNoteInspection> | null {
		return this.noteReads.listen() ? this.index : null;
	}

	/** Drops what is remembered about a changed note. It reads nothing: the next index scan does. */
	private forgetNote(change: SessionHistoryNoteChange): void {
		for (const path of change.oldPath === undefined ? [change.path] : [change.path, change.oldPath]) this.index.delete(path);
	}

	/**
	 * Keeps what a shared read decoded, whichever history made it. Only while the host's changes are followed, and never a read
	 * the host named in a change while it was under way: the text just inspected may already be the old one.
	 */
	private keepRead(file: SessionHistoryFile, read: SharedNoteRead, stale: boolean): void {
		if (stale || !this.noteReads.listening()) return;
		this.index.set(file.path, read.durable);
	}

	/**
	 * Looks up one durable note for startup recovery without ever entering a write path. It goes through the index (Z24): a
	 * note already inspected in this run is not read again, and what it reads is kept for the history and the live list, so
	 * their first load after it reads nothing. Every listed note still counts, wherever it is.
	 */
	async readSession(sessionRef: string): Promise<DurableSessionLookup> {
		try {
			const index = this.openIndex();
			const matches: Array<{ file: SessionHistoryFile; content: string | null }> = [];
			let unreadable = false;
			for (const file of this.vault.markdownFiles()) {
				let decoded = index?.get(file.path);
				let content: string | null = null;
				if (decoded === undefined) {
					let text: SharedNoteText;
					try { text = await this.noteReads.read(file, 'join'); }
					catch (error) { unreadable = true; this.logFailure('vault_read', 'read_session', error); continue; }
					// A decoder that throws ends the lookup in the catch below, logged and `unavailable`, as before Z24.
					decoded = (await text.inspect()).durable;
					content = text.content;
				}
				if (decoded.status !== 'ok' || decoded.session.sessionRef !== sessionRef) continue;
				matches.push({ file, content });
			}
			if (matches.length > 1) return { status: 'conflict' };
			if (matches.length === 0) return { status: unreadable ? 'unavailable' : 'missing' };
			// An inspection taken from the index carries no text: the one note found is read for its loot summary, and decoded
			// again from that text so the session and the summary come from the same bytes.
			const match = matches[0]!;
			const content = match.content ?? await this.vault.read(match.file);
			const decoded = await decodeDurableSession(content);
			if (decoded.status !== 'ok' || decoded.session.sessionRef !== sessionRef) return { status: 'missing' };
			return { status: 'found', path: match.file.path, session: decoded.session, loot: await inspectStoredSessionLootSummary(content) };
		} catch (error) {
			this.logFailure('vault_read', 'read_session', error);
			return { status: 'unavailable' };
		}
	}

	/**
	 * Reads the one note a completed session was written to (H18.8), instead of every Markdown file
	 * in the vault. A note moved or renamed since reads as `missing`; that never undoes the fact
	 * that it was saved, it only means its stored loot summary is not shown.
	 */
	async readSessionAt(path: string, sessionRef: string): Promise<DurableSessionLookup> {
		try {
			const file = this.vault.file(path);
			if (file === null) return { status: 'missing' };
			const content = await this.vault.read(file);
			const decoded = await decodeDurableSession(content);
			if (decoded.status !== 'ok' || decoded.session.sessionRef !== sessionRef) return { status: 'missing' };
			return { status: 'found', path: file.path, session: decoded.session, loot: await inspectStoredSessionLootSummary(content) };
		} catch (error) {
			this.logFailure('vault_read', 'read_session', error);
			return { status: 'unavailable' };
		}
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
		} catch (error) {
			this.logFailure('vault_read', 'scrub_preview', error);
			return { status: 'unavailable', message: 'History scrub could not be prepared safely.' };
		}
	}

	revokeScrub(token: string): void { this.scrubPlans.delete(token); }

	dispose(): void {
		this.scrubPlans.clear();
		this.noteReads.dispose();
		this.index.clear();
	}

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
				catch (error) {
					if (this.vault.file(item.path) === null) {
						return { status: 'conflict', ...progress, message: 'A scrub target was deleted, renamed, or is no longer a file.' };
					}
					this.logFailure('vault_read', 'scrub', error);
					return { status: 'unavailable', ...progress, message: 'A scrub target could not be read safely.' };
				}
				if (await sha256Text(before) !== item.expectedHash || before !== item.expectedContent) {
					if (before === item.scrubbedContent) { progress.alreadyAbsent += 1; continue; }
					return { status: 'conflict', ...progress, message: 'A scrub target changed after preview.' };
				}
				const outcome: { value: 'erased' | 'changed' } = { value: 'changed' };
				let current = '';
				if (!lease.isLive()) return { status: 'blocked', ...progress, message: 'Session runtime, recovery, or detector is not idle.' };
				try {
					// Decided on every run, not latched: a host may re-run the update on a fresh read, and
					// only the run whose result it wrote may count as an erasure.
					await this.vault.process(file, (value) => {
						current = value;
						outcome.value = value === item.expectedContent ? 'erased' : 'changed';
						return outcome.value === 'erased' ? item.scrubbedContent : value;
					});
				} catch (error) {
					if (this.vault.file(item.path) === null) {
						return { status: 'conflict', ...progress, message: 'A scrub target was deleted, renamed, or is no longer a file.' };
					}
					this.logFailure('vault_write', 'scrub', error);
					return { status: 'unavailable', ...progress, message: 'A scrub target could not be updated safely.' };
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
			const live = await inspectLiveSessionNote(content);
			// A note of a newer payload format cannot be scrubbed by a build that cannot read it: the plan fails closed, as for an unreadable one.
			if (live.status === 'unsupported') { invalid += 1; continue; }
			const decoded = live.status === 'ok' ? live : await decodeDurableSession(content);
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
		} catch (error) {
			this.logFailure('vault_write', 'export', error);
			return { status: 'unavailable', message: 'History export could not be created safely.' };
		}
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
/** `live` is the note's live inspection when the caller already has it (`SessionNoteReads`); it is computed here otherwise. */
export async function inspectDurableSessionNote(content: string, known?: LiveSessionNoteInspection): Promise<DurableSessionNoteInspection> {
	if (declaresOtherTyrianNoteKind(content)) return { status: 'non_candidate' };
	const live = known ?? await inspectLiveSessionNote(content);
	if (live.status === 'ok') return { status: 'non_candidate' };
	if (live.status === 'invalid') return { status: 'invalid' };
	// A live note of a newer payload format is none of the durable (API) history's business, and no reason to fail it.
	if (live.status === 'unsupported') return { status: 'non_candidate' };
	const note = await inspectStoredSessionNote(content);
	if (note === null) return { status: hasTcHint(content) ? 'invalid' : 'non_candidate' };
	const fm = note.frontmatter;
	if (Object.keys(fm).length === 0) return { status: 'non_candidate' };
	if (fm.tc_kind !== 'gw2_farming_session' ||
		(fm.tc_schema !== 1 && fm.tc_schema !== 2 && fm.tc_schema !== 3 && fm.tc_schema !== 4 && fm.tc_schema !== 5 && fm.tc_schema !== 6) ||
		!hasExactKeys(fm, [...sessionKeysFor(fm.tc_schema),
			...(fm.tc_schema === 6 && fm.tc_comparison_json !== undefined ? ['tc_comparison_json'] : []),
			...(fm.tc_schema === 6 && fm.tc_sack_observation_json !== undefined ? ['tc_sack_observation_json'] : []),
			...(fm.tc_schema === 6 && fm.tc_farming_goal_json !== undefined ? ['tc_farming_goal_json'] : []),
			...(fm.tc_schema === 6 && fm.tc_farming_goal_result_json !== undefined ? ['tc_farming_goal_result_json'] : [])]) ||
		!note.managedBlocksValid || note.hasInvalidScalar) return { status: 'invalid' };
	const farmingGoal = parseOptionalJson(fm.tc_farming_goal_json, isFarmingGoal);
	const farmingGoalResult = parseOptionalJson(fm.tc_farming_goal_result_json, isFarmingGoalProgress);
	if ((fm.tc_farming_goal_json !== undefined && farmingGoal === null) ||
		(fm.tc_farming_goal_result_json !== undefined && (farmingGoalResult === null ||
		canonicalJson(farmingGoal) !== canonicalJson(farmingGoalResult.goal)))) return { status: 'invalid' };
	const comparisonMetadata = parseDurableSessionComparison(fm.tc_comparison_json);
	const sackObservation = parseSessionSackObservation(fm.tc_sack_observation_json);
	if ((fm.tc_comparison_json !== undefined && comparisonMetadata === null) ||
		(fm.tc_sack_observation_json !== undefined && sackObservation === null)) return { status: 'invalid' };
	const sessionRef = fm.tc_session_ref;
	const accountRef = fm.tc_account_ref;
	const startedAt = fm.tc_started_at;
	const endedAt = fm.tc_ended_at;
	const durationMs = fm.tc_duration_ms;
	const classification = fm.tc_classification;
	const confidence = fm.tc_confidence;
	const scope = fm.tc_scope;
	// H18.11: from schema 5 the duration is the active time; before it there was nothing to subtract.
	const unobservedMs = fm.tc_schema === 5 || fm.tc_schema === 6 ? fm.tc_unobserved_ms : 0;
	// From schema 6 a note says whether its session completed or was abandoned (and why); an
	// abandoned one measured nothing, so it carries no classification at all.
	const outcome = fm.tc_schema === 6 ? fm.tc_outcome : 'completed';
	const abandoned = outcome === 'abandoned';
	if (!isRef(sessionRef) || !isRef(accountRef) || !iso(startedAt) || !iso(endedAt) || !safePositive(durationMs) ||
		!safeNonNegative(unobservedMs) || !validOutcome(fm) ||
		Date.parse(endedAt) - Date.parse(startedAt) - unobservedMs !== durationMs ||
		(abandoned
			? classification !== null || confidence !== null
			: !enumValue(classification, ['exact', 'estimated', 'contaminated']) || !enumValue(confidence, ['high', 'medium', 'low'])) ||
		scope !== 'observed_storage_net' || !isSessionMetadata(fm)) return { status: 'invalid' };
	const carriesItemDeltas = fm.tc_schema === 3 || fm.tc_schema === 4 || fm.tc_schema === 5 || fm.tc_schema === 6;
	const positiveItemDeltas = carriesItemDeltas ? parsePositiveItemDeltas(fm.tc_positive_item_deltas_json) : null;
	if (carriesItemDeltas && positiveItemDeltas === null) return { status: 'invalid' };
	// The results table is read back the same way `readSession` already does for a single note
	// (H9.5); this just reuses that codec here too, so the history scan carries the gains list
	// without a second Vault-wide pass (H18.10).
	const lootSummary = await inspectStoredSessionLootSummary(content);
	return { status: 'ok', session: {
		sessionRef, accountRef,
		...(farmingGoal ? { farmingGoal } : {}),
		...(farmingGoalResult ? { farmingGoalResult } : {}),
		...(comparisonMetadata ? { comparisonMetadata } : {}),
		...(sackObservation ? { sackObservation } : {
			legacyPositiveNetSacks: positiveItemDeltas?.find(({ itemId }) => itemId === 36038)?.quantity ?? null,
		}),
		activity: fm.tc_schema === 1 ? null : fm.tc_event as 'halloween' | null,
		build: nullableString(fm.tc_build),
		startedAt, endedAt, durationMs,
		outcome: abandoned ? 'abandoned' : 'completed',
		classification: abandoned ? 'abandoned' : classification as string,
		confidence: abandoned ? 'none' : confidence as string,
		scope,
		valuationCoverage: stringOr(fm.tc_valuation_coverage), observedImmediateCopper: numberOrNull(fm.tc_observed_immediate_copper),
		observedListingCopper: numberOrNull(fm.tc_observed_listing_copper), sacks: numberOrNull(fm.tc_sacks),
		sacksPerHourMilli: numberOrNull(fm.tc_sacks_per_hour_milli), immediateCopperPerHour: numberOrNull(fm.tc_immediate_copper_per_hour),
		listingCopperPerHour: numberOrNull(fm.tc_listing_copper_per_hour), recommendationStatus: stringOr(fm.tc_recommendation_status),
		recommendationAction: nullableString(fm.tc_recommendation_action), recommendationQuantity: numberOrNull(fm.tc_recommendation_quantity),
		recommendationRoute: nullableString(fm.tc_recommendation_route),
		lootRows: lootSummary?.rows ?? [],
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
		isV2Metadata(fm) && isV4MagicFindMetadata(fm);
}

/**
 * Schema 4 records where the magic find total came from and how much of it the player declared
 * by hand. Notes written before it carry neither key, and `hasExactKeys` already rejected any
 * that did, so there is nothing to validate for them.
 */
function isV4MagicFindMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_schema !== 4 && fm.tc_schema !== 5 && fm.tc_schema !== 6) return true;
	return enumValue(fm.tc_magic_find_source, ['derived', 'manual', 'unavailable']) &&
		safeNonNegative(fm.tc_magic_find_consumables) &&
		fm.tc_magic_find_consumables <= (fm.tc_magic_find as number);
}

/** The exact key set a note of this schema must carry, no more and no less. */
function sessionKeysFor(schema: 1 | 2 | 3 | 4 | 5 | 6): readonly string[] {
	if (schema === 1) return V1_SESSION_KEYS;
	if (schema === 2) return V2_SESSION_KEYS;
	if (schema === 5) return V5_SESSION_KEYS;
	if (schema === 6) return V6_SESSION_KEYS;
	return schema === 3 ? V3_SESSION_KEYS : V4_SESSION_KEYS;
}

/**
 * Schema 6: `completed` carries no reason; `abandoned` carries one of the known reasons and no
 * value, rate or loot at all, so nothing can read it as a measured result.
 */
function validOutcome(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_schema !== 6) return true;
	if (fm.tc_outcome === 'completed') return fm.tc_abandon_reason === null;
	return fm.tc_outcome === 'abandoned'
		&& (SESSION_ABANDON_REASONS as readonly unknown[]).includes(fm.tc_abandon_reason)
		&& fm.tc_valuation_coverage === 'not_evaluated'
		&& fm.tc_positive_item_deltas_json === '[]';
}

/** The renderer derives confidence from classification; no other pair is durable. */
function validClassificationMetadata(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_schema === 6 && fm.tc_outcome === 'abandoned') return fm.tc_classification === null && fm.tc_confidence === null;
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
	const hourly = evidence.slice(3);
	// Net copper includes observed spending; quantities remain nonnegative.
	if (![fm.tc_observed_immediate_copper, fm.tc_observed_listing_copper].every(safeInteger) ||
		!safeNonNegative(fm.tc_sacks)) return false;
	return fm.tc_classification === 'estimated'
		? hourly.every((value) => value === null)
		: safeNonNegative(fm.tc_sacks_per_hour_milli) &&
			[fm.tc_immediate_copper_per_hour, fm.tc_listing_copper_per_hour].every(safeInteger);
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
		(fm.tc_event_source === null || fm.tc_event_source === 'manual_explicit' || fm.tc_event_source === 'assisted'
			|| fm.tc_event_source === 'ingame_presence') &&
		(fm.tc_event === null ? fm.tc_event_source === null : fm.tc_event_source !== null) &&
		validRecommendationMetadata(fm) && validPositiveItemDeltas(fm);
}

function validPositiveItemDeltas(fm: Readonly<Record<string, string | number | null>>): boolean {
	if (fm.tc_schema !== 3 && fm.tc_schema !== 4 && fm.tc_schema !== 5 && fm.tc_schema !== 6) return true;
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
	return `${JSON.stringify({
		format: 'tyrian-companion-session-export',
		version: SESSION_HISTORY_EXPORT_VERSION,
		sessions: sessions.map(exportSession),
	}, null, 2)}\n`;
}

/** Export v1 is an explicit allowlist; local activity/build/loot-row dimensions never cross this boundary. */
function exportSession(session: DurableSessionHistoryRecord): Omit<DurableSessionHistoryRecord, 'activity' | 'build' | 'lootRows' | 'comparisonMetadata' | 'sackObservation' | 'farmingGoal' | 'farmingGoalResult' | 'legacyPositiveNetSacks'> {
	return {
		sessionRef: session.sessionRef,
		accountRef: session.accountRef,
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		durationMs: session.durationMs,
		classification: session.classification,
		confidence: session.confidence,
		scope: session.scope,
		valuationCoverage: session.valuationCoverage,
		observedImmediateCopper: session.observedImmediateCopper,
		observedListingCopper: session.observedListingCopper,
		sacks: session.sacks,
		sacksPerHourMilli: session.sacksPerHourMilli,
		immediateCopperPerHour: session.immediateCopperPerHour,
		listingCopperPerHour: session.listingCopperPerHour,
		recommendationStatus: session.recommendationStatus,
		recommendationAction: session.recommendationAction,
		recommendationQuantity: session.recommendationQuantity,
		recommendationRoute: session.recommendationRoute,
	};
}
function serializeCsv(sessions: readonly DurableSessionHistoryRecord[]): string {
	const rows = [
		CSV_COLUMNS.map((column) => serializeCsvCell(column)).join(','),
		...sessions.map((session) => CSV_COLUMNS.map((column) => serializeCsvCell(valueForColumn(session, column))).join(',')),
	];
	return `${rows.join('\r\n')}\r\n`;
}
function valueForColumn(session: DurableSessionHistoryRecord, column: typeof CSV_COLUMNS[number]): string | number | null {
	const key = column.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()) as Exclude<keyof DurableSessionHistoryRecord, 'notePath' | 'lootRows' | 'outcome' | 'comparisonMetadata' | 'sackObservation' | 'farmingGoal' | 'farmingGoalResult' | 'legacyPositiveNetSacks'>;
	return session[key];
}
/**
 * RFC-style quoting plus spreadsheet formula protection after invisible prefixes. Protection is
 * for strings only: a `number` cannot be a formula, and prefixing a negative one turned it into
 * text (`'-4`) that a spreadsheet will not sum.
 */
export function serializeCsvCell(value: string | number | null): string {
	const text = value === null ? '' : String(value);
	const protectedText = typeof value === 'string' && /^[\s\p{Cc}]*[=+\-@]/u.test(text) ? `'${text}` : text;
	return `"${protectedText.replace(/"/gu, '""')}"`;
}
function compareSessions(a: DurableSessionHistoryRecord, b: DurableSessionHistoryRecord): number {
	return a.startedAt.localeCompare(b.startedAt) || a.endedAt.localeCompare(b.endedAt) || a.sessionRef.localeCompare(b.sessionRef);
}
/**
 * The history scan reads the whole vault, so it also meets the notes the plugin's other writers
 * leave there (inventory positions, wallet currencies, the collector status note). Those are not
 * sessions and must not read as corrupt ones: that blocked the whole history on any account that
 * had synced its inventory. Only a closed list of the kinds this plugin writes is exempt; an
 * unknown `tc_kind` keeps failing closed, because it can be a session note whose kind was damaged
 * and skipping it would drop it from both the history and the privacy scrub. For the same reason a
 * note that declares one of these kinds but carries a session's identity keys is not exempt.
 */
const OTHER_TYRIAN_NOTE_KINDS: ReadonlySet<string> = new Set([
	INVENTORY_NOTE_KIND, WALLET_NOTE_KIND, COLLECTOR_STATUS_NOTE_KIND,
]);
const SESSION_IDENTITY_KEYS: ReadonlySet<string> = new Set(['tc_session_ref', 'tc_account_ref']);

function declaresOtherTyrianNoteKind(content: string): boolean {
	if (!content.startsWith('---\n')) return false;
	const end = content.indexOf('\n---\n', 4);
	if (end < 0) return false;
	const kinds: string[] = [];
	for (const line of content.slice(4, end).split('\n')) {
		const match = /^(tc_[A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
		if (!match) continue;
		if (SESSION_IDENTITY_KEYS.has(match[1]!)) return false;
		if (match[1] === 'tc_kind') kinds.push(unquotedScalar(match[2] ?? ''));
	}
	return kinds.length === 1 && OTHER_TYRIAN_NOTE_KINDS.has(kinds[0]!);
}
function unquotedScalar(value: string): string {
	const trimmed = value.trim();
	const quoted = /^"([^"\\]*)"$|^'([^']*)'$/u.exec(trimmed);
	return quoted ? quoted[1] ?? quoted[2] ?? '' : trimmed;
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
function safeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function safeNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) ? value : null; }
function nullableString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function isNullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function stringOr(value: unknown): string { return typeof value === 'string' ? value : 'not_evaluated'; }

function parseOptionalJson<T>(value: unknown, validate: (candidate: unknown) => candidate is T): T | null {
	if (typeof value !== 'string') return null;
	try { const parsed: unknown = JSON.parse(value); return validate(parsed) ? parsed : null; }
	catch { return null; }
}
