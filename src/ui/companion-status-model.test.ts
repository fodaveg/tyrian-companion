import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { SessionState } from '../sessions/session';
import type { SessionStartFailure, SessionStopFailure } from '../sessions/manual-session-start-service';
import {
	buildCompanionStatus,
	localizedClassificationStatus,
	localizedConfidence,
	localizedCoverageStatus,
	localizedDeltaStatus,
	formatElapsed,
	type CompanionStatusInput,
} from './companion-status-model';
import { createTranslator } from '../core/i18n';
import type { RuntimeTranslationKey } from '../core/i18n-runtime-catalog';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

describe('buildCompanionStatus', () => {
	it('localizes every visible closed enum in Spanish and English', () => {
		for (const [locale, expected] of [
			['es', {
				coverage: ['Completa', 'Limitada', 'Desconocida'],
				delta: ['Comparable', 'Limitado', 'No válido'],
				classification: ['Exacta', 'Estimada', 'Contaminada', 'No válida'],
				confidence: ['Alta', 'Media', 'Baja'],
			}],
			['en', {
				coverage: ['Complete', 'Limited', 'Unknown'],
				delta: ['Comparable', 'Limited', 'Invalid'],
				classification: ['Exact', 'Estimated', 'Contaminated', 'Invalid'],
				confidence: ['High', 'Medium', 'Low'],
			}],
		] as const) {
			const translator = createTranslator(locale);
			const text = (key: RuntimeTranslationKey, params?: Record<string, string | number>) => translator.t(key, params);
			expect((['complete', 'limited', 'unknown'] as const).map((status) => localizedCoverageStatus(status, text))).toEqual(expected.coverage);
			expect((['comparable', 'limited', 'invalid'] as const).map((status) => localizedDeltaStatus(status, text))).toEqual(expected.delta);
			expect((['exact', 'estimated', 'contaminated', 'invalid'] as const).map((status) => localizedClassificationStatus(status, text))).toEqual(expected.classification);
			expect((['high', 'medium', 'low'] as const).map((status) => localizedConfidence(status, text))).toEqual(expected.confidence);
		}
	});
	it('projects status labels in the requested locale without changing domain states', () => {
		const es = buildCompanionStatus(input({ locale: 'es', detection: detection('armed') }));
		const en = buildCompanionStatus(input({ locale: 'en', detection: detection('armed') }));
		expect(es.items[0]).toMatchObject({ label: 'Detección', value: 'Activada' });
		expect(en.items[0]).toMatchObject({ label: 'Detection', value: 'Armed' });
		expect(es.items[0]?.id).toBe(en.items[0]?.id);
	});

	it.each([
		['busy', 'Inicio: Ya hay una sesión o recuperación pendiente. Resuélvela antes de iniciar otra.', 'Start: A session or recovery is already pending. Resolve it before starting another one.'],
		['coordination_unavailable', 'Inicio: La coordinación local no está disponible. Recarga Obsidian antes de volver a iniciar.', 'Start: Local coordination is unavailable. Reload Obsidian before starting again.'],
		['invalid_input', 'Inicio: Los datos de inicio no son válidos. Revisa el personaje y el Hallazgo mágico.', 'Start: The start details are invalid. Review the character and Magic Find.'],
		['missing_capability', 'Inicio: La clave API no permite leer la configuración del personaje. Añade el permiso builds y vuelve a comprobar la conexión.', 'Start: The API key cannot read the character build. Add the builds permission and check the connection again.'],
		['snapshot_failed', 'Inicio: No se pudo capturar la línea base. Comprueba la conexión y vuelve a iniciar.', 'Start: The baseline could not be captured. Check the connection and start again.'],
		['lease_lost', 'Inicio: Otra ventana tomó la autoridad de la sesión. Resuelve la sesión allí antes de reintentar.', 'Start: Another window took session authority. Resolve the session there before retrying.'],
		['rate_limited', 'Inicio: Guild Wars 2 está limitando las peticiones. Espera a que termine el enfriamiento compartido y vuelve a iniciar.', 'Start: Guild Wars 2 is rate limiting requests. Wait for the shared cooldown to end and start again.'],
		['unexpected', 'Inicio: No se pudo iniciar la sesión. Comprueba la conexión y vuelve a intentarlo.', 'Start: The session could not be started. Check the connection and try again.'],
	] satisfies ReadonlyArray<readonly [SessionStartFailure['code'], string, string]>)('projects actionable start failure %s in ES and EN', (code, es, en) => {
		const failure = { code, message: 'untrusted runtime detail' } satisfies SessionStartFailure;
		expect(buildCompanionStatus(input({ locale: 'es', startFailure: failure })).errors).toEqual([es]);
		expect(buildCompanionStatus(input({ locale: 'en', startFailure: failure })).errors).toEqual([en]);
	});

	it.each([
		['coordination_unavailable', 'Final: La coordinación local no está disponible. Recarga Obsidian, recupera la sesión guardada y vuelve a terminarla.', 'Stop: Local coordination is unavailable. Reload Obsidian, recover the saved session, and finish it again.'],
		['snapshot_failed', 'Final: No se pudo capturar la instantánea final. La línea base está a salvo; comprueba la conexión y vuelve a terminar.', 'Stop: The final snapshot could not be captured. The baseline is safe; check the connection and finish again.'],
		['lease_lost', 'Final: Otra ventana tomó la autoridad de la sesión. Termínala o recupérala allí antes de reintentar.', 'Stop: Another window took session authority. Finish or recover the session there before retrying.'],
		['delta_invalid', 'Final: La instantánea final no se pudo comparar con la línea base. Conserva la sesión, comprueba la cuenta y la conexión y vuelve a terminar.', 'Stop: The final snapshot could not be compared with the baseline. Keep the session, check the account and connection, and finish again.'],
		['rate_limited', 'Final: Guild Wars 2 está limitando las peticiones. Espera a que termine el enfriamiento compartido y vuelve a terminar.', 'Stop: Guild Wars 2 is rate limiting requests. Wait for the shared cooldown to end and finish again.'],
		['unexpected', 'Final: No se pudo terminar la sesión. Conserva el estado actual, revísalo en el Acompañante y vuelve a intentarlo.', 'Stop: The session could not be finished. Keep the current state, review it in Companion, and try again.'],
	] satisfies ReadonlyArray<readonly [SessionStopFailure['code'], string, string]>)('projects actionable stop failure %s in ES and EN', (code, es, en) => {
		const failure = { code, message: 'untrusted runtime detail' } satisfies SessionStopFailure;
		expect(buildCompanionStatus(input({ locale: 'es', stopFailure: failure })).errors).toEqual([es]);
		expect(buildCompanionStatus(input({ locale: 'en', stopFailure: failure })).errors).toEqual([en]);
	});
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

	it('freezes provisional duration at the stop boundary and reports invalid clocks', () => {
		const provisional = provisionalSession();
		expect(buildCompanionStatus(input({ session: provisional, now: NOW + 999_000 })).items[1]?.detail)
			.toBe('00:05:00 · final snapshot captured');
		// The final capture waits out the API settlement window, so it lands minutes after the
		// player stopped and must not stretch the duration the note bills for that same session.
		const late = { ...provisional, finalSnapshot: { ...provisional.finalSnapshot, completedAt: new Date(NOW + 900_000).toISOString() } };
		expect(buildCompanionStatus(input({ session: late })).items[1]?.detail)
			.toBe('00:05:00 · final snapshot captured');
		// The stop boundary is therefore the timestamp whose corruption has to surface as a dash.
		const invalid = { ...provisional, stoppedAt: '2026-08-14T11:00:00.000Z' };
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
			recovery: { status: 'error', code: 'corrupt', message: 'Saved evidence is corrupt.' },
			detection: detection('error'),
			connection: { status: 'error', code: 'unavailable', message: 'Offline.', retryAt: null },
			qualityState: { status: 'unavailable', message: 'Recorder unavailable.' },
		}));
		expect(projection.errors[0]).toBe('Recovery: The saved farming session could not be read and was left untouched. Discard it to use the session controls again.');
		expect(projection.incidentTone).toBe('error');
		expect(projection.errors).toHaveLength(4);
	});

	it('gives a corrupt record and an unreachable store two different recovery texts', () => {
		const corrupt = buildCompanionStatus(input({ recovery: { status: 'error', code: 'corrupt', message: 'raw' } }));
		const unavailable = buildCompanionStatus(input({ recovery: { status: 'error', code: 'unavailable', message: 'raw' } }));

		expect(corrupt.items[1]?.detail).not.toBe(unavailable.items[1]?.detail);
		expect(corrupt.items[1]?.detail).toBe('The saved farming session could not be read and was left untouched. Discard it to use the session controls again.');
		expect(unavailable.items[1]?.detail).toBe('The local recovery store is unavailable. Reload Obsidian and try again.');

		expect(corrupt.errors[0]).not.toBe(unavailable.errors[0]);
	});

	it('drops cooldown metadata at expiry while keeping the underlying connection error', () => {
		const connection = { status: 'error', code: 'rate_limited', message: 'Too many requests.', retryAt: NOW + 1_000 } as const;
		const during = buildCompanionStatus(input({ connection, now: NOW }));
		const after = buildCompanionStatus(input({ connection, now: NOW + 1_000 }));
		expect(during.errors).toContain('Connection: retry cooldown is active.');
		expect(during.refreshEveryMs).toBe(1_000);
		expect(after.errors).not.toContain('Connection: retry cooldown is active.');
		expect(after.errors).toContain('Connection: The operation could not be completed safely.');
		expect(after.refreshEveryMs).toBeNull();
	});

	it('keeps start and stop 429 copy separate from the connection incident and live cooldown', () => {
		const projection = buildCompanionStatus(input({
			startFailure: { code: 'rate_limited', message: 'raw start 429' },
			stopFailure: { code: 'rate_limited', message: 'raw stop 429' },
			connection: { status: 'error', code: 'rate_limited', message: 'raw connection 429', retryAt: NOW + 1_000 },
		}));

		expect(projection.errors).toEqual([
			'Start: Guild Wars 2 is rate limiting requests. Wait for the shared cooldown to end and start again.',
			'Stop: Guild Wars 2 is rate limiting requests. Wait for the shared cooldown to end and finish again.',
			'Connection: The operation could not be completed safely.',
			'Connection: retry cooldown is active.',
		]);
		expect(projection.refreshEveryMs).toBe(1_000);
	});

	it.each([
		[{ status: 'available', state: activeSession() }, 'Recovery available'],
		[{ status: 'busy', state: activeSession(), message: 'Owned elsewhere.' }, 'Recovery blocked'],
		[{ status: 'working', action: 'recover', state: activeSession() }, 'Recovering'],
		[{ status: 'working', action: 'discard', state: activeSession() }, 'Discarding'],
		[{ status: 'error', code: 'unavailable', message: 'Store failed.' }, 'Recovery error'],
	] as const)('gives recovery %s precedence in the header', (recovery, phase) => {
		const projection = buildCompanionStatus(input({ recovery }));
		expect(projection.items[1]?.value).toBe(phase);
	});

	it('shows available recovery as the first incident without losing the phase', () => {
		const projection = buildCompanionStatus(input({
			recovery: { status: 'available', state: activeSession(), message: 'Resume the saved run.' },
			connection: { status: 'error', code: 'unavailable', message: 'Offline.', retryAt: null },
		}));
		expect(projection.errors[0]).toBe('Recovery: A saved farming session needs a decision.');
		expect(projection.items[1]?.value).toBe('Recovery available');
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
			'Connection: Attention',
			'Quality: Unavailable',
			'Account: 1 future permissions are missing.',
		]);
	});

	it('surfaces durable pending confirmations before ordinary connection incidents', () => {
		const projection = buildCompanionStatus(input({
			pendingProposals: { status: 'ready', pendingCount: 2, next: null },
			connection: { status: 'error', code: 'unavailable', message: 'Offline.', retryAt: null },
		}));
		expect(projection.errors[0]).toBe('Confirmations: 2 farming proposals waiting for review.');
		expect(projection.errors[1]).toBe('Connection: The operation could not be completed safely.');
	});

	it('preserves long diagnostic text and large safe counters without truncating data', () => {
		const message = 'x'.repeat(512);
		const projection = buildCompanionStatus(input({
			detection: { ...detection('error'), message } as AssistedDetectionState,
			qualityStats: { acceptedBoundaries: Number.MAX_SAFE_INTEGER, correctedFalsePositives: 0, correctionsByCause: {
				not_farming: 0, still_farming: 0, temporary_pause: 0, unrelated_account_activity: 0, other: 0,
			} },
		}));
		expect(projection.errors.join(' ')).not.toContain(message);
		expect(projection.errors).toContain('Detection: Detection stopped.');
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
