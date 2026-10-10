import { describe, expect, it } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { buildLiveSessionComparison } from './live-session-comparison';
import { serializeLiveSessionExport } from './live-session-export';
import { liveSessionViewFromStored, sortLiveItemsByValue } from './live-session-history';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, livePriceBasisOf, LIVE_SESSION_NOTE_WRITE_VERSION,
	type LiveInventorySampleV1, type LiveJournalEntryV1, type LivePriceBasis, type LivePriceV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { isStoredLiveSessionPayload, prepareLiveSessionPayload, type LiveSessionPayloadVersion, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { liveItemValueCopper, reduceLiveInventorySample } from './live-session-reducer';
import { isLiveSessionFormat, LEGACY_LIVE_SESSION_FORMAT, newLiveSessionFormat } from './live-session-format';
import { computeSummaryFigures } from './live-session-summary-figures';

const AT = Date.parse('2026-10-09T12:00:00.000Z');
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
/** A cheap item that comes in by the pile: 250 units at a best buy order of 8 c. */
const CHEAP = 12147;
/** An item the session sells six of, at a best buy order of 3 c. */
const SOLD = 24;
/** The same market read two ways: the bid as the trading post gives it, and what ONE unit of it nets (8 - 1 - 1, 3 - 1 - 1). */
const GROSS: LivePriceV1[] = [{ itemId: SOLD, unitCopper: 3 }, { itemId: CHEAP, unitCopper: 8 }];
const NET: LivePriceV1[] = [{ itemId: SOLD, unitCopper: 1 }, { itemId: CHEAP, unitCopper: 6 }];
const iso = (second: number): string => new Date(AT + second * 1000).toISOString();

/** A finished session: 250 of the cheap item come in, then six of the other one leave. `prices` go into the record as they are. */
function finished(prices: LivePriceV1[]): { record: LiveSessionRuntimeRecord; journal: LiveJournalEntryV1[] } {
	const sessionId = 'session';
	let record: LiveSessionRuntimeRecord = { version: 4, kind: 'live_inventory', sessionId, phase: 'active',
		authority: { machineId: 'machine', instanceId: 'host', sessionId, fence: 1, acquiredAt: AT },
		startedAt: iso(0), endedAt: null, persistedAt: AT, sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		epoch: EPOCH, context: { state: 'gameplay', mapId: 866, character: 'Test' }, connection: 'connected', lastPresenceAt: AT,
		lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, lastSourceDisconnectedAt: null, currencyTrackedIds: [],
		lastSample: null, fingerprint: null, itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null,
		observationCount: 0, sampleCount: 0, totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0, prices: [], priceCapturedAt: null,
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: { version: 1, kind: 'bags', targetBags: 500 },
		groupContext: null, mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
	const journal: LiveJournalEntryV1[] = [];
	for (const [cursor, [cheap, sold]] of ([[0, 10], [250, 10], [250, 4]] as const).entries()) {
		const sample: LiveInventorySampleV1 = { epoch: EPOCH, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample',
			itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: 8,
			rows: [{ kind: 'item', idNumber: SOLD, quantity: sold }, { kind: 'item', idNumber: CHEAP, quantity: cheap }],
			observedAt: iso(cursor), sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: record.context! };
		const next = reduceLiveInventorySample(record, sample); record = next.record; journal.push(next.journal);
	}
	return { record: { ...record, phase: 'complete', endedAt: iso(2), prices, priceCapturedAt: iso(1) }, journal };
}

/** The payload the note of that session carries when its format is note `version` and prices in `basis`: `prices` are stated as they are. */
async function stored(version: LiveSessionPayloadVersion, basis: LivePriceBasis, prices: LivePriceV1[]): Promise<StoredLiveSessionPayloadV1> {
	const payload = await prepareLiveSessionPayload({ ...finished(prices), format: { noteVersion: version, priceBasis: basis }, locale: 'en', outputFolder: 'Sessions' });
	if (payload === null) throw new Error('The fixture session did not render.');
	return payload;
}

describe('what a quantity is worth under each price basis', () => {
	it('takes the commission once over the total of a gross sale: 250 units at 8 c net 1 700 c, not 250 times what one unit nets', () => {
		expect(liveItemValueCopper('instant_sell_gross', 8, 1)).toBe(6);
		expect(liveItemValueCopper('instant_sell_gross', 8, 250)).toBe(1_700);
		expect(liveItemValueCopper('instant_sell_net', 6, 250)).toBe(1_500);
	});
	it('gives what left the inventory the value of what came in, with the sign changed, and nothing for nothing', () => {
		expect(liveItemValueCopper('instant_sell_gross', 3, -6)).toBe(-15);
		expect(liveItemValueCopper('instant_sell_gross', 3, 6)).toBe(15);
		expect(Object.is(liveItemValueCopper('instant_sell_gross', 3, 0), 0)).toBe(true);
		expect(Object.is(liveItemValueCopper('instant_sell_gross', 0, -6), 0)).toBe(true);
	});
	it('nets zero, never a negative, when the two minimum fees take the whole sale', () => {
		expect(liveItemValueCopper('instant_sell_gross', 1, 1)).toBe(0);
		expect(liveItemValueCopper('instant_sell_gross', 1, 10)).toBe(8);
	});
	it('has no value for a total outside the safe-integer range, in either basis', () => {
		expect(liveItemValueCopper('instant_sell_gross', Number.MAX_SAFE_INTEGER, 2)).toBeNull();
		expect(liveItemValueCopper('instant_sell_net', Number.MAX_SAFE_INTEGER, 2)).toBeNull();
	});
	it('starts a session of note version 1 in net per unit and one of version 2 in gross per unit; this build starts version 1 sessions', () => {
		expect(livePriceBasisOf(1)).toBe('instant_sell_net');
		expect(livePriceBasisOf(2)).toBe('instant_sell_gross');
		expect(LIVE_SESSION_NOTE_WRITE_VERSION).toBe(1);
		expect(newLiveSessionFormat()).toEqual({ noteVersion: 1, priceBasis: 'instant_sell_net' });
	});
	it('has no format for a version 1 session kept in gross prices, and takes a session with no mark for one from before the mark', () => {
		expect(isLiveSessionFormat({ noteVersion: 1, priceBasis: 'instant_sell_net' })).toBe(true);
		expect(isLiveSessionFormat({ noteVersion: 2, priceBasis: 'instant_sell_gross' })).toBe(true);
		expect(isLiveSessionFormat({ noteVersion: 2, priceBasis: 'instant_sell_net' })).toBe(true);
		expect(isLiveSessionFormat({ noteVersion: 1, priceBasis: 'instant_sell_gross' })).toBe(false);
		expect(isLiveSessionFormat({ noteVersion: 3, priceBasis: 'instant_sell_gross' })).toBe(false);
		expect(LEGACY_LIVE_SESSION_FORMAT).toEqual({ noteVersion: 1, priceBasis: 'instant_sell_net' });
	});
});

describe('a saved live session is read in the price basis it states', () => {
	it('accepts a version 2 note with gross prices and values every figure over the totals', async () => {
		const session = await stored(2, 'instant_sell_gross', GROSS);
		expect(isStoredLiveSessionPayload(session)).toBe(true);
		expect(session.valuation).toMatchObject({ priceBasis: 'instant_sell_gross', prices: GROSS,
			positiveItemValueKnownCopper: 1_700, netItemValueKnownCopper: 1_685, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] });

		const view = liveSessionViewFromStored(session, 0);
		expect(view.valuation).toEqual(session.valuation);
		// The chart is revalued point by point in the same basis: the pile alone, then the pile less what was sold.
		expect(view.chartPoints.map((point) => point.netItemValueKnownCopper)).toEqual([0, 1_700, 1_685]);

		expect(buildLiveSessionComparison([session]).rows[0]).toMatchObject({ knownItemValueCopper: 1_685, unpricedItemCount: 0 });

		const figures = computeSummaryFigures(session, { [CHEAP]: { flags: [], type: 'CraftingMaterial' }, [SOLD]: { flags: [], type: 'CraftingMaterial' } }, []);
		expect(figures).toMatchObject({ netCopper: 1_685, positiveCopper: 1_700, noPrices: false });
		expect(figures.sellable).toEqual([{ itemId: CHEAP, quantity: 250, valueCopper: 1_700, container: false }]);

		const csv = serializeLiveSessionExport(session, 'timeline', 'csv');
		expect(csv).toContain('"instant_sell_gross"');
		expect(csv).not.toContain('"instant_sell_net"');
		expect(csv.split('\r\n').filter((line) => line.startsWith('"price"')).map((line) => line.split(',')[31])).toEqual(['"3"', '"8"']);
		expect(JSON.parse(serializeLiveSessionExport(session, 'summary', 'json'))).toMatchObject({ session: { valuation: { priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 1_685 } } });
	});

	it('still values a net price per unit times the quantity, in a note of either version', async () => {
		for (const version of [1, 2] as const) {
			const session = await stored(version, 'instant_sell_net', NET);
			expect(isStoredLiveSessionPayload(session), `version ${String(version)}`).toBe(true);
			expect(session.valuation).toMatchObject({ priceBasis: 'instant_sell_net', positiveItemValueKnownCopper: 1_500, netItemValueKnownCopper: 1_494 });
			expect(liveSessionViewFromStored(session, 0).chartPoints.map((point) => point.netItemValueKnownCopper)).toEqual([0, 1_500, 1_494]);
			expect(buildLiveSessionComparison([session]).rows[0]).toMatchObject({ knownItemValueCopper: 1_494 });
			const figures = computeSummaryFigures(session, {}, []);
			expect(figures).toMatchObject({ netCopper: 1_494, positiveCopper: 1_500 });
			expect(figures.sellable).toEqual([{ itemId: CHEAP, quantity: 250, valueCopper: 1_500, container: false }]);
			expect(serializeLiveSessionExport(session, 'timeline', 'csv')).toContain('"instant_sell_net"');
		}
	});

	it('writes what it always wrote for a version 1 note: the prices at hand as net per unit', async () => {
		const written = await prepareLiveSessionPayload({ ...finished(NET), format: LEGACY_LIVE_SESSION_FORMAT, locale: 'en', outputFolder: 'Sessions' });
		expect(written?.valuation).toEqual({ priceBasis: 'instant_sell_net', capturedAt: iso(1), prices: NET,
			positiveItemValueKnownCopper: 1_500, netItemValueKnownCopper: 1_494, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] });
		expect(written).toEqual(await stored(1, 'instant_sell_net', NET));
	});

	it('ranks the items of a session by the value its basis gives them, not by unit price times quantity', () => {
		// What a sale nets never goes down as its total goes up (the two fees never step up at the same copper), so the plain product
		// and the net over the total can only disagree where two totals net the same: 30 c and 29 c both leave 25 c. There the
		// larger pile goes first, as in every tie, while the product would put the single 30 c unit ahead of it.
		const totals = [{ kind: 'item' as const, idNumber: 1, positive: 1, negative: 0, net: 1 }, { kind: 'item' as const, idNumber: 2, positive: 29, negative: 0, net: 29 }];
		const prices = [{ itemId: 1, unitCopper: 30 }, { itemId: 2, unitCopper: 1 }];
		expect(liveItemValueCopper('instant_sell_gross', 30, 1)).toBe(25);
		expect(liveItemValueCopper('instant_sell_gross', 1, 29)).toBe(25);
		expect(sortLiveItemsByValue(totals, prices, 'instant_sell_gross').map((row) => row.idNumber)).toEqual([2, 1]);
		// The same numbers as net prices are worth 30 c and 29 c, and with no basis named they are net.
		expect(sortLiveItemsByValue(totals, prices, 'instant_sell_net').map((row) => row.idNumber)).toEqual([1, 2]);
		expect(sortLiveItemsByValue(totals, prices).map((row) => row.idNumber)).toEqual([1, 2]);
	});
	it('never ranks a smaller net above a larger one: the net of a sale does not fall as its total rises', () => {
		// Kept to 20 000 c so it stays fast. The independent review of 9 Oct 2026 swept every total up to 6 000 000 c and found no fall.
		let previous = 0; const falls: number[] = [];
		for (let gross = 1; gross <= 20_000; gross += 1) {
			const net = liveItemValueCopper('instant_sell_gross', gross, 1)!;
			if (net - previous !== 0 && net - previous !== 1) falls.push(gross);
			previous = net;
		}
		expect(falls).toEqual([]);
	});
});

describe('what the validator refuses about the price basis', () => {
	it('a version 1 note that states gross prices, which a 0.6.16 could not read', async () => {
		const gross = await stored(2, 'instant_sell_gross', GROSS);
		const old = await stored(1, 'instant_sell_net', NET);
		expect(isStoredLiveSessionPayload(old)).toBe(true);
		// The gross valuation is arithmetically sound; it is the version that cannot carry it.
		expect(isStoredLiveSessionPayload({ ...old, valuation: gross.valuation })).toBe(false);
		expect(isStoredLiveSessionPayload({ ...old, valuation: { ...old.valuation, priceBasis: 'instant_sell_gross' } })).toBe(false);
	});

	it('subtotals that are not the ones the stated basis gives', async () => {
		const gross = await stored(2, 'instant_sell_gross', GROSS);
		const net = await stored(2, 'instant_sell_net', GROSS);
		expect(isStoredLiveSessionPayload(gross)).toBe(true); expect(isStoredLiveSessionPayload(net)).toBe(true);
		// Gross prices with the per-unit products (2 000 c for the pile), and the other way round.
		expect(isStoredLiveSessionPayload({ ...gross, valuation: { ...net.valuation, priceBasis: 'instant_sell_gross' } })).toBe(false);
		expect(isStoredLiveSessionPayload({ ...net, valuation: { ...gross.valuation, priceBasis: 'instant_sell_net' } })).toBe(false);
		expect(isStoredLiveSessionPayload({ ...gross, valuation: { ...gross.valuation, positiveItemValueKnownCopper: 1_500 } })).toBe(false);
	});

	it('a basis it does not know, in either version', async () => {
		for (const version of [1, 2] as const) {
			const session = await stored(version, 'instant_sell_net', NET);
			expect(isStoredLiveSessionPayload({ ...session, valuation: { ...session.valuation, priceBasis: 'listing_net' } }), `version ${String(version)}`).toBe(false);
			const unstated: Partial<typeof session.valuation> = { ...session.valuation }; delete unstated.priceBasis;
			expect(isStoredLiveSessionPayload({ ...session, valuation: unstated }), `version ${String(version)}, no basis`).toBe(false);
		}
	});

	it('a valuation that mixes bases: a price row has no basis of its own, the one stated covers them all', async () => {
		const gross = await stored(2, 'instant_sell_gross', GROSS);
		const mixed = structuredClone(gross) as unknown as { valuation: { prices: Record<string, unknown>[] } };
		mixed.valuation.prices[0] = { ...mixed.valuation.prices[0], priceBasis: 'instant_sell_net' };
		expect(isStoredLiveSessionPayload(mixed)).toBe(false);
		// And a row stated in the other basis without saying so does not match the subtotals: one net row among gross ones.
		const disguised = structuredClone(gross); disguised.valuation.prices = [NET[0]!, GROSS[1]!];
		expect(isStoredLiveSessionPayload(disguised)).toBe(false);
	});
});
