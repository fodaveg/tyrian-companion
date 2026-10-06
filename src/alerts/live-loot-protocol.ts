import { validIngameBridgeId, type IngameGameContext, type IngameParseResult, type IngameBridgeVersion } from './alert-ingame-protocol';

export const LIVE_INGAME_TAG = 'live1' as const;
export const LIVE_INGAME_PROFILE = 'owned-bags-v3' as const;
export const LIVE_INGAME_BUILD = '27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c';
export const LIVE_INGAME_MAX_ROWS = 4_096;
export const LIVE_INGAME_MAX_PARTS = 512;
export const LIVE_INGAME_MAX_SAMPLE_BYTES = 256 * 1_024;
export const LIVE_INGAME_BATCH_TIMEOUT_MS = 10_000;
export const LIVE_INGAME_STALE_MS = 5_000;

export type LiveIngameRow = readonly [kind: 0 | 1, id: number, quantity: number];
export type LiveIngameReadyStatus = 'ready' | 'source_conflict' | 'unsupported_build' | 'not_gameplay';
export type LiveIngameAckStatus = 'stored' | 'storage_unavailable' | 'not_owner';
export type LiveIngameGapReason = 'disconnect' | 'source_stale' | 'read_failed' | 'partial_inventory' | 'context_changed' | 'host_restart' | 'storage_unavailable' | 'unsupported_build' | 'source_missing' | 'cursor_gap';
export type LiveIngameUnavailableReason = 'unsupported_build' | 'root_unavailable' | 'read_failed' | 'partial_inventory' | 'not_gameplay';

/** Source identity stays local to the host; it is not an API account identity. */
export interface LiveIngameSource {
	readonly sourceInstance: string;
	readonly epoch: string;
	readonly build: string;
	readonly profile: typeof LIVE_INGAME_PROFILE;
	readonly context: IngameGameContext;
}

/** Atomic read-only transport sample. The runtime converts tuples to its durable domain model. */
export interface LiveIngameSample extends LiveIngameSource {
	readonly contextSeq: number;
	readonly cursor: number;
	readonly sourceElapsedMs: number;
	readonly mode: 'baseline' | 'sample';
	readonly itemCoverage: 'complete' | 'partial' | 'none';
	readonly currencyCoverage: 'none' | 'listed';
	readonly unknownPositions: number;
	readonly freeSlots: number | null;
	readonly rows: readonly LiveIngameRow[];
	readonly observedAt: string;
}

export interface LiveIngameGap {
	readonly sourceInstance: string;
	readonly epoch: string | null;
	readonly reason: LiveIngameGapReason;
	readonly observedAt: string;
}

/** All success acknowledgements wait for the session owner's durable result. */
export interface LiveIngamePort {
	open(source: LiveIngameSource): Promise<LiveIngameReadyStatus>;
	commit(sample: LiveIngameSample): Promise<LiveIngameAckStatus>;
	gap(event: LiveIngameGap): Promise<void>;
	/** Diagnostics remain host-local; neither exception text nor raw frames are returned to the addon. */
	onError(error: unknown): void;
}

interface LiveIngameHeader {
	readonly v: 3; readonly nonce: string; readonly seq: number; readonly tag: typeof LIVE_INGAME_TAG;
}
export interface LiveIngameOpen extends LiveIngameHeader {
	readonly type: 'live_open'; readonly epoch: string; readonly build: string; readonly profile: typeof LIVE_INGAME_PROFILE;
}
export interface LiveIngameBegin extends LiveIngameHeader {
	readonly type: 'live_begin'; readonly epoch: string; readonly cursor: number; readonly ctx: number; readonly ms: number;
	readonly mode: 'baseline' | 'sample'; readonly items: 'complete' | 'partial' | 'none';
	readonly currencies: 'none' | 'listed'; readonly unknown: number; readonly slots: number | null; readonly rows: number;
}
export interface LiveIngameRows extends LiveIngameHeader {
	readonly type: 'live_rows'; readonly epoch: string; readonly cursor: number; readonly part: number; readonly rows: readonly LiveIngameRow[];
}
export interface LiveIngameEnd extends LiveIngameHeader {
	readonly type: 'live_end'; readonly epoch: string; readonly cursor: number;
}
export interface LiveIngameStatus extends LiveIngameHeader {
	readonly type: 'live_status'; readonly epoch: string | null; readonly status: 'unavailable'; readonly reason: LiveIngameUnavailableReason;
}
export type LiveIngameMessage = LiveIngameOpen | LiveIngameBegin | LiveIngameRows | LiveIngameEnd | LiveIngameStatus;

const KEYS = {
	live_open: ['v', 'type', 'nonce', 'seq', 'tag', 'epoch', 'build', 'profile'],
	live_begin: ['v', 'type', 'nonce', 'seq', 'tag', 'epoch', 'cursor', 'ctx', 'ms', 'mode', 'items', 'currencies', 'unknown', 'slots', 'rows'],
	live_rows: ['v', 'type', 'nonce', 'seq', 'tag', 'epoch', 'cursor', 'part', 'rows'],
	live_end: ['v', 'type', 'nonce', 'seq', 'tag', 'epoch', 'cursor'],
	live_status: ['v', 'type', 'nonce', 'seq', 'tag', 'epoch', 'status', 'reason'],
} as const;

export function isLiveIngameType(type: unknown): type is keyof typeof KEYS {
	return typeof type === 'string' && Object.prototype.hasOwnProperty.call(KEYS, type);
}

/** Strict extension parser; framing/UTF-8/duplicate keys are checked by the existing bridge decoder. */
export function parseLiveIngameMessage(
	record: Record<string, unknown>, expected: { readonly nonce: string; readonly seq: number }, version: IngameBridgeVersion,
): IngameParseResult<LiveIngameMessage> {
	if (version !== 3 || !isLiveIngameType(record.type)) return { ok: false, code: 'unexpected_message' };
	if (record.v !== 3 || !exactKeys(record, KEYS[record.type]) || record.tag !== LIVE_INGAME_TAG) return { ok: false, code: 'frame_schema' };
	if (record.nonce !== expected.nonce) return { ok: false, code: 'nonce_mismatch' };
	if (!integer(record.seq) || record.seq !== expected.seq) return { ok: false, code: 'sequence_mismatch' };
	const nullableEpoch = record.type === 'live_status' && record.epoch === null;
	if (!nullableEpoch && !validIngameBridgeId(record.epoch)) return { ok: false, code: 'frame_schema' };
	let valid = false;
	switch (record.type) {
		case 'live_open': valid = typeof record.build === 'string' && /^[a-f0-9]{64}$/u.test(record.build) && record.profile === LIVE_INGAME_PROFILE; break;
		case 'live_begin': valid = integer(record.cursor) && integer(record.ctx) && integer(record.ms)
			&& enumValue(record.mode, ['baseline', 'sample']) && enumValue(record.items, ['complete', 'partial', 'none'])
			&& enumValue(record.currencies, ['none', 'listed']) && integer(record.unknown, LIVE_INGAME_MAX_ROWS)
			&& (record.slots === null || integer(record.slots, LIVE_INGAME_MAX_ROWS)) && integer(record.rows, LIVE_INGAME_MAX_ROWS)
			&& (record.items !== 'complete' || record.unknown === 0); break;
		case 'live_rows': valid = integer(record.cursor) && integer(record.part, LIVE_INGAME_MAX_PARTS - 1)
			&& Array.isArray(record.rows) && record.rows.length >= 1 && record.rows.length <= 8 && record.rows.every(validRow); break;
		case 'live_end': valid = integer(record.cursor); break;
		case 'live_status': valid = record.status === 'unavailable'
			&& enumValue(record.reason, ['unsupported_build', 'root_unavailable', 'read_failed', 'partial_inventory', 'not_gameplay']); break;
	}
	return valid ? { ok: true, value: record as unknown as LiveIngameMessage } : { ok: false, code: 'frame_schema' };
}

/** Responses have no independent sequence and cannot become alert receipts. */
export function liveIngameCapabilityLine(nonce: string): string {
	return JSON.stringify({ v: 3, type: 'live_cap', nonce, tag: LIVE_INGAME_TAG });
}
export function liveIngameReadyLine(nonce: string, epoch: string, status: LiveIngameReadyStatus): string {
	return JSON.stringify({ v: 3, type: 'live_ready', nonce, tag: LIVE_INGAME_TAG, epoch, status });
}
export function liveIngameAckLine(nonce: string, epoch: string, cursor: number, status: LiveIngameAckStatus): string {
	return JSON.stringify({ v: 3, type: 'live_ack', nonce, tag: LIVE_INGAME_TAG, epoch, cursor, status });
}

/** Stable content identity excludes connection nonce, transport seq, chunking and receive date. */
export function liveIngameSampleFingerprint(sample: LiveIngameSample): string {
	return JSON.stringify([sample.sourceInstance, sample.epoch, sample.build, sample.profile,
		sample.context.state, sample.context.mapId, sample.context.character, sample.cursor, sample.contextSeq,
		sample.sourceElapsedMs, sample.mode, sample.itemCoverage, sample.currencyCoverage,
		sample.unknownPositions, sample.freeSlots, sample.rows]);
}

function enumValue(value: unknown, choices: readonly string[]): boolean {
	return typeof value === 'string' && choices.includes(value);
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function validRow(value: unknown): value is LiveIngameRow {
	return Array.isArray(value) && value.length === 3 && (value[0] === 0 || value[0] === 1)
		&& integer(value[1], 2_147_483_647) && value[1] > 0 && integer(value[2], 2_147_483_647);
}
function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}
