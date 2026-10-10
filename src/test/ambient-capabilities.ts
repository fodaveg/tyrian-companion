import { vi } from 'vitest';

/**
 * Ambient capabilities a review-only module must never reach for. Each one is replaced by a trap
 * that records the access and throws, so a test can assert the absence by execution instead of by
 * grepping the source of the module under test.
 */
export const AMBIENT_CAPABILITIES = [
	'fetch', 'requestUrl', 'XMLHttpRequest', 'WebSocket',
	'EventSource', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback',
	'indexedDB', 'localStorage', 'sessionStorage', 'app',
];

/**
 * Trapped only on request: `fake-indexeddb` schedules its work with `setImmediate`, so a test that
 * runs through it cannot trap it, while a pure module's test should.
 */
export const NODE_TIMER_CAPABILITIES = ['setImmediate'];

/** Runs `work` with every ambient capability trapped (plus `extra`) and returns the accesses it made. */
export async function ambientCapabilityUse(work: () => unknown, extra: readonly string[] = []): Promise<string[]> {
	const used: string[] = [];
	for (const name of [...AMBIENT_CAPABILITIES, ...extra]) vi.stubGlobal(name, ambientTrap(name, used));
	try {
		await work();
	} finally {
		vi.unstubAllGlobals();
	}
	return used;
}

function ambientTrap(name: string, used: string[]): unknown {
	return new Proxy(() => undefined, {
		apply: () => { used.push(`${name}()`); throw new Error(`${name} is not available in a review-only module.`); },
		get: (_target, key) => {
			used.push(`${name}.${String(key)}`);
			throw new Error(`${name} is not available in a review-only module.`);
		},
	});
}
