import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { TyrianVaultFile } from '../host/tyrian-host';
import { canonicalPathFor } from './canonical-path';
import { loadCollectorInstanceId } from './collector-instance';
import {
	COLLECTOR_HEARTBEAT_FRESH_MS,
	COLLECTOR_HEARTBEAT_INTERVAL_MS,
	CollectorHeartbeat,
	collectorStatusNotePath,
	collectorStatusVerdict,
	parseCollectorStatusNote,
	renderCollectorStatusNote,
	type CollectorBeatOutcome,
	type CollectorFootprint,
	type CollectorHeartbeatOptions,
	type CollectorStatusVault,
} from './collector-status';

const ROOT = 'Games/Tyrian Companion';
const NOTE = `${ROOT}/Collector status.md`;
const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const MINUTE = 60_000;

function footprint(instanceId: string, heartbeatAt: number, platform: CollectorFootprint['platform'] = 'linux'): CollectorFootprint {
	return { instanceId, platform, hostVersion: '1.9.12', pluginVersion: '0.2.6', heartbeatAt: new Date(heartbeatAt).toISOString() };
}

/** A vault in memory that records every write and every folder it creates. */
function memoryVault(initial: Record<string, string> = {}) {
	const notes = new Map(Object.entries(initial));
	const folders = new Set<string>();
	const writes: string[] = [];
	const vault: CollectorStatusVault = {
		file: (path) => notes.has(path) || folders.has(path) ? { path } : null,
		read: async (file: TyrianVaultFile) => notes.get(file.path) ?? '',
		process: async (file, update) => {
			const next = update(notes.get(file.path) ?? '');
			if (next !== notes.get(file.path)) writes.push(file.path);
			notes.set(file.path, next);
			return next;
		},
		create: async (path, content) => { notes.set(path, content); writes.push(path); return { path }; },
		createFolder: async (path) => { folders.add(path); },
	};
	return { vault, notes, folders, writes };
}

function heartbeat(
	vault: CollectorStatusVault,
	instanceId: string,
	now: () => number,
	overrides: Partial<CollectorHeartbeatOptions> = {},
) {
	const conflicts: CollectorFootprint[] = [];
	const beats: Array<Promise<CollectorBeatOutcome>> = [];
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	const clock = new CollectorHeartbeat({
		vault, root: () => ROOT, instanceId, now, locale: () => 'en',
		environment: { platform: 'macos', hostVersion: '1.9.12', pluginVersion: '0.2.6' },
		setInterval: (callback, delayMs) => {
			expect(delayMs).toBe(COLLECTOR_HEARTBEAT_INTERVAL_MS);
			timers.set(nextTimer, callback);
			return nextTimer++;
		},
		clearInterval: (handle) => { timers.delete(handle); },
		run: (beat) => { beats.push(beat()); },
		onConflict: (other) => { conflicts.push(other); },
		...overrides,
	});
	return { clock, conflicts, beats, timers };
}

describe('collector status note (R1b)', () => {
	it('round-trips the footprint and is found by canonicalPathFor at its one fixed path', () => {
		const text = renderCollectorStatusNote(footprint('instance-a', T0), 'es');
		expect(parseCollectorStatusNote(text)).toEqual(footprint('instance-a', T0));
		expect(parseCollectorStatusNote(text.replace(/\n/gu, '\r\n'))).toEqual(footprint('instance-a', T0));
		expect(canonicalPathFor(ROOT, text)).toEqual(['Collector status.md']);
		expect(collectorStatusNotePath(ROOT)).toBe(NOTE);
	});

	it('writes a host value it could not read back as unknown, so the note stays reclaimable', () => {
		const odd = { ...footprint('instance-a', T0), hostVersion: '0.12 (build 91)', platform: 'beos' as never };
		expect(parseCollectorStatusNote(renderCollectorStatusNote(odd, 'en'))).toEqual({
			...footprint('instance-a', T0), hostVersion: 'unknown', platform: 'unknown',
		});
	});

	it('does not mistake any other note for a status note', () => {
		const valid = renderCollectorStatusNote(footprint('instance-a', T0), 'en');
		for (const foreign of [
			'# My own note\n',
			valid.replace('gw2_collector_status', 'gw2_farming_session'),
			valid.replace('tc_collector_schema: 1', 'tc_collector_schema: 2'),
			valid.replace('"2026-09-28T10:00:00.000Z"', '"2026-09-28 10:00"'),
			valid.replace('tc_collector_platform: linux', 'tc_collector_platform: amiga'),
			valid.replace('"instance-a"', '"a/b"'),
			valid.replace('tc_kind:', 'tc_kind: [broken'),
		]) {
			expect(parseCollectorStatusNote(foreign)).toBeNull();
			expect(canonicalPathFor(ROOT, foreign)).toEqual([]);
		}
	});

	it('tells a recent heartbeat from another installation apart from a stale one', () => {
		const other = renderCollectorStatusNote(footprint('instance-a', T0), 'en');
		expect(collectorStatusVerdict(null, 'instance-b', T0)).toEqual({ kind: 'free' });
		expect(collectorStatusVerdict('# mine', 'instance-b', T0)).toEqual({ kind: 'unrecognized' });
		expect(collectorStatusVerdict(other, 'instance-a', T0 + 5 * 60 * MINUTE).kind).toBe('own');
		expect(collectorStatusVerdict(other, 'instance-b', T0 + 20 * MINUTE).kind).toBe('held');
		expect(collectorStatusVerdict(other, 'instance-b', T0 + COLLECTOR_HEARTBEAT_FRESH_MS).kind).toBe('held');
		expect(collectorStatusVerdict(other, 'instance-b', T0 + COLLECTOR_HEARTBEAT_FRESH_MS + 1).kind).toBe('stale');
		// A heartbeat from a clock far in the future cannot hold the note forever.
		expect(collectorStatusVerdict(other, 'instance-b', T0 - COLLECTOR_HEARTBEAT_FRESH_MS - 1).kind).toBe('stale');
	});
});

describe('CollectorHeartbeat (R1b)', () => {
	it('writes the footprint on a vault that has none, creating the output folder first', async () => {
		const { vault, notes, folders, writes } = memoryVault();
		const { clock, conflicts } = heartbeat(vault, 'instance-b', () => T0);

		await expect(clock.beat()).resolves.toEqual({ status: 'written' });

		expect([...folders]).toEqual(['Games', 'Games/Tyrian Companion']);
		expect(writes).toEqual([NOTE]);
		expect(parseCollectorStatusNote(notes.get(NOTE)!)).toEqual(footprint('instance-b', T0, 'macos'));
		expect(conflicts).toEqual([]);
	});

	it('warns once about a second collector with a recent heartbeat and never overwrites its note', async () => {
		const otherNote = renderCollectorStatusNote(footprint('instance-a', T0), 'en');
		const { vault, notes, writes } = memoryVault({ [NOTE]: otherNote });
		let now = T0 + 10 * MINUTE;
		const { clock, conflicts } = heartbeat(vault, 'instance-b', () => now);

		await expect(clock.beat()).resolves.toEqual({ status: 'held', other: footprint('instance-a', T0) });
		now += COLLECTOR_HEARTBEAT_INTERVAL_MS;
		await expect(clock.beat()).resolves.toMatchObject({ status: 'held' });

		expect(conflicts).toEqual([footprint('instance-a', T0)]);
		expect(clock.currentConflict()).toEqual(footprint('instance-a', T0));
		expect(writes).toEqual([]);
		expect(notes.get(NOTE)).toBe(otherNote);
	});

	it('takes over a note whose heartbeat went stale, without any warning', async () => {
		const { vault, notes, writes } = memoryVault({ [NOTE]: renderCollectorStatusNote(footprint('instance-a', T0), 'en') });
		const now = T0 + COLLECTOR_HEARTBEAT_FRESH_MS + MINUTE;
		const { clock, conflicts } = heartbeat(vault, 'instance-b', () => now);

		await expect(clock.beat()).resolves.toEqual({ status: 'written' });

		expect(conflicts).toEqual([]);
		expect(writes).toEqual([NOTE]);
		expect(parseCollectorStatusNote(notes.get(NOTE)!)?.instanceId).toBe('instance-b');
	});

	it('stops warning once the other collector goes quiet and it takes the note back', async () => {
		const { vault, notes } = memoryVault({ [NOTE]: renderCollectorStatusNote(footprint('instance-a', T0), 'en') });
		let now = T0;
		const { clock, conflicts } = heartbeat(vault, 'instance-b', () => now);
		await clock.beat();
		now = T0 + COLLECTOR_HEARTBEAT_FRESH_MS + MINUTE;
		await expect(clock.beat()).resolves.toEqual({ status: 'written' });
		expect(clock.currentConflict()).toBeNull();
		// The other one comes back and beats again: a new episode, a new warning.
		notes.set(NOTE, renderCollectorStatusNote(footprint('instance-a', now + MINUTE), 'en'));
		now += 2 * MINUTE;
		await clock.beat();
		expect(conflicts.map(({ instanceId }) => instanceId)).toEqual(['instance-a', 'instance-a']);
	});

	it('refreshes its own heartbeat and leaves a note that is not a status note alone', async () => {
		const own = memoryVault({ [NOTE]: renderCollectorStatusNote(footprint('instance-b', T0), 'en') });
		await expect(heartbeat(own.vault, 'instance-b', () => T0 + MINUTE).clock.beat()).resolves.toEqual({ status: 'written' });
		expect(parseCollectorStatusNote(own.notes.get(NOTE)!)?.heartbeatAt).toBe(new Date(T0 + MINUTE).toISOString());

		const foreign = memoryVault({ [NOTE]: '# Collector status\nMy own notes.\n' });
		await expect(heartbeat(foreign.vault, 'instance-b', () => T0).clock.beat()).resolves.toEqual({ status: 'unrecognized' });
		expect(foreign.writes).toEqual([]);
	});

	it('re-decides inside the atomic update when the other collector beats in between', async () => {
		const { vault, notes, writes } = memoryVault({ [NOTE]: renderCollectorStatusNote(footprint('instance-a', T0), 'en') });
		const now = T0 + COLLECTOR_HEARTBEAT_FRESH_MS + MINUTE;
		const read = vault.read.bind(vault);
		vault.read = async (file) => {
			const text = await read(file);
			// Sync delivers a fresh beat from instance-a right after this read.
			notes.set(NOTE, renderCollectorStatusNote(footprint('instance-a', now), 'en'));
			return text;
		};
		const { clock, conflicts } = heartbeat(vault, 'instance-b', () => now);

		await expect(clock.beat()).resolves.toMatchObject({ status: 'held' });
		expect(writes).toEqual([]);
		expect(conflicts).toHaveLength(1);
	});

	it('beats now and on the interval, skips while the root is not writable, and stops for good', async () => {
		const { vault, writes } = memoryVault();
		let writable = false;
		const { clock, beats, timers } = heartbeat(vault, 'instance-b', () => T0, { writable: () => writable });

		clock.start();
		clock.start();
		expect(timers.size).toBe(1);
		await expect(beats[0]).resolves.toEqual({ status: 'skipped' });
		writable = true;
		[...timers.values()][0]!();
		await expect(beats[1]).resolves.toEqual({ status: 'written' });
		expect(writes).toEqual([NOTE]);

		clock.stop();
		expect(timers.size).toBe(0);
		await expect(clock.beat()).resolves.toEqual({ status: 'skipped' });
		clock.start();
		expect(timers.size).toBe(0);
	});
});

describe('loadCollectorInstanceId (R1b)', () => {
	const VAULT_A = 'a'.repeat(64);
	const VAULT_B = 'b'.repeat(64);

	it('keeps one id per installation across loads, and a different one per vault', async () => {
		const factory = new IDBFactory();
		const createId = vi.fn()
			.mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
			.mockReturnValueOnce('22222222-2222-4222-8222-222222222222');

		const first = await loadCollectorInstanceId(factory, VAULT_A, createId);
		await expect(loadCollectorInstanceId(factory, VAULT_A, createId)).resolves.toBe(first);
		const other = await loadCollectorInstanceId(factory, VAULT_B, createId);

		expect(first).toBe('11111111-1111-4111-8111-111111111111');
		expect(other).toBe('22222222-2222-4222-8222-222222222222');
		expect(createId).toHaveBeenCalledTimes(2);
	});

	it('refuses a vault identity that is not a vaultId hash', async () => {
		await expect(loadCollectorInstanceId(new IDBFactory(), 'not-a-hash')).rejects.toThrow('vault identity');
	});
});
