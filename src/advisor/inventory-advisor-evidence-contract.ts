import { isComparableStorageSnapshot } from '../account/storage-delta';
import {
	isAccountSignals,
	isCatalogResolution,
	isInventoryAdvisorInput,
	isInventoryPriceSnapshot,
	sha256CanonicalValue,
} from './inventory-advisor-contract';
import type {
	InventoryAdvisorInputV1,
	InventoryAdvisorPolicyV1,
	InventoryAdvisorRulePackV1,
	KeepExceptionV1,
} from './inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';
import {
	INVENTORY_ADVISOR_EVIDENCE_VERSION,
	type InventoryAdvisorEvidenceV1,
} from './inventory-advisor-evidence-model';

/** Strictly validates the H4.14 wrapper before it is composed into the H4.13 input contract. */
export function isInventoryAdvisorEvidence(value: unknown): value is InventoryAdvisorEvidenceV1 {
	try {
		if (!record(value) || !exactKeys(value, [
			'version', 'scope', 'accountId', 'snapshotId', 'schemaVersion', 'capturedAt', 'finishedAt', 'locale',
			'snapshot', 'snapshotFingerprint', 'ttl', 'coverage', 'catalog', 'prices', 'accountSignals',
		]) || value.version !== INVENTORY_ADVISOR_EVIDENCE_VERSION || value.scope !== 'supported_storage_v1'
			|| !text(value.accountId) || !text(value.snapshotId) || !text(value.schemaVersion) || !iso(value.capturedAt) || !iso(value.finishedAt)
			|| (value.locale !== 'es' && value.locale !== 'en') || !ttl(value.ttl) || !coverage(value.coverage)
			|| !isComparableStorageSnapshot(value.snapshot) || !isCatalogResolution(value.catalog) || !isInventoryPriceSnapshot(value.prices) || !isAccountSignals(value.accountSignals)) return false;
		return value.catalog.snapshotId === value.snapshotId && value.catalog.schemaVersion === value.schemaVersion && value.catalog.locale === value.locale
			&& value.snapshot.accountId === value.accountId && value.snapshot.snapshotId === value.snapshotId && value.snapshot.schemaVersion === value.schemaVersion && sha(value.snapshotFingerprint) && value.snapshotFingerprint === sha256CanonicalValue(value.snapshot)
			&& value.prices.accountId === value.accountId && value.prices.snapshotId === value.snapshotId
			&& value.prices.schemaVersion === value.schemaVersion && value.accountSignals.accountId === value.accountId
			&& timestamps(value as unknown as InventoryAdvisorEvidenceV1)
			&& exactCoverage(value as unknown as InventoryAdvisorEvidenceV1)
			&& JSON.parse(JSON.stringify(value)) !== undefined;
	} catch { return false; }
}

/** Composes capture evidence into the already strict H4.13 input; no classification occurs here. */
export function createInventoryAdvisorInputFromEvidence(value: {
	asOf: string;
	evidence: InventoryAdvisorEvidenceV1;
	goals: ReservationGoal[];
	keepExceptions: KeepExceptionV1[];
	rulePack: InventoryAdvisorRulePackV1;
	policy: InventoryAdvisorPolicyV1;
}): InventoryAdvisorInputV1 | null {
	try {
		if (!isInventoryAdvisorEvidence(value.evidence) || !evidenceFreshForPolicy(value.evidence, value.asOf, value.policy)) return null;
		const input: InventoryAdvisorInputV1 = {
			version: 1, asOf: value.asOf, snapshot: value.evidence.snapshot, catalog: value.evidence.catalog,
			prices: value.evidence.prices, goals: value.goals, keepExceptions: value.keepExceptions,
			accountSignals: value.evidence.accountSignals, rulePack: value.rulePack, policy: value.policy,
		};
		return isInventoryAdvisorInput(input) ? structuredClone(input) : null;
	} catch { return null; }
}

function ttl(value: unknown): boolean { return record(value) && exactKeys(value, ['snapshotMs', 'catalogMs', 'pricesMs', 'accountSignalsMs']) && value.snapshotMs === 15 * 60_000 && value.catalogMs === 7 * 86_400_000 && value.pricesMs === 15 * 60_000 && value.accountSignalsMs === 24 * 60 * 60_000; }
function coverage(value: unknown): boolean { return record(value) && exactKeys(value, ['snapshot', 'catalog', 'prices', 'accountSignals']) && Object.values(value).every((entry) => entry === 'complete' || entry === 'partial' || entry === 'unavailable'); }
function exactCoverage(value: InventoryAdvisorEvidenceV1): boolean {
	const owned = Object.entries(value.snapshot.ownedByItem).filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort((a, b) => a - b);
	const available = Object.entries(value.snapshot.availableByItem).filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort((a, b) => a - b);
	const catalogIds = Object.keys(value.catalog.coverage.items).map(Number).sort((a, b) => a - b);
	const priced = [...value.prices.items.map((item) => item.itemId), ...value.prices.missingItemIds].sort((a, b) => a - b);
	const same = (left: number[], right: number[]): boolean => left.length === right.length && left.every((entry, index) => entry === right[index]);
	const catalog = owned.every((id) => resolvedFresh(value.catalog.coverage.items[String(id)])) ? 'complete'
		: owned.every((id) => value.catalog.coverage.items[String(id)]?.status === 'unavailable') ? 'unavailable' : 'partial';
	const signals = value.accountSignals.unlockCoverage === 'complete' && value.accountSignals.achievementCoverage === 'complete' && value.accountSignals.tradingPostAccess !== 'unknown' ? 'complete'
		: value.accountSignals.unlockCoverage === 'unavailable' && value.accountSignals.achievementCoverage === 'unavailable' && value.accountSignals.tradingPostAccess === 'unknown' ? 'unavailable' : 'partial';
	const snapshot = snapshotCoverage(value.snapshot);
	return same(owned, catalogIds) && same(available, value.prices.requestedItemIds) && same(available, priced)
		&& value.coverage.snapshot === snapshot && value.coverage.catalog === catalog && value.coverage.prices === value.prices.status && value.coverage.accountSignals === signals;
}
function evidenceFreshForPolicy(evidence: InventoryAdvisorEvidenceV1, asOf: unknown, policy: InventoryAdvisorPolicyV1): boolean {
	if (!iso(asOf) || !Number.isSafeInteger(policy.maxFutureSkewMs)
		|| policy.maxSnapshotAgeMs > evidence.ttl.snapshotMs || policy.maxPriceAgeMs > evidence.ttl.pricesMs
		|| policy.maxCatalogAgeMs > evidence.ttl.catalogMs || policy.maxAccountSignalsAgeMs > evidence.ttl.accountSignalsMs) return false;
	return fresh(evidence.snapshot.completedAt, asOf, policy.maxSnapshotAgeMs, policy.maxFutureSkewMs)
		&& fresh(evidence.catalog.resolvedAt, asOf, policy.maxCatalogAgeMs, policy.maxFutureSkewMs)
		&& fresh(evidence.prices.capturedAt, asOf, policy.maxPriceAgeMs, policy.maxFutureSkewMs)
		&& fresh(evidence.accountSignals.capturedAt, asOf, policy.maxAccountSignalsAgeMs, policy.maxFutureSkewMs);
}
function timestamps(value: InventoryAdvisorEvidenceV1): boolean {
	const captured = Date.parse(value.capturedAt);
	const finished = Date.parse(value.finishedAt);
	if (captured !== Date.parse(value.snapshot.completedAt) || captured > finished) return false;
	const within = (instant: string, ttlMs: number): boolean => Date.parse(instant) >= finished - ttlMs && Date.parse(instant) <= finished;
	if (!within(value.snapshot.completedAt, value.ttl.snapshotMs) || !within(value.catalog.resolvedAt, value.ttl.catalogMs)
		|| !within(value.prices.capturedAt, value.ttl.pricesMs) || !within(value.accountSignals.capturedAt, value.ttl.accountSignalsMs)) return false;
	return Object.values(value.accountSignals.endpointCoverage).every((endpoint) => endpoint.capturedAt === null
		|| (Date.parse(endpoint.capturedAt) <= Date.parse(value.accountSignals.capturedAt) && within(endpoint.capturedAt, value.ttl.accountSignalsMs)));
}
function resolvedFresh(entry: { status: string; source: string } | undefined): boolean {
	return entry?.status === 'resolved' && (entry.source === 'network' || entry.source === 'cache_fresh');
}
function snapshotCoverage(snapshot: InventoryAdvisorEvidenceV1['snapshot']): InventoryAdvisorEvidenceV1['coverage']['snapshot'] {
	return snapshot.quality === 'stable' && Object.values(snapshot.coverage.sources).every((entry) => entry.status === 'complete') ? 'complete' : 'partial';
}
function fresh(evidenceAt: string, asOf: string, maxAgeMs: number, maxFutureSkewMs: number): boolean {
	const evidence = Date.parse(evidenceAt); const now = Date.parse(asOf);
	return evidence <= now + maxFutureSkewMs && now - evidence <= maxAgeMs;
}
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
