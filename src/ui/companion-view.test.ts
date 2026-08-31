import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./halloween-alert-panel', () => ({ renderHalloweenAlertPanel: vi.fn() }));

import { TyrianCompanionView } from './companion-view';
import { createTranslator } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import { ProductActionController } from './product-action-controller';
import { SessionHistoryPanelController } from './session-history-panel';

afterEach(() => vi.unstubAllGlobals());

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
			'Local diagnostics are degraded',
			'Some entries could not be written. Plugin actions continue to work.',
			'Local diagnostics',
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
		const translator = createTranslator('es');
		const harness = {
			t: (key: RuntimeTranslationKey, params?: Record<string, string | number>) => translateRuntime(translator, key, params),
			formatTimestamp: (value: string) => value,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderDetectionTimeline(
				this: typeof harness, container: HTMLElement, mode: 'assisted', state: unknown, session: unknown,
			): void;
		}).renderDetectionTimeline;
		const attemptedAt = Date.parse('2026-08-31T10:00:00.000Z');
		render.call(harness, container as unknown as HTMLElement, 'assisted', {
			status: 'armed', armedAt: '2026-08-31T09:00:00.000Z', lastSnapshotAt: '2026-08-31T10:00:00.000Z',
			scheduler: {
				status: 'scheduled', intervalMs: 120_000, nextRunAt: attemptedAt + 120_000,
				lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, consecutiveFailures: 0,
			},
		}, { status: 'idle' });

		const cells = container.children[0]?.children ?? [];
		expect(cells.map((cell) => cell.children[0]?.textContent)).toEqual(['Última consulta', 'Resultado', 'Próxima consulta']);
		expect(cells[1]?.children[1]?.textContent).toContain('saco #36038');
		expect(harness.t('view.assistedDetection')).toBe('Detección del saco #36038');
		expect(harness.t('view.detectionScope')).toContain('No detecta farmeo general');
	});

	it('promotes exactly one pending confirmation over the ordinary session action', () => {
		const document = new RetainedFakeDocument();
		const container = new RetainedFakeElement('div', document);
		const next = { phase: 'start' as const };
		const reviewPending = vi.fn();
		const harness = {
			actions: { getPendingProposalState: () => ({ status: 'ready', pendingCount: 1, next }) },
				t: (key: string) => key,
				reviewPending,
			};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderPrimaryAction(this: typeof harness, container: HTMLElement, projection: unknown, connection: unknown): void;
		}).renderPrimaryAction;
		render.call(harness, container as unknown as HTMLElement, { primaryAction: 'start' }, { status: 'connected' });
		expect(container.children).toHaveLength(1);
		expect(container.children[0]?.className).toContain('mod-cta');
		expect(container.children[0]?.textContent).toBe('view.reviewStart');
		container.children[0]?.listeners.get('click')?.[0]?.();
		expect(reviewPending).toHaveBeenCalledWith(next);
	});
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
						staleAt: '2026-08-21T10:00:00.000Z',
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
			productShell: null,
			productShellKey: null,
			sessionHistoryController: new SessionHistoryPanelController(async () => ({ status: 'ok', sessions: [], ignored: 0 })),
			sessionHistoryPanel: null,
			clearRefresh: vi.fn(),
			projectStatus: () => ({ refreshEveryMs: null }),
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
		const pending = main.children.find((element) => element.className.includes('test-pending-confirmation'))!;
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
	readonly win = { setInterval: () => 1, clearInterval: () => undefined };
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
}
