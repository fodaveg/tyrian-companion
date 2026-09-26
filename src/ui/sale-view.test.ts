import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import { renderSaleView } from './sale-view';
import { buildSaleViewModel, type SaleSourceRow, type SaleViewModelInput } from './sale-view-model';

vi.mock('obsidian', () => ({
	setIcon: (el: { setAttribute(name: string, value: string): void }, iconId: string) => { el.setAttribute('data-icon', iconId); },
}));

afterEach(() => vi.unstubAllGlobals());

const NOW_MS = Date.UTC(2026, 8, 26, 7, 38, 0);

function row(overrides: Partial<SaleSourceRow> & Pick<SaleSourceRow, 'itemId' | 'name'>): SaleSourceRow {
	return {
		id: `#/row/${String(overrides.itemId)}`, icon: null, ownedQuantity: 1, slotsUsed: 1,
		materialStorageEligible: false, decision: null, bidCopper: null, instantSellNetCopper: null, listingNetCopper: null,
		...overrides,
	};
}

function baseInput(overrides: Partial<SaleViewModelInput> = {}): SaleViewModelInput {
	return {
		status: 'ready', nowMs: NOW_MS, festivalStartMs: Date.UTC(2026, 9, 13), maxPriceAgeMs: 900_000,
		hero: null, rows: [], calendar: [],
		...overrides,
	};
}

function installDom(): void {
	vi.stubGlobal('createEl', (tag: string, options?: FakeOptions) => new FakeElement(tag, new FakeDocument(), options));
	vi.stubGlobal('createDiv', (options?: FakeOptions) => new FakeElement('div', new FakeDocument(), options));
	vi.stubGlobal('createSpan', (options?: FakeOptions) => new FakeElement('span', new FakeDocument(), options));
}

function render(model: ReturnType<typeof buildSaleViewModel>, locale: 'es' | 'en' = 'es') {
	installDom();
	const container = new FakeElement('div', new FakeDocument());
	renderSaleView(container as unknown as HTMLElement, model, createTranslator(locale));
	return container;
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function text(root: FakeElement): string {
	return walk(root).map((element) => element.textContent ?? '').join('\n');
}

function find(root: FakeElement, tag: string): FakeElement[] {
	return walk(root).filter((element) => element.tag === tag);
}

function byClass(elements: FakeElement[], cls: string): FakeElement[] {
	return elements.filter((element) => element.className.split(' ').includes(cls));
}

describe('sale view render', () => {
	it('renders the hero card, the calendar and the three groups with the expected copy', () => {
		const model = buildSaleViewModel(baseInput({
			hero: {
				...row({
					itemId: 36038, name: 'Saco de Halloween', ownedQuantity: 2350, slotsUsed: 10, bidCopper: 342,
					instantSellNetCopper: 683_145, listingNetCopper: 800_997,
					decision: {
						action: 'sell', reason: 'no_demonstrated_wait_advantage',
						until: new Date(NOW_MS + 900_000).toISOString(), priceQuotedAt: new Date(NOW_MS - 180_000).toISOString(),
						sellWindowFromDay: null, sellWindowToDay: null,
					},
				}),
				yearThresholdCopper: 430,
				openVsSell: null,
			},
			calendar: [{
				itemId: 36038, name: 'Saco de Halloween', icon: null,
				candidates: [{ fromDay: '2026-09-15', toDay: '2026-10-12' }],
			}],
			rows: [
				row({
					itemId: 48805, name: 'Colmillos de plástico de alta calidad', bidCopper: 3603, instantSellNetCopper: 1_163_777,
					decision: {
						action: 'sell', reason: 'seasonal_sell_window',
						until: new Date(NOW_MS + 900_000).toISOString(), priceQuotedAt: new Date(NOW_MS - 180_000).toISOString(),
						sellWindowFromDay: '2026-09-22', sellWindowToDay: '2026-10-19',
					},
				}),
				row({
					itemId: 43320, name: 'Jorcamelo',
					decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
				}),
				row({
					itemId: 36059, name: 'Colmillos de plástico',
					decision: { action: 'review', reason: 'price_unknown', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
				}),
			],
		}));
		const container = render(model, 'es');
		const copy = text(container);
		expect(copy).toContain('Saco de Halloween');
		expect(copy).toContain('Vender ahora');
		expect(copy).toContain('Umbral del año');
		expect(copy).toContain('Ventanas de venta');
		expect(copy).toContain('Colmillos de plástico de alta calidad');
		expect(copy).toContain('Esperar'); // Jorcamelo, hold -> "wait"
		expect(copy).toContain('Sin cotización'); // Colmillos, review -> "no_data"
		expect(copy).toContain('Ahora');
		expect(find(container, 'meter')).toHaveLength(0); // no storage space supplied: no meter, not a fabricated one.
		const badges = byClass(walk(container), 'tyrian-action');
		expect(badges.some((badge) => badge.attributes.get('data-action') === 'sell')).toBe(true);
		expect(badges.some((badge) => badge.attributes.get('data-action') === 'hold')).toBe(true);
		expect(badges.some((badge) => badge.attributes.get('data-action') === 'nodata')).toBe(true);
	});

	/**
	 * Review fix (26 sep 2026): David's report — the calendar had no mark for "today" and every
	 * bar rendered as the same fixed, unpositioned outline regardless of its real dates (open or
	 * closed looked the same size). NOW_MS is 26 sep 2026.
	 */
	it('review fix: marks today on the shared axis and states days left/until per window', () => {
		const model = buildSaleViewModel(baseInput({
			calendar: [
				{
					itemId: 36038, name: 'Saco de Halloween', icon: null,
					// Open today (15 sep – 12 oct): closes in 16 days.
					candidates: [{ fromDay: '2026-09-15', toDay: '2026-10-12' }],
				},
				{
					itemId: 47909, name: 'Barra de caramelo', icon: null,
					// Not open yet (6 oct – 19 oct): opens in 10 days.
					candidates: [{ fromDay: '2026-10-06', toDay: '2026-10-19' }],
				},
			],
		}));
		const container = render(model, 'es');
		const copy = text(container);
		expect(copy).toContain('quedan 16 días');
		expect(copy).toContain('faltan 10 días');
		const todays = byClass(walk(container), 'tyrian-sale__today');
		expect(todays.length).toBeGreaterThan(0);
		for (const marker of todays) {
			const at = marker.attributes.get('style') ?? '';
			expect(at).toMatch(/--at:\d/);
		}
		const bars = byClass(walk(container), 'tyrian-sale__bar');
		expect(bars).toHaveLength(2);
		for (const bar of bars) {
			const style = bar.attributes.get('style') ?? '';
			const from = Number(/--from:([\d.]+)/.exec(style)?.[1]);
			const to = Number(/--to:([\d.]+)/.exec(style)?.[1]);
			expect(Number.isFinite(from)).toBe(true);
			expect(Number.isFinite(to)).toBe(true);
			expect(to).toBeGreaterThan(from); // a real window, never a zero-width bar.
		}
	});

	/**
	 * Review fix (26 sep 2026): David's report — the hero card never said how many Sacos he owns,
	 * unlike every other row (`sale.view.slots.*` never actually interpolates `{{quantity}}`).
	 */
	it('review fix: the hero card states the owned quantity, not just the slot count', () => {
		const model = buildSaleViewModel(baseInput({
			hero: {
				...row({
					itemId: 36038, name: 'Saco de Halloween', ownedQuantity: 2350, slotsUsed: 10, bidCopper: 342,
					decision: { action: 'sell', reason: 'no_demonstrated_wait_advantage', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
				}),
				yearThresholdCopper: null, openVsSell: null,
			},
		}));
		const container = render(model, 'es');
		expect(text(container)).toContain('2350');
	});

	it('review fix: shows the open-vs-sell comparison and the "Abrir" badge when opening beats selling now', () => {
		const model = buildSaleViewModel(baseInput({
			hero: {
				...row({
					itemId: 36038, name: 'Saco de Halloween', ownedQuantity: 2350, bidCopper: 342, instantSellNetCopper: 201,
					decision: { action: 'sell', reason: 'no_demonstrated_wait_advantage', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
				}),
				yearThresholdCopper: 430,
				openVsSell: { openCopper: 295, sellCopper: 201 },
			},
		}));
		expect(model.hero?.action).toBe('open');
		const container = render(model, 'es');
		const copy = text(container);
		expect(copy).toContain('Abrir');
		expect(copy).toContain('Vender');
		const badges = byClass(walk(container), 'tyrian-action');
		expect(badges.some((badge) => badge.attributes.get('data-action') === 'open')).toBe(true);
	});

	/**
	 * Review fix (coordinator, round 2): David's real dump read "puja leída a las 09:35 · hace dentro
	 * de 0 segundos" — `relativeTimeLabel` already returns a fully-worded "hace N minutos"/"in N
	 * minutes", and `sale.quote.readAt`'s ES template wrapped it in ANOTHER "hace ", doubling the
	 * word for a past instant and contradicting it outright for a future/zero one. Separately, a
	 * quote read in the very same instant (`now` === `quotedAtMs`, exactly the acceptance test's own
	 * clock) rendered "dentro de 0 segundos" ("in 0 seconds") instead of "ahora" ("now").
	 */
	it('review fix: a quote read in the SAME instant says "ahora", never "hace dentro de 0 segundos"', () => {
		const quotedAtIso = new Date(NOW_MS).toISOString();
		const model = buildSaleViewModel(baseInput({
			hero: {
				...row({
					itemId: 36038, name: 'Saco de Halloween', bidCopper: 342,
					decision: { action: 'sell', reason: 'no_demonstrated_wait_advantage', until: null, priceQuotedAt: quotedAtIso, sellWindowFromDay: null, sellWindowToDay: null },
				}),
				yearThresholdCopper: null, openVsSell: null,
			},
			rows: [row({
				itemId: 47909, name: 'Barra de caramelo', bidCopper: 41_345,
				decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: quotedAtIso, sellWindowFromDay: null, sellWindowToDay: null },
			})],
		}));
		const copy = text(render(model, 'es'));
		expect(copy).not.toMatch(/hace\s+hace/u);
		expect(copy).not.toMatch(/dentro de 0 segundos/u);
		expect(copy).toContain('ahora');

		const en = text(render(model, 'en'));
		expect(en).not.toMatch(/ago\s+ago/u);
		expect(en).not.toMatch(/in 0 seconds/u);
		expect(en).toContain('now');
	});

	it('renders the storage space block and low-space override reaching an actual row, not just the model', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: {
				bags: { free: 5, total: 160 }, bank: { free: 4, total: 210 }, sharedInventory: { free: 0, total: 6 },
				lowSpace: { freeSlots: 9, totalSlots: 376, thresholdFreeSlots: 20, isLow: true },
				materialCapacity: null,
			},
			rows: [row({
				itemId: 43320, name: 'Jorcamelo', slotsUsed: 1,
				decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
			})],
		}));
		const container = render(model, 'es');
		const copy = text(container);
		expect(copy).toContain('Poco espacio');
		expect(find(container, 'meter')).toHaveLength(1);
		// The row itself, not just `model.groups`, now says "Vender ahora" and "Libera 1 hueco.".
		const rowEl = find(container, 'li').find((li) => li.attributes.get('data-item') === '43320')!;
		expect(text(rowEl)).toContain('Vender ahora');
		expect(text(rowEl)).toContain('Libera 1 hueco');
	});

	it('H18.37: shows the verdict and its lateral mark before the meter and the free-slot line, same as Inventory', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: {
				bags: { free: 5, total: 160 }, bank: { free: 4, total: 210 }, sharedInventory: { free: 0, total: 6 },
				lowSpace: { freeSlots: 9, totalSlots: 376, thresholdFreeSlots: 20, isLow: true },
				materialCapacity: null,
			},
		}));
		const container = render(model, 'es');
		const space = byClass(walk(container), 'tyrian-inventory-advisor__storage-space')[0]!;
		expect(space.attributes.get('data-low-space')).toBe('true');
		expect(space.children[0]?.className).toBe('tyrian-inventory-advisor__storage-verdict');
		expect(space.children.map((child) => child.tag)).toEqual(['p', 'meter', 'p']);
	});

	it('renders a fallen icon as initials, never an empty <img>', () => {
		const model = buildSaleViewModel(baseInput({
			rows: [row({ itemId: 1, name: 'Objeto Sin Icono', icon: null })],
		}));
		const container = render(model, 'es');
		expect(find(container, 'img')).toHaveLength(0);
		const initials = byClass(walk(container), 'tyrian-inventory__icon');
		expect(initials.some((el) => el.textContent === 'OS')).toBe(true);
	});

	it('shows the plugin\'s own blocked-reason copy, never a made-up one, when the model is blocked', () => {
		const model = buildSaleViewModel(baseInput({ status: 'blocked', blockedReason: 'capture_rate_limited' }));
		const container = render(model, 'es');
		expect(text(container)).toContain('Guild Wars 2 está limitando las peticiones');
	});

	/**
	 * H18.34: an expired curated bundle gets its own explained copy, with the exact date, instead of
	 * the generic advisor "hace falta publicar una revisión" or a silent "sin datos". ES and EN.
	 */
	it('shows the curated-rules expiry copy with its exact date, in ES and EN, never "sin datos"', () => {
		const model = buildSaleViewModel(baseInput({
			status: 'ready', rulesExpiredAtMs: Date.UTC(2027, 5, 1, 0, 0, 0),
			hero: { ...row({ itemId: 36038, name: 'Saco de Halloween', decision: null }), yearThresholdCopper: null, openVsSell: null },
		}));
		expect(model.status).toBe('blocked');
		const es = text(render(model, 'es'));
		expect(es).toContain('Las reglas de venta caducaron el');
		expect(es).not.toContain('Sin datos');
		expect(es).not.toContain('La venta no está disponible ahora mismo');
		const en = text(render(model, 'en'));
		expect(en).toContain('The sale rules expired on');
		expect(en).not.toContain('No data');
	});

	it('shows the loading copy while loading, with no groups or hero rendered', () => {
		const model = buildSaleViewModel(baseInput({ status: 'loading' }));
		const container = render(model, 'es');
		expect(text(container)).toContain('Leyendo precios del bazar');
		expect(find(container, 'li')).toHaveLength(0);
	});
});

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

class FakeDocument {
	activeElement: FakeElement | null = null;
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = '';
	textContent: string | null = null;
	disabled = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? null;
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}
	empty(): void { this.children.splice(0); this.textContent = null; }
	append(...children: FakeElement[]): void { this.children.push(...children); }
	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, this.ownerDocument, options); this.children.push(child); return child; }
	createDiv(options?: FakeOptions): FakeElement { const child = new FakeElement('div', this.ownerDocument, options); this.children.push(child); return child; }
	createSpan(options?: FakeOptions): FakeElement { const child = new FakeElement('span', this.ownerDocument, options); this.children.push(child); return child; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
}
