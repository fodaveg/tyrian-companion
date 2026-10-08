import { INGAME_BRIDGE_MAX_LINE_BYTES } from './alert-ingame-protocol';

export const PRICE_INGAME_TAG = 'price2' as const;
/** Cadence of the transport frame, the same as `farm1`; it never refreshes the quotation by itself. */
export const PRICE_INGAME_REFRESH_MS = 5_000;
/** The stack size the unit prices are multiplied by for `sellStack` and `listStack`. */
export const PRICE_INGAME_STACK = 250;
/** A quotation this old (seconds) or older is `stale`: the figures are no longer sent. */
export const PRICE_INGAME_STALE_SECONDS = 600;
/** The public `commerce/prices` answer is cacheable for 120 s, so asking more often gains nothing. */
export const PRICE_INGAME_QUOTE_REFRESH_MS = 120_000;

/**
 * Public gross price of the Halloween bag (`docs/SPEC-puente-ingame.md`, `price2`). Copper, as the
 * Trading Post shows it, with no fee discounted. Neither the item id, nor a name, nor an account ever enters this DTO: the tag fixes the object.
 */
export interface PriceIngameState {
	st: 'ok' | 'idle' | 'pending' | 'stale';
	sell: number | null;
	sellStack: number | null;
	list: number | null;
	listStack: number | null;
	age: number | null;
}

/** No live session in `active`: nothing to price. */
export function emptyPriceIngameState(): PriceIngameState {
	return { st: 'idle', sell: null, sellStack: null, list: null, listStack: null, age: null };
}

/** Capability stays separate from welcome and from `farming_cap`, so an existing v3 client can ignore it. */
export function priceIngameCapabilityLine(nonce: string): string {
	return JSON.stringify({ v: 3, type: 'price_cap', nonce, tag: PRICE_INGAME_TAG });
}

/**
 * Closed, bounded frame: exactly 12 keys in the contract's order. Anything that is not an int32 >= 0
 * travels as `null`, never as zero; with a `st` other than `ok` the four figures are forced to `null`,
 * and `idle`/`pending` carry no age either.
 */
export function priceIngameStateLine(state: PriceIngameState, nonce: string, seq: number): string {
	if (!Number.isInteger(seq) || seq < 1 || seq > 2_147_483_647) throw new Error('Invalid price sequence.');
	const figures = state.st === 'ok';
	const frame = {
		v: 3, type: 'price_state', tag: PRICE_INGAME_TAG, nonce, seq, ttl: 15, st: state.st,
		sell: figures ? metric(state.sell) : null, sellStack: figures ? metric(state.sellStack) : null,
		list: figures ? metric(state.list) : null, listStack: figures ? metric(state.listStack) : null,
		age: state.st === 'idle' || state.st === 'pending' ? null : metric(state.age),
	};
	const line = JSON.stringify(frame);
	if (new TextEncoder().encode(line).byteLength > INGAME_BRIDGE_MAX_LINE_BYTES) {
		throw new Error('Price state exceeds the 512-byte wire limit.');
	}
	return line;
}

function metric(value: number | null): number | null {
	return value !== null && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}
