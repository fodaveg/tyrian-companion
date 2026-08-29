import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InventoryVaultSyncLastRun } from '../core/settings';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './inventory-advisor-view-model';
import type { InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';
import { ambientCapabilityUse } from '../test/ambient-capabilities';
import { InventoryAdvisorItemView, type InventoryAdvisorViewActions } from './inventory-advisor-item-view';

vi.mock('obsidian', () => ({
	ItemView: class {
		readonly contentEl = new FakeElement('div', activeDocument);
		constructor(_leaf: unknown) {}
	},
	setIcon: (el: { setAttribute(name: string, value: string): void }, iconId: string) => { el.setAttribute('data-icon', iconId); },
}));

let activeDocument: FakeDocument;

beforeEach(() => { activeDocument = new FakeDocument(); });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('InventoryAdvisorItemView instance behavior', () => {
	it('keeps query, action, group and focus per ItemView across model/locale renders and another instance render', async () => {
		installDom();
		let leftLocale: 'es' | 'en' = 'es';
		const leftActions = actions(() => leftLocale);
		const rightActions = actions(() => 'en');
		const left = new InventoryAdvisorItemView({} as never, leftActions.value);
		const right = new InventoryAdvisorItemView({} as never, rightActions.value);
		await left.onOpen();
		await right.onOpen();

		const [leftSearch] = find(left.contentEl as unknown as FakeElement, 'input');
		const [leftAction, leftGroup] = find(left.contentEl as unknown as FakeElement, 'select');
		if (!leftSearch || !leftAction || !leftGroup) throw new Error('Advisor controls were not mounted.');
		leftSearch.value = 'material';
		leftSearch.dispatch('input');
		leftAction.value = 'sell';
		leftAction.dispatch('change');
		leftGroup.value = 'evidence';
		leftGroup.dispatch('change');
		leftSearch.focus();

		right.render();
		leftLocale = 'en';
		left.render();

		const [updatedSearch] = find(left.contentEl as unknown as FakeElement, 'input');
		const [updatedAction, updatedGroup] = find(left.contentEl as unknown as FakeElement, 'select');
		expect(updatedSearch).toBe(leftSearch);
		expect(updatedAction).toBe(leftAction);
		expect(updatedGroup).toBe(leftGroup);
		expect([updatedSearch?.value, updatedAction?.value, updatedGroup?.value]).toEqual(['material', 'sell', 'evidence']);
		expect(activeDocument.activeElement).toBe(leftSearch);
		expect(text(left.contentEl as unknown as FakeElement)).toContain('Inventory advisor');
		expect(text(right.contentEl as unknown as FakeElement)).toContain('Inventory advisor');
	});

	it('opens without capturing or writing, and a single click on the one guided button runs the whole sync once', async () => {
		installDom();
		const run = vi.fn(async () => undefined);
		const viewActions = actions(() => 'es', { state: { status: 'idle', lastRun: null }, run });
		const view = new InventoryAdvisorItemView({} as never, viewActions.value);
		await view.onOpen();
		expect(run).not.toHaveBeenCalled();
		const button = find(view.contentEl as unknown as FakeElement, 'button')
			.find((candidate) => walk(candidate).some((element) => element.textContent === 'Sincronizar inventario'));
		if (!button) throw new Error('The single sync button was not mounted.');
		button.dispatch('click');
		await Promise.resolve();
		await Promise.resolve();
		expect(run).toHaveBeenCalledOnce();
	});

	it('keeps analysis busy over a retained ready model and prevents overlapping analysis or sync', async () => {
		installDom();
		let finishAnalysis!: () => void;
		const pending = new Promise<void>((resolve) => { finishAnalysis = resolve; });
		const analyze = vi.fn(() => pending);
		const run = vi.fn(async () => undefined);
		const viewActions = actions(() => 'es', { state: { status: 'idle', lastRun: null }, analyze, run });
		const view = new InventoryAdvisorItemView({} as never, viewActions.value);
		await view.onOpen();
		const analysisButton = find(view.contentEl as unknown as FakeElement, 'button')
			.find((candidate) => candidate.textContent === 'Analizar sin escribir');
		const syncButton = find(view.contentEl as unknown as FakeElement, 'button')
			.find((candidate) => walk(candidate).some((element) => element.textContent === 'Sincronizar inventario'));
		if (!analysisButton || !syncButton) throw new Error('The inventory action buttons were not mounted.');
		analysisButton.dispatch('click');
		expect(analyze).toHaveBeenCalledOnce();
		expect(analysisButton.textContent).toBe('Analizando…');
		expect(analysisButton.disabled).toBe(true);
		expect(syncButton.disabled).toBe(true);

		// The fake DOM deliberately dispatches disabled controls, so these calls prove
		// the ItemView guard itself prevents overlap instead of trusting the browser.
		analysisButton.dispatch('click');
		syncButton.dispatch('click');
		await Promise.resolve();
		expect(analyze).toHaveBeenCalledOnce();
		expect(run).not.toHaveBeenCalled();

		finishAnalysis();
		await Promise.resolve();
		await Promise.resolve();
		expect(analysisButton.textContent).toBe('Analizar sin escribir');
		expect(analysisButton.disabled).toBe(false);
		expect(syncButton.disabled).toBe(false);
	});

	it('forwards confirm and cancel only from their own buttons while a destructive plan awaits confirmation', async () => {
		installDom();
		const confirm = vi.fn(async () => undefined);
		const cancel = vi.fn();
		const summary = { positions: 3, create: 1, update: 1, unchanged: 1, deactivate: 1, conflicts: 0 };
		const viewActions = actions(() => 'es', { state: { status: 'confirm', summary }, confirm, cancel });
		const view = new InventoryAdvisorItemView({} as never, viewActions.value);
		await view.onOpen();
		const buttons = find(view.contentEl as unknown as FakeElement, 'button');
		const confirmButton = buttons.find((candidate) => candidate.textContent === 'Confirmar y escribir');
		const cancelButton = buttons.find((candidate) => candidate.textContent === 'Cancelar');
		if (!confirmButton || !cancelButton) throw new Error('Confirm/cancel buttons were not mounted.');
		confirmButton.dispatch('click');
		cancelButton.dispatch('click');
		await Promise.resolve();
		await Promise.resolve();
		expect(confirm).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('shows the persisted last run again after the view closes and reopens, without a view-local cache', async () => {
		installDom();
		const lastRun: InventoryVaultSyncLastRun = {
			status: 'success', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 86694,
			summary: { positions: 2909, create: 1616, update: 1167, unchanged: 79, deactivate: 0, conflicts: 0 }, error: null,
		};
		let queries = 0;
		const getState = vi.fn((): InventoryVaultSyncRunState => { queries += 1; return { status: 'idle', lastRun }; });
		const viewActions = actions(() => 'es', { getState });
		const view = new InventoryAdvisorItemView({} as never, viewActions.value);
		await view.onOpen();
		expect(text(view.contentEl as unknown as FakeElement)).toContain('Última ejecución: 2026-08-25T07:00:13.750Z');
		const queriesWhileOpen = queries;
		expect(queriesWhileOpen).toBeGreaterThan(0);

		await view.onClose();
		await view.onOpen();
		expect(text(view.contentEl as unknown as FakeElement)).toContain('Última ejecución: 2026-08-25T07:00:13.750Z');
		expect(queries).toBeGreaterThan(queriesWhileOpen);

		// A brand-new ItemView instance backed by the same actions shows the same saved run:
		// the outcome lives behind the action port, never in the closed view's own fields.
		const remounted = new InventoryAdvisorItemView({} as never, viewActions.value);
		await remounted.onOpen();
		expect(text(remounted.contentEl as unknown as FakeElement)).toContain('Última ejecución: 2026-08-25T07:00:13.750Z');
	});

	it('opens, renders and syncs without reaching for a timer, network, storage or plugin global', async () => {
		const rendered: string[] = [];
		const used = await ambientCapabilityUse(async () => {
			installDom();
			const run = vi.fn(async () => undefined);
			const viewActions = actions(() => 'es', { state: { status: 'idle', lastRun: null }, run });
			const view = new InventoryAdvisorItemView({} as never, viewActions.value);
			await view.onOpen();
			view.render();
			const button = find(view.contentEl as unknown as FakeElement, 'button')
				.find((candidate) => walk(candidate).some((element) => element.textContent === 'Sincronizar inventario'));
			if (!button) throw new Error('The single sync button was not mounted.');
			button.dispatch('click');
			await Promise.resolve();
			await Promise.resolve();
			rendered.push(String(run.mock.calls.length));
			rendered.push(text(view.contentEl as unknown as FakeElement).includes('Material') ? 'rows' : 'empty');
		});
		expect(used).toEqual([]);
		expect(rendered).toEqual(['1', 'rows']);
	});
});

function actions(
	locale: () => 'es' | 'en',
	sync?: {
		state?: InventoryVaultSyncRunState;
		getState?: () => InventoryVaultSyncRunState;
		run?: () => Promise<void>;
		confirm?: () => Promise<void>;
		cancel?: () => void;
		analyze?: () => Promise<void>;
	},
): { value: InventoryAdvisorViewActions } {
	const base: InventoryAdvisorViewActions = {
		getInventoryAdvisorLocale: locale,
		getInventoryAdvisorViewModel: readyModel,
		refreshInventoryAdvisor: sync?.analyze ?? (async () => undefined),
	};
	if (sync === undefined) return { value: base };
	return { value: {
		...base,
		getInventoryVaultSyncRunState: sync.getState ?? (() => sync.state ?? { status: 'idle', lastRun: null }),
		runInventoryVaultSync: sync.run ?? (async () => undefined),
		confirmInventoryVaultSync: sync.confirm ?? (async () => undefined),
		cancelInventoryVaultSync: sync.cancel ?? (() => undefined),
		hasManagedAssetsRoot: () => true,
	} };
}

function readyModel(): InventoryAdvisorViewModel {
	return { status: 'ready', title: 'advisor', detail: 'ready', groups: [{ key: 'market', rows: [row()] }] };
}

function row(): InventoryAdvisorViewRow {
	return {
		id: '#/explanations/10/0', itemId: 10, name: 'Material', icon: null, ownedQuantity: 2, availableQuantity: 2,
		action: 'sell', quantity: 2,
		allocations: [{ positionRef: '#/positions/10/0', quantity: 2, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } }],
		reasonCodes: ['rule_missing'], protectionReasons: [], value: { status: 'available', route: 'instant_sell', copper: 170 },
		marketComparison: null, burden: null,
		coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
		irreversibleReviewOnly: false, discardProof: null,
	};
}

function installDom(): void {
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, activeDocument));
	vi.stubGlobal('createDiv', () => new FakeElement('div', activeDocument));
	vi.stubGlobal('createSpan', () => new FakeElement('span', activeDocument));
}

function find(root: FakeElement, tag: string): FakeElement[] {
	return walk(root).filter((element) => element.tag === tag);
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function text(root: FakeElement): string {
	return walk(root).map((element) => element.textContent ?? '').join('\n');
}

class FakeDocument {
	activeElement: FakeElement | null = null;
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = '';
	id = '';
	scope = '';
	colSpan = 1;
	textContent: string | null = null;
	type = '';
	value = '';
	max = 0;
	placeholder = '';
	selected = false;
	disabled = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	focus(): void { this.ownerDocument.activeElement = this; }
}
