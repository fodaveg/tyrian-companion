// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { IngameSessionRuntime } from './runtime/ingame-session-runtime';
import { IngameSessionMarker } from './sessions/ingame-session-marker';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, ninth wave: the core's side of `IngameSessionRuntime`. Each delegate of the core reaches the
 * runtime once, with the caller's arguments, and returns what the runtime returned; the sibling
 * runtimes' ports reach it too, and its own port reads the core's fields as they stand and writes the
 * marker back to the core's own field. The secret of the bridge is not here: it stays in the core
 * (`src/main-alert-runtime-wiring.test.ts`, `src/main-ingame-secret-copy.test.ts`).
 */
type Reached = 'startIngameSession' | 'getIngameSessionLink' | 'recordIngameSessionFailure' | 'ingameSessionView';
type Core = Record<string, (...args: unknown[]) => unknown>;
type Ports = Record<'alerts' | 'farming' | 'commands', { port: Core }>;

const FAILURE = new TypeError('storage refused');
/** The core's one-line delegates: name in the core, name in the runtime, the caller's arguments. */
const DELEGATES: ReadonlyArray<readonly [core: string, runtime: Reached, args: readonly unknown[]]> = [
	['startIngameSession', 'startIngameSession', ['Astra Uno']],
	['getIngameSessionLink', 'getIngameSessionLink', ['session-a']],
];
/** The sibling runtimes' ports that reach it: whose port, the member, the runtime method, the arguments. */
const ROUTES: ReadonlyArray<readonly [owner: keyof Ports, member: string, runtime: Reached, args: readonly unknown[]]> = [
	['alerts', 'startIngameSession', 'startIngameSession', ['Astra Uno']],
	['alerts', 'recordIngameSessionFailure', 'recordIngameSessionFailure', [FAILURE]],
	['farming', 'recordIngameSessionFailure', 'recordIngameSessionFailure', [FAILURE]],
	['commands', 'startIngameSession', 'startIngameSession', ['Astra Uno']],
	['commands', 'ingameSessionView', 'ingameSessionView', []],
];

interface Own {
	ingame: IngameSessionRuntime;
	ingameSessionMarker: IngameSessionMarker | null;
	collectorMode: string | undefined;
	settings: { alertIngameEnabled: boolean };
	localDebugActions: null;
}

describe('the core hands the in-game session to IngameSessionRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(DELEGATES)('%s reaches IngameSessionRuntime.%s once, with its arguments, and returns what it returned', (name, target, args) => {
		harness = createRuntimeHarness();
		const answer = Symbol(name);
		const reached = vi.spyOn(IngameSessionRuntime.prototype, target).mockReturnValue(answer as never);

		const result = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(result).toBe(answer);
	});

	it.each(ROUTES)('the %s port\'s %s reaches IngameSessionRuntime.%s once, with its arguments', (owner, member, target, args) => {
		harness = createRuntimeHarness();
		const answer = Symbol(member);
		const reached = vi.spyOn(IngameSessionRuntime.prototype, target).mockReturnValue(answer as never);

		(harness.core as unknown as Ports)[owner].port[member]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
	});

	it('the boot builds the marker into the core\'s own field, which the other runtimes read, and a second start keeps it', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as Own;
		own.localDebugActions = null;
		expect(own.ingameSessionMarker).toBeNull();

		await harness.initializeRuntime();
		const built = own.ingameSessionMarker;
		own.ingame.startIngameSessionMarking();

		expect(built).toBeInstanceOf(IngameSessionMarker);
		expect(own.ingameSessionMarker).toBe(built);
	});

	it('the port reads the bridge setting and the device\'s mode as they stand, not as they were when the marker was built', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as Own;
		own.localDebugActions = null;
		await harness.initializeRuntime();
		const enabled = (): boolean => (own.ingameSessionMarker as unknown as { options: { port: { enabled(): boolean } } }).options.port.enabled();

		own.collectorMode = 'collector';
		const before = enabled();
		own.settings.alertIngameEnabled = true;
		const switchedOn = enabled();
		own.collectorMode = 'consult';
		const consulting = enabled();

		expect({ before, switchedOn, consulting }).toEqual({ before: false, switchedOn: true, consulting: false });
	});

	it('the link is read from the host\'s local storage the core holds, and a refusal reaches the core\'s diagnostics by error class only', () => {
		harness = createRuntimeHarness();
		const app = harness.plugin.app as unknown as { loadLocalStorage?: (key: string) => unknown };
		app.loadLocalStorage = () => { throw FAILURE; };
		const read = (): unknown => (harness!.core as unknown as { ingame: { readIngameSessionLink(): unknown } }).ingame.readIngameSessionLink();

		expect(read()).toBeNull();
		expect(harness.diagnostics()).toEqual([expect.objectContaining({
			component: 'session', action: 'session_start', state: 'ingame_presence',
			level: 'error', phase: 'failure', code: 'internal_failure', details: { errorName: 'TypeError' },
		})]);
		app.loadLocalStorage = (key) => ({ key });
		expect(read()).toEqual({ key: 'tyrian-companion:ingame-session-link' });
	});
});
