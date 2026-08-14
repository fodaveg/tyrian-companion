import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './inventory-advisor-view-model';
import { InventoryAdvisorItemView, type InventoryAdvisorViewActions } from './inventory-advisor-item-view';

vi.mock('obsidian', () => ({
	ItemView: class {
		readonly contentEl = new FakeElement('div', activeDocument);
		constructor(_leaf: unknown) {}
	},
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
		expect(leftActions.refresh).not.toHaveBeenCalled();
		expect(rightActions.refresh).not.toHaveBeenCalled();

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
		await left.refresh();

		const [updatedSearch] = find(left.contentEl as unknown as FakeElement, 'input');
		const [updatedAction, updatedGroup] = find(left.contentEl as unknown as FakeElement, 'select');
		expect(updatedSearch).toBe(leftSearch);
		expect(updatedAction).toBe(leftAction);
		expect(updatedGroup).toBe(leftGroup);
		expect([updatedSearch?.value, updatedAction?.value, updatedGroup?.value]).toEqual(['material', 'sell', 'evidence']);
		expect(activeDocument.activeElement).toBe(leftSearch);
		expect(leftActions.refresh).toHaveBeenCalledOnce();
		expect(text(left.contentEl as unknown as FakeElement)).toContain('Inventory advisor');
		expect(text(right.contentEl as unknown as FakeElement)).toContain('Inventory advisor');
	});

	it('opens without capture and invokes one explicit refresh for one button click', async () => {
		installDom();
		const viewActions = actions(() => 'es');
		const view = new InventoryAdvisorItemView({} as never, viewActions.value);
		await view.onOpen();
		expect(viewActions.refresh).not.toHaveBeenCalled();
		const refresh = find(view.contentEl as unknown as FakeElement, 'button')[0];
		if (!refresh) throw new Error('Refresh button was not mounted.');
		refresh.dispatch('click');
		await Promise.resolve();
		await Promise.resolve();
		expect(viewActions.refresh).toHaveBeenCalledOnce();
	});
});

function actions(locale: () => 'es' | 'en'): { value: InventoryAdvisorViewActions; refresh: ReturnType<typeof vi.fn> } {
	const refresh = vi.fn(async () => undefined);
	return { value: {
		getInventoryAdvisorLocale: locale,
		getInventoryAdvisorViewModel: readyModel,
		refreshInventoryAdvisor: refresh,
	}, refresh };
}

function readyModel(): InventoryAdvisorViewModel {
	return { status: 'ready', title: 'advisor', detail: 'ready', groups: [{ key: 'market', rows: [row()] }] };
}

function row(): InventoryAdvisorViewRow {
	return {
		id: '#/explanations/10/0', itemId: 10, name: 'Material', ownedQuantity: 2, availableQuantity: 2,
		action: 'sell', quantity: 2,
		allocations: [{ positionRef: '#/positions/10/0', quantity: 2, location: { source: 'bank', slot: 0 } }],
		reasonCodes: ['rule_missing'], value: { status: 'available', route: 'instant_sell', copper: 170 },
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
	placeholder = '';
	selected = false;
	disabled = false;

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
