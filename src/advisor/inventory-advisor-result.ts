import {
	isInventoryRecommendationEnvelope,
	type InventoryRecommendationEnvelopeV1,
} from '../economy/inventory-recommendation-envelope';
import {
	isInventoryAdvisorInput,
	isInventoryAdvisorReason,
	isInventoryAdvisorReport,
	sha256InventoryAdvisorReport,
} from './inventory-advisor-contract';
import type {
	InventoryAdvisorInputV1,
	InventoryAdvisorLineV1,
	InventoryAdvisorReasonCode,
	InventoryAdvisorResultV1,
	InventoryRecommendationDecisionV1,
} from './inventory-advisor-model';
import { buildReservationBalance, createReservationPlan } from '../economy/reservation';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import { selectInventoryMarketRoute } from './inventory-advisor-market';

export function isInventoryAdvisorResult(value: unknown): value is InventoryAdvisorResultV1 {
	try { return isInventoryAdvisorResultUnsafe(value); } catch { return false; }
}

function isInventoryAdvisorResultUnsafe(value: unknown): value is InventoryAdvisorResultV1 {
	if (!record(value) || typeof value.status !== 'string') return false;
	if (value.status === 'invalid') {
		return keys(value, ['status', 'reasons', 'report', 'envelope'])
			&& Array.isArray(value.reasons) && value.reasons.every(isInventoryAdvisorReason)
			&& value.report === null && value.envelope === null;
	}
	if (!['ready', 'limited', 'blocked'].includes(value.status)
		|| !keys(value, ['status', 'report', 'envelope'])
		|| !isInventoryAdvisorReport(value.report)
		|| !isInventoryRecommendationEnvelope(value.envelope)) return false;
	const report = value.report;
	const envelope = value.envelope;
	if (report.accountId !== envelope.accountId || report.snapshotId !== envelope.snapshotId
		|| sha256InventoryAdvisorReport(report) !== envelope.reportSha256
		|| !sameRulePack(report.rulePack, envelope.rulePack)
		|| canonical(report.lines.flatMap((line) => line.decisions)) !== canonical(envelope.decisions)) return false;
	if (value.status === 'ready') return report.coverage === 'complete';
	if (value.status === 'limited') return report.coverage === 'limited';
	return report.coverage === 'blocked'
		&& envelope.decisions.every((decision) => decision.action === 'keep' || decision.action === 'review');
}

export function isInventoryAdvisorResultForInput(
	value: unknown,
	input: unknown,
): value is InventoryAdvisorResultV1 {
	try { return isInventoryAdvisorResultForInputUnsafe(value, input); } catch { return false; }
}

function isInventoryAdvisorResultForInputUnsafe(
	value: unknown,
	input: unknown,
): value is InventoryAdvisorResultV1 {
	if (!isInventoryAdvisorInput(input) || !isInventoryAdvisorResult(value)) return false;
	if (value.status === 'invalid') return true;
	const report = value.report;
	if (report.accountId !== input.snapshot.accountId || report.snapshotId !== input.snapshot.snapshotId
		|| report.asOf !== input.asOf || canonical(report.rulePack) !== canonical(input.rulePack)) return false;
	const balanceResult = buildReservationBalance(input.snapshot);
	if (balanceResult.status !== 'ok') return false;
	const planResult = createReservationPlan({ goals: input.goals, balance: balanceResult.balance });
	if (planResult.status !== 'ok') return false;
	const planAssets = new Map(planResult.plan.assets.map((asset) => [asset.key, asset]));
	const expectedIds = Object.entries(input.snapshot.ownedByItem)
		.filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort((left, right) => left - right);
	if (report.lines.length !== expectedIds.length
		|| report.lines.some((line, index) => line.itemId !== expectedIds[index])) return false;
	for (const line of report.lines) {
		if (line.ownedQuantity !== input.snapshot.ownedByItem[String(line.itemId)]
			|| line.availableQuantity !== (input.snapshot.availableByItem[String(line.itemId)] ?? 0)) return false;
		const expectedPositions = input.snapshot.holdings
			.map((holding, holdingIndex) => ({ holding, holdingIndex }))
			.filter(({ holding }) => holding.kind === 'item' && holding.itemId === line.itemId);
		if (line.positions.length !== expectedPositions.length) return false;
		for (let index = 0; index < line.positions.length; index += 1) {
			const position = line.positions[index]!;
			const expected = expectedPositions[index]!;
			if (expected.holding.kind !== 'item' || position.holdingIndex !== expected.holdingIndex
				|| position.ref !== `#/positions/${line.itemId}/${expected.holdingIndex}`
				|| position.quantity !== expected.holding.quantity
				|| position.source !== expected.holding.location.source
				|| position.state !== expected.holding.state) return false;
		}
		const reserved = planAssets.get(`item:${line.itemId}`)?.protectedAvailable ?? 0;
		const planAsset = planAssets.get(`item:${line.itemId}`);
		if (line.reservedQuantity !== reserved) return false;
		let remaining = line.availableQuantity - reserved;
		let expectedException = 0;
		for (const exception of input.keepExceptions.filter((candidate) => candidate.status === 'active'
			&& candidate.itemId === line.itemId)) {
			const requested = exception.quantity.mode === 'all' ? remaining : exception.quantity.value;
			const allocated = Math.min(requested, remaining);
			expectedException += allocated;
			remaining -= allocated;
		}
		if (line.exceptionQuantity !== expectedException) return false;
		const catalogCoverage = input.catalog.coverage.items[String(line.itemId)];
		const catalogComplete = catalogCoverage?.status === 'resolved'
			&& ['network', 'cache_fresh'].includes(catalogCoverage.source)
			&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs);
		const pricesComplete = input.prices.status === 'complete'
			&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs);
		const signalsFresh = fresh(input.accountSignals.capturedAt, input.asOf,
			input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs);
		const signalsComplete = signalsFresh && input.accountSignals.unlockCoverage === 'complete'
			&& input.accountSignals.achievementCoverage === 'complete'
			&& input.accountSignals.tradingPostAccess !== 'unknown';
		const rulesComplete = fresh(input.rulePack.reviewedAt, input.asOf,
			input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
			&& Date.parse(input.asOf) <= Date.parse(input.rulePack.validUntil) + input.policy.maxFutureSkewMs;
		const expectedCoverage = {
			snapshot: snapshotComplete(input.snapshot) ? 'complete' : 'limited',
			inventory: planAsset?.coverage === 'complete' ? 'complete' : planAsset?.coverage === 'limited' ? 'limited' : 'unknown',
			catalog: catalogComplete ? 'complete' : catalogCoverage ? 'limited' : 'unknown',
			prices: pricesComplete ? 'complete' : input.prices.status === 'partial' ? 'limited' : 'unknown',
			reservations: planAsset?.coverage === 'complete' ? 'complete' : planAsset?.coverage === 'limited' ? 'limited' : 'unknown',
			accountSignals: signalsComplete ? 'complete' : signalsFresh ? 'limited' : 'unknown',
			rules: rulesComplete ? 'complete' : 'limited',
		};
		if (canonical(line.coverage) !== canonical(expectedCoverage)) return false;
		const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
		const sold = line.decisions.filter((decision) => decision.action === 'sell')
			.reduce((total, decision) => total + decision.quantity, 0);
		if (sold > (price?.bid?.quantity ?? 0)) return false;
		let remainingBid = price?.bid?.quantity ?? 0;
		for (const decision of line.decisions) {
			const explanation = report.explanations.find((entry) => entry.ref === decision.explanationRef);
			if (!validDecisionAgainstInput(decision, line, input, reserved, expectedException, remainingBid, explanation?.reasonCodes ?? [])) return false;
			if (decision.action === 'sell') remainingBid -= decision.quantity;
		}
	}
	return true;
}

function validDecisionAgainstInput(
	decision: InventoryRecommendationDecisionV1,
	line: InventoryAdvisorLineV1,
	input: InventoryAdvisorInputV1,
	reserved: number,
	exceptionQuantity: number,
	remainingBid: number,
	reasonCodes: InventoryAdvisorReasonCode[],
): boolean {
	if (decision.action === 'keep' || decision.action === 'review') return true;
	const item = input.catalog.items[String(line.itemId)];
	const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
	const catalogCoverage = input.catalog.coverage.items[String(line.itemId)];
	if (!item || catalogCoverage?.status !== 'resolved' || !['network', 'cache_fresh'].includes(catalogCoverage.source)
		|| !fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs,
		input.policy.maxFutureSkewMs)) return false;
	const holdings = decision.allocations.map((allocation) => input.snapshot.holdings[allocationPositionIndex(allocation.positionRef)]);
	if (holdings.some((holding) => holding?.kind !== 'item')) return false;
	if (decision.action === 'discard_candidate') {
		return validDiscardAgainstInput(decision, line, input, reserved, exceptionQuantity);
	}
	if (decision.action === 'sell' || decision.action === 'list') {
		if (!price || input.prices.status !== 'complete'
			|| !fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
			|| input.accountSignals.tradingPostAccess === 'unknown'
			|| (input.accountSignals.tradingPostAccess === 'free_to_play' && !price.whitelisted)) return false;
		const side = decision.action === 'sell' ? price.bid : price.ask;
		if (side === null || !holdings.every((holding) => {
			const result = classifyItemLiquidity(holding, item, 'available');
			return result.status === 'ok' && result.classification.tradingPost.status === 'eligible';
		})) return false;
		const holding = holdings[0];
		if (!holding || holding.kind !== 'item') return false;
		const selection = selectInventoryMarketRoute({ holding, item, price,
			tradingPostAccess: input.accountSignals.tradingPostAccess, quantity: decision.quantity,
			allowSell: remainingBid >= decision.quantity, listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
		return selection.action === decision.action && reasonCodes.length === 1 && reasonCodes[0] === selection.reason;
	}
	if (decision.action === 'vendor') {
		if (!holdings.every((holding) => {
			const result = classifyItemLiquidity(holding, item, 'unavailable');
			return result.status === 'ok' && result.classification.vendor.status === 'eligible';
		})) return false;
		const holding = holdings[0];
		if (!holding || holding.kind !== 'item') return false;
		const selection = selectInventoryMarketRoute({ holding, item, price,
			tradingPostAccess: input.accountSignals.tradingPostAccess, quantity: decision.quantity,
			allowSell: remainingBid >= decision.quantity, listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
		return selection.action === 'vendor' && reasonCodes.length === 1 && reasonCodes[0] === selection.reason;
	}
	if (!fresh(input.rulePack.reviewedAt, input.asOf, input.policy.maxRulePackAgeMs,
		input.policy.maxFutureSkewMs) || Date.parse(input.asOf) > Date.parse(input.rulePack.validUntil) + input.policy.maxFutureSkewMs) return false;
	const matchingRules = input.rulePack.rules.filter((rule) => rule.ruleId === decision.ruleId
		&& rule.itemId === line.itemId && rule.action === decision.action
		&& rule.status === 'approved' && rule.assertion === 'applicable');
	if (matchingRules.length !== 1) return false;
	if (decision.action === 'salvage') return !item.flags.includes('NoSalvage');
	if (decision.action === 'use') {
		return fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs,
			input.policy.maxFutureSkewMs) && input.accountSignals.unlockCoverage === 'complete'
			&& input.accountSignals.achievementCoverage === 'complete';
	}
	return decision.action === 'open';
}

function allocationPositionIndex(ref: string): number {
	const value = Number(ref.slice(ref.lastIndexOf('/') + 1));
	return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function validDiscardAgainstInput(
	decision: InventoryRecommendationDecisionV1,
	line: InventoryAdvisorLineV1,
	input: InventoryAdvisorInputV1,
	reserved: number,
	exceptionQuantity: number,
): boolean {
	const item = input.catalog.items[String(line.itemId)];
	const coverage = input.catalog.coverage.items[String(line.itemId)];
	const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
	const proof = decision.discardProof;
	if (!item || !coverage || !proof || reserved !== 0 || exceptionQuantity !== 0
		|| input.prices.status !== 'complete' || !price || price.bid !== null || price.ask !== null
		|| input.accountSignals.tradingPostAccess === 'unknown'
		|| input.accountSignals.unlockCoverage !== 'complete'
		|| input.accountSignals.achievementCoverage !== 'complete'
		|| !item.flags.includes('NoSalvage') || item.flags.includes('DeleteWarning')
		|| (item.vendorValue > 0 && !item.flags.includes('NoSell'))
		|| coverage.status !== 'resolved' || !['network', 'cache_fresh'].includes(coverage.source)
		|| proof.catalogSource !== coverage.source || proof.rulePackSha256 !== input.rulePack.sha256
		|| input.rulePack.rules.some((rule) => rule.itemId === line.itemId && rule.status === 'approved'
			&& (rule.action === 'use' || rule.action === 'open'))) return false;
	return fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs,
			input.policy.maxFutureSkewMs)
		&& fresh(input.rulePack.reviewedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
		&& Date.parse(input.asOf) <= Date.parse(input.rulePack.validUntil) + input.policy.maxFutureSkewMs;
}

function fresh(evidenceAt: string, asOf: string, maxAgeMs: number, maxFutureSkewMs: number): boolean {
	const evidence = Date.parse(evidenceAt);
	const now = Date.parse(asOf);
	return evidence <= now + maxFutureSkewMs && now - evidence <= maxAgeMs;
}

function snapshotComplete(snapshot: InventoryAdvisorInputV1['snapshot']): boolean {
	return snapshot.quality === 'stable' && Object.values(snapshot.coverage.sources)
		.every((coverage) => coverage.status === 'complete');
}

function sameRulePack(
	left: { id: string; version: number; sha256: string },
	right: InventoryRecommendationEnvelopeV1['rulePack'],
): boolean {
	return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value) as unknown;
		return prototype === Object.prototype || prototype === null;
	} catch { return false; }
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (record(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}
