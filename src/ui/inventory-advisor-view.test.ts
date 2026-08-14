import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import {
	createInventoryAdvisorFixturePort,
	filterInventoryAdvisorRows,
	groupInventoryAdvisorRows,
	inventoryAdvisorViewLayout,
	renderInventoryAdvisorView,
	renderInventoryAdvisorViewFromPort,
	type InventoryAdvisorViewAction,
	type InventoryAdvisorViewCoverage,
	type InventoryAdvisorViewCoverageState,
	type InventoryAdvisorViewModel,
	type InventoryAdvisorViewRow,
} from './inventory-advisor-view';

afterEach(() => vi.unstubAllGlobals());

describe('Inventory Advisor view', () => {
	it.each([[479, 'cards'], [480, 'compact-table'], [759, 'compact-table'], [760, 'table']] as const)(
		'selects the semantic H5.11 layout at %ipx',
		(width, expected) => expect(inventoryAdvisorViewLayout(width)).toBe(expected),
	);

	it('filters by item text or id and groups the local rows without mutating the frozen model', () => {
		const model = deepFreeze(readyModel());
		const before = structuredClone(model);
		const rows = model.groups.flatMap((group) => group.rows);
		expect(filterInventoryAdvisorRows(rows, { query: 'mat', action: 'all', groupBy: 'action' }).map((row) => row.itemId)).toEqual([100]);
		expect(filterInventoryAdvisorRows(rows, { query: '200', action: 'all', groupBy: 'action' }).map((row) => row.itemId)).toEqual([200]);
		expect(groupInventoryAdvisorRows(rows, 'evidence').map((group) => group.key)).toEqual(['complete', 'limited']);
		expect(model).toEqual(before);
	});

	it('keeps controls, focus, and the live region stable through consecutive search and select events', () => {
		const mount = render(readyModel());
		const search = only(find(mount.elements(), 'input'));
		const [action, group] = find(mount.elements(), 'select');
		if (!action || !group) throw new Error('Expected Inventory Advisor filter controls.');
		const state = only(byClass(mount.elements(), 'tyrian-inventory-advisor__state'));
		const results = only(byClass(mount.elements(), 'tyrian-inventory-advisor__results'));
		search.focus();
		search.value = 'does-not-exist';
		search.dispatch('input');
		expect(mount.document.activeElement).toBe(search);
		expect(only(find(mount.elements(), 'input'))).toBe(search);
		expect(only(byClass(mount.elements(), 'tyrian-inventory-advisor__state'))).toBe(state);
		expect(only(byClass(mount.elements(), 'tyrian-inventory-advisor__results'))).toBe(results);
		expect(state.textContent).toBe('Ningún objeto coincide con los filtros actuales.');
		expect(withText(mount.elements(), 'Ningún objeto coincide con los filtros actuales.')).toEqual([state]);
		search.value = 'material';
		search.dispatch('input');
		action.focus();
		action.value = 'sell';
		action.dispatch('change');
		expect(mount.document.activeElement).toBe(action);
		expect(action.value).toBe('sell');
		group.focus();
		group.value = 'evidence';
		group.dispatch('change');
		expect(mount.document.activeElement).toBe(group);
		expect(search.value).toBe('material');
		expect(group.value).toBe('evidence');
		expect(state.textContent).toBe('Recomendaciones preparadas para revisión manual.');
		expect(text(mount.elements())).toContain('Completa');
		expect(text(mount.elements())).not.toContain('Resto sin valor');
	});

	it('keeps discard candidates out of the filter while rendering an explicit review-only warning if wired', () => {
		const mount = render(readyModel());
		const action = find(mount.elements(), 'select')[0];
		if (!action) throw new Error('Expected an action filter.');
		expect(action.children.map((option) => option.value)).not.toContain('discard_candidate');
		expect(text(mount.elements())).toContain('⚠ Revisión irreversible');
		expect(find(mount.elements(), 'th').filter((element) => element.scope === 'rowgroup')
		.map((element) => element.textContent)).toContain('⚠ Revisión irreversible');
		expect(find(mount.elements(), 'h3').map((element) => element.textContent)).toContain('⚠ Revisión irreversible');
		expect(find(mount.elements(), 'button')).toEqual([]);
		expect(find(mount.elements(), 'dialog')).toEqual([]);
	});

	it('renders semantic tables, cards, and long content without raw action or coverage enums in Spanish and English', () => {
		for (const locale of ['es', 'en'] as const) {
			const mount = render(allStatesAndActionsModel(), locale);
			const allText = text(mount.elements());
			expect(find(mount.elements(), 'caption')).toHaveLength(1);
			expect(find(mount.elements(), 'th').some((element) => element.scope === 'col')).toBe(true);
			expect(find(mount.elements(), 'th').some((element) => element.scope === 'row')).toBe(true);
			expect(find(mount.elements(), 'article')).toHaveLength(8);
			expect(find(mount.elements(), 'dl')).toHaveLength(8);
			expect(allText).toContain('x'.repeat(320));
			expect(allText).not.toContain('discard_candidate');
			for (const action of ['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review'] as const) {
				expect(allText).toContain(createTranslator(locale).t(`advisor.view.action.${action}`));
			}
			for (const coverageLabel of ['complete', 'limited', 'review'] as const) {
				expect(allText).toContain(createTranslator(locale).t(`advisor.view.evidence.${coverageLabel}`));
			}
		}
	});

	it('renders every status with a persistent polite live region and alert semantics that do not create focus targets', () => {
		for (const status of ['empty', 'loading', 'ready', 'limited', 'blocked', 'invalid'] as const) {
			const mount = render({ ...readyModel(), status, groups: status === 'ready' || status === 'limited' ? readyModel().groups : [] });
			const state = only(byClass(mount.elements(), 'tyrian-inventory-advisor__state'));
			expect(state.attributes.get('aria-live')).toBe('polite');
			expect(mount.section.attributes.get('aria-busy')).toBe(String(status === 'loading'));
			if (status === 'blocked' || status === 'invalid') expect(state.attributes.get('role')).toBe('alert');
			else expect(state.attributes.has('role')).toBe(false);
			expect(mount.elements().every((element) => !element.attributes.has('tabindex'))).toBe(true);
		}
	});

	it('renders independent instances into disjoint nodes and reads a fixture port without changing it', () => {
		const model = deepFreeze(readyModel());
		const left = render(model, 'es');
		const right = render(model, 'en');
		const leftNodes = left.elements();
		const rightNodes = right.elements();
		expect(left.section).not.toBe(right.section);
		expect(left.container.children[0]).toBe(left.section);
		expect(right.container.children[0]).toBe(right.section);
		expect(leftNodes).toHaveLength(rightNodes.length);
		for (const node of leftNodes) expect(rightNodes).not.toContain(node);
		const ids = [...leftNodes, ...rightNodes].map((node) => node.id).filter((id) => id.length > 0);
		expect(ids).toEqual([]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(left.section.attributes.get('aria-label')).toBe('Asesor de inventario');
		expect(right.section.attributes.get('aria-label')).toBe('Inventory advisor');
		const portMount = createMount();
		renderInventoryAdvisorViewFromPort(portMount.container as unknown as HTMLElement, createInventoryAdvisorFixturePort(model), createTranslator('en'));
		expect(portMount.container.children[0]?.attributes.get('aria-label')).toBe('Inventory advisor');
	});
});

function render(model: InventoryAdvisorViewModel, locale: 'es' | 'en' = 'es') {
	const mount = createMount();
	renderInventoryAdvisorView(mount.container as unknown as HTMLElement, model, createTranslator(locale));
	const section = mount.container.children[0];
	if (!section) throw new Error('Expected a rendered Inventory Advisor section.');
	return { ...mount, section, elements: () => walk(mount.container) };
}

function createMount(): { container: FakeElement; document: FakeDocument } {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, document));
	vi.stubGlobal('createDiv', () => new FakeElement('div', document));
	return { container: new FakeElement('div', document), document };
}

function readyModel(): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		groups: [{ key: 'initial', rows: [
			row({ itemId: 100, name: 'Material seguro', action: 'sell' }),
			row({ itemId: 200, name: 'Resto sin valor', action: 'discard_candidate', coverage: coverage('limited'), irreversibleReviewOnly: true }),
		] }],
	};
}

function allStatesAndActionsModel(): InventoryAdvisorViewModel {
	const actions: readonly InventoryAdvisorViewAction[] = ['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review'];
	return {
		status: 'limited', title: 'inventory_advisor.title', detail: 'inventory_advisor.limited',
		groups: [{ key: 'initial', rows: actions.map((action, index) => row({
			itemId: index + 1,
			name: index === 0 ? `Objeto extenso ${'x'.repeat(320)}` : `Objeto ${String(index + 1)}`,
			action,
			coverage: coverage(index % 3 === 0 ? 'complete' : index % 3 === 1 ? 'limited' : 'unknown'),
		})) }],
	};
}

function row(overrides: Partial<InventoryAdvisorViewRow>): InventoryAdvisorViewRow {
	return {
		itemId: 1, name: 'Object', ownedQuantity: 5, availableQuantity: 3,
		action: 'review', coverage: coverage('complete'), irreversibleReviewOnly: false,
		...overrides,
	};
}

function coverage(state: InventoryAdvisorViewCoverageState): InventoryAdvisorViewCoverage {
	return {
		snapshot: state, inventory: state, catalog: state, prices: state,
		reservations: state, accountSignals: state, rules: state,
	};
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function only<T>(items: readonly T[]): T {
	const item = items[0];
	if (items.length !== 1 || !item) throw new Error(`Expected one item, received ${String(items.length)}.`);
	return item;
}

function find(elements: readonly FakeElement[], tag: string): FakeElement[] {
	return elements.filter((element) => element.tag === tag);
}

function byClass(elements: readonly FakeElement[], className: string): FakeElement[] {
	return elements.filter((element) => element.className.split(' ').includes(className));
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function text(elements: readonly FakeElement[]): string {
	return elements.map((element) => element.textContent ?? '').join('\n');
}

function withText(elements: readonly FakeElement[], value: string): FakeElement[] {
	return elements.filter((element) => element.textContent === value);
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

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	focus(): void { this.ownerDocument.activeElement = this; }
}
