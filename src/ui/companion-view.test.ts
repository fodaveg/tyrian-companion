import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./halloween-alert-panel', () => ({ renderHalloweenAlertPanel: vi.fn() }));

import { TyrianCompanionView } from './companion-view';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import { ProductActionController } from './product-action-controller';

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
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocalDebugStatus: () => status,
				getLocale: () => 'en' as const,
				openLocalDebugSettings: opened,
			},
		});
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
				getProvisionalDelta: () => null,
				getContaminationReview: () => null,
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

	it.each(['start_proposed', 'disarmed'] as const)(
		'arms the sole HUD timer for a new pending proposal and expires it in place while detection is %s',
		(detectionStatus) => {
			vi.useFakeTimers();
			const now = Date.parse('2026-08-31T10:00:00.000Z');
			vi.setSystemTime(now);
			const document = new RetainedFakeDocument();
			const contentEl = new RetainedFakeElement('div', document);
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
			const projection = { refreshEveryMs: null, items: [], errors: [] };
			const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
				actions, contentEl, refreshInterval: null,
				headerElapsed: null, checkButton: null,
				incident: null, incidentMessage: null, incidentMore: null,
				detectionTimelineNodes: null, pendingConfirmationContainer: pending, pendingConfirmationKey: null,
				pendingConfirmationFocusTarget: null,
				projectStatus: () => projection,
				t: (key: string) => key,
				formatTimestamp: (value: string) => value,
			});
			const methods = TyrianCompanionView.prototype as unknown as {
				renderPendingConfirmation(this: typeof harness, container: HTMLElement, at: number): void;
				projectPendingConfirmationKey(this: typeof harness, at: number): string;
				scheduleRefresh(this: typeof harness, projection: unknown, retryAt: number | null, at: number): void;
				refreshBackgroundStatus(this: typeof harness): void;
			};
			methods.renderPendingConfirmation.call(harness, pending as unknown as HTMLElement, now);
			(harness as { pendingConfirmationKey: string | null }).pendingConfirmationKey =
				methods.projectPendingConfirmationKey.call(harness, now);
			methods.scheduleRefresh.call(harness, projection, null, now);
			expect(contentEl.scheduledInterval).toBeNull();

			currentNext = next;
			methods.refreshBackgroundStatus.call(harness);
			const pendingButtons = walkRetained(pending).filter((element) => element.tag === 'button');
			expect(pendingButtons).toHaveLength(2);
			expect(contentEl.intervalSetCount).toBe(1);
			const tick = contentEl.scheduledInterval;
			expect(tick).not.toBeNull();
			pendingButtons[0]?.focus();

			vi.advanceTimersByTime(1_000);
			tick?.();

			// The expired proposal loses every action, and the focus that lived inside the repainted
			// slot lands on the stale section instead of falling back to the document.
			expect(openManualSessionStart).not.toHaveBeenCalled();
			expect(reviewPendingProposal).not.toHaveBeenCalled();
			expect(walkRetained(pending).filter((element) => element.tag === 'button')).toHaveLength(0);
			const stale = walkRetained(pending).find((element) => element.attributes.get('tabindex') === '-1');
			expect(stale).toBeTruthy();
			expect(walkRetained(pending).some((element) => element.textContent === 'view.stale')).toBe(true);
			expect(document.activeElement).toBe(stale);
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
			renderStopProposalLag: vi.fn(),
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
	it('offers human review only when automatic finalization leaves a provisional session', () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const container = new RetainedFakeElement('div', document);
		const openSessionReview = vi.fn();
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getProvisionalDelta: () => null,
				getContaminationReview: () => null,
				openSessionReview,
				getLiveSessionLoot: () => ({ status: 'complete' as const, sessionId: 'session', restored: false,
					rows: [], knownTotalCopper: 0, hasUnknownValue: false, updatedAt: null, error: null }),
			},
			renderLiveLoot: vi.fn(),
		});
		const session = {
			version: 1 as const, status: 'provisional' as const, sessionId: 'session',
			startContext: { characterName: 'Rinopopo' },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated view harness.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderSimpleSession(this: typeof harness, container: HTMLElement, connection: unknown, session: unknown, projection: unknown): void;
		}).renderSimpleSession;
		render.call(harness, container as unknown as HTMLElement, { status: 'connected' }, session, { items: [], errors: [] });
		const button = walkRetained(container).find((element) => element.tag === 'button' && element.textContent === 'Revisar');
		expect(button).toBeTruthy();
		button?.listeners.get('click')?.[0]?.();
		expect(openSessionReview).toHaveBeenCalledOnce();
	});

	it('offers one-click next-session rotation from the completed summary', () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const container = new RetainedFakeElement('div', document);
		const rotateToNewSession = vi.fn(async () => undefined);
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getProvisionalDelta: () => null,
				getContaminationReview: () => null,
				rotateToNewSession,
				getLootPresentation: () => null,
				getLiveSessionLoot: () => ({ status: 'complete' as const, sessionId: 'session', restored: false,
					rows: [], knownTotalCopper: 0, hasUnknownValue: false, updatedAt: null, error: null }),
			},
			renderLiveLoot: vi.fn(),
		});
		const session = {
			version: 1 as const, status: 'complete' as const, sessionId: 'session',
			startContext: { characterName: 'Rinopopo' },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated view harness.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderSimpleSession(this: typeof harness, container: HTMLElement, connection: unknown, session: unknown, projection: unknown): void;
		}).renderSimpleSession;
		render.call(harness, container as unknown as HTMLElement, { status: 'connected' }, session, { items: [], errors: [] });
		const button = walkRetained(container).find((element) => element.tag === 'button' && element.textContent === 'Nueva sesión');
		expect(button).toBeTruthy();
		button?.listeners.get('click')?.[0]?.();
		expect(rotateToNewSession).toHaveBeenCalledOnce();
	});

	it('prefers the durable note names after restart when the live tracker is idle', () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const container = new RetainedFakeElement('div', document);
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getProvisionalDelta: () => null,
				getContaminationReview: () => null,
				getSessionSummarySaveState: () => 'saved' as const,
				getLiveSessionLoot: () => ({ status: 'idle' as const }),
				getStoredSessionLootSummary: () => ({
					locale: 'es' as const, immediateCopper: 40_000,
					rows: [{ name: 'Pimpollo de flor de cerezo', netQuantity: 4, immediateLabel: '4 g 00 s 00 c' }],
				}),
				getLootPresentation: () => ({
					version: 1, locale: 'es', scope: 'observed_storage_net', quality: 'estimated', warnings: [],
					rows: [{ key: 'item:9349', namespace: 'item', id: 9349, name: 'Objeto #9349', direction: 'gain',
						netQuantity: 4, evidence: 'estimated_net', valuation: { status: 'complete', immediateCopper: 40_000, listingCopper: 45_000 },
						allocation: { status: 'not_evaluated' }, recommendation: { status: 'not_evaluated' } }],
					economy: { immediateCopper: 40_000 }, decision: {},
				}) as never,
			},
			renderLiveLoot: vi.fn(),
		});
		const session = { version: 1 as const, status: 'complete' as const, sessionId: 'session',
			startContext: { characterName: 'Rinopopo' } };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated view harness.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderSimpleSession(this: typeof harness, container: HTMLElement, connection: unknown, session: unknown, projection: unknown): void;
		}).renderSimpleSession;
		render.call(harness, container as unknown as HTMLElement, { status: 'connected' }, session, { items: [], errors: [] });
		const text = walkRetained(container).map(({ textContent }) => textContent).join(' ');
		expect(text).toContain('Resumen guardado');
		expect(text).toContain('Pimpollo de flor de cerezo');
		expect(text).toContain('×4');
		expect(text).not.toContain('Objeto guardado');
	});

	it('shows the real failed save state with one contextual retry action', () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const container = new RetainedFakeElement('div', document);
		const retrySessionSummarySave = vi.fn(async () => undefined);
		const harness = Object.assign(Object.create(TyrianCompanionView.prototype) as object, {
			actions: {
				getLocale: () => 'es' as const,
				getProvisionalDelta: () => null,
				getContaminationReview: () => null,
				getSessionSummarySaveState: () => 'failed' as const,
				retrySessionSummarySave,
				getLiveSessionLoot: () => ({ status: 'idle' as const }),
				getLootPresentation: () => null,
			},
			renderLiveLoot: vi.fn(),
		});
		const session = { version: 1 as const, status: 'complete' as const, sessionId: 'session',
			startContext: { characterName: 'Rinopopo' } };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated view harness.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderSimpleSession(this: typeof harness, container: HTMLElement, connection: unknown, session: unknown, projection: unknown): void;
		}).renderSimpleSession;
		render.call(harness, container as unknown as HTMLElement, { status: 'connected' }, session, { items: [], errors: [] });
		const retry = walkRetained(container).find((element) => element.tag === 'button' && element.textContent === 'Reintentar guardado');
		expect(walkRetained(container).some(({ textContent }) => textContent.includes('pendiente de guardar'))).toBe(true);
		expect(retry).toBeTruthy();
		retry?.listeners.get('click')?.[0]?.();
		expect(retrySessionSummarySave).toHaveBeenCalledOnce();
	});

	it('preserves the navigation shell without remounting the removed action panel', async () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const contentEl = new RetainedFakeElement('div', document);
		const controller = retainedProductController();
		const harness = {
			actions: {
				getLocale: () => 'es' as const,
				getProvisionalDelta: () => null,
				getContaminationReview: () => null,
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
			productShell: null,
			productShellKey: null,
			clearRefresh: vi.fn(),
			projectStatus: () => ({ refreshEveryMs: null }),
			scheduleRefresh: vi.fn(),
			renderLocalDebugWarning: vi.fn(),
			// The panels below have their own behavioural suites; this case only watches the shell.
			renderPendingConfirmationSlot: vi.fn(),
			renderAssistedDetection: vi.fn(),
			renderHalloweenAlerts: vi.fn(),
			renderSessionHistory: vi.fn(),
			sessionHistoryMount: null,
			renderSimpleSession: (container: RetainedFakeElement) => {
				container.createEl('section', { cls: 'tyrian-companion-session' });
			},
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated retained-view harness.
		const render = (TyrianCompanionView.prototype as unknown as { render(this: typeof harness): void }).render;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated retained-view harness.
		const close = (TyrianCompanionView.prototype as unknown as { onClose(this: typeof harness): Promise<void> }).onClose;

		render.call(harness);
		const main = walkRetained(contentEl).find((element) => element.tag === 'main')!;
		expect(main.children).toHaveLength(1);
		expect(main.children[0]?.className).toContain('tyrian-companion-session');
		const shell = walkRetained(contentEl).find((element) => element.className.includes('tyrian-product-shell'))!;
		expect(walkRetained(contentEl).some((element) => element.tag === 'aside')).toBe(false);

		render.call(harness);
		expect(walkRetained(contentEl).find((element) => element.className.includes('tyrian-product-shell'))).toBe(shell);
		expect(walkRetained(contentEl).some((element) => element.tag === 'aside')).toBe(false);

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

describe('Companion stop proposal staleness', () => {
	function renderLag(possibleTo: string, detectedAt: string): RetainedFakeElement {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const harness = {
			t: (key: string, params?: Record<string, string | number>) => `${key}:${String(params?.duration)}`,
			formatDuration: (durationMs: number) => `${String(durationMs / 60_000)}min`,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated render harness.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderStopProposalLag(this: typeof harness, container: HTMLElement, possibleTo: string, detectedAt: string): void;
		}).renderStopProposalLag;
		render.call(harness, container as unknown as HTMLElement, possibleTo, detectedAt);
		return container;
	}

	it('states how much later than the possible end the quiet was confirmed', () => {
		// Stopping settles the session at the moment the button is pressed, so a proposal that
		// arrives long after its own frontier must say so instead of looking current.
		const container = renderLag('2026-08-20T10:00:00.000Z', '2026-08-20T10:20:00.000Z');

		expect(walkRetained(container).map((element) => element.textContent))
			.toContain('view.stopProposalLag:20min');
	});

	it.each([
		['2026-08-20T10:00:00.000Z', '2026-08-20T10:00:00.000Z'],
		['2026-08-20T10:00:00.000Z', 'not-a-timestamp'],
	])('says nothing when there is no lag to declare (%s, %s)', (possibleTo, detectedAt) => {
		expect(walkRetained(renderLag(possibleTo, detectedAt))).toHaveLength(1);
	});
});

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
