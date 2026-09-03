/**
 * Inventory advisor composition, lifted out of `main.ts`.
 *
 * The advisor is the deepest stack in the plugin: a capture service that only
 * exists once a refresh is actually asked for, a preferences runtime scoped to
 * the vault, a workflow that walks capture, preferences and classification, and
 * a presentation controller on top. All of it used to hang off a fourteen
 * argument factory in `main.ts`, which is why the only test that could see the
 * wiring read the file as text.
 *
 * Everything the stack needs arrives as an explicit input, and every settings
 * read is a function: a preference changed mid-session has to take effect on
 * the next refresh without rebuilding the workflow.
 */

import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import { InventoryAdvisorEvidenceService } from '../advisor/inventory-advisor-evidence';
import type {
	InventoryAdvisorCaptureProgress,
	InventoryAdvisorCaptureReceiptV1,
} from '../advisor/inventory-advisor-evidence-model';
import {
	createInventoryAdvisorBuiltinRulesProvider,
	InventoryAdvisorWorkflow,
	type InventoryAdvisorWorkflowResult,
} from '../advisor/inventory-advisor-workflow';
import { InventoryPreferencesRuntime } from '../advisor/inventory-preferences-runtime';
import { InventoryPreferencesService } from '../advisor/inventory-preferences-service';
import { IndexedDbInventoryPreferencesStore } from '../advisor/inventory-preferences-store';
import type { GuildWars2Client } from '../account/guild-wars-2-client';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';
import { createCatalogCacheAdapter } from '../catalog/persistent-catalog-cache';
import type { GuildWars2PublicCatalogClient } from '../catalog/public-catalog-client';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import type { Locale } from '../core/i18n';
import type { LocalDebugActionRunner, ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { startLocalDebugAction } from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type {
	resolveEquipmentSalvagePreferences,
	resolveMaterialStorageCapacity,
	TyrianSettings,
} from '../core/settings';
import { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';

/** A mutable slot the one-click sync run swaps in for the duration of one refresh call. */
export interface InventoryAdvisorPhaseListenerRef {
	current: ((phase: 'capture' | 'preferences' | 'classification') => void) | null;
}

/** Same shape, for the capture phase's own real request counters. */
export interface InventoryAdvisorCaptureProgressListenerRef {
	current: ((progress: InventoryAdvisorCaptureProgress) => void) | null;
}

export interface AdvisorAssemblyInput {
	/** The IndexedDB factory the preferences store opens against. */
	factory: IDBFactory;
	/** Scopes stored preferences to one vault. */
	vaultId: string;
	client: GuildWars2Client;
	publicClient: GuildWars2PublicCatalogClient;
	snapshots: Pick<StorageSnapshotService, 'captureInventoryWithOperation'>;
	rateLimit: RateLimitCoordinator;
	locale: () => Locale;
	personalValuation: () => TyrianSettings['halloweenPersonalValuation'];
	materialStorageCapacity: () => ReturnType<typeof resolveMaterialStorageCapacity>;
	equipmentSalvagePreferences: () => ReturnType<typeof resolveEquipmentSalvagePreferences>;
	writeCaptureReceipt: (receipt: InventoryAdvisorCaptureReceiptV1) => void | Promise<void>;
	phaseListener: InventoryAdvisorPhaseListenerRef;
	captureProgressListener: InventoryAdvisorCaptureProgressListenerRef;
	catalogPersistence: LocalDebugPersistenceProbe;
	preferencesReadPersistence: LocalDebugPersistenceProbe;
	preferencesWritePersistence: LocalDebugPersistenceProbe;
	diagnostics: LocalDebugActionRunner | null;
}

export interface AdvisorAssembly {
	preferences: InventoryPreferencesRuntime;
	controller: InventoryAdvisorPresentationController;
}

/** Builds the preferences runtime and the advisor controller that reads it. Nothing is captured here. */
export function assembleAdvisor(input: AdvisorAssemblyInput): AdvisorAssembly {
	const preferences = new InventoryPreferencesRuntime(
		new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(
			input.factory,
			undefined,
			{ read: input.preferencesReadPersistence, write: input.preferencesWritePersistence },
		)),
		input.vaultId,
		input.diagnostics ?? undefined,
	);
	return { preferences, controller: createInventoryAdvisorRuntime(input, preferences) };
}

function createInventoryAdvisorRuntime(
	input: AdvisorAssemblyInput,
	preferences: InventoryPreferencesRuntime,
): InventoryAdvisorPresentationController {
	const { client, publicClient, snapshots, rateLimit, diagnostics } = input;
	const { phaseListener, captureProgressListener, writeCaptureReceipt } = input;
	const { personalValuation, materialStorageCapacity, equipmentSalvagePreferences } = input;
	let inventoryEvidence: InventoryAdvisorEvidenceService | null = null;
	let latestCaptureReceipt: InventoryAdvisorCaptureReceiptV1 | null = null;
	let workflowStartedAt = 0;
	let workflowStage: 'capture' | 'preferences' | 'classification' = 'capture';
	const enterWorkflowStage = (stage: typeof workflowStage): void => {
		workflowStage = stage;
		phaseListener.current?.(stage);
	};
	const writeWorkflowReceipt = async (
		workflow: NonNullable<InventoryAdvisorCaptureReceiptV1['workflow']>,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> => {
		const receipt = latestCaptureReceipt ?? emptyInventoryAdvisorCaptureReceipt();
		const span = startLocalDebugAction(diagnostics ?? undefined, {
			component: 'advisor', action: 'inventory_advisor_refresh', state: 'workflow_receipt',
			...(parent === undefined ? {} : {
				parent: { actionId: parent.actionId, correlationId: parent.correlationId },
			}),
		});
		try {
			await writeCaptureReceipt({ ...receipt, workflow });
			span.success('workflow_receipt_written');
		} catch (error) {
			span.failure(error, 'storage_failure', 'workflow_receipt_failed');
			/* Local receipt persistence must never become an advisor dependency. */
		}
	};
	const inventoryWorkflow = new InventoryAdvisorWorkflow({
		diagnostics: diagnostics ?? undefined,
		capture: { capture: async (captureLocale, expectedPriceItemIds, _onProgress, actionContext) => {
			if (inventoryEvidence === null) {
				const catalogCache = await createCatalogCacheAdapter({ diagnostics: input.catalogPersistence });
				inventoryEvidence = new InventoryAdvisorEvidenceService(
					client, snapshots, new PublicCatalogService(publicClient, catalogCache), publicClient,
					Date.now, async (receipt) => {
						latestCaptureReceipt = structuredClone(receipt);
						await writeCaptureReceipt(receipt);
					}, rateLimit,
				);
			}
			return await inventoryEvidence.capture(captureLocale, expectedPriceItemIds, (progress) => {
				captureProgressListener.current?.(progress);
			}, actionContext);
		} },
		preferences: { load: async (capture, parent) => {
			enterWorkflowStage('preferences');
			await writeWorkflowReceipt({
				status: 'progress', stage: 'preferences',
				elapsedMs: Math.max(0, Date.now() - workflowStartedAt),
			}, parent);
			const loaded = await preferences.load(capture, parent);
			enterWorkflowStage('classification');
			await writeWorkflowReceipt({
				status: 'progress', stage: 'classification',
				elapsedMs: Math.max(0, Date.now() - workflowStartedAt),
			}, parent);
			return loaded;
		} },
		rules: createInventoryAdvisorBuiltinRulesProvider(
			inventoryAdvisorBuiltinBundleProvider, personalValuation, materialStorageCapacity,
			equipmentSalvagePreferences,
		),
	});
	return new InventoryAdvisorPresentationController({
		load: async (parent) => {
			latestCaptureReceipt = null;
			workflowStartedAt = Date.now();
			enterWorkflowStage('capture');
			try {
				const result = await inventoryWorkflow.refresh(input.locale(), parent);
				await writeWorkflowReceipt(inventoryAdvisorWorkflowReceipt(result), parent);
				return result;
			} catch (error) {
				await writeWorkflowReceipt(inventoryAdvisorWorkflowFailureReceipt(
					error, workflowStage, Math.max(0, Date.now() - workflowStartedAt),
				), parent);
				throw error;
			}
		},
		reclassify: (parent) => inventoryWorkflow.reclassify(parent),
		invalidate: () => inventoryWorkflow.invalidate(),
	});
}

export function inventoryAdvisorWorkflowFailureReceipt(
	error: unknown,
	stage: 'capture' | 'preferences' | 'classification',
	elapsedMs: number,
): Extract<NonNullable<InventoryAdvisorCaptureReceiptV1['workflow']>, { status: 'failed' }> {
	return {
		status: 'failed',
		stage,
		reason: error instanceof Error && error.message === 'inventory_advisor_input_invalid'
			? 'input_invalid' : 'unexpected_failure',
		elapsedMs: Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0,
	};
}

function emptyInventoryAdvisorCaptureReceipt(): InventoryAdvisorCaptureReceiptV1 {
	return {
		version: 1,
		recordedAt: new Date().toISOString(),
		status: 'unavailable',
		failure: null,
		evidenceCoverage: null,
		evidenceDetails: null,
		containerPrices: 'not_requested',
		workflow: null,
		snapshot: null,
	};
}

export function inventoryAdvisorWorkflowReceipt(
	result: InventoryAdvisorWorkflowResult,
): NonNullable<InventoryAdvisorCaptureReceiptV1['workflow']> {
	if (result.status === 'blocked') return { status: 'blocked', reason: result.reason };
	const report = result.source.result.report;
	if (report === null) {
		return {
			status: 'ready',
			resultStatus: result.source.result.status,
			lineCount: 0,
			decisionCount: 0,
			defaultVisibleDecisionCount: 0,
			actionCounts: [],
			reasonCounts: [],
		};
	}
	const decisions = report.lines.flatMap((line) => line.decisions);
	return {
		status: 'ready',
		resultStatus: result.source.result.status,
		lineCount: report.lines.length,
		decisionCount: decisions.length,
		defaultVisibleDecisionCount: decisions.filter((decision) => decision.action !== 'review').length,
		actionCounts: counts(decisions.map((decision) => decision.action), 'action'),
		reasonCounts: counts(
			report.explanations.flatMap((explanation) => explanation.reasonCodes),
			'reason',
		),
	};
}

function counts<Key extends 'action' | 'reason'>(
	values: readonly string[],
	key: Key,
): Array<Record<Key, string> & { count: number }> {
	const totals = new Map<string, number>();
	for (const value of values) totals.set(value, (totals.get(value) ?? 0) + 1);
	return [...totals].sort(([left], [right]) => left.localeCompare(right))
		.map(([value, count]) => ({ [key]: value, count }) as Record<Key, string> & { count: number });
}
