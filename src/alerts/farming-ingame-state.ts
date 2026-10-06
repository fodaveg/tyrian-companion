import { INGAME_BRIDGE_MAX_LINE_BYTES } from './alert-ingame-protocol';

export const FARMING_INGAME_TAG = 'farm1' as const;
export const FARMING_INGAME_REFRESH_MS = 5_000;

/** A read-only projection: names, identifiers, prices and credentials never enter this DTO. */
export interface FarmingIngameState {
	phase: 'idle' | 'starting' | 'active' | 'stopping' | 'provisional' | 'complete' | 'error' | 'abandoned';
	err: 'start' | 'observe' | 'stop' | 'save' | 'other' | null;
	elapsed: number | null;
	observed: number | null;
	net: number | null;
	lo: number | null;
	hi: number | null;
	age: number | null;
	slots: number | null;
	slotSrc: 'ingame' | 'recent' | 'unknown';
	slotAge: number | null;
	goal: 'none' | 'bags' | 'duration';
	target: number | null;
	progress: number | null;
	eta: number | null;
	mf: number | null;
	mfKind: 'partial' | 'unknown';
	prep: 'partial' | 'attention' | 'unknown';
}

/** Unknown evidence stays null; zero is reserved for a measured zero. */
export function emptyFarmingIngameState(): FarmingIngameState {
	return {
		phase: 'idle', err: null, elapsed: null, observed: null, net: null, lo: null, hi: null,
		age: null, slots: null, slotSrc: 'unknown', slotAge: null, goal: 'none', target: null,
		progress: null, eta: null, mf: null, mfKind: 'unknown', prep: 'unknown',
	};
}

/** Capability stays separate from welcome, so an existing v3 client can ignore this new type. */
export function farmingIngameCapabilityLine(nonce: string): string {
	return JSON.stringify({ v: 3, type: 'farming_cap', nonce, tag: FARMING_INGAME_TAG });
}

/** Closed, bounded frame. Explicit projection discards runtime-only or accidental extra fields. */
export function farmingIngameStateLine(state: FarmingIngameState, nonce: string, seq: number): string {
	if (!Number.isInteger(seq) || seq < 1 || seq > 2_147_483_647) throw new Error('Invalid farming sequence.');
	const frame = {
		v: 3, type: 'farming_state', tag: FARMING_INGAME_TAG, nonce, seq, ttl: 15,
		phase: state.phase, err: state.err,
		elapsed: metric(state.elapsed), observed: metric(state.observed), net: metric(state.net, true),
		lo: metric(state.lo), hi: metric(state.hi), age: metric(state.age), slots: metric(state.slots),
		slotSrc: state.slotSrc, slotAge: metric(state.slotAge), goal: state.goal,
		target: metric(state.target), progress: metric(state.progress), eta: metric(state.eta),
		mf: metric(state.mf), mfKind: state.mfKind, prep: state.prep,
	};
	const line = JSON.stringify(frame);
	if (new TextEncoder().encode(line).byteLength > INGAME_BRIDGE_MAX_LINE_BYTES) {
		throw new Error('Farming state exceeds the 512-byte wire limit.');
	}
	return line;
}

function metric(value: number | null, signed = false): number | null {
	return value !== null && Number.isInteger(value) && value <= 2_147_483_647
		&& value >= (signed ? -2_147_483_648 : 0) ? value : null;
}
