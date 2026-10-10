import { isPublicCatalogNotFound, type PublicCatalogGateway, type PublicCatalogResponse } from '../catalog/public-catalog-client';
import type { CatalogCurrency, CatalogIdCoverage, CatalogItem } from '../catalog/public-catalog-model';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { HALLOWEEN_TOT_BAG_ITEM_ID } from '../economy/session-valuation';
import { PRICE_INGAME_QUOTE_REFRESH_MS } from '../alerts/price-ingame-state';
import type { BagRawQuote } from '../runtime/farming-runtime-projection';
import { parsePublicTradingPostPriceBatch } from '../economy/session-price-snapshot';
import type { AlertDeliveryReport } from '../alerts/alert-emitter';
import type { LiveAlertOutboxV1, LiveJournalEntryV1 } from './live-session-model';
import type { LiveSessionLifecycle } from './live-session-lifecycle';
import { decideLiveAlert } from './live-session-outbox';

interface LiveEconomyOptions {
	lifecycle: LiveSessionLifecycle; gateway: PublicCatalogGateway; rateLimit: RateLimitCoordinator;
	now(): number; catalog(ids: readonly number[]): Promise<Record<string,CatalogItem>>;
	/** Local catalog cache only, any age, never a request: how a restored session gets its labels back. */
	cachedItems(ids: readonly number[]): Promise<Record<string,CatalogItem>>;
	/** Public `currencies` lookup (name, icon) for ONLY the coins this session observed; `coverage` says how each id fared. */
	currencies(ids: readonly number[]): Promise<{currencies: Record<string,CatalogCurrency>; coverage: Record<string,CatalogIdCoverage>}>;
	/** Local currency cache only, any age, never a request. */
	cachedCurrencies(ids: readonly number[]): Promise<Record<string,CatalogCurrency>>;
	canEmit?(): boolean;
	emit(intent: LiveAlertOutboxV1): Promise<AlertDeliveryReport>; onError(error: unknown): void; onChange(): void;
}
/** A coin the public catalog could not name: `unavailable` is a failed request, `missing` an id it does not know (404). */
class CurrencyCatalogUnavailableError extends Error { constructor() { super('The currency catalog could not be read.'); this.name = 'CurrencyCatalogUnavailableError'; } }
class CurrencyCatalogMissingError extends Error { constructor() { super('The currency catalog does not know an observed currency.'); this.name = 'CurrencyCatalogMissingError'; } }
/** A coin that stayed unresolved is asked again at most this often; the catalog service itself caches a 404 for an hour. */
const CURRENCY_RETRY_MS = 5 * 60_000;
/** A quote older than this is no longer fresh: the entry's own items are asked again, and a held item's is not counted. */
const QUOTE_FRESH_MS = 15 * 60_000;
/** An item the session holds but no read has quoted (a failed request, a rate limit) is asked again at most this often, and at most this many per pass. */
const UNQUOTED_RETRY_MS = 60_000;
/** One public price batch carries up to 200 ids; a retry pass adds 50 at most so a long unpriced list never turns into a burst. */
const UNQUOTED_RETRY_MAX = 50;
/** Older entries whose alert still awaits a price, or a claim, that are looked at per pass; the rest wait for the next one. */
const AWAITING_ENTRIES_MAX = 20;
/** A journal entry's identity. The session is part of it: two sessions of one game process share the epoch and repeat its cursors. */
function journalKey(entry: Pick<LiveJournalEntryV1,'sessionId' | 'epoch' | 'cursor'>): string { return `${entry.sessionId}/${entry.epoch}/${String(entry.cursor)}`; }

/**
 * Public catalog and price requests run only in `enrich()`, after the durable measurement ACK, never
 * during rendering. Rendering may read labels from the LOCAL catalog cache (no network, any age).
 */
export class LiveSessionEconomy {
	private readonly entities = new Map<number,{name:string;icon:string|null}>();
	/**
	 * Unit prices of the session `quotesSession`, in the basis that session keeps (`LiveSessionLifecycle.getSessionFormat()`): the
	 * same one the record they are saved to and restored from is in. They are dropped when the session changes, so a quote read
	 * for a session in one basis never values another.
	 */
	private readonly quotes = new Map<number,{unitCopper:number|null;capturedAt:number}>();
	/** Ids a panel asked for and nobody has resolved yet, and ids whose cache read already missed (cleared when `enrich()` resolves something). */
	private readonly wanted = new Set<number>();
	private readonly tried = new Set<number>();
	/** The same four pieces for coins, which live apart from items: an item id and a currency id can coincide. */
	private readonly currencyEntities = new Map<number,{name:string;icon:string|null}>();
	private readonly wantedCurrencies = new Set<number>();
	private readonly triedCurrencies = new Set<number>();
	private readonly currencyAskedAt = new Map<number,number>();
	private readonly unquotedAskedAt = new Map<number,number>();
	/** When the price of each item was last asked of the trading post, by any pass and whatever came back: what spaces a retry pass. */
	private readonly priceAskedAt = new Map<number,number>();
	/** The session `quotes` were gathered for: a new session starts without the previous one's quotes. */
	private quotesSession: string | null = null;
	/** Gross best bid and lowest ask of the Halloween bag from the last public read of THIS process; a restored quote has none. */
	private bagRaw: BagRawQuote | null = null;
	private bagAttemptedAt: number | null = null;
	private bagRefreshing = false;
	/**
	 * Alerts a pass decided (`ready`) or was about to decide and could not carry through, by outbox id, with the entry each belongs
	 * to: the claim is a durable write, and storage or the lease can refuse it. Without this list such an alert was looked at again
	 * only on a start or a mode switch, and closing the session skipped it. Every pass tries them, and so does `retryUnclaimedAlerts()`.
	 */
	private readonly unclaimed = new Map<string,LiveJournalEntryV1>();
	/** The entry of the pass `retryUnclaimedAlerts()` asked for while that pass waits in the queue: asking again adds nothing. */
	private retryQueued: LiveJournalEntryV1 | null = null;
	private lookup: Promise<void> | null = null;
	private flight = Promise.resolve();
	private disposed = false;
	constructor(private readonly options: LiveEconomyOptions) {}
	/**
	 * Names live only in memory, so after a plugin reload they are empty for a restored session
	 * (finished or running). A miss reads the local catalog cache once (no network) and repaints
	 * through `onChange`; an id absent from the cache stays a placeholder until `enrich()` resolves it.
	 */
	entity(kind: 'item'|'currency', id: number): {name:string;icon:string|null}|null {
		const known = (kind === 'item' ? this.entities : this.currencyEntities).get(id);
		if (known) return known;
		this.want(kind,id);
		return null;
	}
	private want(kind: 'item'|'currency', id: number): void {
		const wanted = kind === 'item' ? this.wanted : this.wantedCurrencies;
		if (this.disposed || wanted.has(id)) return;
		if ((kind === 'item' ? this.tried : this.triedCurrencies).has(id)) return;
		wanted.add(id);
		this.lookup ??= Promise.resolve().then(async () => await this.resolveWanted());
	}
	private async resolveWanted(): Promise<void> {
		const ids = [...this.wanted]; this.wanted.clear();
		const currencyIds = [...this.wantedCurrencies]; this.wantedCurrencies.clear(); this.lookup = null;
		for (const id of ids) this.tried.add(id);
		for (const id of currencyIds) this.triedCurrencies.add(id);
		if (this.disposed) return;
		if (currencyIds.length > 0) {
			try {
				const metadata = await this.options.cachedCurrencies(currencyIds);
				if (this.disposed) return;
				let changed = false;
				for (const currency of Object.values(metadata)) if (!this.currencyEntities.has(currency.id)) { this.currencyEntities.set(currency.id,{name:currency.name,icon:currency.icon}); changed = true; }
				if (changed) this.options.onChange();
			} catch { /* A cosmetic lookup that fails keeps "Currency <id>" until `enrich()` resolves it. */ }
		}
		if (ids.length === 0) return;
		try {
			const metadata = await this.options.cachedItems(ids);
			if (this.disposed) return;
			let changed = false;
			for (const item of Object.values(metadata)) if (!this.entities.has(item.id)) { this.entities.set(item.id,{name:item.name,icon:item.icon ?? null}); changed = true; }
			if (changed) this.options.onChange();
		} catch { /* A cosmetic lookup that fails (offline, no catalog) keeps "Item <id>" until `enrich()` resolves it. */ }
	}
	/** Raw public quote kept for `price2`; only the Halloween bag is retained, and a restored net quote is not one (the session valuation keeps its fees; `price2` never uses them). */
	rawQuote(itemId: number): BagRawQuote | null {
		return itemId === HALLOWEEN_TOT_BAG_ITEM_ID ? this.bagRaw : null;
	}
	/**
	 * Keeps the bag quote at most `PRICE_INGAME_QUOTE_REFRESH_MS` old. It has no timer of its own: the
	 * in-game bridge calls it from its 5 s state tick, and only for a connection subscribed to `price2`,
	 * so with no subscriber nothing runs. Requires an `active` live session, an allowed host (not
	 * consulting, not unloaded) and an inactive rate limit; one request in flight at most. A failure keeps
	 * the previous quote, and the attempt itself spaces the next one by the same 120 s.
	 */
	refreshBagQuote(): void {
		const now = this.options.now();
		if (this.disposed || this.bagRefreshing || this.options.canEmit?.() === false) return;
		if (this.options.lifecycle.getRuntime()?.phase !== 'active' || this.options.rateLimit.status().active) return;
		const last = Math.max(this.bagRaw?.capturedAt ?? -Infinity, this.bagAttemptedAt ?? -Infinity);
		if (now - last < PRICE_INGAME_QUOTE_REFRESH_MS) return;
		this.bagRefreshing = true; this.bagAttemptedAt = now;
		this.flight = this.flight.then(async () => { await this.fetchBagQuote(); })
			.catch((error: unknown) => { this.options.onError(error); })
			.finally(() => { this.bagRefreshing = false; });
	}
	private async fetchBagQuote(): Promise<void> {
		if (this.disposed || this.options.lifecycle.getRuntime()?.phase !== 'active') return;
		const id = HALLOWEEN_TOT_BAG_ITEM_ID; let response: PublicCatalogResponse;
		try { response = await this.options.gateway.requestDetailed(`commerce/prices?ids=${String(id)}`,undefined,[id]); }
		catch (error) { if (!isPublicCatalogNotFound(error)) throw error; response = {status:404,headers:{},body:[]}; }
		if (response.status === 429) { this.options.rateLimit.recordRateLimited(null); return; }
		if (![200,206,404].includes(response.status) || !Array.isArray(response.body) || this.disposed) return;
		this.recordPrice(id,parsePublicTradingPostPriceBatch(response.body,new Set([id])).items.find((price) => price.itemId === id));
	}
	/**
	 * One place for what a public read of an id means: the bid for the session, in the basis the session in course keeps (its own,
	 * fixed when it started: `getSessionFormat()`), plus the raw sides for the bag. Net per unit: what one unit nets, or no price when
	 * the commission leaves nothing of it. Gross per unit: the bid as read, and the commission is worked out later over each total
	 * that is valued; a bid of 1 c is then a price like any other (one unit of it nets 0 c, ten net 8 c), where net per unit has none.
	 */
	private recordPrice(id: number, price: {bid: {unitCopper:number}|null; ask: {unitCopper:number}|null}|undefined): void {
		const capturedAt = this.options.now();
		const bid = price?.bid; let unitCopper: number | null = null;
		if (bid && this.options.lifecycle.getSessionFormat().priceBasis === 'instant_sell_gross') unitCopper = Number.isSafeInteger(bid.unitCopper) && bid.unitCopper > 0 ? bid.unitCopper : null;
		else if (bid) { const priced = createTradingPostValueWithPolicy('instant_sell',bid.unitCopper,1); unitCopper = priced.status === 'ok' ? priced.value.netCopper : null; }
		this.quotes.set(id,{unitCopper,capturedAt});
		if (id === HALLOWEEN_TOT_BAG_ITEM_ID) this.bagRaw = {bid: price?.bid?.unitCopper ?? null, ask: price?.ask?.unitCopper ?? null, capturedAt};
	}
	observe(entry: LiveJournalEntryV1): void {
		if (this.disposed || entry.observations.length === 0 && entry.outbox.length === 0) return;
		this.flight = this.flight.then(async () => await this.enrich(entry)).catch((error: unknown) => { this.options.onError(error); });
	}
	/**
	 * Looks again at the alerts a pass decided and could not claim (`unclaimed`). The lifecycle has no signal of its own for
	 * «storage is back»; what it does when a refused write finally lands is report a state change, so the host calls this from
	 * there. With nothing owed it does nothing, and at most one such pass waits in the queue however often it is called.
	 * It goes through `observe`, the path a start or a mode switch already use for the alerts left unsettled: one pass over
	 * one owed entry, which tries every other owed alert too. That pass asks the trading post for the entry's items only when
	 * their quote is stale AND nobody asked for them in the last `UNQUOTED_RETRY_MS`, so a failing trading post is not asked
	 * once per state change.
	 */
	retryUnclaimedAlerts(): void {
		if (this.disposed || this.retryQueued !== null || this.unclaimed.size === 0) return;
		const [owed] = this.unclaimed.values();
		if (owed === undefined) return;
		this.retryQueued = owed; this.observe(owed);
	}
	async dispose(): Promise<void> { this.disposed = true; await this.flight; await this.lookup; }
	async drain(): Promise<void> { await this.flight; await this.lookup; }
	/**
	 * One public `currencies?ids=` read for the coins this entry observed and nobody has named yet (never the wallet).
	 * It cannot fail the entry: an unavailable catalog or an unknown id is reported through `onError` and the tile
	 * keeps its fallback name until a later entry asks again, at most every `CURRENCY_RETRY_MS`.
	 */
	private async enrichCurrencies(entry: LiveJournalEntryV1): Promise<void> {
		const now = this.options.now();
		const ids = [...new Set(entry.observations.filter((row) => row.kind === 'currency').map((row) => row.idNumber))]
			.filter((id) => !this.currencyEntities.has(id) && now - (this.currencyAskedAt.get(id) ?? -Infinity) >= CURRENCY_RETRY_MS);
		if (ids.length === 0 || this.options.rateLimit.status().active) return;
		for (const id of ids) this.currencyAskedAt.set(id,now);
		try {
			const found = await this.options.currencies(ids);
			if (this.disposed) return;
			for (const currency of Object.values(found.currencies)) this.currencyEntities.set(currency.id,{name:currency.name,icon:currency.icon});
			const unresolved = ids.filter((id) => !this.currencyEntities.has(id));
			if (unresolved.some((id) => found.coverage[String(id)]?.status === 'unavailable' || found.coverage[String(id)] === undefined)) this.options.onError(new CurrencyCatalogUnavailableError());
			if (unresolved.some((id) => { const status = found.coverage[String(id)]?.status; return status === 'missing' || status === 'invalid' || status === 'malformed'; })) this.options.onError(new CurrencyCatalogMissingError());
			this.triedCurrencies.clear();
			if (unresolved.length < ids.length) this.options.onChange();
		} catch (error) { this.options.onError(error); }
	}
	private async enrich(entry: LiveJournalEntryV1): Promise<void> {
		const lifecycle = this.options.lifecycle; const runtime = lifecycle.getRuntime();
		// A pass asked for by `retryUnclaimedAlerts()` is there to claim, not to quote: it can run on every state change of the session.
		const retrying = entry === this.retryQueued; if (retrying) this.retryQueued = null;
		// An alert of a session that is over is owed to nobody: closing it skipped every alert still `ready`.
		for (const [outboxId,row] of this.unclaimed) if (runtime?.phase !== 'active' || row.sessionId !== runtime.sessionId) this.unclaimed.delete(outboxId);
		if (this.disposed || runtime?.phase !== 'active' || runtime.sessionId !== entry.sessionId) return;
		await this.enrichCurrencies(entry);
		if (this.disposed || lifecycle.getRuntime()?.phase !== 'active' || lifecycle.getRuntime()?.sessionId !== entry.sessionId) return;
		const ids = [...new Set(entry.observations.filter((row) => row.kind === 'item').map((row) => row.idNumber))];
		const now = this.options.now();
		if (this.quotesSession !== runtime.sessionId) { this.quotes.clear(); this.unquotedAskedAt.clear(); this.priceAskedAt.clear(); this.quotesSession = runtime.sessionId; }
		for (const price of runtime.prices) if (!this.quotes.has(price.itemId) && runtime.priceCapturedAt !== null) this.quotes.set(price.itemId,{unitCopper:price.unitCopper,capturedAt:Date.parse(runtime.priceCapturedAt)});
		// Held items no read has quoted (a 404 DOES record a null quote, so only a failed or skipped request leaves one here) or
		// whose quote is older than the criterion for a fresh one: asked again, 60 s apart per id and 50 per pass.
		const retry = runtime.totals.filter((total) => total.kind === 'item' && !ids.includes(total.idNumber) && (!this.quotes.has(total.idNumber) || now - this.quotes.get(total.idNumber)!.capturedAt > QUOTE_FRESH_MS)
			&& now - (this.unquotedAskedAt.get(total.idNumber) ?? -Infinity) >= UNQUOTED_RETRY_MS).map((total) => total.idNumber).slice(0,UNQUOTED_RETRY_MAX);
		// The entry's own items are asked whenever their quote is missing or no longer fresh. In a retry pass they keep the spacing of
		// the items above, counted from the last time anyone asked: a trading post that fails (an error, a 5xx) records no quote, and
		// without the spacing every state change of a session with an alert owed would be one more request.
		const missing = [...ids.filter((id) => (!this.quotes.has(id) || now - this.quotes.get(id)!.capturedAt > QUOTE_FRESH_MS)
			&& (!retrying || now - (this.priceAskedAt.get(id) ?? -Infinity) >= UNQUOTED_RETRY_MS)),...retry];
		if (missing.length > 0 && !this.options.rateLimit.status().active) {
			for (const id of retry) this.unquotedAskedAt.set(id,now);
			for (const id of missing) this.priceAskedAt.set(id,now);
			const metadata = await this.options.catalog([...new Set([...ids,...retry])]);
			for (const item of Object.values(metadata)) this.entities.set(item.id,{name:item.name,icon:item.icon ?? null});
			for (let offset = 0; offset < missing.length; offset += 200) {
				if (this.disposed || this.options.rateLimit.status().active) break;
				const batch = missing.slice(offset,offset+200); let response: PublicCatalogResponse;
				// The Trading Post answers 404 (thrown by the transport) when NONE of the ids is quoted and 206 when only some are:
				// both mean "no price" for the unquoted ids, never "abort the entry", or their priced neighbours stay undecided until close.
				try { response = await this.options.gateway.requestDetailed(`commerce/prices?ids=${batch.join(',')}`,undefined,batch); }
				catch (error) { if (!isPublicCatalogNotFound(error)) throw error; response = {status:404,headers:{},body:[]}; }
				if (response.status === 429) { this.options.rateLimit.recordRateLimited(null); break; }
				if (![200,206,404].includes(response.status) || !Array.isArray(response.body)) continue;
				const parsed = parsePublicTradingPostPriceBatch(response.body,new Set(batch));
				for (const id of batch) this.recordPrice(id,parsed.items.find((price) => price.itemId === id));
			}
		}
		if (this.disposed || lifecycle.getRuntime()?.phase !== 'active' || lifecycle.getRuntime()?.sessionId !== entry.sessionId) return;
		const priceIds = new Set([...runtime.prices.map((row) => row.itemId),...ids,...retry,
			...runtime.totals.filter((total) => total.kind === 'item' && this.quotes.has(total.idNumber) && now - this.quotes.get(total.idNumber)!.capturedAt <= QUOTE_FRESH_MS).map((total) => total.idNumber)]); // a quote read elsewhere (the bag refresh) still values what the session holds
		const pricedIds = [...priceIds].filter((id) => this.quotes.has(id));
		if (pricedIds.length > 0) await lifecycle.updatePrices(pricedIds.map((itemId) => ({itemId,unitCopper:this.quotes.get(itemId)!.unitCopper})),
			new Date(Math.min(...pricedIds.map((id) => this.quotes.get(id)!.capturedAt))).toISOString());
		// Older entries whose alert is still waiting for a price a failed read never delivered: decided as soon as a later read quotes the item.
		const waiting = lifecycle.getAwaitingPriceEntries((id) => this.quotes.has(id),AWAITING_ENTRIES_MAX,entry);
		// And the entries with an alert an earlier pass decided and could not claim (see `unclaimed`): this pass tries them again.
		const visited = new Set([entry,...waiting].map((row) => journalKey(row)));
		const owed = [...new Map([...this.unclaimed.values()].map((row) => [journalKey(row),row])).values()]
			.filter((row) => !visited.has(journalKey(row))).slice(0,AWAITING_ENTRIES_MAX);
		for (const target of [entry,...waiting,...owed]) for (const candidate of target.outbox) {
			if (this.options.canEmit?.() === false) return;
			const observation = target.observations.find((row) => row.id === candidate.observationId); if (!observation) continue;
			const quote = this.quotes.get(observation.idNumber);
			if (candidate.state === 'awaiting_price' && quote) await lifecycle.updateAlert(candidate.outboxId,(prior) =>
				decideLiveAlert(prior,observation,quote.unitCopper,this.entities.get(observation.idNumber)?.name ?? String(observation.idNumber),new Date(quote.capturedAt).toISOString(),false,lifecycle.getSessionFormat().priceBasis));
			// The claim is the one durable step that lets an alert sound, and only a `ready` one can take it: an alert already
			// `dispatching` or `processed` comes back unchanged, so looking at it again can never make it sound twice.
			const found: {state: LiveAlertOutboxV1['state'] | null} = {state: null};
			if (candidate.state === 'ready' || candidate.state === 'awaiting_price' && quote) this.unclaimed.set(candidate.outboxId,target);
			const claimed = await lifecycle.updateAlert(candidate.outboxId,(prior) => { found.state = prior.state; return prior.state === 'ready'
				? {...prior,state:'dispatching',claimedAt:new Date(this.options.now()).toISOString()} : prior; });
			// Still owed while it is `ready` (storage refused the claim), while its decision could not be written either (still
			// awaiting a price this pass has), or while the lifecycle could not look at all (no lease, no storage). Otherwise it is settled.
			const owedStill = claimed?.state !== 'dispatching' && (found.state === null || found.state === 'ready' || found.state === 'awaiting_price' && quote !== undefined);
			if (!owedStill) this.unclaimed.delete(candidate.outboxId);
			if (claimed?.state !== 'dispatching' || claimed.alert === null || this.disposed) continue;
			if (this.options.canEmit?.() === false) return;
			const report = await this.options.emit(claimed);
			await lifecycle.updateAlert(candidate.outboxId,(prior) => ({...prior,state:'processed',deliveryReport:report}),true);
		}
		this.tried.clear(); // what enrich() just fetched may have filled the cache for ids a render missed
		this.options.onChange();
	}
}
