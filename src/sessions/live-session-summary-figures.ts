import type { LiveGapV1 } from './live-session-model';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';

/** Below this much observed item time a per-hour figure says nothing; it is not written. */
export const SUMMARY_MIN_RATE_MS = 15 * 60_000;
/** The main map is the one that holds more than this share of the time spent on known maps. */
export const SUMMARY_MAIN_MAP_SHARE = 0.7;
/** One item above this share of the sellable value makes the per-hour figure misleading on its own. */
export const SUMMARY_DOMINANT_VALUE_SHARE = 0.5;
/** An item that came in at least this many separate times and is first by quantity is the session's staple. */
export const SUMMARY_STAPLE_MIN_ENTRIES = 10;
/** Below this observed share the unobserved intervals are listed instead of folded into one line. */
export const SUMMARY_FOLD_COVERAGE = 0.9;
const GOLD_CURRENCY_ID = 1;
/** `/v2/items` flags that take an item out of «sell now» and out of the value. */
const UNSELLABLE_FLAGS = ['AccountBound', 'SoulbindOnAcquire', 'NoSell'] as const;

/** What the plugin knows of an item from the public catalog; an absent entry means it does not know. */
export interface SummaryItemMeta { readonly flags: readonly string[]; readonly type: string }
export type SummaryItemMetaMap = Readonly<Record<number, SummaryItemMeta | undefined>>;

export interface SummaryItemRow { itemId: number; quantity: number; valueCopper: number | null; container: boolean }

export interface SummaryFigures {
	durationMs: number;
	/** 0..1, observed item time over the session's length. */
	observedShare: number;
	mainMapId: number | null;
	maps: { mapId: number; ms: number }[];
	/** Sellable items that came in, best value first (priced ones before unpriced). */
	sellable: SummaryItemRow[];
	/** Items that came in and are bound to the account (or cannot be sold): out of the list and out of the value. */
	boundItemIds: number[];
	/** Sellable items without a bazaar price: apart, out of the value. */
	unpriced: SummaryItemRow[];
	/** Items whose binding the plugin could not read: the value is then an upper bound. */
	unknownBindingIds: number[];
	netCopper: number;
	positiveCopper: number;
	perHour: { copper: number | null; reason: 'short' | 'coverage' | null };
	/** Set when ONE item is over half of the value: the per-hour figure without it. */
	withoutDominant: { itemId: number; perHourCopper: number } | null;
	staple: { itemId: number; quantity: number; entries: number; perHour: number | null } | null;
	goldCopper: number | null;
	currencies: { id: number; net: number }[];
	dominantCurrency: { id: number; net: number } | null;
	/** Units that left the inventory (sold, consumed or deposited: the plugin cannot tell). */
	outCount: number;
	hasNewItems: boolean;
	salesSession: boolean;
	alerts: { at: string; itemId: number; name: string; quantity: number; totalCopper: number | null }[];
	gaps: { fromAt: string; toAt: string; ms: number; reason: LiveGapV1['reason']; channels: LiveGapV1['channels']; characterChange: boolean }[];
	gapsMs: number;
}

export interface SummaryCharacter { name: string; fromAt: string }

/** The map holding more than 70 % of the time on known maps, or null («varios mapas»). */
export function summaryMainMap(session: Pick<StoredLiveSessionPayloadV1, 'mapIntervals'>): number | null {
	const times = mapTimes(session.mapIntervals);
	const total = times.reduce((sum, row) => sum + row.ms, 0);
	const first = times[0];
	return first !== undefined && total > 0 && first.ms / total > SUMMARY_MAIN_MAP_SHARE ? first.mapId : null;
}

function mapTimes(intervals: StoredLiveSessionPayloadV1['mapIntervals']): { mapId: number; ms: number }[] {
	const totals = new Map<number, number>();
	for (const interval of intervals) if (interval.mapId !== null) totals.set(interval.mapId, (totals.get(interval.mapId) ?? 0) + interval.toMs - interval.fromMs);
	return [...totals.entries()].map(([mapId, ms]) => ({ mapId, ms })).sort((a, b) => b.ms - a.ms || a.mapId - b.mapId);
}

/** Every figure of the summary, computed once from the stored payload; nothing here reads the network. */
export function computeSummaryFigures(session: StoredLiveSessionPayloadV1, meta: SummaryItemMetaMap,
	characters: readonly SummaryCharacter[]): SummaryFigures {
	const durationMs = Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt));
	const prices = new Map(session.valuation.prices.map((price) => [price.itemId, price.unitCopper]));
	const itemTotals = session.totals.filter((row) => row.kind === 'item');
	const sellable: SummaryItemRow[] = []; const unpriced: SummaryItemRow[] = []; const boundItemIds: number[] = []; const unknownBindingIds: number[] = [];
	let netCopper = 0; let positiveCopper = 0;
	for (const row of itemTotals) {
		const info = meta[row.idNumber];
		if (info === undefined && row.net !== 0) unknownBindingIds.push(row.idNumber);
		if (info !== undefined && info.flags.some((flag) => (UNSELLABLE_FLAGS as readonly string[]).includes(flag))) {
			if (row.net > 0) boundItemIds.push(row.idNumber);
			continue;
		}
		const unit = prices.get(row.idNumber);
		const priced = unit !== undefined && unit !== null;
		if (priced) netCopper += unit * row.net;
		if (row.net <= 0) continue;
		const entry: SummaryItemRow = { itemId: row.idNumber, quantity: row.net, valueCopper: priced ? unit * row.net : null, container: info?.type === 'Container' };
		if (priced) { sellable.push(entry); positiveCopper += unit * row.net; } else unpriced.push(entry);
	}
	sellable.sort((a, b) => (b.valueCopper ?? 0) - (a.valueCopper ?? 0) || b.quantity - a.quantity || a.itemId - b.itemId);
	unpriced.sort((a, b) => b.quantity - a.quantity || a.itemId - b.itemId);

	const observedMs = session.observedItemsMs;
	const rateReason: 'short' | 'coverage' | null = observedMs < SUMMARY_MIN_RATE_MS ? 'short' : session.coverage.items !== 'complete' ? 'coverage' : null;
	const perHour = (copper: number): number | null => rateReason === null ? Math.round(copper * 3_600_000 / observedMs) : null;
	const top = sellable[0];
	const withoutDominant = rateReason === null && top !== undefined && top.valueCopper !== null && positiveCopper > 0
		&& top.valueCopper / positiveCopper > SUMMARY_DOMINANT_VALUE_SHARE
		? { itemId: top.itemId, perHourCopper: perHour(netCopper - top.valueCopper)! } : null;

	const entries = new Map<number, number>();
	for (const entry of session.journal) for (const row of entry.observations) if (row.kind === 'item' && row.delta > 0) entries.set(row.idNumber, (entries.get(row.idNumber) ?? 0) + 1);
	const byQuantity = itemTotals.filter((row) => row.net > 0).sort((a, b) => b.net - a.net || a.idNumber - b.idNumber)[0];
	const staple = byQuantity !== undefined && (entries.get(byQuantity.idNumber) ?? 0) >= SUMMARY_STAPLE_MIN_ENTRIES
		? { itemId: byQuantity.idNumber, quantity: byQuantity.net, entries: entries.get(byQuantity.idNumber)!,
			perHour: rateReason === null ? Math.round(byQuantity.net * 3_600_000 / observedMs * 10) / 10 : null } : null;

	const currencyRows = session.totals.filter((row) => row.kind === 'currency');
	const gold = currencyRows.find((row) => row.idNumber === GOLD_CURRENCY_ID);
	const goldCopper = session.valuation.coinNetCopper ?? (gold === undefined ? null : gold.net);
	const currencies = currencyRows.filter((row) => row.idNumber !== GOLD_CURRENCY_ID && row.net !== 0)
		.map((row) => ({ id: row.idNumber, net: row.net })).sort((a, b) => a.id - b.id);
	const gainedCurrency = currencies.filter((row) => row.net > 0).sort((a, b) => b.net - a.net)[0] ?? null;
	const itemUnitsNet = itemTotals.reduce((sum, row) => sum + row.net, 0);
	const hasNewItems = itemTotals.some((row) => row.net > 0);

	const alerts = session.journal.flatMap((entry) => entry.outbox.filter((row) => row.state === 'processed' && row.alert !== null)
		.map((row) => ({ at: entry.observedAt, itemId: row.alert!.itemId, name: row.alert!.name, quantity: row.alert!.quantity, totalCopper: row.alert!.totalCopper })));

	const gaps = session.gaps.filter((gap) => gap.toAt !== null).map((gap) => ({ fromAt: gap.fromAt, toAt: gap.toAt!, reason: gap.reason, channels: gap.channels,
		ms: Date.parse(gap.toAt!) - Date.parse(gap.fromAt),
		characterChange: gap.reason === 'context_changed' && characters.slice(1).some((entry) => entry.fromAt >= gap.fromAt && entry.fromAt <= gap.toAt!) }));
	return { durationMs, observedShare: durationMs > 0 ? Math.min(1, observedMs / durationMs) : 0,
		mainMapId: summaryMainMap(session), maps: mapTimes(session.mapIntervals), sellable, boundItemIds, unpriced, unknownBindingIds,
		netCopper, positiveCopper, perHour: { copper: perHour(netCopper), reason: rateReason }, withoutDominant, staple, goldCopper, currencies,
		dominantCurrency: positiveCopper === 0 ? gainedCurrency : null,
		outCount: itemTotals.reduce((sum, row) => sum + row.negative, 0), hasNewItems,
		salesSession: goldCopper !== null && goldCopper > 0 && itemUnitsNet < 0,
		alerts, gaps, gapsMs: unionMs(session.gaps, session.endedAt) };
}

/** Union of the unobserved intervals, whatever the channel: overlaps count once. */
function unionMs(gaps: readonly LiveGapV1[], endedAt: string): number {
	let end = Number.NEGATIVE_INFINITY; let ms = 0;
	for (const gap of [...gaps].sort((a, b) => a.fromAt.localeCompare(b.fromAt))) {
		const from = Date.parse(gap.fromAt); const to = Date.parse(gap.toAt ?? endedAt);
		ms += Math.max(0, to - Math.max(from, end)); end = Math.max(end, to);
	}
	return ms;
}
