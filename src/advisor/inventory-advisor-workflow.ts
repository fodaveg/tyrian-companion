import type { InventoryAdvisorEvidenceCapture, InventoryAdvisorEvidenceCaptureResultV1, InventoryAdvisorEvidenceV1 } from './inventory-advisor-evidence-model';
import { createInventoryAdvisorInputFromEvidence } from './inventory-advisor-evidence-contract';
import { classifyInventoryAdvisor } from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { applyInventoryDiscardAllowlist } from './inventory-advisor-discard';
import type { InventoryAdvisorPolicyV1, InventoryAdvisorRulePackV1, KeepExceptionV1 } from './inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryAdvisorContextualPresentationSource, InventoryAdvisorPresentationSource } from './inventory-advisor-presentation';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import type { InventoryAdvisorBuiltinBundleProvider } from './inventory-advisor-builtin-bundle';

export interface InventoryAdvisorPreferencesSnapshot {
	goals: ReservationGoal[];
	keepExceptions: KeepExceptionV1[];
}

export type InventoryAdvisorPreferencesLoadResult =
	| { status: 'ready'; value: InventoryAdvisorPreferencesSnapshot }
	| { status: 'blocked'; reason: 'preferences_corrupt' | 'preferences_future' | 'preferences_unavailable' };

export interface InventoryAdvisorWorkflowPorts {
	capture: Pick<InventoryAdvisorEvidenceCapture, 'capture'>;
	/** Preferences are scoped only after the explicit capture proves an account identity. */
	preferences: { load(capture: InventoryAdvisorEvidenceCaptureResultV1): Promise<InventoryAdvisorPreferencesLoadResult> };
	rules: InventoryAdvisorRulesProvider;
	now?: () => number;
}

export type InventoryAdvisorRules = {
	rulePack: InventoryAdvisorRulePackV1;
	knowledgePack: InventoryKnowledgePackV1;
	policy: InventoryAdvisorPolicyV1;
};
export type InventoryAdvisorRulesAvailability = { status: 'available'; value: InventoryAdvisorRules } | { status: 'unavailable' };
export interface InventoryAdvisorRulesProvider { current(asOf: string): InventoryAdvisorRulesAvailability }
export type InventoryAdvisorWorkflowResult =
	| { status: 'ready'; source: InventoryAdvisorPresentationSource }
	| { status: 'blocked'; reason: 'missing_rules' | 'preferences_corrupt' | 'preferences_future' | 'preferences_unavailable' | 'stale_evidence' };

/** Explicit capture-to-presentation composition. Construction and reads perform no I/O. */
export class InventoryAdvisorWorkflow {
	private last: { capture: InventoryAdvisorEvidenceCaptureResultV1 } | null = null;
	private epoch = 0;

	constructor(private readonly ports: InventoryAdvisorWorkflowPorts) {}

	async refresh(locale: CatalogLocale): Promise<InventoryAdvisorWorkflowResult> {
		const epoch = ++this.epoch;
		this.last = null;
		const asOf = new Date(this.ports.now?.() ?? Date.now()).toISOString();
		const rules = this.ports.rules.current(asOf);
		if (rules.status === 'unavailable') return { status: 'blocked', reason: 'missing_rules' };
		const capture = await this.ports.capture.capture(locale);
		if (!this.active(epoch)) return { status: 'blocked', reason: 'stale_evidence' };
		const preferences = await this.ports.preferences.load(capture);
		if (!this.active(epoch)) return { status: 'blocked', reason: 'stale_evidence' };
		if (preferences.status === 'blocked') return preferences;
		const source = composeInventoryAdvisorRefresh(capture, preferences.value, rules.value, asOf);
		if (!this.active(epoch)) return { status: 'blocked', reason: 'stale_evidence' };
		this.last = { capture: structuredClone(capture) };
		return {
			status: 'ready',
			source,
		};
	}

	/** Rebuilds the local presentation after a preference write, never recapturing the account. */
	async reclassify(): Promise<InventoryAdvisorWorkflowResult> {
		const epoch = this.epoch;
		if (this.last === null) return { status: 'blocked', reason: 'stale_evidence' };
		const last = this.last;
		const asOf = new Date(this.ports.now?.() ?? Date.now()).toISOString();
		const rules = this.ports.rules.current(asOf);
		if (rules.status === 'unavailable') {
			this.last = null;
			return { status: 'blocked', reason: 'missing_rules' };
		}
		if (last.capture.evidence === null || !fresh(last.capture.evidence, asOf, rules.value.policy)) {
			this.last = null;
			return { status: 'blocked', reason: 'stale_evidence' };
		}
		const preferences = await this.ports.preferences.load(structuredClone(last.capture));
		if (!this.active(epoch) || this.last !== last) return { status: 'blocked', reason: 'stale_evidence' };
		if (preferences.status === 'blocked') return preferences;
		const source = composeInventoryAdvisorRefresh(last.capture, preferences.value, rules.value, asOf);
		if (!this.active(epoch) || this.last !== last) return { status: 'blocked', reason: 'stale_evidence' };
		return { status: 'ready', source };
	}

	/** Invalidates retained evidence after account/locale changes without opening a persistence boundary. */
	invalidate(): void { this.epoch += 1; this.last = null; }

	private active(epoch: number): boolean { return this.epoch === epoch; }
}

/** Maps the immutable H4.17 bundle into the H5.11 workflow without weakening its expiry gate. */
export function createInventoryAdvisorBuiltinRulesProvider(
	provider: InventoryAdvisorBuiltinBundleProvider,
): InventoryAdvisorRulesProvider {
	return Object.freeze({
		current(asOf: string): InventoryAdvisorRulesAvailability {
			const loaded = provider.load(asOf);
			return loaded.status === 'available'
				? { status: 'available', value: {
					rulePack: loaded.bundle.rulePack,
					knowledgePack: loaded.bundle.knowledgePack,
					policy: loaded.bundle.policy,
				} }
				: { status: 'unavailable' };
		},
	});
}

export function composeInventoryAdvisorRefresh(
	capture: InventoryAdvisorEvidenceCaptureResultV1,
	preferences: InventoryAdvisorPreferencesSnapshot,
	rules: InventoryAdvisorRules,
	asOf: string,
): InventoryAdvisorContextualPresentationSource {
	if (capture.evidence === null) throw new Error(`inventory_advisor_capture_${capture.status}`);
	const input = createInventoryAdvisorInputFromEvidence({
		asOf, evidence: capture.evidence,
		goals: structuredClone(preferences.goals),
		keepExceptions: structuredClone(preferences.keepExceptions),
		rulePack: structuredClone(rules.rulePack), policy: structuredClone(rules.policy),
	});
	if (input === null) throw new Error('inventory_advisor_input_invalid');
	const engineInput = { input, knowledgePack: structuredClone(rules.knowledgePack) };
	const producerResult = classifyInventoryAdvisor(engineInput);
	const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
	return { input, result, discardContext: { engineInput, producerResult } };
}

/** Replaceable H5.12 port. It is deliberately empty until persisted preferences are wired. */
export const EMPTY_INVENTORY_ADVISOR_PREFERENCES = Object.freeze({
	async load(): Promise<InventoryAdvisorPreferencesLoadResult> {
		return { status: 'ready', value: { goals: [], keepExceptions: [] } };
	},
});

function fresh(evidence: InventoryAdvisorEvidenceV1, asOf: string, policy: InventoryAdvisorPolicyV1): boolean {
	const now = Date.parse(asOf);
	const timestamps = [evidence.snapshot.completedAt, evidence.catalog.resolvedAt, evidence.prices.capturedAt, evidence.accountSignals.capturedAt];
	const limits = [policy.maxSnapshotAgeMs, policy.maxCatalogAgeMs, policy.maxPriceAgeMs, policy.maxAccountSignalsAgeMs];
	const supported = limits[0]! <= evidence.ttl.snapshotMs && limits[1]! <= evidence.ttl.catalogMs
		&& limits[2]! <= evidence.ttl.pricesMs && limits[3]! <= evidence.ttl.accountSignalsMs;
	return Number.isFinite(now) && supported && timestamps.every((value, index) => {
		const capturedAt = Date.parse(value);
		return Number.isFinite(capturedAt) && capturedAt <= now + policy.maxFutureSkewMs && now - capturedAt <= limits[index]!;
	});
}
