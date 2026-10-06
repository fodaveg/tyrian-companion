import { describe, expect, it, vi } from 'vitest';
import type { SessionRecoveryState } from '../sessions/manual-session-start-service';
import type { SessionState } from '../sessions/session';
import { liveSessionControl, oldSessionBlocksStart, type LiveSessionControlSource } from './live-session-control';
import type { ProductActionController, ProductActionDescriptor } from './product-action-controller';

const idle = { version: 1, status: 'idle' } as SessionState;
const status = (value: string): SessionState => ({ version: 1, status: value }) as unknown as SessionState;
const recovery = (value: string): SessionRecoveryState => ({ status: value }) as unknown as SessionRecoveryState;

describe('which old session blocks a new live one', () => {
	// Measured on `ingameSessionView().canStart` and `startIngameSession` in the core: with no live
	// runtime only a busy/working/unreadable recovery or an unfinished legacy session refuse the start.
	it.each([
		['no old state', idle, recovery('none'), false],
		['a recovery that is only available', idle, recovery('available'), false],
		['a finished legacy session', status('complete'), recovery('none'), false],
		['an abandoned legacy session', status('abandoned'), recovery('none'), false],
		['a recovery whose owner is still alive', idle, recovery('busy'), true],
		['a recovery being worked on', idle, recovery('working'), true],
		['an unreadable recovery', idle, recovery('error'), true],
		['a legacy session still active', status('active'), recovery('none'), true],
		['a legacy session stopping', status('stopping'), recovery('none'), true],
		['a legacy session in error', status('error'), recovery('none'), true],
	])('with no live runtime: %s', (_name, session, rec, blocks) => {
		expect(oldSessionBlocksStart({ phase: 'idle' }, session, rec)).toBe(blocks);
	});

	it('never blocks once a live runtime exists: the core then decides on the live session alone', () => {
		for (const phase of ['active', 'complete', 'starting', 'stopping', 'error'] as const) {
			expect(oldSessionBlocksStart({ phase }, status('active'), recovery('error'))).toBe(false);
		}
	});
});

function descriptor(id: string, patch: Partial<ProductActionDescriptor> = {}): ProductActionDescriptor {
	return { id, available: false, state: 'idle', ...patch } as unknown as ProductActionDescriptor;
}
function source(overrides: Partial<LiveSessionControlSource> & { run?: (id: string) => Promise<string>; describe?: (id: string) => ProductActionDescriptor } = {}) {
	const run = vi.fn(overrides.run ?? (async () => 'completed'));
	const describe = overrides.describe ?? ((id: string) => descriptor(id));
	const controller = { run, describe } as unknown as ProductActionController;
	const value: LiveSessionControlSource = {
		getProductActionController: () => controller,
		getIngamePresence: () => ({ status: 'present' }) as never,
		getCollectorMode: () => 'collector',
		getSessionState: () => idle, getSessionRecoveryState: () => recovery('none'), ...overrides };
	return { value, run };
}
const view = () => ({ phase: 'idle' }) as never;

describe('the one button reaches the product actions that already exist', () => {
	it('reads availability, busy, consult, presence and the old-session rule from the shared controller and the core', () => {
		const { value } = source({
			describe: (id) => id === 'start-farming-session' ? descriptor(id, { available: true })
				: id === 'discard-saved-session' ? descriptor(id, { available: true }) : descriptor(id, { state: 'running' }),
			getSessionRecoveryState: () => recovery('error'),
		});
		expect(liveSessionControl(value, view).getLiveSessionControl()).toEqual({
			gameConnected: true, consult: false, canStart: true, canStop: false, busy: 'stop', oldSession: { canDiscard: true } });
		const away = source({ getIngamePresence: () => ({ status: 'lost' }) as never, getCollectorMode: () => 'consult' });
		expect(liveSessionControl(away.value, view).getLiveSessionControl()).toMatchObject({ gameConnected: false, consult: true, oldSession: null });
	});

	it('starts, finishes and discards through run(); only a rejection is a failure, never unavailable or cancelled', async () => {
		const { value, run } = source();
		const control = liveSessionControl(value, view);
		await control.startLiveSession(); await control.stopLiveSession(); await control.discardOldSession();
		expect(run.mock.calls.map(([id]) => id)).toEqual(['start-farming-session', 'finish-farming-session', 'discard-saved-session']);
		for (const outcome of ['unavailable', 'cancelled']) {
			const quiet = source({ run: async () => outcome });
			await expect(liveSessionControl(quiet.value, view).startLiveSession()).resolves.toBeUndefined();
			await expect(liveSessionControl(quiet.value, view).stopLiveSession()).resolves.toBeUndefined();
		}
		const failing = source({ run: async () => { throw new Error('boom'); } });
		await expect(liveSessionControl(failing.value, view).stopLiveSession()).rejects.toThrow('boom');
		await expect(liveSessionControl({ ...value, getProductActionController: undefined }, view).startLiveSession()).rejects.toThrow();
	});
});
