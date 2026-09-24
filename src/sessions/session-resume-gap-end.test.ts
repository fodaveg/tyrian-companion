/**
 * H18.11 (audit 2026-09-24), corrected rule: a session that comes back after a gap nobody observed
 * (a suspend that outlived the lease, Obsidian closed or restarted) still ends at the player's own
 * stop. The gap, from the last evidence saved before it to the instant the session came back, is
 * recorded on the session as `unobservedGaps` and subtracted from its duration, and the note says so.
 * Play the in-game presence observed during the gap is not subtracted.
 *
 * The earlier rule ended such a session at the evidence before the gap, which cut a player without
 * the addon down to the time before a restart: three hours of loot over one hour of duration.
 *
 * Real lease coordinator and real IndexedDB runtime store (fake-indexeddb), fake clock, and the
 * intervals the service registers driven by hand, exactly as `session-auto-recovery.test.ts` does.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import {
	ManualSessionStartService,
	SESSION_EVIDENCE_SAVE_INTERVAL_MS,
	type ObservedPlayInterval,
} from './manual-session-start-service';
import { API_SETTLEMENT_TICK_MS, API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';
import { prepareSessionNote } from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import { IndexedDbSessionRuntimeStore, type SessionRuntimeRecord } from './session-runtime-store';
import { isSessionState, transitionSession } from './session-state-machine';
import type { SessionStartCaptureResult } from './session-start-capture';
import type { SessionState } from './session';

const captured: SessionStartCaptureResult = {
	snapshot: storageDeltaSnapshot(),
	context: {
		characterName: 'Astra Uno',
		magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
		build: {
			tab: 1,
			name: 'Farm',
			profession: 'Revenant',
			specializations: [
				{ id: 3, traits: [1, 2, 3] },
				{ id: 52, traits: [4, 5, 6] },
				{ id: 63, traits: [7, 8, 9] },
			],
			skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
			aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
		},
		capturedAt: '2026-08-13T08:00:02.000Z',
	},
};

const START = Date.parse('2026-08-13T07:59:59.500Z');
/** When the baseline finished: the session's played window starts here. */
const BASELINE = Date.parse(captured.snapshot.completedAt);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The production lease; the heartbeat renews it every third of it. */
const LEASE_TTL_MS = 300_000;
const HEARTBEAT_MS = LEASE_TTL_MS / 3;
const AFTER_FIRST_RETRY_MS = 60_000;
let clock = START;

interface Interval { callback: () => void; periodMs: number; handle: number }

function openWindow(factory: IDBFactory, instanceId: string, options: {
	observedPlayIntervals?: () => readonly ObservedPlayInterval[];
} = {}) {
	let intervals: Interval[] = [];
	let nextHandle = 1;
	const coordinator = new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName: 'gap-coordination',
		clock: () => clock,
		instanceId,
		leaseTtlMs: LEASE_TTL_MS,
		sleep: async () => undefined,
	});
	const runtimeStore = new IndexedDbSessionRuntimeStore(factory, 'gap-runtime');
	const service = new ManualSessionStartService(coordinator, {
		capture: vi.fn(async () => structuredClone(captured)),
		captureFinal: vi.fn(async () => afterSnapshot({
			startedAt: new Date(clock).toISOString(),
			completedAt: new Date(clock + 1_000).toISOString(),
		})),
	}, {
		now: () => clock,
		sessionId: () => 'session-1',
		setInterval: (callback, periodMs) => {
			const registered = { callback, periodMs, handle: nextHandle++ };
			intervals.push(registered);
			return registered.handle;
		},
		clearInterval: (handle) => { intervals = intervals.filter((entry) => entry.handle !== handle); },
		runtimeStore,
		...(options.observedPlayIntervals === undefined ? {} : { observedPlayIntervals: options.observedPlayIntervals }),
	});
	/** Fires every interval registered with `periodMs`, like the host timer would on its next tick. */
	const tick = (periodMs: number): void => {
		for (const entry of intervals.filter((candidate) => candidate.periodMs === periodMs)) entry.callback();
	};
	return { service, tick, runtimeStore, coordinator };
}

type Window = ReturnType<typeof openWindow>;

async function start(service: ManualSessionStartService): Promise<void> {
	await expect(service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
		.resolves.toMatchObject({ status: 'started' });
}

/**
 * Plays with Obsidian open until `until`: one heartbeat every 100 s, the last one exactly at
 * `until`, each renewing the lease and re-saving the record as evidence.
 */
async function playUntil(window: Window, until: number): Promise<void> {
	await keepLeaseUntil(window, until);
	await vi.waitFor(async () => {
		expect(await window.runtimeStore.load()).toMatchObject({ status: 'loaded', record: { persistedAt: until } });
	});
}

/** Runs the heartbeat every 100 s up to `until`, the last one exactly at `until`. */
async function keepLeaseUntil(window: Window, until: number): Promise<void> {
	const renew = vi.spyOn(window.coordinator, 'renew');
	const beats = Math.floor((until - clock) / HEARTBEAT_MS);
	for (let beat = beats; beat >= 0; beat -= 1) {
		clock = until - beat * HEARTBEAT_MS;
		const before = renew.mock.calls.length;
		window.tick(HEARTBEAT_MS);
		await vi.waitFor(() => expect(renew.mock.calls.length).toBe(before + 1));
		await renew.mock.results.at(-1)?.value;
		// The heartbeat's own flight guard clears in its `.finally`, a few microtasks after the
		// renewal settles; the next tick would otherwise find it still armed and skip.
		for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
	}
	renew.mockRestore();
}

/** Stops by hand at `at`, waits the settlement window out and finalizes, as the host would. */
async function stopAndFinish(window: Window, at: number): Promise<SessionRuntimeRecord> {
	clock = at;
	await expect(window.service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
	await keepLeaseUntil(window, at + API_SETTLEMENT_WINDOW_MS);
	await expect(window.service.stop()).resolves.toMatchObject({ status: 'stopped' });
	await expect(window.service.finalizeStoppedSession()).resolves.toMatchObject({ status: 'finalized' });
	const record = await window.service.getCompletedRuntimeRecord();
	if (record === null) throw new Error('The session did not complete.');
	return record;
}

async function renderedNote(record: SessionRuntimeRecord) {
	const prepared = prepareSessionNote({
		runtime: record, valuation: null, reservation: null, hold: null, recommendation: null, envelope: null,
		eventDeclaration: null, displayNames: {}, firstSeenItemIds: [], rareUnpricedOrBoundItemIds: [],
		locale: 'es', outputFolder: 'Tyrian Companion',
	});
	if (prepared.status !== 'ok') throw new Error(`Invalid note: ${prepared.reason}`);
	const rendered = await renderSessionNote(prepared.note);
	if (rendered.status !== 'ok') throw new Error('Render failed.');
	return { prepared: prepared.note, rendered: rendered.note };
}

function iso(value: number): string {
	return new Date(value).toISOString();
}

describe('unobserved gaps are subtracted, the end stays the stop (H18.11)', () => {
	beforeEach(() => { clock = START; });

	it('re-saves the active record from the heartbeat so it keeps the last instant it was alive', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);
		await playUntil(window, BASELINE + 10 * MINUTE);

		// Throttled: a heartbeat sooner than the interval renews the lease but does not write again.
		const renew = vi.spyOn(window.coordinator, 'renew');
		const save = vi.spyOn(window.runtimeStore, 'save');
		expect(SESSION_EVIDENCE_SAVE_INTERVAL_MS).toBe(60_000);
		clock += 30_000;
		window.tick(HEARTBEAT_MS);
		await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
		await renew.mock.results[0]?.value;
		await Promise.resolve();
		expect(save).not.toHaveBeenCalled();
	});

	it('the reproduction: no addon, Obsidian restarted for a minute, played on for two hours', async () => {
		const factory = new IDBFactory();
		const first = openWindow(factory, 'window-before-restart');
		await start(first.service);
		const restartAt = BASELINE + HOUR;
		await playUntil(first, restartAt);
		// An update restarts Obsidian: the plugin unloads (releasing the lease) and loads again.
		await first.service.dispose();

		clock = restartAt + MINUTE;
		const second = openWindow(factory, 'window-after-restart');
		await second.service.initialize();
		expect(second.service.getState()).toMatchObject({
			status: 'active', unobservedGaps: [{ from: iso(restartAt), to: iso(restartAt + MINUTE) }],
		});
		const stopAt = BASELINE + 3 * HOUR;
		await playUntil(second, stopAt);
		const record = await stopAndFinish(second, stopAt);

		expect(record.state).toMatchObject({ stopRequestedAt: iso(stopAt), stoppedAt: iso(stopAt) });
		expect(record.state).not.toHaveProperty('stopBoundary');
		const { prepared, rendered } = await renderedNote(record);
		// 2 h 59 min of active time, the end is the stop, and the minute nobody saw is declared.
		expect(prepared.durationMs).toBe(3 * HOUR - MINUTE);
		expect(rendered.frontmatter).toMatchObject({
			tc_schema: 5, tc_ended_at: iso(stopAt), tc_duration_ms: 3 * HOUR - MINUTE, tc_unobserved_ms: MINUTE,
		});
		expect(rendered.content).toContain('Tiempo sin observar descontado: 00:01:00 en 1 hueco(s)');
		expect(rendered.content).toContain('la duración es incierta');
		expect(rendered.content).toContain('Hubo 1 min sin observar');
	});

	it('subtracts a three-hour suspend in the middle of the session and keeps the stop as its end', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);
		const sleepAt = BASELINE + HOUR;
		await playUntil(window, sleepAt);

		// The machine sleeps three hours; the first heartbeat after it finds the lease gone.
		clock = sleepAt + 3 * HOUR;
		window.tick(HEARTBEAT_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'error', code: 'lease_lost' }));
		clock += AFTER_FIRST_RETRY_MS;
		const backAt = clock;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({
			status: 'active', authority: { fence: 2 }, unobservedGaps: [{ from: iso(sleepAt), to: iso(backAt) }],
		}));

		const stopAt = backAt + 30 * MINUTE;
		await playUntil(window, stopAt);
		const record = await stopAndFinish(window, stopAt);
		const { prepared, rendered } = await renderedNote(record);
		expect(record.state).toMatchObject({ stoppedAt: iso(stopAt) });
		expect(prepared.durationMs).toBe(stopAt - BASELINE - (backAt - sleepAt));
		expect(prepared.durationMs).toBe(HOUR + 30 * MINUTE);
		expect(rendered.frontmatter).toMatchObject({ tc_ended_at: iso(stopAt), tc_unobserved_ms: backAt - sleepAt });
	});

	it('does not subtract a gap the in-game presence saw being played', async () => {
		let observed: ObservedPlayInterval[] = [];
		const window = openWindow(new IDBFactory(), 'window-a', { observedPlayIntervals: () => observed });
		await start(window.service);
		const lostAt = BASELINE + HOUR;
		await playUntil(window, lostAt);

		// The lease is lost with Obsidian alive and the game running the whole time.
		clock = lostAt + 20 * MINUTE;
		observed = [{ fromMs: BASELINE, toMs: clock + AFTER_FIRST_RETRY_MS }];
		window.tick(HEARTBEAT_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'error' }));
		clock += AFTER_FIRST_RETRY_MS;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'active', authority: { fence: 2 } }));
		expect(window.service.getState()).not.toHaveProperty('unobservedGaps');

		const stopAt = clock + 2 * MINUTE;
		await playUntil(window, stopAt);
		const record = await stopAndFinish(window, stopAt);
		expect(record.state).toMatchObject({ stopRequestedAt: iso(stopAt) });
		expect(record.state).not.toHaveProperty('stopBoundary');
		expect((await renderedNote(record)).prepared.durationMs).toBe(stopAt - BASELINE);
	});

	it('subtracts only the part of a gap the presence did not see', async () => {
		let observed: ObservedPlayInterval[] = [];
		const window = openWindow(new IDBFactory(), 'window-a', { observedPlayIntervals: () => observed });
		await start(window.service);
		const sleepAt = BASELINE + HOUR;
		await playUntil(window, sleepAt);

		// The addon kept reporting for five minutes after the last save, then the machine slept.
		observed = [{ fromMs: BASELINE, toMs: sleepAt + 5 * MINUTE }];
		clock = sleepAt + 2 * HOUR;
		window.tick(HEARTBEAT_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'error' }));
		clock += AFTER_FIRST_RETRY_MS;
		const backAt = clock;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({
			status: 'active', unobservedGaps: [{ from: iso(sleepAt + 5 * MINUTE), to: iso(backAt) }],
		}));
	});

	it('keeps the gap of a session reopened twice, and the next one after it', async () => {
		const factory = new IDBFactory();
		const first = openWindow(factory, 'window-1');
		await start(first.service);
		const firstClose = BASELINE + HOUR;
		await playUntil(first, firstClose);
		await first.service.dispose();

		clock = firstClose + 10 * MINUTE;
		const second = openWindow(factory, 'window-2');
		await second.service.initialize();
		const secondClose = clock + HOUR;
		await playUntil(second, secondClose);
		await second.service.dispose();

		clock = secondClose + 20 * MINUTE;
		const third = openWindow(factory, 'window-3');
		await third.service.initialize();
		expect(third.service.getState()).toMatchObject({
			status: 'active',
			unobservedGaps: [
				{ from: iso(firstClose), to: iso(firstClose + 10 * MINUTE) },
				{ from: iso(secondClose), to: iso(secondClose + 20 * MINUTE) },
			],
		});
	});

	it('keeps the click as the end of a session that never went through a gap', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);
		const stopAt = BASELINE + HOUR;
		await playUntil(window, stopAt);
		const record = await stopAndFinish(window, stopAt);
		expect(record.state).not.toHaveProperty('unobservedGaps');
		const { prepared, rendered } = await renderedNote(record);
		expect(prepared.durationMs).toBe(HOUR);
		expect(rendered.frontmatter).toMatchObject({ tc_unobserved_ms: 0, tc_ended_at: iso(stopAt) });
		expect(rendered.content).not.toContain('Tiempo sin observar');
	});

	it('validates the gaps as part of the state: ordered, inside the session, and cut at the stop', () => {
		const active = {
			version: 1, status: 'active', sessionId: 'session-1',
			authority: { machineId: 'machine', instanceId: 'instance', sessionId: 'session-1', fence: 1, acquiredAt: START - 500 },
			requestedAt: iso(START), baseline: {
				snapshotId: captured.snapshot.snapshotId, accountId: captured.snapshot.accountId,
				schemaVersion: captured.snapshot.schemaVersion, startedAt: captured.snapshot.startedAt,
				completedAt: captured.snapshot.completedAt, quality: 'stable',
			},
			startContext: captured.context,
		} as const;
		expect(isSessionState(active)).toBe(true);
		const gap = { from: iso(BASELINE + HOUR), to: iso(BASELINE + 2 * HOUR) };
		const recorded = transitionSession(active, { type: 'record_unobserved_gap', authority: active.authority, ...gap });
		expect(recorded).toMatchObject({ status: 'applied', state: { unobservedGaps: [gap] } });
		const withGap = recorded.state as SessionState;
		// Before the baseline, overlapping, or empty: never a valid state.
		expect(isSessionState({ ...withGap, unobservedGaps: [{ from: iso(BASELINE - 1), to: gap.to }] })).toBe(false);
		expect(isSessionState({ ...withGap, unobservedGaps: [gap, gap] })).toBe(false);
		expect(isSessionState({ ...withGap, unobservedGaps: [] })).toBe(false);
		// A stop inside the gap keeps only the part before it.
		const stopped = transitionSession(withGap, {
			type: 'request_stop', authority: active.authority, requestedAt: iso(BASELINE + 90 * MINUTE),
		});
		expect(stopped).toMatchObject({
			status: 'applied', state: { unobservedGaps: [{ from: gap.from, to: iso(BASELINE + 90 * MINUTE) }] },
		});
	});
});
