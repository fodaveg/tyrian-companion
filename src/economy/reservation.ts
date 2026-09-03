import {
	isComparableStorageSnapshot,
	isInventoryAdvisorStorageSnapshot,
} from '../account/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { isStorageDelta } from '../account/contamination';
import { isSessionValuation, isSessionValuationRecord } from './session-valuation';
import {
	RESERVATION_SCHEMA_VERSION,
	type IntendedUse,
	type ReservationAllocation,
	type ReservationAllowances,
	type ReservationAssetBalance,
	type ReservationBalance,
	type ReservationGoal,
	type ReservationPlan,
	type ReservationPlanAsset,
	type ReservationRequirement,
	type ReservationWarning,
	type SessionValuationReservationOverlay,
} from './reservation-model';
import { canonicalStructuralJson as canonical } from '../core/canonical-sha256';

export type ReservationPlanResult = { status: 'ok'; plan: ReservationPlan } | { status: 'invalid'; reason: string };
export type ReservationBalanceResult = { status: 'ok'; balance: ReservationBalance } | { status: 'invalid'; reason: string };
export type ReservationOverlayResult = { status: 'ok'; overlay: SessionValuationReservationOverlay } | { status: 'invalid'; reason: string };

export function createReservationPlan(input: unknown): ReservationPlanResult {
	if (!isRecord(input) || !exactKeys(input, ['goals', 'balance']) ||
		!Array.isArray(input.goals) || !input.goals.every(isReservationGoal) ||
		!isReservationBalance(input.balance)) return { status: 'invalid', reason: 'invalid_input' };
	const goals = input.goals;
	if (!unique(goals.map((goal) => goal.goalId)) || !unique(goals.map((goal) => goal.title))) {
		return { status: 'invalid', reason: 'duplicate_goal' };
	}
	const balance = input.balance;
	const balanceByKey = new Map(balance.assets.map((asset) => [asset.key, asset]));
	const active = goals.filter((goal) => goal.status === 'active')
		.flatMap((goal) => goal.requirements.map((requirement) => ({ goal, requirement })))
		.filter(({ requirement }) => requirement.creditedQuantity < requirement.targetQuantity)
		.sort((left, right) => right.goal.priority - left.goal.priority ||
			compareText(left.goal.goalId, right.goal.goalId) ||
			compareText(left.requirement.key, right.requirement.key));
	const keys = [...new Set([...balanceByKey.keys(), ...active.map(({ requirement }) => requirement.key)])]
		.sort(compareText);
	const assets: ReservationPlanAsset[] = [];
	const warnings: ReservationWarning[] = [];
	try {
		for (const key of keys) {
			const requirements = active.filter((entry) => entry.requirement.key === key);
			const template = requirements[0]?.requirement;
			const balanceAsset = balanceByKey.get(key) ?? {
				key, namespace: template!.namespace, id: template!.id,
				ownedQuantity: 0, availableQuantity: 0,
				coverage: balance.coverage[template!.namespace],
			};
			let nonAvailable = safeSubtract(balanceAsset.ownedQuantity, balanceAsset.availableQuantity);
			let available = balanceAsset.availableQuantity;
			let requested = 0;
			let protectedAvailable = 0;
			let shortfall = 0;
			const allocations: ReservationAllocation[] = [];
			for (const { goal, requirement } of requirements) {
				const required = safeSubtract(requirement.targetQuantity, requirement.creditedQuantity);
				requested = safeAdd(requested, required);
				let fromUnavailable = 0;
				if (requirement.basis === 'owned') {
					fromUnavailable = Math.min(required, nonAvailable);
					nonAvailable = safeSubtract(nonAvailable, fromUnavailable);
				}
				const fromAvailable = Math.min(safeSubtract(required, fromUnavailable), available);
				available = safeSubtract(available, fromAvailable);
				const satisfied = safeAdd(fromUnavailable, fromAvailable);
				const missing = safeSubtract(required, satisfied);
				protectedAvailable = safeAdd(protectedAvailable, fromAvailable);
				shortfall = safeAdd(shortfall, missing);
				allocations.push({
					goalId: goal.goalId, priority: goal.priority, reason: goal.reason, required, satisfied,
					protectedAvailable: fromAvailable, shortfall: missing,
					basis: requirement.basis, intendedUse: requirement.intendedUse,
				});
			}
			const asset: ReservationPlanAsset = {
				...balanceAsset, requested, protectedAvailable,
				unprotectedAvailable: available, shortfall, allocations,
				allowances: allowances(balanceAsset, available, allocations),
			};
			assets.push(asset);
			if (balanceAsset.coverage === 'limited') warnings.push({ code: 'limited_balance', key });
			if (balanceAsset.coverage === 'unknown') warnings.push({ code: 'unknown_balance', key });
			if (shortfall > 0) warnings.push({ code: 'insufficient_quantity', key });
			if (new Set(requirements.map(({ goal }) => goal.goalId)).size > 1) {
				warnings.push({ code: 'multiple_goals_same_asset', key });
			}
		}
	} catch {
		return { status: 'invalid', reason: 'arithmetic_overflow' };
	}
	const plan: ReservationPlan = {
		schemaVersion: RESERVATION_SCHEMA_VERSION,
		accountId: balance.accountId,
		snapshotId: balance.snapshotId,
		capturedAt: balance.capturedAt,
		coverage: assets.some((asset) => asset.coverage === 'unknown') ? 'blocked'
			: assets.some((asset) => asset.coverage === 'limited') ? 'limited' : 'complete',
		satisfaction: assets.some((asset) => asset.shortfall > 0) ? 'shortfall' : 'met',
		assets,
		warnings: warnings.sort(compareCanonical),
	};
	return isReservationPlan(plan) ? { status: 'ok', plan } : { status: 'invalid', reason: 'invalid_plan' };
}

export function buildReservationBalance(snapshot: unknown): ReservationBalanceResult {
	if (!isComparableStorageSnapshot(snapshot)) return { status: 'invalid', reason: 'invalid_snapshot' };
	return buildValidatedReservationBalance(snapshot,
		snapshot.coverage.sources.commerce_delivery.status === 'complete' ? 'complete' : 'limited');
}

/** Builds balances from the narrower Inventory Advisor capture contract. */
export function buildInventoryAdvisorReservationBalance(snapshot: unknown): ReservationBalanceResult {
	if (!isInventoryAdvisorStorageSnapshot(snapshot)) return { status: 'invalid', reason: 'invalid_snapshot' };
	return buildValidatedReservationBalance(snapshot, 'complete');
}

function buildValidatedReservationBalance(snapshot: StorageSnapshot, itemCoverage: 'complete' | 'limited'): ReservationBalanceResult {
	const walletComplete = snapshot.coverage.sources.wallet.status === 'complete';
	const currencyCoverage = !walletComplete ? 'unknown'
		: snapshot.coverage.sources.commerce_delivery.status === 'complete' ? 'complete' : 'limited';
	const assets: ReservationAssetBalance[] = [];
	for (const [key, ownedQuantity] of Object.entries(snapshot.ownedByItem)) {
		assets.push({ key: `item:${key}`, namespace: 'item', id: Number(key), ownedQuantity,
			availableQuantity: snapshot.availableByItem[key] ?? 0, coverage: itemCoverage });
	}
	for (const [key, total] of Object.entries(snapshot.currencyById)) {
		assets.push({ key: `currency:${key}`, namespace: 'currency', id: Number(key),
			ownedQuantity: total.total, availableQuantity: total.total, coverage: currencyCoverage });
	}
	assets.sort((left, right) => compareText(left.key, right.key));
	const balance = { accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		capturedAt: snapshot.completedAt,
		coverage: { item: itemCoverage, currency: currencyCoverage }, assets };
	return isReservationBalance(balance) ? { status: 'ok', balance } : { status: 'invalid', reason: 'invalid_snapshot' };
}

export function partitionSessionValuation(input: unknown): ReservationOverlayResult {
	if (!isRecord(input) || !exactKeys(input, ['valuation', 'delta', 'plan', 'sackItemIds']) ||
		!isStorageDelta(input.delta) || !isReservationPlan(input.plan) || !Array.isArray(input.sackItemIds) ||
		!isSessionValuation(input.valuation, input.delta, input.sackItemIds)) {
		return { status: 'invalid', reason: 'invalid_input' };
	}
	const valuation = input.valuation;
	const delta = input.delta;
	const plan = input.plan;
	const sackItemIds = input.sackItemIds as number[];
	if (plan.accountId !== delta.accountId || plan.snapshotId !== delta.afterSnapshotId) {
		return { status: 'invalid', reason: 'identity_mismatch' };
	}
	const coinNet = delta.currencyChanges.find((change) => change.id === 1)?.delta ?? 0;
	const hasItemLoss = delta.itemChanges.some((change) => change.delta < 0);
	if (valuation.totals.coinNetCopper !== coinNet ||
		valuation.warnings.includes('item_losses_not_valued') !== hasItemLoss) {
		return { status: 'invalid', reason: 'valuation_mismatch' };
	}
	const positive = new Map(delta.itemChanges.filter((change) => change.delta > 0).map((change) => [change.id, change.delta]));
	if (valuation.lines.length !== positive.size ||
		valuation.lines.some((line) => positive.get(line.itemId) !== line.quantity) ||
		!unique(valuation.lines.map((line) => line.itemId))) return { status: 'invalid', reason: 'valuation_mismatch' };
	const planByKey = new Map(plan.assets.map((asset) => [asset.key, asset]));
	const lines = valuation.lines.map((line) => {
		const asset = planByKey.get(`item:${line.itemId}`);
		const allowance = asset?.allowances;
		const liquidationEligible = allowance ? eligible(line.quantity, allowance.liquidate) : null;
		return {
			itemId: line.itemId, gainedQuantity: line.quantity,
			protectedFromLiquidation: liquidationEligible === null ? null : line.quantity - liquidationEligible,
			liquidationEligible,
			openEligible: allowance ? eligible(line.quantity, allowance.open) : null,
			consumeEligible: allowance ? eligible(line.quantity, allowance.consume) : null,
			exchangeEligible: allowance ? eligible(line.quantity, allowance.exchange) : null,
		};
	});
	const overlay: SessionValuationReservationOverlay = {
		schemaVersion: RESERVATION_SCHEMA_VERSION, accountId: plan.accountId,
		snapshotId: plan.snapshotId, sackItemIds: [...sackItemIds], valuation, lines,
	};
	return isSessionValuationReservationOverlay(overlay)
		? { status: 'ok', overlay }
		: { status: 'invalid', reason: 'invalid_overlay' };
}

export function isReservationGoal(value: unknown): value is ReservationGoal {
	if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'goalId', 'title', 'status', 'priority', 'reason', 'requirements']) ||
		value.schemaVersion !== 1 || !trimmed(value.goalId, 128) || !trimmed(value.title, 256) ||
		!['active', 'paused', 'completed'].includes(String(value.status)) || !safeNonNegative(value.priority) ||
		(value.priority) > 1_000 || !['achievement', 'purchase', 'personal'].includes(String(value.reason)) ||
		!Array.isArray(value.requirements) || !value.requirements.every(isRequirement)) return false;
	return unique(value.requirements.map((requirement) => requirement.key));
}

export function isReservationBalance(value: unknown): value is ReservationBalance {
	if (!(isRecord(value) && exactKeys(value, ['accountId', 'snapshotId', 'capturedAt', 'coverage', 'assets']) &&
		trimmed(value.accountId, 256) && trimmed(value.snapshotId, 256) && validIso(value.capturedAt) &&
		isNamespaceCoverage(value.coverage) && Array.isArray(value.assets) && value.assets.every(isBalanceAsset))) return false;
	const balance = value as unknown as ReservationBalance;
	return sortedAssets(balance.assets) &&
		balance.assets.every((asset) => asset.coverage === balance.coverage[asset.namespace]);
}

export function isReservationPlan(value: unknown): value is ReservationPlan {
	if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'accountId', 'snapshotId', 'capturedAt', 'coverage', 'satisfaction', 'assets', 'warnings']) ||
		value.schemaVersion !== 1 || !trimmed(value.accountId, 256) || !trimmed(value.snapshotId, 256) || !validIso(value.capturedAt) ||
		!['complete', 'limited', 'blocked'].includes(String(value.coverage)) || !['met', 'shortfall'].includes(String(value.satisfaction)) ||
		!Array.isArray(value.assets) || !value.assets.every(isPlanAsset) || !Array.isArray(value.warnings) ||
		!value.warnings.every(isWarning)) return false;
	if (!sortedAssets(value.assets) || canonical(value.warnings) !== canonical([...value.warnings].sort(compareCanonical)) ||
		!unique(value.warnings.map((warning) => `${warning.code}:${warning.key}`))) return false;
	const expectedCoverage = value.assets.some((asset) => asset.coverage === 'unknown') ? 'blocked'
		: value.assets.some((asset) => asset.coverage === 'limited') ? 'limited' : 'complete';
	const expectedSatisfaction = value.assets.some((asset) => asset.shortfall > 0) ? 'shortfall' : 'met';
	return value.coverage === expectedCoverage && value.satisfaction === expectedSatisfaction &&
		canonical(value.warnings) === canonical(expectedWarnings(value.assets));
}

/** Validates the overlay's own H4.5 and quantity invariants; intended-use provenance requires its plan. */
export function isSessionValuationReservationOverlay(
	value: unknown,
): value is SessionValuationReservationOverlay {
	if (!(isRecord(value) && exactKeys(value, ['schemaVersion', 'accountId', 'snapshotId', 'sackItemIds', 'valuation', 'lines']) &&
		value.schemaVersion === 1 && trimmed(value.accountId, 256) && trimmed(value.snapshotId, 256) &&
		isSessionValuationRecord(value.valuation, value.sackItemIds) && Array.isArray(value.lines) &&
		value.lines.every(isOverlayLine))) return false;
	const lines = value.lines;
	const valuation = value.valuation;
	return lines.every((line, index) => index === 0 || lines[index - 1]!.itemId < line.itemId) &&
		lines.length === valuation.lines.length && lines.every((line, index) =>
			line.itemId === valuation.lines[index]!.itemId && line.gainedQuantity === valuation.lines[index]!.quantity,
		);
}

function allowances(balance: ReservationAssetBalance, unprotected: number, allocations: ReservationAllocation[]): ReservationAllowances {
	if (balance.coverage === 'unknown') return { liquidate: null, open: null, consume: null, exchange: null, spend: null };
	const protectedFor = (use: IntendedUse) => allocations.filter((allocation) => allocation.intendedUse === use)
		.reduce((total, allocation) => safeAdd(total, allocation.protectedAvailable), 0);
	if (balance.namespace === 'currency') return {
		liquidate: null, open: null, consume: null, exchange: null,
		spend: safeAdd(unprotected, protectedFor('spend')),
	};
	return {
		liquidate: unprotected,
		open: safeAdd(unprotected, protectedFor('open')),
		consume: safeAdd(unprotected, protectedFor('consume')),
		exchange: safeAdd(unprotected, protectedFor('exchange')),
		spend: null,
	};
}

function isRequirement(value: unknown): value is ReservationRequirement {
	return isRecord(value) && exactKeys(value, ['key', 'namespace', 'id', 'targetQuantity', 'creditedQuantity', 'basis', 'intendedUse']) &&
		(value.namespace === 'item' || value.namespace === 'currency') && positive(value.id) &&
		value.key === `${value.namespace}:${String(value.id)}` && positive(value.targetQuantity) &&
		safeNonNegative(value.creditedQuantity) && (value.creditedQuantity) <= (value.targetQuantity) &&
		(value.basis === 'owned' || value.basis === 'available') && compatibleUse(value.namespace, value.intendedUse);
}

function isBalanceAsset(value: unknown): value is ReservationAssetBalance {
	return isRecord(value) && exactKeys(value, ['key', 'namespace', 'id', 'ownedQuantity', 'availableQuantity', 'coverage']) &&
		(value.namespace === 'item' || value.namespace === 'currency') && positive(value.id) &&
		value.key === `${value.namespace}:${String(value.id)}` && safeNonNegative(value.ownedQuantity) &&
		safeNonNegative(value.availableQuantity) && (value.availableQuantity) <= (value.ownedQuantity) &&
		['complete', 'limited', 'unknown'].includes(String(value.coverage));
}

function isPlanAsset(value: unknown): value is ReservationPlanAsset {
	if (!isRecord(value) || !exactKeys(value, ['key', 'namespace', 'id', 'ownedQuantity', 'availableQuantity', 'coverage', 'requested', 'protectedAvailable', 'unprotectedAvailable', 'shortfall', 'allocations', 'allowances']) ||
		!isBalanceAsset(pickBalance(value)) || !safeNonNegative(value.requested) || !safeNonNegative(value.protectedAvailable) ||
		!safeNonNegative(value.unprotectedAvailable) || !safeNonNegative(value.shortfall) ||
		!Array.isArray(value.allocations) || !value.allocations.every(isAllocation) || !isAllowances(value.allowances)) return false;
	const asset = value as unknown as ReservationPlanAsset;
	try {
		if (safeAdd(asset.protectedAvailable, asset.unprotectedAvailable) !== asset.availableQuantity) return false;
		let nonAvailablePool = safeSubtract(asset.ownedQuantity, asset.availableQuantity);
		let availablePool = asset.availableQuantity;
		for (const allocation of asset.allocations) {
			const expectedNonAvailable = allocation.basis === 'owned'
				? Math.min(allocation.required, nonAvailablePool) : 0;
			const expectedProtected = Math.min(
				safeSubtract(allocation.required, expectedNonAvailable), availablePool,
			);
			const expectedSatisfied = safeAdd(expectedNonAvailable, expectedProtected);
			if (allocation.protectedAvailable !== expectedProtected ||
				allocation.satisfied !== expectedSatisfied ||
				allocation.shortfall !== safeSubtract(allocation.required, expectedSatisfied)) return false;
			nonAvailablePool = safeSubtract(nonAvailablePool, expectedNonAvailable);
			availablePool = safeSubtract(availablePool, expectedProtected);
		}
		if (availablePool !== asset.unprotectedAvailable) return false;
		const requested = asset.allocations.reduce((sum, allocation) => safeAdd(sum, allocation.required), 0);
		const satisfied = asset.allocations.reduce((sum, allocation) => safeAdd(sum, allocation.satisfied), 0);
		const protectedAvailable = asset.allocations.reduce((sum, allocation) => safeAdd(sum, allocation.protectedAvailable), 0);
		const shortfall = asset.allocations.reduce((sum, allocation) => safeAdd(sum, allocation.shortfall), 0);
		return requested === asset.requested && satisfied <= asset.ownedQuantity &&
			protectedAvailable === asset.protectedAvailable && shortfall === asset.shortfall &&
			unique(asset.allocations.map((allocation) => allocation.goalId)) &&
			asset.allocations.every((allocation, index) => compatibleUse(asset.namespace, allocation.intendedUse) &&
				(index === 0 || compareAllocations(asset.allocations[index - 1]!, allocation) < 0)) &&
			canonical(asset.allowances) === canonical(allowances(asset, asset.unprotectedAvailable, asset.allocations));
	} catch { return false; }
}

function isAllocation(value: unknown): value is ReservationAllocation {
	if (!(isRecord(value) && exactKeys(value, ['goalId', 'priority', 'reason', 'required', 'satisfied', 'protectedAvailable', 'shortfall', 'basis', 'intendedUse']) &&
		trimmed(value.goalId, 128) && safeNonNegative(value.priority) && (value.priority) <= 1_000 &&
		['achievement', 'purchase', 'personal'].includes(String(value.reason)) &&
		positive(value.required) && safeNonNegative(value.satisfied) && safeNonNegative(value.protectedAvailable) &&
		safeNonNegative(value.shortfall) && (value.protectedAvailable) <= (value.satisfied) &&
		(value.basis === 'owned' || value.basis === 'available') &&
		['hold', 'open', 'consume', 'exchange', 'spend'].includes(String(value.intendedUse)))) return false;
	return sumsTo(value.satisfied, value.shortfall, value.required) &&
		(value.basis !== 'available' || value.protectedAvailable === value.satisfied);
}

function isAllowances(value: unknown): value is ReservationAllowances {
	return isRecord(value) && exactKeys(value, ['liquidate', 'open', 'consume', 'exchange', 'spend']) &&
		Object.values(value).every((amount) => amount === null || safeNonNegative(amount));
}

function isWarning(value: unknown): value is ReservationWarning {
	return isRecord(value) && exactKeys(value, ['code', 'key']) &&
		['limited_balance', 'unknown_balance', 'insufficient_quantity', 'multiple_goals_same_asset'].includes(String(value.code)) &&
		typeof value.key === 'string';
}

function isOverlayLine(value: unknown): value is SessionValuationReservationOverlay['lines'][number] {
	if (!isRecord(value) || !exactKeys(value, ['itemId', 'gainedQuantity', 'protectedFromLiquidation', 'liquidationEligible', 'openEligible', 'consumeEligible', 'exchangeEligible']) ||
		!positive(value.itemId) || !positive(value.gainedQuantity)) return false;
	const quantities = [value.protectedFromLiquidation, value.liquidationEligible, value.openEligible, value.consumeEligible, value.exchangeEligible];
	if (!quantities.every((quantity) => quantity === null || safeNonNegative(quantity))) return false;
	if (value.protectedFromLiquidation === null || value.liquidationEligible === null) {
		return quantities.every((quantity) => quantity === null);
	}
	const protectedQuantity = value.protectedFromLiquidation;
	const liquidationEligible = value.liquidationEligible;
	const gainedQuantity = value.gainedQuantity;
	return typeof protectedQuantity === 'number' && typeof liquidationEligible === 'number' &&
		sumsTo(protectedQuantity, liquidationEligible, gainedQuantity) &&
		quantities.slice(1).every((quantity) => typeof quantity === 'number' &&
			quantity >= liquidationEligible && quantity <= gainedQuantity);
}

function eligible(quantity: number, allowance: number | null): number | null {
	return allowance === null ? null : Math.min(quantity, allowance);
}

function pickBalance(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(['key', 'namespace', 'id', 'ownedQuantity', 'availableQuantity', 'coverage'].map((key) => [key, value[key]]));
}

function compatibleUse(namespace: unknown, use: unknown): boolean {
	return namespace === 'currency' ? use === 'hold' || use === 'spend'
		: use === 'hold' || use === 'open' || use === 'consume' || use === 'exchange';
}

function compareAllocations(left: ReservationAllocation, right: ReservationAllocation): number {
	return right.priority - left.priority || compareText(left.goalId, right.goalId);
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right) || (left < right ? -1 : left > right ? 1 : 0);
}

function expectedWarnings(assets: ReservationPlanAsset[]): ReservationWarning[] {
	const warnings: ReservationWarning[] = [];
	for (const asset of assets) {
		if (asset.coverage === 'limited') warnings.push({ code: 'limited_balance', key: asset.key });
		if (asset.coverage === 'unknown') warnings.push({ code: 'unknown_balance', key: asset.key });
		if (asset.shortfall > 0) warnings.push({ code: 'insufficient_quantity', key: asset.key });
		if (new Set(asset.allocations.map((allocation) => allocation.goalId)).size > 1) {
			warnings.push({ code: 'multiple_goals_same_asset', key: asset.key });
		}
	}
	return warnings.sort(compareCanonical);
}

function isNamespaceCoverage(value: unknown): value is ReservationBalance['coverage'] {
	return isRecord(value) && exactKeys(value, ['item', 'currency']) &&
		['complete', 'limited', 'unknown'].includes(String(value.item)) &&
		['complete', 'limited', 'unknown'].includes(String(value.currency));
}

function sumsTo(left: number, right: number, expected: number): boolean {
	const total = left + right;
	return Number.isSafeInteger(total) && total === expected;
}

function validIso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function trimmed(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function safeNonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function safeAdd(left: number, right: number): number { const value = left + right; if (!Number.isSafeInteger(value)) throw new Error('overflow'); return value; }
function safeSubtract(left: number, right: number): number { const value = left - right; if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid subtraction'); return value; }
function sortedAssets(values: ReservationAssetBalance[] | ReservationPlanAsset[]): boolean { return values.every((asset, index) => index === 0 || compareText(values[index - 1]!.key, asset.key) < 0); }
function unique<T>(values: T[]): boolean { return new Set(values).size === values.length; }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return canonical(Object.keys(value).sort()) === canonical([...keys].sort()); }
function compareCanonical(left: unknown, right: unknown): number { return canonical(left).localeCompare(canonical(right)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
