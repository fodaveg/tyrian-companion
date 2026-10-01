import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
// Wraps the real classifier so each classification of the account is counted, never replaced.
vi.mock('./advisor/inventory-advisor-classifier', async (importOriginal) => {
	const original = await importOriginal<typeof import('./advisor/inventory-advisor-classifier')>();
	return { ...original, classifyInventoryAdvisor: vi.fn(original.classifyInventoryAdvisor) };
});

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './advisor/inventory-advisor-classifier';
import { InventoryAdvisorWorkflow, type InventoryAdvisorRules } from './advisor/inventory-advisor-workflow';
import { InventoryPreferencesRuntime } from './advisor/inventory-preferences-runtime';
import { InventoryPreferencesService } from './advisor/inventory-preferences-service';
import type {
	InventoryPreferenceScope, InventoryPreferencesReadResult, InventoryPreferencesStore,
	InventoryPreferencesV1, InventoryPreferencesWriteResult,
} from './advisor/inventory-preferences-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './advisor/inventory-advisor-contract';
import type { InventoryAdvisorEvidenceV1 } from './advisor/inventory-advisor-evidence-model';
import type { AccountSignalsV1, InventoryPriceSnapshotV1, KeepExceptionV1 } from './advisor/inventory-advisor-model';
import type { InventoryKnowledgePackV1 } from './advisor/inventory-advisor-classifier-model';
import { InventoryAdvisorPresentationController } from './ui/inventory-advisor-controller';
import { keepExceptionForItem } from './ui/inventory-advisor-view';
import type { StorageSnapshot } from './account/storage-snapshot-model';
import { PINNED_SCHEMA } from './account/storage-snapshot-model';
import type { CatalogResolution } from './catalog/public-catalog-model';

const NOW = '2026-08-14T12:00:00.000Z';

/**
 * Runs the production editor-session closure of the core (`createInventoryPreferencesEditorSession`)
 * over the real preferences runtime, workflow and presentation controller. Only the account capture
 * and the IndexedDB store are fakes; `classifyInventoryAdvisor` is the real classifier, counted.
 */
async function analysedAdvisor() {
	const fixture = reviewedDiscardFixture();
	const store = new MemoryPreferencesStore();
	const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
	const workflow = new InventoryAdvisorWorkflow({
		capture: { capture: async () => ({ status: 'complete' as const, evidence: fixture.evidence }) },
		preferences: { load: async (capture, parent) => await runtime.load(capture, parent) },
		rules: { current: () => ({ status: 'available', value: fixture.rules }) },
		now: () => Date.parse(NOW),
	});
	const controller = new InventoryAdvisorPresentationController({
		load: async () => await workflow.refresh('es'),
		reclassify: async () => await workflow.reclassify(),
		invalidate: () => workflow.invalidate(),
	});
	const harness = {
		runtimeReady: true, inventoryPreferences: runtime, inventoryAdvisor: controller,
		renderInventoryAdvisorViews: () => undefined, notifyRuntimeStarting: () => undefined,
	};
	await controller.refresh();
	const classifications = vi.mocked(classifyInventoryAdvisor);
	classifications.mockClear();
	const newSession = () => TyrianCompanionCore.prototype.createInventoryPreferencesEditorSession.call(harness as never);
	return { fixture, store, runtime, controller, classifications, newSession };
}

/** The item view's "Conservar" (`keepItem`): load when not ready, then one keep-exception write. */
async function keepItem(session: ReturnType<Awaited<ReturnType<typeof analysedAdvisor>>['newSession']>, itemId: number) {
	const state = session.current().status === 'ready' ? session.current() : await session.load();
	if (state.status !== 'ready') throw new Error(`preferences not ready: ${state.status}`);
	const keepException = keepExceptionForItem(itemId, state.keepExceptions);
	if (keepException !== null) await session.upsertKeepException(keepException);
}

describe('inventory preferences: loading does not reclassify the account unless the revision changed', () => {
	it('opening the preferences editor on the revision the analysis used classifies 0 times', async () => {
		const { newSession, classifications } = await analysedAdvisor();
		const state = await newSession().load();
		expect(state.status).toBe('ready');
		expect(classifications).toHaveBeenCalledTimes(0);
	});

	it('loading a revision changed from outside (another window or device) classifies once', async () => {
		const { newSession, classifications, store, fixture } = await analysedAdvisor();
		const other = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await other.load({ status: 'complete', evidence: fixture.evidence });
		await other.upsertKeepException(keep(10));
		const state = await newSession().load();
		expect(state).toMatchObject({ status: 'ready', keepExceptions: [{ itemId: 10 }] });
		expect(classifications).toHaveBeenCalledTimes(1);
	});

	it('the first "Conservar" after an analysis classifies exactly once', async () => {
		const { newSession, classifications, store, fixture } = await analysedAdvisor();
		await keepItem(newSession(), 10);
		// The write must have landed (a load that expired the session would drop it silently)...
		const stored = await store.read({ vaultId: 'vault-hash', accountId: fixture.evidence.accountId });
		expect(stored).toMatchObject({ status: 'ok', record: { keepExceptions: [{ itemId: 10, status: 'active' }] } });
		// ...and the whole click paid one classification, not one for the load and one for the write.
		expect(classifications).toHaveBeenCalledTimes(1);
	});

	it('control: saving a preference still reclassifies once and the editor reflects it', async () => {
		const { newSession, classifications, store, fixture } = await analysedAdvisor();
		const session = newSession();
		await session.load();
		classifications.mockClear();
		const state = await session.upsertKeepException(keep(10));
		expect(state).toMatchObject({ status: 'ready', keepExceptions: [{ itemId: 10 }] });
		expect(classifications).toHaveBeenCalledTimes(1);
		const stored = await store.read({ vaultId: 'vault-hash', accountId: fixture.evidence.accountId });
		expect(stored).toMatchObject({ status: 'ok', record: { keepExceptions: [{ itemId: 10 }] } });
	});
});

function keep(itemId: number): KeepExceptionV1 {
	return { version: 1, exceptionId: `keep-${String(itemId)}`, itemId, status: 'active', basis: 'available', quantity: { mode: 'all' }, reason: 'user_keep' };
}

class MemoryPreferencesStore implements InventoryPreferencesStore {
	private readonly records = new Map<string, InventoryPreferencesV1>();
	async read(scope: InventoryPreferenceScope): Promise<InventoryPreferencesReadResult> {
		return { status: 'ok', record: structuredClone(this.records.get(key(scope)) ?? null) };
	}
	async compareAndSwap(scope: InventoryPreferenceScope, expected: number, next: InventoryPreferencesV1): Promise<InventoryPreferencesWriteResult> {
		const current = this.records.get(key(scope)) ?? null;
		if ((current?.generation ?? 0) !== expected) return { status: 'conflict', generation: current?.generation ?? 0 };
		this.records.set(key(scope), structuredClone(next));
		return { status: 'saved', record: structuredClone(next) };
	}
	dispose(): void {}
}

function key(scope: InventoryPreferenceScope): string { return `${scope.vaultId}\u0000${scope.accountId}`; }

function completeEndpoint() {
	return { status: 'complete' as const, capturedAt: NOW, reason: null };
}

function completeSnapshotCoverage() {
	return { sources: {
		characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const },
		bank: { status: 'complete' as const }, materials: { status: 'complete' as const },
		wallet: { status: 'complete' as const }, commerce_delivery: { status: 'complete' as const },
	}, characters: {} };
}

function notApplicable(assertionId: string) {
	return { status: 'not_applicable' as const, assertionId, sourceIds: ['knowledge-source'] };
}

/** The same one-item account the workflow tests classify: item 10, a curated discard candidate. */
function reviewedDiscardFixture(): { evidence: InventoryAdvisorEvidenceV1; rules: InventoryAdvisorRules } {
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
		currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {}, roster: [],
		coverage: completeSnapshotCoverage(), passCoverages: [completeSnapshotCoverage(), completeSnapshotCoverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [{ ruleId: 'discard-10', itemId: 10, action: 'discard_candidate' as const, status: 'approved' as const,
			assertion: 'applicable' as const, reason: 'curated_discard_review' as const, sourceIds: ['rule-source'] }],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledgePack: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'knowledge-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [{ itemId: 10, use: notApplicable('use-none'), open: notApplicable('open-none'), salvage: notApplicable('salvage-none') }],
	};
	knowledgePack.sha256 = sha256InventoryKnowledgePack(knowledgePack);
	const catalog: CatalogResolution = {
		snapshotId: 'snapshot-1', locale: 'es' as const, schemaVersion: PINNED_SCHEMA, resolvedAt: NOW,
		items: { '10': { kind: 'item' as const, id: 10, name: 'No vendible', type: 'Trophy', rarity: 'Basic', level: 0,
			vendorValue: 0, flags: ['AccountBound', 'NoSell', 'NoSalvage'], gameTypes: [], restrictions: [] } },
		currencies: {}, materials: {}, warnings: [],
		coverage: { items: { '10': { status: 'resolved' as const, source: 'network' as const } }, currencies: {}, materials: {} },
	};
	const prices: InventoryPriceSnapshotV1 = {
		version: 1 as const, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: NOW,
		source: 'gw2-commerce-prices' as const, schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete' as const,
		items: [{ itemId: 10, whitelisted: false, bid: null, ask: null }], missingItemIds: [],
	};
	const accountSignals: AccountSignalsV1 = {
		version: 1 as const, source: 'gw2-account-api' as const, accountId: 'account-1',
		capturedAt: NOW, schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full' as const,
		endpointCoverage: { account: completeEndpoint(), recipes: completeEndpoint(), skins: completeEndpoint(), minis: completeEndpoint(), achievements: completeEndpoint() },
		unlockCoverage: 'complete' as const, unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
		achievementCoverage: 'complete' as const, completedAchievementBits: {}, achievementProgress: [],
	};
	const evidence: InventoryAdvisorEvidenceV1 = {
		version: 1, scope: 'supported_storage_v1', accountId: 'account-1', snapshotId: 'snapshot-1', schemaVersion: PINNED_SCHEMA,
		capturedAt: snapshot.completedAt, finishedAt: NOW, locale: 'es', snapshot,
		snapshotFingerprint: sha256CanonicalValue(snapshot),
		ttl: { snapshotMs: 900_000, catalogMs: 604_800_000, pricesMs: 900_000, accountSignalsMs: 86_400_000 },
		coverage: { snapshot: 'complete', catalog: 'complete', prices: 'complete', accountSignals: 'complete' },
		catalog, prices, accountSignals,
	};
	return { evidence, rules: { rulePack, knowledgePack, policy: {
		version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
		maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
		listingMinimumAdvantageBps: 1_000,
	} } };
}
