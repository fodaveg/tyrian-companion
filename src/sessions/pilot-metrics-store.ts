import {
	PILOT_METRICS_MAX_OBSERVATIONS,
	isPilotEnvironment,
	isLegacyPilotVerification,
	isPilotObservation,
	isPilotVerification,
	isSampleRevision,
	pilotObservationKey,
	type PilotEnvironmentV1,
	type PilotJournalSnapshotV1,
	type PilotObservationV1,
	type PilotProposalObservationV1,
	type PilotProposalTerminalV1,
	type PilotRecoveryObservationV1,
	type PilotRecoveryKind,
	type PilotSessionObservationV1,
	type PilotVerificationV1,
} from './pilot-metrics-model';
import { openIndexedDb } from '../core/indexed-db-open';

export const PILOT_METRICS_DB_NAME = 'tyrian-companion-pilot-metrics';
export const PILOT_METRICS_DB_VERSION = 2;
export const PILOT_METRICS_PROFILE_STORE = 'profile-v1';
export const PILOT_METRICS_OBSERVATION_STORE = 'observations-v1';
export const PILOT_METRICS_VERIFICATION_STORE = 'verification-v1';
const PILOT_METRICS_SAMPLE_REVISION_KEY = 'sample-revision';

export type PilotStoreResult<T = undefined> =
	| { status: 'ok'; value: T }
	| { status: 'duplicate'; value: T }
	| { status: 'missing' }
	| { status: 'stale' }
	| { status: 'error'; code: 'unavailable' | 'inconsistent' | 'full' | 'unconfigured' };

export interface PilotMetricsStore {
	load(): Promise<PilotStoreResult<PilotJournalSnapshotV1>>;
	loadProfile(): Promise<PilotStoreResult<PilotEnvironmentV1>>;
	saveProfile(profile: PilotEnvironmentV1): Promise<PilotStoreResult<PilotEnvironmentV1>>;
	saveVerification(verification: PilotVerificationV1): Promise<PilotStoreResult<PilotVerificationV1>>;
	ensureObservation(observation: PilotObservationV1): Promise<PilotStoreResult<PilotObservationV1>>;
	finishProposal(proposalRef: string, terminal: PilotProposalTerminalV1, allowMissing?: boolean): Promise<PilotStoreResult<PilotProposalObservationV1>>;
	finishSession(sessionRef: string, completedAt: string, allowMissing?: boolean): Promise<PilotStoreResult<PilotSessionObservationV1>>;
	finishRecovery(recoveryRef: string, terminal: NonNullable<PilotRecoveryObservationV1['terminal']>, allowMissing?: boolean): Promise<PilotStoreResult<PilotRecoveryObservationV1>>;
	classifyRecovery(recoveryRef: string, recoveryKind: PilotRecoveryKind): Promise<PilotStoreResult<PilotRecoveryObservationV1>>;
	clearObservations(): Promise<PilotStoreResult<number>>;
	disable(): Promise<PilotStoreResult<number>>;
	close(): void;
}

/** Lazy IndexedDB journal. No product action depends on this store opening or succeeding. */
export class IndexedDbPilotMetricsStore implements PilotMetricsStore {
	private database: Promise<IDBDatabase> | null = null;
	private unavailable = false;

	constructor(
		private readonly indexedDb: IDBFactory,
		vaultId: string,
		databaseName = PILOT_METRICS_DB_NAME,
		private readonly maximumObservations = PILOT_METRICS_MAX_OBSERVATIONS,
	) {
		if (vaultId.length === 0 || vaultId.length > 128) throw new TypeError('Pilot metrics vault scope is invalid.');
		this.databaseName = `${databaseName}:${vaultId}`;
	}

	private readonly databaseName: string;

	async load(): Promise<PilotStoreResult<PilotJournalSnapshotV1>> {
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_VERIFICATION_STORE, PILOT_METRICS_OBSERVATION_STORE,
			], 'readonly');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const profileRequest = requestValue(profiles.get('active') as IDBRequest<unknown>);
			const revisionRequest = requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>);
			const verificationRequest = requestValue(transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).get('active') as IDBRequest<unknown>);
			const observationsRequest = requestValue(transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE)
				.getAll(undefined, this.maximumObservations + 1) as IDBRequest<unknown[]>);
			const [profile, storedRevision, storedVerification, raw] = await Promise.all([
				profileRequest, revisionRequest, verificationRequest, observationsRequest,
			]);
			await transactionDone(transaction);
			if (profile === undefined) return { status: 'error', code: 'unconfigured' };
			if (!isPilotEnvironment(profile)) return { status: 'error', code: 'inconsistent' };
			const sampleRevision = normalizeSampleRevision(storedRevision);
			if (sampleRevision === null) return { status: 'error', code: 'inconsistent' };
			if (storedVerification !== undefined && !isPilotVerification(storedVerification) &&
				!isLegacyPilotVerification(storedVerification)) return { status: 'error', code: 'inconsistent' };
			const verification = isPilotVerification(storedVerification) && storedVerification.sampleRevision === sampleRevision
				? storedVerification : undefined;
			if (isPilotVerification(verification) && !sameEnvironment(profile, verification.environment)) {
				return { status: 'error', code: 'inconsistent' };
			}
			if (raw.length > this.maximumObservations) return { status: 'error', code: 'full' };
			if (!raw.every(isPilotObservation)) return { status: 'error', code: 'inconsistent' };
			const observations = raw.sort(compareObservations).map((entry) => structuredClone(entry));
			return { status: 'ok', value: {
				version: 1, profile: structuredClone(profile), sampleRevision,
				verification: verification === undefined ? null : structuredClone(verification), observations,
			} };
		} catch { return this.failed(); }
	}

	async loadProfile(): Promise<PilotStoreResult<PilotEnvironmentV1>> {
		try {
			const profile = await this.read(PILOT_METRICS_PROFILE_STORE, 'active');
			if (profile === undefined) return { status: 'error', code: 'unconfigured' };
			return isPilotEnvironment(profile)
				? { status: 'ok', value: structuredClone(profile) }
				: { status: 'error', code: 'inconsistent' };
		} catch { return this.failed(); }
	}

	async saveProfile(profile: PilotEnvironmentV1): Promise<PilotStoreResult<PilotEnvironmentV1>> {
		if (!isPilotEnvironment(profile)) return { status: 'error', code: 'inconsistent' };
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const [existing, storedRevision] = await Promise.all([
				requestValue(profiles.get('active') as IDBRequest<unknown>),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
			]);
			const sampleRevision = normalizeSampleRevision(storedRevision);
			if (sampleRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			const changed = !isPilotEnvironment(existing) || !sameEnvironment(existing, profile);
			const nextRevision = changed ? incrementSampleRevision(sampleRevision) : sampleRevision;
			if (nextRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			profiles.put(structuredClone(profile), 'active');
			profiles.put(nextRevision, PILOT_METRICS_SAMPLE_REVISION_KEY);
			if (changed) {
				transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).delete('active');
			}
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(profile) };
		} catch { return this.failed(); }
	}

	async saveVerification(verification: PilotVerificationV1): Promise<PilotStoreResult<PilotVerificationV1>> {
		if (!isPilotVerification(verification)) return { status: 'error', code: 'inconsistent' };
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const [profile, storedRevision] = await Promise.all([
				requestValue(profiles.get('active') as IDBRequest<unknown>),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
			]);
			const sampleRevision = normalizeSampleRevision(storedRevision);
			if (sampleRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			if (profile !== undefined && !isPilotEnvironment(profile)) {
				transaction.abort();
				return { status: 'error', code: 'inconsistent' };
			}
			if (verification.sampleRevision !== sampleRevision) { transaction.abort(); return { status: 'stale' }; }
			if (profile === undefined) {
				transaction.abort();
				return { status: 'error', code: 'unconfigured' };
			}
			if (!sameEnvironment(profile, verification.environment)) {
				transaction.abort();
				return { status: 'error', code: 'inconsistent' };
			}
			transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).put(structuredClone(verification), 'active');
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(verification) };
		} catch { return this.failed(); }
	}

	async ensureObservation(observation: PilotObservationV1): Promise<PilotStoreResult<PilotObservationV1>> {
		if (!isPilotObservation(observation)) return { status: 'error', code: 'inconsistent' };
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const key = pilotObservationKey(observation);
			const [profile, storedRevision, existing, count] = await Promise.all([
				requestValue(profiles.get('active') as IDBRequest<unknown>),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
				requestValue(store.get(key) as IDBRequest<unknown>),
				requestValue(store.count()),
			]);
			if (!isPilotEnvironment(profile) || !sameEnvironment(profile, observation.environment)) {
				transaction.abort();
				return { status: 'error', code: profile === undefined ? 'unconfigured' : 'inconsistent' };
			}
			if (existing !== undefined) {
				transaction.abort();
				if (!isPilotObservation(existing) || !samePresentation(existing, observation)) {
					return { status: 'error', code: 'inconsistent' };
				}
				return { status: 'duplicate', value: structuredClone(existing) };
			}
			if (count >= this.maximumObservations) {
				transaction.abort();
				return { status: 'error', code: 'full' };
			}
			const nextRevision = nextStoredSampleRevision(storedRevision);
			if (nextRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			store.add(structuredClone(observation), key);
			profiles.put(nextRevision, PILOT_METRICS_SAMPLE_REVISION_KEY);
			transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).delete('active');
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(observation) };
		} catch { return this.failed(); }
	}

	async finishProposal(
		proposalRef: string,
		terminal: PilotProposalTerminalV1,
		allowMissing = false,
	): Promise<PilotStoreResult<PilotProposalObservationV1>> {
		return await this.finish<PilotProposalObservationV1>(`proposal:${proposalRef}`, (existing) => {
			if (!isPilotObservation(existing) || existing.kind !== 'proposal') return null;
			const candidate = { ...existing, terminal };
			return isPilotObservation(candidate) && candidate.kind === 'proposal' ? candidate : null;
		}, allowMissing);
	}

	async finishSession(sessionRef: string, completedAt: string, allowMissing = false): Promise<PilotStoreResult<PilotSessionObservationV1>> {
		return await this.finish<PilotSessionObservationV1>(`session:${sessionRef}`, (existing) => {
			if (!isPilotObservation(existing) || existing.kind !== 'session') return null;
			const candidate = { ...existing, completedAt };
			return isPilotObservation(candidate) && candidate.kind === 'session' ? candidate : null;
		}, allowMissing);
	}

	async finishRecovery(
		recoveryRef: string,
		terminal: NonNullable<PilotRecoveryObservationV1['terminal']>,
		allowMissing = false,
	): Promise<PilotStoreResult<PilotRecoveryObservationV1>> {
		return await this.finish<PilotRecoveryObservationV1>(`recovery:${recoveryRef}`, (existing) => {
			if (!isPilotObservation(existing) || existing.kind !== 'recovery') return null;
			const candidate = { ...existing, terminal };
			return isPilotObservation(candidate) && candidate.kind === 'recovery' ? candidate : null;
		}, allowMissing);
	}

	async classifyRecovery(
		recoveryRef: string,
		recoveryKind: PilotRecoveryKind,
	): Promise<PilotStoreResult<PilotRecoveryObservationV1>> {
		return await this.updateRecovery(`recovery:${recoveryRef}`, (existing) => ({ ...existing, recoveryKind }));
	}

	async clearObservations(): Promise<PilotStoreResult<number>> {
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const [count, storedRevision] = await Promise.all([
				requestValue(store.count()),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
			]);
			const sampleRevision = normalizeSampleRevision(storedRevision);
			if (sampleRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			if (count > 0) {
				const nextRevision = incrementSampleRevision(sampleRevision);
				if (nextRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
				profiles.put(nextRevision, PILOT_METRICS_SAMPLE_REVISION_KEY);
			}
			store.clear();
			transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).clear();
			await transactionDone(transaction);
			return { status: 'ok', value: count };
		} catch { return this.failed(); }
	}

	async disable(): Promise<PilotStoreResult<number>> {
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const observations = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const [count, storedRevision] = await Promise.all([
				requestValue(observations.count()),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
			]);
			const nextRevision = nextStoredSampleRevision(storedRevision);
			if (nextRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			observations.clear();
			profiles.delete('active');
			// A generation counter carries no profile or evidence and prevents ABA after opt-in is restored.
			profiles.put(nextRevision, PILOT_METRICS_SAMPLE_REVISION_KEY);
			transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).clear();
			await transactionDone(transaction);
			return { status: 'ok', value: count };
		} catch { return this.failed(); }
	}

	close(): void {
		void this.database?.then((database) => database.close()).catch(() => undefined);
		this.database = null;
		this.unavailable = true;
	}

	private async finish<T extends PilotObservationV1>(
		key: string,
		update: (existing: unknown) => T | null,
		allowMissing = false,
	): Promise<PilotStoreResult<T>> {
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const [existing, storedRevision] = await Promise.all([
				requestValue(store.get(key) as IDBRequest<unknown>),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
			]);
			if (existing === undefined) {
				transaction.abort();
				return allowMissing ? { status: 'missing' } : { status: 'error', code: 'inconsistent' };
			}
			const candidate = update(existing);
			if (!candidate) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			const currentTerminal = existingTerminal(existing);
			const nextTerminal = existingTerminal(candidate);
			if (currentTerminal !== null) {
				transaction.abort();
				if (isSealedWorkflowFailure(existing)) {
					return { status: 'duplicate', value: structuredClone(existing as T) };
				}
				return JSON.stringify(currentTerminal) === JSON.stringify(nextTerminal)
					? { status: 'duplicate', value: structuredClone(existing as T) }
					: { status: 'error', code: 'inconsistent' };
			}
			const nextRevision = nextStoredSampleRevision(storedRevision);
			if (nextRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			store.put(structuredClone(candidate), key);
			profiles.put(nextRevision, PILOT_METRICS_SAMPLE_REVISION_KEY);
			transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).delete('active');
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(candidate) };
		} catch { return this.failed(); }
	}

	private async updateRecovery(
		key: string,
		update: (existing: PilotRecoveryObservationV1) => PilotRecoveryObservationV1,
	): Promise<PilotStoreResult<PilotRecoveryObservationV1>> {
		try {
			const database = await this.open();
			const transaction = database.transaction([
				PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE,
			], 'readwrite');
			const profiles = transaction.objectStore(PILOT_METRICS_PROFILE_STORE);
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const [existing, storedRevision] = await Promise.all([
				requestValue(store.get(key) as IDBRequest<unknown>),
				requestValue(profiles.get(PILOT_METRICS_SAMPLE_REVISION_KEY) as IDBRequest<unknown>),
			]);
			if (!isPilotObservation(existing) || existing.kind !== 'recovery') {
				transaction.abort();
				return { status: 'error', code: 'inconsistent' };
			}
			if (existing.recoveryKind !== null) {
				transaction.abort();
				return existing.recoveryKind === update(existing).recoveryKind
					? { status: 'duplicate', value: structuredClone(existing) }
					: { status: 'error', code: 'inconsistent' };
			}
			const candidate = update(existing);
			if (!isPilotObservation(candidate) || candidate.kind !== 'recovery') {
				transaction.abort();
				return { status: 'error', code: 'inconsistent' };
			}
			const nextRevision = nextStoredSampleRevision(storedRevision);
			if (nextRevision === null) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			store.put(structuredClone(candidate), key);
			profiles.put(nextRevision, PILOT_METRICS_SAMPLE_REVISION_KEY);
			transaction.objectStore(PILOT_METRICS_VERIFICATION_STORE).delete('active');
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(candidate) };
		} catch { return this.failed(); }
	}

	private async read(storeName: string, key: IDBValidKey): Promise<unknown> {
		const database = await this.open();
		const transaction = database.transaction(storeName, 'readonly');
		const value = await requestValue(transaction.objectStore(storeName).get(key) as IDBRequest<unknown>);
		await transactionDone(transaction);
		return value;
	}

	private async open(): Promise<IDBDatabase> {
		if (this.unavailable) throw new Error('Pilot metrics storage is unavailable.');
		this.database ??= openIndexedDb({
			factory: this.indexedDb,
			databaseName: this.databaseName,
			databaseVersion: PILOT_METRICS_DB_VERSION,
			schema: [
				{ name: PILOT_METRICS_PROFILE_STORE },
				{ name: PILOT_METRICS_OBSERVATION_STORE },
				{ name: PILOT_METRICS_VERIFICATION_STORE },
			],
			onVersionChange: () => { this.unavailable = true; },
			toError: (reason) => new Error(reason === 'blocked'
				? 'Pilot metrics storage upgrade was blocked.'
				: 'Could not open pilot metrics storage.'),
		});
		return await this.database;
	}

	private failed<T>(): PilotStoreResult<T> {
		this.unavailable = true;
		return { status: 'error', code: 'unavailable' };
	}
}

function samePresentation(existing: PilotObservationV1, candidate: PilotObservationV1): boolean {
	if (existing.kind !== candidate.kind) return false;
	if (existing.kind === 'proposal' && candidate.kind === 'proposal') {
		return JSON.stringify({
			proposalRef: existing.proposalRef, phase: existing.phase, mode: existing.mode,
			window: existing.window, pollingIntervalMs: existing.pollingIntervalMs,
			evidenceQuality: existing.evidenceQuality,
		}) === JSON.stringify({
			proposalRef: candidate.proposalRef, phase: candidate.phase, mode: candidate.mode,
			window: candidate.window, pollingIntervalMs: candidate.pollingIntervalMs,
			evidenceQuality: candidate.evidenceQuality,
		});
	}
	if (existing.kind === 'session' && candidate.kind === 'session') {
		return JSON.stringify({ ...existing, completedAt: null }) === JSON.stringify({ ...candidate, completedAt: null });
	}
	if (existing.kind === 'recovery' && candidate.kind === 'recovery') {
		return existing.recoveryRef === candidate.recoveryRef;
	}
	return false;
}

function sameEnvironment(a: PilotEnvironmentV1, b: PilotEnvironmentV1): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function existingTerminal(value: unknown): unknown {
	if (!isPilotObservation(value)) return null;
	return value.kind === 'session' ? value.completedAt : value.terminal;
}

function isSealedWorkflowFailure(value: unknown): value is PilotProposalObservationV1 {
	return isPilotObservation(value) && value.kind === 'proposal' &&
		value.terminal?.effectiveResult === 'accepted_workflow_failed';
}

function normalizeSampleRevision(value: unknown): number | null {
	return value === undefined ? 0 : isSampleRevision(value) ? value : null;
}

function nextStoredSampleRevision(value: unknown): number | null {
	const current = normalizeSampleRevision(value);
	return current === null ? null : incrementSampleRevision(current);
}

function incrementSampleRevision(value: number): number | null {
	const next = value + 1;
	return isSampleRevision(next) ? next : null;
}

function compareObservations(a: PilotObservationV1, b: PilotObservationV1): number {
	const at = a.kind === 'proposal' ? a.reviewPresentedAt : a.kind === 'session' ? a.startedAt : a.presentedAt;
	const bt = b.kind === 'proposal' ? b.reviewPresentedAt : b.kind === 'session' ? b.startedAt : b.presentedAt;
	return at.localeCompare(bt) || pilotObservationKey(a).localeCompare(pilotObservationKey(b));
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Pilot metrics request failed.'));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('Pilot metrics transaction failed.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('Pilot metrics transaction aborted.'));
	});
}
