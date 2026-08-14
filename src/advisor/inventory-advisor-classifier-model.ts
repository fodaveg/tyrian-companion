import type { InventoryAdvisorInputV1, InventoryAdvisorPositionV1, InventoryRecommendationAction } from './inventory-advisor-model';

export const INVENTORY_KNOWLEDGE_PACK_VERSION = 1 as const;
export const INVENTORY_ADVISOR_ENGINE_VERSION = 1 as const;

export type InventoryKnowledgeTargetV1 =
	| { kind: 'recipe'; id: number }
	| { kind: 'skin'; id: number }
	| { kind: 'mini'; id: number }
	| { kind: 'achievement'; achievementId: number; bit: number | null }
	| { kind: 'generic_consumable' };

export type InventoryRouteClaimV1 =
	| { status: 'applicable'; ruleId: string; sourceIds: string[]; target?: InventoryKnowledgeTargetV1 }
	| { status: 'not_applicable'; assertionId: string; sourceIds: string[] };

export interface InventoryKnowledgeEntryV1 {
	itemId: number;
	use: InventoryRouteClaimV1 | null;
	open: InventoryRouteClaimV1 | null;
	salvage: InventoryRouteClaimV1 | null;
}

export interface InventoryKnowledgePackV1 {
	schemaVersion: typeof INVENTORY_KNOWLEDGE_PACK_VERSION;
	id: string;
	version: number;
	publishedAt: string;
	reviewedAt: string;
	validUntil: string;
	sha256: string;
	sources: Array<{ id: string; url: string; retrievedAt: string }>;
	entries: InventoryKnowledgeEntryV1[];
}

export interface InventoryAdvisorEngineInputV1 {
	input: InventoryAdvisorInputV1;
	knowledgePack: InventoryKnowledgePackV1;
}

export interface InventoryAdvisorEngineAllocationV1 { positionRef: string; quantity: number; }
export interface InventoryAdvisorEngineDecisionV1 {
	action: Exclude<InventoryRecommendationAction, 'discard_candidate'>;
	itemId: number;
	quantity: number;
	allocations: InventoryAdvisorEngineAllocationV1[];
	reason: string;
	ruleId: string | null;
}
export interface InventoryAdvisorEngineLineV1 {
	itemId: number;
	name: string;
	ownedQuantity: number;
	positions: InventoryAdvisorPositionV1[];
	decisions: InventoryAdvisorEngineDecisionV1[];
}
export interface InventoryAdvisorEngineReportV1 {
	version: typeof INVENTORY_ADVISOR_ENGINE_VERSION;
	scope: 'supported_storage_v1';
	accountId: string;
	snapshotId: string;
	asOf: string;
	knowledgePack: { id: string; version: number; sha256: string };
	lines: InventoryAdvisorEngineLineV1[];
}
export type InventoryAdvisorEngineResultV1 =
	| { status: 'ready' | 'limited' | 'blocked'; report: InventoryAdvisorEngineReportV1; envelope: { execution: 'manual_in_game'; sideEffects: 'none'; requiresUserAction: true } }
	| { status: 'invalid'; report: null; envelope: null; };
