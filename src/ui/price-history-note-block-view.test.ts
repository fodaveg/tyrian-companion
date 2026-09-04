import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import { renderPriceHistoryNoteBlock, type PriceHistoryNoteBlockState } from './price-history-note-block-view';

afterEach(() => vi.unstubAllGlobals());

describe('price history note block view', () => {
	it('renders a readable heading and never calls network on its own', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: 'Trick-or-Treat Bag', piloted: true, seed: undefined,
		}));
		const elements = walk(mount.container);
		expect(elements[0]?.className).toBe('tyrian-price-history-note');
		expect(elements.find((element) => element.className === 'tyrian-price-history-note__heading')?.textContent)
			.toBe('Price history: Trick-or-Treat Bag (#36038)');
	});

	it('shows an unrecognized-block message for a null item id, in plain readable text', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: null, itemName: null, piloted: false, seed: undefined,
		}));
		const texts = walk(mount.container).map((element) => element.textContent).join('\n');
		expect(texts).toContain('unrecognized block');
		expect(texts).toContain('nothing was requested');
	});

	it('shows a not-piloted message without drawing a chart', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('es'), block({
			itemId: 100_063, itemName: null, piloted: false, seed: undefined,
		}));
		const elements = walk(mount.container);
		expect(elements.some((element) => element.tag === 'svg')).toBe(false);
		expect(elements.some((element) => element.textContent?.includes('piloto'))).toBe(true);
	});

	it('shows loading state while the seed has not answered yet, as an aria-live status', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: null, piloted: true, seed: undefined,
		}));
		const status = walk(mount.container).find((element) => element.className === 'tyrian-price-history-note__state');
		expect(status?.textContent).toContain('Loading');
		expect(status?.attributes.get('aria-live')).toBe('polite');
		expect(status?.attributes.get('role')).toBeUndefined();
	});

	it('renders a no-history alert without throwing when datawars2 answered no_seed', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: null, piloted: true,
			seed: seedState({ status: 'no_seed', failureReason: 'unreachable' }),
		}));
		const status = walk(mount.container).find((element) => element.className === 'tyrian-price-history-note__state');
		expect(status?.textContent).toContain('no history available');
		expect(status?.attributes.get('role')).toBe('alert');
	});

	it('renders a store-unavailable alert for a broken local cache', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: null, piloted: true, seed: seedState({ status: 'store_unavailable' }),
		}));
		const status = walk(mount.container).find((element) => element.className === 'tyrian-price-history-note__state');
		expect(status?.textContent).toContain('not available right now');
		expect(status?.attributes.get('role')).toBe('alert');
	});

	it('draws a figure with the seed-only chart when seeded, solid (never dashed, nothing local to confuse it with), and no local median/close markers', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: 'Trick-or-Treat Bag', piloted: true,
			seed: seedState({
				status: 'seeded',
				days: [
					{ dayUtc: '2026-08-01', bidCopper: 100, askCopper: 110 },
					{ dayUtc: '2026-08-02', bidCopper: 120, askCopper: 130 },
				],
			}),
		}));
		const elements = walk(mount.container);
		expect(elements.some((element) => element.tag === 'figure')).toBe(true);
		expect(elements.some((element) => element.className === 'price-seed-solo')).toBe(true);
		// The dashed "shares the chart with a local line" class never appears without one.
		expect(elements.some((element) => element.className === 'price-seed')).toBe(false);
		expect(elements.some((element) => element.className === 'price-median')).toBe(false);
		expect(elements.some((element) => element.className === 'price-close')).toBe(false);
		const caption = elements.find((element) => element.tag === 'figcaption');
		expect(caption?.textContent).toContain('last 2 datawars2');
	});

	it('keeps the chart on screen and notes a stale cache after a refresh failure', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: null, piloted: true,
			seed: seedState({
				status: 'seeded', failureReason: 'unreachable',
				days: [{ dayUtc: '2026-08-01', bidCopper: 100, askCopper: null }],
			}),
		}));
		const elements = walk(mount.container);
		expect(elements.some((element) => element.tag === 'figure')).toBe(true);
		expect(elements.some((element) => element.textContent?.includes('could not be downloaded'))).toBe(true);
	});

	it('treats an empty seeded day list as no history, never an empty chart', () => {
		const mount = createMount();
		renderPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, createTranslator('en'), block({
			itemId: 36_038, itemName: null, piloted: true, seed: seedState({ status: 'seeded', days: [] }),
		}));
		const elements = walk(mount.container);
		expect(elements.some((element) => element.tag === 'figure')).toBe(false);
		expect(elements.some((element) => element.textContent?.includes('no history available'))).toBe(true);
	});

	it('uses only semantic theme variables and matches the styled class names', () => {
		const styles = readFileSync('styles.css', 'utf8');
		expect(styles).toContain('.tyrian-price-history-note {');
		const section = styles.slice(styles.indexOf('.tyrian-price-history-note {'), styles.indexOf('.tyrian-inventory-advisor__scope legend'));
		expect(section).not.toMatch(/#[0-9a-f]{3,8}/iu);
		expect(section).toContain('var(--background-secondary)');
		expect(section).toContain('.tyrian-price-history-note__state[role=\'alert\']');
	});
});

function block(overrides: Partial<PriceHistoryNoteBlockState>): PriceHistoryNoteBlockState {
	return { itemId: 36_038, itemName: null, piloted: true, seed: undefined, ...overrides };
}

function seedState(overrides: Partial<PriceHistoryPanelSeedState>): PriceHistoryPanelSeedState {
	return {
		status: 'idle', itemId: 36_038, days: [], failureReason: null, retrievedAt: null, ...overrides,
	};
}

function createMount(): { container: FakeElement } {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, document));
	vi.stubGlobal('createDiv', () => new FakeElement('div', document));
	vi.stubGlobal('createSpan', () => new FakeElement('span', document));
	return { container: new FakeElement('div', document) };
}
function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }
class FakeDocument {
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = ''; textContent: string | null = null; type = ''; value = ''; disabled = false;
	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	addEventListener(type: string, listener: () => void): void { const entries = this.listeners.get(type) ?? []; entries.push(listener); this.listeners.set(type, entries); }
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	setAttribute(name: string, value: string): void {
		if (name === 'class') this.className = value; else this.attributes.set(name, value);
	}
}
