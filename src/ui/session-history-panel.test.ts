import { describe, expect, it, vi } from 'vitest';

import type { DurableSessionHistoryRecord } from '../sessions/session-history';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
import { mountSessionHistoryPanel, SessionHistoryPanelController } from './session-history-panel';

describe('SessionHistoryPanelController', () => {
	it('starts idle, coalesces an explicit load, and projects all terminal states', async () => {
		let settle!: (result: SessionHistoryLoadResult) => void;
		const loader = vi.fn(() => new Promise<SessionHistoryLoadResult>((resolve) => { settle = resolve; }));
		const controller = new SessionHistoryPanelController(loader);
		const states: string[] = [];
		controller.subscribe((state) => states.push(state.status));

		expect(controller.current()).toEqual({ status: 'idle' });
		const first = controller.load();
		const second = controller.load();
		expect(first).toBe(second);
		expect(loader).toHaveBeenCalledOnce();
		expect(controller.current()).toEqual({ status: 'loading' });
		settle({ status: 'ok', sessions: [], ignored: 3 });
		await first;
		expect(controller.current()).toEqual({ status: 'empty' });
		expect(states).toEqual(['loading', 'empty']);

		const conflict = new SessionHistoryPanelController(async () => ({ status: 'conflict', invalid: 2, duplicates: 1 }));
		await conflict.load();
		expect(conflict.current()).toEqual({ status: 'conflict', invalid: 2, duplicates: 1 });

		const unavailable = new SessionHistoryPanelController(async () => ({ status: 'unavailable' }));
		await unavailable.load();
		expect(unavailable.current()).toEqual({ status: 'unavailable' });
	});

	it('maps a rejected port to unavailable without leaking the error', async () => {
		const controller = new SessionHistoryPanelController(async () => await Promise.reject(new Error('private path')));
		await controller.load();
		expect(controller.current()).toEqual({ status: 'unavailable' });
	});
});

describe('mountSessionHistoryPanel', () => {
	it('does no load on mount and keeps the focused action while rendering a ready result', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		let settle!: (result: SessionHistoryLoadResult) => void;
		const load = vi.fn(() => new Promise<SessionHistoryLoadResult>((resolve) => { settle = resolve; }));
		const controller = new SessionHistoryPanelController(load);
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'en', controller);

		expect(load).not.toHaveBeenCalled();
		expect(allText(container)).toContain('History has not been read yet');
		const button = descendants(container).find((element) => element.tag === 'button')!;
		button.focus();
		button.click();
		expect(button.disabled).toBe(true);
		expect(allText(container)).toContain('Reading session notes');

		settle({ status: 'ok', ignored: 0, sessions: [record('2026-08-20T10:00:00.000Z')] });
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));
		expect(button.disabled).toBe(false);
		expect(button.textContent).toBe('Refresh history');
		expect(document.activeElement).toBe(button);
		expect(allText(container)).toContain('History validated');
		expect(descendants(container).some((element) => element.tag === 'caption')).toBe(true);
		expect(descendants(container).some((element) => element.tag === 'article')).toBe(true);
	});

	it('announces fail-closed conflicts and never renders a partial table', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({ status: 'conflict', invalid: 4, duplicates: 2 }));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('conflict'));

		const state = descendants(container).find((element) => element.className === 'tyrian-session-history__state')!;
		expect(state.attributes.get('role')).toBe('alert');
		expect(allText(state)).toContain('4 notas no válidas y 2 referencias duplicadas');
		expect(descendants(state).some((element) => element.tag === 'table')).toBe(false);
	});
});

function record(startedAt: string): DurableSessionHistoryRecord {
	return {
		sessionRef: 'a'.repeat(64), accountRef: 'b'.repeat(64), startedAt,
		endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(), durationMs: 3_600_000,
		classification: 'exact', confidence: 'high', scope: 'observed_storage_net', valuationCoverage: 'complete',
		observedImmediateCopper: 10_000, observedListingCopper: 12_000, sacks: 10, sacksPerHourMilli: 10_000,
		immediateCopperPerHour: 10_000, listingCopperPerHour: 12_000, recommendationStatus: 'not_evaluated',
		recommendationAction: null, recommendationQuantity: null, recommendationRoute: null,
	};
}

function descendants(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(descendants)];
}

function allText(root: FakeElement): string {
	return descendants(root).map((element) => element.textContent).join(' ');
}

interface FakeOptions { readonly text?: string; readonly cls?: string }

class FakeDocument { activeElement: FakeElement | null = null }

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = '';
	textContent = '';
	disabled = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
	}

	createEl(tag: string, options?: FakeOptions): FakeElement {
		const child = new FakeElement(tag, this.ownerDocument, options);
		this.children.push(child);
		return child;
	}

	createDiv(options?: FakeOptions): FakeElement {
		const child = new FakeElement('div', this.ownerDocument, options);
		this.children.push(child);
		return child;
	}
	createSpan(options?: FakeOptions): FakeElement {
		const child = new FakeElement('span', this.ownerDocument, options);
		this.children.push(child);
		return child;
	}
	empty(): void { this.children.splice(0); this.textContent = ''; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
	click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
	focus(): void { this.ownerDocument.activeElement = this; }
}
