import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./halloween-alert-panel', () => ({ renderHalloweenAlertPanel: vi.fn() }));

import { TyrianCompanionView } from './companion-view';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import { ProductActionController } from './product-action-controller';
import { SessionHistoryPanelController } from './session-history-panel';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('Companion local diagnostics warning', () => {
	it('renders a live degraded warning with a navigable Settings action', () => {
		const opened = vi.fn();
		const texts: string[] = [];
		let role = '';
		let click: (() => void) | null = null;
		const status: LocalDebugStatus = {
			enabled: true, minimumLevel: 'debug', state: 'degraded', path: 'test-config-dir/plugins/tyrian-companion/logs/',
			bytes: 0, fileCount: 0, lastEventAt: null, droppedRecords: 1,
			errorCode: 'logger_failure', queuedRecords: 0, recoveredTails: 0,
		};
		const warning = {
			setAttr: (name: string, value: string) => { if (name === 'role') role = value; },
			createEl: (_tag: string, options: { text: string }) => {
				texts.push(options.text);
				return { addEventListener: (_name: string, listener: () => void) => { click = listener; } };
			},
		};
		const container = { createDiv: () => warning };
		const harness = {
			actions: {
				getLocalDebugStatus: () => status,
				getLocale: () => 'en' as const,
				openLocalDebugSettings: opened,
			},
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderLocalDebugWarning(this: typeof harness, container: { createDiv(): typeof warning }): void;
		}).renderLocalDebugWarning;

		render.call(harness, container);
		expect(role).toBe('alert');
		expect(texts).toEqual([
			'Diagnostic logs are degraded',
			'Some entries could not be written. Plugin actions continue to work.',
			'Diagnostic logs',
		]);
		if (click === null) throw new Error('Expected a Settings action.');
		(click as () => void)();
		expect(opened).toHaveBeenCalledOnce();
	});

	it('renders nothing while the writer is healthy', () => {
		const createDiv = vi.fn();
		const harness = { actions: { getLocalDebugStatus: () => ({ state: 'ready' }) } };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderLocalDebugWarning(this: typeof harness, container: { createDiv(): unknown }): void;
		}).renderLocalDebugWarning;
		render.call(harness, { createDiv });
		expect(createDiv).not.toHaveBeenCalled();
	});
});

describe('Companion game HUD narrative', () => {
	it('renders the exact bag scope and last query to result to next query sequence', () => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const attemptedAt = Date.parse('2026-08-31T10:00:00.000Z');
		let state: AssistedDetectionState = {
			status: 'armed', armedAt: '2026-08-31T09:00:00.000Z', lastSnapshotAt: '2026-08-31T10:00:00.000Z',
			scheduler: {
				status: 'scheduled', intervalMs: 120_000, nextRunAt: attemptedAt + 120_000,
				lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, consecutiveFailures: 0,
			},
		};
		const session = { version: 1 as const, status: 'idle' as const };
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getDetectionMode: () => 'assisted' as const,
				getAssistedDetectionState: () => state,
				getSessionState: () => session,
			},
			detectionTimelineNodes: null,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderDetectionTimeline(
				this: typeof harness, container: HTMLElement, mode: 'assisted', state: AssistedDetectionState, session: unknown,
			): void;
		}).renderDetectionTimeline;
		render.call(harness, container as unknown as HTMLElement, 'assisted', state, session);

		const cells = container.children[0]?.children ?? [];
		expect(container.children[0]?.tag).toBe('dl');
		expect(cells.every((cell) => cell.children[0]?.tag === 'dt' && cell.children[1]?.tag === 'dd')).toBe(true);
		expect(cells.map((cell) => cell.children[0]?.textContent)).toEqual(['Última consulta', 'Resultado', 'Próxima consulta']);
		expect(cells[1]?.children[1]?.textContent).toContain('saco #36038');
		const initialLast = cells[0]?.children[1]?.textContent;
		const initialNext = cells[2]?.children[1]?.textContent;

		state = {
			...state,
			scheduler: {
				...state.scheduler, status: 'backoff', lastAttemptAt: attemptedAt + 60_000,
				lastSuccessAt: attemptedAt, nextRunAt: attemptedAt + 180_000, consecutiveFailures: 1,
			},
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const refresh = (TyrianCompanionView.prototype as unknown as {
			refreshDetectionTimeline(this: typeof harness): void;
		}).refreshDetectionTimeline;
		refresh.call(harness);
		expect(cells[0]?.children[1]?.textContent).not.toBe(initialLast);
		expect(cells[1]?.children[1]?.textContent).toContain('falló');
		expect(cells[2]?.children[1]?.textContent).not.toBe(initialNext);

		const translator = createTranslator('es');
		expect(translateRuntime(translator, 'view.assistedDetection')).toBe('Detección del saco #36038');
		expect(translateRuntime(translator, 'view.detectionScope')).toContain('No detecta farmeo general');
	});

	it('promotes exactly one pending confirmation over the ordinary session action', () => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const next = { phase: 'start' as const, proposalId: 'proposal', staleAt: '2099-01-01T00:00:00.000Z' };
		const reviewPending = vi.fn();
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getPendingProposalState: () => ({ status: 'ready' as const, pendingCount: 1, next }),
			},
			reviewPending,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderPrimaryAction(this: typeof harness, container: HTMLElement, projection: unknown, connection: unknown): void;
		}).renderPrimaryAction;
		render.call(harness, container as unknown as HTMLElement, { primaryAction: 'start' }, { status: 'connected' });
		expect(container.children).toHaveLength(1);
		expect(container.children[0]?.className).toContain('mod-cta');
		expect(container.children[0]?.textContent).toBe('Revisar e iniciar');
		container.children[0]?.listeners.get('click')?.[0]?.();
		expect(reviewPending).toHaveBeenCalledWith(next);
	});

	it('does not promote an expired pending confirmation', () => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const next = { phase: 'start' as const, proposalId: 'stale', staleAt: '2000-01-01T00:00:00.000Z' };
		const reviewPending = vi.fn();
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getPendingProposalState: () => ({ status: 'ready' as const, pendingCount: 1, next }),
				getAssistedDetectionState: () => ({ status: 'armed' }),
				getSessionState: () => ({ version: 1 as const, status: 'idle' as const }),
			},
			reviewPending,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderPrimaryAction(this: typeof harness, container: HTMLElement, projection: unknown, connection: unknown): void;
		}).renderPrimaryAction;
		render.call(harness, container as unknown as HTMLElement, { primaryAction: 'start' }, { status: 'connected' });
		expect(container.children[0]?.textContent).toBe('Iniciar sesión');
		expect(reviewPending).not.toHaveBeenCalled();
	});

	it('reprojects the retained primary action when assisted detection proposes a start', () => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		let detectionStatus: 'armed' | 'start_proposed' = 'armed';
		const actions = {
			getLocale: () => 'es' as const,
			getPendingProposalState: () => ({ status: 'ready' as const, pendingCount: 0, next: null }),
			getAssistedDetectionState: () => ({ status: detectionStatus }),
			getSessionState: () => ({ version: 1 as const, status: 'idle' as const }),
			openManualSessionStart: vi.fn(),
		};
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions, primaryActionContainer: container, primaryActionKey: null,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderPrimaryAction(this: typeof harness, container: HTMLElement, projection: unknown, connection: unknown): string | null;
		}).renderPrimaryAction;
		(harness as { primaryActionKey: string | null }).primaryActionKey = render.call(
			harness, container as unknown as HTMLElement, { primaryAction: 'start' }, { status: 'connected' },
		);
		expect(container.children[0]?.textContent).toBe('Iniciar sesión');

		detectionStatus = 'start_proposed';
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const refresh = (TyrianCompanionView.prototype as unknown as {
			refreshPrimaryAction(this: typeof harness, projection: unknown, connection: unknown): void;
		}).refreshPrimaryAction;
		refresh.call(harness, { primaryAction: 'start' }, { status: 'connected' });
		expect(container.children).toHaveLength(1);
		expect(container.children[0]?.textContent).toBe('Revisar e iniciar');
	});

	it.each(['start_proposed', 'disarmed'] as const)(
		'arms the sole HUD timer for a new pending proposal and expires it in place while detection is %s',
		(detectionStatus) => {
			vi.useFakeTimers();
			const now = Date.parse('2026-08-31T10:00:00.000Z');
			vi.setSystemTime(now);
			const document = new RetainedFakeDocument();
			const contentEl = new RetainedFakeElement('div', document);
			const primary = new RetainedFakeElement('div', document);
			const pending = new RetainedFakeElement('div', document);
			const next = {
				version: 1, phase: 'start' as const, proposalId: 'expiring', accountId: 'account',
				binding: { kind: 'idle' as const, ruleSetId: 'rules', ruleSetVersion: 1 },
				proposal: { evidenceQuality: 'complete' as const }, detectedAt: '2026-08-31T09:59:00.000Z',
				staleAt: new Date(now + 1_000).toISOString(),
			};
			const reviewPendingProposal = vi.fn(async () => true);
			const openManualSessionStart = vi.fn();
			let currentNext: typeof next | null = null;
			const actions = {
				getLocale: () => 'es' as const,
				getPendingProposalState: () => ({
					status: 'ready' as const, pendingCount: currentNext === null ? 0 : 1, next: currentNext,
				}),
				getAssistedDetectionState: () => ({ status: detectionStatus }),
				getSessionState: () => ({ version: 1 as const, status: 'idle' as const }),
				getConnectionState: () => ({ status: 'connected' as const, accountId: 'account', accountName: 'Account' }),
				reviewPendingProposal,
				openPendingSessionStart: vi.fn(),
				stopPendingSession: vi.fn(async () => undefined),
				dismissPendingProposal: vi.fn(async () => undefined),
				openManualSessionStart,
			};
			const projection = {
				primaryAction: 'start', refreshEveryMs: null, items: [], errors: [], surfaceTone: 'neutral',
			};
			const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
				actions, contentEl, refreshInterval: null,
				dynamicStatusNodes: new Map(), headerPhase: null, headerElapsed: null, checkButton: null,
				cooldownNodes: [], incident: null, incidentMessage: null, incidentMore: null, ledger: null,
				detectionTimelineNodes: null, pendingConfirmationContainer: pending, pendingConfirmationKey: null,
				primaryActionContainer: primary, primaryActionButton: null, primaryActionKey: null,
				projectStatus: () => projection,
				t: (key: string) => key,
				formatTimestamp: (value: string) => value,
			});
			const methods = TyrianCompanionView.prototype as unknown as {
				renderPrimaryAction(this: typeof harness, container: HTMLElement, projection: unknown, connection: unknown, at: number): string | null;
				renderPendingConfirmation(this: typeof harness, container: HTMLElement, at: number): void;
				projectPendingConfirmationKey(this: typeof harness, at: number): string;
				scheduleRefresh(this: typeof harness, projection: unknown, retryAt: number | null, at: number): void;
				refreshBackgroundStatus(this: typeof harness): void;
			};
			(harness as { primaryActionKey: string | null }).primaryActionKey = methods.renderPrimaryAction.call(
				harness, primary as unknown as HTMLElement, projection, actions.getConnectionState(), now,
			);
			methods.renderPendingConfirmation.call(harness, pending as unknown as HTMLElement, now);
			(harness as { pendingConfirmationKey: string | null }).pendingConfirmationKey =
				methods.projectPendingConfirmationKey.call(harness, now);
			methods.scheduleRefresh.call(harness, projection, null, now);
			expect(contentEl.scheduledInterval).toBeNull();

			currentNext = next;
			methods.refreshBackgroundStatus.call(harness);
			const pendingCta = primary.children[0]!;
			const pendingButtons = walkRetained(pending).filter((element) => element.tag === 'button');
			expect(pendingButtons).toHaveLength(2);
			expect(contentEl.intervalSetCount).toBe(1);
			const tick = contentEl.scheduledInterval;
			expect(tick).not.toBeNull();
			pendingButtons[0]?.focus();

			vi.advanceTimersByTime(1_000);
			tick?.();

			const currentCta = primary.children[0]!;
			expect(currentCta).not.toBe(pendingCta);
			currentCta.listeners.get('click')?.[0]?.();
			if (detectionStatus === 'start_proposed') expect(openManualSessionStart).toHaveBeenCalledWith(null);
			else expect(openManualSessionStart).toHaveBeenCalledWith();
			expect(reviewPendingProposal).not.toHaveBeenCalled();
			expect(walkRetained(pending).filter((element) => element.tag === 'button')).toHaveLength(0);
			expect(walkRetained(pending).some((element) => element.textContent === 'view.stale')).toBe(true);
			expect(document.activeElement).toBe(currentCta);
			expect(contentEl.scheduledInterval).toBeNull();
			expect(contentEl.intervalSetCount).toBe(1);
		},
	);
});

describe('Companion pilot metrics fail-open actions', () => {
	it.each([
		['start_proposed', 'idle', 'reviewStart'],
		['stop_proposed', 'active', 'stopSession'],
	] as const)('runs %s immediately with a nullable boundary when the pilot hook fails', (status, sessionStatus, label) => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const openStart = vi.fn();
		const stop = vi.fn(async () => undefined);
		const actions = {
			getDetectionMode: () => 'assisted' as const,
			getAssistedDetectionState: () => ({
				status,
				proposal: {
					possibleStart: pilotWindow(), possibleStop: pilotWindow(), evidenceQuality: 'complete',
				},
			}) as never,
			getLocale: () => 'en' as const,
			recordAssistedProposalPresented: () => { throw new Error('pilot unavailable'); },
			openManualSessionStart: openStart,
			stopManualSession: stop,
		};
		const harness = {
			actions,
			t: (key: string) => key,
			renderDetectionQualityStatus: vi.fn(),
			renderDetectionTimeline: vi.fn(),
			renderProposalDetails: vi.fn(),
			addDismissAndDisarm: vi.fn(),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated fail-open harness.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderAssistedDetection(this: typeof harness, container: HTMLElement, connection: unknown, session: unknown): void;
		}).renderAssistedDetection;
		expect(() => render.call(harness, container as unknown as HTMLElement, {}, { status: sessionStatus })).not.toThrow();
		const button = walkRetained(container).find((element) => element.textContent === `view.${label}`);
		expect(button).toBeDefined();
		button?.listeners.get('click')?.[0]?.();
		if (status === 'start_proposed') expect(openStart).toHaveBeenCalledWith(null);
		else expect(stop).toHaveBeenCalledWith(null);
	});

	it.each(['missing', 'throwing'] as const)(
		'accepts a reviewed pending proposal without a cancellable pilot modal when the hook is %s',
		async (hookState) => {
			const document = new RetainedFakeDocument();
			const container = new RetainedFakeElement('div', document);
			const open = vi.fn();
			const actions = {
				getPendingProposalState: () => ({
					status: 'ready', pendingCount: 1,
					next: {
						version: 1, phase: 'start', proposalId: 'proposal', accountId: 'account',
						binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 },
						proposal: { evidenceQuality: 'complete' }, detectedAt: '2026-08-20T10:00:00.000Z',
						staleAt: '2099-08-21T10:00:00.000Z',
					},
				}) as never,
				reviewPendingProposal: vi.fn(async (_intent: unknown) => true),
				openPendingSessionStart: open,
				stopPendingSession: vi.fn(async () => undefined),
				...(hookState === 'throwing' ? {
					recordPendingProposalPresented: () => { throw new Error('pilot unavailable'); },
				} : {}),
			};
			const harness = {
				actions,
				t: (key: string) => key,
				formatTimestamp: (value: string) => value,
				reviewPending: (next: { phase: 'start'; proposalId: string; accountId: string; binding: { kind: 'idle' } }) => {
					const intent = { proposalId: next.proposalId, accountId: next.accountId, phase: next.phase, binding: next.binding } as never;
					void actions.reviewPendingProposal(intent).then((reviewed) => {
						if (reviewed) actions.openPendingSessionStart(intent, null);
					});
				},
			};
			// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated fail-open harness.
			const render = (TyrianCompanionView.prototype as unknown as {
				renderPendingConfirmation(this: typeof harness, container: HTMLElement): void;
			}).renderPendingConfirmation;
			expect(() => render.call(harness, container as unknown as HTMLElement)).not.toThrow();
			walkRetained(container).find((element) => element.textContent === 'view.reviewStart')
				?.listeners.get('click')?.[0]?.();
			await Promise.resolve();
			expect(open).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'proposal' }), null);
		},
	);

	it('omits every dead action for a stale queued proposal', () => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const recordPresented = vi.fn();
		const harness = {
			actions: {
				getPendingProposalState: () => ({
					status: 'ready', pendingCount: 1,
					next: {
						version: 1, phase: 'start', proposalId: 'stale', accountId: 'account',
						binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 },
						proposal: { evidenceQuality: 'complete' }, detectedAt: '2000-01-01T00:00:00.000Z',
						staleAt: '2000-01-01T01:00:00.000Z',
					},
				}) as never,
				recordPendingProposalPresented: recordPresented,
			},
			t: (key: string) => key,
			formatTimestamp: (value: string) => value,
			reviewPending: vi.fn(),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderPendingConfirmation(this: typeof harness, container: HTMLElement): void;
		}).renderPendingConfirmation;
		render.call(harness, container as unknown as HTMLElement);
		const buttons = walkRetained(container).filter((element) => element.tag === 'button');
		expect(buttons).toHaveLength(0);
		expect(walkRetained(container).some((element) => element.textContent === 'view.stale')).toBe(true);
		expect(recordPresented).not.toHaveBeenCalled();
	});
});

describe('Companion retained product shell', () => {
	it('preserves the aside, panel disclosure and focus across an external render', async () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const contentEl = new RetainedFakeElement('div', document);
		const controller = retainedProductController();
		const harness = {
			actions: {
				getLocale: () => 'es' as const,
				getConnectionState: () => ({ status: 'idle' as const }),
				getSessionState: () => ({ version: 1 as const, status: 'idle' as const }),
				getProductActionController: () => controller,
				hasConfiguredApiKey: () => true,
				openProductSettings: () => undefined,
				getLootPresentation: () => null,
				localDebugViewEvent: vi.fn(),
			},
			contentEl,
			refreshInterval: null,
			dynamicStatusNodes: new Map(),
			headerPhase: null,
			headerElapsed: null,
			checkButton: null,
			cooldownNodes: [],
			incident: null,
			incidentMessage: null,
			incidentMore: null,
			ledger: null,
			pendingConfirmationContainer: null,
			pendingConfirmationFocusTarget: null,
			pendingConfirmationKey: null,
			primaryActionButton: null,
			productShell: null,
			productShellKey: null,
			sessionHistoryController: new SessionHistoryPanelController(async () => ({ status: 'ok', sessions: [], ignored: 0 })),
			sessionHistoryPanel: null,
			clearRefresh: vi.fn(),
			projectStatus: () => ({ refreshEveryMs: null }),
			projectPendingConfirmationKey: () => 'test-pending',
			scheduleRefresh: vi.fn(),
			renderLedgerHeader: vi.fn(),
			renderLocalDebugWarning: vi.fn(),
			renderStatusRail: vi.fn(),
			renderSession: vi.fn(),
			renderAssistedDetection: vi.fn(),
			renderPendingConfirmation: (container: RetainedFakeElement) => {
				container.createEl('section', { cls: 'test-pending-confirmation' });
			},
			renderConnectionState: vi.fn(),
			t: (key: string) => key,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated retained-view harness.
		const render = (TyrianCompanionView.prototype as unknown as { render(this: typeof harness): void }).render;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated retained-view harness.
		const close = (TyrianCompanionView.prototype as unknown as { onClose(this: typeof harness): Promise<void> }).onClose;

		render.call(harness);
		const main = walkRetained(contentEl).find((element) => element.tag === 'main')!;
		const sessionDetails = main.children.find((element) => element.tag === 'details' &&
			element.children.some((child) => child.textContent === 'view.sessionDetails'))!;
		const detectionDetails = main.children.find((element) => element.tag === 'details' &&
			element.children.some((child) => child.textContent === 'view.detectionDetails'))!;
		const pending = main.children.find((element) => element.className.includes('tyrian-companion-view__pending-slot'))!;
		const history = main.children.find((element) => element.className.includes('tyrian-session-history'))!;
		expect(main.children.indexOf(sessionDetails)).toBeLessThan(main.children.indexOf(detectionDetails));
		expect(main.children.indexOf(detectionDetails)).toBeLessThan(main.children.indexOf(pending));
		expect(main.children.indexOf(pending)).toBeLessThan(main.children.indexOf(history));
		const aside = walkRetained(contentEl).find((element) => element.tag === 'aside')!;
		const disclosure = walkRetained(aside).find((element) => element.tag === 'details')!;
		const focused = walkRetained(disclosure).find((element) => element.tag === 'button')!;
		disclosure.open = false;
		focused.focus();

		render.call(harness);
		expect(walkRetained(contentEl).find((element) => element.tag === 'aside')).toBe(aside);
		expect(walkRetained(aside).find((element) => element.tag === 'details')).toBe(disclosure);
		expect(disclosure.open).toBe(false);
		expect(document.activeElement).toBe(focused);

		await close.call(harness);
		expect(harness.productShell).toBeNull();
	});
});

function retainedProductController(): ProductActionController {
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

function installRetainedDom(document: RetainedFakeDocument): void {
	vi.stubGlobal('createEl', (tag: string, options?: RetainedFakeOptions) => new RetainedFakeElement(tag, document, options));
	vi.stubGlobal('createDiv', (options?: RetainedFakeOptions) => new RetainedFakeElement('div', document, options));
	vi.stubGlobal('createSpan', (options?: RetainedFakeOptions) => new RetainedFakeElement('span', document, options));
}

function walkRetained(root: RetainedFakeElement): RetainedFakeElement[] {
	return [root, ...root.children.flatMap(walkRetained)];
}

interface RetainedFakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

function pilotWindow() {
	return { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z', uncertaintyMs: 60_000 };
}

class RetainedFakeDocument { activeElement: RetainedFakeElement | null = null }

class RetainedFakeElement {
	readonly children: RetainedFakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	intervalSetCount = 0;
	scheduledInterval: (() => void) | null = null;
	readonly win = {
		setInterval: (callback: () => void, _delay: number) => {
			this.intervalSetCount += 1;
			this.scheduledInterval = callback;
			return this.intervalSetCount;
		},
		clearInterval: (_handle: number) => { this.scheduledInterval = null; },
	};
	className = '';
	textContent = '';
	disabled = false;
	hidden = false;
	open = false;

	constructor(readonly tag: string, readonly ownerDocument: RetainedFakeDocument, options: RetainedFakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	empty(): void { this.children.splice(0); this.textContent = ''; }
	append(...children: RetainedFakeElement[]): void { this.children.push(...children); }
	prepend(...children: RetainedFakeElement[]): void { this.children.unshift(...children); }
	createEl(tag: string, options?: RetainedFakeOptions): RetainedFakeElement {
		const child = new RetainedFakeElement(tag, this.ownerDocument, options); this.children.push(child); return child;
	}
	createDiv(options?: RetainedFakeOptions): RetainedFakeElement {
		const child = new RetainedFakeElement('div', this.ownerDocument, options); this.children.push(child); return child;
	}
	createSpan(options?: RetainedFakeOptions): RetainedFakeElement {
		const child = new RetainedFakeElement('span', this.ownerDocument, options); this.children.push(child); return child;
	}
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
	focus(): void { this.ownerDocument.activeElement = this; }
	contains(target: RetainedFakeElement | null): boolean {
		return target === this || this.children.some((child) => child.contains(target));
	}
}
