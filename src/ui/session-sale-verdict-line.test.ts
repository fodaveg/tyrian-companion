import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import { renderSessionSaleVerdictLine } from './session-sale-verdict-line';
import type { SaleHeroViewModel } from './sale-view-model';

/**
 * H18.36 (boceto lámina 2.1, decisión G): pure-module coverage for the DOM this line builds,
 * isolated from `companion-view.ts`'s own wiring test (`companion-view.test.ts`, "Companion sale
 * verdict line"). `renderActionBadge` (`sale-view.ts`) reaches for the global `createSpan`, so
 * every test here stubs it the same way `sale-view.test.ts` does.
 */

afterEach(() => { vi.unstubAllGlobals(); });

function stubGlobalDom(): void {
	vi.stubGlobal('createEl', (tag: string, options?: FakeOptions) => new FakeElement(tag, options));
	vi.stubGlobal('createDiv', (options?: FakeOptions) => new FakeElement('div', options));
	vi.stubGlobal('createSpan', (options?: FakeOptions) => new FakeElement('span', options));
}

function heroWith(action: SaleHeroViewModel['action']): SaleHeroViewModel {
	return {
		id: '#/sale/hero/36038', itemId: 36038, name: 'Saco de Halloween', icon: null,
		ownedQuantity: 5, slotsUsed: 1, action, slotsFreedLabel: null, reasonCode: null, window: null,
		bidCopper: 5_000, instantSellNetCopper: 4_500, listingNetCopper: null,
		quote: { quotedAtMs: null, stale: false },
		yearThresholdCopper: null, openVsSell: null,
	};
}

describe('renderSessionSaleVerdictLine', () => {
	it('renders nothing with no hero row', () => {
		stubGlobalDom();
		const container = new FakeElement('div');
		renderSessionSaleVerdictLine(container as unknown as HTMLElement, null, createTranslator('es'), vi.fn());
		expect(container.children).toHaveLength(0);
	});

	it('renders nothing while the verdict is undecided (no_data)', () => {
		stubGlobalDom();
		const container = new FakeElement('div');
		renderSessionSaleVerdictLine(container as unknown as HTMLElement, heroWith('no_data'), createTranslator('es'), vi.fn());
		expect(container.children).toHaveLength(0);
	});

	it('mounts the marca lateral with the same data-action Venta uses', () => {
		stubGlobalDom();
		const container = new FakeElement('div');
		renderSessionSaleVerdictLine(container as unknown as HTMLElement, heroWith('sell'), createTranslator('es'), vi.fn());
		const badge = findAll(container, (n) => n.className === 'tyrian-action')[0];
		expect(badge?.attributes.get('data-action')).toBe('sell');
		expect(badge?.textContent).toBe('Vender ahora');
	});

	it('calls the onOpenSale callback when "Ver en Venta" is clicked', () => {
		stubGlobalDom();
		const container = new FakeElement('div');
		const onOpenSale = vi.fn();
		renderSessionSaleVerdictLine(container as unknown as HTMLElement, heroWith('sell'), createTranslator('es'), onOpenSale);
		const button = findAll(container, (n) => n.tag === 'button')[0]!;
		expect(button.textContent).toBe('Ver en Venta');
		button.listeners.get('click')?.[0]?.();
		expect(onOpenSale).toHaveBeenCalledOnce();
	});
});

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	textContent: string | null = null;
	className = '';

	constructor(readonly tag: string, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? null;
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, options); this.children.push(child); return child; }
	createSpan(options?: FakeOptions): FakeElement { const child = new FakeElement('span', options); this.children.push(child); return child; }
	append(...children: FakeElement[]): void { this.children.push(...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
}

function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }
function findAll(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement[] {
	return walk(root).filter(predicate);
}
