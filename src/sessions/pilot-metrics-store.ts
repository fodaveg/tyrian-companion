import {
	PILOT_METRICS_MAX_OBSERVATIONS,
	isPilotEnvironment,
	isPilotObservation,
	pilotObservationKey,
	type PilotEnvironmentV1,
	type PilotJournalSnapshotV1,
	type PilotObservationV1,
	type PilotProposalObservationV1,
	type PilotProposalTerminalV1,
	type PilotRecoveryObservationV1,
	type PilotSessionObservationV1,
} from './pilot-metrics-model';

export const PILOT_METRICS_DB_NAME = 'tyrian-companion-pilot-metrics';
export const PILOT_METRICS_DB_VERSION = 1;
export const PILOT_METRICS_PROFILE_STORE = 'profile-v1';
export const PILOT_METRICS_OBSERVATION_STORE = 'observations-v1';

export type PilotStoreResult<T = undefined> =
	| { status: 'ok'; value: T }
	| { status: 'duplicate'; value: T }
	| { status: 'error'; code: 'unavailable' | 'inconsistent' | 'full' | 'unconfigured' };

export interface PilotMetricsStore {
	load(): Promise<PilotStoreResult<PilotJournalSnapshotV1>>;
	loadProfile(): Promise<PilotStoreResult<PilotEnvironmentV1>>;
	saveProfile(profile: PilotEnvironmentV1): Promise<PilotStoreResult<PilotEnvironmentV1>>;
	ensureObservation(observation: PilotObservationV1): Promise<PilotStoreResult<PilotObservationV1>>;
	finishProposal(proposalRef: string, terminal: PilotProposalTerminalV1): Promise<PilotStoreResult<PilotProposalObservationV1>>;
	finishSession(sessionRef: string, completedAt: string): Promise<PilotStoreResult<PilotSessionObservationV1>>;
	finishRecovery(recoveryRef: string, terminal: NonNullable<PilotRecoveryObservationV1['terminal']>): Promise<PilotStoreResult<PilotRecoveryObservationV1>>;
	clearObservations(): Promise<PilotStoreResult<number>>;
	close(): void;
}

/** Lazy IndexedDB journal. No product action depends on this store opening or succeeding. */
export class IndexedDbPilotMetricsStore implements PilotMetricsStore {
	private database: Promise<IDBDatabase> | null = null;
	private unavailable = false;

	constructor(
		private readonly indexedDb: IDBFactory,
		private readonly databaseName = PILOT_METRICS_DB_NAME,
		private readonly maximumObservations = PILOT_METRICS_MAX_OBSERVATIONS,
	) {}

	async load(): Promise<PilotStoreResult<PilotJournalSnapshotV1>> {
		try {
			const profile = await this.read(PILOT_METRICS_PROFILE_STORE, 'active');
			if (profile === undefined) return { status: 'error', code: 'unconfigured' };
			if (!isPilotEnvironment(profile)) return { status: 'error', code: 'inconsistent' };
			const raw = await this.readAll(PILOT_METRICS_OBSERVATION_STORE);
			if (!raw.every(isPilotObservation)) return { status: 'error', code: 'inconsistent' };
			const observations = raw.sort(compareObservations).map((entry) => structuredClone(entry));
			return { status: 'ok', value: { version: 1, profile: structuredClone(profile), observations } };
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
			const transaction = database.transaction(PILOT_METRICS_PROFILE_STORE, 'readwrite');
			transaction.objectStore(PILOT_METRICS_PROFILE_STORE).put(structuredClone(profile), 'active');
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(profile) };
		} catch { return this.failed(); }
	}

	async ensureObservation(observation: PilotObservationV1): Promise<PilotStoreResult<PilotObservationV1>> {
		if (!isPilotObservation(observation)) return { status: 'error', code: 'inconsistent' };
		try {
			const database = await this.open();
			const transaction = database.transaction(PILOT_METRICS_OBSERVATION_STORE, 'readwrite');
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const key = pilotObservationKey(observation);
			const existing = await requestValue(store.get(key) as IDBRequest<unknown>);
			if (existing !== undefined) {
				transaction.abort();
				if (!isPilotObservation(existing) || !samePresentation(existing, observation)) {
					return { status: 'error', code: 'inconsistent' };
				}
				return { status: 'duplicate', value: structuredClone(existing) };
			}
			const count = await requestValue(store.count());
			if (count >= this.maximumObservations) {
				transaction.abort();
				return { status: 'error', code: 'full' };
			}
			store.add(structuredClone(observation), key);
			await transactionDone(transaction);
			return { status: 'ok', value: structuredClone(observation) };
		} catch { return this.failed(); }
	}

	async finishProposal(
		proposalRef: string,
		terminal: PilotProposalTerminalV1,
	): Promise<PilotStoreResult<PilotProposalObservationV1>> {
		return await this.finish<PilotProposalObservationV1>(`proposal:${proposalRef}`, (existing) => {
			if (!isPilotObservation(existing) || existing.kind !== 'proposal') return null;
			const candidate = { ...existing, terminal };
			return isPilotObservation(candidate) && candidate.kind === 'proposal' ? candidate : null;
		});
	}

	async finishSession(sessionRef: string, completedAt: string): Promise<PilotStoreResult<PilotSessionObservationV1>> {
		return await this.finish<PilotSessionObservationV1>(`session:${sessionRef}`, (existing) => {
			if (!isPilotObservation(existing) || existing.kind !== 'session') return null;
			const candidate = { ...existing, completedAt };
			return isPilotObservation(candidate) && candidate.kind === 'session' ? candidate : null;
		});
	}

	async finishRecovery(
		recoveryRef: string,
		terminal: NonNullable<PilotRecoveryObservationV1['terminal']>,
	): Promise<PilotStoreResult<PilotRecoveryObservationV1>> {
		return await this.finish<PilotRecoveryObservationV1>(`recovery:${recoveryRef}`, (existing) => {
			if (!isPilotObservation(existing) || existing.kind !== 'recovery') return null;
			const candidate = { ...existing, terminal };
			return isPilotObservation(candidate) && candidate.kind === 'recovery' ? candidate : null;
		});
	}

	async clearObservations(): Promise<PilotStoreResult<number>> {
		try {
			const database = await this.open();
			const transaction = database.transaction(PILOT_METRICS_OBSERVATION_STORE, 'readwrite');
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const count = await requestValue(store.count());
			store.clear();
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
	): Promise<PilotStoreResult<T>> {
		try {
			const database = await this.open();
			const transaction = database.transaction(PILOT_METRICS_OBSERVATION_STORE, 'readwrite');
			const store = transaction.objectStore(PILOT_METRICS_OBSERVATION_STORE);
			const existing = await requestValue(store.get(key) as IDBRequest<unknown>);
			const candidate = update(existing);
			if (!candidate) { transaction.abort(); return { status: 'error', code: 'inconsistent' }; }
			const currentTerminal = existingTerminal(existing);
			const nextTerminal = existingTerminal(candidate);
			if (currentTerminal !== null) {
				transaction.abort();
				return JSON.stringify(currentTerminal) === JSON.stringify(nextTerminal)
					? { status: 'duplicate', value: structuredClone(existing as T) }
					: { status: 'error', code: 'inconsistent' };
			}
			store.put(structuredClone(candidate), key);
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

	private async readAll(storeName: string): Promise<unknown[]> {
		const database = await this.open();
		const transaction = database.transaction(storeName, 'readonly');
		const values = await requestValue(transaction.objectStore(storeName).getAll() as IDBRequest<unknown[]>);
		await transactionDone(transaction);
		return values;
	}

	private async open(): Promise<IDBDatabase> {
		if (this.unavailable) throw new Error('Pilot metrics storage is unavailable.');
		this.database ??= new Promise((resolve, reject) => {
			const request = this.indexedDb.open(this.databaseName, PILOT_METRICS_DB_VERSION);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(PILOT_METRICS_PROFILE_STORE)) database.createObjectStore(PILOT_METRICS_PROFILE_STORE);
				if (!database.objectStoreNames.contains(PILOT_METRICS_OBSERVATION_STORE)) database.createObjectStore(PILOT_METRICS_OBSERVATION_STORE);
			};
			request.onsuccess = () => {
				request.result.onversionchange = () => { request.result.close(); this.unavailable = true; };
				resolve(request.result);
			};
			request.onerror = () => reject(new Error('Could not open pilot metrics storage.'));
			request.onblocked = () => reject(new Error('Pilot metrics storage upgrade was blocked.'));
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
		return JSON.stringify({ ...existing, terminal: null }) === JSON.stringify({ ...candidate, terminal: null });
	}
	if (existing.kind === 'session' && candidate.kind === 'session') {
		return JSON.stringify({ ...existing, completedAt: null }) === JSON.stringify({ ...candidate, completedAt: null });
	}
	if (existing.kind === 'recovery' && candidate.kind === 'recovery') {
		return JSON.stringify({ ...existing, terminal: null }) === JSON.stringify({ ...candidate, terminal: null });
	}
	return false;
}

function existingTerminal(value: unknown): unknown {
	if (!isPilotObservation(value)) return null;
	return value.kind === 'session' ? value.completedAt : value.terminal;
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
