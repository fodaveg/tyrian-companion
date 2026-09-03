import type {
	InventoryRecommendationDecisionV1,
} from '../advisor/inventory-advisor-model';
import { canonicalJson as canonical } from '../core/canonical-sha256';
import {
	isInventoryAdvisorReport,
	sha256InventoryAdvisorReport,
} from '../advisor/inventory-advisor-contract';
import { materialStorageDepositsFit } from './material-storage-deposit-validation';
import { EQUIPMENT_SALVAGE_POLICY_V1 } from './models/equipment-salvage-policy';
import { EQUIPMENT_SALVAGE_POLICY_V1_SHA256 } from './equipment-salvage-economy';

export const INVENTORY_RECOMMENDATION_ENVELOPE_VERSION = 1 as const;

export interface InventoryRecommendationEnvelopeV1 {
	version: typeof INVENTORY_RECOMMENDATION_ENVELOPE_VERSION;
	kind: 'inventory_recommendation';
	execution: 'manual_in_game';
	sideEffects: 'none';
	requiresUserAction: true;
	accountId: string;
	snapshotId: string;
	reportSha256: string;
	rulePack: { id: string; version: number; sha256: string };
	decisions: InventoryRecommendationDecisionV1[];
}

export function createInventoryRecommendationEnvelope(
	report: unknown,
): InventoryRecommendationEnvelopeV1 | null {
	try { return createInventoryRecommendationEnvelopeUnsafe(report); } catch { return null; }
}

function createInventoryRecommendationEnvelopeUnsafe(
	report: unknown,
): InventoryRecommendationEnvelopeV1 | null {
	if (!isInventoryAdvisorReport(report)) return null;
	const decisions = report.lines.flatMap((line) => line.decisions);
	const envelope: InventoryRecommendationEnvelopeV1 = {
		version: INVENTORY_RECOMMENDATION_ENVELOPE_VERSION,
		kind: 'inventory_recommendation',
		execution: 'manual_in_game',
		sideEffects: 'none',
		requiresUserAction: true,
		accountId: report.accountId,
		snapshotId: report.snapshotId,
		reportSha256: sha256InventoryAdvisorReport(report),
		rulePack: { id: report.rulePack.id, version: report.rulePack.version, sha256: report.rulePack.sha256 },
		decisions: clone(decisions),
	};
	return isInventoryRecommendationEnvelope(envelope) ? envelope : null;
}

export function isInventoryRecommendationEnvelope(
	value: unknown,
): value is InventoryRecommendationEnvelopeV1 {
	try { return isInventoryRecommendationEnvelopeUnsafe(value); } catch { return false; }
}

function isInventoryRecommendationEnvelopeUnsafe(
	value: unknown,
): value is InventoryRecommendationEnvelopeV1 {
	if (!record(value) || !keys(value, [
		'version', 'kind', 'execution', 'sideEffects', 'requiresUserAction',
		'accountId', 'snapshotId', 'reportSha256', 'rulePack', 'decisions',
	])) return false;
	return value.version === INVENTORY_RECOMMENDATION_ENVELOPE_VERSION
		&& value.kind === 'inventory_recommendation'
		&& value.execution === 'manual_in_game'
		&& value.sideEffects === 'none'
		&& value.requiresUserAction === true
		&& text(value.accountId)
		&& text(value.snapshotId)
		&& sha(value.reportSha256)
		&& isRulePackRef(value.rulePack)
		&& Array.isArray(value.decisions)
		&& value.decisions.every(isDecision)
		&& value.decisions.every((decision) => decision.ruleId !== EQUIPMENT_SALVAGE_POLICY_V1.rules[0].ruleId
			|| equipmentSalvageProofMatchesDecision(decision, value.snapshotId as string))
		&& materialStorageDepositsFit(value.decisions)
		&& unique(value.decisions.map((decision) => decision.explanationRef))
		&& jsonRoundTrip(value);
}

function isDecision(value: unknown): value is InventoryRecommendationDecisionV1 {
	if (!record(value) || !optionalKeys(value, [
		'action', 'itemId', 'quantity', 'allocations', 'explanationRef', 'ruleId', 'safety', 'discardProof',
	], ['materialStorage', 'salvageProof'])) return false;
	if (!['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'deposit_material', 'keep', 'review', 'discard_candidate']
		.includes(String(value.action)) || !positive(value.itemId) || !positive(value.quantity)
		|| !Array.isArray(value.allocations) || value.allocations.length === 0
		|| !value.allocations.every(isAllocation)
		|| !sortedUnique(value.allocations.map((allocation) => allocation.positionRef))
		|| safeSum(value.allocations.map((allocation) => allocation.quantity)) !== value.quantity
		|| !internalRef(value.explanationRef)
		|| (value.ruleId !== null && !identifier(value.ruleId))) return false;
	const curated = ['salvage', 'use', 'open', 'discard_candidate'].includes(String(value.action));
	if (curated !== (value.ruleId !== null)) return false;
	if (value.action === 'deposit_material' ? !isMaterialStorageContext(value.materialStorage)
		: value.materialStorage !== undefined) return false;
	if (value.salvageProof !== undefined && (value.action !== 'salvage'
		|| !isEquipmentSalvageProof(value.salvageProof))) return false;
	if (value.action === 'discard_candidate') {
		return value.safety === 'irreversible_review_only' && isDiscardProof(value.discardProof);
	}
	return value.safety === 'manual_only' && value.discardProof === null;
}

function isEquipmentSalvageProof(value: unknown): boolean {
	if (!record(value) || !keys(value, ['item', 'catalog', 'policy', 'rule'])
		|| !record(value.item) || !keys(value.item, ['itemId', 'rarity', 'level'])
		|| !positive(value.item.itemId) || value.item.rarity !== 'Rare'
		|| !nonNegative(value.item.level) || value.item.level < 68
		|| !record(value.catalog) || !keys(value.catalog, ['snapshotId', 'itemRef'])
		|| !text(value.catalog.snapshotId) || !internalRef(value.catalog.itemRef)
		|| !record(value.policy) || !keys(value.policy, ['id', 'version', 'sha256'])
		|| value.policy.id !== EQUIPMENT_SALVAGE_POLICY_V1.id || value.policy.version !== 1
		|| value.policy.sha256 !== EQUIPMENT_SALVAGE_POLICY_V1_SHA256
		|| !record(value.rule) || !keys(value.rule, ['ruleId', 'minimumLevel', 'expectedOutputMillionths'])) return false;
	const rareRule = EQUIPMENT_SALVAGE_POLICY_V1.rules[0];
	return value.rule.ruleId === rareRule.ruleId && value.rule.minimumLevel === rareRule.minimumLevel
		&& value.rule.expectedOutputMillionths === rareRule.expectedOutputMillionths;
}

function equipmentSalvageProofMatchesDecision(
	decision: InventoryRecommendationDecisionV1,
	snapshotId: string,
): boolean {
	const proof = decision.salvageProof;
	return isEquipmentSalvageProof(proof) && proof!.item.itemId === decision.itemId
		&& proof!.catalog.snapshotId === snapshotId
		&& proof!.catalog.itemRef === `#/items/${decision.itemId}`;
}

function isMaterialStorageContext(value: unknown): boolean {
	return record(value) && keys(value, ['capacity', 'capacitySource', 'storedQuantity', 'spaceBefore'])
		&& Number.isSafeInteger(value.capacity) && (value.capacity as number) >= 250
		&& (value.capacity as number) <= 3000 && (value.capacity as number) % 250 === 0
		&& (value.capacitySource === 'configured' || value.capacitySource === 'minimum_guaranteed')
		&& (value.capacitySource !== 'minimum_guaranteed' || value.capacity === 250)
		&& nonNegative(value.storedQuantity) && nonNegative(value.spaceBefore)
		&& value.spaceBefore === Math.max(0, (value.capacity as number) - value.storedQuantity);
}

function isAllocation(value: unknown): value is InventoryRecommendationDecisionV1['allocations'][number] {
	return record(value) && keys(value, ['positionRef', 'quantity'])
		&& internalRef(value.positionRef) && positive(value.quantity);
}

function isDiscardProof(value: unknown): boolean {
	return record(value) && keys(value, [
		'rulePackSha256', 'catalogSource', 'tradingPost', 'vendor', 'salvage', 'use', 'open',
		'unlocks', 'collections', 'deleteWarning',
	]) && sha(value.rulePackSha256) && ['network', 'cache_fresh'].includes(String(value.catalogSource))
		&& value.tradingPost === 'unavailable' && value.vendor === 'unavailable'
		&& value.salvage === 'no_salvage' && value.use === 'not_applicable'
		&& value.open === 'not_applicable' && value.unlocks === 'complete'
		&& value.collections === 'complete' && value.deleteWarning === false;
}

function isRulePackRef(value: unknown): value is InventoryRecommendationEnvelopeV1['rulePack'] {
	return record(value) && keys(value, ['id', 'version', 'sha256'])
		&& identifier(value.id) && positive(value.version) && sha(value.sha256);
}

function internalRef(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 256 && /^#(?:\/[A-Za-z0-9._~-]+)+$/u.test(value);
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function sha(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function text(value: unknown): value is string {
	return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256;
}

function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sortedUnique(values: string[]): boolean {
	return unique(values) && values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function safeSum(values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (!positive(value) || total > Number.MAX_SAFE_INTEGER - value) return Number.NaN;
		total += value;
	}
	return total;
}

function unique(values: string[]): boolean {
	return new Set(values).size === values.length;
}

function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function optionalKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
	const actual = Object.keys(value);
	return required.every((key) => actual.includes(key))
		&& actual.every((key) => required.includes(key) || optional.includes(key));
}

function jsonRoundTrip(value: unknown): boolean {
	try { return canonical(JSON.parse(JSON.stringify(value))) === canonical(value); } catch { return false; }
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

