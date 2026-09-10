import { describe, expect, it, vi } from 'vitest';

import type { SessionRecoveryState, SessionStopFailure } from '../sessions/manual-session-start-service';
import type { SessionState } from '../sessions/session';
import { LocalDebugActionRunner, type LocalDebugActionPort } from '../core/local-debug-action-runner';
import type { LocalDebugRecordV1 } from '../core/local-debug-contract';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from '../core/local-debug-writer';
import { SessionCommandBackendFailure, SessionCommandController, type SessionCommandPorts } from './session-command-controller';
import {
	createSessionCommandDispatch,
	hasExactSessionBackendResult,
	projectSessionMenu,
	registerSessionPalette,
	type PaletteCommandSpec,
} from './session-command-adapter';
import { projectSessionCommands, SESSION_COMMAND_IDS, type SessionCommandContext } from './session-command-model';

describe('projectSessionCommands', () => {
	it.each([
		['idle', ['start-farming-session']],
		['starting', []],
		['active', ['finish-farming-session']],
		['stopping', []],
		// Nobody reviews a session anymore (Lote S, 2026-09-09): `provisional` finalizes on its own
		// and offers no command while it does.
		['provisional', []],
		['complete', ['clear-completed-session']],
		['error', []],
	] as const)('projects commands for %s', (status, expected) => {
		expect(available(context(status))).toEqual(expected);
	});

	it('requires a visible stop failure before retrying stopping', () => {
		expect(available(context('stopping', { stopFailure: failure() }))).toEqual(['finish-farming-session']);
	});

	/**
	 * H15.8 (2026-09-10 audit): a live authority failure (heartbeat `lease_lost`, stop
	 * `clock_anomaly`) leaves `state.status === 'error'` with a recorded `stopFailure`, and no
	 * descriptor here checked that status at all: `sessionCommands.available()` came back `[]`, the
	 * exact dead end the audit measured (only a manual Obsidian reload got the player out).
	 */
	it('offers a retry from a live authority-failure error once a stop failure is on record', () => {
		expect(available(context('error', { stopFailure: failure() }))).toEqual(['finish-farming-session']);
	});

	it('does not define or offer an active-session cancel command', () => {
		expect(SESSION_COMMAND_IDS as readonly string[]).not.toContain('cancel-session');
		for (const status of ['idle', 'starting', 'active', 'stopping', 'provisional', 'complete', 'error'] as const) {
			expect(projectSessionCommands(context(status)).map((command) => command.id)).not.toContain('cancel-session');
		}
	});

	it('requires account connection before start', () => {
		for (const connection of ['idle', 'checking', 'error'] as const) {
			expect(available(context('idle', { connection }))).toEqual([]);
		}
		for (const connection of ['connected', 'warning'] as const) {
			expect(available(context('idle', { connection }))).toEqual(['start-farming-session']);
		}
	});

	it.each(['available', 'busy'] as const)('offers recover and confirmed discard while recovery is %s', (status) => {
		const recovery = { status, state: state('active'), message: status === 'busy' ? 'Retry later.' : undefined } as SessionRecoveryState;
		const commands = projectSessionCommands(context('idle', { recovery }));
		expect(commands.filter((command) => command.available).map((command) => command.id))
			.toEqual(['recover-saved-session', 'discard-saved-session']);
		expect(commands.find((command) => command.id === 'discard-saved-session')?.destructive).toBe(true);
	});

	it('fails closed while recovery is working', () => {
		const recovery = { status: 'working', action: 'recover', state: state('active') } as SessionRecoveryState;
		expect(available(context('idle', { recovery }))).toEqual([]);
	});

	it('offers only a confirmed discard while the saved recovery evidence could not be read', () => {
		const recovery = { status: 'error', code: 'corrupt', message: 'Failed.' } as SessionRecoveryState;
		const commands = projectSessionCommands(context('idle', { recovery }));
		expect(commands.filter((command) => command.available).map((command) => command.id))
			.toEqual(['discard-saved-session']);
		expect(commands.find((command) => command.id === 'discard-saved-session')?.destructive).toBe(true);
	});

	it('has one stable descriptor for every registered command id', () => {
		expect(projectSessionCommands(context('idle')).map((command) => command.id)).toEqual(SESSION_COMMAND_IDS);
	});

	it('localizes names without changing stable command ids', () => {
		const commands = projectSessionCommands(context('idle'), 'es');
		expect(commands.find((command) => command.id === 'start-farming-session')).toMatchObject({
			id: 'start-farming-session', name: 'Iniciar sesión de farmeo',
		});
	});
});

describe('SessionCommandController', () => {
	it('reports completed, cancelled, unavailable and failed outcomes without changing legacy run()', async () => {
		const completed = controllerHarness('active');
		completed.ports.prepare.mockResolvedValue(async () => undefined);
		await expect(completed.controller.runWithOutcome('finish-farming-session')).resolves.toBe('completed');

		const cancelled = controllerHarness('complete');
		cancelled.ports.prepare.mockResolvedValue(null);
		await expect(cancelled.controller.runWithOutcome('clear-completed-session')).resolves.toBe('cancelled');

		const unavailable = controllerHarness('starting');
		await expect(unavailable.controller.runWithOutcome('start-farming-session')).resolves.toBe('unavailable');

		// `provisional` no longer offers any command (Lote S, 2026-09-09: it finalizes on its own),
		// so this generic "prepare throws" case moves to `complete`/`clear-completed-session`.
		const failed = controllerHarness('complete');
		failed.ports.prepare.mockResolvedValue(async () => { throw new Error('raw detail'); });
		await expect(failed.controller.runWithOutcome('clear-completed-session')).resolves.toBe('failed');
		await expect(completed.controller.run('finish-farming-session')).resolves.toBeUndefined();
	});

	it('rechecks stale state inside the execution microtask', async () => {
		const harness = controllerHarness('idle');
		expect(harness.controller.describe('start-farming-session').available).toBe(true);
		const run = harness.controller.run('start-farming-session');
		harness.setState('starting');
		await run;
		expect(harness.ports.prepare).not.toHaveBeenCalled();
		expect(harness.ports.notify).toHaveBeenCalledWith('That session action is no longer available.');
	});

	it('coalesces a double asynchronous invocation', async () => {
		const harness = controllerHarness('active');
		const execute = vi.fn();
		let release!: () => void;
		harness.ports.prepare.mockResolvedValue(() => new Promise<void>((resolve) => { release = resolve; }));
		const first = harness.controller.run('finish-farming-session');
		const second = harness.controller.run('finish-farming-session');
		expect(first).toBe(second);
		await flush();
		expect(harness.ports.prepare).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
		release();
		await first;
	});

	it('keeps the flight through confirmation and resolves cancel without backend work', async () => {
		const harness = controllerHarness('complete');
		const confirmation = deferred<(() => Promise<void>) | null>();
		const execute = vi.fn(async () => undefined);
		harness.ports.prepare.mockReturnValue(confirmation.promise);
		const first = harness.controller.run('clear-completed-session');
		const second = harness.controller.run('clear-completed-session');
		expect(second).toBe(first);
		confirmation.resolve(null);
		await first;
		expect(execute).not.toHaveBeenCalled();
		expect(harness.ports.notify).not.toHaveBeenCalled();
	});

	it('revalidates the exact destructive command after confirmation', async () => {
		const recovery = { status: 'available', state: state('active') } as SessionRecoveryState;
		const harness = controllerHarness('idle', { recovery });
		const confirmation = deferred<(() => Promise<void>) | null>();
		const execute = vi.fn(async () => undefined);
		harness.ports.prepare.mockReturnValue(confirmation.promise);
		const run = harness.controller.run('discard-saved-session');
		await flush();
		harness.setContext({ recovery: { status: 'working', action: 'recover', state: state('active') } as SessionRecoveryState });
		confirmation.resolve(execute);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(harness.ports.notify).toHaveBeenCalledWith('That session action is no longer available.');
	});

	// `provisional` no longer offers any command (Lote S, 2026-09-09), so its row moves to `active`/
	// `finish-farming-session`: still two different session identities under the same status,
	// still genuinely available from the start, so the mid-flight target-mismatch path this test
	// means to exercise is the one that actually fires (not an unrelated "unavailable from the
	// start" that would notify the identical message for the wrong reason).
	it.each([
		['finish-farming-session', 'active'],
		['clear-completed-session', 'complete'],
	] as const)('rejects same-status session identity replacement for %s', async (command, status) => {
		const harness = controllerHarness(status);
		harness.setContext({ state: identifiedState(status, 'session-a', 1) });
		const confirmation = deferred<(() => Promise<void>) | null>();
		const execute = vi.fn(async () => undefined);
		harness.ports.prepare.mockReturnValue(confirmation.promise);
		const run = harness.controller.run(command);
		await flush();
		harness.setContext({ state: identifiedState(status, 'session-b', 2) });
		confirmation.resolve(execute);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(harness.ports.notify).toHaveBeenCalledWith('That session action is no longer available.');
	});

	it('rejects recovery A replaced by recovery B after confirmation', async () => {
		const first = { status: 'available', state: identifiedState('active', 'session-a', 1) } as SessionRecoveryState;
		const second = { status: 'available', state: identifiedState('active', 'session-b', 2) } as SessionRecoveryState;
		const harness = controllerHarness('idle', { recovery: first });
		const confirmation = deferred<(() => Promise<void>) | null>();
		const execute = vi.fn(async () => undefined);
		harness.ports.prepare.mockReturnValue(confirmation.promise);
		const run = harness.controller.run('discard-saved-session');
		await flush();
		harness.setContext({ recovery: second });
		confirmation.resolve(execute);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(harness.ports.notify).toHaveBeenCalledWith('That session action is no longer available.');
	});

	it('shares one recovery mutex between recover and discard', async () => {
		const recovery = { status: 'available', state: state('active') } as SessionRecoveryState;
		const harness = controllerHarness('idle', { recovery });
		const intent = deferred<(() => Promise<void>) | null>();
		harness.ports.prepare.mockReturnValue(intent.promise);
		const recover = harness.controller.run('recover-saved-session');
		const discard = harness.controller.run('discard-saved-session');
		expect(discard).toBe(recover);
		intent.resolve(null);
		await recover;
		expect(harness.ports.prepare).toHaveBeenCalledTimes(1);
	});

	it('sanitizes failures and never exposes the raw error', async () => {
		// `provisional` no longer offers any command (Lote S, 2026-09-09: it finalizes on its own).
		const harness = controllerHarness('complete');
		harness.ports.prepare.mockResolvedValue(async () => { throw new Error('raw secret-bearing detail'); });
		// `run()` rejects on a failed backend action (H15.2, 2026-09-10 incident) so the diagnostics
		// span wrapping it stops logging a false success; the sanitized notice still fires either way.
		await expect(harness.controller.run('clear-completed-session')).rejects.toThrow(SessionCommandBackendFailure);
		expect(harness.ports.notify).toHaveBeenCalledWith('The session action could not be completed.');
		expect(harness.ports.notify).not.toHaveBeenCalledWith(expect.stringContaining('raw'));
	});

	// H15.1 (2026-09-10 incident): a rejected backend action never rethrows past `flight()`, so
	// without this log call the button path left no local trace at all, even though it always
	// notified the player and always resolved to `'failed'`.
	it.each([
		['start-farming-session', 'idle', 'session_start'],
		['finish-farming-session', 'active', 'session_finish'],
	] as const)('logs a structured error record when %s rejects', async (id, status, action) => {
		const harness = controllerHarness(status);
		harness.ports.prepare.mockResolvedValue(async () => { throw new Error('Start failed.'); });

		await expect(harness.controller.runWithOutcome(id)).resolves.toBe('failed');

		expect(harness.ports.diagnostics.event).toHaveBeenCalledWith(expect.objectContaining({
			component: 'session',
			action,
			level: 'error',
			phase: 'failure',
			code: 'unknown_failure',
			details: { reason: 'Error' },
		}));
		const [record] = (harness.ports.diagnostics.event as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [Record<string, unknown>];
		expect(record.message).toBeUndefined();
		expect(record.stack).toBeUndefined();
	});

	it('dispose prevents a confirmed late intent from executing', async () => {
		const harness = controllerHarness('complete');
		const confirmation = deferred<(() => Promise<void>) | null>();
		const execute = vi.fn(async () => undefined);
		harness.ports.prepare.mockReturnValue(confirmation.promise);
		const run = harness.controller.run('clear-completed-session');
		await flush();
		harness.controller.dispose();
		confirmation.resolve(execute);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(harness.ports.notify).not.toHaveBeenCalled();
	});

	it('dispose before the execution microtask prevents opening an intent', async () => {
		const harness = controllerHarness('idle');
		const run = harness.controller.run('start-farming-session');
		harness.controller.dispose();
		await run;
		expect(harness.ports.prepare).not.toHaveBeenCalled();
		expect(harness.ports.notify).not.toHaveBeenCalled();
	});

	/**
	 * H15.2 (2026-09-10 incident): `main.ts` wraps `sessionCommands.run(id)` in exactly this shape
	 * (`localDebugActions.run({component:'session', action}, () => this.sessionCommands.run(id))`).
	 * Before `legacy` rejected, that outer span always saw a promise that settled, so it logged a
	 * false `success` for a start or stop that had just failed. This drives the real
	 * `LocalDebugActionRunner`/`LocalDebugLogger` stack over an in-memory writer, the way `main.ts`
	 * actually wires it, and reads back the persisted record.
	 */
	it('lets a real diagnostics span log the true failure instead of a false success', async () => {
		const storage = new MemoryDebugStorage();
		const writer = new LocalDebugJsonlWriter({ storage, directory: 'obsidian/plugins/tyrian-companion/logs' });
		const logger = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.31', writer });
		const runner = new LocalDebugActionRunner({ diagnostics: logger });
		const harness = controllerHarness('active');
		harness.ports.prepare.mockResolvedValue(async () => { throw new Error('Stop failed.'); });

		await expect(runner.run(
			{ component: 'session', action: 'session_finish' },
			async () => harness.controller.run('finish-farming-session'),
		)).rejects.toThrow();

		await logger.flush();
		const records = storage.records();
		const outer = records.filter((record) => record.action === 'session_finish');
		expect(outer).not.toHaveLength(0);
		expect(outer.every((record) => record.phase !== 'success')).toBe(true);
		expect(outer.some((record) => record.level === 'error' && record.phase === 'failure')).toBe(true);
	});
});

describe('session command adapters', () => {
	it('keeps checking pure and invokes only from a false checkCallback', () => {
		const specs: PaletteCommandSpec[] = [];
		const run = vi.fn(async () => undefined);
		registerSessionPalette(
			{ addCommand: (spec) => { specs.push(spec); } },
			{ describe: (id) => projectSessionCommands(context('idle')).find((command) => command.id === id)!, run },
			SESSION_COMMAND_IDS,
		);
		const start = specs.find((spec) => spec.id === 'start-farming-session')!;
		expect(start.checkCallback(true)).toBe(true);
		expect(run).not.toHaveBeenCalled();
		expect(start.checkCallback(false)).toBe(true);
		expect(run).toHaveBeenCalledWith('start-farming-session');
	});

	it('projects Open first, primary actions, separator, then destructive actions', () => {
		const recovery = { status: 'available', state: state('active') } as SessionRecoveryState;
		const menu = projectSessionMenu(projectSessionCommands(context('idle', { recovery })).filter((command) => command.available));
		expect(menu.map((entry) => entry.type === 'command' ? entry.command.id : entry.type)).toEqual([
			'open', 'separator', 'recover-saved-session', 'separator', 'discard-saved-session',
		]);
	});

	it('localizes the stable Open menu entry', () => {
		expect(projectSessionMenu([], 'es')[0]).toEqual({ type: 'open', title: 'Abrir acompañante', icon: 'compass' });
	});

	it('routes view recovery and discard actions through the same controller resource', async () => {
		const recovery = { status: 'available', state: identifiedState('active', 'session-a', 1) } as SessionRecoveryState;
		const harness = controllerHarness('idle', { recovery });
		const intent = deferred<(() => Promise<void>) | null>();
		harness.ports.prepare.mockReturnValue(intent.promise);
		const dispatch = createSessionCommandDispatch(harness.controller);
		const recover = dispatch.recover();
		const discard = dispatch.discard();
		expect(discard).toBe(recover);
		intent.resolve(null);
		await recover;
		expect(harness.ports.prepare).toHaveBeenCalledTimes(1);
	});

	it('routes view and palette finish through one shared controller flight', async () => {
		const harness = controllerHarness('active');
		const backend = deferred<void>();
		const execute = vi.fn(() => backend.promise);
		harness.ports.prepare.mockResolvedValue(execute);
		const dispatch = createSessionCommandDispatch(harness.controller);
		const fromView = dispatch.finish();
		const fromPalette = harness.controller.run('finish-farming-session');
		expect(fromPalette).toBe(fromView);
		await flush();
		expect(harness.ports.prepare).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
		backend.resolve();
		await fromView;
	});

	it('contains a failed finish backend, rejects and emits only fixed feedback', async () => {
		const harness = controllerHarness('active');
		harness.ports.prepare.mockResolvedValue(async () => { throw new Error('raw stop failure'); });
		// The rejection (H15.2, 2026-09-10 incident) is what lets a diagnostics span wrapping
		// `finish()` in `main.ts` log the real failure instead of a false success.
		await expect(createSessionCommandDispatch(harness.controller).finish()).rejects.toThrow(SessionCommandBackendFailure);
		expect(harness.ports.notify).toHaveBeenCalledTimes(1);
		expect(harness.ports.notify).toHaveBeenCalledWith('The session action could not be completed.');
	});

	it('accepts only exact backend success results', () => {
		expect(hasExactSessionBackendResult('recover', { status: 'recovered', state: state('active') })).toBe(true);
		expect(hasExactSessionBackendResult('recover', { status: 'busy' })).toBe(false);
		expect(hasExactSessionBackendResult('recover', { status: 'discarded' })).toBe(false);
		expect(hasExactSessionBackendResult('discard', { status: 'discarded' })).toBe(true);
		expect(hasExactSessionBackendResult('discard', { status: 'failed' })).toBe(false);
		expect(hasExactSessionBackendResult('discard', { status: 'recovered' })).toBe(false);
		expect(hasExactSessionBackendResult('clear', true)).toBe(true);
		expect(hasExactSessionBackendResult('clear', false)).toBe(false);
		expect(hasExactSessionBackendResult('clear', { status: 'cleared' })).toBe(false);
	});
});

function available(value: SessionCommandContext): string[] {
	return projectSessionCommands(value).filter((command) => command.available).map((command) => command.id);
}

function context(status: SessionState['status'], overrides: Partial<SessionCommandContext> = {}): SessionCommandContext {
	return { state: state(status), recovery: { status: 'none' }, connection: 'connected', stopFailure: null, ...overrides };
}

function state(status: SessionState['status']): SessionState {
	if (status === 'error') {
		return {
			version: 1, status, code: 'unexpected', failedAt: '2026-08-14T12:00:00.000Z',
			failedState: {
				version: 1, status: 'starting', sessionId: 'failed-session', requestedAt: '2026-08-14T11:59:00.000Z',
				authority: { machineId: 'machine', instanceId: 'instance', sessionId: 'failed-session', fence: 1, acquiredAt: 1 },
			},
		};
	}
	return { version: 1, status } as SessionState;
}

function identifiedState(
	status: 'active' | 'provisional' | 'complete',
	sessionId: string,
	fence: number,
): SessionState {
	return {
		version: 1,
		status,
		sessionId,
		authority: { machineId: 'machine', instanceId: 'instance', sessionId, fence, acquiredAt: 1 },
		baseline: { snapshotId: `before-${sessionId}` },
		...(status === 'provisional' || status === 'complete' ? { finalSnapshot: { snapshotId: `after-${sessionId}` } } : {}),
	} as SessionState;
}

function failure(): SessionStopFailure {
	return { code: 'snapshot_failed', message: 'Final snapshot failed.' };
}

function controllerHarness(initial: SessionState['status'], overrides: Partial<SessionCommandContext> = {}) {
	let current = context(initial, overrides);
	const diagnosticsEvent: LocalDebugActionPort['event'] = vi.fn();
	const ports = {
		getContext: vi.fn(() => current),
		prepare: vi.fn<SessionCommandPorts['prepare']>(async () => async () => undefined),
		notify: vi.fn(),
		diagnostics: {
			createContext: (ctx) => ({ ...ctx, actionId: 'a', correlationId: 'a' }),
			event: diagnosticsEvent,
		} satisfies LocalDebugActionPort,
	} satisfies SessionCommandPorts;
	return {
		ports,
		controller: new SessionCommandController(ports),
		setState: (status: SessionState['status']) => { current = context(status); },
		setContext: (next: Partial<SessionCommandContext>) => { current = { ...current, ...next }; },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/** Minimal in-memory `LocalDebugStoragePort` so a test can drive the real writer/logger/runner stack. */
class MemoryDebugStorage implements LocalDebugStoragePort {
	private readonly files = new Map<string, string>();

	async exists(path: string): Promise<boolean> { return this.files.has(path); }
	async read(path: string): Promise<string> { return this.files.get(path) ?? ''; }
	async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
	async append(path: string, data: string): Promise<void> { this.files.set(path, `${this.files.get(path) ?? ''}${data}`); }
	async mkdir(): Promise<void> { /* a single flat log file needs no directory bookkeeping here. */ }
	async remove(path: string): Promise<void> { this.files.delete(path); }
	async rename(path: string, destination: string): Promise<void> {
		const value = this.files.get(path);
		if (value === undefined) return;
		this.files.delete(path);
		this.files.set(destination, value);
	}

	/** Parses every retained JSONL line back into a record, in the order they were appended. */
	records(): LocalDebugRecordV1[] {
		return [...this.files.values()]
			.flatMap((content) => content.split('\n').filter((line) => line.length > 0))
			.map((line) => JSON.parse(line) as LocalDebugRecordV1);
	}
}
