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
	emit(intent: LiveAlertOutboxV1): Promise<AlertDeliveryReport>; onError(error: unknown): void; onChange(): void;
}
/** Public, cached enrichment runs after the durable measurement ACK, never during rendering. */
export class LiveSessionEconomy {
	private readonly entities = new Map<number,{name:string;icon:string|null}>();
	private readonly quotes = new Map<number,{unitCopper:number|null;capturedAt:number}>();
	private flight = Promise.resolve();
	private disposed = false;
	constructor(private readonly options: LiveEconomyOptions) {}
	entity(kind: 'item'|'currency', id: number): {name:string;icon:string|null}|null {
		return kind === 'item' ? this.entities.get(id) ?? null : null;
	}
	observe(entry: LiveJournalEntryV1): void {
		if (this.disposed || entry.observations.length === 0 && entry.outbox.length === 0) return;
		this.flight = this.flight.then(async () => await this.enrich(entry)).catch((error: unknown) => { this.options.onError(error); });
	}
	async dispose(): Promise<void> { this.disposed = true; await this.flight; }
	async drain(): Promise<void> { await this.flight; }
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
			const observation = entry.observations.find((row) => row.id === candidate.observationId); if (!observation) continue;
			const quote = this.quotes.get(observation.idNumber);
			if (candidate.state === 'awaiting_price' && quote) await lifecycle.updateAlert(candidate.outboxId,(prior) =>
				decideLiveAlert(prior,observation,quote.unitCopper,this.entities.get(observation.idNumber)?.name ?? String(observation.idNumber),new Date(quote.capturedAt).toISOString(),false));
			const claimed = await lifecycle.updateAlert(candidate.outboxId,(prior) => prior.state === 'ready'
				? {...prior,state:'dispatching',claimedAt:new Date(this.options.now()).toISOString()} : prior);
			if (claimed?.state !== 'dispatching' || claimed.alert === null || this.disposed) continue;
			const report = await this.options.emit(claimed);
			await lifecycle.updateAlert(candidate.outboxId,(prior) => ({...prior,state:'processed',deliveryReport:report}),true);
		}
		this.options.onChange();
	}
}
