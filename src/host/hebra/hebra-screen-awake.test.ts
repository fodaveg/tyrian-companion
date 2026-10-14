// @vitest-environment happy-dom
import type { PluginMainViewDefinition, PluginUi } from 'hebra-plugin-api';
import { describe, expect, it, vi } from 'vitest';

import type { TyrianSectionsViewRegistration, TyrianViewSectionRegistration } from '../tyrian-host';
import { registerHebraMainView } from './hebra-main-view';
import { createScreenAwake, screenAwakeViewId } from './hebra-screen-awake';

// Hebra's `screen.awake` (API 1.8, provisional) through the adapter. The pinned types do not have
// it, so the api here is hand-made and only has what the adapter touches.

function apiWith(options: { has?: ((name: string) => boolean) | 'missing'; keepScreenOn?: ((id: string, on: boolean) => Promise<{ held: boolean }>) | 'missing' }) {
	const calls: Array<[string, boolean]> = [];
	const keepScreenOn = options.keepScreenOn ?? (async (id: string, on: boolean) => { calls.push([id, on]); return { held: on }; });
	const ui = keepScreenOn === 'missing' ? {} : { keepScreenOn: (id: string, on: boolean) => { if (options.keepScreenOn === undefined) return keepScreenOn(id, on); calls.push([id, on]); return keepScreenOn(id, on); } };
	const api = {
		...(options.has === 'missing' ? {} : { has: options.has ?? ((name: string) => name === 'screen.awake') }),
		ui,
	};
	return { api: api as never, calls };
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('createScreenAwake', () => {
	it('asks on once and does not repeat it; releases once and does not release what is not held', () => {
		const { api, calls } = apiWith({});
		const awake = createScreenAwake(api, vi.fn());
		awake.request('v', false);
		awake.request('v', true);
		awake.request('v', true);
		awake.request('v', false);
		awake.request('v', false);
		expect(calls).toEqual([[screenAwakeViewId('v'), true], [screenAwakeViewId('v'), false]]);
	});

	it('calls nothing when has("screen.awake") is false, when has is missing, or when it throws (the throw is reported)', () => {
		const report = vi.fn();
		for (const has of [() => false, 'missing' as const, () => { throw new Error('boom'); }]) {
			const { api, calls } = apiWith({ has });
			createScreenAwake(api, report).request('v', true);
			expect(calls).toEqual([]);
		}
		expect(report).toHaveBeenCalledTimes(1);
	});

	it('reports, without throwing, a keepScreenOn that is missing, throws or rejects, and asks again after a failure', async () => {
		const report = vi.fn();
		const missing = apiWith({ keepScreenOn: 'missing' });
		expect(() => createScreenAwake(missing.api, report).request('v', true)).not.toThrow();
		expect(report).toHaveBeenCalledTimes(1);

		const throwing = apiWith({ keepScreenOn: () => { throw new Error('sync'); } });
		expect(() => createScreenAwake(throwing.api, report).request('v', true)).not.toThrow();
		expect(report).toHaveBeenCalledTimes(2);

		const rejecting = apiWith({ keepScreenOn: () => Promise.reject(new Error('async')) });
		const awake = createScreenAwake(rejecting.api, report);
		awake.request('v', true);
		await flush();
		expect(report).toHaveBeenCalledTimes(3);
		awake.request('v', true);
		expect(rejecting.calls).toEqual([['v', true], ['v', true]]);
		await flush();
	});
});

function section(id: string, overrides: Partial<TyrianViewSectionRegistration> = {}): TyrianViewSectionRegistration {
	return { id, title: () => id, icon: 'x', mount: () => undefined, unmount: () => undefined, ...overrides };
}

function mainView(unregister = vi.fn()) {
	const held: { definition?: PluginMainViewDefinition } = {};
	const ui = { registerView: (def: PluginMainViewDefinition) => { held.definition = def; return unregister; } } as unknown as PluginUi;
	const view: TyrianSectionsViewRegistration = {
		type: 'tyrian-main-view', title: () => 'T', icon: 'sword',
		sections: [section('session'), section('live', { keepScreenAwake: true })],
	};
	const { api, calls } = apiWith({});
	const report = vi.fn();
	const off = registerHebraMainView({
		ui, lane: () => (step) => { void step(); }, report, screenAwake: createScreenAwake(api, report),
	}, view);
	const mount = (id: string) => {
		const handle = held.definition!.mountSection(document.createElement('div'), id);
		return handle as unknown as { unmount(): void; onVisibilityChange(visible: boolean): void };
	};
	return { mount, calls, report, off, unregister };
}

describe('the live section on the main view', () => {
	it('asks on when it is mounted and off when it is hidden, shown again, unmounted', () => {
		const { mount, calls } = mainView();
		const live = mount('live');
		live.onVisibilityChange(false);
		live.onVisibilityChange(false);
		live.onVisibilityChange(true);
		live.unmount();
		expect(calls).toEqual([['tyrian-main-view', true], ['tyrian-main-view', false], ['tyrian-main-view', true], ['tyrian-main-view', false]]);
	});

	it('asks nothing for the other sections', () => {
		const { mount, calls } = mainView();
		const session = mount('session');
		session.onVisibilityChange(false);
		session.onVisibilityChange(true);
		session.unmount();
		expect(calls).toEqual([]);
	});

	it('releases when the whole view is taken away, once', () => {
		const { mount, calls, off, unregister } = mainView();
		mount('live');
		off();
		off();
		expect(unregister).toHaveBeenCalled();
		expect(calls).toEqual([['tyrian-main-view', true], ['tyrian-main-view', false]]);
	});
});
