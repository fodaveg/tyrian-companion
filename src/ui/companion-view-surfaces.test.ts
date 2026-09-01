import { describe, expect, it, vi } from 'vitest';

import { TyrianCompanionView, type CompanionActions } from './companion-view';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenPriceNoticeV1 } from '../halloween/halloween-price-alert';
import type { PendingProposal } from '../sessions/pending-proposal-model';
import type { SessionRecoveryState } from '../sessions/manual-session-start-service';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
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

		expect(texts(contentEl)).toContain('Detección del saco #36038');
		const timeline = find(contentEl, (node) => node.className.includes('tyrian-companion-view__detection-timeline'));
		expect(timeline?.attributes.get('aria-label')).toContain('Última consulta, resultado y próxima consulta');
		expect(termsAndDetails(contentEl)).toEqual(expect.arrayContaining([
			['Última consulta'], ['Resultado'], ['Próxima consulta'],
		]));
		expect(texts(contentEl)).toContain('Límites registrados');
		expect(texts(contentEl)).toContain('Propuestas corregidas');
		const lag = texts(contentEl).find((text) => text.includes('minutos de retraso'));
		expect(lag).toBeDefined();
		// The queried clock stops at the minute; a seconds field would promise precision the API lacks.
		const queried = definitionValue(contentEl, 'Última consulta');
		expect(queried).toBeDefined();
		expect(queried).not.toMatch(/\d{1,2}:\d{2}:\d{2}/u);
	});

	it('arms the detection from the mounted disarmed card', async () => {
		const armAssistedDetection = vi.fn(async () => 'completed' as const);
		const { contentEl, render } = mountCompanion({
			armAssistedDetection,
			getAssistedDetectionState: () => ({ status: 'disarmed', reason: 'initial', scheduler: idleScheduler(), lastSnapshotAt: null }),
		});

		render();

		const arm = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Activar detección');
		expect(arm).toBeDefined();
		expect(arm?.disabled).toBe(false);

		arm?.click();
		await Promise.resolve();
		expect(armAssistedDetection).toHaveBeenCalledOnce();
	});
});

describe('Companion durable history surface', () => {
	it('mounts the panel idle and only reads the Vault when its action is pressed', async () => {
		const loadSessionHistory = vi.fn(async (): Promise<SessionHistoryLoadResult> => ({ status: 'ok', sessions: [], ignored: 0 }));
		const { contentEl, render } = mountCompanion({ loadSessionHistory });

		render();

		const panel = find(contentEl, (node) => node.className.includes('tyrian-session-history'));
		expect(panel).toBeDefined();
		expect(loadSessionHistory).not.toHaveBeenCalled();
		const load = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Cargar historial');
		expect(load?.attributes.get('aria-controls')).toBeDefined();

		load?.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(loadSessionHistory).toHaveBeenCalledOnce();
		expect(texts(contentEl)).toContain('No hay sesiones finalizadas');
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

		expect(texts(contentEl)).toContain('Esperando a que la API confirme los últimos minutos');
		expect(texts(contentEl)).toContain('Captura final en 07:00');
		const why = texts(contentEl).find((text) => text.includes('varios minutos de retraso'));
		expect(why).toBeDefined();
		expect(texts(contentEl)).toContain('El resultado puede no incluir los últimos minutos y la sesión quedará marcada como estimada.');

		const captureNow = find(contentEl, (node) => node.tag === 'button' && node.textContent === 'Capturar ya');
		expect(captureNow).toBeDefined();
		captureNow?.click();
		await Promise.resolve();
		expect(captureSessionFinalNow).toHaveBeenCalledOnce();
	});

	it('shows the ordinary reconciling copy when no window is pending', () => {
		const { contentEl, render } = mountCompanion({
			captureSessionFinalNow: vi.fn(async () => undefined),
			getSessionState: () => stoppingSession(),
			getSessionSettlementWait: () => null,
		});

		render();

		expect(texts(contentEl)).not.toContain('Esperando a que la API confirme los últimos minutos');
		expect(find(contentEl, (node) => node.textContent === 'Capturar ya')).toBeUndefined();
	});
});

describe('Companion incident line', () => {
	it('carries the first projected incident into the card and counts the rest', () => {
		const { contentEl, render } = mountCompanion({
			getSessionState: () => stoppingSession(),
			getSessionStopFailure: () => ({ code: 'rate_limited', message: 'rate limited' }),
			getConnectionState: () => ({ status: 'error', code: 'unavailable', message: 'offline', retryAt: null }),
		});

		render();

		const incident = incidentLine(contentEl);
		expect(incident?.hidden).toBe(false);
		expect(incident?.attributes.get('role')).toBe('alert');
		expect(incident?.children[0]?.textContent).toContain('Final: ');
		expect(incident?.children[1]?.textContent).toBe('+1 más');
		expect(incident?.children[1]?.hidden).toBe(false);
	});

	it('keeps the line mounted and silent while nothing needs attention', () => {
		const { contentEl, render } = mountCompanion();

		render();

		const incident = incidentLine(contentEl);
		expect(incident).toBeDefined();
		expect(incident?.hidden).toBe(true);
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

		expect(texts(contentEl)).toContain('Calidad: Limitada · Comparación de almacenamiento · Limitado');
	});

	it('claims nothing while the session is still running', () => {
		const { contentEl, render } = mountCompanion({ getSessionState: () => activeSession() });

		render();

		expect(texts(contentEl).some((text) => text.startsWith('Calidad: '))).toBe(false);
	});
});

describe('Companion saved-session decision', () => {
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

	it('omits the check while the account is answering', () => {
		const { contentEl, render } = mountCompanion();

		render();

		expect(find(contentEl, (node) => node.textContent === 'Comprobar conexión')).toBeUndefined();
	});
});

/** The card's single alert line, found by its role rather than by its position. */
function incidentLine(root: FakeElement): FakeElement | undefined {
	return find(root, (node) => node.tag === 'p'
		&& node.className.includes('tyrian-companion-session__warning')
		&& node.attributes.get('role') === 'alert');
}

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
	const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
		actions, contentEl, refreshInterval: null,
		headerElapsed: null, settlementCountdown: null, checkButton: null,
		incident: null, incidentMessage: null, incidentMore: null,
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
