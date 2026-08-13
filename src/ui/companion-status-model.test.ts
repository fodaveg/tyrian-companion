import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { SessionState } from '../sessions/session';
import {
	buildCompanionStatus,
	formatElapsed,
	visibleRailItems,
	type CompanionStatusInput,
} from './companion-status-model';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

describe('buildCompanionStatus', () => {
	it('projects the closed-note idle state without scheduling refreshes', () => {
		const projection = buildCompanionStatus(input());

		expect(values(projection)).toEqual(['Disarmed', 'Idle', 'Stopped', 'No sample']);
		expect(projection.connection.value).toBe('Not checked');
		expect(projection.refreshEveryMs).toBeNull();
	});

	it.each([
		['arming', 'Arming', 'Waiting'],
		['armed', 'Armed', 'Scheduled'],
		['start_proposed', 'Start proposed', 'Paused'],
		['stop_proposed', 'Stop proposed', 'Paused'],
		['error', 'Error', 'Stopped'],
	] as const)('maps detector %s to the rail', (status, detector, polling) => {
		const projection = buildCompanionStatus(input({ detection: detection(status) }));
		expect(values(projection).slice(0, 3)).toEqual([detector, 'Idle', polling]);
	});

	it.each([
		['polling', 'Checking now'],
		['paused_offline', 'Offline'],
		['paused_sleep', 'Resuming'],
		['backoff', 'Backing off'],
		['fatal', 'Failed'],
		['disposed', 'Unavailable'],
	] as const)('maps polling state %s', (status, expected) => {
		const armed = detection('armed');
		armed.scheduler.status = status;
		const projection = buildCompanionStatus(input({ detection: armed }));
		expect(projection.items[2]?.value).toBe(expected);
	});

	it('ticks active duration from the completed baseline using tabular HH:MM:SS', () => {
		const projection = buildCompanionStatus(input({ session: activeSession(), now: NOW + 3_723_000 }));
		expect(projection.items[1]).toMatchObject({ value: 'Active', detail: '01:02:03 · Ranger' });
		expect(projection.refreshEveryMs).toBe(1_000);
	});

	it('freezes provisional duration at the final snapshot and reports invalid clocks', () => {
		const provisional = provisionalSession();
		expect(buildCompanionStatus(input({ session: provisional, now: NOW + 999_000 })).items[1]?.detail)
			.toBe('00:05:00 · final snapshot captured');
		const invalid = { ...provisional, finalSnapshot: { ...provisional.finalSnapshot, completedAt: '2026-08-14T11:00:00.000Z' } };
		const projection = buildCompanionStatus(input({ session: invalid }));
		expect(projection.items[1]?.detail).toBe('— · final snapshot captured');
		expect(projection.errors[0]).toContain('clock window');
	});

	it('uses quality precedence review, delta, proposal, session summary, then recorder', () => {
		const proposal = detection('start_proposed');
		expect(buildCompanionStatus(input({ detection: proposal })).items[3]?.value).toBe('Limited');
		expect(buildCompanionStatus(input({
			detection: proposal,
			delta: { status: 'comparable' } as CompanionStatusInput['delta'],
		})).items[3]?.value).toBe('Complete');
		expect(buildCompanionStatus(input({
			detection: proposal,
			delta: { status: 'limited' } as CompanionStatusInput['delta'],
			review: { classification: { status: 'contaminated' } } as CompanionStatusInput['review'],
		})).items[3]?.value).toBe('Limited');
	});

	it('orders incidents by recovery, session, quality, detector, connection and recorder', () => {
		const projection = buildCompanionStatus(input({
			recovery: { status: 'error', message: 'Saved evidence is corrupt.' },
			detection: detection('error'),
			connection: { status: 'error', code: 'unavailable', message: 'Offline.', retryAt: null },
			qualityState: { status: 'unavailable', message: 'Recorder unavailable.' },
		}));
		expect(projection.errors[0]).toBe('Recovery: Saved evidence is corrupt.');
		expect(projection.surfaceTone).toBe('error');
		expect(projection.errors).toHaveLength(4);
	});

	it('drops cooldown metadata at expiry while keeping the underlying connection error', () => {
		const connection = { status: 'error', code: 'rate_limited', message: 'Too many requests.', retryAt: NOW + 1_000 } as const;
		const during = buildCompanionStatus(input({ connection, now: NOW }));
		const after = buildCompanionStatus(input({ connection, now: NOW + 1_000 }));
		expect(during.errors).toContain('Connection: retry cooldown is active.');
		expect(during.refreshEveryMs).toBe(1_000);
		expect(after.errors).not.toContain('Connection: retry cooldown is active.');
		expect(after.errors).toContain('Connection: Too many requests.');
		expect(after.refreshEveryMs).toBeNull();
	});

	it.each([
		[{ status: 'available', state: activeSession() }, 'Recovery available', 'recover'],
		[{ status: 'busy', state: activeSession(), message: 'Owned elsewhere.' }, 'Recovery blocked', 'none'],
		[{ status: 'working', action: 'recover', state: activeSession() }, 'Recovering', 'none'],
		[{ status: 'working', action: 'discard', state: activeSession() }, 'Discarding', 'none'],
		[{ status: 'error', message: 'Store failed.' }, 'Recovery error', 'none'],
	] as const)('gives recovery %s precedence in the header', (recovery, phase, action) => {
		const projection = buildCompanionStatus(input({ recovery }));
		expect(projection.items[1]?.value).toBe(phase);
		expect(projection.primaryAction).toBe(action);
	});

	it('shows available recovery as the first incident without losing phase or action', () => {
		const projection = buildCompanionStatus(input({
			recovery: { status: 'available', state: activeSession(), message: 'Resume the saved run.' },
			connection: { status: 'error', code: 'unavailable', message: 'Offline.', retryAt: null },
		}));
		expect(projection.errors[0]).toBe('Recovery: Resume the saved run.');
		expect(projection.items[1]?.value).toBe('Recovery available');
		expect(projection.primaryAction).toBe('recover');
	});

	it('exports exactly Detector, Polling, Quality and Account for the visible rail', () => {
		const rail = visibleRailItems(buildCompanionStatus(input()));
		expect(rail.map((item) => item.id)).toEqual(['detection', 'polling', 'quality', 'account']);
		expect(rail.map((item) => item.label)).toEqual(['Detection', 'Polling', 'Quality', 'Account']);
	});

	it('suppresses stale detector and scheduler failures while assisted detection is off', () => {
		const stale = detection('error');
		stale.scheduler.status = 'fatal';
		const projection = buildCompanionStatus(input({ detectionMode: 'off', detection: stale }));
		expect(projection.errors).toEqual([]);
		expect(values(projection).slice(0, 3)).toEqual(['Off', 'Idle', 'Off']);
	});

	it('places a stale connection warning before recorder and future-scope warnings', () => {
		const projection = buildCompanionStatus(input({
			connection: {
				status: 'warning', reason: 'stale_connection', message: 'Last verified account shown. Current check failed.', retryAt: null,
				details: connectionDetails(['characters']),
			},
			qualityState: { status: 'unavailable', message: 'Recorder failed.' },
		}));
		expect(projection.errors).toEqual([
			'Connection: Last verified account shown. Current check failed.',
			'Quality: Recorder failed.',
			'Account: 1 future permissions are missing.',
		]);
	});

	it('surfaces durable pending confirmations before ordinary connection incidents', () => {
		const projection = buildCompanionStatus(input({
			pendingProposals: { status: 'ready', pendingCount: 2, next: null },
			connection: { status: 'error', code: 'unavailable', message: 'Offline.', retryAt: null },
		}));
		expect(projection.errors[0]).toBe('Confirmations: 2 farming proposals waiting for review.');
		expect(projection.errors[1]).toBe('Connection: Offline.');
	});

	it('preserves long diagnostic text and large safe counters without truncating data', () => {
		const message = 'x'.repeat(512);
		const projection = buildCompanionStatus(input({
			detection: { ...detection('error'), message } as AssistedDetectionState,
			qualityStats: { acceptedBoundaries: Number.MAX_SAFE_INTEGER, correctedFalsePositives: 0, correctionsByCause: {
				not_farming: 0, still_farming: 0, temporary_pause: 0, unrelated_account_activity: 0, other: 0,
			} },
		}));
		expect(projection.errors.join(' ')).toContain(message);
		expect(projection.items[3]?.value).toContain(String(Number.MAX_SAFE_INTEGER));
	});
});

describe('formatElapsed', () => {
	it('does not wrap hours after one day', () => {
		expect(formatElapsed(123 * 3_600_000 + 4_000)).toBe('123:00:04');
	});
});

describe('status projection boundary', () => {
	it('has no live Obsidian, network, timer, or storage dependency', () => {
		const source = readFileSync(new URL('./companion-status-model.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/from ['"]obsidian['"]|requestUrl|\bfetch\s*\(|setInterval|localStorage|indexedDB/);
	});

	it('prevents timer ticks from rebuilding the view and stealing focus', () => {
		const source = readFileSync(new URL('./companion-view.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/setInterval\s*\(\s*\(\)\s*=>\s*this\.render\s*\(/);
		expect(source).toContain('setInterval(() => this.refreshDynamicStatus()');
		expect(source).toContain('for (const status of visibleRailItems(projection))');
		expect(source).toContain('this.checkButton.disabled');
		expect(source).toContain('this.incident.hidden');
	});
});

function input(overrides: Partial<CompanionStatusInput> = {}): CompanionStatusInput {
	return {
		now: NOW,
		connection: { status: 'idle' },
		session: { version: 1, status: 'idle' },
		detectionMode: 'assisted',
		detection: detection('disarmed'),
		qualityState: { status: 'ready' },
		qualityStats: null,
		sessionQuality: null,
		delta: null,
		review: null,
		recovery: { status: 'none' },
		startFailure: null,
		stopFailure: null,
		pendingProposals: { status: 'ready', pendingCount: 0, next: null },
		...overrides,
	};
}

function scheduler() {
	return {
		status: 'scheduled' as const,
		intervalMs: 60_000,
		nextRunAt: NOW + 30_000,
		lastAttemptAt: NOW - 60_000,
		lastSuccessAt: NOW - 60_000,
		consecutiveFailures: 0,
	};
}

function detection(status: AssistedDetectionState['status']): AssistedDetectionState {
	const base = { scheduler: scheduler(), lastSnapshotAt: '2026-08-14T11:59:00.000Z' };
	if (status === 'disarmed') return { ...base, status, reason: 'initial' };
	if (status === 'arming') return { ...base, status, requestedAt: '2026-08-14T11:59:00.000Z' };
	if (status === 'armed') return { ...base, status, armedAt: '2026-08-14T11:59:00.000Z' };
	if (status === 'error') return { ...base, status, message: 'Detector failed.' };
	const window = { from: '2026-08-14T11:58:00.000Z', to: '2026-08-14T11:59:00.000Z', uncertaintyMs: 60_000 };
	if (status === 'start_proposed') return {
		...base, status, armedAt: window.from,
		proposal: { possibleStart: window, evidenceQuality: 'limited' },
	} as AssistedDetectionState;
	return {
		...base, status, armedAt: window.from,
		proposal: { possibleStop: window, evidenceQuality: 'complete' },
	} as AssistedDetectionState;
}

function activeSession(): Extract<SessionState, { status: 'active' }> {
	return {
		version: 1, status: 'active', sessionId: 'session-1', requestedAt: '2026-08-14T11:59:00.000Z',
		authority: { machineId: 'machine', instanceId: 'instance', sessionId: 'session-1', fence: 1, acquiredAt: NOW - 60_000 },
		baseline: { snapshotId: 'before', accountId: 'account', schemaVersion: '2024-07-20T01:00:00.000Z', startedAt: '2026-08-14T11:59:59.000Z', completedAt: new Date(NOW).toISOString(), quality: 'stable' },
		startContext: { characterName: 'Ranger', magicFind: { value: 100, source: 'manual' }, capturedAt: new Date(NOW).toISOString(), build: {
			tab: 1, name: 'Open world', profession: 'Ranger', specializations: [],
			skills: { heal: null, utilities: [], elite: null }, aquaticSkills: { heal: null, utilities: [], elite: null },
		} },
	};
}

function provisionalSession(): Extract<SessionState, { status: 'provisional' }> {
	const active = activeSession();
	return { ...active, status: 'provisional', stopRequestedAt: new Date(NOW + 240_000).toISOString(), stoppedAt: new Date(NOW + 300_000).toISOString(),
		finalSnapshot: { ...active.baseline, snapshotId: 'after', startedAt: new Date(NOW + 299_000).toISOString(), completedAt: new Date(NOW + 300_000).toISOString() } };
}

function values(projection: ReturnType<typeof buildCompanionStatus>): string[] {
	return projection.items.map((status) => status.value);
}

function connectionDetails(missingRecommendedScopes: string[]) {
	return {
		account: { id: 'account', name: 'Account.1234', world: 1001, created: '2020-01-01T00:00:00Z', access: ['GuildWars2'], commander: false },
		keyName: 'Main key', scopes: ['account'], missingRecommendedScopes, hasFutureUrlRestrictions: false,
	};
}
