import { afterEach, describe, expect, it, vi } from 'vitest';

import { TyrianCompanionView, type CompanionActions } from './companion-view';
import { ProductActionController } from './product-action-controller';
import { mountSessionHistoryPanel, SessionHistoryPanelController, type SessionHistoryPanelMount } from './session-history-panel';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { LiveSessionLootRow, LiveSessionLootState } from '../sessions/live-session-loot';
import type { SessionState } from '../sessions/session';
import type { DurableSessionHistoryRecord } from '../sessions/session-history';

/**
 * Audit V3 (findings 3.5 and 3.6). Every figure here is a COUNT of nodes the fake DOM was asked to
 * create, never a duration: a clock would measure the machine, and what the audit asks is how much
 * of the durable history and of the live loot list a repaint builds again when nothing moved.
 *
 * The sizes are a ladder, not a claim about a real player: the repo names 8 sessions in one real
 * install (`docs/CHANGELOG.md`) and 14 in the design sheet (`docs/diseno/h18-31-interfaz`), and has
 * no source at all for how many distinct items a long session observes.
 */

const HISTORY_SIZES = [30, 300, 3_000] as const;
const LOOT_SIZES = [10, 100, 1_000] as const;
/** Gains lines per stored session in the "with loot" column; the notes carry no cap of their own. */
const LOOT_LINES_PER_SESSION = 8;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Durable history: nodes built per paint (audit 3.6)', () => {
	it.each(HISTORY_SIZES)('builds 7 nodes per session, and 12 more for a session with 8 gains lines, at %i sessions', async (count) => {
		const bare = await mountedHistory(sessionRecords(count, 0));
		expect(bare.document.created - bare.createdBeforeReady).toBe(HISTORY_FIXED_NODES + (NODES_PER_SESSION * count));
		expect(historyRows(bare.container)).toHaveLength(count);
		const performance = walk(bare.container).find((node) => node.className === 'tyrian-session-history__performance')!;
		const groups = walk(performance).find((node) => node.tag === 'tbody')!;
		expect(groups.children).toHaveLength(1);
		expect(walk(groups.children[0]!)).toHaveLength(PERFORMANCE_GROUP_NODES);
		expect(walk(performance)).toHaveLength(PERFORMANCE_SECTION_NODES + PERFORMANCE_TABLE_NODES + PERFORMANCE_GROUP_NODES);

		const withLoot = await mountedHistory(sessionRecords(count, LOOT_LINES_PER_SESSION));
		expect(withLoot.document.created - withLoot.createdBeforeReady)
			.toBe(HISTORY_FIXED_NODES + (NODES_PER_SESSION_WITH_LOOT * count));
	});

	it('adds one comparison row per distinct condition group, independently of the session rows', async () => {
		const sessions = sessionRecords(30, 0);
		const oneGroup = await mountedHistory(sessions);
		const twoGroups = await mountedHistory(sessions.map((session, index) => index < 15 ? {
			...session,
			comparisonMetadata: { buildRef: 'c'.repeat(64), magicFind: { observable: 300, manual: null, unobservedBuffs: true } },
		} : session));
		const performance = walk(twoGroups.container).find((node) => node.className === 'tyrian-session-history__performance')!;
		const groups = walk(performance).find((node) => node.tag === 'tbody')!;
		expect(groups.children).toHaveLength(2);
		for (const group of groups.children) expect(walk(group)).toHaveLength(PERFORMANCE_GROUP_NODES);
		expect(walk(performance)).toHaveLength(PERFORMANCE_SECTION_NODES + PERFORMANCE_TABLE_NODES + 2 * PERFORMANCE_GROUP_NODES);
		expect(historyRows(twoGroups.container)).toHaveLength(30);
		expect((twoGroups.document.created - twoGroups.createdBeforeReady) - (oneGroup.document.created - oneGroup.createdBeforeReady))
			.toBe(PERFORMANCE_GROUP_NODES);
	});

	it.each(HISTORY_SIZES)('builds no history node on a repaint of the Companion tab with %i unchanged sessions', async (count) => {
		const companion = await idleCompanion(sessionRecords(count, LOOT_LINES_PER_SESSION));
		const section = historySection(companion.contentEl);
		const nodesInPanel = walk(section).length;
		expect(nodesInPanel).toBe(HISTORY_SHELL_NODES + HISTORY_FIXED_NODES + (NODES_PER_SESSION_WITH_LOOT * count));
		const textBefore = allText(section);

		const mark = companion.document.created;
		companion.view.render();

		const repainted = historySection(companion.contentEl);
		expect(id(repainted)).toBe(id(section));
		expect(walk(repainted).filter((node) => node.serial > mark)).toHaveLength(0);
		expect(walk(repainted)).toHaveLength(nodesInPanel);
		expect(allText(repainted)).toBe(textBefore);
		expect(companion.loadSessionHistory).toHaveBeenCalledOnce();
	});

	it('keeps the totals over every session: 300 sessions add up to 300 hours and 3,000 sacks, before and after a repaint', async () => {
		const companion = await idleCompanion(sessionRecords(300, LOOT_LINES_PER_SESSION));
		const metrics = (): string[] => walk(historySection(companion.contentEl))
			.filter((node) => node.className === 'tyrian-session-history__metric')
			.map((node) => node.children.map((child) => child.textContent).join(' = '));
		const expected = ['Sesiones = 300', 'Duración total = 300 h', 'Sacos = 3000'];
		expect(metrics().slice(0, 3)).toEqual(expected);
		expect(metrics()).toHaveLength(4);
		expect(historyRows(companion.contentEl)).toHaveLength(300);

		companion.view.render();

		expect(metrics().slice(0, 3)).toEqual(expected);
		expect(historyRows(companion.contentEl)).toHaveLength(300);
		expect(allText(historySection(companion.contentEl))).toContain('300 sesiones · leídas a las');
	});

	it('keeps every row it already had when a session is added, and builds only the new one at the top', async () => {
		const sessions = sessionRecords(30, LOOT_LINES_PER_SESSION);
		const history = await mountedHistory(sessions);
		const rowsBefore = historyRows(history.container);
		const ledger = rowsBefore[0]!.parentElement!;
		const table = ledger.parentElement!;

		sessions.push(sessionRecords(31, LOOT_LINES_PER_SESSION)[30]!);
		const mark = history.document.created;
		await history.controller.load();

		const rowsAfter = historyRows(history.container);
		expect(rowsAfter).toHaveLength(31);
		expect(ids(rowsAfter.slice(1))).toEqual(ids(rowsBefore));
		expect(rowsAfter[0]!.serial).toBeGreaterThan(mark);
		expect(id(rowsAfter[0]!.parentElement)).toBe(id(ledger));
		expect(id(ledger.parentElement)).toBe(id(table));
		expect(walk(ledger).filter((node) => node.serial > mark)).toHaveLength(NODES_PER_SESSION_WITH_LOOT);
		expect(ledger.children).toHaveLength(2 * 31);
		expect(allText(history.container)).toContain('31 sesiones · leídas a las');
	});

	it('drops the row of a session that is gone and rebuilds the one whose figures changed', async () => {
		const sessions = sessionRecords(4, 0);
		const history = await mountedHistory(sessions);
		// Newest first: the row at index 0 is `sessions[3]`.
		const [newest, second, third, oldest] = ids(historyRows(history.container));

		sessions[2] = { ...sessions[2]!, sacks: 99 };
		sessions.shift();
		await history.controller.load();

		const rowsAfter = historyRows(history.container);
		expect(rowsAfter).toHaveLength(3);
		expect(id(rowsAfter[0])).toBe(newest);
		expect(id(rowsAfter[1])).not.toBe(second);
		expect(rowsAfter[1]!.children[3]!.textContent).toBe('99');
		expect(id(rowsAfter[2])).toBe(third);
		expect(ids(walk(history.container))).not.toContain(oldest);
	});

	it('moves "hoy" to "ayer" on the same row when a repaint finds the calendar day has changed', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0));
		const startedAt = new Date(2026, 8, 10, 9, 0, 0).toISOString();
		const history = await mountedHistory([{ ...sessionRecords(1, 0)[0]!, startedAt, endedAt: new Date(2026, 8, 10, 10, 0, 0).toISOString() }]);
		const ended = historyRows(history.container)[0]!.children[0]!;
		expect(ended.textContent).toMatch(/^hoy /u);

		const mark = history.document.created;
		history.mount.update();
		expect(ended.textContent).toMatch(/^hoy /u);

		vi.setSystemTime(new Date(2026, 8, 11, 0, 5, 0));
		history.mount.update();

		expect(id(historyRows(history.container)[0]!.children[0])).toBe(id(ended));
		expect(ended.textContent).toMatch(/^ayer /u);
		expect(history.document.created).toBe(mark);

		// A read that lands on a later day keeps the row and still moves its text.
		vi.setSystemTime(new Date(2026, 8, 12, 0, 5, 0));
		await history.controller.load();
		expect(id(historyRows(history.container)[0]!.children[0])).toBe(id(ended));
		expect(ended.textContent).not.toMatch(/^(hoy|ayer) /u);
	});
});

describe('Durable history: accessibility across a repaint', () => {
	// Once bare and once under the product shell: the shell is what the plugin really mounts, and
	// there the repainted surface is the shell's `<main>`, not the view's own `contentEl`.
	it.each([
		{ name: 'without the product shell', shell: false, nav: [] },
		{ name: 'under the product shell', shell: true, nav: ['button:Sesión', 'button:Inventario', 'button:Venta', 'button:'] },
	])('keeps the focus on "Actualizar historial", and the same roles, scopes and tab order, $name', async ({ shell, nav }) => {
		const actionController = shellController();
		const companion = await idleCompanion(
			sessionRecords(30, LOOT_LINES_PER_SESSION), shell ? { getProductActionController: () => actionController } : {},
		);
		const refresh = walk(historySection(companion.contentEl)).find((node) => node.tag === 'button')!;
		expect(refresh.textContent).toBe('Actualizar historial');
		const accessibility = (): unknown => {
			const section = historySection(companion.contentEl);
			const region = walk(section).find((node) => node.className === 'tyrian-session-history__state')!;
			return {
				label: section.attributes.get('aria-label'),
				region: ['role', 'aria-live', 'aria-atomic', 'aria-busy', 'id'].map((name) => region.attributes.get(name)),
				controls: refresh.attributes.get('aria-controls'),
				scopes: walk(section).filter((node) => node.tag === 'th').map((node) => node.attributes.get('scope')),
				tabOrder: walk(companion.contentEl)
					.filter((node) => node.tag === 'button' || node.tag === 'summary')
					.map((node) => `${node.tag}:${node.textContent}`),
				surfaceOrder: surface(companion.contentEl).children.map((node) => node.className || node.tag),
			};
		};
		const before = accessibility();
		expect(before).toMatchObject({
			region: ['status', 'polite', 'true', 'false', refresh.attributes.get('aria-controls')],
			tabOrder: [...nav, 'button:Iniciar sesión', 'summary:Botín', 'summary:Avisos', 'summary:Detalle', 'button:Actualizar historial'],
		});
		expect(surface(companion.contentEl).tag).toBe(shell ? 'main' : 'div');

		refresh.focus();
		companion.view.render();

		expect(id(companion.document.activeElement)).toBe(id(refresh));
		expect(accessibility()).toEqual(before);
	});
});

describe('Durable history: what leaves with the mount', () => {
	it('takes its section out of the tree and stops listening to the controller on dispose', async () => {
		const history = await mountedHistory(sessionRecords(30, 0));
		const section = historySection(history.container);

		history.mount.dispose();

		expect(history.container.children).toHaveLength(0);
		expect(id(section.parentElement)).toBeNull();
		const mark = history.document.created;
		await history.controller.load('rebuild');
		expect(history.document.created).toBe(mark);
		// The rows were released with the section: nothing the mount still holds can be painted again.
		history.mount.update();
		expect(history.document.created).toBe(mark);
	});

	it('leaves no history section behind when the tab closes or a session starts', async () => {
		const closing = await idleCompanion(sessionRecords(30, 0));
		await closing.view.onClose();
		expect(walk(closing.contentEl).some((node) => node.className === 'tyrian-session-history')).toBe(false);

		let session: SessionState = { version: 1, status: 'idle' };
		const sessions = sessionRecords(30, 0);
		const starting = mountCompanion({
			getSessionState: () => session,
			loadSessionHistory: async () => ({ status: 'ok', sessions, ignored: 0 }),
		});
		await vi.waitFor(() => expect(walk(starting.contentEl).some((node) => node.tag === 'caption')).toBe(true));
		session = ACTIVE_SESSION;
		starting.view.render();
		expect(walk(starting.contentEl).some((node) => node.className === 'tyrian-session-history')).toBe(false);
	});
});

describe('Live loot list: nodes built per paint (audit 3.5)', () => {
	it.each(LOOT_SIZES)('holds 3 nodes per distinct item plus the list itself at %i items', (count) => {
		const companion = activeCompanion(lootRows(count));
		expect(walk(lootList(companion.contentEl))).toHaveLength(1 + (NODES_PER_LOOT_ITEM * count));
		expect(drawerSuffix(companion.contentEl, 'Botín')).toBe(`${String(count)} objetos`);
	});

	it.each(LOOT_SIZES)('builds no loot node when one of %i items gains a unit, and 3 when a new item appears', (count) => {
		const rows = lootRows(count);
		const companion = activeCompanion(rows);
		const list = lootList(companion.contentEl);
		const items = ids(list.children);

		let mark = companion.document.created;
		rows[0] = { ...rows[0]!, quantity: rows[0]!.quantity + 1, totalCopper: 2 * (rows[0]!.totalCopper ?? 0) };
		companion.view.render();

		const afterGain = lootList(companion.contentEl);
		expect(id(afterGain)).toBe(id(list));
		expect(ids(afterGain.children)).toEqual(items);
		expect(walk(afterGain).filter((node) => node.serial > mark)).toHaveLength(0);
		expect(afterGain.children[0]!.children.map((node) => node.textContent)).toEqual(['Objeto 1 ×2', '0g 2s 0c']);
		expect(companion.document.created - mark).toBe(TAB_NODES_AROUND_THE_LOOT);

		mark = companion.document.created;
		rows.push(lootRow(count + 1));
		companion.view.render();

		const afterNewItem = lootList(companion.contentEl);
		expect(ids(afterNewItem.children.slice(0, count))).toEqual(items);
		expect(walk(afterNewItem).filter((node) => node.serial > mark)).toHaveLength(NODES_PER_LOOT_ITEM);
		expect(afterNewItem.children).toHaveLength(count + 1);
		expect(drawerSuffix(companion.contentEl, 'Botín')).toBe(`${String(count + 1)} objetos`);
	});

	it('follows the tracker when an item leaves, the order changes or the price is unknown', () => {
		const rows = lootRows(3);
		const companion = activeCompanion(rows);
		const [first, second, third] = ids(lootList(companion.contentEl).children);

		rows.splice(0, 3, { ...rows[2]!, priceStatus: 'unavailable', totalCopper: null, unitCopper: null }, rows[0]!);
		companion.view.render();

		const list = lootList(companion.contentEl);
		expect(ids(list.children)).toEqual([third, first]);
		expect(ids(walk(companion.contentEl))).not.toContain(second);
		expect(list.children.map((item) => item.children.map((node) => node.textContent))).toEqual([
			['Objeto 3 ×1', 'sin precio'], ['Objeto 1 ×1', '0g 1s 0c'],
		]);
		expect(drawerSuffix(companion.contentEl, 'Botín')).toBe('2 objetos · 1 sin precio');
	});

	it('goes back to "Sin botín" with no list when the tracker empties, and to a fresh list afterwards', () => {
		const rows = lootRows(3);
		const companion = activeCompanion(rows);
		const list = lootList(companion.contentEl);

		rows.splice(0);
		companion.view.render();
		expect(walk(companion.contentEl).some((node) => node.className === 'tyrian-companion-session__list')).toBe(false);
		expect(allText(companion.contentEl)).toContain('Sin botín');

		rows.push(lootRow(7));
		companion.view.render();
		const fresh = lootList(companion.contentEl);
		expect(id(fresh)).not.toBe(id(list));
		expect(fresh.children).toHaveLength(1);
	});

	it('releases the list when the tab closes', async () => {
		const rows = lootRows(3);
		const companion = activeCompanion(rows);
		const list = lootList(companion.contentEl);
		await companion.view.onClose();
		companion.view.render();
		expect(id(lootList(companion.contentEl))).not.toBe(id(list));
	});
});

describe('The rest of the Companion tab: the yardstick for both lists', () => {
	it('builds 66 nodes per repaint around an active session with no loot yet', () => {
		const companion = activeCompanion([]);
		const mark = companion.document.created;
		companion.view.render();
		expect(companion.document.created - mark).toBe(TAB_NODES_AROUND_THE_LOOT + 1);
	});
});

/** What a repaint builds around the Botín body during an active session; "Sin botín" is one more. */
const TAB_NODES_AROUND_THE_LOOT = 65;
const ACTIVE_SESSION = {
	version: 1, status: 'active', sessionId: 'session',
	baseline: { completedAt: '2026-08-31T09:00:00.000Z' }, startContext: { characterName: 'Rinopopo' },
} as unknown as SessionState;

/** Section, title, sample introduction, causal caveat and the missing-build warning. */
const PERFORMANCE_SECTION_NODES = 5;
/** Overflow, table, caption, thead, header row, four headers and tbody. */
const PERFORMANCE_TABLE_NODES = 10;
/**
 * This fixture's exact-quality row: tr, th and quality; four context details and one exclusion;
 * session cell/count/status; gold cell/sample/range; bags cell/sample/insufficient/source.
 * Optional evidence changes this cost per group, never per session in that group.
 */
const PERFORMANCE_GROUP_NODES = 3 + 4 + 1 + 3 + 3 + 4;
/** Ready paragraph/summary/four three-node totals, latest comparison, ledger shell and footer. */
const HISTORY_OUTSIDE_PERFORMANCE_NODES = (2 + 4 * 3) + (4 + 4 * 2) + (6 + 6) + 1;
/** One group remains one group at every size in the ladder, even without a captured build. */
const HISTORY_FIXED_NODES = HISTORY_OUTSIDE_PERFORMANCE_NODES
	+ PERFORMANCE_SECTION_NODES + PERFORMANCE_TABLE_NODES + PERFORMANCE_GROUP_NODES;
/** The `<tr>`, its row header and five cells. */
const NODES_PER_SESSION = 7;
/** Plus the detail `<tr>`, its cell, the label, the list and one `<li>` per gains line. */
const NODES_PER_SESSION_WITH_LOOT = NODES_PER_SESSION + 4 + LOOT_LINES_PER_SESSION;
/** The `<li>`, the name with its quantity, and the value. */
const NODES_PER_LOOT_ITEM = 3;
/** The section, its header line and the state region: built once per mount. */
const HISTORY_SHELL_NODES = 7;

/** The panel alone, reading `sessions` again (the same array, as the caller left it) on every load. */
async function mountedHistory(sessions: DurableSessionHistoryRecord[]): Promise<{
	document: CountingDocument; container: CountingElement; createdBeforeReady: number;
	controller: SessionHistoryPanelController; mount: SessionHistoryPanelMount;
}> {
	const document = new CountingDocument();
	const container = new CountingElement('div', document);
	const controller = new SessionHistoryPanelController(async () => ({ status: 'ok', sessions: [...sessions], ignored: 0 }));
	const mount = mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
	const flight = controller.load();
	// The loading copy is two nodes of its own; the figure pinned above is the ready paint alone.
	const createdBeforeReady = document.created;
	await flight;
	return { document, container, createdBeforeReady, controller, mount };
}

interface MountedCompanion {
	document: CountingDocument;
	contentEl: CountingElement;
	view: TyrianCompanionView;
	loadSessionHistory: ReturnType<typeof vi.fn>;
}

async function idleCompanion(
	sessions: DurableSessionHistoryRecord[], overrides: Partial<CompanionActions> = {},
): Promise<MountedCompanion> {
	const loadSessionHistory = vi.fn(async () => ({ status: 'ok' as const, sessions, ignored: 0 }));
	const companion = mountCompanion({ ...overrides, loadSessionHistory });
	await vi.waitFor(() => expect(walk(companion.contentEl).some((node) => node.tag === 'caption')).toBe(true));
	return { ...companion, loadSessionHistory };
}

function activeCompanion(rows: LiveSessionLootRow[]): MountedCompanion {
	const loadSessionHistory = vi.fn(async () => ({ status: 'ok' as const, sessions: [], ignored: 0 }));
	return {
		...mountCompanion({
			loadSessionHistory,
			getSessionState: () => ACTIVE_SESSION,
			getLiveSessionLoot: (): LiveSessionLootState => ({
				status: 'observing', sessionId: 'session', restored: false, rows,
				knownTotalCopper: rows.reduce((total, row) => total + (row.totalCopper ?? 0), 0), sackQuantity: 0,
				hasUnknownValue: false, updatedAt: '2026-08-31T09:30:00.000Z', error: null,
			}),
		}),
		loadSessionHistory,
	};
}

/** The real view, built by its own constructor and painted through its own `render()`. */
function mountCompanion(overrides: Partial<CompanionActions>): Omit<MountedCompanion, 'loadSessionHistory'> {
	const document = new CountingDocument();
	vi.stubGlobal('createEl', (tag: string, options?: CountingOptions) => new CountingElement(tag, document, options));
	vi.stubGlobal('createDiv', (options?: CountingOptions) => new CountingElement('div', document, options));
	vi.stubGlobal('createSpan', (options?: CountingOptions) => new CountingElement('span', document, options));
	const contentEl = new CountingElement('div', document);
	const ui = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); }, openModal: () => undefined };
	const view = new TyrianCompanionView(
		contentEl as unknown as HTMLElement, ui as never, { ...baseActions(), ...overrides },
	);
	view.render();
	return { document, contentEl, view };
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
		getAssistedDetectionState: (): AssistedDetectionState => ({
			status: 'disarmed', reason: 'initial', lastSnapshotAt: null,
			scheduler: { status: 'idle', intervalMs: null, nextRunAt: null, lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
		}),
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

/** The controller whose presence makes the view mount the product shell around its page. */
function shellController(): ProductActionController {
	return new ProductActionController({
		getLocale: () => 'es', isRuntimeReady: () => true, hasApiKey: () => true,
		getConnectionState: () => ({ status: 'idle' }),
		getPendingProposals: () => ({ status: 'ready', pendingCount: 0, next: null }),
		getDetectionState: () => ({ status: 'disarmed', reason: 'initial', scheduler: {}, lastSnapshotAt: null } as never),
		canArmDetection: () => true, canApplyInventory: () => false, canApplyWallet: () => false,
		isInventoryBusy: () => false,
		sessionCommands: {
			describe: (id) => ({ id, name: id, available: true, icon: 'test', destructive: false, targetKey: 'test' }),
			runWithOutcome: async () => 'completed',
		},
		execute: async () => 'completed' as const,
	});
}

function sessionRecords(count: number, lootLines: number): DurableSessionHistoryRecord[] {
	const first = Date.parse('2026-01-01T10:00:00.000Z');
	return Array.from({ length: count }, (_unused, index) => {
		const startedAt = new Date(first + (index * 3 * 3_600_000)).toISOString();
		return {
			sessionRef: index.toString(16).padStart(64, '0'), accountRef: 'b'.repeat(64), activity: null, build: null, startedAt,
			endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(), durationMs: 3_600_000,
			outcome: 'completed' as const,
			classification: 'exact', confidence: 'high', scope: 'observed_storage_net' as const, valuationCoverage: 'complete',
			observedImmediateCopper: 10_000 + index, observedListingCopper: 12_000 + index, sacks: 10, sacksPerHourMilli: 10_000,
			immediateCopperPerHour: 10_000, listingCopperPerHour: 12_000, recommendationStatus: 'not_evaluated',
			recommendationAction: null, recommendationQuantity: null, recommendationRoute: null,
			lootRows: Array.from({ length: lootLines }, (_line, line) => ({
				name: `Objeto ${String(line + 1)}`, netQuantity: line + 1, immediateLabel: '1 g 00 s 00 c',
			})),
		};
	});
}

function lootRows(count: number): LiveSessionLootRow[] {
	return Array.from({ length: count }, (_unused, index) => lootRow(index + 1));
}

function lootRow(itemId: number): LiveSessionLootRow {
	return { itemId, name: `Objeto ${String(itemId)}`, quantity: 1, unitCopper: 100, totalCopper: 100, priceStatus: 'known' };
}

function historySection(root: CountingElement): CountingElement {
	return walk(root).find((node) => node.className === 'tyrian-session-history')!;
}

/** The `<tr>` of each session, without the detail row that carries its gains lines. */
function historyRows(root: CountingElement): CountingElement[] {
	const ledger = walk(root).filter((node) => node.tag === 'tbody').at(-1)!;
	return ledger.children.filter((row) => row.className === '');
}

function lootList(root: CountingElement): CountingElement {
	return walk(root).find((node) => node.className === 'tyrian-companion-session__list')!;
}

/** The page the view repaints: `contentEl` itself here, since no product shell is wired. */
function surface(root: CountingElement): CountingElement {
	return historySection(root).parentElement!;
}

/** The closed-state text a gaveto shows next to its name. */
function drawerSuffix(root: CountingElement, name: string): string {
	return walk(root).find((node) => node.tag === 'summary' && node.textContent === name)!.children[0]!.textContent;
}

/**
 * Identity by the order of creation. Two elements are never handed to `toBe` or `toEqual`
 * themselves: on a mismatch the reporter would print two trees of tens of thousands of nodes.
 */
function id(node: CountingElement | null | undefined): number | null {
	return node?.serial ?? null;
}

function ids(nodes: readonly CountingElement[]): number[] {
	return nodes.map((node) => node.serial);
}

function allText(root: CountingElement): string {
	return walk(root).map((node) => node.textContent).join(' | ');
}

function walk(root: CountingElement): CountingElement[] {
	return [root, ...root.children.flatMap(walk)];
}

interface CountingOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string>; readonly type?: string }

class CountingDocument {
	/** How many elements were ever built against this document; each one keeps its own ordinal. */
	created = 0;
	activeElement: CountingElement | null = null;
	hidden = false;
	readonly listeners = new Map<string, Set<() => void>>();
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
	}
	removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
}

/**
 * The fake DOM of this suite. Unlike the other view suites' doubles it keeps a parent pointer and
 * drops focus the way a browser does: an element that leaves the tree, even to be put back a line
 * later, is no longer `activeElement`.
 */
class CountingElement {
	readonly children: CountingElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	readonly serial: number;
	readonly win = { setInterval: (): number => 1, clearInterval: (): void => undefined };
	parentElement: CountingElement | null = null;
	className = '';
	textContent = '';
	type = '';
	disabled = false;
	hidden = false;
	open = false;

	constructor(readonly tag: string, readonly ownerDocument: CountingDocument, options: CountingOptions = {}) {
		this.serial = (ownerDocument.created += 1);
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
		this.type = options.type ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	get doc(): CountingDocument { return this.ownerDocument; }

	createEl(tag: string, options?: CountingOptions): CountingElement { return this.build(tag, options); }
	createDiv(options?: CountingOptions): CountingElement { return this.build('div', options); }
	createSpan(options?: CountingOptions): CountingElement { return this.build('span', options); }
	private build(tag: string, options?: CountingOptions): CountingElement {
		return this.insertBefore(new CountingElement(tag, this.ownerDocument, options), null);
	}
	empty(): void {
		for (const child of [...this.children]) this.removeChild(child);
		this.textContent = '';
	}
	append(...nodes: CountingElement[]): void { for (const node of nodes) this.insertBefore(node, null); }
	prepend(...nodes: CountingElement[]): void {
		const first = this.children[0] ?? null;
		for (const node of nodes) this.insertBefore(node, first);
	}
	insertBefore(node: CountingElement, reference: CountingElement | null): CountingElement {
		node.parentElement?.removeChild(node);
		const index = reference === null ? this.children.length : this.children.indexOf(reference);
		this.children.splice(index, 0, node);
		node.parentElement = this;
		return node;
	}
	removeChild(node: CountingElement): CountingElement {
		const index = this.children.indexOf(node);
		if (index === -1) throw new Error('removeChild: not a child of this element');
		this.children.splice(index, 1);
		node.parentElement = null;
		if (node.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
		return node;
	}
	remove(): void { this.parentElement?.removeChild(this); }
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
	contains(target: CountingElement | null): boolean {
		return target === this || this.children.some((child) => child.contains(target));
	}
}
