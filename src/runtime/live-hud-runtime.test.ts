import { describe, expect, it } from 'vitest';

import type { TyrianVaultChange } from '../host/tyrian-host-storage';
import { emptyLiveSessionView } from '../sessions/live-session-lifecycle';
import { emptyLivePanelLive, livePanelLive, renderLivePanelNote, type LivePanelLiveV1 } from '../sessions/live-panel-note';
import type { LiveSessionViewV1 } from '../sessions/live-session-model';
import { LiveHudRuntime, type LiveHudRuntimeOptions } from './live-hud-runtime';

const ROOT = 'Games/Tyrian Companion';
const NOTE = `${ROOT}/Live panel.md`;
const START = new Date(2026, 9, 31, 18, 0, 0).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

function activeView(nowMs: number, patch: Partial<LiveSessionViewV1> = {}): LiveSessionViewV1 {
	const base = emptyLiveSessionView();
	return {
		...base, sessionId: 's1', phase: 'active', connection: 'connected', sourceState: 'ready', sourceReason: null, source: 'nexus_inventory',
		startedAt: iso(START), elapsedMs: nowMs - START, observedItemsMs: 20 * 60_000, lastObservationAt: iso(nowMs), itemCoverage: 'complete',
		totals: [{ kind: 'item', idNumber: 36038, positive: 5, negative: 0, net: 5 }],
		valuation: { ...base.valuation, capturedAt: iso(START), knownNetValueCopper: 50_000, netItemValueKnownCopper: 40_000, coinNetCopper: 10_000 },
		...patch,
	};
}

function note(view: LiveSessionViewV1): string {
	return renderLivePanelNote({ locale: 'es', nowMs: START + 10 * 60_000, view, valueCopper: 50_000, ratePerHourCopper: 150_000, loot: [], lastDrop: null });
}

function setup(options: { consulting?: boolean; notes?: Record<string, string>; failRead?: boolean } = {}) {
	const notes = new Map(Object.entries(options.notes ?? {}));
	const listeners = new Set<(change: TyrianVaultChange) => void>();
	const reads: string[] = [];
	const runs: Promise<void>[] = [];
	const state: { consulting: boolean; failRead: boolean; local: LivePanelLiveV1 } = { consulting: options.consulting ?? true, failRead: options.failRead ?? false, local: emptyLivePanelLive() };
	let subscriptions = 0;
	const runtimeOptions: LiveHudRuntimeOptions = {
		vault: {
			file: (path) => notes.has(path) ? { path } : null,
			read: async (file) => { reads.push(file.path); if (state.failRead) throw new Error('unreadable'); return notes.get(file.path) ?? ''; },
			onChange: (root, listener) => {
				expect(root).toBe(ROOT);
				subscriptions += 1;
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			},
		},
		root: () => ROOT,
		consulting: () => state.consulting,
		local: () => state.local,
		run: (read) => { const running = read(); running.catch(() => undefined); runs.push(running); },
	};
	const runtime = new LiveHudRuntime(runtimeOptions);
	const settle = async (): Promise<PromiseSettledResult<void>[]> => Promise.allSettled(runs.splice(0));
	const change = (kind: TyrianVaultChange['kind'], path: string, oldPath?: string): void => {
		for (const listener of listeners) listener(oldPath === undefined ? { kind, path } : { kind, path, oldPath });
	};
	return { runtime, notes, reads, state, settle, change, watching: () => listeners.size, subscriptions: () => subscriptions };
}

describe('LiveHudRuntime on a device in consult', () => {
	it('reads the note when the first view subscribes, and tells the views what it carries', async () => {
		const view = activeView(START + 10 * 60_000);
		const t = setup({ notes: { [NOTE]: note(view) } });
		let told = 0;
		t.runtime.subscribe(() => { told += 1; });
		expect(t.runtime.current()).toEqual({ state: 'missing', live: null, source: 'note' });
		await t.settle();
		expect(t.reads).toEqual([NOTE]);
		expect(told).toBe(1);
		const expected = livePanelLive({ view, valueCopper: 50_000, ratePerHourCopper: 150_000, loot: [] });
		expect(t.runtime.current()).toEqual({ state: 'live', live: expected, source: 'note' });
	});

	it('is «missing» without a note, «invalid» with a foreign or corrupt one, and never reads twice for one event', async () => {
		const missing = setup();
		missing.runtime.subscribe(() => undefined);
		await missing.settle();
		expect(missing.runtime.current()).toEqual({ state: 'missing', live: null, source: 'note' });
		expect(missing.reads).toEqual([]);

		const foreign = setup({ notes: { [NOTE]: '---\ntitle: mine\n---\nMy farming notes.\n' } });
		foreign.runtime.subscribe(() => undefined);
		await foreign.settle();
		expect(foreign.runtime.current()).toEqual({ state: 'invalid', live: null, source: 'note' });

		const corrupt = setup({ notes: { [NOTE]: '---\ntc_kind: gw2_live_panel\ntc_live_state: live\ntc_live_v: 1\ntc_live_bags: many\n---\n' } });
		corrupt.runtime.subscribe(() => undefined);
		await corrupt.settle();
		expect(corrupt.runtime.current()).toEqual({ state: 'invalid', live: null, source: 'note' });
		expect(corrupt.reads).toHaveLength(1);
	});

	it('reads again on a change of that note only, follows a rename onto it, and drops it on a delete', async () => {
		const t = setup({ notes: { [NOTE]: note(activeView(START + 10 * 60_000)) } });
		const told: string[] = [];
		t.runtime.subscribe(() => { told.push(t.runtime.current().state); });
		await t.settle();
		t.change('modify', `${ROOT}/Collector status.md`);
		t.change('create', `${ROOT}/sessions/2026-10-31.md`);
		await t.settle();
		expect(t.reads).toHaveLength(1);

		t.notes.set(NOTE, note(activeView(START + 11 * 60_000, { sourceState: 'stale' })));
		t.change('modify', NOTE);
		await t.settle();
		expect(t.reads).toHaveLength(2);
		expect(told).toEqual(['live', 'stale']);

		t.notes.delete(NOTE);
		t.change('delete', NOTE);
		await t.settle();
		expect(t.runtime.current().state).toBe('missing');

		t.notes.set(NOTE, note(activeView(START + 12 * 60_000, { phase: 'complete', connection: 'disconnected', sourceState: 'unavailable', endedAt: iso(START + 12 * 60_000) })));
		t.change('rename', NOTE, `${ROOT}/Old panel.md`);
		await t.settle();
		expect(t.runtime.current().state).toBe('ended');
	});

	it('keeps what it showed when a read fails, and reports the failure through the host', async () => {
		const t = setup({ notes: { [NOTE]: note(activeView(START + 10 * 60_000)) } });
		t.runtime.subscribe(() => undefined);
		await t.settle();
		t.state.failRead = true;
		t.change('modify', NOTE);
		const settled = await t.settle();
		expect(settled[0]!.status).toBe('rejected');
		expect(t.runtime.current().state).toBe('live');
		// The next change reads again: a failed read does not jam the reader.
		t.state.failRead = false;
		t.change('modify', NOTE);
		await t.settle();
		expect(t.reads).toHaveLength(3);
	});

	it('watches the vault while at least one view listens, and stops with the last one', async () => {
		const t = setup({ notes: { [NOTE]: note(activeView(START + 10 * 60_000)) } });
		const first = t.runtime.subscribe(() => undefined);
		const second = t.runtime.subscribe(() => undefined);
		await t.settle();
		expect([t.watching(), t.subscriptions()]).toEqual([1, 1]);
		first();
		expect(t.watching()).toBe(1);
		second();
		expect(t.watching()).toBe(0);
		// Nobody listening: nothing is kept, and a change is not read.
		t.change('modify', NOTE);
		await t.settle();
		expect(t.reads).toHaveLength(1);
		// A new listener starts afresh.
		t.runtime.subscribe(() => undefined);
		await t.settle();
		expect([t.watching(), t.reads.length]).toEqual([1, 2]);
		t.runtime.dispose();
		expect(t.watching()).toBe(0);
		expect(t.runtime.subscribe(() => undefined)).toBeTypeOf('function');
		expect(t.watching()).toBe(0);
	});

	it('asks for the note the first time it is needed after this device switched to consult', async () => {
		const t = setup({ consulting: false, notes: { [NOTE]: note(activeView(START + 10 * 60_000)) } });
		t.runtime.subscribe(() => undefined);
		await t.settle();
		expect(t.reads).toEqual([]);
		t.state.consulting = true;
		expect(t.runtime.current()).toEqual({ state: 'missing', live: null, source: 'note' });
		await t.settle();
		expect(t.reads).toEqual([NOTE]);
		expect(t.runtime.current().state).toBe('live');
	});
});

describe('LiveHudRuntime on the collector', () => {
	it('paints from the live session and never reads the note, even when the vault reports it changed', async () => {
		const t = setup({ consulting: false, notes: { [NOTE]: note(activeView(START + 10 * 60_000)) } });
		t.state.local = { ...emptyLivePanelLive(), state: 'live', startedAt: iso(START), valueCopper: 123 };
		t.runtime.subscribe(() => undefined);
		await t.settle();
		expect(t.runtime.current()).toEqual({ state: 'live', live: t.state.local, source: 'local' });
		t.change('modify', NOTE);
		await t.settle();
		expect(t.reads).toEqual([]);
	});
});
