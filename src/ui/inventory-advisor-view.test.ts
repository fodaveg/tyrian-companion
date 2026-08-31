import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import {
	createInventoryAdvisorFixturePort,
	filterInventoryAdvisorRows,
	formatInventoryAdvisorLocation,
	groupInventoryAdvisorRows,
	inventoryAdvisorCharacters,
	inventoryAdvisorValueConcentration,
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
import type { InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';
import { ambientCapabilityUse } from '../test/ambient-capabilities';

afterEach(() => vi.unstubAllGlobals());

describe('Inventory Advisor view', () => {
	it.each([
		['es', 'Economía de reciclaje de equipo', 'No incluido: faltan segundos por objeto',
			'Límite inferior: materiales base, suerte y mejoras recicladas están excluidos'],
		['en', 'Equipment salvage economics', 'Excluded: seconds per item',
			'Lower bound: base materials, luck, and salvaged upgrades are excluded'],
	] as const)('discloses the lower-bound salvage EV and missing optional time preference in %s',
		(locale, title, time, excluded) => {
			const mount = render(equipmentSalvageModel(), locale);
			const copy = text(mount.elements());
			expect(copy).toContain(title);
			expect(copy).toContain('rare-equipment-68-ecto-v1');
			expect(copy).toContain(time);
			expect(copy).toContain(excluded);
			expect(copy).toContain('gw2-wiki-ecto-yield');
			expect(byClass(mount.elements(), 'tyrian-inventory-advisor__advanced-filters')).toHaveLength(1);
			expect(find(mount.elements(), 'details')).toHaveLength(3);
		});

	it('renders the Exotic uncertainty as review without a numeric EV', () => {
		const model = equipmentSalvageModel();
		model.groups[0]!.rows[0]!.action = 'review';
		model.groups[0]!.rows[0]!.equipmentSalvage = {
			status: 'review', reason: 'exotic_output_rate_unverified',
			ruleId: 'exotic-equipment-68-review-v1',
			sourceIds: ['gw2-wiki-exotic-equipment-2060139'],
		};
		const mount = render(model, 'es');
		const review = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox').at(-1);
		if (review === undefined) throw new Error('Expected the review visibility option.');
		review.checked = true;
		review.dispatch('change');
		const copy = text(mount.elements());
		expect(copy).toContain('no hay una tasa específica trazable para recomendar');
		expect(copy).not.toContain('EV neto de reciclaje');
	});

	it.each([
		['es', 'Compara venta instantánea, publicación y mercader con precios actuales.'],
		['en', 'Compares instant sell, listing and vendor routes with current prices.'],
	] as const)('shows the honest liquid-route banner in %s', (locale, expected) => {
		const mount = render(readyModel(), locale);
		expect(text(mount.elements())).toContain(expected);
	});

	it.each([
		['es', 'EV líquido por bolsa', 'Pendiente: faltan 9 de 10 valores manuales', 'margen del 10%',
			'Solo líquida: Abrir · personal pendiente', 'EV líquido; la valoración personal no está completa'],
		['en', 'Liquid EV per bag', 'Pending: 9 of 10 manual values missing', 'with a 10% margin',
			'Liquid-only: Open · personal pending', 'Liquid EV; personal valuation is incomplete'],
	] as const)('discloses liquid EV and a partial personal lower bound without a personal decision in %s',
		(locale, liquid, pending, threshold, decisions, basis) => {
			const model = economyModel(personalDisclosure('partial', false));
			const mount = render(model, locale);
			const copy = text(mount.elements());
			expect(copy).toContain(liquid);
			expect(copy).toContain(pending);
			expect(copy).toContain(threshold);
			expect(copy).toContain(decisions);
			expect(copy).toContain(basis);
			expect(copy).toContain(locale === 'es' ? 'límite inferior, no como total' : 'lower bound, not a total');
		});

	it('shows both decisions when complete personal EV changes the primary recommendation', () => {
		const mount = render(economyModel(personalDisclosure('complete', true)), 'es');
		const copy = text(mount.elements());
		expect(copy).toContain('Líquida: Vender ya · personal: Abrir');
		expect(copy).toContain('EV personal completo');
		expect(copy).not.toContain('límite inferior, no como total');
		expect(copy).toContain('La cola rara y los jackpots agregados (1171 unidades de muestra) permanecen sin valorar.');
		expect(copy).toContain('1484,56789 cobre esperado');
	});

	it.each([
		['es', 'Sin valores manuales todavía; no equivale a un ajuste conocido de cero'],
		['en', 'No manual values yet; this is not a known zero adjustment'],
	] as const)('does not present absent personal values as a known zero in %s', (locale, expected) => {
		const disclosure = personalDisclosure('partial', false);
		disclosure.personal.valuation.coverage = 'none';
		disclosure.personal.valuation.lines = [];
		disclosure.personal.valuation.unvalued = Array.from({ length: 10 }, (_, index) => ({
			outcomeKey: `item:${String(36_031 + index)}`,
			label: `Outcome ${String(index)}`,
			expectedUnitsMillionths: 1,
		}));
		const copy = text(render(economyModel(disclosure), locale).elements());
		expect(copy).toContain(expected);
		expect(copy).not.toContain(locale === 'es' ? '0 cobre esperado como límite inferior' : '0 expected copper as a lower bound');
	});

	it.each([[479, 'cards'], [480, 'cards'], [759, 'cards'], [760, 'table']] as const)(
		'selects the semantic H5.11 layout at %ipx',
		(width, expected) => expect(inventoryAdvisorViewLayout(width)).toBe(expected),
	);

	it('keeps the complete card evidence surface visible at both 480px and 759px breakpoints', () => {
		const styles = readFileSync('styles.css', 'utf8');
		const cardsRule = styles.indexOf('.tyrian-inventory-advisor__cards {\n\t\tdisplay: grid;');
		expect(cardsRule).toBeGreaterThan(-1);
		const breakpoint = styles.lastIndexOf('@container (max-width: 759px)', cardsRule);
		const compact = styles.slice(breakpoint, styles.indexOf('@container (max-width: 479px)', breakpoint));
		expect(compact).toMatch(/tyrian-inventory-advisor__table[\s\S]*display:\s*none/u);
		expect(compact).toMatch(/tyrian-inventory-advisor__cards[\s\S]*display:\s*grid/u);
		for (const width of [480, 759]) expect(inventoryAdvisorViewLayout(width)).toBe('cards');
	});

	it.each([['es', 'Filtros avanzados'], ['en', 'Advanced filters']] as const)(
		'keeps search and sort visible before one folded advanced-filter disclosure in %s',
		(locale, disclosure) => {
			const mount = render(readyModel(), locale);
			const controls = only(byClass(mount.elements(), 'tyrian-inventory-advisor__controls'));
			expect(controls.children.map((child) => child.tag)).toEqual(['label', 'label', 'details']);
			expect(controlWithLabel(walk(controls), 'input', createTranslator(locale).t('advisor.view.search')).disabled).toBe(false);
			expect(controlWithLabel(walk(controls), 'select', createTranslator(locale).t('advisor.view.sort')).disabled).toBe(false);
			const advanced = only(byClass(walk(controls), 'tyrian-inventory-advisor__advanced-filters'));
			expect(advanced.attributes.has('open')).toBe(false);
			expect(advanced.children[0]?.textContent).toBe(disclosure);
			const styles = readFileSync('styles.css', 'utf8');
			expect(styles).toMatch(/tyrian-inventory-advisor__advanced-filters summary\s*\{[\s\S]*?min-height:\s*44px;/u);
			expect(styles).toMatch(/@container \(max-width: 479px\)[\s\S]*?advanced-filters-content > label[\s\S]*?width:\s*100%;/u);
		},
	);

	it('moves a fresh manual queue before sync, history, and preferences, then restores maintenance-first loading order', () => {
		const interactions: InventoryAdvisorViewInteractions = {
			onLoadPreferences: vi.fn(),
			inventorySync: {
				state: { status: 'idle', lastRun: null }, assetsInstalled: true,
				onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		};
		const mount = render(readyModel(), 'es', interactions);
		expect(mount.section.children.slice(3).map((child) => child.className)).toEqual([
			'tyrian-inventory-advisor__analysis',
			'tyrian-inventory-advisor__operations',
			'tyrian-inventory-advisor__preferences',
		]);
		expect(text(walk(mount.section.children[3]!))).toContain('Qué hacer ahora');

		renderInventoryAdvisorView(
			mount.container as unknown as HTMLElement,
			{ ...readyModel(), status: 'loading', groups: [] },
			createTranslator('es'), undefined, interactions,
		);
		expect(mount.section.children.slice(3).map((child) => child.className)).toEqual([
			'tyrian-inventory-advisor__operations',
			'tyrian-inventory-advisor__preferences',
			'tyrian-inventory-advisor__analysis',
		]);
	});

	it('uses native disabled controls and busy semantics while loading, then restores the same controls', () => {
		const model = { ...readyModel(), status: 'loading' as const, contentVersion: 8 };
		const mount = render(model);
		const controls = only(byClass(mount.elements(), 'tyrian-inventory-advisor__controls'));
		expect(controls.attributes.get('aria-disabled')).toBe('true');
		expect(controls.attributes.get('aria-busy')).toBe('true');
		expect(find(walk(controls), 'input').every((control) => control.disabled)).toBe(true);
		expect(find(walk(controls), 'select').every((control) => control.disabled)).toBe(true);
		expect(only(find(walk(controls), 'fieldset')).disabled).toBe(true);
		expect(only(byClass(mount.elements(), 'tyrian-inventory-advisor__results')).children).toEqual([]);

		renderInventoryAdvisorView(
			mount.container as unknown as HTMLElement,
			{ ...readyModel(), contentVersion: 8 }, createTranslator('es'),
		);
		expect(controls.attributes.has('aria-disabled')).toBe(false);
		expect(controls.attributes.get('aria-busy')).toBe('false');
		expect(find(walk(controls), 'input').every((control) => !control.disabled)).toBe(true);
		expect(find(walk(controls), 'select').every((control) => !control.disabled)).toBe(true);
		expect(only(find(walk(controls), 'fieldset')).disabled).toBe(false);
		expect(byClass(mount.elements(), 'tyrian-inventory-advisor__recommendation-summary')).toHaveLength(1);
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
		const action = controlWithLabel(mount.elements(), 'select', 'Filtrar acción');
		const group = controlWithLabel(mount.elements(), 'select', 'Agrupar por');
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

	it('renders and drives its filters without reaching for a timer, network, storage or plugin global', async () => {
		const observed: string[] = [];
		const used = await ambientCapabilityUse(() => {
			const mount = render(readyModel());
			const search = only(find(mount.elements(), 'input').filter((input) => input.type === 'search'));
			const action = controlWithLabel(mount.elements(), 'select', 'Filtrar acción');
			const group = controlWithLabel(mount.elements(), 'select', 'Agrupar por');
			search.value = 'material';
			search.dispatch('input');
			action.value = 'sell';
			action.dispatch('change');
			group.value = 'evidence';
			group.dispatch('change');
			observed.push(only(byClass(mount.elements(), 'tyrian-inventory-advisor__state')).textContent ?? '');
			const portMount = createMount();
			renderInventoryAdvisorViewFromPort(
				portMount.container as unknown as HTMLElement,
				createInventoryAdvisorFixturePort(readyModel()),
				createTranslator('en'),
			);
			observed.push(portMount.container.children[0]?.attributes.get('aria-label') ?? '');
		});
		expect(used).toEqual([]);
		expect(observed).toEqual([
			'Estas son las mejores acciones conocidas. Nada se ejecuta automáticamente.', 'Inventory advisor',
		]);
	});

	it('keeps discard reviews out of the filter while rendering an explicit warning-only proof surface if wired', () => {
		const mount = render(readyModel());
		const action = controlWithLabel(mount.elements(), 'select', 'Filtrar acción');
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
			expect(mount.section.attributes.get('aria-busy')).toBe(String(status === 'loading'));
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
		const characterSelect = controlWithLabel(mount.elements(), 'select', 'Personaje');
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

	it('uses one price-or-fallback contract for row totals, unit values, and aggregate value', () => {
		const model: InventoryAdvisorViewModel = {
			...readyModel(),
			groups: [{ key: 'market', rows: [
				row({ itemId: 1, name: 'Con precio', action: 'sell', quantity: 3, value: { status: 'available', route: 'instant_sell', copper: 123 } }),
				row({ itemId: 2, name: 'Sin precio', action: 'sell', quantity: 3, value: { status: 'unavailable', route: null } }),
				row({ itemId: 3, name: 'No aplica', action: 'sell', quantity: 3, value: { status: 'not_applicable', route: null } }),
			] }],
		};
		const mount = render(model);
		const rowText = (name: string): string => {
			const tableRow = find(mount.elements(), 'tr').find((candidate) => text(walk(candidate)).includes(name));
			if (tableRow === undefined) throw new Error(`Missing table row ${name}.`);
			return text(walk(tableRow));
		};
		expect(rowText('Con precio')).toContain('0 oro · 0 plata · 41 cobre');
		expect(rowText('Con precio')).toContain('0 oro · 1 plata · 23 cobre');
		expect(rowText('Sin precio').match(/No disponible/gu)).toHaveLength(2);
		expect(rowText('No aplica').match(/No aplica/gu)?.length).toBeGreaterThanOrEqual(2);
		expect(text(mount.elements())).toContain('Valor conocido: 0 oro · 1 plata · 23 cobre');
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
			expect.arrayContaining(['Subtotal · 2 objetos', '10', '0 oro · 10 plata · 0 cobre']),
		);
		const sortSelect = controlWithLabel(mount.elements(), 'select', 'Ordenar por');
		sortSelect.value = 'quantity_desc';
		sortSelect.dispatch('change');
		expect(find(mount.elements(), 'article').map((card) => walk(card).some((element) => element.textContent === 'Bajo valor')))
			.toEqual([true, false]);
	});

	it('puts the rows that free the most occupied slots before high-gold rows in the default priority', () => {
		const valuable = row({
			id: '#/explanations/1/0', itemId: 1, name: 'Mucho oro', action: 'sell',
			value: { status: 'available', route: 'instant_sell', copper: 1_000_000 },
		});
		const deadWeight = row({
			id: '#/explanations/2/0', itemId: 2, name: 'Tres huecos', action: 'review', quantity: 30,
			allocations: [
				allocation('#/positions/2/0', 10), allocation('#/positions/2/1', 10), allocation('#/positions/2/2', 10),
			],
			burden: { kind: 'unclassified', quantity: 30, occupiedSlots: 3 },
		});
		const oneSlot = row({
			id: '#/explanations/3/0', itemId: 3, name: 'Un hueco', action: 'keep', quantity: 250,
			burden: { kind: 'retained', quantity: 250, occupiedSlots: 1 },
		});

		expect(sortInventoryAdvisorRows([valuable, oneSlot, deadWeight], 'value_desc', 'es')
			.map((entry) => entry.itemId)).toEqual([2, 3, 1]);
	});

	it('shows value concentration in value-desc order against the existing visible total', () => {
		const rows = [
			row({ id: '#/explanations/1/0', itemId: 1, name: 'Top', action: 'sell',
				value: { status: 'available', route: 'instant_sell', copper: 900 } }),
			row({ id: '#/explanations/2/0', itemId: 2, name: 'Tail', action: 'sell',
				value: { status: 'available', route: 'instant_sell', copper: 100 } }),
		];
		expect([...inventoryAdvisorValueConcentration(rows)]).toEqual([
			['#/explanations/1/0', { shareBasisPoints: 9_000, cumulativeBasisPoints: 9_000 }],
			['#/explanations/2/0', { shareBasisPoints: 1_000, cumulativeBasisPoints: 10_000 }],
		]);
		const mount = render({ ...readyModel(), groups: [{ key: 'market', rows }] });
		expect(text(mount.elements())).toContain('90% del valor conocido · 90% acumulado');
		expect(text(mount.elements())).toContain('10% del valor conocido · 100% acumulado');
	});

	it('renders concrete protection, occupied burden, and only demonstrated sell-vs-list values in both locales', () => {
		const model: InventoryAdvisorViewModel = {
			...readyModel(),
			groups: [{ key: 'market', rows: [row({
				id: '#/explanations/1/0', itemId: 1, name: 'Comparable', action: 'list',
				value: { status: 'available', route: 'listing', copper: 51 },
				marketComparison: {
					instantSellCopper: 34, listingCopper: 51,
					differenceCopper: 17, differenceBasisPoints: 5_000,
				},
			})] }, { key: 'keep', rows: [row({
				id: '#/explanations/2/0', itemId: 2, name: 'Reservado', action: 'keep',
				protectionReasons: [{
					kind: 'reservation_goal', id: 'goal', title: 'Legendaria', quantity: 4,
					reason: 'achievement', basis: 'available', intendedUse: 'exchange',
				}],
			})] }, { key: 'review', rows: [row({
				id: '#/explanations/3/0', itemId: 3, name: 'Pendiente', action: 'review',
				burden: { kind: 'unclassified', quantity: 3, occupiedSlots: 1 },
			})] }],
		};
		for (const locale of ['es', 'en'] as const) {
			const mount = render(model, locale);
			const contextOptions = find(mount.elements(), 'input').filter((input) => input.type === 'checkbox').slice(-2);
			for (const input of contextOptions) { input.checked = true; input.dispatch('change'); }
			const allText = text(mount.elements());
			if (locale === 'es') {
				expect(allText).toContain('Reserva: Legendaria');
				expect(allText).toContain('4 unidades · Logro · base Disponible · destino Canjear');
				expect(allText).toContain('Pendiente sin clasificar');
				expect(allText).toContain('1 huecos ocupados · 3 unidades');
				expect(allText).toContain('Diferencia al publicar');
				expect(allText).toContain('+0 oro · 0 plata · 17 cobre (+50%)');
			} else {
				expect(allText).toContain('Reservation: Legendaria');
				expect(allText).toContain('4 units · Achievement · Available basis · intended for Exchange');
				expect(allText).toContain('Pending classification');
				expect(allText).toContain('1 occupied slots · 3 units');
				expect(allText).toContain('Listing difference');
				expect(allText).toContain('+0 gold · 0 silver · 17 copper (+50%)');
			}
		}
	});

	it('keeps three readable evidence states in normal mode and the exact axes in an advanced disclosure', () => {
		const mount = render({
			...readyModel(),
			groups: [{ key: 'market', rows: [row({
				itemId: 7, name: 'Parcial', action: 'sell',
				coverage: { ...coverage('complete'), prices: 'limited', rules: 'unknown' },
			})] }],
		});
		const details = find(mount.elements(), 'details');
		expect(details.length).toBeGreaterThan(0);
		expect(details.some((entry) => walk(entry).some((element) => element.textContent === 'Detalles técnicos'))).toBe(true);
		expect(details.some((entry) => walk(entry).some((element) => element.textContent === 'Limitada (precios, reglas)'))).toBe(true);
	});

	it('removes stack noise and combines owned and available quantities in table and card layouts', () => {
		const model = readyModel();
		model.groups[0]!.rows[0]!.reasonCodes = ['position_not_actionable'];
		const mount = render(model);
		const columnLabels = find(mount.elements(), 'th')
			.filter((element) => element.scope === 'col')
			.map((element) => element.textContent);
		expect(columnLabels).toHaveLength(9);
		expect(columnLabels).not.toContain('Pilas');
		expect(columnLabels).not.toContain('Disponible');
		expect(text(mount.elements())).toContain('3 (0 disponibles)');
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

	it('names recommendation summaries as non-executing list filters and handles zero, one, and many types', () => {
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
		expect(allText).toContain('Objetos distintos: 3 · Unidades: 9');
		expect(allText).not.toContain('Pilas:');
		expect(allText).toContain('Valor conocido: 3 oro · 74 plata · 44 cobre');
		expect(allText).toContain('Todos los objetos visibles tienen precio demostrado.');
		expect(allText).toContain('Estos resúmenes solo filtran la lista; no ejecutan acciones.');
		expect(allText).toContain('Ver 1 tipo: Vender ya');
		expect(allText).toContain('Ver 1 tipo: Publicar en el bazar');
		expect(allText).toContain('Ver 1 tipo: Vender al mercader');
		expect(allText).not.toContain('Context only');
		const summaryButtons = byClass(mount.elements(), 'tyrian-inventory-advisor__recommendation-action');
		expect(summaryButtons).toHaveLength(3);
		expect(summaryButtons.every((button) => !button.className.includes('mod-cta'))).toBe(true);
		const sell = only(summaryButtons.filter((button) => walk(button).some((element) => element.textContent === 'Ver 1 tipo: Vender ya')));
		sell.dispatch('click');
		const action = controlWithLabel(mount.elements(), 'select', 'Filtrar acción');
		expect(action.value).toBe('sell');
		expect(mount.document.activeElement).toBe(action);
		expect(find(mount.elements(), 'article')).toHaveLength(1);
		const pressed = only(byClass(mount.elements(), 'tyrian-inventory-advisor__recommendation-action')
			.filter((button) => button.attributes.get('aria-pressed') === 'true'));
		expect(walk(pressed).some((element) => element.textContent === 'Ver 1 tipo: Vender ya')).toBe(true);

		const many = render({
			...readyModel(),
			groups: [{ key: 'market', rows: [
				row({ id: '#/explanations/10/0', itemId: 10, name: 'One', action: 'sell' }),
				row({ id: '#/explanations/11/0', itemId: 11, name: 'Two', action: 'sell' }),
			] }],
		});
		expect(text(many.elements())).toContain('Ver 2 tipos: Vender ya');
		const empty = render({ ...readyModel(), groups: [] });
		expect(byClass(empty.elements(), 'tyrian-inventory-advisor__recommendation-summary')).toEqual([]);
		expect(text(empty.elements())).toContain('No hay acciones directas.');
	});

	it('renders only trusted GW2 item icons', () => {
		const model = allStatesAndActionsModel();
		model.groups[0]!.rows[0]!.icon = 'https://render.guildwars2.com/file/abc.png';
		model.groups[0]!.rows[1]!.icon = 'https://render.guildwars2.com:444/file/port.png';
		model.groups[0]!.rows[2]!.icon = 'https://user@render.guildwars2.com/file/credentials.png';
		const mount = render(model);
		const images = find(mount.elements(), 'img');
		expect(images).toHaveLength(2);
		expect(new Set(images.map((image) => image.attributes.get('src')))).toEqual(new Set(['https://render.guildwars2.com/file/abc.png']));
		expect(images.every((image) => image.attributes.get('alt') === '')).toBe(true);
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

	it('renders the one guided button and its advance notice without capturing or writing until an explicit click', () => {
		const onRun = vi.fn();
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const mount = render(readyModel(), 'es', {
			inventorySync: {
				state: { status: 'idle', lastRun: null }, assetsInstalled: false,
				onRun, onConfirm, onCancel,
			},
		});
		const section = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync'));
		const statusPanel = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-status'));
		expect(section.hidden).toBe(false);
		expect(statusPanel.attributes.get('aria-live')).toBe('polite');
		expect(text(walk(section))).toContain('Abrir esta vista no lee la cuenta ni escribe notas.');
		expect(text(walk(section))).toContain('Instala o actualiza los assets gestionados');
		const button = only(find(walk(section), 'button').filter((candidate) => walk(candidate).some((element) => element.textContent === 'Sincronizar inventario')));
		expect(button.disabled).toBe(false);
		expect(button.attributes.get('aria-label')).toBe('Sincronizar inventario');
		const confirmPanel = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-confirm'));
		expect(confirmPanel.hidden).toBe(true);
		expect(onRun).not.toHaveBeenCalled();
		button.dispatch('click');
		expect(onRun).toHaveBeenCalledOnce();
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('offers a neutral analysis-only action with accessible idle, loading, and disabled states', () => {
		const onAnalyze = vi.fn();
		const onRun = vi.fn();
		const interactions: InventoryAdvisorViewInteractions = {
			inventorySync: {
				state: { status: 'idle', lastRun: null }, assetsInstalled: true,
				analysisBusy: false, onAnalyze, onRun, onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		};
		const mount = render(readyModel(), 'es', interactions);
		const analysis = only(find(mount.elements(), 'button').filter((button) => button.textContent === 'Analizar sin escribir'));
		expect(analysis.className).not.toContain('mod-cta');
		expect(analysis.attributes.get('aria-label')).toBe('Analizar sin escribir');
		expect(analysis.disabled).toBe(false);
		analysis.dispatch('click');
		expect(onAnalyze).toHaveBeenCalledOnce();
		expect(onRun).not.toHaveBeenCalled();

		interactions.inventorySync!.analysisBusy = true;
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, { ...readyModel(), status: 'loading' }, createTranslator('es'), undefined, interactions);
		expect(analysis.textContent).toBe('Analizando…');
		expect(analysis.disabled).toBe(true);

		interactions.inventorySync!.analysisBusy = false;
		interactions.inventorySync!.state = { status: 'disabled', reason: 'missing_key' };
		renderInventoryAdvisorView(mount.container as unknown as HTMLElement, readyModel(), createTranslator('es'), undefined, interactions);
		expect(analysis.disabled).toBe(true);
	});

	it('pauses for explicit confirmation on a destructive plan, disables the button, and forwards confirm/cancel only from their own controls', () => {
		const onRun = vi.fn();
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const summary = { positions: 3, create: 1, update: 1, unchanged: 0, deactivate: 1, conflicts: 0 };
		const mount = render(readyModel(), 'es', {
			inventorySync: { state: { status: 'confirm', summary }, assetsInstalled: true, onRun, onConfirm, onCancel },
		});
		const section = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync'));
		const runButton = only(find(walk(section), 'button').filter((candidate) => walk(candidate).some((element) => element.textContent === 'Sincronizar inventario')));
		expect(runButton.disabled).toBe(true);
		const confirmPanel = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-confirm'));
		expect(confirmPanel.hidden).toBe(false);
		expect(text(walk(confirmPanel))).toContain('desactivará 1 filas');
		expect(text(walk(confirmPanel))).toContain('3 filas · 1 nuevas · 1 actualizadas · 0 sin cambios · 1 inactivas · 0 conflictos');
		const confirmButton = only(find(walk(confirmPanel), 'button').filter((candidate) => candidate.textContent === 'Confirmar y escribir'));
		const cancelButton = only(find(walk(confirmPanel), 'button').filter((candidate) => candidate.textContent === 'Cancelar'));
		confirmButton.dispatch('click');
		expect(onConfirm).toHaveBeenCalledOnce();
		cancelButton.dispatch('click');
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onRun).not.toHaveBeenCalled();
	});

	it('stops at conflict without an apply path, still allows a retry click, and never leaks a raw secret', () => {
		const summary = { positions: 2, create: 1, update: 0, unchanged: 0, deactivate: 0, conflicts: 1 };
		for (const [state, alert, buttonDisabled, tone] of [
			[{ status: 'running', phase: 'capture', percent: 0, completed: null, total: null, captureStep: null, captureLeg: null, elapsedMs: 12_000 }, false, true, 'normal'],
			[{ status: 'confirm', summary: { ...summary, conflicts: 0, deactivate: 1 } }, false, true, 'normal'],
			// A real conflict cannot be applied, but the button still allows the user to retry after resolving it manually.
			[{ status: 'conflict', summary }, true, false, 'normal'],
			[{ status: 'disabled', reason: 'missing_key' }, true, true, 'normal'],
			[{ status: 'idle', lastRun: { status: 'success', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 1, summary, error: null } }, false, false, 'success'],
			[{ status: 'idle', lastRun: { status: 'error', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 1, summary: null, error: 'write_unavailable' } }, true, false, 'error'],
		] as const) {
			const mount = render(readyModel(), 'en', {
				inventorySync: { state, assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() },
			});
			const section = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync'));
			const statusPanel = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-status'));
			const statusTitle = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync-status-title'));
			const button = only(find(walk(section), 'button').filter((candidate) => walk(candidate).some((element) => element.textContent === 'Sync inventory' || element.textContent === 'Syncing…')));
			expect(statusPanel.attributes.has('role')).toBe(alert);
			expect(button.disabled).toBe(buttonDisabled);
			expect(statusTitle.attributes.get('data-tone')).toBe(tone);
			expect(text(walk(section))).not.toMatch(/account-|token-|RAW_/u);
		}
	});

	it('paints the live percent and phase from the run state alone, never from a timer', () => {
		const running = render(readyModel(), 'es', {
			inventorySync: {
				state: {
					status: 'running', phase: 'classification', percent: 40, completed: null, total: null,
					captureStep: null, captureLeg: null, elapsedMs: 48_000,
				},
				assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		});
		const runningPanel = only(byClass(running.elements(), 'tyrian-inventory-advisor__sync-status'));
		const progress = only(find(walk(runningPanel), 'progress'));
		expect(progress.value).toBe(40);
		expect(text(walk(runningPanel))).toContain('40%');
		// The elapsed time is a real clock measurement, shown next to the percent.
		expect(text(walk(runningPanel))).toContain('48 s');

		const applying = render(readyModel(), 'es', {
			inventorySync: {
				state: {
					status: 'running', phase: 'apply', percent: 90, completed: 9, total: 10,
					captureStep: null, captureLeg: null, elapsedMs: 9_000,
				},
				assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		});
		const applyingPanel = only(byClass(applying.elements(), 'tyrian-inventory-advisor__sync-status'));
		const applyingProgress = only(find(walk(applyingPanel), 'progress'));
		expect(applyingProgress.value).toBe(90);
		expect(text(walk(applyingPanel))).toContain('90% · 9/10 · Escritura');
	});

	it('shows what the capture phase is doing right now, with a real characters counter kept off the aria-live region', () => {
		const running = render(readyModel(), 'es', {
			inventorySync: {
				state: {
					status: 'running', phase: 'capture', percent: 37, completed: 7, total: 19,
					captureStep: 'characters', captureLeg: { completed: 4, total: 12 }, elapsedMs: 12_000,
				},
				assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		});
		const statusPanel = only(byClass(running.elements(), 'tyrian-inventory-advisor__sync-status'));
		expect(statusPanel.attributes.get('aria-live')).toBe('polite');
		const message = only(withText(walk(statusPanel), 'Leyendo los inventarios de los personajes…'));
		// The fast-changing counter and elapsed time live in a node that opts itself
		// out of the aria-live region, so a screen reader is not read every tick.
		const fastLine = only(find(walk(statusPanel), 'small'));
		expect(fastLine.attributes.get('aria-live')).toBe('off');
		expect(fastLine.textContent).toContain('4/12 personajes');
		expect(fastLine.textContent).toContain('12 s');
		expect(message.textContent).not.toContain('4/12');
	});

	it('never rebuilds the results table for a live sync-panel tick, and the rebuild count does not grow with N', () => {
		const model = { ...readyModel(), contentVersion: 1 };
		const stateAt = (percent: number): InventoryVaultSyncRunState => ({
			status: 'running', phase: 'capture', percent, completed: percent, total: 100,
			captureStep: 'characters', captureLeg: { completed: percent, total: 100 }, elapsedMs: percent * 1_000,
		});
		const interactionsAt = (percent: number): InventoryAdvisorViewInteractions => ({
			inventorySync: { state: stateAt(percent), assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() },
		});
		const mount = render(model, 'es', interactionsAt(0));
		const results = only(byClass(mount.elements(), 'tyrian-inventory-advisor__results'));

		const tick = (percent: number): boolean => {
			const before = results.children[0];
			renderInventoryAdvisorView(mount.container as unknown as HTMLElement, model, createTranslator('es'), undefined, interactionsAt(percent));
			return results.children[0] !== before;
		};
		const rebuildsAcross = (ticks: number): number => {
			let rebuilds = 0;
			for (let percent = 1; percent <= ticks; percent += 1) if (tick(percent)) rebuilds += 1;
			return rebuilds;
		};

		// The rebuild count for a run of N sync-only ticks does not grow with N: it
		// is zero regardless, because none of them touch the advisor's own content.
		expect(rebuildsAcross(5)).toBe(0);
		expect(rebuildsAcross(50)).toBe(0);

		// A genuine content change (a fresh capture landing) still rebuilds exactly once.
		const before = results.children[0];
		renderInventoryAdvisorView(
			mount.container as unknown as HTMLElement, { ...model, contentVersion: 2 }, createTranslator('es'), undefined, interactionsAt(60),
		);
		expect(results.children[0]).not.toBe(before);
	});

	it('shows the persisted last run with its own note and finished-at line only while nothing is live', () => {
		const mount = render(readyModel(), 'es', {
			inventorySync: {
				state: { status: 'idle', lastRun: {
					status: 'success', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 86694,
					summary: { positions: 2909, create: 1616, update: 1167, unchanged: 79, deactivate: 0, conflicts: 0 }, error: null,
				} }, assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		});
		const section = only(byClass(mount.elements(), 'tyrian-inventory-advisor__sync'));
		expect(text(walk(section))).toContain('Se muestra la última ejecución guardada.');
		expect(text(walk(section))).toContain('Última ejecución: 2026-08-25T07:00:13.750Z');
		expect(text(walk(section))).toContain('La última sincronización guardada movió 2909 filas: 1616 nuevas, 1167 actualizadas, 0 inactivas.');
		const running = render(readyModel(), 'es', {
			inventorySync: {
				state: {
					status: 'running', phase: 'preview', percent: 60, completed: null, total: null,
					captureStep: null, captureLeg: null, elapsedMs: 20_000,
				},
				assetsInstalled: true, onRun: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
			},
		});
		const runningSection = only(byClass(running.elements(), 'tyrian-inventory-advisor__sync'));
		expect(text(walk(runningSection))).not.toContain('Se muestra la última ejecución guardada.');
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

function economyModel(containerEconomy: NonNullable<InventoryAdvisorViewRow['containerEconomy']>): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		optionalSources: null,
		groups: [{ key: 'curated', rows: [row({
			itemId: 36_038, name: 'Trick-or-Treat Bag', action: containerEconomy.recommendation.action,
			containerEconomy,
		})] }],
	};
}

function equipmentSalvageModel(): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		optionalSources: null,
		groups: [{ key: 'curated', rows: [row({
			itemId: 10, name: 'Rare sword', action: 'salvage',
			equipmentSalvage: {
				status: 'ready', action: 'salvage', economics: {
					ruleId: 'rare-equipment-68-ecto-v1', quantity: 2,
					expectedOutputMillionths: 900_000, outputItemId: 19_721,
					outputStrategy: 'instant_sell', outputStrategySource: 'conservative_lower_quote',
					grossOutputMicroCopper: 1_530_000_000, kit: 'master',
					kitSource: 'conservative_master_default', kitCostMicroCopper: 122_880_000,
					timeCostMicroCopper: 0, timeCostSource: 'excluded_missing_preference',
					netSalvageMicroCopper: 1_407_120_000,
					marketAlternatives: { instantSellCopper: 170, listingCopper: 186, vendorCopper: 100,
						bestAction: 'list', bestCopper: 186 },
					excludedOutputs: ['base_materials', 'luck', 'upgrade_returns'],
					sourceIds: ['gw2-api-ecto-19721', 'gw2-wiki-ecto-yield',
						'gw2-wiki-salvage-3166722', 'gw2-wiki-salvage-kit-3121384'],
				},
			},
		})] }],
	};
}

function personalDisclosure(
	coverageState: 'partial' | 'complete',
	different: boolean,
): NonNullable<InventoryAdvisorViewRow['containerEconomy']> {
	const liquidAction = different ? 'sell' as const : 'open' as const;
	const liquidDecision = { action: liquidAction, quantity: 3, ruleId: liquidAction === 'open' ? 'open-rule' : null };
	const personalDecision = coverageState === 'complete'
		? { action: 'open' as const, quantity: 3, ruleId: 'open-rule' }
		: null;
	const valued = coverageState === 'complete' ? 10 : 1;
	return {
		recommendation: personalDecision ?? liquidDecision,
		recommendationBasis: coverageState === 'complete' ? 'personal' : 'liquid_only',
		liquidOnly: {
			decision: liquidDecision,
			explanation: {
				sellNow: { route: 'instant_sell', unitCopper: 1_000, grossCopper: 3_000,
					listingFeeCopper: 150, exchangeFeeCopper: 300, totalFeesCopper: 450, netCopper: 2_550 },
				open: { evPerContainerMicroCopper: 1_234_567_890, totalExpectedMicroCopper: '3703703670',
					coverage: 'complete', modelId: 'model', modelVersion: 1, sampleContainers: 106_264,
					excludedSampleUnits: 1_171, rareTreatment: 'excluded' },
				threshold: { marginBps: 1_000, requiredOpenMicroCopper: '2805000000' },
				comparison: { differenceMicroCopper: '898703670', advantageBps: 4_500,
					rule: 'open_at_or_above_threshold' },
				freshness: { asOf: '2026-08-29T00:00:00.000Z', priceCapturedAt: '2026-08-29T00:00:00.000Z', priceAgeMs: 0 },
				caveats: ['excluded_outcomes_not_valued'],
			},
		},
		personal: {
			valuation: {
				version: 1, modelId: 'model', modelVersion: 1, containerItemId: 36_038,
				coverage: coverageState, knownAdjustment: 250_000_000,
				totalAdjustment: coverageState === 'complete' ? 250_000_000 : null,
				lines: Array.from({ length: valued }, (_, index) => ({ outcomeKey: `item:${String(36_031 + index)}`,
					label: `Outcome ${String(index)}`, expectedUnitsMillionths: 1_000_000, unitCopper: 25,
					adjustment: 25_000_000, origin: 'manual' as const })),
				unvalued: Array.from({ length: 10 - valued }, (_, index) => ({ outcomeKey: `item:${String(46_000 + index)}`,
					label: `Pending ${String(index)}`, expectedUnitsMillionths: 1_000_000 })),
				outsideModelSampleUnits: 1_171, origin: 'manual',
			},
			openEvPerContainerMicroCopper: coverageState === 'complete' ? 1_484_567_890 : null,
			totalExpectedMicroCopper: coverageState === 'complete' ? '4453703670' : null,
			decision: personalDecision,
			comparison: coverageState === 'complete'
				? { differenceMicroCopper: '1648703670', advantageBps: 7_450,
					rule: 'open_at_or_above_threshold' } : null,
		},
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
		reasonCodes: ['rule_missing'], protectionReasons: [], value: { status: 'unavailable', route: null },
		marketComparison: null, burden: null,
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

function controlWithLabel(elements: readonly FakeElement[], tag: string, label: string): FakeElement {
	return only(find(elements, tag).filter((element) => element.attributes.get('aria-label') === label));
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
