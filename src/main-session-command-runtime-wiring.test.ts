// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { ConnectionService, type ConnectionState } from './account/connection-service';
import { createTranslator } from './core/i18n';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import type { TyrianMenuEntry, TyrianRibbonHandle, TyrianRibbonRegistration } from './host/tyrian-host';
import { LiveSessionRuntime } from './runtime/live-session-runtime';
import { SessionCommandRuntime } from './runtime/session-command-runtime';
import type { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import type { IngamePresenceSnapshot } from './alerts/alert-ingame-presence';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { PendingProposalIntent } from './sessions/pending-proposal-model';
import { PendingProposalService } from './sessions/pending-proposal-service';
import { SESSION_STATE_VERSION } from './sessions/session';
import {
	ConfirmAbandonSessionModal,
	ConfirmClearCompletedSessionModal,
	ConfirmDiscardLiveSessionModal,
	ConfirmDiscardSessionModal,
} from './ui/companion-modals';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import { SessionCommandController } from './ui/session-command-controller';
import { TyrianModal } from './ui/tyrian-modal';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3d: the core's side of `SessionCommandRuntime`, over the real core and its real
 * `initializeRuntime`. The core's one facade method (`FACADE`) reaches it with the view's arguments,
 * and the port reads the core's fields as they stand (several are built after the port, in
 * `initializeRuntime` or `onload`) and writes the modals, the controller, its dispatch and the ribbon
 * back to the core's own fields, which the unload, the product actions and `LiveSessionRuntime` read.
 * The commands' own behaviour (the intents through the real controller and the real modals) is run
 * in `src/main.test.ts` ('manual session start command', 'abandon session command').
 */

/** The methods both expose; `collectorMode` is a field of the core, read by the port. */
type FacadeMethod = Exclude<keyof SessionCommandRuntime & keyof TyrianCompanionCore, 'collectorMode'>;

const BOUNDARY = '2026-10-11T00:00:00.000Z';
const INTENT: PendingProposalIntent = {
	proposalId: 'proposal-1', accountId: 'account-1', phase: 'start',
	binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 },
};

/**
 * Each facade method of the core and the arguments SessionCommandRuntime must get. A record over
 * `FacadeMethod`, so a public method added to both does not compile until it has its row here.
 */
const FACADE: Readonly<Record<FacadeMethod, readonly [call: (core: TyrianCompanionCore) => unknown, args: readonly unknown[]]>> = {
	openPendingSessionStart: [(core) => { core.openPendingSessionStart(INTENT, BOUNDARY); }, [INTENT, BOUNDARY]],
};

/** The core's own fields these cases read, and its commands runtime. */
interface CoreFields {
	commands: SessionCommandRuntime;
	host: { ui: { ribbon(registration: TyrianRibbonRegistration): TyrianRibbonHandle; openMenu(entries: readonly TyrianMenuEntry[], event: MouseEvent): void; registerCommand(...args: unknown[]): unknown } };
	liveSessions: unknown;
	unloaded: boolean;
	localDebugActions: LocalDebugActionRunner | null;
	ingameSessionMarker: { linkReplacement(previous: string | null, next: string, reason: string): void } | null;
	sessionHistoryRuntimeAuthority: { acquireScrub(): { release(): void } | null };
	startModal: unknown;
	discardModal: unknown;
	clearModal: unknown;
	abandonModal: unknown;
	discardLiveModal: unknown;
	sessionCommands: SessionCommandController | undefined;
	sessionDispatch: unknown;
	sessionRibbon: TyrianRibbonHandle | null;
}

describe('the core hands the session commands to SessionCommandRuntime', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	/** The real core, not booted: a collector device, with no modal really opened. */
	function core() {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const setup = runtime.core as unknown as {
			localDebugActions: null;
			settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
		};
		setup.localDebugActions = null;
		setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined };
		runtime.core.settings = { ...runtime.core.settings, apiKeySecret: 'tyrian-test-key', language: 'es' };
		const open = vi.spyOn(TyrianModal.prototype, 'open').mockImplementation(() => undefined);
		return { runtime, own: runtime.core as unknown as CoreFields, open };
	}

	/** The ribbon `onload` would add, recorded; its handle is the one the core must keep. */
	function ribbonOf(own: CoreFields) {
		const handle = { setTitle: vi.fn<(title: string) => void>(), setPending: vi.fn<(pending: boolean) => void>() };
		let registered: TyrianRibbonRegistration | null = null;
		vi.spyOn(own.host.ui, 'ribbon').mockImplementation((registration) => { registered = registration; return handle; });
		return {
			handle,
			registration: (): TyrianRibbonRegistration => { if (registered === null) throw new Error('No ribbon was added.'); return registered; },
		};
	}

	it.each(Object.keys(FACADE) as FacadeMethod[])('%s reaches SessionCommandRuntime once, with the view\'s arguments', async (name) => {
		const { runtime } = core();
		await runtime.initializeRuntime();
		const reached = vi.spyOn(SessionCommandRuntime.prototype, name).mockImplementation(() => undefined);
		const [call, args] = FACADE[name];

		const answer = call(runtime.core);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toBeUndefined();
	});

	describe('the port reads the core as it stands and writes the commands\' state back to it', () => {
		it('sessionCommands, sessionDispatch and sessionRibbon: the setup leaves the controller, its dispatch and the ribbon on the core, where live runs its commands', async () => {
			const { runtime, own } = core();
			const { handle } = ribbonOf(own);
			own.commands.setupSessionCommands();
			await runtime.initializeRuntime();
			const run = vi.spyOn(SessionCommandController.prototype, 'run').mockResolvedValue(undefined);

			await runtime.core.resetCompletedSession();

			expect({
				controller: own.sessionCommands instanceof SessionCommandController,
				dispatch: typeof own.sessionDispatch,
				ribbon: own.sessionRibbon,
				ranOn: run.mock.contexts[0],
			}).toEqual({ controller: true, dispatch: 'object', ribbon: handle, ranOn: own.sessionCommands });
		});

		it('settings and host: the ribbon is added through the core\'s host, titled in the language the core reads now', () => {
			const { own } = core();
			const { registration } = ribbonOf(own);

			own.commands.setupSessionCommands();

			expect(registration().title).toBe(createTranslator('es').t('commands.ribbon'));
		});

		it('runtimeReady, sessions, connection and liveSessions: the controller set up before the boot reads the context the boot built', async () => {
			const { runtime, own } = core();
			ribbonOf(own);
			own.commands.setupSessionCommands();
			const before = own.sessionCommands!.describe('start-farming-session').available;
			await runtime.initializeRuntime();
			// A device without a live lifecycle reads the account-era context.
			own.liveSessions = null;
			vi.spyOn(ConnectionService.prototype, 'getState').mockReturnValue({ status: 'connected' } as ConnectionState);
			vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue({ version: SESSION_STATE_VERSION, status: 'idle' });

			expect({ before, after: own.sessionCommands!.describe('start-farming-session').available }).toEqual({ before: false, after: true });
		});

		it.each([
			['discard-saved-session', 'discardModal', ConfirmDiscardSessionModal],
			['clear-completed-session', 'clearModal', ConfirmClearCompletedSessionModal],
			['abandon-farming-session', 'abandonModal', ConfirmAbandonSessionModal],
		] as const)('%s on a device without a live lifecycle: its confirmation is the core\'s own %s', async (id, field, Modal) => {
			const { runtime, own, open } = core();
			await runtime.initializeRuntime();
			own.liveSessions = null;

			void own.commands.prepareSessionCommand(id);
			const opened = own[field];
			void own.commands.prepareSessionCommand(id);

			expect({ opened: opened instanceof Modal, same: own[field] === opened, opens: open.mock.calls.length })
				.toEqual({ opened: true, same: true, opens: 1 });
		});

		it('discardLiveModal and live: a stuck live session\'s discard confirms in the core\'s own field and runs on the core\'s live runtime', async () => {
			const { runtime, own } = core();
			await runtime.initializeRuntime();
			const discard = vi.spyOn(LiveSessionRuntime.prototype, 'performDiscardLiveSession').mockResolvedValue();

			const prepared = own.commands.prepareSessionCommand('discard-saved-session');
			const modal = own.discardLiveModal as ConfirmDiscardLiveSessionModal;
			await (modal as unknown as { onConfirm(): Promise<void> }).onConfirm();
			await (await prepared)?.();

			expect({ modal: modal instanceof ConfirmDiscardLiveSessionModal, discarded: discard.mock.contexts[0] })
				.toEqual({ modal: true, discarded: (own as unknown as { live: LiveSessionRuntime }).live });
		});

		it('startModal: a pending start proposal opens the start modal once, in the core\'s own field', async () => {
			const { runtime, own, open } = core();
			await runtime.initializeRuntime();

			runtime.core.openPendingSessionStart(INTENT);
			const opened = own.startModal;
			runtime.core.openPendingSessionStart(INTENT);

			expect({ opened: opened instanceof ManualSessionStartModal, same: own.startModal === opened, opens: open.mock.calls.length })
				.toEqual({ opened: true, same: true, opens: 1 });
		});

		it('sessionHistoryRuntimeAuthority: while a history scrub holds the runtime, no command is prepared', async () => {
			const { runtime, own } = core();
			await runtime.initializeRuntime();
			const scrub = own.sessionHistoryRuntimeAuthority.acquireScrub();

			const during = await own.commands.prepareSessionCommand('discard-saved-session');
			scrub?.release();
			void own.commands.prepareSessionCommand('discard-saved-session');

			expect({ scrubbing: scrub !== null, during, after: own.discardLiveModal instanceof ConfirmDiscardLiveSessionModal })
				.toEqual({ scrubbing: true, during: null, after: true });
		});

		it('pendingProposals: the ribbon flags the pending proposal of the queue the boot built', async () => {
			const { runtime, own } = core();
			const { handle } = ribbonOf(own);
			own.commands.setupSessionCommands();
			await runtime.initializeRuntime();
			vi.spyOn(PendingProposalService.prototype, 'getState').mockReturnValue({ status: 'ready', pendingCount: 1, next: null });
			handle.setPending.mockClear();

			own.commands.refreshSessionRibbon();

			expect(handle.setPending.mock.calls).toEqual([[true]]);
		});

		it('localDebugActions: a runner the core gets after the runtime was built journals a menu command', async () => {
			const { runtime, own } = core();
			const { registration } = ribbonOf(own);
			own.commands.setupSessionCommands();
			await runtime.initializeRuntime();
			const records: LocalDebugRecordInput[] = [];
			let id = 0;
			own.localDebugActions = new LocalDebugActionRunner({
				diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
				createId: () => `diagnostic-${String(id += 1)}`,
			});
			let menu: readonly TyrianMenuEntry[] = [];
			vi.spyOn(own.host.ui, 'openMenu').mockImplementation((entries) => { menu = entries; });
			vi.spyOn(runtime.core as unknown as { activateView(): Promise<void> }, 'activateView').mockResolvedValue();

			registration().onClick({} as MouseEvent);
			const open = menu.find((entry) => entry.kind === 'item');
			if (open?.kind !== 'item') throw new Error('The menu offered nothing.');
			open.onClick();
			await vi.waitFor(() => { expect(records.length).toBeGreaterThan(0); });

			expect(records).toContainEqual(expect.objectContaining({ component: 'ui', action: 'command_execute', state: 'open_companion' }));
		});

		it('collectorMode and unloaded: a stuck live session can be discarded until the device turns to consult, or the plugin unloads', async () => {
			const { runtime, own } = core();
			await runtime.initializeRuntime();
			vi.spyOn(runtime.core, 'isLiveSessionStuck').mockReturnValue(true);
			const canDiscard = (): boolean => own.commands.passiveSessionCommandContext().canDiscard;

			const collector = canDiscard();
			runtime.core.collectorMode = 'consult';
			const consult = canDiscard();
			runtime.core.collectorMode = 'collector';
			own.unloaded = true;
			const unloaded = canDiscard();

			expect({ collector, consult, unloaded }).toEqual({ collector: true, consult: false, unloaded: false });
		});

		it('ingameSessionMarker: a passive start links the new session to the addon through the marker the core built later', async () => {
			const { runtime, own } = core();
			await runtime.initializeRuntime();
			const linkReplacement = vi.fn();
			own.ingameSessionMarker = { linkReplacement };
			vi.spyOn(runtime.core, 'getIngamePresence').mockReturnValue({ status: 'present', context: { character: 'Astra Uno' } } as IngamePresenceSnapshot);
			const started = vi.spyOn(runtime.core as unknown as { startIngameSession(character: string | null): Promise<string | null> }, 'startIngameSession')
				.mockResolvedValue('new-session');

			const start = await own.commands.prepareSessionCommand('start-farming-session');
			await start?.();

			expect({ started: started.mock.calls, linked: linkReplacement.mock.calls })
				.toEqual({ started: [['Astra Uno']], linked: [[null, 'new-session', 'adopted']] });
		});
	});
});
