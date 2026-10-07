import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
// Wraps the real classifier so each classification of the account is counted, never replaced. The
// workflow reaches it through the diagnosed entry, and so would a stage that reproduced the analysis.
vi.mock('./advisor/inventory-advisor-classifier', async (importOriginal) => {
	const original = await importOriginal<typeof import('./advisor/inventory-advisor-classifier')>();
	return { ...original, classifyInventoryAdvisorDiagnosed: vi.fn(original.classifyInventoryAdvisorDiagnosed) };
});

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { classifyInventoryAdvisorDiagnosed, sha256InventoryKnowledgePack } from './advisor/inventory-advisor-classifier';
import { InventoryAdvisorWorkflow, type InventoryAdvisorRules } from './advisor/inventory-advisor-workflow';
import { InventoryPreferencesRuntime, type InventoryPreferencesEditorSession } from './advisor/inventory-preferences-runtime';
import { InventoryPreferencesService } from './advisor/inventory-preferences-service';
import type {
	InventoryPreferenceScope, InventoryPreferencesReadResult, InventoryPreferencesStore,
	InventoryPreferencesV1, InventoryPreferencesWriteResult,
} from './advisor/inventory-preferences-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './advisor/inventory-advisor-contract';
import type { InventoryAdvisorEvidenceV1 } from './advisor/inventory-advisor-evidence-model';
import type { AccountSignalsV1, InventoryPriceSnapshotV1, KeepExceptionV1 } from './advisor/inventory-advisor-model';
import type { InventoryKnowledgePackV1 } from './advisor/inventory-advisor-classifier-model';
import type { ReservationGoal } from './economy/reservation-model';
import { InventoryAdvisorPresentationController } from './ui/inventory-advisor-controller';
import { InventoryAdvisorItemView } from './ui/inventory-advisor-item-view';
import type { InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';
import type { StorageSnapshot } from './account/storage-snapshot-model';
import { PINNED_SCHEMA } from './account/storage-snapshot-model';
import type { CatalogResolution } from './catalog/public-catalog-model';

const NOW = '2026-08-14T12:00:00.000Z';
const SCOPE = { vaultId: 'vault-hash', accountId: 'account-1' };
const ITEMS = [{ id: 10, name: 'Trofeo' }, { id: 11, name: 'Baratija' }];

let activeDocument: FakeDocument;
let randomUuid: MockInstance<typeof crypto.randomUUID>;

beforeEach(() => {
	// The view names each new goal and exception with a random UUID, and the stored record orders
	// them by that id. Ids that grow with each call keep every run on the same order; every test
	// here keeps item 10 before item 11, the order the classifier input accepts.
	let created = 0;
	randomUuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
		created += 1;
		return `00000000-0000-4000-8000-${String(created).padStart(12, '0')}`;
	});
	activeDocument = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, activeDocument));
	vi.stubGlobal('createDiv', () => new FakeElement('div', activeDocument));
	vi.stubGlobal('createSpan', () => new FakeElement('span', activeDocument));
});

afterEach(() => { randomUuid.mockRestore(); vi.unstubAllGlobals(); });

/**
 * The production path of a preference write: the real item view over the real editor-session
 * closure of the core (`createInventoryPreferencesEditorSession`), preferences runtime, workflow and
 * presentation controller. Only the account capture and the IndexedDB store are fakes, and
 * `classifyInventoryAdvisorDiagnosed` is the real classifier, counted.
 */
async function analysedAdvisor(alreadyStored: KeepExceptionV1[] = []) {
	const fixture = twoDiscardCandidatesFixture();
	const store = new MemoryPreferencesStore();
	// What an earlier session of the user left in the store, written through the same service.
	const earlier = new InventoryPreferencesService(store, () => NOW);
	for (const [generation, exception] of alreadyStored.entries()) await earlier.upsertKeepException(SCOPE, generation, exception);
	const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), SCOPE.vaultId);
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
	const views: InventoryAdvisorItemView[] = [];
	const harness = {
		runtimeReady: true, inventoryPreferences: runtime, inventoryAdvisor: controller,
		renderInventoryAdvisorViews: () => { for (const view of views) view.render(); },
		notifyRuntimeStarting: () => undefined,
	};
	await controller.refresh();
	const classifications = vi.mocked(classifyInventoryAdvisorDiagnosed);
	classifications.mockClear();
	const newSession = (): InventoryPreferencesEditorSession =>
		TyrianCompanionCore.prototype.createInventoryPreferencesEditorSession.call(harness as never);
	/** One leaf of the Inventory tab, with its own editor session, as the host mounts it. */
	const openView = async (): Promise<{ view: InventoryAdvisorItemView; root: FakeElement }> => {
		const view = new InventoryAdvisorItemView(new FakeElement('div', activeDocument) as unknown as HTMLElement,
			{ setIcon: () => undefined }, {
				getInventoryAdvisorLocale: () => 'es',
				getInventoryAdvisorViewModel: () => controller.open(),
				createInventoryPreferencesEditorSession: newSession,
			});
		views.push(view);
		await view.onOpen();
		return { view, root: view.contentEl as unknown as FakeElement };
	};
	/** A second window on the same vault and account: its own runtime over the same store. */
	const otherWindow = async (): Promise<InventoryPreferencesRuntime> => {
		const other = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), SCOPE.vaultId);
		await other.load({ status: 'complete', evidence: fixture.evidence });
		return other;
	};
	/** What the store holds, read from the store itself and never from an editor state. */
	const stored = async (): Promise<{ goalTitles: string[]; keeps: number[] }> => {
		const read = await store.read(SCOPE);
		if (read.status !== 'ok') throw new Error(`store read failed: ${read.code}`);
		return {
			goalTitles: (read.record?.goals ?? []).map((entry) => entry.title).sort(),
			keeps: (read.record?.keepExceptions ?? []).map((entry) => entry.itemId).sort(),
		};
	};
	/** The stored exceptions in the order the record keeps them, which is the order the workflow receives. */
	const storedKeepOrder = async (): Promise<Array<[number, string]>> => {
		const read = await store.read(SCOPE);
		if (read.status !== 'ok') throw new Error(`store read failed: ${read.code}`);
		return (read.record?.keepExceptions ?? []).map((entry) => [entry.itemId, entry.exceptionId]);
	};
	return { store, runtime, controller, classifications, newSession, openView, otherWindow, stored, storedKeepOrder };
}

/**
 * Waits for the view's preference action to finish, read where the user's screen reader does: the
 * editor's `aria-busy`. The classifier hashes asynchronously, so counting ticks would be a guess.
 */
async function settle(root: FakeElement): Promise<void> {
	await vi.waitFor(() => {
		const [editor] = walk(root).filter((element) => element.className === 'tyrian-inventory-advisor__preferences');
		expect(editor?.attributes.get('aria-busy')).toBe('false');
	}, { timeout: 5_000, interval: 5 });
}

async function click(root: FakeElement, ariaLabelOrText: string): Promise<void> {
	const matches = find(root, 'button').filter((button) =>
		button.attributes.get('aria-label') === ariaLabelOrText || button.textContent === ariaLabelOrText);
	if (matches.length !== 1) throw new Error(`Expected one button «${ariaLabelOrText}», found ${String(matches.length)}.`);
	matches[0]!.dispatch('click');
	await settle(root);
}

/** The `disabled` of the two forms' submit buttons, goal first: what stops a real user from saving. */
function submitDisabled(root: FakeElement): boolean[] {
	const { goal: goalForm, exception } = forms(root);
	return [goalForm, exception].map((form) => find(form, 'button').find((button) => button.type === 'submit')!.disabled);
}

function forms(root: FakeElement): { goal: FakeElement; exception: FakeElement } {
	const [goal, exception] = walk(root).filter((element) => element.className === 'tyrian-inventory-advisor__preference-form');
	if (goal === undefined || exception === undefined) throw new Error('Expected both preference forms.');
	return { goal, exception };
}

/** Types a goal into the editor's form and submits it, as the user does. */
async function submitGoal(root: FakeElement, title: string, itemId: number): Promise<void> {
	const { goal } = forms(root);
	const inputs = find(goal, 'input');
	inputs[0]!.value = title; inputs[1]!.value = String(itemId); inputs[2]!.value = '1'; inputs[3]!.value = '1';
	goal.dispatch('submit');
	await settle(root);
}

/** Submits the editor's keep-exception form for one item, whole stack. */
async function submitException(root: FakeElement, itemId: number): Promise<void> {
	const { exception } = forms(root);
	find(exception, 'input')[0]!.value = String(itemId);
	find(exception, 'select').at(-1)!.value = 'all';
	exception.dispatch('submit');
	await settle(root);
}

function preferencesStatus(root: FakeElement): string {
	const [status] = walk(root).filter((element) => element.className === 'tyrian-inventory-advisor__preferences-status');
	return status?.textContent ?? '';
}

function keepStatus(root: FakeElement): string {
	const [status] = walk(root).filter((element) => element.className === 'tyrian-inventory-advisor__keep-status');
	return status === undefined || status.hidden ? '' : status.textContent ?? '';
}

const READY = 'Preferencias locales cargadas para esta cuenta.';
const NOT_SAVED = 'No se guardó el cambio.';

describe('inventory preferences: a write of the user is either in the store or visibly refused', () => {
	it('two goals saved in a row from the open editor are both in the store', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await submitGoal(root, 'Uno', 10);
		// The editor stays usable after its own write: no reload click between the two saves.
		expect(preferencesStatus(root)).toBe(READY);
		expect(submitDisabled(root)).toEqual([false, false]);
		await submitGoal(root, 'Dos', 11);
		expect((await env.stored()).goalTitles).toEqual(['Dos', 'Uno']);
		expect(preferencesStatus(root)).toBe(READY);
	});

	it('a goal and then a keep exception from the open editor are both in the store', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await submitGoal(root, 'Uno', 10);
		await submitException(root, 11);
		expect(await env.stored()).toEqual({ goalTitles: ['Uno'], keeps: [11] });
		expect(preferencesStatus(root)).toBe(READY);
	});

	it('"Conservar" on a second row after a first one saves it and says so', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Conservar Trofeo');
		expect(keepStatus(root)).toBe('Guardado: «Trofeo» se conserva entero. Está en «Objetos para conservar».');
		await click(root, 'Conservar Baratija');
		expect((await env.stored()).keeps).toEqual([10, 11]);
		expect(keepStatus(root)).toBe('Guardado: «Baratija» se conserva entero. Está en «Objetos para conservar».');
	});

	it('"Conservar" while the same view has its editor loaded saves it and the editor lists it', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await click(root, 'Conservar Trofeo');
		expect((await env.stored()).keeps).toEqual([10]);
		expect(keepStatus(root)).toBe('Guardado: «Trofeo» se conserva entero. Está en «Objetos para conservar».');
		expect(preferencesStatus(root)).toBe(READY);
		expect(find(root, 'button').map((button) => button.attributes.get('aria-label'))).toContain('Editar excepción del objeto 10');
	});

	it('another leaf wrote in between: the write is applied on top of its revision, never over it', async () => {
		const env = await analysedAdvisor();
		const left = await env.openView();
		const right = await env.openView();
		await click(left.root, 'Cargar preferencias locales');
		await click(right.root, 'Conservar Baratija');
		// The leaf that did not write is still expired: only the writing session is reloaded.
		expect(preferencesStatus(left.root)).toBe('Actualiza el inventario antes de editar preferencias.');
		// The fake DOM dispatches a disabled form: this is the submit that races the repaint.
		await submitGoal(left.root, 'Uno', 10);
		expect(await env.stored()).toEqual({ goalTitles: ['Uno'], keeps: [11] });
		expect(preferencesStatus(left.root)).toBe(READY);
	});

	it('another window wrote in between: the editor refuses, says so, and the store keeps the other write', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await (await env.otherWindow()).upsertKeepException(keep(11));
		await submitGoal(root, 'Uno', 10);
		expect(await env.stored()).toEqual({ goalTitles: [], keeps: [11] });
		expect(preferencesStatus(root)).toBe(`${NOT_SAVED} Otra ventana cambió las preferencias. Tu borrador se conserva; recarga para revisar.`);
	});

	it('another window wrote in between: "Conservar" refuses, says so, and the store keeps the other write', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await (await env.otherWindow()).upsertGoal(goal('ajeno', 11));
		await click(root, 'Conservar Trofeo');
		expect(await env.stored()).toEqual({ goalTitles: ['ajeno'], keeps: [] });
		expect(keepStatus(root)).toBe('No se pudo guardar «Trofeo» para conservar. Revisa «Preferencias de inventario».');
	});

	it('a write the reload cannot rescue (the account was invalidated) is refused and says it was not saved', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		env.runtime.invalidate();
		await submitGoal(root, 'Uno', 10);
		expect(await env.stored()).toEqual({ goalTitles: [], keeps: [] });
		expect(preferencesStatus(root)).toBe(`${NOT_SAVED} Actualiza el inventario antes de editar preferencias.`);
	});

	it('with the store unavailable the editor says the change was not saved and nothing is written', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await submitGoal(root, 'Uno', 10);
		env.store.unavailable = true;
		await submitGoal(root, 'Dos', 11);
		expect(preferencesStatus(root)).toBe(`${NOT_SAVED} Las preferencias locales no son seguras de usar. Corrige el almacenamiento antes de editar.`);
		env.store.unavailable = false;
		expect((await env.stored()).goalTitles).toEqual(['Uno']);
	});

	// 7 Oct 2026: after the engine stopped answering, the sale tab kept the "preferences unavailable"
	// block until the plugin was restarted, although the preferences could be read again.
	it('once the store answers again, loading the preferences lifts the block the failure left on the advisor', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await submitGoal(root, 'Uno', 10);
		env.store.unavailable = true;
		await submitGoal(root, 'Dos', 11);
		expect(env.controller.current()).toMatchObject({ status: 'blocked', blockedReason: 'preferences_unavailable' });

		env.store.unavailable = false;
		await click(root, 'Cargar preferencias locales');
		expect(preferencesStatus(root)).toBe(READY);
		// The block is gone; what is left is the honest one, that the capture it dropped must be redone.
		expect(env.controller.blockedOnPreferences()).toBe(false);
		expect(env.controller.current()).toMatchObject({ status: 'blocked', blockedReason: 'stale_evidence' });
		await env.controller.refresh();
		expect(env.controller.current().status).toBe('ready');
		expect(env.controller.current().blockedReason).toBeUndefined();
	});

	it('with the store unavailable "Conservar" says it could not save and nothing is written', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		env.store.unavailable = true;
		await click(root, 'Conservar Trofeo');
		expect(keepStatus(root)).toBe('No se pudo guardar «Trofeo» para conservar. Revisa «Preferencias de inventario».');
		env.store.unavailable = false;
		expect((await env.stored()).keeps).toEqual([]);
	});

	it('a saved write clears the "not saved" notice of an earlier refused one', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await (await env.otherWindow()).upsertKeepException(keep(11));
		await submitGoal(root, 'Uno', 10);
		expect(preferencesStatus(root)).toContain(NOT_SAVED);
		await click(root, 'Cargar preferencias locales');
		expect(preferencesStatus(root)).toBe(READY);
		await submitGoal(root, 'Uno', 10);
		expect(await env.stored()).toEqual({ goalTitles: ['Uno'], keeps: [11] });
		expect(preferencesStatus(root)).toBe(READY);
	});
});

describe('inventory preferences: keep exceptions whose ids order the items backwards still classify', () => {
	/** The advisor's rows as the view model has them, to tell a ready analysis from a failed one. */
	function analysis(model: InventoryAdvisorViewModel): { status: string; rows: string[] } {
		return { status: model.status, rows: model.groups.flatMap((group) => group.rows.map((row) => `${row.name}:${row.action}`)).sort() };
	}
	const BOTH_KEPT = { status: 'ready', rows: ['Baratija:keep', 'Trofeo:keep'] };

	it('"Conservar" item 11 and then item 10 leaves the analysis ready, and so does the next one', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		// The ids grow with each call, so the stored order by id is item 11, then item 10.
		await click(root, 'Conservar Baratija');
		await click(root, 'Conservar Trofeo');
		expect(await env.storedKeepOrder()).toEqual([[11, '00000000-0000-4000-8000-000000000001'], [10, '00000000-0000-4000-8000-000000000002']]);
		expect(analysis(env.controller.open())).toEqual(BOTH_KEPT);
		expect(analysis(await env.controller.refresh())).toEqual(BOTH_KEPT);
	});

	it('a store already holding the exceptions in that order analyses without a migration', async () => {
		const env = await analysedAdvisor([keep(11, 'a'), keep(10, 'b')]);
		expect(await env.storedKeepOrder()).toEqual([[11, 'a'], [10, 'b']]);
		expect(analysis(env.controller.open())).toEqual(BOTH_KEPT);
		// The stored record is read, never rewritten: same order, same generation.
		expect((await env.store.read(SCOPE))).toMatchObject({ status: 'ok', record: { generation: 2 } });
	});

	it('two goals whose ids order the items backwards classify too: goals carry no order of their own', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		await submitGoal(root, 'Primero', 11);
		await submitGoal(root, 'Segundo', 10);
		expect((await env.stored()).goalTitles).toEqual(['Primero', 'Segundo']);
		expect(env.controller.open().status).toBe('ready');
		expect((await env.controller.refresh()).status).toBe('ready');
	});
});

describe('inventory preferences: the account is classified once per write, never for a reload', () => {
	it('three writes from one view (a goal, a keep exception and a "Conservar") classify three times', async () => {
		const env = await analysedAdvisor();
		const { root } = await env.openView();
		await click(root, 'Cargar preferencias locales');
		expect(env.classifications).toHaveBeenCalledTimes(0);
		// Both editor writes are about item 10, so item 11's row still offers "Conservar".
		await submitGoal(root, 'Uno', 10);
		expect(env.classifications).toHaveBeenCalledTimes(1);
		await submitException(root, 10);
		expect(env.classifications).toHaveBeenCalledTimes(2);
		await click(root, 'Conservar Baratija');
		expect(env.classifications).toHaveBeenCalledTimes(3);
		expect(await env.stored()).toEqual({ goalTitles: ['Uno'], keeps: [10, 11] });
	});

	it('the session that wrote is ready again after its own reclassification, another leaf\'s is not', async () => {
		const env = await analysedAdvisor();
		const writer = env.newSession();
		const bystander = env.newSession();
		await writer.load();
		await bystander.load();
		const state = await writer.upsertKeepException(keep(10));
		expect(state).toMatchObject({ status: 'ready', keepExceptions: [{ itemId: 10 }] });
		expect(writer.current()).toMatchObject({ status: 'ready', keepExceptions: [{ itemId: 10 }] });
		expect(env.classifications).toHaveBeenCalledTimes(1);
		// The bystander never saw generation 1: it must reload before it may write.
		expect(bystander.current().status).toBe('needs_refresh');
		expect((await bystander.upsertGoal(goal('tardio', 11))).status).toBe('needs_refresh');
		expect(await env.stored()).toEqual({ goalTitles: [], keeps: [10] });
		expect(env.classifications).toHaveBeenCalledTimes(1);
	});

	it('a load that finds a revision written by another window classifies once and leaves the session ready', async () => {
		const env = await analysedAdvisor();
		await (await env.otherWindow()).upsertKeepException(keep(11));
		const session = env.newSession();
		expect((await session.load()).status).toBe('ready');
		expect(session.current()).toMatchObject({ status: 'ready', keepExceptions: [{ itemId: 11 }] });
		expect(env.classifications).toHaveBeenCalledTimes(1);
	});
});

function keep(itemId: number, exceptionId = `keep-${String(itemId)}`): KeepExceptionV1 {
	return { version: 1, exceptionId, itemId, status: 'active', basis: 'available', quantity: { mode: 'all' }, reason: 'user_keep' };
}

function goal(goalId: string, itemId: number): ReservationGoal {
	return { schemaVersion: 1, goalId, title: goalId, status: 'active', priority: 1, reason: 'personal',
		requirements: [{ key: `item:${String(itemId)}`, namespace: 'item', id: itemId, targetQuantity: 1, creditedQuantity: 0, basis: 'available', intendedUse: 'hold' }] };
}

class MemoryPreferencesStore implements InventoryPreferencesStore {
	/** When set, reads and writes answer as the IndexedDB adapter does once its database stops opening. */
	unavailable = false;
	private readonly records = new Map<string, InventoryPreferencesV1>();
	async read(scope: InventoryPreferenceScope): Promise<InventoryPreferencesReadResult> {
		if (this.unavailable) return { status: 'error', code: 'unavailable' };
		return { status: 'ok', record: structuredClone(this.records.get(key(scope)) ?? null) };
	}
	async compareAndSwap(scope: InventoryPreferenceScope, expected: number, next: InventoryPreferencesV1): Promise<InventoryPreferencesWriteResult> {
		if (this.unavailable) return { status: 'error', code: 'unavailable' };
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

/** A two-item account, both curated discard candidates, so two rows offer "Conservar". */
function twoDiscardCandidatesFixture(): { evidence: InventoryAdvisorEvidenceV1; rules: InventoryAdvisorRules } {
	const ids = ITEMS.map((item) => item.id);
	const byId = <T>(value: (item: { id: number; name: string }) => T): Record<string, T> =>
		Object.fromEntries(ITEMS.map((item) => [String(item.id), value(item)]));
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: SCOPE.accountId, startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: ITEMS.map((item, slot) => ({ kind: 'item' as const, itemId: item.id, quantity: 2, state: 'loose' as const, location: { source: 'bank' as const, slot }, metadata: {} })),
		currencies: [], availableByItem: byId(() => 2), ownedByItem: byId(() => 2), currencyById: {}, roster: [],
		coverage: completeSnapshotCoverage(), passCoverages: [completeSnapshotCoverage(), completeSnapshotCoverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: ids.map((itemId) => ({ ruleId: `discard-${String(itemId)}`, itemId, action: 'discard_candidate' as const, status: 'approved' as const,
			assertion: 'applicable' as const, reason: 'curated_discard_review' as const, sourceIds: ['rule-source'] })),
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledgePack: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'knowledge-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: ids.map((itemId) => ({ itemId, use: notApplicable('use-none'), open: notApplicable('open-none'), salvage: notApplicable('salvage-none') })),
	};
	knowledgePack.sha256 = sha256InventoryKnowledgePack(knowledgePack);
	const catalog: CatalogResolution = {
		snapshotId: 'snapshot-1', locale: 'es' as const, schemaVersion: PINNED_SCHEMA, resolvedAt: NOW,
		items: byId((item) => ({ kind: 'item' as const, id: item.id, name: item.name, type: 'Trophy', rarity: 'Basic', level: 0,
			vendorValue: 0, flags: ['AccountBound', 'NoSell', 'NoSalvage'], gameTypes: [], restrictions: [] })),
		currencies: {}, materials: {}, warnings: [],
		coverage: { items: byId(() => ({ status: 'resolved' as const, source: 'network' as const })), currencies: {}, materials: {} },
	};
	const prices: InventoryPriceSnapshotV1 = {
		version: 1 as const, accountId: SCOPE.accountId, snapshotId: 'snapshot-1', capturedAt: NOW,
		source: 'gw2-commerce-prices' as const, schemaVersion: PINNED_SCHEMA, requestedItemIds: ids, status: 'complete' as const,
		items: ids.map((itemId) => ({ itemId, whitelisted: false, bid: null, ask: null })), missingItemIds: [],
	};
	const accountSignals: AccountSignalsV1 = {
		version: 1 as const, source: 'gw2-account-api' as const, accountId: SCOPE.accountId,
		capturedAt: NOW, schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full' as const,
		endpointCoverage: { account: completeEndpoint(), recipes: completeEndpoint(), skins: completeEndpoint(), minis: completeEndpoint(), achievements: completeEndpoint() },
		unlockCoverage: 'complete' as const, unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
		achievementCoverage: 'complete' as const, completedAchievementBits: {}, achievementProgress: [],
	};
	const evidence: InventoryAdvisorEvidenceV1 = {
		version: 1, scope: 'supported_storage_v1', accountId: SCOPE.accountId, snapshotId: 'snapshot-1', schemaVersion: PINNED_SCHEMA,
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

function find(root: FakeElement, tag: string): FakeElement[] {
	return walk(root).filter((element) => element.tag === tag);
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

type FakeListener = (event: { preventDefault(): void }) => void;

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, FakeListener[]>();
	className = '';
	id = '';
	scope = '';
	colSpan = 1;
	textContent: string | null = null;
	type = '';
	value = '';
	max = 0;
	placeholder = '';
	disabled = false;
	open = false;
	required = false;
	selected = false;
	checked = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	prepend(...children: FakeElement[]): void { this.children.unshift(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: FakeListener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} }); }
	focus(): void { this.ownerDocument.activeElement = this; }
	contains(other: FakeElement): boolean { return walk(this).includes(other); }
}
