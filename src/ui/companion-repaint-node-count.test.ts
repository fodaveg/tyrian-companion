import { afterEach, describe, expect, it, vi } from 'vitest';

import { TyrianCompanionView, type CompanionActions } from './companion-view';
import { mountSessionHistoryPanel, SessionHistoryPanelController } from './session-history-panel';
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

		const withLoot = await mountedHistory(sessionRecords(count, LOOT_LINES_PER_SESSION));
		expect(withLoot.document.created - withLoot.createdBeforeReady)
			.toBe(HISTORY_FIXED_NODES + (NODES_PER_SESSION_WITH_LOOT * count));
	});

	it.each(HISTORY_SIZES)('builds the whole panel again on a repaint of the Companion tab with %i unchanged sessions', async (count) => {
		const companion = await idleCompanion(sessionRecords(count, LOOT_LINES_PER_SESSION));
		const section = historySection(companion.contentEl);
		const nodesInPanel = walk(section).length;
		expect(nodesInPanel).toBe(HISTORY_SHELL_NODES + HISTORY_FIXED_NODES + (NODES_PER_SESSION_WITH_LOOT * count));

		const mark = companion.document.created;
		companion.view.render();

		const repainted = historySection(companion.contentEl);
		expect(repainted).not.toBe(section);
		expect(walk(repainted).filter((node) => node.serial > mark)).toHaveLength(nodesInPanel);
		expect(companion.loadSessionHistory).toHaveBeenCalledOnce();
	});
});

describe('Live loot list: nodes built per paint (audit 3.5)', () => {
	it.each(LOOT_SIZES)('holds 3 nodes per distinct item plus the list itself at %i items', (count) => {
		const companion = activeCompanion(lootRows(count));
		expect(walk(lootList(companion.contentEl))).toHaveLength(1 + (NODES_PER_LOOT_ITEM * count));
	});

	it.each(LOOT_SIZES)('builds the whole list again when one of %i items gains a unit', (count) => {
		const rows = lootRows(count);
		const companion = activeCompanion(rows);
		const list = lootList(companion.contentEl);

		const mark = companion.document.created;
		rows[0] = { ...rows[0]!, quantity: rows[0]!.quantity + 1, totalCopper: 2 * (rows[0]!.totalCopper ?? 0) };
		companion.view.render();

		const afterGain = lootList(companion.contentEl);
		expect(afterGain).not.toBe(list);
		expect(walk(afterGain).filter((node) => node.serial > mark)).toHaveLength(1 + (NODES_PER_LOOT_ITEM * count));
		expect(afterGain.children[0]!.children[0]!.textContent).toBe('Objeto 1 ×2');
	});
});

describe('The rest of the Companion tab: the yardstick for both lists', () => {
	it('builds 66 nodes per repaint around an active session with no loot yet', () => {
		const companion = activeCompanion([]);
		const mark = companion.document.created;
		companion.view.render();
		expect(companion.document.created - mark).toBe(66);
	});
});

/** Everything the ready state builds that does not grow with the session count. */
const HISTORY_FIXED_NODES = 44;
/** The `<tr>`, its row header and five cells. */
const NODES_PER_SESSION = 7;
/** Plus the detail `<tr>`, its cell, the label, the list and one `<li>` per gains line. */
const NODES_PER_SESSION_WITH_LOOT = NODES_PER_SESSION + 4 + LOOT_LINES_PER_SESSION;
/** The `<li>`, the name with its quantity, and the value. */
const NODES_PER_LOOT_ITEM = 3;
/** The section, its header line and the state region: built once per mount. */
const HISTORY_SHELL_NODES = 7;

async function mountedHistory(sessions: DurableSessionHistoryRecord[]): Promise<{
	document: CountingDocument; container: CountingElement; createdBeforeReady: number;
}> {
	const document = new CountingDocument();
	const container = new CountingElement('div', document);
	const controller = new SessionHistoryPanelController(async () => ({ status: 'ok', sessions, ignored: 0 }));
	mountSessionHistoryPanel(container as unknown as HTMLElement, 'es', controller);
	const flight = controller.load();
	// The loading copy is two nodes of its own; the figure pinned above is the ready paint alone.
	const createdBeforeReady = document.created;
	await flight;
	return { document, container, createdBeforeReady };
}

interface MountedCompanion {
	document: CountingDocument;
	contentEl: CountingElement;
	view: TyrianCompanionView;
	loadSessionHistory: ReturnType<typeof vi.fn>;
}

async function idleCompanion(sessions: DurableSessionHistoryRecord[]): Promise<MountedCompanion> {
	const loadSessionHistory = vi.fn(async () => ({ status: 'ok' as const, sessions, ignored: 0 }));
	const companion = mountCompanion({ loadSessionHistory });
	await vi.waitFor(() => expect(walk(companion.contentEl).some((node) => node.tag === 'caption')).toBe(true));
	return { ...companion, loadSessionHistory };
}

function activeCompanion(rows: LiveSessionLootRow[]): MountedCompanion {
	const loadSessionHistory = vi.fn(async () => ({ status: 'ok' as const, sessions: [], ignored: 0 }));
	return {
		...mountCompanion({
			loadSessionHistory,
			getSessionState: () => ({
				version: 1, status: 'active', sessionId: 'session',
				baseline: { completedAt: '2026-08-31T09:00:00.000Z' }, startContext: { characterName: 'Rinopopo' },
			}) as unknown as SessionState,
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
