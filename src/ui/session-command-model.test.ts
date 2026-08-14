import { describe, expect, it, vi } from 'vitest';

import type { SessionRecoveryState, SessionStopFailure } from '../sessions/manual-session-start-service';
import type { SessionState } from '../sessions/session';
import { SessionCommandController, type SessionCommandPorts } from './session-command-controller';
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
		['provisional', ['review-session']],
		['complete', ['clear-completed-session']],
		['error', []],
	] as const)('projects commands for %s', (status, expected) => {
		expect(available(context(status))).toEqual(expected);
	});

	it('requires a visible stop failure before retrying stopping', () => {
		expect(available(context('stopping', { stopFailure: failure() }))).toEqual(['finish-farming-session']);
	});

	it.each(['idle', 'error'] as const)('does not offer active-session cancel in %s', (status) => {
		expect(projectSessionCommands(context(status)).map((command) => command.id)).not.toContain('cancel-session');
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

	it.each(['working', 'error'] as const)('fails closed while recovery is %s', (status) => {
		const recovery = status === 'working'
			? { status, action: 'recover', state: state('active') }
			: { status, message: 'Failed.' };
		expect(available(context('idle', { recovery: recovery as SessionRecoveryState }))).toEqual([]);
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

	it.each([
		['review-session', 'provisional'],
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
		const harness = controllerHarness('provisional');
		harness.ports.prepare.mockResolvedValue(async () => { throw new Error('raw secret-bearing detail'); });
		await harness.controller.run('review-session');
		expect(harness.ports.notify).toHaveBeenCalledWith('The session action could not be completed.');
		expect(harness.ports.notify).not.toHaveBeenCalledWith(expect.stringContaining('raw'));
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

	it('contains a failed finish backend and emits only fixed feedback', async () => {
		const harness = controllerHarness('active');
		harness.ports.prepare.mockResolvedValue(async () => { throw new Error('raw stop failure'); });
		await expect(createSessionCommandDispatch(harness.controller).finish()).resolves.toBeUndefined();
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
	const ports = {
		getContext: vi.fn(() => current),
		prepare: vi.fn<SessionCommandPorts['prepare']>(async () => async () => undefined),
		notify: vi.fn(),
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
