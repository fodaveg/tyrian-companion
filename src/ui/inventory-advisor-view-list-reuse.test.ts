import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import {
	renderInventoryAdvisorView,
	type InventoryAdvisorViewAction,
	type InventoryAdvisorViewCoverageState,
	type InventoryAdvisorViewInteractions,
	type InventoryAdvisorViewModel,
	type InventoryAdvisorViewRow,
} from './inventory-advisor-view';
import { ambientCapabilityUse } from '../test/ambient-capabilities';

/**
 * Audit V2 (findings 3.3 and 3.4): the advisor list at account size. Three kinds of test live here.
 *
 * - Equivalence: the visible list (nodes, order, classes, attributes and text) for every filter and
 *   order the view offers, and for searches that narrow and widen again, pinned as hashes captured
 *   from the implementation that rebuilt everything on every key.
 * - Counts, never clocks: nodes created on mount, sorts and rows created per key, detail bodies
 *   mounted while closed.
 * - Accessibility of a list whose rows are kept and moved instead of rebuilt.
 */

const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };

/** The account size the audit measured: 1,371 objects. */
const ACCOUNT_SIZE = 1_371;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('Inventory Advisor list: equivalence of what is visible', () => {
	it('shows the same list for every combination of order, grouping, action, character and included stores', () => {
		const mount = render(fixtureModel(60));
		const controls = filterControls(mount);
		const hash = createHash('sha256');
		let combinations = 0;
		for (const character of ['all', 'Astra', 'Borja']) {
			for (const stores of range(32)) {
				for (const action of ['all', 'deposit_material', 'sell', 'list', 'vendor', 'salvage', 'use', 'open']) {
					for (const groupBy of ['none', 'action', 'evidence']) {
						for (const sort of ['value_desc', 'quantity_desc', 'name_asc']) {
							controls.character.value = character;
							controls.includes.forEach((input, index) => { input.checked = (stores & (1 << index)) !== 0; });
							controls.action.value = action;
							controls.group.value = groupBy;
							controls.sort.value = sort;
							controls.sort.dispatch('change');
							hash.update(visibleTree(mount.results));
							hash.update(`\n# ${mount.state.textContent ?? ''}\n`);
							combinations += 1;
						}
					}
				}
			}
		}
		expect(combinations).toBe(6_912);
		expect(hash.digest('hex')).toBe(PINNED.combinations);
	}, 60_000);

	it('shows the same list while a search narrows and widens again, in every order and grouping', () => {
		const mount = render(fixtureModel(400));
		const controls = filterControls(mount);
		const hash = createHash('sha256');
		const emptyQuery: string[] = [];
		for (const groupBy of ['none', 'action', 'evidence']) {
			for (const sort of ['value_desc', 'quantity_desc', 'name_asc']) {
				controls.group.value = groupBy;
				controls.sort.value = sort;
				controls.sort.dispatch('change');
				for (const query of ['é', 'éb', 'ébano', 'ébano 1', 'ébano', 'é', '', '10', '103', '1037', '103', '', 'no existe', ' SEDA ', '']) {
					controls.search.value = query;
					controls.search.dispatch('input');
					const tree = visibleTree(mount.results);
					if (query === '') emptyQuery.push(tree);
					hash.update(`${tree}\n# ${mount.state.textContent ?? ''}\n`);
				}
			}
		}
		// Widening back to an empty search gives the very list the search started from.
		for (let index = 0; index < emptyQuery.length; index += 3) {
			expect(emptyQuery[index + 1]).toBe(emptyQuery[index]);
			expect(emptyQuery[index + 2]).toBe(emptyQuery[index]);
		}
		expect(hash.digest('hex')).toBe(PINNED.searches);
	});

	it('shows the same detail of every row once it is opened, with the concentration of the rows visible then', () => {
		const mount = render(fixtureModel(60), 'es', keepInteractions([1_003]));
		const controls = filterControls(mount);
		const hash = createHash('sha256');
		for (const [query, groupBy, sort] of [
			['', 'none', 'value_desc'], ['seda', 'none', 'value_desc'], ['', 'action', 'name_asc'], ['1', 'evidence', 'quantity_desc'],
		] as const) {
			controls.group.value = groupBy;
			controls.sort.value = sort;
			controls.sort.dispatch('change');
			controls.search.value = query;
			controls.search.dispatch('input');
			openAll(mount.results);
			hash.update(fullTree(mount.results));
		}
		expect(hash.digest('hex')).toBe(PINNED.openDetails);
	});

	it('shows the same list after the data, the language, the keep state or the free space change', () => {
		const mount = render(fixtureModel(60));
		const hash = createHash('sha256');
		const repaint = (model: InventoryAdvisorViewModel, locale: 'es' | 'en', interactions: InventoryAdvisorViewInteractions): void => {
			renderInventoryAdvisorView(mount.container as unknown as HTMLElement, icons, model, createTranslator(locale), undefined, interactions);
			hash.update(visibleTree(mount.results));
			openAll(mount.results);
			hash.update(fullTree(mount.results));
		};
		repaint(fixtureModel(60), 'en', {});
		repaint(fixtureModel(45), 'es', keepInteractions([1_003, 1_010]));
		repaint(fixtureModel(45), 'es', { ...keepInteractions([1_010]), preferencesBusy: true });
		repaint({ ...fixtureModel(60), storageSpace: lowSpace() }, 'es', {});
		// The deliberate bag-only copy changes this pin, while retained-row equivalence remains.
		expect(visibleTree(mount.results)).toContain('en las bolsas del personaje seleccionado');
		expect(fullTree(mount.results)).not.toContain('entre bolsas y banco');
		repaint({ ...fixtureModel(60), status: 'loading' }, 'es', {});
		repaint(fixtureModel(60), 'es', {});
		expect(hash.digest('hex')).toBe(PINNED.repaints);
	});

	it('repaints the keep control of a kept row on the next key when the keep state changed under the same data', () => {
		const model = { ...fixtureModel(60), contentVersion: 1 };
		const mount = render(model, 'es', keepInteractions([]));
		const controls = filterControls(mount);
		const pressedAndDisabled = (): string[] => keepButtons(mount.results)
			.map((button) => `${button.attributes.get('aria-pressed') ?? ''}:${String(button.disabled)}`);
		expect(new Set(pressedAndDisabled())).toEqual(new Set(['false:false']));
		// Same content version: the list is not repainted for it, as a live sync tick is not.
		renderInventoryAdvisorView(
			mount.container as unknown as HTMLElement, icons, model, createTranslator('es'), undefined,
			{ ...keepInteractions([1_000]), preferencesBusy: true },
		);
		expect(new Set(pressedAndDisabled())).toEqual(new Set(['false:false']));
		controls.search.value = 'a';
		controls.search.dispatch('input');
		expect(new Set(pressedAndDisabled())).toEqual(new Set(['false:true', 'true:true']));
		expect(pressedAndDisabled().filter((state) => state === 'true:true')).toHaveLength(1);
	});

	it('filters the new data on the next key when an update brings other groups under the same content version', () => {
		const labels = (mount: Mount): Array<string | undefined> => listRows(mount.results).map((row) => row.attributes.get('aria-label'));
		const mount = render({ ...fixtureModel(60), contentVersion: 1 });
		renderInventoryAdvisorView(
			mount.container as unknown as HTMLElement, icons, { ...fixtureModel(45), contentVersion: 1 }, createTranslator('es'), undefined, {},
		);
		const controls = filterControls(mount);
		controls.search.value = 'seda';
		controls.search.dispatch('input');
		const expected = render({ ...fixtureModel(45), contentVersion: 1 });
		const expectedControls = filterControls(expected);
		expectedControls.search.value = 'seda';
		expectedControls.search.dispatch('input');
		expect(labels(mount)).toEqual(labels(expected));
		expect(labels(mount).length).toBeGreaterThan(0);
	});

	it('closes every open detail, and the folded group without value, when a filter or the data change', () => {
		const mount = render(fixtureModel(60));
		const controls = filterControls(mount);
		const anyOpen = (): boolean => find(mount.results, 'details').some((details) => details.open);
		openAll(mount.results);
		expect(anyOpen()).toBe(true);
		controls.search.value = 'seda';
		controls.search.dispatch('input');
		expect(anyOpen()).toBe(false);
		controls.search.value = '';
		controls.search.dispatch('input');
		expect(anyOpen()).toBe(false);
		openAll(mount.results);
		controls.sort.value = 'name_asc';
		controls.sort.dispatch('change');
		expect(anyOpen()).toBe(false);
		openAll(mount.results);
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, icons, fixtureModel(60), createTranslator('es'), undefined, {});
		expect(anyOpen()).toBe(false);
	});
});

describe('Inventory Advisor list: counts at account size', () => {
	it('mounts 1,371 rows without one detail body, in at most 14 nodes per row', () => {
		const mount = render(fixtureModel(ACCOUNT_SIZE));
		const rows = listRows(mount.results);
		expect(rows).toHaveLength(ACCOUNT_SIZE);
		expect({ detailBodies: find(mount.results, 'dl').length, nodes: mount.document.createdCount })
			.toEqual({ detailBodies: 0, nodes: PINNED.nodesOnMount });
		expect(PINNED.nodesOnMount).toBeLessThanOrEqual(ACCOUNT_SIZE * 14);
	});

	it('sorts nothing and compares no names on a key of the search', () => {
		const mount = render(fixtureModel(ACCOUNT_SIZE));
		const controls = filterControls(mount);
		const counted = countSorts();
		for (const query of ['s', 'se', 'sed', 'se', '']) {
			controls.search.value = query;
			controls.search.dispatch('input');
		}
		expect({ sortsOfTheList: counted.listSorts(), comparisons: counted.comparisons() }).toEqual({ sortsOfTheList: 0, comparisons: 0 });
	});

	it('sorts the list once per change of order, of scope or of data, and never for a grouping or an action', () => {
		const model = { ...fixtureModel(ACCOUNT_SIZE), contentVersion: 1 };
		const mount = render(model);
		const controls = filterControls(mount);
		const sortsDuring = (work: () => void): number => {
			const counted = countSorts();
			work();
			const sorts = counted.listSorts();
			vi.restoreAllMocks();
			return sorts;
		};
		expect({
			order: sortsDuring(() => { controls.sort.value = 'name_asc'; controls.sort.dispatch('change'); }),
			grouping: sortsDuring(() => { controls.group.value = 'action'; controls.group.dispatch('change'); }),
			action: sortsDuring(() => { controls.action.value = 'sell'; controls.action.dispatch('change'); }),
			scope: sortsDuring(() => { controls.includes[0]!.checked = false; controls.includes[0]!.dispatch('change'); }),
			data: sortsDuring(() => {
				renderInventoryAdvisorView(
					mount.container as unknown as HTMLElement, icons, { ...model, contentVersion: 2 }, createTranslator('es'), undefined, {},
				);
			}),
			sameData: sortsDuring(() => {
				renderInventoryAdvisorView(
					mount.container as unknown as HTMLElement, icons, { ...model, contentVersion: 2 }, createTranslator('es'), undefined, {},
				);
			}),
		}).toEqual({ order: 1, grouping: 0, action: 0, scope: 1, data: 1, sameData: 0 });
	});

	it('creates no row on a key of the search: the rows already mounted are kept and moved', () => {
		const mount = render(fixtureModel(ACCOUNT_SIZE));
		const controls = filterControls(mount);
		const mounted = new Set(listRows(mount.results));
		const perKey: Array<{ rows: number; rowsCreated: number; rowsKept: number; nodesCreated: number }> = [];
		for (const query of ['s', 'se', 'sed', 'seda 1', 'sed', '', '10', '']) {
			mount.document.recordCreated();
			controls.search.value = query;
			controls.search.dispatch('input');
			const created = mount.document.created;
			const rows = listRows(mount.results);
			perKey.push({
				rows: rows.length,
				rowsCreated: created.filter(isListRow).length,
				rowsKept: rows.filter((row) => mounted.has(row)).length,
				nodesCreated: created.length,
			});
		}
		// What a key still builds is the frame around the rows (scope line, summary, head, subtotals).
		expect(perKey).toEqual(PINNED.perKey.map(([rows, nodesCreated]) => ({ rows, rowsCreated: 0, rowsKept: rows, nodesCreated })));
		expect(Math.max(...PINNED.perKey.map(([, nodesCreated]) => nodesCreated))).toBeLessThanOrEqual(60);
		expect(sameElements(listRows(mount.results), [...mounted])).toBe(true);
	});

	it('keeps the rows when only the order or the grouping change', () => {
		const mount = render(fixtureModel(ACCOUNT_SIZE));
		const controls = filterControls(mount);
		const mounted = new Set(listRows(mount.results));
		mount.document.recordCreated();
		controls.sort.value = 'name_asc';
		controls.sort.dispatch('change');
		controls.group.value = 'evidence';
		controls.group.dispatch('change');
		expect(mount.document.created.filter(isListRow)).toHaveLength(0);
		const rows = listRows(mount.results);
		expect(rows).toHaveLength(mounted.size);
		expect(rows.every((row) => mounted.has(row))).toBe(true);
	});

	it('mounts a detail body on the first opening and unmounts it when it closes, one row at a time', () => {
		const mount = render(fixtureModel(ACCOUNT_SIZE));
		const controls = filterControls(mount);
		const bodies = (): number => find(mount.results, 'dl').length;
		expect(bodies()).toBe(0);
		const details = find(listRows(mount.results)[0]!, 'details')[0]!;
		const summary = details.children[0]!;
		// Deliberate renunciation: a closed row has none of its detail text in the document, so a
		// browser's page search does not find it and does not open the row.
		expect(walk(details).map((element) => element.textContent ?? '').filter((text) => text !== '')).toEqual(['Detalles']);
		// The click arrives before the browser opens it: the body is already there when it shows.
		summary.dispatch('click');
		expect(bodies()).toBe(1);
		open(details);
		expect(bodies()).toBe(1);
		expect(details.children[0] === summary).toBe(true);
		close(details);
		expect(bodies()).toBe(0);
		expect(sameElements(details.children, [summary])).toBe(true);
		// Opened by something that is not a click (an assistive tool, a script): `toggle` mounts it.
		// Page search is not such a case: it never sees a closed row, which is deliberate.
		open(details);
		expect(bodies()).toBe(1);
		controls.search.value = 's';
		controls.search.dispatch('input');
		expect(bodies()).toBe(0);
	});
});

describe('Inventory Advisor list: accessibility of rows that are kept and moved', () => {
	it('keeps the focus in the search while typing, on the same input', () => {
		const mount = render(fixtureModel(60), 'es', keepInteractions([]));
		const controls = filterControls(mount);
		controls.search.focus();
		for (const query of ['s', 'se', 'no existe', '']) {
			controls.search.value = query;
			controls.search.dispatch('input');
			expect(mount.document.activeElement === controls.search).toBe(true);
			expect(filterControls(mount).search === controls.search).toBe(true);
		}
	});

	it('keeps the focus on the focused control of a row when the list around it is reordered', () => {
		const mount = render(fixtureModel(60), 'es', keepInteractions([]));
		const controls = filterControls(mount);
		const button = keepButtons(mount.results)[5]!;
		button.focus();
		controls.sort.value = 'name_asc';
		controls.sort.dispatch('change');
		expect(button.isConnected).toBe(true);
		expect(mount.document.activeElement === button).toBe(true);
		const summary = find(listRows(mount.results)[7]!, 'summary')[0]!;
		summary.focus();
		controls.group.value = 'action';
		controls.group.dispatch('change');
		expect(summary.isConnected).toBe(true);
		expect(mount.document.activeElement === summary).toBe(true);
	});

	it('moves the focus to the same control of the same row when the data rebuild the row', () => {
		const model = { ...fixtureModel(60), contentVersion: 1 };
		const mount = render(model, 'es', keepInteractions([]));
		const button = keepButtons(mount.results)[5]!;
		const label = button.attributes.get('aria-label');
		button.focus();
		renderInventoryAdvisorView(
			mount.container as unknown as HTMLElement, icons, { ...model, contentVersion: 2 }, createTranslator('es'), undefined, keepInteractions([]),
		);
		const focused = mount.document.activeElement;
		expect(focused === button).toBe(false);
		expect(focused?.isConnected).toBe(true);
		expect(focused?.tag).toBe('button');
		expect(focused?.attributes.get('aria-label')).toBe(label);
	});

	it('leaves a row that stops matching out of the document: no tab stop, nothing to announce, no focus left on it', () => {
		const mount = render(fixtureModel(60), 'es', keepInteractions([]));
		const controls = filterControls(mount);
		const hiddenRow = listRows(mount.results).find((row) => !(row.attributes.get('aria-label') ?? '').toLowerCase().includes('seda'))!;
		const button = find(hiddenRow, 'button')[0] ?? find(hiddenRow, 'summary')[0]!;
		button.focus();
		controls.search.value = 'seda';
		controls.search.dispatch('input');
		expect(hiddenRow.isConnected).toBe(false);
		expect(mount.container.contains(hiddenRow)).toBe(false);
		expect(mount.document.activeElement === button).toBe(false);
		expect(listRows(mount.results).every((row) => (row.attributes.get('aria-label') ?? '').toLowerCase().includes('seda'))).toBe(true);
		// Nothing is hidden with an attribute a reader could still reach: what does not match is not there.
		expect(walk(mount.results).filter((element) => element.hidden)).toHaveLength(0);
		controls.search.value = '';
		controls.search.dispatch('input');
		expect(hiddenRow.isConnected).toBe(true);
	});

	it('keeps the tab order of the list: each visible row gives its keep button and then its detail, in the order shown', () => {
		const mount = render(fixtureModel(60), 'es', keepInteractions([]));
		const controls = filterControls(mount);
		const expectTabOrder = (): void => {
			// A row inside the folded group without value is out of reach until that group is opened.
			const shownRows = shownElements(mount.results).filter(isListRow);
			const expected = shownRows.flatMap((row) => [
				...find(only(row.children.filter((cell) => cell.className.split(' ').includes('c-keep'))), 'button'),
				only(row.children.filter((child) => child.tag === 'details')).children[0]!,
			]);
			const tabStops = tabStopsOf(mount.results).filter((element) => shownRows.some((row) => row.contains(element)));
			expect(sameElements(tabStops, expected)).toBe(true);
			expect(tabStops.length).toBeGreaterThan(shownRows.length);
		};
		const openNoValueGroup = (): void => {
			open(only(find(mount.results, 'details').filter((details) => details.className === 'tyrian-inventory-advisor__no-value')));
		};
		expectTabOrder();
		openNoValueGroup();
		expectTabOrder();
		controls.sort.value = 'name_asc';
		controls.search.value = 'a';
		controls.search.dispatch('input');
		expectTabOrder();
		controls.search.value = '';
		controls.group.value = 'evidence';
		controls.group.dispatch('change');
		openNoValueGroup();
		expectTabOrder();
	});

	it('keeps each detail a native disclosure: a `details` whose first child is its `summary`, the body inside it', () => {
		const mount = render(fixtureModel(60));
		for (const row of listRows(mount.results)) {
			const details = find(row, 'details').filter((element) => element.className === 'tyrian-inventory__more');
			expect(details).toHaveLength(1);
			expect(details[0]!.children[0]?.tag).toBe('summary');
			expect(details[0]!.children[0]?.textContent).toBe('Detalles');
			// Native semantics: the browser exposes expanded/collapsed itself, no ARIA copy to keep in step.
			for (const name of ['role', 'aria-expanded', 'aria-controls']) {
				expect(details[0]!.attributes.has(name)).toBe(false);
				expect(details[0]!.children[0]!.attributes.has(name)).toBe(false);
			}
		}
		const details = find(listRows(mount.results)[0]!, 'details')[0]!;
		open(details);
		expect(details.children.length).toBeGreaterThan(1);
		expect(details.children.slice(1).every((child) => details.contains(child) && child.isConnected)).toBe(true);
	});

	it('answers a key and opens a detail without a timer, at account size', async () => {
		const used = await ambientCapabilityUse(() => {
			const mount = render(fixtureModel(ACCOUNT_SIZE));
			const controls = filterControls(mount);
			controls.search.value = 'seda';
			controls.search.dispatch('input');
			// The answer is already in the document when the event returns.
			expect(listRows(mount.results).every((row) => (row.attributes.get('aria-label') ?? '').toLowerCase().includes('seda'))).toBe(true);
			const details = find(listRows(mount.results)[0]!, 'details')[0]!;
			details.children[0]!.dispatch('click');
			open(details);
			expect(find(details, 'dl')).toHaveLength(1);
		});
		expect(used).toEqual([]);
	});
});

/** The hashes were captured from the implementation that rebuilt the list on every key (cfecb9b). */
const PINNED = {
	combinations: 'bfdf52bd3d2cb89216e600458ecc3e7acd613879612edc5aa1a5891ca979a2fe',
	searches: '1a7431810c76531c5eb8a368001813bb5bdfeea8e2f436a9205c427b85b4f0dd',
	openDetails: 'b5d3d5a0859400b28a1a0b4d732028b7a8be13c2c6730485e8534a5f7c27185f',
	// Halloween scope: the low-space repaint labels character bags; its pressure fixture now excludes bank slots.
	repaints: 'b2abb6b7aeee4723c45081bbe0ad874c47e21d65ae6bf959ea339c2f102b342e',
	/** Elements created to mount 1,371 rows; 36,144 while every closed detail carried its body. */
	nodesOnMount: 18_110,
	/**
	 * Per key of the search `s, se, sed, seda 1, sed, (empty), 10, (empty)`: rows shown, elements
	 * created. While every key rebuilt the rows it created 10,336, 5,189, 5,189, 1,882, 5,189,
	 * 36,051, 4,612 and 36,051.
	 */
	perKey: [[392, 42], [196, 42], [196, 42], [70, 42], [196, 42], [1_371, 42], [173, 42], [1_371, 42]] as ReadonlyArray<readonly [number, number]>,
};

interface Mount {
	container: FakeElement;
	document: FakeDocument;
	results: FakeElement;
	state: FakeElement;
}

function render(model: InventoryAdvisorViewModel, locale: 'es' | 'en' = 'es', interactions: InventoryAdvisorViewInteractions = {}): Mount {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => document.create(tag));
	vi.stubGlobal('createDiv', () => document.create('div'));
	vi.stubGlobal('createSpan', () => document.create('span'));
	const container = new FakeElement('div', document);
	container.root = true;
	renderInventoryAdvisorView(container as unknown as HTMLElement, icons, model, createTranslator(locale), undefined, interactions);
	return {
		container, document,
		results: only(walk(container).filter((element) => element.className === 'tyrian-inventory-advisor__results')),
		state: only(walk(container).filter((element) => element.className === 'tyrian-inventory-advisor__state')),
	};
}

function filterControls(mount: Mount): {
	search: FakeElement; sort: FakeElement; group: FakeElement; action: FakeElement; character: FakeElement; includes: FakeElement[];
} {
	const elements = walk(mount.container);
	const labelled = (tag: string, label: string): FakeElement => only(elements
		.filter((element) => element.tag === tag && element.attributes.get('aria-label') === label));
	return {
		search: only(elements.filter((element) => element.tag === 'input' && element.type === 'search')),
		sort: labelled('select', 'Ordenar por'),
		group: labelled('select', 'Agrupar por'),
		action: labelled('select', 'Filtrar acción'),
		character: labelled('select', 'Personaje'),
		includes: only(elements.filter((element) => element.className === 'tyrian-inventory-advisor__scope'))
			.children.flatMap((label) => label.children.filter((element) => element.tag === 'input')),
	};
}

function keepInteractions(keptItemIds: readonly number[]): InventoryAdvisorViewInteractions {
	return {
		onKeepItem: () => undefined,
		onRemoveKeepException: () => undefined,
		onOpenSale: () => undefined,
		preferences: { status: 'ready', goals: [], keepExceptions: keptItemIds.map((itemId) => ({
			version: 1, exceptionId: `exception-${String(itemId)}`, itemId, status: 'active', basis: 'available', quantity: { mode: 'all' }, reason: 'user_keep',
		})) },
	};
}

function lowSpace(): NonNullable<InventoryAdvisorViewModel['storageSpace']> {
	return {
		bags: { free: 3, total: 30 }, bank: { free: 4, total: 30 }, sharedInventory: null,
		lowSpace: { freeSlots: 3, totalSlots: 30, thresholdFreeSlots: 20, isLow: true },
		materialCapacity: { quantity: 1_500, source: 'observed_minimum' },
	};
}

const FIXTURE_ACTIONS: readonly InventoryAdvisorViewAction[] = [
	'sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review', 'discard_review', 'deposit_material',
];
const FIXTURE_NAMES = ['Seda', 'Ébano', 'ébano', 'Mithril', 'Bolsa de truco o trato', 'Cuero', 'Lino'] as const;
const FIXTURE_COVERAGE: readonly InventoryAdvisorViewCoverageState[] = ['complete', 'limited', 'unknown'];

/**
 * A deterministic account: unique row ids, repeated names and values (so every tie-break of the
 * order matters), every action, every store, two characters, split stacks, shared item ids, rows
 * with and without a demonstrated value.
 */
function fixtureModel(count: number): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		optionalSources: { bank: { status: 'complete' }, materials: { status: 'complete' }, delivery: { status: 'complete' } },
		groups: [
			{ key: 'market', rows: range(count).filter((index) => index % 2 === 0).map(fixtureRow) },
			{ key: 'review', rows: range(count).filter((index) => index % 2 === 1).map(fixtureRow) },
		],
	};
}

function fixtureRow(index: number): InventoryAdvisorViewRow {
	// Every 25th row is a second decision over the object of the row before it.
	const itemId = 1_000 + (index % 25 === 24 ? index - 1 : index);
	const quantity = 1 + (index * 7) % 250;
	const position = `#/positions/${String(index)}`;
	const bag = (character: string, amount: number): InventoryAdvisorViewRow['allocations'][number] => ({
		positionRef: `${position}/bag`, quantity: amount,
		location: { source: 'character', character, container: 'bag', bagIndex: index % 4, slot: index % 20 },
	});
	const bank = (amount: number): InventoryAdvisorViewRow['allocations'][number] => ({
		positionRef: `${position}/bank`, quantity: amount, location: { source: 'bank', slot: index },
	});
	const allocations: InventoryAdvisorViewRow['allocations'] = index % 13 === 12
		? [{ positionRef: `${position}/delivery`, quantity, location: { source: 'commerce_delivery', slot: index % 5 } }]
		: index % 6 === 0 ? [bag('Astra', quantity)]
			: index % 6 === 1 ? [bag('Borja', quantity)]
				: index % 6 === 2 ? [{ positionRef: `${position}/shared`, quantity, location: { source: 'shared_inventory', slot: index % 7 } }]
					: index % 6 === 3 ? [bank(quantity)]
						: index % 6 === 4 ? [{ positionRef: `${position}/materials`, quantity, location: { source: 'materials', category: index % 9 } }]
							: quantity > 1 ? [bag('Astra', 1), bank(quantity - 1)] : [bag('Astra', 1)];
	const state = FIXTURE_COVERAGE[index % 5 === 0 ? 1 : index % 11 === 0 ? 2 : 0]!;
	return {
		id: `#/explanations/${String(index)}/0`, itemId,
		name: `${FIXTURE_NAMES[index % FIXTURE_NAMES.length]!} ${String(index % 31)}`,
		icon: index % 4 === 0 ? `https://render.guildwars2.com/file/ABC/${String(itemId)}.png` : null,
		ownedQuantity: quantity, availableQuantity: quantity,
		action: FIXTURE_ACTIONS[index % FIXTURE_ACTIONS.length]!,
		quantity,
		...(index % 9 === 0 ? { reservedQuantity: Math.max(1, quantity - 1) } : {}),
		...(index % 4 === 1 ? { slotsFreed: 1 + index % 3 } : {}),
		allocations,
		reasonCodes: index % 8 === 3 ? ['position_not_actionable'] : ['rule_missing'],
		protectionReasons: [],
		value: index % 3 === 0
			? { status: 'unavailable', route: null }
			: { status: 'available', copper: ((index * 7_919) % 500) * 30, route: index % 2 === 0 ? 'instant_sell' : 'vendor' },
		marketComparison: null, burden: null,
		coverage: {
			snapshot: state, inventory: state, catalog: state, prices: state, reservations: state, accountSignals: state, rules: state,
		},
		irreversibleReviewOnly: index % FIXTURE_ACTIONS.length === 8,
		discardProof: null,
	};
}

function range(count: number): number[] {
	return Array.from({ length: count }, (_, index) => index);
}

/** Counts the sorts of a list of account size and every name comparison, wherever they are made. */
function countSorts(): { listSorts(): number; comparisons(): number } {
	const sort = vi.spyOn(Array.prototype, 'sort');
	const compare = vi.spyOn(String.prototype, 'localeCompare');
	return {
		listSorts: () => sort.mock.contexts.filter((sorted) => (sorted as unknown[]).length >= 100).length,
		comparisons: () => compare.mock.calls.length,
	};
}

function isListRow(element: FakeElement): boolean {
	const classes = element.className.split(' ');
	return element.tag === 'li' && classes.includes('tyrian-inventory__row') && !classes.includes('tyrian-inventory-advisor__subtotal');
}

function listRows(root: FakeElement): FakeElement[] {
	return walk(root).filter(isListRow);
}

function keepButtons(root: FakeElement): FakeElement[] {
	return listRows(root).flatMap((row) => find(row, 'button'));
}

/** What the tabulator reaches inside an element: enabled buttons and summaries the document shows. */
function tabStopsOf(root: FakeElement): FakeElement[] {
	return shownElements(root).filter((element) => (element.tag === 'button' && !element.disabled) || element.tag === 'summary');
}

/** Opens a `<details>` as the browser does once it has changed `open`. */
function open(details: FakeElement): void {
	details.open = true;
	details.dispatch('toggle');
}

/** Opens every `<details>` under `root`, and the ones that only exist once their parent is open. */
function openAll(root: FakeElement): void {
	for (;;) {
		const closed = find(root, 'details').filter((details) => !details.open);
		if (closed.length === 0) return;
		closed.forEach(open);
	}
}

function close(details: FakeElement): void {
	details.open = false;
	details.dispatch('toggle');
}

/**
 * The same nodes in the same order, by identity. Never `toEqual` on these doubles: they point at
 * their parent, and a deep comparison of two lists walks the whole document for every pair.
 */
function sameElements(left: readonly FakeElement[], right: readonly FakeElement[]): boolean {
	return left.length === right.length && left.every((element, index) => element === right[index]);
}

function only<T>(items: readonly T[]): T {
	const item = items[0];
	if (items.length !== 1 || item === undefined) throw new Error(`Expected one item, received ${String(items.length)}.`);
	return item;
}

function find(root: FakeElement, tag: string): FakeElement[] {
	return walk(root).filter((element) => element.tag === tag);
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

/** The elements a reader gets: nothing `hidden`, and of a closed `<details>` only its summary. */
function shownElements(root: FakeElement): FakeElement[] {
	if (root.hidden) return [];
	const children = root.tag === 'details' && !root.open ? root.children.filter((child) => child.tag === 'summary') : root.children;
	return [root, ...children.flatMap(shownElements)];
}

/** One line per shown element, in document order: tag, classes, attributes, state and own text. */
function visibleTree(root: FakeElement): string {
	return describeTree(root, true, 0).join('\n');
}

/** Every element under `root`, shown or not. */
function fullTree(root: FakeElement): string {
	return describeTree(root, false, 0).join('\n');
}

function describeTree(element: FakeElement, shownOnly: boolean, depth: number): string[] {
	if (shownOnly && element.hidden) return [];
	const children = shownOnly && element.tag === 'details' && !element.open
		? element.children.filter((child) => child.tag === 'summary') : element.children;
	const attributes = [...element.attributes].map(([name, value]) => `${name}=${JSON.stringify(value)}`);
	const flags = [
		element.type === '' ? '' : `type=${element.type}`, element.disabled ? 'disabled' : '', element.open ? 'open' : '',
		element.hidden ? 'hidden' : '',
	].filter((flag) => flag !== '');
	return [
		`${'\t'.repeat(depth)}${element.tag}.${element.className} [${[...attributes, ...flags].join(' ')}] ${JSON.stringify(element.textContent)}`,
		...children.flatMap((child) => describeTree(child, shownOnly, depth + 1)),
	];
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	/** How many elements the view has asked for. */
	createdCount = 0;
	/** The elements asked for since `recordCreated()`, in creation order; none are kept before it. */
	created: FakeElement[] = [];
	private recording = false;

	create(tag: string): FakeElement {
		const element = new FakeElement(tag, this);
		this.createdCount += 1;
		if (this.recording) this.created.push(element);
		return element;
	}

	/** Starts keeping the created elements: a test that repaints thousands of times must not hold them all. */
	recordCreated(): void {
		this.recording = true;
		this.created = [];
	}
}

type FakeListener = (event: { preventDefault(): void }) => void;

/**
 * A DOM double that moves nodes as the browser does: appending an attached node takes it out of
 * its old parent, and a focused node that leaves the document loses the focus.
 */
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, FakeListener[]>();
	parent: FakeElement | null = null;
	/** The mount container: the only node attached without a parent. */
	root = false;
	className = '';
	id = '';
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

	get tagName(): string { return this.tag.toUpperCase(); }

	get isConnected(): boolean {
		return this.root || (this.parent?.isConnected ?? false);
	}

	contains(other: FakeElement | null): boolean {
		for (let node = other; node !== null; node = node.parent) if (node === this) return true;
		return false;
	}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.detach();
			child.parent = this;
			this.children.push(child);
		}
	}

	prepend(...children: FakeElement[]): void {
		for (const child of [...children].reverse()) {
			child.detach();
			child.parent = this;
			this.children.unshift(child);
		}
	}

	replaceChildren(...children: FakeElement[]): void {
		for (const child of [...this.children]) if (!children.includes(child)) child.detach();
		for (const child of children) child.detach();
		this.append(...children);
	}

	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }

	addEventListener(type: string, listener: FakeListener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} }); }

	focus(): void {
		if (this.isConnected) this.ownerDocument.activeElement = this;
	}

	private detach(): void {
		if (this.parent === null) return;
		const active = this.ownerDocument.activeElement;
		if (active !== null && this.contains(active)) this.ownerDocument.activeElement = null;
		this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
}
