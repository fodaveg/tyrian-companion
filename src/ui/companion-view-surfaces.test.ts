import { describe, expect, it, vi } from 'vitest';

import { TyrianCompanionView, type CompanionActions } from './companion-view';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenPriceNoticeV1 } from '../halloween/halloween-price-alert';
import type { SessionState } from '../sessions/session';

/**
 * Behavioural coverage for the surfaces the Companion view mounts. Every case renders the real
 * view against a fake DOM and then presses the produced control, because a source-text assertion
 * stays green while the panel is unreachable.
 */

describe('Companion Halloween alert surface', () => {
	it('renders the unread notice and acknowledges it from the mounted panel', async () => {
		const acknowledgeHalloweenNotice = vi.fn(async () => true);
		const { contentEl, render } = mountCompanion({ acknowledgeHalloweenNotice, getHalloweenState: () => unreadHalloweenState() });

		render();

		const panel = find(contentEl, (node) => node.className.includes('tyrian-companion-halloween'));
		expect(panel?.attributes.get('aria-label')).toBe('Bandeja de alertas de Halloween');
		expect(panel?.attributes.get('data-attention')).toBe('true');
		expect(texts(contentEl)).toContain('Alertas de Halloween');
		const acknowledge = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Marcar como revisada');
		expect(acknowledge).toBeDefined();

		acknowledge?.click();
		await Promise.resolve();
		expect(acknowledgeHalloweenNotice).toHaveBeenCalledWith('notice');
	});

	it('acknowledges an unread price notice from the same panel', async () => {
		const acknowledgeHalloweenPriceNotice = vi.fn(async () => true);
		const { contentEl, render } = mountCompanion({
			acknowledgeHalloweenPriceNotice,
			getHalloweenPriceAlertState: () => ({ status: 'unread', projection: null, notices: [priceNotice()], unreadCount: 1 }),
		});

		render();

		const price = find(contentEl, (node) => node.className.includes('tyrian-companion-halloween__price'));
		expect(price).toBeDefined();
		const acknowledge = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Marcar como revisada');
		acknowledge?.click();
		await Promise.resolve();
		expect(acknowledgeHalloweenPriceNotice).toHaveBeenCalledWith('price-notice');
	});
});

function mountCompanion(overrides: Partial<CompanionActions> = {}): {
	contentEl: FakeElement;
	actions: CompanionActions;
	render: () => void;
} {
	const document = new FakeDocument();
	const contentEl = new FakeElement('div', document);
	const actions: CompanionActions = { ...baseActions(), ...overrides };
	const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
		actions, contentEl, refreshInterval: null,
		dynamicStatusNodes: new Map(), headerPhase: null, headerElapsed: null, checkButton: null,
		cooldownNodes: [], incident: null, incidentMessage: null, incidentMore: null, ledger: null,
		detectionTimelineNodes: null, pendingConfirmationContainer: null, pendingConfirmationFocusTarget: null,
		pendingConfirmationKey: null, primaryActionContainer: null, primaryActionButton: null, primaryActionKey: null,
		productShell: null, productShellKey: null, sessionHistoryController: null, sessionHistoryMount: null,
		projectStatus: () => ({ items: [], errors: [], surfaceTone: 'neutral', refreshEveryMs: null, primaryAction: null }),
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
		getDetectionMode: () => 'assisted',
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
		reviewSessionContamination: async () => null,
		openSessionReview: () => undefined,
		confirmClearCompletedSession: () => undefined,
		getSessionRecoveryState: () => ({ status: 'none' }),
		openManualSessionStart: () => undefined,
		stopManualSession: async () => undefined,
		recoverSession: async () => undefined,
		confirmDiscardRecoveredSession: () => undefined,
		loadSessionHistory: async () => ({ status: 'ok', sessions: [], ignored: 0 }),
		hasConfiguredApiKey: () => true,
		getHalloweenState: () => ({ status: 'ready', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null }),
		acknowledgeHalloweenNotice: async () => false,
		getHalloweenPriceAlertState: () => ({ status: 'ready', projection: null, notices: [], unreadCount: 0 }),
		acknowledgeHalloweenPriceNotice: async () => false,
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

function unreadHalloweenState() {
	const notice: HalloweenNoticeV1 = {
		version: 1, vaultId: 'vault', accountRef: 'account', noticeId: 'notice', episodeId: 'episode',
		observedAt: '2026-08-31T12:00:00.000Z', source: 'assisted_poll', wording: 'observed_change',
		coverage: 'complete', acknowledgedAt: null,
		items: [{ itemId: 36_038, quantity: 4, name: 'Saco de truco o trato', reasons: [{ code: 'first_seen' }] }],
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

interface FakeOptions {
	readonly text?: string;
	readonly cls?: string;
	readonly type?: string;
	readonly value?: string;
	readonly attr?: Record<string, string>;
}

class FakeDocument { activeElement: FakeElement | null = null }

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	readonly win = {
		setInterval: (callback: () => void, _delay: number) => { this.scheduledInterval = callback; return 1; },
		clearInterval: (_handle: number) => { this.scheduledInterval = null; },
	};
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

	empty(): void { this.children.splice(0); this.textContent = ''; }
	createEl(tag: string, options?: FakeOptions): FakeElement { return this.appendChild(tag, options); }
	private appendChild(tag: string, options?: FakeOptions): FakeElement {
		const child = new FakeElement(tag, this.ownerDocument, options); this.children.push(child); return child;
	}
	createDiv(options?: FakeOptions): FakeElement { return this.appendChild('div', options); }
	createSpan(options?: FakeOptions): FakeElement { return this.appendChild('span', options); }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
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
