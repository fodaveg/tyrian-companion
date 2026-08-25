import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import {
	createInventoryAdvisorFixturePort,
	filterInventoryAdvisorRows,
	formatInventoryAdvisorLocation,
	groupInventoryAdvisorRows,
	inventoryAdvisorCharacters,
	inventoryAdvisorViewLayout,
	renderInventoryAdvisorView,
	renderInventoryAdvisorViewFromPort,
	sortInventoryAdvisorRows,
	summarizeInventoryAdvisorRows,
	type InventoryAdvisorViewAction,
	type InventoryAdvisorViewCoverage,
	type InventoryAdvisorViewCoverageState,
	type InventoryAdvisorViewModel,
	type InventoryAdvisorViewRow,
	type InventoryAdvisorViewInteractions,
} from './inventory-advisor-view';
import type { InventoryPreferencesEditorState } from '../advisor/inventory-preferences-runtime';

afterEach(() => vi.unstubAllGlobals());

describe('Inventory Advisor view', () => {
	it.each([
		['es', 'Compara venta instantánea, publicación y mercader con precios actuales.'],
		['en', 'Compares instant sell, listing and vendor routes with current prices.'],
	] as const)('shows the honest liquid-route banner in %s', (locale, expected) => {
		const mount = render(readyModel(), locale);
		expect(text(mount.elements())).toContain(expected);
	});

	it.each([[479, 'cards'], [480, 'cards'], [759, 'cards'], [760, 'table']] as const)(
		'selects the semantic H5.11 layout at %ipx',
		(width, expected) => expect(inventoryAdvisorViewLayout(width)).toBe(expected),
	);

	it('keeps the complete card evidence surface visible at both 480px and 759px breakpoints', () => {
		const styles = readFileSync('styles.css', 'utf8');
		const breakpoint = styles.lastIndexOf('@container (max-width: 759px)');
		const compact = styles.slice(breakpoint, styles.indexOf('@container (max-width: 479px)', breakpoint));
		expect(compact).toMatch(/tyrian-inventory-advisor__table[\s\S]*display:\s*none/u);
		expect(compact).toMatch(/tyrian-inventory-advisor__cards[\s\S]*display:\s*grid/u);
		for (const width of [480, 759]) expect(inventoryAdvisorViewLayout(width)).toBe('cards');
	});

	it.each([
		[{ source: 'character', character: 'Astra', container: 'equipped_bag', bagIndex: 1 }, 'Personaje: Astra · Bolsa equipada 2'],
		[{ source: 'character', character: 'Astra', container: 'bag', bagIndex: 2, slot: 4 }, 'Personaje: Astra · Bolsa 3, ranura 5'],
		[{ source: 'shared_inventory', slot: 3 }, 'Inventario compartido · Ranura 4'],
		[{ source: 'bank', slot: 7 }, 'Banco · Ranura 8'],
		[{ source: 'materials', category: 12 }, 'Almacén de materiales · Categoría 12'],
		[{ source: 'commerce_delivery', slot: 0 }, 'Entrega del bazar · Ranura 1'],
	] as const)('formats the exact discriminators for location %#', (location, expected) => {
		expect(formatInventoryAdvisorLocation(location, createTranslator('es'))).toBe(expected);
	});

	it('filters by item text or id and groups the local rows without mutating the frozen model', () => {
		const model = deepFreeze(readyModel());
		const before = structuredClone(model);
		const rows = model.groups.flatMap((group) => group.rows);
		expect(filterInventoryAdvisorRows(rows, { query: 'mat', action: 'all', groupBy: 'action' }).map((row) => row.itemId)).toEqual([100]);
		expect(filterInventoryAdvisorRows(rows, { query: '200', action: 'all', groupBy: 'action', showReview: true }).map((row) => row.itemId)).toEqual([200]);
		expect(groupInventoryAdvisorRows(rows, 'evidence').map((group) => group.key)).toEqual(['complete', 'limited']);
		expect(model).toEqual(before);
	});

	it('keeps controls, focus, and the live region stable through consecutive search and select events', () => {
		const mount = render(readyModel());
		const search = only(find(mount.elements(), 'input').filter((input) => input.type === 'search'));
		const [action, group] = find(mount.elements(), 'select');
		if (!action || !group) throw new Error('Expected Inventory Advisor filter controls.');
		const state = only(byClass(mount.elements(), 'tyrian-inventory-advisor__state'));
		const results = only(byClass(mount.elements(), 'tyrian-inventory-advisor__results'));
		search.focus();
		search.value = 'does-not-exist';
		search.dispatch('input');
		expect(mount.document.activeElement).toBe(search);
		expect(only(find(mount.elements(), 'input').filter((input) => input.type === 'search'))).toBe(search);
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
		expect(state.textContent).toBe('Estas son las mejores acciones conocidas. Nada se ejecuta automáticamente.');
		expect(text(mount.elements())).toContain('Completa');
		expect(text(mount.elements())).not.toContain('Resto sin valor');
	});

	it('keeps discard reviews out of the filter while rendering an explicit warning-only proof surface if wired', () => {
		const mount = render(readyModel());
		const action = find(mount.elements(), 'select')[0];
		if (!action) throw new Error('Expected an action filter.');
		expect(action.children.map((option) => option.value)).not.toEqual(expect.arrayContaining(['keep', 'review', 'discard_review']));
		expect(text(mount.elements())).not.toContain('⚠ Revisión irreversible');
		const review = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox').at(-1);
		if (review === undefined) throw new Error('Expected the review visibility option.');
		review.checked = true;
		review.dispatch('change');
		expect(text(mount.elements())).toContain('⚠ Revisión irreversible');
		expect(find(mount.elements(), 'th').filter((element) => element.scope === 'rowgroup')
		.map((element) => element.textContent)).toContain('⚠ Revisión irreversible');
		expect(find(mount.elements(), 'h3').map((element) => element.textContent)).toContain('⚠ Revisión irreversible');
		expect(find(mount.elements(), 'button').some((button) => walk(button).some((element) => element.textContent?.includes('irreversible') === true))).toBe(false);
		expect(find(mount.elements(), 'dialog')).toEqual([]);
	});

	it('renders semantic tables, cards, and long content without raw action or coverage enums in Spanish and English', () => {
		for (const locale of ['es', 'en'] as const) {
			const mount = render(allStatesAndActionsModel(), locale);
			const context = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox').slice(-2);
			for (const input of context) { input.checked = true; input.dispatch('change'); }
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
			expect(mount.section.attributes.get('aria-busy')).toBe('false');
			if (status === 'blocked' || status === 'invalid') expect(state.attributes.get('role')).toBe('alert');
			else expect(state.attributes.has('role')).toBe(false);
			expect(mount.elements().every((element) => !element.attributes.has('tabindex'))).toBe(true);
		}
	});

	it('defaults to bags and shared inventory, keeps optional stores off, and rescales mixed rows without mutation', () => {
		const mixed = deepFreeze([row({
			itemId: 42, name: 'Mixed', action: 'sell', quantity: 5, ownedQuantity: 5, availableQuantity: 5,
			value: { status: 'available', route: 'instant_sell', copper: 500 },
			allocations: [
				{ positionRef: '#/positions/42/0', quantity: 2, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } },
				{ positionRef: '#/positions/42/1', quantity: 3, location: { source: 'bank', slot: 0 } },
			],
		})]);
		const before = structuredClone(mixed);
		const base = filterInventoryAdvisorRows(mixed, { query: '', action: 'all', groupBy: 'action' });
		expect(base[0]).toMatchObject({ quantity: 2, ownedQuantity: 2, availableQuantity: 2, value: { copper: 200 } });
		expect(base[0]?.allocations).toHaveLength(1);
		const withBank = filterInventoryAdvisorRows(mixed, { query: '', action: 'all', groupBy: 'action', includeBank: true });
		expect(withBank[0]).toMatchObject({ quantity: 5, ownedQuantity: 5, availableQuantity: 5, value: { copper: 500 } });
		expect(mixed).toEqual(before);
	});

	it('scopes rows to one character, ignores every other store and rescales its value', () => {
		const rows = deepFreeze([row({
			itemId: 42, name: 'Mixed', action: 'sell', quantity: 10, ownedQuantity: 10, availableQuantity: 10,
			value: { status: 'available', route: 'instant_sell', copper: 1_000 },
			allocations: [
				{ positionRef: '#/positions/42/0', quantity: 2, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } },
				{ positionRef: '#/positions/42/1', quantity: 3, location: { source: 'character', character: 'Borja', container: 'bag', bagIndex: 0, slot: 1 } },
				{ positionRef: '#/positions/42/2', quantity: 1, location: { source: 'shared_inventory', slot: 0 } },
				{ positionRef: '#/positions/42/3', quantity: 4, location: { source: 'bank', slot: 0 } },
			],
		})]);
		expect(inventoryAdvisorCharacters(rows, 'es')).toEqual(['Astra', 'Borja']);
		const everything = filterInventoryAdvisorRows(rows, { query: '', action: 'all', groupBy: 'action', character: 'all' });
		expect(everything[0]).toMatchObject({ quantity: 6, value: { copper: 600 } });
		const astra = filterInventoryAdvisorRows(rows, { query: '', action: 'all', groupBy: 'action', character: 'Astra' });
		expect(astra[0]).toMatchObject({ quantity: 2, ownedQuantity: 2, availableQuantity: 2, value: { copper: 200 } });
		expect(astra[0]?.allocations).toHaveLength(1);
		const withBankAndCharacter = filterInventoryAdvisorRows(rows, {
			query: '', action: 'all', groupBy: 'action', character: 'Borja', includeBank: true,
		});
		expect(withBankAndCharacter[0]).toMatchObject({ quantity: 3, value: { copper: 300 } });
		expect(filterInventoryAdvisorRows(rows, { query: '', action: 'all', groupBy: 'action', character: 'Unknown' })).toEqual([]);
	});

	it('offers the observed roster, disables the extra stores while one character is scoped and resets an absent one', () => {
		const mount = render(twoCharacterModel());
		const characterSelect = find(mount.elements(), 'select')[2];
		if (characterSelect === undefined) throw new Error('Expected the character filter.');
		expect(characterSelect.children.map((option) => option.value)).toEqual(['all', 'Astra', 'Borja']);
		expect(text(mount.elements())).toContain('Todas las bolsas y compartido');
		const stores = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox').slice(0, 3);
		expect(stores.every((input) => !input.disabled)).toBe(true);
		characterSelect.value = 'Astra';
		characterSelect.dispatch('change');
		expect(stores.every((input) => input.disabled)).toBe(true);
		expect(text(mount.elements())).toContain('Solo de Astra');
		expect(text(mount.elements())).not.toContain('Solo de Borja');
		const withoutAstra: InventoryAdvisorViewModel = {
			...readyModel(),
			groups: [{ key: 'market', rows: [row({ itemId: 11, name: 'De Borja', action: 'sell',
				allocations: [{ positionRef: '#/positions/11/0', quantity: 3, location: { source: 'character', character: 'Borja', container: 'bag', bagIndex: 0, slot: 0 } }] })] }],
		};
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, withoutAstra, createTranslator('es'));
		expect(characterSelect.value).toBe('all');
		expect(characterSelect.children.map((option) => option.value)).toEqual(['all', 'Borja']);
		expect(text(mount.elements())).not.toContain('Solo de Astra');
	});

	it('counts unpriced items apart instead of folding them into the known value', () => {
		const rows = [
			row({ itemId: 1, quantity: 2, action: 'sell', allocations: [allocation('#/positions/1/0', 2)], value: { status: 'available', route: 'instant_sell', copper: 500 } }),
			row({ itemId: 2, quantity: 3, action: 'sell', allocations: [allocation('#/positions/2/0', 3)], value: { status: 'unavailable', route: null } }),
			row({ itemId: 3, quantity: 1, action: 'sell', allocations: [allocation('#/positions/3/0', 1)], value: { status: 'not_applicable', route: null } }),
		];
		expect(summarizeInventoryAdvisorRows(rows)).toEqual({
			items: 3, units: 6, stacks: 3, knownCopper: 500, pricedItems: 1, unpricedItems: 2,
		});
		expect(summarizeInventoryAdvisorRows([
			row({ itemId: 4, quantity: 1, action: 'sell', allocations: [allocation('#/positions/4/0', 1)] }),
			row({ itemId: 4, quantity: 2, action: 'keep', allocations: [allocation('#/positions/4/0', 2)] }),
		]).stacks).toBe(1);
		expect(summarizeInventoryAdvisorRows([])).toMatchObject({ items: 0, knownCopper: 0, unpricedItems: 0 });
		expect(summarizeInventoryAdvisorRows([
			row({ itemId: 5, action: 'sell', quantity: 1, allocations: [allocation('#/positions/5/0', 1)], value: { status: 'available', route: 'instant_sell', copper: 100 } }),
			row({ itemId: 5, action: 'list', quantity: 1, allocations: [allocation('#/positions/5/1', 1)], value: { status: 'unavailable', route: null } }),
		])).toMatchObject({ items: 1, pricedItems: 0, unpricedItems: 1, knownCopper: 100 });
		const mount = render({ ...readyModel(), groups: [{ key: 'market', rows }] });
		expect(text(mount.elements())).toContain('Sin precio demostrado: 2 objetos.');
		expect(text(mount.elements())).toContain('2 sin precio');
	});

	it('distinguishes a read empty optional store from unavailable or restricted stores', () => {
		const model = readyModel();
		model.groups = [];
		model.optionalSources = {
			bank: { status: 'complete' },
			materials: { status: 'partial', reason: 'unavailable', diagnostic: { kind: 'http', status: 403, retryAfterMs: null } },
			delivery: { status: 'skipped', reason: 'url_restricted' },
		};
		const mount = render(model);
		const stores = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox').slice(0, 3);
		expect(stores.map((input) => input.disabled)).toEqual([false, true, true]);
		expect(byClass(mount.elements(), 'tyrian-inventory-advisor__source-status').map((entry) => entry.textContent))
			.toEqual([' · Leído', ' · No disponible', ' · Restringido por la clave', null, null]);
		expect(text(mount.elements())).not.toContain('403');
	});

	it('orders visible rows by the selected criterion and closes each group with its exact subtotal', () => {
		const rows = [
			row({ id: '#/explanations/1/0', itemId: 1, name: 'Bajo valor', action: 'sell', quantity: 9,
				allocations: [{ positionRef: '#/positions/1/0', quantity: 9, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } }],
				value: { status: 'available', route: 'instant_sell', copper: 100 } }),
			row({ id: '#/explanations/2/0', itemId: 2, name: 'Alto valor', action: 'sell', quantity: 1,
				allocations: [{ positionRef: '#/positions/2/0', quantity: 1, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 1 } }],
				value: { status: 'available', route: 'instant_sell', copper: 900 } }),
		];
		expect(sortInventoryAdvisorRows(rows, 'value_desc', 'es').map((entry) => entry.itemId)).toEqual([2, 1]);
		expect(sortInventoryAdvisorRows(rows, 'quantity_desc', 'es').map((entry) => entry.itemId)).toEqual([1, 2]);
		expect(sortInventoryAdvisorRows(rows, 'name_asc', 'es').map((entry) => entry.name)).toEqual(['Alto valor', 'Bajo valor']);
		const mount = render({ ...readyModel(), groups: [{ key: 'market', rows }] });
		const subtotal = only(byClass(mount.elements(), 'tyrian-inventory-advisor__subtotal'));
		expect(walk(subtotal).map((cell) => cell.textContent)).toEqual(
			expect.arrayContaining(['Subtotal · 2 objetos', '10', '2', '0 oro · 10 plata · 0 cobre']),
		);
		const sortSelect = find(mount.elements(), 'select')[3];
		if (sortSelect === undefined) throw new Error('Expected the sort control.');
		sortSelect.value = 'quantity_desc';
		sortSelect.dispatch('change');
		expect(find(mount.elements(), 'article').map((card) => walk(card).some((element) => element.textContent === 'Bajo valor')))
			.toEqual([true, false]);
	});

	it('names the exact coverage axes that are not complete', () => {
		const mount = render({
			...readyModel(),
			groups: [{ key: 'market', rows: [row({
				itemId: 7, name: 'Parcial', action: 'sell',
				coverage: { ...coverage('complete'), prices: 'limited', rules: 'unknown' },
			})] }],
		});
		expect(text(mount.elements())).toContain('Limitada (precios, reglas)');
	});

	it('shows direct actions by default and keeps preserve/review context explicitly opt-in', () => {
		const mount = render(allStatesAndActionsModel());
		const options = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox');
		expect(options).toHaveLength(5);
		expect(options.every((input) => input.checked === false)).toBe(true);
		expect(options.every((input) => !input.disabled)).toBe(true);
		expect(find(mount.elements(), 'article')).toHaveLength(6);
		const keep = options[3];
		if (keep === undefined) throw new Error('Expected the keep visibility option.');
		keep.checked = true;
		keep.dispatch('change');
		expect(find(mount.elements(), 'article')).toHaveLength(7);
		const review = options[4];
		if (review === undefined) throw new Error('Expected the review visibility option.');
		review.checked = true;
		review.dispatch('change');
		expect(find(mount.elements(), 'article')).toHaveLength(8);
	});

	it('leads with an imperative action queue and lets its buttons drive the stable filter', () => {
		const model: InventoryAdvisorViewModel = {
			status: 'limited', title: 'inventory_advisor.title', detail: 'inventory_advisor.limited',
			groups: [{ key: 'market', rows: [
				row({ itemId: 1, name: 'Sell first', action: 'sell', value: { status: 'available', route: 'instant_sell', copper: 12_345 } }),
				row({ itemId: 2, name: 'List second', action: 'list', value: { status: 'available', route: 'listing', copper: 25_000 } }),
				row({ itemId: 3, name: 'Vendor third', action: 'vendor', value: { status: 'available', route: 'vendor', copper: 99 } }),
				row({ itemId: 4, name: 'Context only', action: 'keep' }),
			] }],
		};
		const mount = render(model);
		const allText = text(mount.elements());
		expect(allText).toContain('Qué hacer ahora');
		expect(allText).toContain('Objetos distintos: 3 · Unidades: 9 · Pilas: 3');
		expect(allText).toContain('Valor conocido: 3 oro · 74 plata · 44 cobre');
		expect(allText).toContain('Todos los objetos visibles tienen precio demostrado.');
		expect(allText).toContain('Vender ya');
		expect(allText).toContain('Publicar en el bazar');
		expect(allText).toContain('Vender al mercader');
		expect(allText).not.toContain('Context only');
		const summaryButtons = byClass(mount.elements(), 'tyrian-inventory-advisor__recommendation-action');
		expect(summaryButtons).toHaveLength(3);
		const sell = only(summaryButtons.filter((button) => walk(button).some((element) => element.textContent === 'Vender ya')));
		sell.dispatch('click');
		const action = find(mount.elements(), 'select')[0];
		if (action === undefined) throw new Error('Expected the action filter.');
		expect(action.value).toBe('sell');
		expect(mount.document.activeElement).toBe(action);
		expect(find(mount.elements(), 'article')).toHaveLength(1);
		const pressed = only(byClass(mount.elements(), 'tyrian-inventory-advisor__recommendation-action')
			.filter((button) => button.attributes.get('aria-pressed') === 'true'));
		expect(walk(pressed).some((element) => element.textContent === 'Vender ya')).toBe(true);
	});

	it('renders only trusted GW2 item icons and an honest indeterminate refresh state', () => {
		const model = allStatesAndActionsModel();
		model.groups[0]!.rows[0]!.icon = 'https://render.guildwars2.com/file/abc.png';
		model.groups[0]!.rows[1]!.icon = 'https://render.guildwars2.com:444/file/port.png';
		model.groups[0]!.rows[2]!.icon = 'https://user@render.guildwars2.com/file/credentials.png';
		const mount = render(model, 'es', { refreshing: true });
		const images = find(mount.elements(), 'img');
		expect(images).toHaveLength(2);
		expect(new Set(images.map((image) => image.attributes.get('src')))).toEqual(new Set(['https://render.guildwars2.com/file/abc.png']));
		expect(images.every((image) => image.attributes.get('alt') === '')).toBe(true);
		const progress = only(find(mount.elements(), 'progress'));
		expect(progress.attributes.has('value')).toBe(false);
		expect(mount.section.attributes.get('aria-busy')).toBe('true');
		expect(text(mount.elements())).toContain('Puede tardar cerca de un minuto.');
		expect(text(mount.elements())).toContain('Los iconos visibles se cargan desde el CDN oficial de ArenaNet.');
	});

	it.each([
		['credential_unavailable', 'La clave seleccionada ya no está disponible en el almacén seguro de Obsidian. Vuelve a seleccionarla en los ajustes.'],
		['capture_unavailable', 'No se pudo leer la cuenta de Guild Wars 2. Comprueba la clave seleccionada y vuelve a actualizar.'],
		['capture_invalid', 'La captura de la cuenta no superó la validación de seguridad.'],
		['capture_snapshot_coverage_incomplete', 'No se pudo leer por completo el inventario de todos los personajes o el inventario compartido. Código seguro: snapshot_coverage_incomplete.'],
		['capture_snapshot_structure_invalid', 'La respuesta del inventario no tiene una estructura segura para analizar. Código seguro: snapshot_structure_invalid.'],
		['preferences_unavailable', 'Las preferencias locales del inventario no están disponibles.'],
		['unexpected_failure', 'La actualización del inventario falló de forma inesperada.'],
	] as const)('shows the safe actionable reason %s instead of the generic message', (blockedReason, expected) => {
		const mount = render({
			...readyModel(), status: blockedReason === 'unexpected_failure' ? 'invalid' : 'blocked', blockedReason, groups: [],
		});
		const state = only(byClass(mount.elements(), 'tyrian-inventory-advisor__state'));
		expect(state.textContent).toBe(expected);
		expect(state.textContent).not.toContain('account-');
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

	it('loads explicitly and creates, updates, resets, and removes redacted local preferences accessibly', async () => {
		let preferences: InventoryPreferencesEditorState = {
			status: 'ready', goals: [preferenceGoal('goal-existing')],
			keepExceptions: [preferenceException('exception-existing', 'all')],
		};
		let preferencesBusy = false;
		const callbacks = {
			load: vi.fn(async () => {}), upsertGoal: vi.fn(async () => {}), removeGoal: vi.fn(async () => {}),
			upsertException: vi.fn(async () => {}), removeException: vi.fn(async () => {}),
		};
		const interactions: InventoryAdvisorViewInteractions = {
			get preferences() { return preferences; }, get preferencesBusy() { return preferencesBusy; }, onLoadPreferences: callbacks.load,
			onUpsertGoal: callbacks.upsertGoal, onRemoveGoal: callbacks.removeGoal,
			onUpsertKeepException: callbacks.upsertException, onRemoveKeepException: callbacks.removeException,
		};
		const mount = render(readyModel(), 'es', interactions);
		const load = only(find(mount.elements(), 'button').filter((button) => button.textContent === 'Cargar preferencias locales'));
		load.dispatch('click');
		expect(callbacks.load).toHaveBeenCalledOnce();
		const [goalForm, exceptionForm] = byClass(mount.elements(), 'tyrian-inventory-advisor__preference-form');
		if (goalForm === undefined || exceptionForm === undefined) throw new Error('Expected preference forms.');
		const goalEdit = only(find(mount.elements(), 'button').filter((button) => button.attributes.get('aria-label') === 'Editar objetivo goal-existing'));
		goalEdit.dispatch('click');
		const goalInputs = find(walk(goalForm), 'input');
		expect(goalInputs[0]?.value).toBe('goal-existing');
		expect(only(find(walk(goalForm), 'button').filter((button) => button.type === 'submit')).textContent).toBe('Actualizar objetivo');
		goalInputs[0]!.value = 'Goal updated'; goalInputs[1]!.value = '10'; goalInputs[2]!.value = '5'; goalInputs[3]!.value = '3';
		goalForm.dispatch('submit');
		expect(callbacks.upsertGoal).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'goal-existing', title: 'Goal updated', priority: 3,
			requirements: [expect.objectContaining({ id: 10, targetQuantity: 5, creditedQuantity: 2 })] }));
		const newGoal = only(find(walk(goalForm), 'button').filter((button) => button.textContent === 'Nuevo objetivo'));
		newGoal.dispatch('click');
		expect(only(find(walk(goalForm), 'button').filter((button) => button.type === 'submit')).textContent).toBe('Añadir objetivo');
		const exceptionEdit = only(find(mount.elements(), 'button').filter((button) => button.attributes.get('aria-label') === 'Editar excepción del objeto 12'));
		exceptionEdit.dispatch('click');
		const exceptionInputs = find(walk(exceptionForm), 'input');
		const exceptionSelects = find(walk(exceptionForm), 'select');
		expect(exceptionSelects.at(-1)?.value).toBe('all');
		expect(exceptionInputs[0]?.disabled).toBe(false);
		expect(exceptionInputs[1]?.disabled).toBe(true);
		exceptionForm.dispatch('submit');
		expect(callbacks.upsertException).toHaveBeenCalledWith(expect.objectContaining({ exceptionId: 'exception-existing', quantity: { mode: 'all' } }));
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, readyModel(), createTranslator('es'), undefined, interactions);
		expect(exceptionInputs[1]?.disabled).toBe(true);
		const newException = only(find(walk(exceptionForm), 'button').filter((button) => button.textContent === 'Nueva excepción'));
		newException.dispatch('click');
		expect(exceptionInputs[1]?.disabled).toBe(false);
		expect(exceptionInputs[1]?.required).toBe(true);
		expect(only(find(walk(exceptionForm), 'button').filter((button) => button.type === 'submit')).textContent).toBe('Añadir excepción');
		const goalRemove = only(find(mount.elements(), 'button').filter((button) => button.attributes.get('aria-label') === 'Quitar objetivo goal-existing'));
		goalRemove.dispatch('click'); await Promise.resolve();
		expect(callbacks.removeGoal).toHaveBeenCalledWith('goal-existing');
		expect(mount.document.activeElement).toBe(load);
		preferences = { status: 'conflict', goals: [preferenceGoal('goal-existing')], keepExceptions: [preferenceException('exception-existing', 'all')] };
		goalInputs[0]!.value = 'Draft preserved';
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, readyModel(), createTranslator('es'), undefined, interactions);
		expect(goalInputs[0]?.value).toBe('Draft preserved');
		expect(exceptionInputs[1]?.disabled).toBe(true);
		expect(only(find(mount.elements(), 'button').filter((button) => button.attributes.get('aria-label') === 'Quitar objetivo goal-existing')).disabled).toBe(true);
		expect(only(find(mount.elements(), 'button').filter((button) => button.attributes.get('aria-label') === 'Editar objetivo goal-existing')).disabled).toBe(true);
		preferences = { status: 'ready', goals: [preferenceGoal('goal-existing')], keepExceptions: [preferenceException('exception-existing', 'minimum')] };
		preferencesBusy = true;
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, readyModel(), createTranslator('es'), undefined, interactions);
		expect(exceptionInputs[1]?.disabled).toBe(true);
		preferencesBusy = false;
		const beforeLocale = text(mount.elements());
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, readyModel(), createTranslator('en'), undefined, interactions);
		expect(beforeLocale).toContain('ID del objeto 10');
		expect(text(mount.elements())).toContain('Item ID 10');
		expect(text(mount.elements())).not.toMatch(/vault-hash|account-a|generation/u);
	});

	it('renders durable inventory controls without capturing or applying until an explicit click', () => {
		const preview = vi.fn();
		const apply = vi.fn();
		const mount = render(readyModel(), 'es', {
			inventorySync: {
				state: { status: 'idle' }, canApply: false, assetsInstalled: false,
				onPreview: preview, onApply: apply,
			},
		});
		const section = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync'));
		const status = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-status'));
		const [previewButton, applyButton] = find(walk(section), 'button');
		expect(section.hidden).toBe(false);
		expect(status.attributes.get('aria-live')).toBe('polite');
		expect(text(walk(section))).toContain('Abrir esta vista no lee la cuenta ni escribe notas.');
		expect(text(walk(section))).toContain('Instala o actualiza los assets gestionados');
		expect(preview).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		previewButton!.dispatch('click');
		expect(preview).toHaveBeenCalledOnce();
		expect(applyButton!.disabled).toBe(true);
		expect(apply).not.toHaveBeenCalled();
	});

	it('exposes loading, preview, applying, success, error, conflict and disabled sync states accessibly', () => {
		const summary = { positions: 2, create: 1, update: 0, unchanged: 0, deactivate: 1, conflicts: 0 };
		for (const [state, canApply, busy, alert, previewDisabled, applyDisabled] of [
			[{ status: 'loading' }, false, true, false, true, true],
			[{ status: 'preview', summary }, true, false, false, false, false],
			[{ status: 'applying', summary }, false, true, false, true, true],
			[{ status: 'success', summary, result: { status: 'applied', created: 1, updated: 0, deactivated: 1 } }, false, false, false, false, true],
			[{ status: 'error', reason: 'capture_unavailable' }, false, false, true, false, true],
			[{ status: 'conflict', summary }, false, false, true, false, true],
			[{ status: 'disabled', reason: 'missing_key' }, false, false, true, true, true],
		] as const) {
			const mount = render(readyModel(), 'en', {
				inventorySync: { state, canApply, assetsInstalled: true, onPreview: vi.fn(), onApply: vi.fn() },
			});
			const section = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync'));
			const status = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-status'));
			const [previewButton, applyButton] = find(walk(section), 'button');
			expect(section.attributes.get('aria-busy')).toBe(String(busy));
			expect(status.attributes.has('role')).toBe(alert);
			expect(previewButton?.attributes.get('aria-label')).toBe('Preview sync');
			expect(applyButton?.attributes.get('aria-label')).toBe('Sync to Vault');
			expect(previewButton?.disabled).toBe(previewDisabled);
			expect(applyButton?.disabled).toBe(applyDisabled);
			expect(text(walk(section))).not.toMatch(/account-|token-|RAW_/u);
		}
	});
});

function render(model: InventoryAdvisorViewModel, locale: 'es' | 'en' = 'es', interactions: InventoryAdvisorViewInteractions = {}) {
	const mount = createMount();
	renderInventoryAdvisorView(mount.container as unknown as HTMLElement, model, createTranslator(locale), undefined, interactions);
	const section = mount.container.children[0];
	if (!section) throw new Error('Expected a rendered Inventory Advisor section.');
	return { ...mount, section, elements: () => walk(mount.container) };
}

function createMount(): { container: FakeElement; document: FakeDocument } {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, document));
	vi.stubGlobal('createDiv', () => new FakeElement('div', document));
	vi.stubGlobal('createSpan', () => new FakeElement('span', document));
	return { container: new FakeElement('div', document), document };
}

function readyModel(): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		optionalSources: {
			bank: { status: 'complete' }, materials: { status: 'complete' }, delivery: { status: 'complete' },
		},
		groups: [{ key: 'review', rows: [
			row({ itemId: 100, name: 'Material seguro', action: 'sell' }),
			row({ itemId: 200, name: 'Resto sin valor', action: 'discard_review', coverage: coverage('limited'), irreversibleReviewOnly: true,
				discardProof: { itemId: 200, explanationRef: '#/explanations/200/0', producerResultSha256: 'a'.repeat(64), discardRuleId: 'discard-200', discardRuleSourceIds: ['source'], assertionIds: { use: 'use-200', open: 'open-200', salvage: 'salvage-200' }, assertionSourceIds: { use: ['source'], open: ['source'], salvage: ['source'] } } }),
		] }],
	};
}

function twoCharacterModel(): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		optionalSources: {
			bank: { status: 'complete' }, materials: { status: 'complete' }, delivery: { status: 'complete' },
		},
		groups: [{ key: 'market', rows: [
			row({ id: '#/explanations/10/0', itemId: 10, name: 'De Astra', action: 'sell', quantity: 2,
				allocations: [{ positionRef: '#/positions/10/0', quantity: 2, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } }] }),
			row({ id: '#/explanations/11/0', itemId: 11, name: 'De Borja', action: 'sell', quantity: 4,
				allocations: [{ positionRef: '#/positions/11/0', quantity: 4, location: { source: 'character', character: 'Borja', container: 'bag', bagIndex: 1, slot: 2 } }] }),
		] }],
	};
}

function allStatesAndActionsModel(): InventoryAdvisorViewModel {
	const actions: readonly InventoryAdvisorViewAction[] = ['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review'];
	return {
		status: 'limited', title: 'inventory_advisor.title', detail: 'inventory_advisor.limited',
		optionalSources: {
			bank: { status: 'complete' }, materials: { status: 'complete' }, delivery: { status: 'complete' },
		},
		groups: [{ key: 'review', rows: actions.map((action, index) => row({
			itemId: index + 1,
			name: index === 0 ? `Objeto extenso ${'x'.repeat(320)}` : `Objeto ${String(index + 1)}`,
			action,
			coverage: coverage(index % 3 === 0 ? 'complete' : index % 3 === 1 ? 'limited' : 'unknown'),
		})) }],
	};
}

function row(overrides: Partial<InventoryAdvisorViewRow>): InventoryAdvisorViewRow {
	const itemId = overrides.itemId ?? 1;
	return {
		id: '#/explanations/1/0', itemId, name: 'Object', icon: null, ownedQuantity: 5, availableQuantity: 3,
		action: 'review', quantity: 3,
		allocations: [allocation(`#/positions/${String(itemId)}/0`, 3)],
		reasonCodes: ['rule_missing'], value: { status: 'unavailable', route: null },
		coverage: coverage('complete'), irreversibleReviewOnly: false, discardProof: null,
		...overrides,
	};
}

function allocation(positionRef: string, quantity: number): InventoryAdvisorViewRow['allocations'][number] {
	return { positionRef, quantity, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } };
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
	readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
	className = '';
	id = '';
	scope = '';
	colSpan = 1;
	textContent: string | null = null;
	type = '';
	value = '';
	placeholder = '';
	disabled = false;
	required = false;
	selected = false;
	checked = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} }); }
	focus(): void { this.ownerDocument.activeElement = this; }
}

function preferenceGoal(goalId: string) {
	return { schemaVersion: 1 as const, goalId, title: goalId, status: 'active' as const, priority: 1, reason: 'personal' as const,
		requirements: [{ key: 'item:10', namespace: 'item' as const, id: 10, targetQuantity: 2, creditedQuantity: 2, basis: 'available' as const, intendedUse: 'hold' as const }] };
}

function preferenceException(exceptionId: string, mode: 'all' | 'minimum') {
	return { version: 1 as const, exceptionId, itemId: 12, status: 'active' as const, basis: 'available' as const,
		quantity: mode === 'all' ? { mode: 'all' as const } : { mode: 'minimum' as const, value: 1 }, reason: 'user_keep' as const };
}
