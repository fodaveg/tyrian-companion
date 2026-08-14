import type { InventoryAdvisorEvidenceCaptureResultV1 } from './inventory-advisor-evidence-model';
import type { KeepExceptionV1 } from './inventory-advisor-model';
import {
	type InventoryAdvisorPreferencesLoadResult,
	type InventoryAdvisorPreferencesSnapshot,
} from './inventory-advisor-workflow';
import { InventoryPreferencesService } from './inventory-preferences-service';
import type {
	InventoryPreferenceScope,
	InventoryPreferencesOperationResult,
	InventoryPreferencesV1,
} from './inventory-preferences-model';
import type { ReservationGoal } from '../economy/reservation-model';

export type InventoryPreferencesEditorState =
	| { status: 'not_loaded' | 'needs_refresh'; goals: []; keepExceptions: [] }
	| { status: 'ready'; goals: ReservationGoal[]; keepExceptions: KeepExceptionV1[] }
	| { status: 'conflict'; goals: ReservationGoal[]; keepExceptions: KeepExceptionV1[] }
	| { status: 'blocked'; code: 'corrupt' | 'future_schema' | 'unavailable'; goals: []; keepExceptions: [] };

/** Opaque per-ItemView editor handle; its CAS revision never reaches the DOM. */
export interface InventoryPreferencesEditorSession {
	current(): InventoryPreferencesEditorState;
	load(): Promise<InventoryPreferencesEditorState>;
	upsertGoal(goal: ReservationGoal): Promise<InventoryPreferencesEditorState>;
	removeGoal(goalId: string): Promise<InventoryPreferencesEditorState>;
	upsertKeepException(keepException: KeepExceptionV1): Promise<InventoryPreferencesEditorState>;
	removeKeepException(exceptionId: string): Promise<InventoryPreferencesEditorState>;
}

type EditorSessionSnapshot = {
	state: InventoryPreferencesEditorState;
	generation: number | null;
	epoch: number;
	scope: InventoryPreferenceScope | null;
};

/**
 * Owns the private preference scope and generation. Its public editor state
 * deliberately never exposes a vault identifier, account identifier, or CAS
 * generation to the ItemView.
 */
export class InventoryPreferencesRuntime {
	private capture: InventoryAdvisorEvidenceCaptureResultV1 | null = null;
	private scope: InventoryPreferenceScope | null = null;
	private record: InventoryPreferencesV1 | null = null;
	private loaded = false;
	private epoch = 0;
	private writeFlight: Promise<void> | null = null;
	private state: InventoryPreferencesEditorState = { status: 'not_loaded', goals: [], keepExceptions: [] };

	constructor(
		private readonly service: InventoryPreferencesService,
		private readonly vaultId: string,
	) {}

	current(): InventoryPreferencesEditorState { return clone(this.state); }

	/** Creates an isolated UI revision so two leaves cannot last-write-wins each other. */
	createEditorSession(): InventoryPreferencesEditorSession {
		/* A newly opened leaf must explicitly load its own revision. */
		let state: InventoryPreferencesEditorState = { status: 'not_loaded', goals: [], keepExceptions: [] };
		let generation: number | null = null;
		let sessionEpoch: number | null = null;
		let sessionScope: InventoryPreferenceScope | null = null;
		const expire = (): InventoryPreferencesEditorState => {
			state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
			generation = null; sessionEpoch = null; sessionScope = null;
			return clone(state);
		};
		const valid = (): boolean => sessionEpoch === null || (sessionEpoch === this.epoch
			&& sessionScope !== null && this.scope !== null && sameScope(sessionScope, this.scope));
		const accept = (snapshot: EditorSessionSnapshot): InventoryPreferencesEditorState => {
			state = snapshot.state;
			if (state.status === 'ready' && snapshot.scope !== null) {
				generation = snapshot.generation ?? 0;
				sessionEpoch = snapshot.epoch;
				sessionScope = snapshot.scope;
			} else { generation = null; sessionEpoch = null; sessionScope = null; }
			return clone(state);
		};
		const load = async (): Promise<InventoryPreferencesEditorState> => accept(await this.loadEditorSession());
		const write = async (
			action: (expected: number) => Promise<EditorSessionSnapshot>,
		): Promise<InventoryPreferencesEditorState> => {
			if (!valid()) return expire();
			if (state.status !== 'ready' || generation === null) return clone(state);
			const before = clone(state);
			const next = await action(generation);
			if (next.state.status === 'ready') accept(next);
			else if (next.state.status === 'conflict') {
				/* The DOM draft stays mounted; this snapshot is only its safe base. */
				state = { status: 'conflict', goals: before.goals, keepExceptions: before.keepExceptions };
			} else accept(next);
			return clone(state);
		};
		return Object.freeze({
			current: () => valid() ? clone(state) : expire(), load,
			upsertGoal: async (goal: ReservationGoal) => await write(async (expected) => await this.writeEditorSession((scope, generation) => this.service.upsertGoal(scope, generation, goal), expected)),
			removeGoal: async (goalId: string) => await write(async (expected) => await this.writeEditorSession((scope, generation) => this.service.removeGoal(scope, generation, goalId), expected)),
			upsertKeepException: async (keepException: KeepExceptionV1) => await write(async (expected) => await this.writeEditorSession((scope, generation) => this.service.upsertKeepException(scope, generation, keepException), expected)),
			removeKeepException: async (exceptionId: string) => await write(async (expected) => await this.writeEditorSession((scope, generation) => this.service.removeKeepException(scope, generation, exceptionId), expected)),
		});
	}

	/** Loads the exact account/vault record only after capture supplied its account identity. */
	async load(capture: InventoryAdvisorEvidenceCaptureResultV1): Promise<InventoryAdvisorPreferencesLoadResult> {
		const scope = scopeFromCapture(this.vaultId, capture);
		if (scope === null) {
			this.capture = null;
			this.scope = null;
			this.record = null;
			this.loaded = false;
			this.state = { status: 'blocked', code: 'unavailable', goals: [], keepExceptions: [] };
			return { status: 'blocked', reason: 'preferences_unavailable' };
		}
		this.capture = structuredClone(capture);
		this.scope = scope;
		this.epoch += 1;
		this.record = null;
		this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
		const epoch = this.epoch;
		const result = await this.service.list(scope);
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) {
			return { status: 'blocked', reason: 'preferences_unavailable' };
		}
		return this.applyRead(result);
	}

	/** Explicit editor action. It retries local IndexedDB but never captures or calls GW2. */
	async loadCached(): Promise<InventoryPreferencesEditorState> {
		if (this.capture === null || this.scope === null) {
			this.state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
			return this.current();
		}
		const scope = this.scope;
		const epoch = this.epoch;
		this.record = null;
		this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
		const result = await this.service.list(scope);
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) return this.current();
		this.applyRead(result);
		return this.current();
	}

	async upsertGoal(goal: ReservationGoal, expectedGeneration?: number): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation) => this.service.upsertGoal(scope, generation, goal), expectedGeneration);
	}

	async removeGoal(goalId: string, expectedGeneration?: number): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation) => this.service.removeGoal(scope, generation, goalId), expectedGeneration);
	}

	async upsertKeepException(keepException: KeepExceptionV1, expectedGeneration?: number): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation) => this.service.upsertKeepException(scope, generation, keepException), expectedGeneration);
	}

	async removeKeepException(exceptionId: string, expectedGeneration?: number): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation) => this.service.removeKeepException(scope, generation, exceptionId), expectedGeneration);
	}

	dispose(): void { this.service.dispose(); }

	/** Forgets account-bound local state on API-key or locale invalidation without touching IndexedDB. */
	invalidate(): void {
		this.epoch += 1;
		this.capture = null;
		this.scope = null;
		this.record = null;
		this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
	}

	private async write(
		action: (scope: InventoryPreferenceScope, generation: number) => Promise<InventoryPreferencesOperationResult>,
		expectedGeneration?: number,
	): Promise<InventoryPreferencesEditorState> {
		const earlier = this.writeFlight ?? Promise.resolve();
		const promise = earlier.catch(() => undefined).then(async () => await this.writeNow(action, expectedGeneration));
		const flight = promise.then(() => undefined, () => undefined);
		this.writeFlight = flight;
		try { return await promise; }
		finally { if (this.writeFlight === flight) this.writeFlight = null; }
	}

	/** Captures state and its private CAS identity before resolving to an ItemView session. */
	private snapshotEditorSession(state: InventoryPreferencesEditorState): EditorSessionSnapshot {
		return { state: clone(state), generation: this.record?.generation ?? null, epoch: this.epoch,
			scope: this.scope === null ? null : structuredClone(this.scope) };
	}

	private async loadEditorSession(): Promise<EditorSessionSnapshot> {
		if (this.capture === null || this.scope === null) {
			this.state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
			return this.snapshotEditorSession(this.state);
		}
		const scope = this.scope;
		const epoch = this.epoch;
		this.record = null; this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
		const result = await this.service.list(scope);
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) {
			return this.snapshotEditorSession(this.current());
		}
		const loaded = this.applyRead(result);
		return this.snapshotEditorSession(loaded.status === 'ready' ? this.state : this.current());
	}

	private async writeEditorSession(
		action: (scope: InventoryPreferenceScope, generation: number) => Promise<InventoryPreferencesOperationResult>,
		expected: number,
	): Promise<EditorSessionSnapshot> {
		const earlier = this.writeFlight ?? Promise.resolve();
		const promise = earlier.catch(() => undefined).then(async () => await this.writeNowEditorSession(action, expected));
		const flight = promise.then(() => undefined, () => undefined);
		this.writeFlight = flight;
		try { return await promise; }
		finally { if (this.writeFlight === flight) this.writeFlight = null; }
	}

	/** Applies CAS and captures its opaque session tuple in the same continuation. */
	private async writeNowEditorSession(
		action: (scope: InventoryPreferenceScope, generation: number) => Promise<InventoryPreferencesOperationResult>,
		expectedGeneration: number,
	): Promise<EditorSessionSnapshot> {
		if (this.scope === null || !this.loaded) {
			this.state = this.state.status === 'blocked' ? this.state : { status: 'needs_refresh', goals: [], keepExceptions: [] };
			return this.snapshotEditorSession(this.state);
		}
		const scope = this.scope;
		const epoch = this.epoch;
		const result = await action(scope, expectedGeneration);
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) return this.snapshotEditorSession(this.current());
		if (result.status === 'ok' && result.record !== null) {
			this.record = structuredClone(result.record);
			this.state = editorState(this.record);
			return this.snapshotEditorSession(this.state);
		}
		if (result.status === 'conflict') {
			this.state = { status: 'conflict', ...snapshot(this.record) };
			return this.snapshotEditorSession(this.state);
		}
		if (result.status === 'error') {
			this.record = null; this.state = blocked(result.code);
			return this.snapshotEditorSession(this.state);
		}
		this.state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
		return this.snapshotEditorSession(this.state);
	}

	private async writeNow(
		action: (scope: InventoryPreferenceScope, generation: number) => Promise<InventoryPreferencesOperationResult>,
		expectedGeneration?: number,
	): Promise<InventoryPreferencesEditorState> {
		if (this.scope === null || !this.loaded) {
			this.state = this.state.status === 'blocked'
				? this.state : { status: 'needs_refresh', goals: [], keepExceptions: [] };
			return this.current();
		}
		const scope = this.scope;
		const epoch = this.epoch;
		const result = await action(scope, expectedGeneration ?? this.record?.generation ?? 0);
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) return this.current();
		if (result.status === 'ok' && result.record !== null) {
			this.record = structuredClone(result.record);
			this.state = editorState(this.record);
			return this.current();
		}
		if (result.status === 'conflict') {
			// Keep the caller's draft. A later explicit reload is the only merge policy.
			this.state = { status: 'conflict', ...snapshot(this.record) };
			return this.current();
		}
		if (result.status === 'error') {
			this.record = null;
			this.state = blocked(result.code);
			return this.current();
		}
		this.state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
		return this.current();
	}

	private applyRead(result: InventoryPreferencesOperationResult): InventoryAdvisorPreferencesLoadResult {
		if (result.status === 'ok') {
			this.record = result.record === null ? null : structuredClone(result.record);
			this.loaded = true;
			this.state = editorState(this.record);
			return { status: 'ready', value: snapshot(this.record) };
		}
		if (result.status === 'error') {
			this.record = null;
			this.loaded = false;
			if (result.code === 'corrupt') {
				this.state = blocked('corrupt');
				return { status: 'blocked', reason: 'preferences_corrupt' };
			}
			if (result.code === 'future_schema') {
				this.state = blocked('future_schema');
				return { status: 'blocked', reason: 'preferences_future' };
			}
			this.state = blocked('unavailable');
			return { status: 'blocked', reason: 'preferences_unavailable' };
		}
		this.record = null;
		this.loaded = false;
		this.state = { status: 'blocked', code: 'unavailable', goals: [], keepExceptions: [] };
		return { status: 'blocked', reason: 'preferences_unavailable' };
	}
}

function scopeFromCapture(vaultId: string, capture: InventoryAdvisorEvidenceCaptureResultV1): InventoryPreferenceScope | null {
	const evidence = capture.evidence;
	if (evidence === null || evidence === undefined) return null;
	const accountId = evidence.accountId;
	/* Do not select a durable account record until every account-bound evidence
	 * component agrees. A malformed capture must not cross an account boundary. */
	if (typeof accountId !== 'string' || accountId.length === 0
		|| evidence.snapshot.accountId !== accountId || evidence.prices.accountId !== accountId
		|| evidence.accountSignals.accountId !== accountId) return null;
	return { vaultId, accountId };
}

function snapshot(record: InventoryPreferencesV1 | null): InventoryAdvisorPreferencesSnapshot {
	return { goals: structuredClone(record?.goals ?? []), keepExceptions: structuredClone(record?.keepExceptions ?? []) };
}

function editorState(record: InventoryPreferencesV1 | null): InventoryPreferencesEditorState {
	return { status: 'ready', ...snapshot(record) };
}

function blocked(code: 'corrupt' | 'future_schema' | 'unavailable'): InventoryPreferencesEditorState {
	return { status: 'blocked', code, goals: [], keepExceptions: [] };
}

function sameScope(left: InventoryPreferenceScope, right: InventoryPreferenceScope): boolean {
	return left.vaultId === right.vaultId && left.accountId === right.accountId;
}

function clone<T>(value: T): T { return structuredClone(value); }
