import type { IngameBridgeErrorCode, IngameGameContext } from './alert-ingame-protocol';
import {
	LIVE_INGAME_BATCH_TIMEOUT_MS, LIVE_INGAME_MAX_PARTS, LIVE_INGAME_MAX_SAMPLE_BYTES,
	liveIngameSampleFingerprint, type LiveIngameBegin, type LiveIngameEnd, type LiveIngameRows,
	type LiveIngameRow, type LiveIngameSample, type LiveIngameSource,
} from './live-loot-protocol';

export type LiveAssemblyResult<T = undefined> = { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: IngameBridgeErrorCode };
export interface LiveAssembledSample { readonly sample: LiveIngameSample; readonly duplicate: boolean; }
interface PendingBatch {
	readonly begin: LiveIngameBegin; readonly beganAt: number; readonly rows: LiveIngameRow[];
	bytes: number; nextPart: number;
}

/** One epoch, one bounded atomic batch, one retained committed content identity. No IO or publication. */
export class LiveIngameAssembler {
	readonly source: LiveIngameSource;
	private contextSeq: number;
	private valid = true;
	private batch: PendingBatch | null = null;
	private awaitingCommit: LiveAssembledSample | null = null;
	private last: LiveIngameSample | null = null;

	constructor(source: LiveIngameSource, contextSeq: number) {
		this.source = Object.freeze({ ...source, context: Object.freeze({ ...source.context }) });
		this.contextSeq = contextSeq;
	}
	isValid(): boolean { return this.valid; }
	isCommitting(): boolean { return this.awaitingCommit !== null; }
	batchDeadline(): number | null { return this.batch === null ? null : this.batch.beganAt + LIVE_INGAME_BATCH_TIMEOUT_MS; }

	/** A periodic identical context updates only the transport reference; a real change cuts the epoch. */
	context(seq: number, context: IngameGameContext): boolean {
		this.contextSeq = seq;
		if (!sameContext(this.source.context, context)) { this.invalidate(); return false; }
		return true;
	}
	invalidate(): void { this.valid = false; this.batch = null; this.awaitingCommit = null; }

	begin(message: LiveIngameBegin, bytes: number, now: number): LiveAssemblyResult {
		if (!this.valid || message.epoch !== this.source.epoch) return failure('unexpected_message');
		if (this.batch !== null || this.awaitingCommit !== null) return failure('unexpected_message');
		const duplicate = this.last !== null && message.cursor === this.last.cursor;
		if (!duplicate && (this.last === null
			? message.cursor !== 0 || message.mode !== 'baseline' || message.ms !== 0
			: this.last.cursor === Number.MAX_SAFE_INTEGER || message.cursor !== this.last.cursor + 1
				|| message.mode !== 'sample' || message.ms <= this.last.sourceElapsedMs)) return failure('sequence_mismatch');
		if (message.ctx !== this.contextSeq && !(duplicate && message.ctx === this.last?.contextSeq)) return failure('sequence_mismatch');
		if (bytes > LIVE_INGAME_MAX_SAMPLE_BYTES) return failure('frame_length');
		this.batch = { begin: Object.freeze({ ...message }), beganAt: now, rows: [], bytes, nextPart: 0 };
		return { ok: true, value: undefined };
	}

	rows(message: LiveIngameRows, bytes: number, now: number): LiveAssemblyResult {
		const checked = this.check(message, bytes, now);
		if (!checked.ok) return checked;
		const batch = checked.value;
		if (message.part !== batch.nextPart || batch.nextPart >= LIVE_INGAME_MAX_PARTS) return failure('sequence_mismatch');
		if (batch.rows.length + message.rows.length > batch.begin.rows) return failure('frame_schema');
		for (const row of message.rows) {
			const previous = batch.rows[batch.rows.length - 1];
			if (previous !== undefined && (row[0] < previous[0] || (row[0] === previous[0] && row[1] <= previous[1]))) return failure('frame_schema');
			if ((row[0] === 0 && batch.begin.items === 'none') || (row[0] === 1 && batch.begin.currencies === 'none')) return failure('frame_schema');
			batch.rows.push(Object.freeze([row[0], row[1], row[2]]));
		}
		batch.nextPart += 1;
		return { ok: true, value: undefined };
	}

	end(message: LiveIngameEnd, bytes: number, now: number): LiveAssemblyResult<LiveAssembledSample> {
		const checked = this.check(message, bytes, now);
		if (!checked.ok) return checked;
		const batch = checked.value;
		if (batch.rows.length !== batch.begin.rows || (batch.begin.currencies === 'listed' && !batch.rows.some(([kind]) => kind === 1))) return failure('frame_schema');
		const sample: LiveIngameSample = Object.freeze({ ...this.source,
			contextSeq: batch.begin.ctx, cursor: batch.begin.cursor, sourceElapsedMs: batch.begin.ms,
			mode: batch.begin.mode, itemCoverage: batch.begin.items, currencyCoverage: batch.begin.currencies,
			unknownPositions: batch.begin.unknown, freeSlots: batch.begin.slots,
			rows: Object.freeze(batch.rows), observedAt: new Date(now).toISOString(),
		});
		const duplicate = this.last !== null && sample.cursor === this.last.cursor;
		if (duplicate && liveIngameSampleFingerprint(sample) !== liveIngameSampleFingerprint(this.last!)) return failure('frame_schema');
		this.batch = null;
		this.awaitingCommit = Object.freeze({ sample, duplicate });
		return { ok: true, value: this.awaitingCommit };
	}

	/** Advance only after a durable stored result; a duplicate preserves the original observation time. */
	stored(): void {
		if (this.awaitingCommit === null || !this.valid) return;
		if (!this.awaitingCommit.duplicate) this.last = this.awaitingCommit.sample;
		this.awaitingCommit = null;
	}

	private check(message: LiveIngameRows | LiveIngameEnd, bytes: number, now: number): LiveAssemblyResult<PendingBatch> {
		const batch = this.batch;
		if (!this.valid || batch === null || message.epoch !== this.source.epoch) return failure('unexpected_message');
		if (now - batch.beganAt >= LIVE_INGAME_BATCH_TIMEOUT_MS) { this.invalidate(); return failure('unexpected_message'); }
		if (message.cursor !== batch.begin.cursor) return failure('sequence_mismatch');
		batch.bytes += bytes;
		if (batch.bytes > LIVE_INGAME_MAX_SAMPLE_BYTES) { this.invalidate(); return failure('frame_length'); }
		return { ok: true, value: batch };
	}
}

function sameContext(left: IngameGameContext, right: IngameGameContext): boolean {
	return left.state === right.state && left.mapId === right.mapId && left.character === right.character;
}
function failure(code: IngameBridgeErrorCode): { readonly ok: false; readonly code: IngameBridgeErrorCode } {
	return { ok: false, code };
}
