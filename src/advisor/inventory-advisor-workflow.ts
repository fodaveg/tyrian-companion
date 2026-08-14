import type { InventoryAdvisorEvidenceCapture, InventoryAdvisorEvidenceCaptureResultV1 } from './inventory-advisor-evidence-model';
import { createInventoryAdvisorInputFromEvidence } from './inventory-advisor-evidence-contract';
import { classifyInventoryAdvisor } from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { applyInventoryDiscardAllowlist } from './inventory-advisor-discard';
import type { InventoryAdvisorPolicyV1, InventoryAdvisorRulePackV1, KeepExceptionV1 } from './inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryAdvisorContextualPresentationSource, InventoryAdvisorPresentationSource } from './inventory-advisor-presentation';
import type { CatalogLocale } from '../catalog/public-catalog-model';

export interface InventoryAdvisorPreferencesSnapshot {
	goals: ReservationGoal[];
	keepExceptions: KeepExceptionV1[];
}

export interface InventoryAdvisorWorkflowPorts {
	capture: Pick<InventoryAdvisorEvidenceCapture, 'capture'>;
	preferences: { load(): Promise<InventoryAdvisorPreferencesSnapshot> };
	rules: { current(): InventoryAdvisorRulesAvailability };
	now?: () => number;
}

export type InventoryAdvisorRules = {
	rulePack: InventoryAdvisorRulePackV1;
	knowledgePack: InventoryKnowledgePackV1;
	policy: InventoryAdvisorPolicyV1;
};
export type InventoryAdvisorRulesAvailability = { status: 'available'; value: InventoryAdvisorRules } | { status: 'unavailable' };
export type InventoryAdvisorWorkflowResult =
	| { status: 'ready'; source: InventoryAdvisorPresentationSource }
	| { status: 'blocked'; reason: 'missing_rules' };

/** Explicit capture-to-presentation composition. Construction and reads perform no I/O. */
export class InventoryAdvisorWorkflow {
	constructor(private readonly ports: InventoryAdvisorWorkflowPorts) {}

	async refresh(locale: CatalogLocale): Promise<InventoryAdvisorWorkflowResult> {
		const rules = this.ports.rules.current();
		if (rules.status === 'unavailable') return { status: 'blocked', reason: 'missing_rules' };
		const [capture, preferences] = await Promise.all([
			this.ports.capture.capture(locale),
			this.ports.preferences.load(),
		]);
		return {
			status: 'ready',
			source: composeInventoryAdvisorRefresh(capture, preferences, rules.value, new Date(this.ports.now?.() ?? Date.now()).toISOString()),
		};
	}
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
	async load(): Promise<InventoryAdvisorPreferencesSnapshot> { return { goals: [], keepExceptions: [] }; },
});
