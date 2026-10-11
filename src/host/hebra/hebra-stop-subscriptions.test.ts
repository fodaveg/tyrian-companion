// @vitest-environment happy-dom
import type { HebraPluginApi } from 'hebra-plugin-api';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { createTyrianRuntime } from '../../runtime/tyrian-companion-core';
import { createTyrianTestApi, hebraSettingsKey } from '../../test/hebra-plugin-fakes';
import { activateTyrian } from './hebra-runtime';

describe('Hebra: what the core subscribes outside api.ui does not survive the stop (Z6-2)', () => {
	it('removes the window error listeners and the environment subscriptions on stop', async () => {
		const test = createTyrianTestApi({ mainView: false });
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({ outputFolder: 'Tyrian Companion' }));
		const live = new Map<string, Set<unknown>>();
		const win = Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
			addEventListener: (type: string, listener: unknown) => { (live.get(type) ?? live.set(type, new Set()).get(type)!).add(listener); },
			removeEventListener: (type: string, listener: unknown) => { live.get(type)?.delete(listener); },
		});
		const subscriptions = { online: 0, visibility: 0 };
		const env = Object.assign(Object.create(test.api.env) as HebraPluginApi['env'], {
			onOnlineChange: () => { subscriptions.online += 1; return () => { subscriptions.online -= 1; }; },
			onVisibilityChange: () => { subscriptions.visibility += 1; return () => { subscriptions.visibility -= 1; }; },
		});
		const api: HebraPluginApi = { ...test.api, env };
		const stop = await activateTyrian(api, { indexedDB: new IDBFactory(), window: win, document, createRuntime: (host) => createTyrianRuntime(host) });
		await new Promise((resolve) => { window.setTimeout(resolve, 50); });
		// The core subscribed to all three while it ran.
		expect(live.get('error')?.size ?? 0).toBeGreaterThan(0);
		expect(subscriptions).toEqual({ online: 1, visibility: 1 });
		await stop();
		expect(live.get('error')?.size ?? 0).toBe(0);
		expect(live.get('unhandledrejection')?.size ?? 0).toBe(0);
		expect(subscriptions).toEqual({ online: 0, visibility: 0 });
	}, 30_000);
});
