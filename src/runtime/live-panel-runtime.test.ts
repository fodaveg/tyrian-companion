import { describe, expect, it } from 'vitest';

import { emptyLiveSessionView } from '../sessions/live-session-lifecycle';
import type { LiveSessionLootState } from '../sessions/live-session-loot';
import type { LiveSessionAlertViewV1, LiveSessionViewV1 } from '../sessions/live-session-model';
import { renderLivePanelEmptyNote } from '../sessions/live-panel-note';
import type { CollectorStatusVault } from './collector-status';
import {
	LIVE_PANEL_TICK_MS,
	LIVE_PANEL_WRITE_FLOOR_MS,
	LivePanelRuntime,
	livePanelSnapshot,
	type LivePanelRuntimeOptions,
	type LivePanelSnapshot,
} from './live-panel-runtime';

const ROOT = 'Games/Tyrian Companion';
const NOTE = `${ROOT}/Live panel.md`;
const START = new Date(2026, 9, 31, 18, 0, 0).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

function activeView(nowMs: number, patch: Partial<LiveSessionViewV1> = {}): LiveSessionViewV1 {
	const base = emptyLiveSessionView();
	return {
		...base, sessionId: 's1', phase: 'active', connection: 'connected', sourceState: 'ready', sourceReason: null, source: 'nexus_inventory',
		startedAt: iso(START), elapsedMs: nowMs - START, observedItemsMs: 20 * 60_000, lastObservationAt: iso(nowMs), itemCoverage: 'complete',
		valuation: { ...base.valuation, capturedAt: iso(START), knownNetValueCopper: 50_000, netItemValueKnownCopper: 40_000, coinNetCopper: 10_000 },
		...patch,
	};
}

function snapshot(view: LiveSessionViewV1): LivePanelSnapshot {
	return { view, valueCopper: view.valuation.knownNetValueCopper ?? 0, ratePerHourCopper: 150_000, loot: [{ itemId: 24358, name: 'Hueso', quantity: 3, totalCopper: 300 }], lastDrop: null };
}

function memoryVault(initial: Record<string, string> = {}) {
	const notes = new Map(Object.entries(initial));
	const folders = new Set<string>();
	const writes: string[] = [];
	const touches: string[] = [];
	const failure: { create: Error | null } = { create: null };
	const vault: CollectorStatusVault = {
		file: (path) => notes.has(path) || folders.has(path) ? { path } : null,
		read: async (file) => notes.get(file.path) ?? '',
		process: async (file, update) => {
			touches.push(file.path);
			const next = update(notes.get(file.path) ?? '');
			if (next !== notes.get(file.path)) writes.push(file.path);
			notes.set(file.path, next);
			return next;
		},
		create: async (path, content) => {
			if (failure.create !== null) throw failure.create;
			touches.push(path); notes.set(path, content); writes.push(path); return { path };
		},
		createFolder: async (path) => { folders.add(path); },
	};
	return { vault, notes, folders, writes, touches, failure };
}

function setup(overrides: Partial<LivePanelRuntimeOptions> = {}, initial: Record<string, string> = {}) {
	const store = memoryVault(initial);
	const clock = { now: START + 5 * 60_000 };
	const state = { view: activeView(clock.now), enabled: true, collector: true, throwOnRead: false };
	const timeouts = new Map<number, { callback: () => void; at: number }>();
	const runs: Array<Promise<void>> = [];
	let next = 1;
	const options: LivePanelRuntimeOptions = {
		vault: store.vault, root: () => ROOT, enabled: () => state.enabled, collector: () => state.collector, locale: () => 'es',
		read: () => { if (state.throwOnRead) throw new Error('boom'); return snapshot(state.view); },
		now: () => clock.now,
		setTimeout: (callback, delayMs) => { const id = next++; timeouts.set(id, { callback, at: clock.now + delayMs }); return id; },
		clearTimeout: (id) => { timeouts.delete(id); },
		run: (write) => {
			const running = write();
			// The host's diagnostics own a rejection; the test only keeps the promise to look at how it ended.
			running.catch(() => undefined);
			runs.push(running);
		},
		...overrides,
	};
	const panel = new LivePanelRuntime(options);
	/** Advances the clock, fires the timeouts that come due and waits for the writes they start. */
	const advance = async (ms: number): Promise<PromiseSettledResult<void>[]> => {
		clock.now += ms;
		for (const [id, timer] of [...timeouts]) if (timer.at <= clock.now) { timeouts.delete(id); timer.callback(); }
		const settled = await Promise.allSettled(runs.splice(0));
		return settled;
	};
	return { panel, store, clock, state, timeouts, runs, advance };
}

describe('LivePanelRuntime', () => {
	it('creates the note on the first look and does not rewrite an unchanged text', async () => {
		const t = setup();
		t.panel.start();
		await t.advance(0);
		expect(t.store.writes).toEqual([NOTE]);
		expect(t.store.folders.has(ROOT)).toBe(true);
		expect(t.store.notes.get(NOTE)).toContain('tc_kind: gw2_live_panel');
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toEqual([NOTE]);
		expect(t.store.touches).toEqual([NOTE]);
	});

	it('writes at most once per floor, folding the changes in between into one write', async () => {
		const t = setup();
		t.panel.start();
		await t.advance(0);
		t.state.view = activeView(t.clock.now, { valuation: { ...t.state.view.valuation, knownNetValueCopper: 60_000 } });
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS - 1_000);
		expect(t.store.writes).toHaveLength(1);
		t.state.view = activeView(t.clock.now, { valuation: { ...t.state.view.valuation, knownNetValueCopper: 70_000 } });
		t.panel.notify();
		await t.advance(1_000);
		expect(t.store.writes).toHaveLength(2);
		expect(t.store.notes.get(NOTE)).toContain('# 7g 0s 0c');
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toHaveLength(2);
	});

	it('writes a change of the game magic find under the same floor as a new bag, and its loss back to the account figure', async () => {
		const game: { value: number | null } = { value: null };
		const t = setup({ read: () => ({ ...snapshot(t.state.view), gameMagicFind: game.value }) });
		t.panel.start();
		await t.advance(0);
		expect(t.store.notes.get(NOTE)).not.toContain('tc_live_mf_src: game');
		game.value = 363;
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS - 1_000);
		expect(t.store.writes).toHaveLength(1);
		await t.advance(1_000);
		expect(t.store.writes).toHaveLength(2);
		expect(t.store.notes.get(NOTE)).toContain('\ntc_live_mf: 363\ntc_live_mf_src: game\n');
		game.value = null;
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toHaveLength(3);
		expect(t.store.notes.get(NOTE)).not.toContain('tc_live_mf_src: game');
	});

	it('costs at most one write a minute while connected with nothing new: only the minute-level text moves', async () => {
		const t = setup();
		t.panel.start();
		await t.advance(0);
		const base = t.clock.now;
		// Fifty seconds later the view only has other seconds (duration and last reading inside the same minutes).
		t.clock.now = base + 40_000;
		t.state.view = activeView(base, { elapsedMs: 5 * 60_000 + 40_000 });
		await t.advance(LIVE_PANEL_TICK_MS);
		expect(t.store.writes).toHaveLength(1);
		expect(t.store.touches).toHaveLength(1);
		// A minute later the duration moved on: one write.
		t.state.view = activeView(base, { elapsedMs: 6 * 60_000 + 10_000 });
		await t.advance(LIVE_PANEL_TICK_MS);
		expect(t.store.writes).toHaveLength(2);
	});

	it('never writes from a consult device or with the setting off, and starts clean when it comes back', async () => {
		const t = setup();
		t.state.collector = false;
		t.panel.start();
		await t.advance(0);
		expect(t.timeouts.size).toBe(0);
		t.state.enabled = false;
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toEqual([]);
		t.state.enabled = true; t.state.collector = true;
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toEqual([NOTE]);
	});

	it('leaves a note at that path that is not a live panel note exactly as it is', async () => {
		const own = '---\ntitle: mine\n---\nMy notes about farming.\n';
		const t = setup({}, { [NOTE]: own });
		t.panel.start();
		await t.advance(0);
		t.state.view = activeView(t.clock.now, { elapsedMs: 9 * 60_000 });
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.notes.get(NOTE)).toBe(own);
		expect(t.store.writes).toEqual([]);
	});

	it('records a failed write through the host and keeps going: the next change writes', async () => {
		const t = setup();
		t.store.failure.create = new Error('disk full');
		t.panel.start();
		const settled = await t.advance(0);
		expect(settled).toHaveLength(1);
		expect(settled[0]!.status).toBe('rejected');
		expect(t.store.writes).toEqual([]);
		t.store.failure.create = null;
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toEqual([NOTE]);
		// A reading that throws is reported the same way and does not stop the timers.
		t.state.throwOnRead = true;
		t.panel.notify();
		const failed = await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(failed[0]!.status).toBe('rejected');
		t.state.throwOnRead = false;
		t.state.view = activeView(t.clock.now, { elapsedMs: 30 * 60_000 });
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toHaveLength(2);
	});

	it('leaves a finished session as ended, and keeps it ended once the session is cleared', async () => {
		const t = setup();
		t.panel.start();
		await t.advance(0);
		t.state.view = activeView(t.clock.now, { phase: 'complete', connection: 'disconnected', sourceState: 'unavailable', endedAt: iso(t.clock.now) });
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		const ended = t.store.notes.get(NOTE)!;
		expect(ended).toContain('tc_live_state: ended');
		expect(ended).toContain('Sesión terminada');
		t.state.view = emptyLiveSessionView();
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.notes.get(NOTE)).toBe(ended);
		expect(t.store.writes).toHaveLength(2);
	});

	it('leaves a session cleared before the run saw it end as ended, from the last thing it saw', async () => {
		const t = setup();
		t.panel.start();
		await t.advance(0);
		t.state.view = emptyLiveSessionView();
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.notes.get(NOTE)).toContain('tc_live_state: ended');
	});

	it('creates nothing without a session, replaces a note left mid-session and respects an ended one', async () => {
		const idle = setup();
		idle.state.view = emptyLiveSessionView();
		idle.panel.start();
		await idle.advance(0);
		expect(idle.store.writes).toEqual([]);
		expect(idle.store.notes.has(NOTE)).toBe(false);

		const midSession = setup({}, { [NOTE]: setup().store.notes.get(NOTE) ?? '---\ntc_kind: gw2_live_panel\ntc_live_state: live\n---\n# Tyrian en vivo\n' });
		midSession.state.view = emptyLiveSessionView();
		midSession.panel.start();
		await midSession.advance(0);
		expect(midSession.store.notes.get(NOTE)).toBe(renderLivePanelEmptyNote('es'));

		const endedNote = '---\ntc_kind: gw2_live_panel\ntc_live_state: ended\n---\n# Tyrian en vivo\n\nSesión terminada 18:50 · valor final 1g 0s 0c\n';
		const finished = setup({}, { [NOTE]: endedNote });
		finished.state.view = emptyLiveSessionView();
		finished.panel.start();
		await finished.advance(0);
		expect(finished.store.notes.get(NOTE)).toBe(endedNote);
		expect(finished.store.writes).toEqual([]);
	});

	it('writes the final state on stop, ignoring the floor, then stops for good', async () => {
		const t = setup();
		t.panel.start();
		await t.advance(0);
		const before = t.store.writes.length;
		const stopping = t.panel.stop();
		await Promise.allSettled(t.runs.splice(0));
		await stopping;
		expect(t.store.writes).toHaveLength(before + 1);
		expect(t.store.notes.get(NOTE)).toContain('tc_live_state: disconnected');
		expect(t.timeouts.size).toBe(0);
		t.state.view = activeView(t.clock.now, { elapsedMs: 50 * 60_000 });
		t.panel.notify();
		await t.advance(LIVE_PANEL_WRITE_FLOOR_MS);
		expect(t.store.writes).toHaveLength(before + 1);
	});

	it('does not reject on stop when the final write fails', async () => {
		const t = setup();
		t.store.failure.create = new Error('disk full');
		const stopping = t.panel.stop();
		await Promise.allSettled(t.runs.splice(0));
		await expect(stopping).resolves.toBeUndefined();
	});
});

describe('livePanelSnapshot', () => {
	const view = activeView(START);
	const alert = (id: string, observedAt: string, itemId: number, skipReason: LiveSessionAlertViewV1['skipReason']): LiveSessionAlertViewV1 => ({
		id, outboxId: id, observedAt, itemId, quantity: 2, totalCopper: 90_000, state: 'processed', skipReason, sentTo: [], receipt: null, deliveryReport: null,
	});
	const loot: LiveSessionLootState = {
		status: 'observing', sessionId: 's1', restored: false, knownTotalCopper: 0, sackQuantity: 4, observedSackGains: 7, hasUnknownValue: false,
		updatedAt: null, error: null, rows: [{ itemId: 9, name: 'Pico', quantity: 1, unitCopper: 1, totalCopper: 1, priceStatus: 'known' }],
	};

	it('takes the latest alert that was not skipped, naming it from the entity cache, then the loot rows, then the id', () => {
		const alerts = [alert('a', iso(START + 60_000), 9, null), alert('b', iso(START + 120_000), 77, 'below_threshold'), alert('c', iso(START + 30_000), 5, null)];
		const named = livePanelSnapshot({ locale: 'es', view, alerts, loot, itemName: (id) => id === 9 ? 'Pico encantado' : null });
		expect(named.lastDrop).toEqual({ itemId: 9, name: 'Pico encantado', quantity: 2, totalCopper: 90_000, observedAt: iso(START + 60_000) });
		expect(livePanelSnapshot({ locale: 'es', view, alerts, loot, itemName: () => null }).lastDrop?.name).toBe('Pico');
		expect(livePanelSnapshot({ locale: 'en', view, alerts: [alerts[2]!], loot, itemName: () => null }).lastDrop?.name).toBe('Item 5');
		expect(livePanelSnapshot({ locale: 'es', view, alerts: [alerts[1]!], loot, itemName: () => null }).lastDrop).toBeNull();
	});

	it('carries the loot rows with their item ids, and none while the loot tracker is idle', () => {
		expect(livePanelSnapshot({ locale: 'es', view, alerts: [], loot, itemName: () => null }).loot).toEqual([{ itemId: 9, name: 'Pico', quantity: 1, totalCopper: 1, icon: null }]);
		const idle = livePanelSnapshot({ locale: 'es', view, alerts: [], loot: { status: 'idle' }, itemName: () => null });
		expect(idle.loot).toEqual([]);
	});
});
