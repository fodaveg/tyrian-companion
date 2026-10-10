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
/**
 * What lies between two map intervals is time on no identified map from this much OBSERVED time on. Under it, it is the edge of the
 * map next to it: the two ends of an interval and the samples around them are stamped by different reads of the clock.
 */
export const SUMMARY_MIN_UNIDENTIFIED_MS = 1_000;
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
	/** One of its `context_changed` records holds the instant a later character took over, whatever the reason of its longest record. */
	characterChange: boolean;
	/** The one channel its records name; null when they name both, or when one of them names none. */
	onlyChannel: 'items' | 'currencies' | null;
	/** Time of the stretch that went unobserved in currencies while items were observed: no items record covers it. */
	currencyOnlyMs: number;
}

/** One row of the map breakdown: an identified map, or (`mapId` null) what was observed on no identified map. */
export interface SummaryMapRow {
	mapId: number | null;
	/** Item time observed there: the map's intervals cut to the observed stretches, each instant once. */
	observedMs: number;
	/** Net value of the item changes observed there, valued and excluded exactly as `netCopper`. Null when the summary has no value to state. */
	netCopper: number | null;
	/** That value per hour observed THERE. Null under the 15 observed minutes every live rate needs, or without a value. */
	perHourCopper: number | null;
}
/** One step of the session's route: the map entered (null: a stretch observed on no identified map) and when. */
export interface SummaryMapVisit { mapId: number | null; at: string }
/**
 * One stretch of the session on a map: the route's step with its end. A stretch runs from the hour the map was entered up to
 * the next entry (the session's end for the last one), so the stretches are the route cut at every entry and a return to a
 * map is a stretch of its own. They are cut from the same pieces as `rows`, and `top` and `netCopper` are the value of
 * `rows` split by stretch instead of by map (valued like it, in the session's basis).
 */
export interface SummaryMapStretch {
	mapId: number | null; fromAt: string; toAt: string; ms: number;
	/** Item time observed in it, as `SummaryMapRow.observedMs`. */
	observedMs: number;
	/** Net value of the item changes observed in it. Null when the summary has no value to state (`valued` false), and for a stretch where nothing priced moved. */
	netCopper: number | null;
	/** How many item changes were observed in it, priced or not: zero says «no item changes», and a value of zero says nothing of it. */
	changes: number;
	/** An item of the net value (one with a price) changed in it: false with `changes` above zero is a stretch with no prices. */
	priced: boolean;
	/** The items of most value that came in during it, at most `SUMMARY_STRETCH_TOP` of them, best first. */
	top: { itemId: number; quantity: number; valueCopper: number }[];
}
/** How many objects of most value a stretch lists. */
export const SUMMARY_STRETCH_TOP = 5;
/**
 * The session by map. The session's length is cut ONCE, into the map intervals and the holes between them, and every figure comes
 * from that one cut, so the table, its last row and the route cannot disagree:
 * - a hole with `SUMMARY_MIN_UNIDENTIFIED_MS` or more observed in it is a stretch on no identified map; one with less is the edge of
 *   the map before it (of the one after it, at the start of the session) and that map takes it, its time and its changes. That is
 *   what puts the last change of a session on its map: the session's end is closed on the presence's last frame, and the sample that
 *   frame carried is stamped one clock read later;
 * - time is OBSERVED item time: each piece of the cut less the unobserved stretches of items. `rows` and `unidentified` add up,
 *   exactly, to the session's length less those stretches. That is `observedItemsMs` whenever the saved observed time agrees with
 *   the records; it is saved on the addon's clock and bounded by them, so where it is shorter the rows are what the records say and
 *   add up to that much more;
 * - value is `netCopper` split by where each change was observed, so `rows` and `unidentified` add up to it exactly;
 * - an item change belongs to the piece that holds its hour, after the piece's start and up to its end: a sample stamped at the
 *   instant the map changed is the last one of the map left.
 */
export interface SummaryMapBreakdown {
	/** The identified maps, one row each however many times it was entered, in the order they were first entered. */
	rows: SummaryMapRow[];
	/**
	 * What was observed on no identified map. Next to a map its time is zero or a stretch (`SUMMARY_MIN_UNIDENTIFIED_MS` or more),
	 * and it is not zero exactly when `visits` has a step on no identified map. Its value is that of the changes observed there, plus
	 * units no journal entry accounts for (none in a saved session: only then can it hold value with no time). Always present.
	 */
	unidentified: SummaryMapRow;
	/** Every entry in order, returns to a map already visited included; a new interval of the map the session was already on is no entry. */
	visits: SummaryMapVisit[];
	/** The stretches in order, one per entry in `visits` and over the same pieces. */
	stretches: SummaryMapStretch[];
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
	/** The map of the title and of `tyrian_summary_main_map` (see `summaryMainMap`); it is not read from `mapBreakdown`. */
	mainMapId: number | null;
	/** Observed time, value and pace by map, and the order the maps were entered in. */
	mapBreakdown: SummaryMapBreakdown;
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
	/**
	 * The part of `gapsMs` that is of currencies alone. `gapsMs` is of either channel and the observed time is of items, so
	 * this is what separates them: the session's length less the observed item time is `gapsMs` less this, while the
	 * observed time and the records agree.
	 */
	gapsCurrencyOnlyMs: number;
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

/**
 * The map holding more than 70 % of the observed time, or null (several maps, or none known). It is a SAVED figure
 * (`tyrian_summary_main_map`, which the average by map reads) and so it keeps its own arithmetic: the time of each map is the
 * whole length of its intervals, unobserved stretches inside them included, not the observed time of `mapBreakdown`.
 */
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
	// Every item that enters `netCopper`, with what it adds: the map breakdown splits exactly this, and nothing else.
	const counted = new Map<number, CountedItem>();
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
		if (priced) { netCopper += value; counted.set(row.idNumber, { unitCopper: unit!, net: row.net, valueCopper: value }); if (row.net !== 0) pricedAny = true; }
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
	// Integer arithmetic before the division, so an exact share (57 of 100 minutes) is not truncated to the percent below it.
	const wholePercent = durationMs > 0 ? Math.min(100, Math.floor(observedMs * 100 / durationMs)) : 0;
	return { durationMs, observedShare: durationMs > 0 ? Math.min(1, observedMs / durationMs) : 0,
		observedPercent: stretches.length > 0 ? Math.min(99, wholePercent) : wholePercent,
		mainMapId: summaryMainMap(session), mapBreakdown: mapBreakdown(session, counted, !valueless), sellable, boundItemIds, unpriced, unknownBindingIds,
		netCopper: valueless ? null : netCopper, positiveCopper, noPrices,
		perHour: { copper: valueless ? null : perHour(netCopper), reason: rateReason }, withoutDominant: valueless ? null : withoutDominant, staple, goldCopper, currencies,
		dominantCurrency: positiveCopper === 0 ? gainedCurrency : null,
		outCount: itemTotals.reduce((sum, row) => sum + row.negative, 0), outKinds: itemTotals.filter((row) => row.negative > 0).length, hasNewItems,
		salesSession,
		alerts, stretches, gapsMs: stretches.reduce((sum, stretch) => sum + stretch.ms, 0), gapStretches: stretches.length,
		gapsCurrencyOnlyMs: stretches.reduce((sum, stretch) => sum + stretch.currencyOnlyMs, 0) };
}

/** «1 h 5 min», «12 min 31 s», «40 s»: a length as the notes of a session write it (seconds only under an hour). */
export function formatSummaryDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600); const minutes = Math.floor(total % 3600 / 60); const seconds = total % 60;
	const parts = [...(hours > 0 ? [`${String(hours)} h`] : []), ...(minutes > 0 ? [`${String(minutes)} min`] : []),
		...(hours === 0 && seconds > 0 || total === 0 ? [`${String(seconds)} s`] : [])];
	return parts.join(' ');
}

/** An item that enters the summary's net value: its unit price, its net quantity and what that quantity is worth in the session's basis. */
interface CountedItem { unitCopper: number; net: number; valueCopper: number }

/**
 * The session by map (see `SummaryMapBreakdown`). `counted` are the items of the net value and `valued` says the summary states
 * one: without it every value here is null, like the summary's own.
 */
function mapBreakdown(session: StoredLiveSessionPayloadV1, counted: ReadonlyMap<number, CountedItem>, valued: boolean): SummaryMapBreakdown {
	const start = Date.parse(session.startedAt); const end = Date.parse(session.endedAt);
	const iso = (ms: number): string => new Date(ms).toISOString();
	// What was observed of items: the session less the union of its unobserved item records.
	const observed: { from: number; to: number }[] = []; let seen = start;
	for (const gap of session.gaps.filter((row) => row.channels.includes('items')).map((row) => ({ from: Date.parse(row.fromAt), to: Date.parse(row.toAt ?? session.endedAt) })).sort((a, b) => a.from - b.from)) {
		if (gap.from > seen) observed.push({ from: seen, to: Math.min(gap.from, end) });
		seen = Math.max(seen, gap.to);
	}
	if (end > seen) observed.push({ from: seen, to: end });
	const observedIn = (from: number, to: number): number => observed.reduce((sum, stretch) => sum + Math.max(0, Math.min(to, stretch.to) - Math.max(from, stretch.from)), 0);
	const firstObservedIn = (from: number, to: number): number | null => {
		for (const stretch of observed) { const at = Math.max(from, stretch.from); if (at < Math.min(to, stretch.to)) return at; }
		return null;
	};
	// The identified intervals in order, each instant once: one that starts before the previous ended starts where that one ended.
	// `enteredAt` is the hour the map was entered, which the route writes; `from` and `to` are what the piece covers.
	type Piece = { mapId: number | null; enteredAt: number; from: number; to: number };
	const intervals: Piece[] = []; let until = start;
	for (const row of [...session.mapIntervals].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs)) {
		const from = Math.max(row.fromMs, until); const to = Math.min(row.toMs, end);
		if (row.mapId === null || to <= from) continue;
		intervals.push({ mapId: row.mapId, enteredAt: from, from, to }); until = to;
	}
	// The one cut of the session: the intervals and the holes between them. A hole with a stretch observed in it is a piece on no
	// identified map, entered at its first observed instant; one with less is the edge of the map next to it, which takes it.
	const pieces: Piece[] = [];
	const hole = (from: number, to: number, before: Piece | undefined, after: Piece | undefined): void => {
		const first = to > from ? firstObservedIn(from, to) : null;
		// With no map next to it (a session with no identified map at all) whatever was observed is on none, however short.
		if (first !== null && (observedIn(from, to) >= SUMMARY_MIN_UNIDENTIFIED_MS || before === undefined && after === undefined)) pieces.push({ mapId: null, enteredAt: first, from, to });
		else if (to > from && before !== undefined) before.to = to;
		else if (to > from && after !== undefined) after.from = from;
	};
	if (intervals.length === 0) hole(start, end, undefined, undefined);
	intervals.forEach((interval, index) => {
		hole(index === 0 ? start : intervals[index - 1]!.to, interval.from, intervals[index - 1], interval);
		pieces.push(interval);
		if (index === intervals.length - 1) hole(interval.to, end, interval, undefined);
	});

	const rows = new Map<number, SummaryMapRow>(); const visits: SummaryMapVisit[] = []; const stretches: SummaryMapStretch[] = [];
	const unidentified: SummaryMapRow = { mapId: null, observedMs: 0, netCopper: valued ? 0 : null, perHourCopper: null };
	// The stretch each piece belongs to: the pieces of one entry in the route, which is what `visits` lists.
	const stretchOf: number[] = [];
	for (const piece of pieces) {
		if (visits.at(-1)?.mapId !== piece.mapId) {
			visits.push({ mapId: piece.mapId, at: iso(piece.enteredAt) });
			stretches.push({ mapId: piece.mapId, fromAt: iso(piece.enteredAt), toAt: iso(piece.to), ms: 0, observedMs: 0, netCopper: valued ? 0 : null, changes: 0, priced: false, top: [] });
		}
		const stretch = stretches.at(-1)!;
		stretch.toAt = iso(piece.to); stretch.observedMs += observedIn(piece.from, piece.to); stretchOf.push(stretches.length - 1);
		const row = piece.mapId === null ? unidentified : rows.get(piece.mapId) ?? { mapId: piece.mapId, observedMs: 0, netCopper: valued ? 0 : null, perHourCopper: null };
		row.observedMs += observedIn(piece.from, piece.to);
		if (piece.mapId !== null) rows.set(piece.mapId, row);
	}
	for (const stretch of stretches) stretch.ms = Math.max(0, Date.parse(stretch.toAt) - Date.parse(stretch.fromAt));

	// Where each journal entry was observed: the piece that holds its hour, after the piece's start and up to its end.
	const placed = session.journal.map((entry) => { const at = Date.parse(entry.observedAt); return pieces.findIndex((piece) => at > piece.from && at <= piece.to); });
	session.journal.forEach((entry, index) => {
		const stretch = placed[index]! < 0 ? undefined : stretches[stretchOf[placed[index]!]!];
		if (stretch !== undefined) stretch.changes += entry.observations.filter((row) => row.kind === 'item' && row.delta !== 0).length;
	});

	if (valued) {
		// Units of each counted item by where they were observed. What no entry of the journal accounts for is on no identified map.
		const units = new Map<number, Map<number | null, number>>(); const unitsByStretch = new Map<number, Map<number, number>>();
		session.journal.forEach((entry, index) => {
			const piece = placed[index]! < 0 ? undefined : pieces[placed[index]!];
			const mapId = piece?.mapId ?? null; const stretch = piece === undefined ? UNPLACED_STRETCH : stretchOf[placed[index]!]!;
			for (const row of entry.observations) {
				if (row.kind !== 'item' || !counted.has(row.idNumber)) continue;
				const byMap = units.get(row.idNumber) ?? new Map<number | null, number>();
				byMap.set(mapId, (byMap.get(mapId) ?? 0) + row.delta); units.set(row.idNumber, byMap);
				const byStretch = unitsByStretch.get(row.idNumber) ?? new Map<number, number>();
				byStretch.set(stretch, (byStretch.get(stretch) ?? 0) + row.delta); unitsByStretch.set(row.idNumber, byStretch);
			}
		});
		const basis = session.valuation.priceBasis;
		for (const [mapId, part] of splitCounted(counted, basis, units, null)) { const row = mapId === null ? unidentified : rows.get(mapId)!; row.netCopper = (row.netCopper ?? 0) + part.copper; }
		// The same split by stretch. The units no entry accounts for have no stretch to be written in: they are in no row of it.
		for (const [index, part] of splitCounted(counted, basis, unitsByStretch, UNPLACED_STRETCH)) {
			const stretch = stretches[index];
			if (stretch === undefined) continue;
			const moved = [...part.items].filter(([, item]) => item.quantity !== 0);
			stretch.netCopper = part.copper; stretch.priced = moved.length > 0;
			stretch.top = moved.filter(([, item]) => item.quantity > 0).map(([itemId, item]) => ({ itemId, quantity: item.quantity, valueCopper: item.copper }))
				.sort((a, b) => b.valueCopper - a.valueCopper || b.quantity - a.quantity || a.itemId - b.itemId).slice(0, SUMMARY_STRETCH_TOP);
		}
		// The pace of a map is over the time observed on THAT map, under the one rule of every live rate.
		for (const row of [...rows.values(), unidentified]) {
			if (liveItemRateEligible({ observedItemsMs: row.observedMs })) row.perHourCopper = Math.round((row.netCopper ?? 0) * 3_600_000 / row.observedMs);
		}
	}
	// A stretch where nothing priced moved has no value to state, however the session's own value stands: zero would claim a price.
	for (const stretch of stretches) if (!stretch.priced) stretch.netCopper = null;
	return { rows: [...rows.values()], unidentified, visits, stretches };
}

/** The key of the units no journal entry places in any stretch. */
const UNPLACED_STRETCH = -1;

/**
 * Each place's share of the net value of `counted`, from the units of every item observed there (`units`, by item and place; `unplaced`
 * is the place of what no entry accounts for). Each place's units are valued in the session's basis. A net price is per unit, so the parts
 * add up to the item's value; a gross one takes the commission over each sale's total and they need not: what is left over goes where most
 * units were observed. Maps and stretches both split the value with this one rule.
 */
function splitCounted<K>(counted: ReadonlyMap<number, CountedItem>, basis: StoredLiveSessionPayloadV1['valuation']['priceBasis'],
	units: ReadonlyMap<number, Map<K, number>>, unplaced: K): Map<K, { copper: number; items: Map<number, { quantity: number; copper: number }> }> {
	const out = new Map<K, { copper: number; items: Map<number, { quantity: number; copper: number }> }>();
	for (const [itemId, item] of counted) {
		const byPlace = units.get(itemId) ?? new Map<K, number>();
		const placed = [...byPlace.values()].reduce((sum, quantity) => sum + quantity, 0);
		if (placed !== item.net) byPlace.set(unplaced, (byPlace.get(unplaced) ?? 0) + item.net - placed);
		const parts = [...byPlace].map(([place, quantity]) => ({ place, quantity, copper: basis === 'instant_sell_net' ? item.unitCopper * quantity : liveItemValueCopper(basis, item.unitCopper, quantity) ?? 0 }));
		const largest = parts.reduce<typeof parts[number] | null>((best, part) => best === null || Math.abs(part.quantity) > Math.abs(best.quantity) ? part : best, null);
		if (largest !== null) largest.copper += item.valueCopper - parts.reduce((sum, part) => sum + part.copper, 0);
		for (const part of parts) {
			const share = out.get(part.place) ?? { copper: 0, items: new Map<number, { quantity: number; copper: number }>() };
			share.copper += part.copper; share.items.set(itemId, { quantity: part.quantity, copper: part.copper }); out.set(part.place, share);
		}
	}
	return out;
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
	type Sweep = Record<'items' | 'either', number>;
	const open: { from: number; to: number; reason: LiveGapV1['reason']; longestMs: number; characterChange: boolean;
		items: boolean; currencies: boolean; unlabelled: boolean; covered: Sweep; until: Sweep }[] = [];
	for (const record of records) {
		let stretch = open.at(-1);
		if (stretch === undefined || record.from > stretch.to) {
			stretch = { from: record.from, to: record.from, reason: record.reason, longestMs: -1, characterChange: false, items: false, currencies: false, unlabelled: false,
				covered: { items: 0, either: 0 }, until: { items: Number.NEGATIVE_INFINITY, either: Number.NEGATIVE_INFINITY } };
			open.push(stretch);
		}
		const current = stretch;
		if (record.to - record.from > current.longestMs) { current.longestMs = record.to - record.from; current.reason = record.reason; }
		// Decided record by record, as before the records were joined: the longest record of the stretch may well be of another reason.
		if (record.reason === 'context_changed' && takeovers.some((at) => at >= record.from && at <= record.to)) current.characterChange = true;
		const items = record.channels.includes('items'); const currencies = record.channels.includes('currencies');
		current.items ||= items; current.currencies ||= currencies; current.unlabelled ||= !items && !currencies;
		// Time unobserved inside the stretch, each instant once: in items, and in either channel. The difference is of currencies alone.
		for (const sweep of [...(items ? ['items' as const] : []), ...(items || currencies ? ['either' as const] : [])]) {
			current.covered[sweep] += Math.max(0, record.to - Math.max(record.from, current.until[sweep]));
			current.until[sweep] = Math.max(current.until[sweep], record.to);
		}
		current.to = Math.max(current.to, record.to);
	}
	return open.map((stretch) => ({ fromAt: new Date(stretch.from).toISOString(), toAt: new Date(stretch.to).toISOString(), ms: stretch.to - stretch.from,
		reason: stretch.reason, characterChange: stretch.characterChange, currencyOnlyMs: stretch.covered.either - stretch.covered.items,
		// A record that names no channel leaves its stretch without a channel to name.
		onlyChannel: stretch.unlabelled ? null : stretch.items && !stretch.currencies ? 'items' : stretch.currencies && !stretch.items ? 'currencies' : null }));
}
