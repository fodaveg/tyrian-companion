import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

// The audit 2.2 case below boots the real runtime, whose Obsidian host imports Electron's shell.
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TFile } from 'obsidian';

import { TyrianCompanionView, type CompanionActions } from './companion-view';
import { SESSION_NOTE_BLOCK_IDS } from '../sessions/session-note-model';
import { sha256Text } from '../sessions/session-note-renderer';
import { createRuntimeHarness, type RuntimeHarness } from '../test/runtime-harness';
import { connectionErrorKey } from './settings-i18n';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenPriceNoticeV1 } from '../halloween/halloween-price-alert';
import type { PendingProposal } from '../sessions/pending-proposal-model';
import type { SessionRecoveryState } from '../sessions/manual-session-start-service';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
import type { SessionState } from '../sessions/session';
import { createTranslator } from '../core/i18n';
import { formatClock } from './format-time';

/**
 * Behavioural coverage for the surfaces the Companion view mounts. Every case renders the real
 * view against a fake DOM and then presses the produced control, because a source-text assertion
 * stays green while the panel is unreachable.
 */

describe('Companion Halloween alert surface', () => {
	// Nobody marks an aviso as reviewed anymore (Lote S, 2026-09-09): the button and the acknowledge
	// actions are gone from `CompanionActions`. These two cases used to click it and assert the
	// action fired; they are replaced below by asserting the button never renders at all.
	it('renders the unread notice without a review button', async () => {
		const { contentEl, render } = mountCompanion({
			getHalloweenState: () => unreadHalloweenState(),
			// The notice is observed 2026-08-31, outside the calendar window: the Labyrinth override
			// keeps this surface test about the mounted panel, not about H14.3's season gate (covered
			// on its own in halloween-alert-panel.test.ts).
			getHalloweenPanelContext: () => ({ nowMs: Date.parse('2026-08-31T13:00:00.000Z'), inLabyrinth: true, sessionStartAt: null }),
		});

		render();

		// The "Avisos" gaveto (Lote P) is the panel's chrome now: no more nested `aria-label`/
		// `data-attention`/heading of its own — see "Companion Avisos gaveto forced open" below.
		const notice = find(contentEl, (node) => node.className.includes('tyrian-companion-halloween__notice'));
		expect(notice).toBeDefined();
		const acknowledge = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Marcar como revisada');
		expect(acknowledge).toBeUndefined();
	});

	it('renders an unread price notice without a review button', async () => {
		const { contentEl, render } = mountCompanion({
			getHalloweenPriceAlertState: () => ({ status: 'unread', projection: null, notices: [priceNotice()], unreadCount: 1 }),
		});

		render();

		const price = find(contentEl, (node) => node.className.includes('tyrian-companion-halloween__price'));
		expect(price).toBeDefined();
		const acknowledge = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Marcar como revisada');
		expect(acknowledge).toBeUndefined();
	});
});

/**
 * Before the redesign, `halloween-alert-panel.ts` forced its own panel open for a fresh unread
 * notice (`isFreshNotice`, H14.3). The card now carries that at the gaveto level: the "Avisos"
 * `<details>` renders open even with `drawerOpen.alerts` false, and stops once it is no longer
 * fresh (older than 24h). Nobody marks an aviso reviewed anymore (Lote S, 2026-09-09), so the old
 * "acknowledged" case is gone — freshness alone decides — and the trigger is an emitted alert
 * (`getEmittedAlerts`), never a "Cambio observado" notice (`getHalloweenState().notices`), which
 * is information about the session and never an aviso.
 */
describe('Companion Avisos gaveto forced open by a fresh alert (H14.3 at card level)', () => {
	function valuableAlert(emittedAt: string) {
		return {
			version: 1 as const, vaultId: 'vault', accountRef: 'account', alertId: `alert-${emittedAt}`,
			kind: 'valuable_loot' as const, itemId: 1, name: 'Objeto', quantity: 1, totalCopper: 60_000,
			reason: 'valuable' as const, emittedAt,
		};
	}

	function avisosDrawer(contentEl: FakeElement): FakeElement | undefined {
		return walk(contentEl).find((node) => node.tag === 'details' &&
			node.children.some((child) => child.tag === 'summary' && child.textContent === 'Avisos'));
	}

	it('renders it open with a fresh alert, even though drawerOpen.alerts starts false', () => {
		const { contentEl, render } = mountCompanion({
			getEmittedAlerts: () => [valuableAlert('2026-09-09T10:00:00.000Z')],
			getHalloweenPanelContext: () => ({ nowMs: Date.parse('2026-09-09T11:00:00.000Z'), inLabyrinth: false, sessionStartAt: null }),
		});

		render();

		expect(avisosDrawer(contentEl)?.open).toBe(true);
	});

	it('leaves it closed once the alert is more than 24h old', () => {
		const { contentEl, render } = mountCompanion({
			getEmittedAlerts: () => [valuableAlert('2026-09-08T09:00:00.000Z')],
			getHalloweenPanelContext: () => ({ nowMs: Date.parse('2026-09-09T11:00:00.000Z'), inLabyrinth: false, sessionStartAt: null }),
		});

		render();

		expect(avisosDrawer(contentEl)?.open).toBe(false);
	});
});

describe('Companion pending proposal surface', () => {
	it('renders the queued proposal and reviews it from the mounted panel', async () => {
		const reviewPendingProposal = vi.fn(async () => true);
		const openPendingSessionStart = vi.fn();
		const { contentEl, render } = mountCompanion({
			reviewPendingProposal, openPendingSessionStart,
			getPendingProposalState: () => ({ status: 'ready', pendingCount: 1, next: freshProposal() }),
		});

		render();

		const section = find(contentEl, (node) => node.className.includes('tyrian-companion-view__pending'));
		expect(section?.attributes.get('aria-label')).toBe('Confirmaciones de farmeo pendientes');
		expect(texts(contentEl)).toContain('1 confirmación pendiente');
		const review = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Revisar e iniciar');
		expect(review).toBeDefined();

		review?.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(reviewPendingProposal).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'proposal' }));
		expect(openPendingSessionStart).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'proposal' }), null);
	});
});

describe('Companion assisted detection surface', () => {
	it('renders the armed timeline, the signal quality and the honest API lag caveat', () => {
		const { contentEl, render } = mountCompanion({
			getAssistedDetectionState: () => armedDetection(),
			getDetectionQualityStats: () => ({
				acceptedBoundaries: 3, correctedFalsePositives: 1,
				correctionsByCause: { not_farming: 1, still_farming: 0, temporary_pause: 0, unrelated_account_activity: 0, other: 0 },
			}),
		});

		render();

		expect(texts(contentEl)).toContain('Detección');
		// Flat rows, no nested `<details>` inside "Detalle" (Lote P, 9 sep 2026).
		expect(find(contentEl, (node) => node.className.includes('tyrian-companion-view__detection-details'))).toBeUndefined();
		const timeline = find(contentEl, (node) => node.className.includes('tyrian-companion-view__detection-timeline'));
		expect(timeline?.attributes.get('aria-label')).toContain('Última consulta, resultado y próxima consulta');
		expect(termsAndDetails(contentEl)).toEqual(expect.arrayContaining([
			['Última consulta'], ['Resultado'], ['Próxima consulta'], ['Cadencia'], ['Caché de la API'],
		]));
		expect(texts(contentEl)).toContain('Límites registrados');
		expect(texts(contentEl)).toContain('Propuestas corregidas');
		// The API-lag paragraph is gone; the same honesty now lives as the Caché de la API row's value.
		expect(definitionValue(contentEl, 'Caché de la API')).toBe('5 a 10 min');
		// The queried clock stops at the minute; a seconds field would promise precision the API lacks.
		const queried = definitionValue(contentEl, 'Última consulta');
		expect(queried).toBeDefined();
		expect(queried).not.toMatch(/\d{1,2}:\d{2}:\d{2}/u);
	});

	// Detection is always armed with a connected account now (Lote S, 2026-09-09): no toggle and no
	// arm button left in this row. `disarmed` here only ever means it is still waiting for one.
	it('shows a waiting-for-account row with no arm button while disarmed', () => {
		const { contentEl, render } = mountCompanion({
			getAssistedDetectionState: () => ({ status: 'disarmed', reason: 'initial', scheduler: idleScheduler(), lastSnapshotAt: null }),
		});

		render();

		expect(find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Activar detección')).toBeUndefined();
		expect(texts(contentEl)).toContain('Esperando cuenta');
	});
});

describe('Companion durable history surface', () => {
	// H18.36 (boceto lámina 2.5, David 26 sep): the panel reads itself once on its own — no
	// "Cargar historial" click required — and mounts below the card, only while idle.
	it('reads the Vault on its own, without a "Cargar historial" click, once idle', async () => {
		const loadSessionHistory = vi.fn(async (): Promise<SessionHistoryLoadResult> => ({ status: 'ok', sessions: [], ignored: 0 }));
		const { contentEl, render } = mountCompanion({ loadSessionHistory });

		render();

		const panel = find(contentEl, (node) => node.className.includes('tyrian-session-history'));
		expect(panel).toBeDefined();
		expect(loadSessionHistory).toHaveBeenCalledOnce();
		expect(find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Cargar historial')).toBeUndefined();

		await Promise.resolve();
		await Promise.resolve();
		expect(texts(contentEl)).toContain('No hay sesiones finalizadas');
		const refresh = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Actualizar historial');
		expect(refresh?.className).toContain('mod-link');
	});

	it('mounts nothing below the card while a session is running', () => {
		const { contentEl, render } = mountCompanion({ getSessionState: () => activeSession() });
		render();
		expect(find(contentEl, (node) => node.className.includes('tyrian-session-history'))).toBeUndefined();
	});

	/**
	 * Sabotage: reverting `renderSimpleSession` to gate the panel on `observed.status !== 'idle'`
	 * inverted, or to call `renderSessionHistoryPanel` unconditionally, makes one of the two cases
	 * above fail — either the idle case never sees a panel, or the active case sees one it should not.
	 */
	it('forces a fresh read once a session that just ended leaves the view idle, even if history already loaded once', async () => {
		let status: 'active' | 'idle' = 'active';
		const loadSessionHistory = vi.fn(async (): Promise<SessionHistoryLoadResult> => ({ status: 'ok', sessions: [], ignored: 0 }));
		const { render } = mountCompanion({
			loadSessionHistory,
			getSessionState: () => (status === 'active' ? activeSession() : { version: 1, status: 'idle' }),
		});
		render();
		expect(loadSessionHistory).not.toHaveBeenCalled();
		await Promise.resolve();
		status = 'idle';
		render();
		expect(loadSessionHistory).toHaveBeenCalledOnce();
		await Promise.resolve();
		await Promise.resolve();
		render();
		// The session just ended: a second render while still idle must NOT read the Vault again.
		expect(loadSessionHistory).toHaveBeenCalledOnce();
	});
});

/**
 * Audit 2.2: how many notes the durable history reads, measured on the path the player takes. The
 * real view calls the real `loadSessionHistory` of a core booted by `initializeRuntime`, whose
 * history service reads through the real session-history port over the real Obsidian vault
 * adapter; only the session status the view observes is driven by hand, and a vault change is
 * delivered through the callbacks that adapter registered with `vault.on`. The vault holds 3,000
 * notes that are not sessions and 30 that are.
 */
describe('Companion durable history: vault reads per action (audit 2.2)', () => {
	const FOREIGN_NOTES = 3_000;
	const SESSION_NOTES = 30;
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
	});

	async function mountOverRealCore(foreignNotes: number = FOREIGN_NOTES, sessionNotes: number = SESSION_NOTES) {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const notes = runtime.vaultNotes as Map<string, string>;
		for (let index = 0; index < foreignNotes; index += 1) {
			notes.set(`Notes/${String(index)}.md`, `# Note ${String(index)}\n\nNothing about a session.\n`);
		}
		for (let index = 0; index < sessionNotes; index += 1) {
			notes.set(`Tyrian Companion/sessions/${String(index)}.md`, await durableSessionNote(index));
		}
		// The harness's recording diagnostics port predates `fireAndForget`, which the boot now
		// calls; without a port the boot runs those actions directly, as the `main-*.test.ts` do.
		(runtime.core as unknown as { localDebugActions: null }).localDebugActions = null;
		await runtime.initializeRuntime();
		const vault = runtime.plugin.app.vault as unknown as { read: Mock; on: Mock };
		const read = vault.read;
		const core = runtime.core as unknown as Pick<CompanionActions, 'loadSessionHistory'>;
		const loads: Promise<SessionHistoryLoadResult>[] = [];
		let status: 'active' | 'idle' = 'idle';
		/** One Companion view over the booted core; a second call is the player opening it again. */
		const open = () => mountCompanion({
			loadSessionHistory: (source) => {
				const load = core.loadSessionHistory(source);
				loads.push(load);
				return load;
			},
			getSessionState: () => (status === 'active' ? activeSession() : { version: 1, status: 'idle' }),
		});
		/** Vault reads made by `action`, once every history load it started has settled. */
		const readsDuring = async (action: () => void): Promise<number> => {
			const before = read.mock.calls.length;
			action();
			while (loads.length > 0) await loads.shift();
			await Promise.resolve();
			await Promise.resolve();
			return read.mock.calls.length - before;
		};
		/**
		 * Changes the vault the way Obsidian does: the text lands, then every callback the plugin
		 * registered through `vault.on(name, …)` is called with the file. `event: null` is a change
		 * Obsidian never reports.
		 */
		const change = (path: string, content: string, event: 'create' | 'modify' | null): void => {
			notes.set(path, content);
			if (event === null) return;
			const file = Object.assign(new TFile(), { path });
			for (const [name, callback] of vault.on.mock.calls as [string, (file: TFile) => void][]) {
				if (name === event) callback(file);
			}
		};
		return {
			open, readsDuring, change, onBoot: read.mock.calls.length, runtime, vault,
			setStatus: (next: 'active' | 'idle') => { status = next; },
		};
	}

	// The index is the first thing in the core that stops listening to the vault before Obsidian
	// unloads the plugin: its four listeners go through `vault.offref` on the real shutdown.
	it('releases the four vault listeners of the history index when the runtime shuts down', async () => {
		const { open, readsDuring, runtime, vault } = await mountOverRealCore(2, 1);
		const offref = vi.fn();
		Object.assign(vault, { offref });
		const listenersOnBoot = vault.on.mock.calls.length;

		expect(await readsDuring(open().render)).toBe(3);
		const indexListeners = vault.on.mock.results.slice(listenersOnBoot).map((result) => result.value as unknown);
		expect(indexListeners).toHaveLength(4);
		expect(offref).not.toHaveBeenCalled();

		await runtime.shutdown();

		expect(offref.mock.calls.map(([ref]) => ref as unknown)).toEqual(indexListeners);
	});

	it('reads every Markdown note once on the first open and on "Actualizar historial", and afterwards only the notes Obsidian reported', async () => {
		const { open, readsDuring, change, setStatus, onBoot } = await mountOverRealCore();
		const everyNote = FOREIGN_NOTES + SESSION_NOTES;
		const { contentEl, render } = open();
		const endSession = async (): Promise<number> => {
			setStatus('active');
			const whileActive = await readsDuring(render);
			setStatus('idle');
			return whileActive + await readsDuring(render);
		};

		const onOpen = await readsDuring(render);
		expect(texts(contentEl)).toContain(`${String(SESSION_NOTES)} sesiones`);
		const onRepaint = await readsDuring(render);
		const second = open();
		const onSecondOpen = await readsDuring(second.render);
		expect(texts(second.contentEl)).toContain(`${String(SESSION_NOTES)} sesiones`);

		// A session ends and leaves its note: one new path in the listing.
		setStatus('active');
		const whileActive = await readsDuring(render);
		change(`Tyrian Companion/sessions/${String(SESSION_NOTES)}.md`, await durableSessionNote(SESSION_NOTES), 'create');
		setStatus('idle');
		const onSessionEnd = await readsDuring(render);
		expect(texts(contentEl)).toContain(`${String(SESSION_NOTES + 1)} sesiones`);

		// A note rewritten in place, reported by Obsidian: the same listing, one read.
		change('Tyrian Companion/sessions/0.md', '# Rewritten by hand, no longer a session\n', 'modify');
		const onReportedEdit = await endSession();
		expect(texts(contentEl)).toContain(`${String(SESSION_NOTES)} sesiones`);

		// The limit: an edit Obsidian never reports is not read until the player asks for a refresh.
		change('Tyrian Companion/sessions/1.md', '# Rewritten by hand, no longer a session\n', null);
		const onUnreportedEdit = await endSession();
		expect(texts(contentEl)).toContain(`${String(SESSION_NOTES)} sesiones`);
		const onRefresh = await readsDuring(() => {
			find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Actualizar historial')!.click();
		});
		expect(texts(contentEl)).toContain(`${String(SESSION_NOTES - 1)} sesiones`);

		expect({
			onBoot, onOpen, onRepaint, onSecondOpen, whileActive, onSessionEnd, onReportedEdit, onUnreportedEdit, onRefresh,
		}).toEqual({
			onBoot: 0, onOpen: everyNote, onRepaint: 0, onSecondOpen: 0, whileActive: 0, onSessionEnd: 1,
			onReportedEdit: 1, onUnreportedEdit: 0, onRefresh: everyNote + 1,
		});
	}, 60_000);
});

/** A valid schema 2 session note, unique per `index`: what the history counts as one session. */
async function durableSessionNote(index: number): Promise<string> {
	const frontmatter: Record<string, string | number | null> = {
		tc_schema: 2, tc_kind: 'gw2_farming_session', tc_session_ref: index.toString(16).padStart(64, '0'),
		tc_account_ref: 'b'.repeat(64),
		tc_started_at: '2026-08-13T08:00:00.000Z', tc_ended_at: '2026-08-13T09:00:00.000Z', tc_duration_ms: 3_600_000,
		tc_classification: 'exact', tc_confidence: 'high', tc_scope: 'observed_storage_net', tc_valuation_coverage: 'complete',
		tc_locale: 'en', tc_character: 'Rinopopo', tc_profession: 'Guardian', tc_build: null,
		tc_magic_find: 0, tc_detection_mode: null, tc_price_source: 'gw2-commerce-prices', tc_price_captured_at: '2026-08-13T09:00:00.000Z',
		tc_observed_immediate_copper: 100, tc_observed_listing_copper: 120, tc_sacks: 1,
		tc_sacks_per_hour_milli: 1000, tc_immediate_copper_per_hour: 100, tc_listing_copper_per_hour: 120,
		tc_reservation_status: 'not_evaluated', tc_reserved_quantity: null, tc_hold_status: 'not_evaluated', tc_held_quantity: null,
		tc_recommendation_status: 'not_evaluated', tc_execution: 'manual_in_game', tc_side_effects: 'none',
		tc_event: null, tc_event_source: null, tc_recommendation_action: null, tc_recommendation_quantity: null,
		tc_recommendation_route: null,
	};
	const blocks = await Promise.all(SESSION_NOTE_BLOCK_IDS.map(async (id) => {
		const content = `${id} content`;
		return `<!-- tyrian-companion:managed:start:${id} sha256=${await sha256Text(content)} -->\n${content}\n<!-- tyrian-companion:managed:end:${id} -->`;
	}));
	const yaml = Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
	return `---\n${yaml.join('\n')}\n---\n# Session\n\n${blocks.join('\n\n')}\n`;
}

/** H18.36 (boceto lámina 2.1): Avisos primero en el Laberinto, Botín primero el resto del año. */
describe('Companion gaveto order and Botín', () => {
	function drawerSummaries(contentEl: FakeElement): (string | null)[] {
		return walk(contentEl)
			.filter((node) => node.tag === 'details')
			.map((details) => details.children.find((child) => child.tag === 'summary')?.textContent ?? null);
	}

	it('puts Botín before Avisos outside the Labyrinth, with Detalle always last', () => {
		const { contentEl, render } = mountCompanion({ getSessionState: () => activeSession() });
		render();
		expect(drawerSummaries(contentEl)).toEqual(['Botín', 'Avisos', 'Detalle']);
	});

	it('puts Avisos before Botín inside the Labyrinth, with Detalle still last', () => {
		const { contentEl, render } = mountCompanion({
			getSessionState: () => activeSession(),
			getIngamePresence: () => ({
				status: 'present', presenceId: 'p', revision: 1, startedAtMs: 0, lastSeenAtMs: null,
				graceUntilMs: null, connections: 1, instances: 1,
				context: { source: 'nexus', state: 'gameplay', mapId: 866, character: 'Astra Uno', labyrinth: true },
			}),
		});
		render();
		expect(drawerSummaries(contentEl)).toEqual(['Avisos', 'Botín', 'Detalle']);
	});

	it('lists each observed item with its price, and the unpriced count in the closed suffix', () => {
		const { contentEl, render } = mountCompanion({
			getSessionState: () => activeSession(),
			getLiveSessionLoot: () => ({
				status: 'observing', sessionId: 'session', restored: false,
				rows: [
					{ itemId: 1, name: 'Barra de caramelo', quantity: 3, unitCopper: 100, totalCopper: 300, priceStatus: 'known' },
					{ itemId: 2, name: 'Objeto raro', quantity: 1, unitCopper: null, totalCopper: null, priceStatus: 'unquoted' },
				],
				knownTotalCopper: 300, sackQuantity: 4, hasUnknownValue: true, updatedAt: '2026-09-26T22:00:00.000Z', error: null,
			}),
		});
		render();
		const lootDrawer = walk(contentEl).find((node) => node.tag === 'details'
			&& node.children.find((child) => child.tag === 'summary')?.textContent === 'Botín')!;
		expect(lootDrawer.children.find((child) => child.tag === 'summary')?.children
			.find((child) => child.tag === 'small')?.textContent).toBe('2 objetos · 1 sin precio');
		const text = texts(lootDrawer).join(' ');
		expect(text).toContain('Barra de caramelo ×3');
		expect(text).toContain('Objeto raro ×1');
		expect(text).toContain('sin precio');
	});
});

describe('Companion saved note delivery', () => {
	it('offers the note the plugin just wrote and opens it', () => {
		const openSavedSessionNote = vi.fn();
		const { contentEl, render } = mountCompanion({
			openSavedSessionNote,
			getSavedSessionNotePath: () => 'Tyrian Companion/Sessions/2026-08-31.md',
			getSessionState: () => completedSession(),
			getSessionSummarySaveState: () => 'saved',
		});

		render();

		const open = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Abrir la nota');
		expect(open).toBeDefined();
		expect(open?.attributes.get('aria-label')).toBe('Abrir la nota: Tyrian Companion/Sessions/2026-08-31.md');

		open?.click();
		expect(openSavedSessionNote).toHaveBeenCalledOnce();
	});

	it('omits the action while no note is durable', () => {
		const { contentEl, render } = mountCompanion({
			openSavedSessionNote: vi.fn(),
			getSavedSessionNotePath: () => null,
			getSessionState: () => completedSession(),
			getSessionSummarySaveState: () => 'failed',
		});

		render();

		expect(find(contentEl, (node) => node.textContent === 'Abrir la nota')).toBeUndefined();
	});
});

describe('Companion API settlement surface', () => {
	const waiting = () => ({
		status: 'waiting' as const, windowMs: 600_000, waitedMs: 180_000, remainingMs: 420_000,
		dueAt: Date.parse('2026-08-31T10:10:00.000Z'),
	});
	const captureButton = (contentEl: FakeElement, text: string) =>
		find(contentEl, (node) => node.tag === 'button' && node.textContent === text);

	it('«Capturar ya» answers the click at once: disabled and saying the capture is under way until it ends', async () => {
		let finish: () => void = () => undefined;
		const captureSessionFinalNow = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
		const { contentEl, render } = mountCompanion({
			captureSessionFinalNow, getSessionState: () => stoppingSession(), getSessionSettlementWait: waiting,
		});
		render();

		captureButton(contentEl, 'Capturar ya')?.click();
		await Promise.resolve();

		expect(captureSessionFinalNow).toHaveBeenCalledOnce();
		expect(captureButton(contentEl, 'Capturar ya')).toBeUndefined();
		const busy = captureButton(contentEl, 'Capturando la instantánea final…');
		expect(busy?.disabled).toBe(true);

		finish();
		await Promise.resolve(); await Promise.resolve();
		expect(captureButton(contentEl, 'Capturar ya')?.disabled).toBe(false);
	});

	it('a refused «Capturar ya» does not leak its failure line into the next session\'s wait', async () => {
		let wait: ReturnType<typeof waiting> | null = waiting();
		let session: SessionState = stoppingSession();
		const { contentEl, render } = mountCompanion({
			captureSessionFinalNow: vi.fn(async () => { throw new Error('refused'); }),
			getSessionState: () => session, getSessionSettlementWait: () => wait,
		});
		render();
		captureButton(contentEl, 'Capturar ya')?.click();
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		expect(texts(contentEl)).toContain('No se pudo completar la acción de sesión.');

		wait = null; session = activeSession();
		render();
		wait = waiting(); session = stoppingSession();
		render();

		expect(captureButton(contentEl, 'Capturar ya')).toBeDefined();
		expect(texts(contentEl)).not.toContain('No se pudo completar la acción de sesión.');
	});

	it('«Capturar ya» shows the failure on the card instead of swallowing it', async () => {
		const captureSessionFinalNow = vi.fn(async () => { throw new Error('refused'); });
		const { contentEl, render } = mountCompanion({
			captureSessionFinalNow, getSessionState: () => stoppingSession(), getSessionSettlementWait: waiting,
		});
		render();

		captureButton(contentEl, 'Capturar ya')?.click();
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

		expect(texts(contentEl)).toContain('No se pudo completar la acción de sesión.');
		expect(captureButton(contentEl, 'Capturar ya')?.disabled).toBe(false);
	});

	it('explains the wait, counts it down and keeps the escape hatch with its cost', async () => {
		const captureSessionFinalNow = vi.fn(async () => undefined);
		const { contentEl, render } = mountCompanion({
			captureSessionFinalNow,
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => ({
				status: 'waiting', windowMs: 600_000, waitedMs: 180_000, remainingMs: 420_000,
				dueAt: Date.parse('2026-08-31T10:10:00.000Z'),
			}),
		});

		render();

		// The countdown is the card's single figure while stopping (FICHA §2: dt "Captura final en",
		// dd mm:ss), not a sentence: label and value are separate nodes.
		expect(texts(contentEl)).toContain('Captura final en');
		expect(texts(contentEl)).toContain('07:00');
		const why = texts(contentEl).find((text) => text.includes('minutos de retraso'));
		expect(why).toBeDefined();
		expect(texts(contentEl)).toContain('Puede no incluir los últimos minutos; la sesión quedará marcada como estimada.');

		const captureNow = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Capturar ya');
		expect(captureNow).toBeDefined();
		captureNow?.click();
		await Promise.resolve();
		expect(captureSessionFinalNow).toHaveBeenCalledOnce();

		// H18.36 (boceto lámina 2.2): the cierre's own recorrido, fin marcado (done) · lectura final
		// (en curso, hacia la hora del wait) · nota guardada (pendiente).
		const receipt = find(contentEl, (node) => node.className === 'tyrian-receipt');
		expect(receipt).toBeDefined();
		const steps = receipt!.children.filter((node) => node.tag === 'li');
		expect(steps.map((step) => step.attributes.get('data-step'))).toEqual(['done', 'current', 'skip']);
		expect(texts(contentEl)).toContain('Fin marcado');
		expect(texts(contentEl)).toContain(formatClock(Date.parse('2026-08-31T10:00:00.000Z'), 'es'));
		expect(texts(contentEl)).toContain('Lectura final');
		expect(texts(contentEl)).toContain(`hacia ${formatClock(Date.parse('2026-08-31T10:10:00.000Z'), 'es')}`);
		expect(texts(contentEl)).toContain('Nota guardada');
		expect(texts(contentEl)).toContain('después');
	});

	/**
	 * Sabotage check: reverting `buildSessionCardModel`'s 'stopping'+wait branch to drop `receipt`
	 * (the pre-H18.36 shape) makes the `tyrian-receipt` lookup above resolve to `undefined` and the
	 * `toBeDefined()` assertion fail — the exact regression this test exists to catch.
	 */

	// H18.7: a final capture that failed after the wait used to leave the card with no action at all.
	it('offers a visible retry once the final capture failed after the wait', async () => {
		const stopManualSession = vi.fn(async () => undefined);
		const { contentEl, render } = mountCompanion({
			stopManualSession,
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => null,
			getSessionStopFailure: () => ({ code: 'snapshot_failed', message: 'offline' }),
		});

		render();

		const retry = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Reintentar finalizar sesión');
		expect(retry).toBeDefined();
		retry?.click();
		await Promise.resolve();
		expect(stopManualSession).toHaveBeenCalledOnce();

		// H18.36 (boceto lámina 2.3): the recorrido shows the failed step, never a code on screen.
		const receipt = find(contentEl, (node) => node.className === 'tyrian-receipt');
		const steps = receipt!.children.filter((node) => node.tag === 'li');
		expect(steps.map((step) => step.attributes.get('data-step'))).toEqual(['done', 'failed', 'skip']);
		expect(texts(contentEl)).toContain('pendiente');
	});

	// H18.36 (boceto lámina 2.3, decidido): the meta names when the watch retries on its own.
	it('names the automatic retry time instead of a generic "reconciliando" once one is scheduled', () => {
		const { contentEl, render } = mountCompanion({
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => null,
			getSessionStopFailure: () => ({ code: 'snapshot_failed', message: 'offline' }),
			getSessionAutoRetryAt: () => Date.parse('2026-08-31T10:15:00.000Z'),
		});
		render();
		expect(texts(contentEl)).not.toContain('Reconciliando el inventario y guardando el resumen…');
		const retryTime = formatClock(Date.parse('2026-08-31T10:15:00.000Z'), 'es');
		expect(texts(contentEl).some((text) => text.includes(retryTime))).toBe(true);
	});

	it('offers "Abandonar sesión" beside the retry only when the stop cannot finish on its own', async () => {
		const confirmAbandonSession = vi.fn();
		const { contentEl, render } = mountCompanion({
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => null,
			getSessionStopFailure: () => ({ code: 'account_changed', message: 'another account' }),
			canAbandonSession: () => true,
			confirmAbandonSession,
		});
		render();
		const abandon = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Abandonar sesión');
		expect(abandon).toBeDefined();
		expect(find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Reintentar finalizar sesión')).toBeDefined();
		abandon?.click();
		await Promise.resolve();
		// The click only asks for confirmation; nothing is abandoned from here.
		expect(confirmAbandonSession).toHaveBeenCalledOnce();

		const recoverable = mountCompanion({
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => null,
			getSessionStopFailure: () => ({ code: 'snapshot_failed', message: 'offline' }),
			canAbandonSession: () => false,
		});
		recoverable.render();
		expect(find(recoverable.contentEl, (node) => node.tag === 'button' && node.textContent === 'Abandonar sesión')).toBeUndefined();
	});

	it('shows the ordinary reconciling copy when no window is pending', () => {
		const { contentEl, render } = mountCompanion({
			captureSessionFinalNow: vi.fn(async () => undefined),
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => null,
		});

		render();

		expect(texts(contentEl)).toContain('Reconciliando el inventario y guardando el resumen…');
		expect(texts(contentEl)).not.toContain('Captura final en');
		expect(find(contentEl, (node) => node.textContent === 'Capturar ya')).toBeUndefined();
	});
});

/** Ranura 2 of `diseno-sesion/FICHA.md`: a single native `.callout[data-callout]`, not a bespoke warning line. */
describe('Companion incident callout', () => {
	it('carries the first projected incident into the card and counts the rest', () => {
		const { contentEl, render } = mountCompanion({
			getSessionState: () => stoppingSession(),
			getSessionStopFailure: () => ({ code: 'rate_limited', message: 'rate limited' }),
			getConnectionState: () => ({ status: 'error', code: 'unavailable', message: 'offline', retryAt: null }),
		});

		render();

		const callout = find(contentEl, (node) => node.className === 'callout');
		expect(callout?.attributes.get('data-callout')).toBeDefined();
		expect(callout?.attributes.get('role')).toBe('alert');
		expect(texts(contentEl).some((text) => text.includes('Final: '))).toBe(true);
		expect(texts(contentEl)).toContain('+1 más');
	});

	it('mounts no callout at all while nothing needs attention', () => {
		const { contentEl, render } = mountCompanion();

		render();

		expect(find(contentEl, (node) => node.className === 'callout')).toBeUndefined();
	});

	it('surfaces a failed connection alone as a warning callout line with its own check action', async () => {
		const checkConnection = vi.fn(async () => ({ status: 'idle' }) as never);
		const { contentEl, render } = mountCompanion({
			checkConnection,
			getConnectionState: () => ({ status: 'error', code: 'unavailable', message: 'offline', retryAt: null }),
		});

		render();

		// A failed connection also feeds `companion-status-model.ts`'s generic incident line (its own
		// closed, non-leaking wording, tone `error`); this line is the extra one the callout carries
		// underneath it. H15.24 (commit f869eaa) stopped showing the gateway's raw `message` here and
		// switched to Settings' per-code catalogue (`connectionErrorKey`), so the callout must show
		// the translated guidance for the `unavailable` code and never leak the raw 'offline' text.
		const callout = find(contentEl, (node) => node.className === 'callout');
		expect(callout?.attributes.get('data-callout')).toBe('error');
		expect(texts(contentEl)).toContain(createTranslator('es').t(connectionErrorKey('unavailable')));
		expect(texts(contentEl)).not.toContain('offline');
		// Both the Detalle row (decision 4) and this callout line offer the same recheck, so search
		// broadly instead of assuming which one the walk visits first.
		const checkButtons = walk(contentEl).filter((node) => node.tag === 'button' && node.textContent === 'Comprobar conexión');
		expect(checkButtons.length).toBeGreaterThanOrEqual(1);

		checkButtons[0]?.click();
		await Promise.resolve();
		expect(checkConnection).toHaveBeenCalledOnce();
	});

	it('mounts no callout line while the connection is healthy', () => {
		const { contentEl, render } = mountCompanion();

		render();

		expect(texts(contentEl)).not.toContain('offline');
		expect(find(contentEl, (node) => node.className === 'callout')).toBeUndefined();
	});
});

describe('Companion measured quality line', () => {
	it('states how trustworthy the measured net is once a delta exists', () => {
		const { contentEl, render } = mountCompanion({
			getSessionState: () => provisionalSession(),
			getProvisionalDelta: () => ({
				status: 'limited', itemChanges: [], currencyChanges: [], window: null,
			}) as never,
		});

		render();

		// A badge beside the character line, the reasoning in its tooltip: never a sentence of its own.
		const badge = find(contentEl, (node) => node.className.includes('tyrian-companion-session__badge'));
		expect(badge?.textContent).toBe('Limitada');
		expect(badge?.attributes.get('title')).toBe('Calidad: Comparación de almacenamiento · Limitado');
		expect(texts(contentEl).some((text) => text.startsWith('Calidad: '))).toBe(false);
	});

	it('claims nothing while the session is still running', () => {
		const { contentEl, render } = mountCompanion({ getSessionState: () => activeSession() });

		render();

		expect(texts(contentEl).some((text) => text.startsWith('Calidad: '))).toBe(false);
	});
});

/**
 * Hebra's report (4 oct 2026): on a consult device «Iniciar sesión» stayed enabled with a key
 * selected, and a tap only raised the consult notice. It is disabled there, with the reason in the
 * card's own meta line, the same way a missing key already disables it.
 */
describe('Companion start in consult mode', () => {
	it('consult: «Iniciar sesión» is disabled and the meta line says consult mode', () => {
		const openManualSessionStart = vi.fn();
		const { contentEl, render } = mountCompanion({ openManualSessionStart, getCollectorMode: () => 'consult' });

		render();

		const start = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Iniciar sesión');
		expect(start?.disabled).toBe(true);
		// The reason takes the card's meta line, where the account line was: a consult device never checks it.
		const meta = find(contentEl, (node) => node.className.includes('tyrian-companion-session__meta'));
		expect(meta?.textContent).toContain('modo consulta');
	});

	it('collector: «Iniciar sesión» stays enabled', () => {
		const { contentEl, render } = mountCompanion({ getCollectorMode: () => 'collector' });

		render();

		const start = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Iniciar sesión');
		expect(start?.disabled).toBe(false);
		const meta = find(contentEl, (node) => node.className.includes('tyrian-companion-session__meta'));
		expect(meta?.textContent).not.toContain('modo consulta');
	});
});

describe('Companion saved-session decision', () => {
	// 6 oct 2026: the live surface no longer paints the archived account session, its recovery or its
	// export (the data and the commands stay). `companion-view-live.test.ts` asserts that on the real DOM.
	it('replaces the start action with recovery instead of offering a start that would be refused', async () => {
		const recoverSession = vi.fn(async () => undefined);
		const openManualSessionStart = vi.fn();
		const { contentEl, render } = mountCompanion({
			recoverSession, openManualSessionStart,
			getSessionRecoveryState: () => availableRecovery(),
		});

		render();

		expect(texts(contentEl)).toContain('Recuperación disponible');
		expect(find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Iniciar sesión')).toBeUndefined();
		const discard = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Descartar sesión guardada');
		expect(discard).toBeDefined();
		const recover = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Recuperar sesión');
		expect(recover?.disabled).toBe(false);

		recover?.click();
		await Promise.resolve();
		expect(recoverSession).toHaveBeenCalledOnce();
		expect(openManualSessionStart).not.toHaveBeenCalled();
	});

	it('classifies the pilot recovery from the same card and only when the pilot asks', () => {
		const classifyPilotRecovery = vi.fn(async () => true);
		const { contentEl, render } = mountCompanion({
			classifyPilotRecovery,
			getSessionRecoveryState: () => availableRecovery(),
			isPilotRecoveryClassificationRequired: () => true,
			getPilotRecoveryKind: () => null,
		});

		render();

		const select = find(contentEl, (node) => node.tag === 'select');
		expect(select?.disabled).toBe(false);
		if (select === undefined) throw new Error('Expected the pilot classification control.');
		select.value = 'forced_restart';
		select.listeners.get('change')?.[0]?.();
		expect(classifyPilotRecovery).toHaveBeenCalledWith('forced_restart');
	});

	it('omits the classification control while the pilot does not require it', () => {
		const { contentEl, render } = mountCompanion({ getSessionRecoveryState: () => availableRecovery() });

		render();

		expect(find(contentEl, (node) => node.tag === 'select')).toBeUndefined();
	});
});

describe('Companion account check', () => {
	it('offers the check on the surface that shows the failure', async () => {
		const checkConnection = vi.fn(async () => ({ status: 'idle' }) as never);
		const { contentEl, render } = mountCompanion({
			checkConnection,
			getConnectionState: () => ({ status: 'error', code: 'unavailable', message: 'offline', retryAt: null }),
		});

		render();

		const check = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Comprobar conexión');
		expect(check?.disabled).toBe(false);

		check?.click();
		await Promise.resolve();
		expect(checkConnection).toHaveBeenCalledOnce();
	});

	it('keeps the check disabled while the shared cooldown runs', () => {
		const { contentEl, render } = mountCompanion({
			getConnectionState: () => ({
				status: 'error', code: 'rate_limited', message: 'wait', retryAt: Date.now() + 30_000,
			}),
		});

		render();

		const check = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Comprobar conexión');
		expect(check?.disabled).toBe(true);
	});

	it('omits the check button while the account is answering, though the row still names it', () => {
		const { contentEl, render } = mountCompanion();

		render();

		// The Detalle row's label ("Comprobar conexión") is permanent (Lote P); only the button
		// that retries the check disappears while the account already answers.
		expect(find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Comprobar conexión')).toBeUndefined();
	});
});

/**
 * FICHA §2/§4 (Lote P, 9 sep 2026): one `mod-cta` in the whole card and at most two `<p>` per
 * drawer, across the five compressed states of the anatomy table.
 */
describe('Companion card: one mod-cta and flat drawers (Lote P)', () => {
	function countModCta(root: FakeElement): number {
		return walk(root).filter((node) => node.tag === 'button' && node.className.split(' ').includes('mod-cta')).length;
	}

	function maxParagraphsPerDrawer(root: FakeElement): number {
		const drawers = walk(root).filter((node) => node.className.includes('tyrian-companion-session__drawer-body'));
		return Math.max(0, ...drawers.map((drawer) => walk(drawer).filter((node) => node.tag === 'p').length));
	}

	it.each([
		['Reposo', {}],
		['Activa 0s', { getSessionState: () => activeSession() }],
		['Activa 30 min', {
			getSessionState: () => activeSession(),
			getLiveSessionLoot: () => ({
				status: 'observing' as const, sessionId: 'session', restored: false, rows: [],
				knownTotalCopper: 400_00, sackQuantity: 12, hasUnknownValue: false,
				updatedAt: '2026-08-31T09:00:00.000Z', error: null,
			}),
		}],
		['Terminada', {
			getSessionState: () => completedSession(), getSessionSummarySaveState: () => 'saved' as const,
			getSavedSessionNotePath: () => 'Tyrian Companion/Sessions/2026-08-31.md',
			openSavedSessionNote: () => undefined,
		}],
		['Reposo + callout', {
			getConnectionState: () => ({ status: 'error' as const, code: 'unavailable', message: 'offline', retryAt: null }),
		}],
	] as const)('%s: one mod-cta, at most two <p> in any drawer', (_label, overrides) => {
		const { contentEl, render } = mountCompanion(overrides);

		render();

		expect(countModCta(contentEl)).toBe(1);
		expect(maxParagraphsPerDrawer(contentEl)).toBeLessThanOrEqual(2);
	});
});

function stoppingSession(): SessionState {
	return {
		version: 1, status: 'stopping', sessionId: 'session',
		stopRequestedAt: '2026-08-31T10:00:00.000Z',
		baseline: { completedAt: '2026-08-31T09:00:00.000Z' },
		startContext: { characterName: 'Rinopopo' },
	} as unknown as SessionState;
}

function activeSession(): SessionState {
	return {
		version: 1, status: 'active', sessionId: 'session',
		baseline: { completedAt: '2026-08-31T09:00:00.000Z' },
		startContext: { characterName: 'Rinopopo' },
	} as unknown as SessionState;
}

function provisionalSession(): SessionState {
	return {
		version: 1, status: 'provisional', sessionId: 'session',
		baseline: { completedAt: '2026-08-31T09:00:00.000Z' },
		finalSnapshot: { completedAt: '2026-08-31T10:10:00.000Z' },
		startContext: { characterName: 'Rinopopo' },
	} as unknown as SessionState;
}

function availableRecovery(): SessionRecoveryState {
	return { status: 'available', state: activeSession() } as unknown as SessionRecoveryState;
}

function mountCompanion(overrides: Partial<CompanionActions> = {}): {
	contentEl: FakeElement;
	actions: CompanionActions;
	render: () => void;
} {
	const document = new FakeDocument();
	const contentEl = new FakeElement('div', document);
	const actions: CompanionActions = { ...baseActions(), ...overrides };
	// No projection stub: the card is asserted against the real status projection, because a fake
	// one would keep every integrated line green while the model stopped feeding it.
	// The host's `setIcon`, recording the Lucide id on the element as the Obsidian test double does.
	const ui = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };
	const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
		actions, contentEl, refreshInterval: null,
		ui,
		headerElapsed: null, checkButton: null,
		liveFigures: [], liveFiguresKind: null, calloutSlot: null,
		drawerOpen: { detail: false, alerts: false, history: false },
		recoveryOwnerDetail: null, recoveryOwnerExpiresAt: null, recoveryRecoverButton: null, recoveryDiscardButton: null,
		detectionTimelineNodes: null, pendingConfirmationContainer: null, pendingConfirmationFocusTarget: null,
		pendingConfirmationKey: null,
		productShell: null, productShellKey: null, sessionHistoryController: null, sessionHistoryMount: null,
	});
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
	const render = (TyrianCompanionView.prototype as unknown as { render(this: typeof harness): void }).render;
	return { contentEl, actions, render: () => { render.call(harness); } };
}

function baseActions(): CompanionActions {
	return {
		getLocale: () => 'es',
		getConnectionState: () => ({
			status: 'connected',
			details: { account: { id: 'account', name: 'Rinopopo.1234' }, keyName: 'key', scopes: [], missingRecommendedScopes: [], hasFutureUrlRestrictions: false },
		}) as never,
		checkConnection: async () => ({ status: 'idle' }) as never,
		getSessionState: (): SessionState => ({ version: 1, status: 'idle' }),
		getAssistedDetectionState: () => armedDetection(),
		getDetectionQualityState: () => ({ status: 'ready' }),
		getSessionDetectionQuality: () => null,
		getDetectionQualityStats: () => null,
		getPendingProposalState: () => ({ status: 'ready', pendingCount: 0, next: null }),
		reviewPendingProposal: async () => false,
		dismissPendingProposal: async () => undefined,
		openPendingSessionStart: () => undefined,
		stopPendingSession: async () => undefined,
		armAssistedDetection: async () => 'completed',
		disarmAssistedDetection: () => undefined,
		dismissAssistedProposal: async () => undefined,
		getSessionStartFailure: () => null,
		getSessionStopFailure: () => null,
		getProvisionalDelta: () => null,
		getContaminationReview: () => null,
		getLootPresentation: () => null,
		getLiveSessionLoot: () => ({ status: 'idle' }),
		getSessionSummarySaveState: () => 'unknown',
		getStoredSessionLootSummary: () => null,
		confirmClearCompletedSession: () => undefined,
		getSessionRecoveryState: () => ({ status: 'none' }),
		openManualSessionStart: () => undefined,
		stopManualSession: async () => undefined,
		recoverSession: async () => undefined,
		confirmDiscardRecoveredSession: () => undefined,
		loadSessionHistory: async () => ({ status: 'ok', sessions: [], ignored: 0 }),
		hasConfiguredApiKey: () => true,
		getHalloweenState: () => ({ status: 'ready', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null }),
		getHalloweenPriceAlertState: () => ({ status: 'ready', projection: null, notices: [], unreadCount: 0 }),
		getEmittedAlerts: () => [],
	};
}

function armedDetection(): AssistedDetectionState {
	const attemptedAt = Date.parse('2026-08-31T10:00:00.000Z');
	return {
		status: 'armed', armedAt: '2026-08-31T09:00:00.000Z', lastSnapshotAt: '2026-08-31T10:00:00.000Z',
		scheduler: {
			status: 'scheduled', intervalMs: 120_000, nextRunAt: attemptedAt + 120_000,
			lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, consecutiveFailures: 0,
		},
	};
}

function idleScheduler(): AssistedDetectionState['scheduler'] {
	return { status: 'idle', intervalMs: null, nextRunAt: null, lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 };
}

function completedSession(): SessionState {
	return {
		version: 1, status: 'complete', sessionId: 'session',
		baseline: { completedAt: '2026-08-31T09:00:00.000Z' },
		finalSnapshot: { completedAt: '2026-08-31T10:10:00.000Z' },
		classification: 'exact',
		startContext: { characterName: 'Rinopopo' },
	} as unknown as SessionState;
}

function freshProposal(): PendingProposal {
	return {
		version: 1, phase: 'start', proposalId: 'proposal', accountId: 'account',
		binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 },
		proposal: { evidenceQuality: 'complete' }, detectedAt: '2026-08-31T09:59:00.000Z',
		staleAt: '2099-01-01T00:00:00.000Z',
	} as unknown as PendingProposal;
}

function unreadHalloweenState() {
	const notice: HalloweenNoticeV1 = {
		version: 1, vaultId: 'vault', accountRef: 'account', noticeId: 'notice', episodeId: 'episode',
		observedAt: '2026-08-31T12:00:00.000Z', source: 'assisted_poll', wording: 'observed_change',
		coverage: 'complete', acknowledgedAt: null,
		items: [{ itemId: 36_038, quantity: 4, name: 'Saco de Halloween', netUnitCopper: null, priceStatus: 'no_quote',
			reasons: [{ code: 'first_seen' }] }],
	};
	return { status: 'unread' as const, notices: [notice], unreadCount: 1, lastObservedAt: notice.observedAt, comparison: null };
}

function priceNotice(): HalloweenPriceNoticeV1 {
	return {
		version: 1, vaultId: 'vault', accountRef: 'account', noticeId: 'price-notice',
		observedAt: '2026-08-31T12:00:00.000Z', capturedAtMs: Date.parse('2026-08-31T12:00:00.000Z'),
		bidCopper: 2_000, p90Copper: 1_500, referenceDays: 30, minimumAboveP90Bps: 500, acknowledgedAt: null,
	} as unknown as HalloweenPriceNoticeV1;
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function find(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement | undefined {
	return walk(root).find(predicate);
}

function texts(root: FakeElement): string[] {
	return walk(root).map(({ textContent }) => textContent);
}

function termsAndDetails(root: FakeElement): string[][] {
	return walk(root).filter(({ tag }) => tag === 'dt').map(({ textContent }) => [textContent]);
}

/** Reads the `dd` that follows a `dt` with the given term, wherever the list nests it. */
function definitionValue(root: FakeElement, term: string): string | undefined {
	for (const node of walk(root)) {
		const index = node.children.findIndex((child) => child.tag === 'dt' && child.textContent === term);
		if (index >= 0) return node.children[index + 1]?.textContent;
	}
	return undefined;
}

interface FakeOptions {
	readonly text?: string;
	readonly cls?: string;
	readonly type?: string;
	readonly value?: string;
	readonly attr?: Record<string, string>;
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	hidden = false;
	addEventListener(_type: string, _listener: () => void): void { /* no test here exercises visibilitychange */ }
	removeEventListener(_type: string, _listener: () => void): void { /* symmetric no-op */ }
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	readonly win = {
		setInterval: (callback: () => void, _delay: number) => { this.scheduledInterval = callback; return 1; },
		clearInterval: (_handle: number) => { this.scheduledInterval = null; },
	};
	get doc(): FakeDocument { return this.ownerDocument; }
	scheduledInterval: (() => void) | null = null;
	className = '';
	textContent = '';
	id = '';
	tabIndex = 0;
	type = '';
	step = '';
	value = '';
	checked = false;
	disabled = false;
	hidden = false;
	open = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
		this.type = options.type ?? '';
		this.value = options.value ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	/** Kept only so a retained panel can leave the tree on its own (`parentElement?.removeChild`). */
	parentElement: FakeElement | null = null;
	empty(): void { for (const child of this.children.splice(0)) child.parentElement = null; this.textContent = ''; }
	createEl(tag: string, options?: FakeOptions): FakeElement { return this.appendChild(tag, options); }
	private appendChild(tag: string, options?: FakeOptions): FakeElement {
		return this.insertBefore(new FakeElement(tag, this.ownerDocument, options), null);
	}
	append(...nodes: FakeElement[]): void { for (const node of nodes) this.insertBefore(node, null); }
	insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
		node.parentElement?.removeChild(node);
		this.children.splice(reference === null ? this.children.length : this.children.indexOf(reference), 0, node);
		node.parentElement = this;
		return node;
	}
	removeChild(node: FakeElement): FakeElement {
		this.children.splice(this.children.indexOf(node), 1);
		node.parentElement = null;
		return node;
	}
	createDiv(options?: FakeOptions): FakeElement { return this.appendChild('div', options); }
	createSpan(options?: FakeOptions): FakeElement { return this.appendChild('span', options); }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	setText(value: string): void { this.textContent = value; }
	appendText(value: string): void { this.textContent = `${this.textContent}${value}`; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	removeClass(value: string): void { this.className = this.className.split(' ').filter((entry) => entry !== value).join(' '); }
	toggleClass(value: string, on: boolean): void { if (on) this.addClass(value); else this.removeClass(value); }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
	click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
	focus(): void { this.ownerDocument.activeElement = this; }
	contains(target: FakeElement | null): boolean {
		return target === this || this.children.some((child) => child.contains(target));
	}
}
