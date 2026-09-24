import { describe, expect, it, vi } from 'vitest';

import type { DurableSessionHistoryRecord } from '../sessions/session-history';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
import {
	formatSessionHistoryDuration,
	mountSessionHistoryPanel,
	SessionHistoryPanelController,
} from './session-history-panel';

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
		const state = descendants(container).find((element) => element.className === 'tyrian-session-history__state')!;
		expect(state.attributes.get('aria-live')).toBe('polite');
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
		// Column headers and the per-row "ended" cell are both `<th>`: only the exact accessible
		// scope on each distinguishes them for a screen reader.
		const headers = descendants(container).filter((element) => element.tag === 'th');
		expect(headers.some((header) => header.attributes.get('scope') === 'col')).toBe(true);
		expect(headers.some((header) => header.attributes.get('scope') === 'row')).toBe(true);
		// Lote P (9 sep 2026): no more "Historial durable" header, and the row that names the
		// gaveto's closed-state suffix repaints to the loaded count once ready.
		expect(descendants(container).some((element) => element.tag === 'h3')).toBe(false);
		expect(descendants(container).find((element) => element.tag === 'small')?.textContent).toBe('1 session');
		expect(allText(container)).toContain('1 session · read at');
	});

	it.each([
		['es' as const, 60_000, 30_000, '30 segundos', '+30 segundos'],
		['es' as const, 30_000, 60_000, '30 segundos', '−30 segundos'],
		['en' as const, 60_000, 30_000, '30 seconds', '+30 seconds'],
		['en' as const, 30_000, 60_000, '30 seconds', '−30 seconds'],
	])('preserves whole seconds in %s rows and comparison deltas', async (locale, latestMs, previousMs, duration, delta) => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', previousMs),
				record('2026-08-20T11:00:00.000Z', latestMs),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, locale, controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));
		expect(allText(container)).toContain(duration);
		expect(allText(container)).toContain(delta);
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

	it('renders duration-weighted activity/build performance and an honest minimum-sample warning', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', 3_600_000, { activity: 'halloween', build: 'Power Reaper' }),
				record('2026-08-21T10:00:00.000Z', 3_600_000, { activity: 'halloween', build: 'Power Reaper' }),
				record('2026-08-22T10:00:00.000Z', 3_600_000, { activity: 'halloween', build: 'Condi Scourge' }),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));

		const visible = allText(container);
		expect(visible).toContain('Rendimiento por actividad, build y calidad');
		expect(visible).toContain('Halloween · Power Reaper · Exacta');
		expect(visible).toContain('2/2 sesiones comparables');
		expect(visible).toContain('Muestra insuficiente: 1/2 sesiones comparables');
	});

	it('labels a session outside the Labyrinth "All year" instead of hiding it from performance', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', 3_600_000, { activity: null, build: 'Power Reaper' }),
				record('2026-08-21T10:00:00.000Z', 3_600_000, { activity: null, build: 'Power Reaper' }),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'en', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));

		const visible = allText(container);
		expect(visible).toContain('All year · Power Reaper · Exact');
		expect(visible).not.toContain('sessions are outside groups');
	});

	// H18.10 (Anexo 2): a Labyrinth session (sacks, keys) is routinely `estimated`, so its rate must
	// still form a comparable group of its own — and never merge with an `exact` one.
	it('groups an estimated Labyrinth session apart from an exact one, with an explicit note', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', 3_600_000, {
					activity: 'halloween', build: 'Deadeye', classification: 'estimated', confidence: 'medium',
				}),
				record('2026-08-21T10:00:00.000Z', 3_600_000, {
					activity: 'halloween', build: 'Deadeye', classification: 'estimated', confidence: 'low',
				}),
				record('2026-08-22T10:00:00.000Z', 3_600_000, { activity: 'halloween', build: 'Deadeye' }),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));

		const visible = allText(container);
		expect(visible).toContain('Halloween · Deadeye · Estimada');
		expect(visible).toContain('Halloween · Deadeye · Exacta');
		expect(visible).toContain('Tasa estimada: no se compara con una tasa exacta.');
	});

	it('gives a contaminated session its own visible exclusion instead of silently dropping it', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', 3_600_000, {
					activity: 'halloween', build: 'Deadeye', classification: 'contaminated', confidence: 'high',
					valuationCoverage: 'not_evaluated', sacks: null, observedImmediateCopper: null,
				}),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));

		expect(allText(container)).toContain('1 sesiones quedan excluidas: su calidad no es comparable');
	});

	// H18.10: `loot-presentation-view.ts` had no consumer at all; the durable gains list a note's
	// own results table already carries now renders in each session's history card.
	it('renders each session’s durable gains list in its card', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', 3_600_000, {
					lootRows: [{ name: 'Bolsa de Halloween', netQuantity: 4, immediateLabel: '2 oro' }],
				}),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));

		expect(allText(container)).toContain('Bolsa de Halloween ×4 · 2 oro');
		expect(descendants(container).some((element) =>
			element.tag === 'ul' && element.className === 'tyrian-companion-loot__stored-rows')).toBe(true);
	});

	// H14.2: session-ended timestamps go through the same today/yesterday-or-short-date wrapper
	// every other timestamp in the plugin uses, not a bespoke `toLocaleString`.
	it('shows a session that ended today as "hoy HH:MM", not a locale-specific date', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse('2026-08-20T12:00:00'));
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [record('2026-08-20T10:00:00')],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('ready'));

		expect(allText(container)).toMatch(/hoy \d{2}:\d{2}/u);
		vi.useRealTimers();
	});
});

describe('formatSessionHistoryDuration', () => {
	it.each([
		[30_000, 'es' as const, '30 segundos'],
		[30_000, 'en' as const, '30 seconds'],
		[1, 'es' as const, '<1 segundo'],
		[999, 'en' as const, '<1 second'],
		[0, 'es' as const, '0 segundos'],
		[3_690_000, 'en' as const, '1 h 1 min 30 seconds'],
	])('formats %dms in %s as %s', (durationMs, locale, expected) => {
		expect(formatSessionHistoryDuration(durationMs, locale)).toBe(expected);
	});
});

function record(
	startedAt: string,
	durationMs = 3_600_000,
	overrides: Partial<DurableSessionHistoryRecord> = {},
): DurableSessionHistoryRecord {
	return {
		sessionRef: 'a'.repeat(64), accountRef: 'b'.repeat(64), activity: null, build: null, startedAt,
		endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), durationMs,
		classification: 'exact', confidence: 'high', scope: 'observed_storage_net', valuationCoverage: 'complete',
		observedImmediateCopper: 10_000, observedListingCopper: 12_000, sacks: 10, sacksPerHourMilli: 10_000,
		immediateCopperPerHour: 10_000, listingCopperPerHour: 12_000, recommendationStatus: 'not_evaluated',
		recommendationAction: null, recommendationQuantity: null, recommendationRoute: null, lootRows: [],
		...overrides,
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
