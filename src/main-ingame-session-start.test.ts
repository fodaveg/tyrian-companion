import { describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { IngamePresenceTracker } from './alerts/alert-ingame-presence';
import { HostApiKeyProvider } from './core/secret-provider';
import { DEFAULT_SETTINGS } from './core/settings';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import type { ActiveSessionLeaseHandle } from './sessions/coordination-model';
import { IngameSessionMarker, type IngameSessionLink } from './sessions/ingame-session-marker';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { MemorySessionRuntimeStore } from './sessions/session-runtime-store';
import type { SessionStartCaptureResult } from './sessions/session-start-capture';

/** Real marker + fenced start service + key provider, with the core's actual automatic-start gate. */
function harness(options: { credential?: boolean; entryPresent?: boolean; failCapture?: boolean; unavailableStore?: boolean; bounded?: boolean } = {}) {
	let now = Date.parse('2026-08-13T07:59:59.500Z');
	const secrets = new Map<string, string>();
	const entries = new Set(options.entryPresent === false ? [] : ['synthetic-selection']);
	if (options.credential) secrets.set('synthetic-selection', 'synthetic-value');
	const storeFailure = new Error('Controlled secret-store failure');
	const hostSecrets = { list: () => [...entries], get: (name: string) => {
		if (options.unavailableStore) throw storeFailure;
		return secrets.get(name) ?? null;
	} };
	const provider = new HostApiKeyProvider(hostSecrets, () => 'synthetic-selection');
	const client = new GuildWars2Client({ send: vi.fn() }, provider);
	const tracker = new IngamePresenceTracker({
		now: () => now, createPresenceId: () => 'synthetic-presence', recordObserverFailure: vi.fn(),
		timer: { schedule: () => 1, cancel: () => undefined },
	});
	const lease: ActiveSessionLeaseHandle = {
		machineId: 'synthetic-machine', instanceId: 'synthetic-instance', sessionId: 'synthetic-session',
		fence: 1, acquiredAt: now, renewedAt: now, expiresAt: now + 30_000,
	};
	let captures = 0;
	let failCapture = options.failCapture ?? false;
	const errors: unknown[] = [];
	const service = new ManualSessionStartService({
		instanceId: lease.instanceId,
		acquire: async () => ({ status: 'acquired', handle: lease }),
		renew: async () => ({ status: 'renewed', handle: lease }),
		assertOwned: async () => ({ status: 'owned' }),
		release: async () => ({ status: 'released' }), dispose: () => undefined,
	}, {
		captureFinal: async () => { client.beginOperation(); return afterSnapshot(); },
		capture: async (): Promise<SessionStartCaptureResult> => {
			captures += 1;
			// Keep the red regression bounded even if the old feedback loop keeps starting.
			if (options.bounded && captures === 5) core.settings.alertIngameEnabled = false;
			try { client.beginOperation(); } catch (error) { errors.push(error); throw error; }
			if (failCapture) throw new Error('Controlled capture failure');
			return {
				snapshot: storageDeltaSnapshot(),
				context: {
					characterName: 'Astra Uno', capturedAt: '2026-08-13T08:00:02.000Z',
					magicFind: { value: 1, source: 'manual', consumablesBonus: 0, breakdown: null },
					build: {
						tab: 1, name: 'Farm', profession: 'Revenant',
						specializations: [{ id: 3, traits: [1, 2, 3] }, { id: 52, traits: [4, 5, 6] }, { id: 63, traits: [7, 8, 9] }],
						skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
						aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
					},
				},
			};
		},
	}, {
		runtimeStore: new MemorySessionRuntimeStore(), now: () => now, sessionId: () => lease.sessionId,
		setInterval: () => 1, clearInterval: () => undefined,
		// Same feedback boundary as the assembled core: every session change asks the marker to reconcile.
		onStateChange: () => { if (core.ingameSessionMarker) void core.ingameSessionMarker.reconcile(); },
	});
	const start = vi.fn(async (characterName: string | null) => {
		const result = await service.start({ characterName: characterName ?? 'Astra Uno', magicFind: 1, consumablesBonus: 0 });
		if (result.status === 'failed') throw new Error('Start failed.');
		return result.state.sessionId;
	});
	const stop = vi.fn(async (_input: unknown, _intent: unknown, _immediate: boolean, endedAtMs: number) => {
		await service.stopAt(endedAtMs);
	});
	const core = {
		host: { secrets: hostSecrets }, settings: { ...DEFAULT_SETTINGS, alertIngameEnabled: true, apiKeySecret: 'synthetic-selection' },
		ingameSessionMarker: null as IngameSessionMarker | null,
		hasConfiguredApiKey: () => true,
		getIngamePresence: () => tracker.snapshot(),
		onIngamePresence: (listener: Parameters<IngamePresenceTracker['subscribe']>[0]) => tracker.subscribe(listener),
		ingameSessionView: () => {
			const state = service.getState();
			return { status: state.status, sessionId: state.status === 'idle' ? null : lease.sessionId, canStart: state.status === 'idle' };
		},
		startIngameSession: start,
		performStopManualSession: stop,
		readIngameSessionLink: () => null,
		writeIngameSessionLink: (_link: IngameSessionLink) => undefined,
		recordIngameSessionFailure: vi.fn(),
	};
	tracker.apply({ kind: 'authenticated', connectionId: 'synthetic-connection', client: 'nexus', instance: 'synthetic-game', atMs: now });
	tracker.apply({ kind: 'context', connectionId: 'synthetic-connection', context: { state: 'gameplay', mapId: 50, character: 'Astra Uno' }, atMs: now });
	(TyrianCompanionCore.prototype as unknown as { startIngameSessionMarking(this: typeof core): void }).startIngameSessionMarking.call(core);
	return {
		core, service, start, stop, storeFailure, errors, captures: () => captures,
		settled: async () => { await new Promise<void>((resolve) => { setImmediate(resolve); }); },
		reconcile: async () => { await core.ingameSessionMarker!.reconcile(); await new Promise<void>((resolve) => { setImmediate(resolve); }); },
		restoreCredential: () => { entries.add('synthetic-selection'); secrets.set('synthetic-selection', 'synthetic-value'); },
		removeCredential: () => secrets.delete('synthetic-selection'),
		endGame: async () => {
			now = Date.parse('2026-08-13T08:05:00.000Z');
			tracker.apply({ kind: 'closed', connectionId: 'synthetic-connection', atMs: now, lastSeenAtMs: now, reason: 'game_exit' });
			await new Promise<void>((resolve) => { setImmediate(resolve); });
		},
		retryStopAfterSettlement: async () => { now = Date.parse('2026-08-13T09:00:30.000Z'); return await service.stop(); },
		restoreCapture: () => { failCapture = false; },
		dispose: async () => { core.ingameSessionMarker!.dispose(); await service.dispose(); },
	};
}

describe('automatic session start with the real fenced service', () => {
	it.each([false, true])('waits for the selected credential with entryPresent=%s, then starts on a fresh reconciliation', async (entryPresent) => {
		const runtime = harness({ entryPresent, bounded: true });
		try {
			await runtime.settled();
			expect(runtime.start).not.toHaveBeenCalled();
			expect(runtime.captures()).toBe(0);
			expect(runtime.errors).toEqual([]);
			expect(runtime.core.recordIngameSessionFailure).not.toHaveBeenCalled();
			runtime.restoreCredential();
			await runtime.reconcile();
			expect(runtime.start).toHaveBeenCalledOnce();
			expect(runtime.service.getState().status).toBe('active');
		} finally { await runtime.dispose(); }
	});

	it('does not retry a stable capture failure from the state changes its own failed start emits', async () => {
		const runtime = harness({ credential: true, failCapture: true, bounded: true });
		try {
			await runtime.settled();
			expect(runtime.captures()).toBe(1);
			expect(runtime.start).toHaveBeenCalledOnce();
			expect(runtime.core.recordIngameSessionFailure).toHaveBeenCalledOnce();
			expect(runtime.service.getState().status).toBe('idle');
			runtime.restoreCapture();
			await runtime.reconcile();
			expect(runtime.start).toHaveBeenCalledTimes(2);
			expect(runtime.service.getState().status).toBe('active');
		} finally { await runtime.dispose(); }
	});

	it('keeps the game-exit boundary when the credential disappears after linking and finishes when it returns', async () => {
		const runtime = harness({ credential: true });
		try {
			await runtime.settled();
			expect(runtime.service.getState().status).toBe('active');
			runtime.removeCredential();
			await runtime.endGame();
			expect(runtime.stop).toHaveBeenCalledOnce();
			expect(runtime.service.getState()).toMatchObject({ status: 'stopping', stopRequestedAt: '2026-08-13T08:05:00.000Z' });
			expect((await runtime.retryStopAfterSettlement()).status).toBe('failed');
			expect(runtime.service.getState()).toMatchObject({ status: 'stopping', stopRequestedAt: '2026-08-13T08:05:00.000Z' });
			runtime.restoreCredential();
			expect((await runtime.retryStopAfterSettlement()).status).toBe('stopped');
			expect(runtime.service.getState()).toMatchObject({ status: 'provisional', stoppedAt: '2026-08-13T08:05:00.000Z' });
		} finally { await runtime.dispose(); }
	});

	it('records a synchronous credential-store failure once before attempting the fenced start', async () => {
		const runtime = harness({ unavailableStore: true, bounded: true });
		try {
			await runtime.settled();
			expect(runtime.start).not.toHaveBeenCalled();
			expect(runtime.core.recordIngameSessionFailure).toHaveBeenCalledExactlyOnceWith(runtime.storeFailure);
		} finally { await runtime.dispose(); }
	});

});
