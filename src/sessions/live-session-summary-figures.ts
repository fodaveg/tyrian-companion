import { liveItemRateEligible, type LiveGapV1 } from './live-session-model';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { liveItemValueCopper } from './live-session-reducer';

/** The main map is the one that holds more than this share of the time spent on known maps. */
export const SUMMARY_MAIN_MAP_SHARE = 0.7;
/** One item above this share of the sellable value makes the per-hour figure misleading on its own. */
export const SUMMARY_DOMINANT_VALUE_SHARE = 0.5;
/** An item that came in at least this many separate times and is first by quantity is the session's staple. */
export const SUMMARY_STAPLE_MIN_ENTRIES = 10;
/** Below this observed share the unobserved intervals are listed instead of folded into one line. */
export const SUMMARY_FOLD_COVERAGE = 0.9;
/** An unobserved stretch shorter than this is a cut: the note counts the cuts together instead of writing each one. */
export const SUMMARY_SHORT_GAP_MS = 30_000;
const GOLD_CURRENCY_ID = 1;
/**
 * `/v2/items` flags that take an item out of «sell now» and out of the value: the ones that forbid TRADING it, which is what the
 * value is (a bazaar price). `NoSell` is not one of them: it forbids selling to a VENDOR (NPC), and such items (a candy
 * piece, a mechanical gear) are traded on the bazaar. `AccountBindOnUse` and `SoulBindOnUse` are not either: the item binds
 * when it is used, so until then it still sells. An item with any of those three is valued like any other.
 */
const UNSELLABLE_FLAGS = ['AccountBound', 'SoulbindOnAcquire'] as const;

/** What the plugin knows of an item from the public catalog; an absent entry means it does not know. */
export interface SummaryItemMeta {
	readonly flags: readonly string[]; readonly type: string;
	/** Icon URL from the same catalog cache record; the note keeps it only if it is on the GW2 render host. */
	readonly icon?: string;
}
export type SummaryItemMetaMap = Readonly<Record<number, SummaryItemMeta | undefined>>;

export interface SummaryItemRow { itemId: number; quantity: number; valueCopper: number | null; container: boolean }

/**
 * One unobserved stretch as the note counts and writes it. The session keeps one record per channel, so a cut that
 * took items and currencies at once is two records over the same instants: here it is one stretch, and so are records
 * that touch or overlap. The count and the total are of time nobody observed, never of records.
 */
export interface SummaryGapStretch {
	fromAt: string; toAt: string; ms: number;
	/** The reason of the longest record in the stretch: what the stretch is named after. */
	reason: LiveGapV1['reason'];
	/** A `context_changed` stretch that holds the instant a later character took over. */
	characterChange: boolean;
	/** The one channel that went unobserved, when the other was observed all along the stretch; null when both were hit. */
	onlyChannel: 'items' | 'currencies' | null;
}

export interface SummaryFigures {
	durationMs: number;
	/** 0..1, observed item time over the session's length. */
	observedShare: number;
	/**
	 * The share as the whole percent the note states, truncated and never rounded up: 100 only for a session
	 * observed in full, and at most 99 while it has any unobserved stretch (23 s in 115 minutes is not 100 %).
	 */
	observedPercent: number;
	mainMapId: number | null;
	maps: { mapId: number; ms: number }[];
	/** Time on the maps of `maps` together: what the session spent on a map the plugin could identify. */
	mapsMs: number;
	/** Sellable items that came in, best value first (priced ones before unpriced). */
	sellable: SummaryItemRow[];
	/** Items that came in and are bound to the account (or soulbound on acquire): out of the list and out of the value. */
	boundItemIds: number[];
	/** Sellable items without a bazaar price: apart, out of the value. */
	unpriced: SummaryItemRow[];
	/** Items whose binding the plugin could not read: the value is then an upper bound. */
	unknownBindingIds: number[];
	/** Null when no item with a quantity has any bazaar price, or in a selling session: there is no value to state. */
	netCopper: number | null;
	positiveCopper: number;
	noPrices: boolean;
	/** Over the OBSERVED item time, never the session's length. `short`: under the 15 observed minutes every live rate needs. */
	perHour: { copper: number | null; reason: 'short' | null };
	/**
	 * Set when ONE item is over half of the value: what the session's net comes to without it, and that as a
	 * per-hour figure. The rate is null when nothing positive is left (the item is worth the whole net, or more
	 * than it because what left the inventory subtracts): a rate of nothing, or of a loss, is not a pace.
	 */
	withoutDominant: { itemId: number; netCopper: number; perHourCopper: number | null } | null;
	staple: { itemId: number; quantity: number; entries: number; perHour: number | null } | null;
	goldCopper: number | null;
	currencies: { id: number; net: number }[];
	dominantCurrency: { id: number; net: number } | null;
	/** Units that left the inventory (sold, consumed or deposited: the plugin cannot tell). */
	outCount: number;
	/** How many different items those units are of: 5 units can be 5 of one item or one each of five. */
	outKinds: number;
	hasNewItems: boolean;
	salesSession: boolean;
	alerts: { at: string; itemId: number; name: string; quantity: number; totalCopper: number | null }[];
	/** The disjoint unobserved stretches in the order they happened, whatever the channel. */
	stretches: SummaryGapStretch[];
	/** Their time together. */
	gapsMs: number;
	/** How many they are: the number that goes with `gapsMs`. */
	gapStretches: number;
}

export interface SummaryCharacter { name: string; fromAt: string }

/** Ids of the items and currencies a summary writes by name. */
export interface SummaryEntityIds { readonly itemIds: readonly number[]; readonly currencyIds: readonly number[] }

/**
 * What the note can name: every item that came in (the list, the unpriced and bound lines, the staple),
 * the items of the alerts that fired, and every currency that moved except gold, which is written as money.
 */
export function summaryNamedEntities(session: Pick<StoredLiveSessionPayloadV1, 'totals' | 'journal'>): SummaryEntityIds {
	const ascending = (ids: number[]): number[] => [...new Set(ids)].sort((a, b) => a - b);
	const alerted = session.journal.flatMap((entry) => entry.outbox.flatMap((row) => row.state === 'processed' && row.alert !== null ? [row.alert.itemId] : []));
	return { itemIds: ascending([...session.totals.filter((row) => row.kind === 'item' && row.net > 0).map((row) => row.idNumber), ...alerted]),
		currencyIds: ascending(session.totals.filter((row) => row.kind === 'currency' && row.idNumber !== GOLD_CURRENCY_ID && row.net !== 0).map((row) => row.idNumber)) };
}

/** The map holding more than 70 % of the observed time, or null (several maps, or none known: see `maps`). */
export function summaryMainMap(session: Pick<StoredLiveSessionPayloadV1, 'mapIntervals' | 'observedItemsMs'>): number | null {
	const first = mapTimes(session.mapIntervals)[0];
	// The share is of the OBSERVED time: time on no known map (null intervals, or none recorded) counts in the denominator.
	const total = Math.max(session.mapIntervals.reduce((sum, row) => sum + row.toMs - row.fromMs, 0), session.observedItemsMs);
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
	const basis = session.valuation.priceBasis;
	const itemTotals = session.totals.filter((row) => row.kind === 'item');
	const sellable: SummaryItemRow[] = []; const unpriced: SummaryItemRow[] = []; const boundItemIds: number[] = []; const unknownBindingIds: number[] = [];
	let netCopper = 0; let positiveCopper = 0; let pricedAny = false;
	for (const row of itemTotals) {
		const info = meta[row.idNumber];
		if (info === undefined && row.net !== 0) unknownBindingIds.push(row.idNumber);
		if (info !== undefined && info.flags.some((flag) => (UNSELLABLE_FLAGS as readonly string[]).includes(flag))) {
			if (row.net > 0) boundItemIds.push(row.idNumber);
			continue;
		}
		const unit = prices.get(row.idNumber);
		// What the row's net quantity is worth in the basis the session saved: unit x quantity for a net price, the sale of the
		// whole pile less the commission on its total for a gross one. Null is an item the session could not price.
		const value = unit === undefined || unit === null ? null : basis === 'instant_sell_net' ? unit * row.net : liveItemValueCopper(basis, unit, row.net);
		const priced = value !== null;
		if (priced) { netCopper += value; if (row.net !== 0) pricedAny = true; }
		if (row.net <= 0) continue;
		const entry: SummaryItemRow = { itemId: row.idNumber, quantity: row.net, valueCopper: value, container: info?.type === 'Container' };
		if (priced) { sellable.push(entry); positiveCopper += value; } else unpriced.push(entry);
	}
	sellable.sort((a, b) => (b.valueCopper ?? 0) - (a.valueCopper ?? 0) || b.quantity - a.quantity || a.itemId - b.itemId);
	unpriced.sort((a, b) => b.quantity - a.quantity || a.itemId - b.itemId);

	const observedMs = session.observedItemsMs;
	// The one rule of every live rate (`liveItemRateEligible`): 15 observed minutes. How the session ended does not enter: a
	// disconnection clears the last sample, so `coverage.items` closes as 'none' over any amount of covered time.
	const rateReason: 'short' | null = liveItemRateEligible({ observedItemsMs: observedMs }) ? null : 'short';
	const hasQuantity = itemTotals.some((row) => row.net !== 0);
	const noPrices = hasQuantity && !pricedAny;
	const goldNet = session.valuation.coinNetCopper ?? session.totals.find((row) => row.kind === 'currency' && row.idNumber === GOLD_CURRENCY_ID)?.net ?? null;
	const itemUnitsNet = itemTotals.reduce((sum, row) => sum + row.net, 0);
	const hasNew = itemTotals.some((row) => row.net > 0);
	const salesSession = goldNet !== null && goldNet > 0 && itemUnitsNet < 0;
	const valueless = noPrices || salesSession && !hasNew;
	const perHour = (copper: number): number | null => rateReason === null ? Math.round(copper * 3_600_000 / observedMs) : null;
	const top = sellable[0];
	const withoutDominant = rateReason === null && top !== undefined && top.valueCopper !== null && positiveCopper > 0
		&& top.valueCopper / positiveCopper > SUMMARY_DOMINANT_VALUE_SHARE
		? { itemId: top.itemId, netCopper: netCopper - top.valueCopper, perHourCopper: netCopper - top.valueCopper > 0 ? perHour(netCopper - top.valueCopper) : null } : null;

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
	const hasNewItems = hasNew;

	const alerts = session.journal.flatMap((entry) => entry.outbox.filter((row) => row.state === 'processed' && row.alert !== null)
		.map((row) => ({ at: entry.observedAt, itemId: row.alert!.itemId, name: row.alert!.name, quantity: row.alert!.quantity, totalCopper: row.alert!.totalCopper })));

	const stretches = unobservedStretches(session.gaps, session.endedAt, characters);
	const maps = mapTimes(session.mapIntervals);
	// Integer arithmetic before the division, so an exact share (57 of 100 minutes) is not truncated to the percent below it.
	const wholePercent = durationMs > 0 ? Math.min(100, Math.floor(observedMs * 100 / durationMs)) : 0;
	return { durationMs, observedShare: durationMs > 0 ? Math.min(1, observedMs / durationMs) : 0,
		observedPercent: stretches.length > 0 ? Math.min(99, wholePercent) : wholePercent,
		mainMapId: summaryMainMap(session), maps, mapsMs: maps.reduce((sum, row) => sum + row.ms, 0), sellable, boundItemIds, unpriced, unknownBindingIds,
		netCopper: valueless ? null : netCopper, positiveCopper, noPrices,
		perHour: { copper: valueless ? null : perHour(netCopper), reason: rateReason }, withoutDominant: valueless ? null : withoutDominant, staple, goldCopper, currencies,
		dominantCurrency: positiveCopper === 0 ? gainedCurrency : null,
		outCount: itemTotals.reduce((sum, row) => sum + row.negative, 0), outKinds: itemTotals.filter((row) => row.negative > 0).length, hasNewItems,
		salesSession,
		alerts, stretches, gapsMs: stretches.reduce((sum, stretch) => sum + stretch.ms, 0), gapStretches: stretches.length };
}

/**
 * Union of the unobserved records, whatever the channel: a record that starts after everything before it ended opens a
 * stretch, and one that touches or overlaps the open stretch extends it. So a cut seen by two channels is one stretch,
 * with its time counted once. A record still open is taken up to the session's end.
 */
function unobservedStretches(gaps: readonly LiveGapV1[], endedAt: string, characters: readonly SummaryCharacter[]): SummaryGapStretch[] {
	const records = gaps.map((gap) => ({ from: Date.parse(gap.fromAt), to: Date.parse(gap.toAt ?? endedAt), reason: gap.reason, channels: gap.channels }))
		.sort((a, b) => a.from - b.from || a.to - b.to);
	const takeovers = characters.slice(1).map((entry) => Date.parse(entry.fromAt));
	const open: { from: number; to: number; reason: LiveGapV1['reason']; longestMs: number;
		covered: Record<'items' | 'currencies', number>; until: Record<'items' | 'currencies', number> }[] = [];
	for (const record of records) {
		let stretch = open.at(-1);
		if (stretch === undefined || record.from > stretch.to) {
			stretch = { from: record.from, to: record.from, reason: record.reason, longestMs: -1, covered: { items: 0, currencies: 0 },
				until: { items: Number.NEGATIVE_INFINITY, currencies: Number.NEGATIVE_INFINITY } };
			open.push(stretch);
		}
		if (record.to - record.from > stretch.longestMs) { stretch.longestMs = record.to - record.from; stretch.reason = record.reason; }
		// Time each channel went unobserved inside the stretch, each instant once: it says whether the stretch is of one channel alone.
		for (const channel of record.channels) {
			stretch.covered[channel] += Math.max(0, record.to - Math.max(record.from, stretch.until[channel]));
			stretch.until[channel] = Math.max(stretch.until[channel], record.to);
		}
		stretch.to = Math.max(stretch.to, record.to);
	}
	return open.map((stretch) => ({ fromAt: new Date(stretch.from).toISOString(), toAt: new Date(stretch.to).toISOString(), ms: stretch.to - stretch.from,
		reason: stretch.reason,
		characterChange: stretch.reason === 'context_changed' && takeovers.some((at) => at >= stretch.from && at <= stretch.to),
		onlyChannel: stretch.covered.currencies === 0 ? 'items' : stretch.covered.items === 0 ? 'currencies' : null }));
}
