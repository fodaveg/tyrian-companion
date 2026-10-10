import { describe, expect, it, vi } from 'vitest';

import type { DurableSessionHistoryRecord } from '../sessions/session-history';
import type { SessionHistoryLoadResult, SessionHistoryLoadSource } from '../sessions/session-history-summary';
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
		expect(unavailable.current()).toEqual({ status: 'unavailable', reason: 'not_ready' });
	});

	it('maps a rejected port to unavailable, tagged "failed" (never "not_ready", which the view auto-retries)', async () => {
		const controller = new SessionHistoryPanelController(async () => await Promise.reject(new Error('private path')));
		await controller.load();
		expect(controller.current()).toEqual({ status: 'unavailable', reason: 'failed' });
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
		// H18.36: one table only — no duplicate `.tyrian-session-history__cards` DOM to drift from it.
		expect(descendants(container).some((element) => element.className.includes('tyrian-session-history__cards'))).toBe(false);
		expect(descendants(container).filter((element) => element.tag === 'table').length).toBeGreaterThanOrEqual(1);
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

	// Audit 2.2: the button is the player asking for the notes to be read, so it is the one load
	// that may not be answered from the index. Every load the view starts on its own takes it.
	it('asks for a rebuild from the refresh button, and for the index from a load nobody pressed', async () => {
		const container = new FakeElement('div', new FakeDocument());
		const load = vi.fn(async (_source: SessionHistoryLoadSource): Promise<SessionHistoryLoadResult> => (
			{ status: 'ok', ignored: 0, sessions: [] }));
		const controller = new SessionHistoryPanelController(load);
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'en', controller);

		await controller.load();
		expect(load.mock.calls).toEqual([['index']]);

		descendants(container).find((element) => element.tag === 'button')!.click();
		await vi.waitFor(() => expect(controller.current().status).toBe('empty'));
		expect(load.mock.calls).toEqual([['index'], ['rebuild']]);
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

	it.each([
		['es' as const, '2 sesiones sin identidad de build; conservan estadísticas en un grupo de contexto desconocido.'],
		['en' as const, '2 sessions without build identity; statistics remain in an unknown-context group.'],
	])('keeps missing-build statistics with a translated warning in %s', async (locale, warning) => {
		const container = new FakeElement('div', new FakeDocument());
		const controller = new SessionHistoryPanelController(async () => ({
			status: 'ok', ignored: 0, sessions: [
				record('2026-08-20T10:00:00.000Z', 3_600_000, { build: null }),
				record('2026-08-20T11:00:00.000Z', 3_600_000, { build: null }),
			],
		}));
		mountSessionHistoryPanel(container as unknown as HTMLElement, locale, controller);
		await controller.load();
		const performance = descendants(container).find((element) => element.className === 'tyrian-session-history__performance')!;
		expect(allText(performance)).toContain(warning);
		expect(descendants(performance).find((element) => element.tag === 'tbody')!.children).toHaveLength(1);
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

		// H18.36 (boceto lámina 2.5, decidido): rendimiento en tabla, calidad con forma — no more
		// one `<article>` per group.
		const qualitySpans = descendants(container).filter((element) => element.className.includes('tyrian-session-history__quality'));
		expect(qualitySpans.length).toBeGreaterThanOrEqual(1);
		expect(qualitySpans[0]?.attributes.get('data-quality')).toBe('exact');
		const wideCells = descendants(container).filter((element) => element.className.split(' ').includes('is-wide'));
		expect(wideCells.length).toBeGreaterThan(0);
	});

	it('shows independent bag and money samples with price gaps and explicit comparison limitations', async () => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({ status: 'ok', ignored: 0, sessions: [
			record('2026-10-01T10:00:00.000Z', 3_600_000, { build: '', sacks: 500, valuationCoverage: 'partial' }),
			record('2026-10-02T10:00:00.000Z', 3_600_000, { build: '', sacks: 500, valuationCoverage: 'partial' }),
		] }));
		mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
		await controller.load();
		const visible = allText(container);
		expect(visible).toContain('Build sin nombre');
		expect(visible).toContain('2 sesiones · 120 min');
		expect(visible).toContain('0 sesiones · 0 min');
		expect(visible).toContain('Rango observado:');
		expect(visible).toContain('buffs desconocidos');
		expect(visible).toContain('Delta positivo histórico · 36038');
		expect(visible).toContain('no demuestran que una build cause mejor rendimiento');
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
	// own results table already carries now renders as a detail row under each session (H18.36:
	// there is no history card anymore — one table, no duplicate cards DOM).
	it('renders each session’s durable gains list as its own detail row', async () => {
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

describe('session note link in the history rows', () => {
	const mountWith = async (
		locale: 'es' | 'en', sessions: DurableSessionHistoryRecord[], openNote?: (path: string) => void,
	) => {
		const document = new FakeDocument();
		const container = new FakeElement('div', document);
		const controller = new SessionHistoryPanelController(async () => ({ status: 'ok', ignored: 0, sessions }));
		mountSessionHistoryPanel(container as unknown as HTMLElement, locale, controller, openNote);
		await controller.load();
		return { document, container };
	};
	const links = (container: FakeElement) => descendants(container)
		.filter((element) => element.tag === 'button' && element.className.includes('tyrian-session-history__note-link'));

	it('gives each session its own link, named after the session, that opens ITS note', async () => {
		const openNote = vi.fn();
		const { container } = await mountWith('en', [
			record('2026-08-20T10:00:00.000Z', 3_600_000, { notePath: 'Sessions/first.md' }),
			record('2026-08-21T10:00:00.000Z', 3_600_000, { notePath: 'Sessions/second.md' }),
		], openNote);
		const found = links(container);
		expect(found).toHaveLength(2);
		for (const link of found) {
			expect(link.className).toContain('mod-link');
			expect(link.attributes.get('type')).toBe('button');
			expect(link.attributes.get('aria-label')).toMatch(/^Open the note of the session ended /u);
			expect(link.attributes.get('aria-label')).toContain(link.textContent);
		}
		// Newest first: the second record leads the ledger.
		found[0]!.click();
		found[1]!.click();
		expect(openNote.mock.calls).toEqual([['Sessions/second.md'], ['Sessions/first.md']]);
	});

	it('names the link in Spanish and is a real, focusable button (keyboard activation is the browser\'s)', async () => {
		const openNote = vi.fn();
		const { container, document } = await mountWith('es', [
			record('2026-08-20T10:00:00.000Z', 3_600_000, { notePath: 'Sessions/a.md' }),
		], openNote);
		const [link] = links(container);
		expect(link!.attributes.get('aria-label')).toMatch(/^Abrir la nota de la sesión terminada /u);
		link!.focus();
		expect(document.activeElement).toBe(link);
		// The link sits in the row header cell, so the row keeps its `scope="row"` name.
		const header = descendants(container).find((element) => element.tag === 'th' && element.children.includes(link!));
		expect(header?.attributes.get('scope')).toBe('row');
	});

	it('draws no link for a session without a known note, or when nothing can open it', async () => {
		const withoutPath = await mountWith('en', [record('2026-08-20T10:00:00.000Z')], vi.fn());
		expect(links(withoutPath.container)).toHaveLength(0);
		const withoutOpener = await mountWith('en', [
			record('2026-08-20T10:00:00.000Z', 3_600_000, { notePath: 'Sessions/a.md' }),
		]);
		expect(links(withoutOpener.container)).toHaveLength(0);
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
		legacyPositiveNetSacks: (overrides.sacks === undefined ? 10 : overrides.sacks ?? 0) > 0 ? overrides.sacks ?? 10 : null,
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

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

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
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
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
