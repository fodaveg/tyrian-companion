import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { parsePublicTradingPostPriceBatch } from '../economy/session-price-snapshot';
import type { AlertDeliveryReport } from '../alerts/alert-emitter';
import type { LiveAlertOutboxV1, LiveJournalEntryV1 } from './live-session-model';
import type { LiveSessionLifecycle } from './live-session-lifecycle';
import { decideLiveAlert } from './live-session-outbox';

interface LiveEconomyOptions {
	lifecycle: LiveSessionLifecycle; gateway: PublicCatalogGateway; rateLimit: RateLimitCoordinator;
	now(): number; catalog(ids: readonly number[]): Promise<Record<string,CatalogItem>>;
	canEmit?(): boolean;
	emit(intent: LiveAlertOutboxV1): Promise<AlertDeliveryReport>; onError(error: unknown): void; onChange(): void;
}
const RETRY_MS = 5 * 60_000;
/** Public, cached enrichment runs after the durable measurement ACK, never during rendering. */
export class LiveSessionEconomy {
	private readonly entities = new Map<number,{name:string;icon:string|null}>();
	private readonly quotes = new Map<number,{unitCopper:number|null;capturedAt:number}>();
	/** Ids a panel asked for and nobody has resolved yet, and when each id was last tried (so a miss is not a loop). */
	private readonly wanted = new Set<number>();
	private readonly tried = new Map<number,number>();
	private lookup: Promise<void> | null = null;
	private flight = Promise.resolve();
	private disposed = false;
	constructor(private readonly options: LiveEconomyOptions) {}
	/**
	 * Names live only in memory, so after a plugin reload they are empty for a restored session
	 * (finished or running) until something resolves them. A miss therefore asks the public catalog
	 * (cache first, ids only) once per `RETRY_MS` and repaints through `onChange` when it answers.
	 */
	entity(kind: 'item'|'currency', id: number): {name:string;icon:string|null}|null {
		if (kind !== 'item') return null;
		const known = this.entities.get(id);
		if (known) return known;
		this.want(id);
		return null;
	}
	private want(id: number): void {
		if (this.disposed || this.wanted.has(id)) return;
		const last = this.tried.get(id);
		if (last !== undefined && this.options.now() - last < RETRY_MS) return;
		this.wanted.add(id);
		this.lookup ??= Promise.resolve().then(async () => await this.resolveWanted());
	}
	private async resolveWanted(): Promise<void> {
		const ids = [...this.wanted]; this.wanted.clear(); this.lookup = null;
		const now = this.options.now();
		for (const id of ids) this.tried.set(id,now);
		if (this.disposed || this.options.rateLimit.status().active) return;
		try {
			const metadata = await this.options.catalog(ids);
			if (this.disposed) return;
			let changed = false;
			for (const item of Object.values(metadata)) if (!this.entities.has(item.id)) { this.entities.set(item.id,{name:item.name,icon:item.icon ?? null}); changed = true; }
			if (changed) this.options.onChange();
		} catch { /* A cosmetic lookup that fails (offline, no catalog) keeps "Item <id>" and is retried after RETRY_MS. */ }
	}
	observe(entry: LiveJournalEntryV1): void {
		if (this.disposed || entry.observations.length === 0 && entry.outbox.length === 0) return;
		this.flight = this.flight.then(async () => await this.enrich(entry)).catch((error: unknown) => { this.options.onError(error); });
	}
	async dispose(): Promise<void> { this.disposed = true; await this.flight; await this.lookup; }
	async drain(): Promise<void> { await this.flight; await this.lookup; }
	private async enrich(entry: LiveJournalEntryV1): Promise<void> {
		const lifecycle = this.options.lifecycle; const runtime = lifecycle.getRuntime();
		if (this.disposed || runtime?.phase !== 'active' || runtime.sessionId !== entry.sessionId) return;
		const ids = [...new Set(entry.observations.filter((row) => row.kind === 'item').map((row) => row.idNumber))];
		const now = this.options.now();
		for (const price of runtime.prices) if (!this.quotes.has(price.itemId) && runtime.priceCapturedAt !== null) this.quotes.set(price.itemId,{unitCopper:price.unitCopper,capturedAt:Date.parse(runtime.priceCapturedAt)});
		const missing = ids.filter((id) => !this.quotes.has(id) || now - this.quotes.get(id)!.capturedAt > 15 * 60_000);
		if (missing.length > 0 && !this.options.rateLimit.status().active) {
			const metadata = await this.options.catalog(ids);
			for (const item of Object.values(metadata)) this.entities.set(item.id,{name:item.name,icon:item.icon ?? null});
			for (let offset = 0; offset < missing.length; offset += 200) {
				if (this.disposed || this.options.rateLimit.status().active) break;
				const batch = missing.slice(offset,offset+200); const response = await this.options.gateway.requestDetailed(`commerce/prices?ids=${batch.join(',')}`,undefined,batch);
				if (response.status === 429) { this.options.rateLimit.recordRateLimited(null); break; }
				if (response.status !== 200 || !Array.isArray(response.body)) continue;
				const parsed = parsePublicTradingPostPriceBatch(response.body,new Set(batch));
				for (const id of batch) {
					const bid = parsed.items.find((price) => price.itemId === id)?.bid;
					const priced = bid ? createTradingPostValueWithPolicy('instant_sell',bid.unitCopper,1) : null;
					this.quotes.set(id,{unitCopper:priced?.status === 'ok' ? priced.value.netCopper : null,capturedAt:this.options.now()});
				}
			}
		}
		if (this.disposed || lifecycle.getRuntime()?.phase !== 'active' || lifecycle.getRuntime()?.sessionId !== entry.sessionId) return;
		const priceIds = new Set([...runtime.prices.map((row) => row.itemId),...ids]);
		const pricedIds = [...priceIds].filter((id) => this.quotes.has(id));
		if (pricedIds.length > 0) await lifecycle.updatePrices(pricedIds.map((itemId) => ({itemId,unitCopper:this.quotes.get(itemId)!.unitCopper})),
			new Date(Math.min(...pricedIds.map((id) => this.quotes.get(id)!.capturedAt))).toISOString());
		for (const candidate of entry.outbox) {
			if (this.options.canEmit?.() === false) return;
			const observation = entry.observations.find((row) => row.id === candidate.observationId); if (!observation) continue;
			const quote = this.quotes.get(observation.idNumber);
			if (candidate.state === 'awaiting_price' && quote) await lifecycle.updateAlert(candidate.outboxId,(prior) =>
				decideLiveAlert(prior,observation,quote.unitCopper,this.entities.get(observation.idNumber)?.name ?? String(observation.idNumber),new Date(quote.capturedAt).toISOString(),false));
			const claimed = await lifecycle.updateAlert(candidate.outboxId,(prior) => prior.state === 'ready'
				? {...prior,state:'dispatching',claimedAt:new Date(this.options.now()).toISOString()} : prior);
			if (claimed?.state !== 'dispatching' || claimed.alert === null || this.disposed) continue;
			if (this.options.canEmit?.() === false) return;
			const report = await this.options.emit(claimed);
			await lifecycle.updateAlert(candidate.outboxId,(prior) => ({...prior,state:'processed',deliveryReport:report}),true);
		}
		this.options.onChange();
	}
}
