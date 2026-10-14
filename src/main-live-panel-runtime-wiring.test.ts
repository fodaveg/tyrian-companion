// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LivePanelRuntime, type LivePanelSnapshot } from './runtime/live-panel-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * The core's side of the live panel note (14 oct 2026): the boot builds ONE writer from the live session and starts it, every
 * repaint tells it the view changed, and the unload stops it and waits for its final state. What it writes is in
 * `src/runtime/live-panel-runtime.test.ts`; what the note says is in `src/sessions/live-panel-note.test.ts`.
 */
interface Own {
	livePanel: LivePanelRuntime | null;
	collectorMode: string | undefined;
	localDebugActions: null;
	renderViews(): void;
}

describe('the core wires the live panel note', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it('builds and starts the writer once at the boot, tells it about every repaint and stops it at the unload', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as Own;
		own.localDebugActions = null;
		const start = vi.spyOn(LivePanelRuntime.prototype, 'start');
		const notify = vi.spyOn(LivePanelRuntime.prototype, 'notify');
		const stop = vi.spyOn(LivePanelRuntime.prototype, 'stop');
		expect(own.livePanel).toBeNull();

		await harness.initializeRuntime();
		expect(own.livePanel).toBeInstanceOf(LivePanelRuntime);
		expect(start).toHaveBeenCalledOnce();

		notify.mockClear();
		own.renderViews();
		expect(notify).toHaveBeenCalledOnce();

		await harness.shutdown();
		expect(stop).toHaveBeenCalledOnce();
		expect(own.livePanel).toBeNull();
	});

	it('tells the writer when the game magic find changes what it shows, and hands the figure to the snapshot', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as Own & { observeGameMagicFind(reading: { connectionId: string; value: number | null; observedAtMs: number }): void };
		own.localDebugActions = null;
		await harness.initializeRuntime();
		const notify = vi.spyOn(LivePanelRuntime.prototype, 'notify');
		const read = (): LivePanelSnapshot => (own.livePanel as unknown as { options: { read(): LivePanelSnapshot } }).options.read();
		expect(read().gameMagicFind).toBeNull();

		own.observeGameMagicFind({ connectionId: 'AQEBAQEBAQEBAQEBAQEBAQ', value: 363, observedAtMs: Date.now() });
		expect(notify).toHaveBeenCalledOnce();
		expect(read().gameMagicFind).toBe(363);
		// The same figure again (the addon's minute refresh) changes nothing the panel shows: no repaint.
		own.observeGameMagicFind({ connectionId: 'AQEBAQEBAQEBAQEBAQEBAQ', value: 363, observedAtMs: Date.now() });
		expect(notify).toHaveBeenCalledOnce();
		own.observeGameMagicFind({ connectionId: 'AQEBAQEBAQEBAQEBAQEBAQ', value: null, observedAtMs: Date.now() });
		expect(notify).toHaveBeenCalledTimes(2);
		expect(read().gameMagicFind).toBeNull();
		await harness.shutdown();
	});

	it('writes nothing from a device with no session, in consult or as collector', async () => {
		for (const mode of ['consult', 'collector']) {
			harness = createRuntimeHarness();
			const own = harness.core as unknown as Own;
			own.localDebugActions = null;
			own.collectorMode = mode;
			await harness.initializeRuntime();
			own.renderViews();
			await harness.shutdown();
			expect(harness.vaultWrites().filter((write) => write.path.endsWith('Live panel.md'))).toEqual([]);
			harness.dispose();
			harness = null;
		}
	});
});
