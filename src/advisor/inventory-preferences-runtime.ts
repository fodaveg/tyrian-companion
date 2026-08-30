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
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type LocalDebugActionSpan,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';

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
		private readonly diagnostics?: LocalDebugActionPort,
	) {}

	current(): InventoryPreferencesEditorState { return clone(this.state); }

	/** Creates an isolated UI revision so two leaves cannot last-write-wins each other. */
	createEditorSession(parent?: ResolvedLocalDebugActionContext): InventoryPreferencesEditorSession {
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
		const load = async (): Promise<InventoryPreferencesEditorState> => accept(await this.loadEditorSession(parent));
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
			upsertGoal: async (goal: ReservationGoal) => await write(async (expected) => await this.writeEditorSession((scope, generation, context) => this.service.upsertGoal(scope, generation, goal, context), expected, parent)),
			removeGoal: async (goalId: string) => await write(async (expected) => await this.writeEditorSession((scope, generation, context) => this.service.removeGoal(scope, generation, goalId, context), expected, parent)),
			upsertKeepException: async (keepException: KeepExceptionV1) => await write(async (expected) => await this.writeEditorSession((scope, generation, context) => this.service.upsertKeepException(scope, generation, keepException, context), expected, parent)),
			removeKeepException: async (exceptionId: string) => await write(async (expected) => await this.writeEditorSession((scope, generation, context) => this.service.removeKeepException(scope, generation, exceptionId, context), expected, parent)),
		});
	}

	/** Loads the exact account/vault record only after capture supplied its account identity. */
	async load(
		capture: InventoryAdvisorEvidenceCaptureResultV1,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<InventoryAdvisorPreferencesLoadResult> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_read', ...inheritedIds(parent),
		});
		const scope = scopeFromCapture(this.vaultId, capture);
		if (scope === null) {
			this.capture = null;
			this.scope = null;
			this.record = null;
			this.loaded = false;
			this.state = { status: 'blocked', code: 'unavailable', goals: [], keepExceptions: [] };
			const result = { status: 'blocked', reason: 'preferences_unavailable' } as const;
			finishPreferencesLoadSpan(span, result);
			return result;
		}
		this.capture = structuredClone(capture);
		this.scope = scope;
		this.epoch += 1;
		this.record = null;
		this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
		const epoch = this.epoch;
		let result: InventoryPreferencesOperationResult;
		try { result = await this.service.list(scope, span.context); }
		catch (error) { span.failure(error, 'storage_failure', 'unavailable'); throw error; }
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) {
			const stale = { status: 'blocked', reason: 'preferences_unavailable' } as const;
			span.cancel('stale');
			return stale;
		}
		const applied = this.applyRead(result);
		finishPreferencesLoadSpan(span, applied);
		return applied;
	}

	/** Explicit editor action. It retries local IndexedDB but never captures or calls GW2. */
	async loadCached(parent?: ResolvedLocalDebugActionContext): Promise<InventoryPreferencesEditorState> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_read', ...inheritedIds(parent),
		});
		if (this.capture === null || this.scope === null) {
			this.state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
			span.skip('skipped', this.state.status);
			return this.current();
		}
		const scope = this.scope;
		const epoch = this.epoch;
		this.record = null;
		this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
		let result: InventoryPreferencesOperationResult;
		try { result = await this.service.list(scope, span.context); }
		catch (error) { span.failure(error, 'storage_failure', 'unavailable'); throw error; }
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) {
			span.cancel('stale');
			return this.current();
		}
		this.applyRead(result);
		finishPreferencesEditorSpan(span, this.state);
		return this.current();
	}

	async upsertGoal(goal: ReservationGoal, expectedGeneration?: number, parent?: ResolvedLocalDebugActionContext): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation, context) => this.service.upsertGoal(scope, generation, goal, context), expectedGeneration, parent);
	}

	async removeGoal(goalId: string, expectedGeneration?: number, parent?: ResolvedLocalDebugActionContext): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation, context) => this.service.removeGoal(scope, generation, goalId, context), expectedGeneration, parent);
	}

	async upsertKeepException(keepException: KeepExceptionV1, expectedGeneration?: number, parent?: ResolvedLocalDebugActionContext): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation, context) => this.service.upsertKeepException(scope, generation, keepException, context), expectedGeneration, parent);
	}

	async removeKeepException(exceptionId: string, expectedGeneration?: number, parent?: ResolvedLocalDebugActionContext): Promise<InventoryPreferencesEditorState> {
		return await this.write((scope, generation, context) => this.service.removeKeepException(scope, generation, exceptionId, context), expectedGeneration, parent);
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
		action: (scope: InventoryPreferenceScope, generation: number, context?: ResolvedLocalDebugActionContext) => Promise<InventoryPreferencesOperationResult>,
		expectedGeneration?: number,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<InventoryPreferencesEditorState> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_write', ...inheritedIds(parent),
		});
		const earlier = this.writeFlight ?? Promise.resolve();
		const promise = earlier.catch(() => undefined).then(async () => await this.writeNow(action, expectedGeneration, span.context));
		const flight = promise.then(() => undefined, () => undefined);
		this.writeFlight = flight;
		try {
			const result = await promise;
			finishPreferencesEditorSpan(span, result);
			return result;
		} catch (error) {
			span.failure(error, 'storage_failure', 'unavailable');
			throw error;
		}
		finally { if (this.writeFlight === flight) this.writeFlight = null; }
	}

	/** Captures state and its private CAS identity before resolving to an ItemView session. */
	private snapshotEditorSession(state: InventoryPreferencesEditorState): EditorSessionSnapshot {
		return { state: clone(state), generation: this.record?.generation ?? null, epoch: this.epoch,
			scope: this.scope === null ? null : structuredClone(this.scope) };
	}

	private async loadEditorSession(parent?: ResolvedLocalDebugActionContext): Promise<EditorSessionSnapshot> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_read', ...inheritedIds(parent),
		});
		if (this.capture === null || this.scope === null) {
			this.state = { status: 'needs_refresh', goals: [], keepExceptions: [] };
			span.skip('skipped', this.state.status);
			return this.snapshotEditorSession(this.state);
		}
		const scope = this.scope;
		const epoch = this.epoch;
		this.record = null; this.loaded = false;
		this.state = { status: 'not_loaded', goals: [], keepExceptions: [] };
		let result: InventoryPreferencesOperationResult;
		try { result = await this.service.list(scope, span.context); }
		catch (error) { span.failure(error, 'storage_failure', 'unavailable'); throw error; }
		if (epoch !== this.epoch || this.scope === null || !sameScope(this.scope, scope)) {
			span.cancel('stale');
			return this.snapshotEditorSession(this.current());
		}
		const loaded = this.applyRead(result);
		finishPreferencesLoadSpan(span, loaded);
		return this.snapshotEditorSession(loaded.status === 'ready' ? this.state : this.current());
	}

	private async writeEditorSession(
		action: (scope: InventoryPreferenceScope, generation: number, context?: ResolvedLocalDebugActionContext) => Promise<InventoryPreferencesOperationResult>,
		expected: number,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<EditorSessionSnapshot> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_write', ...inheritedIds(parent),
		});
		const earlier = this.writeFlight ?? Promise.resolve();
		const promise = earlier.catch(() => undefined).then(async () => await this.writeNowEditorSession(action, expected, span.context));
		const flight = promise.then(() => undefined, () => undefined);
		this.writeFlight = flight;
		try {
			const result = await promise;
			finishPreferencesEditorSpan(span, result.state);
			return result;
		} catch (error) {
			span.failure(error, 'storage_failure', 'unavailable');
			throw error;
		}
		finally { if (this.writeFlight === flight) this.writeFlight = null; }
	}

	/** Applies CAS and captures its opaque session tuple in the same continuation. */
	private async writeNowEditorSession(
		action: (scope: InventoryPreferenceScope, generation: number, context?: ResolvedLocalDebugActionContext) => Promise<InventoryPreferencesOperationResult>,
		expectedGeneration: number,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<EditorSessionSnapshot> {
		if (this.scope === null || !this.loaded) {
			this.state = this.state.status === 'blocked' ? this.state : { status: 'needs_refresh', goals: [], keepExceptions: [] };
			return this.snapshotEditorSession(this.state);
		}
		const scope = this.scope;
		const epoch = this.epoch;
		const result = await action(scope, expectedGeneration, actionContext);
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
		action: (scope: InventoryPreferenceScope, generation: number, context?: ResolvedLocalDebugActionContext) => Promise<InventoryPreferencesOperationResult>,
		expectedGeneration?: number,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<InventoryPreferencesEditorState> {
		if (this.scope === null || !this.loaded) {
			this.state = this.state.status === 'blocked'
				? this.state : { status: 'needs_refresh', goals: [], keepExceptions: [] };
			return this.current();
		}
		const scope = this.scope;
		const epoch = this.epoch;
		const result = await action(scope, expectedGeneration ?? this.record?.generation ?? 0, actionContext);
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

function finishPreferencesLoadSpan(
	span: LocalDebugActionSpan,
	result: InventoryAdvisorPreferencesLoadResult,
): void {
	if (result.status === 'ready') span.success('ready');
	else if (result.reason === 'preferences_unavailable') {
		span.failure(new Error('inventory_preferences_unavailable'), 'storage_failure', result.reason);
	} else {
		span.failure(new Error(`inventory_${result.reason}`), 'validation_failed', result.reason);
	}
}

function finishPreferencesEditorSpan(span: LocalDebugActionSpan, state: InventoryPreferencesEditorState): void {
	if (state.status === 'ready') span.success('ready');
	else if (state.status === 'needs_refresh') span.skip('skipped', state.status);
	else if (state.status === 'not_loaded') span.skip('skipped', state.status);
	else if (state.status === 'conflict') span.failure(new Error('inventory_preferences_conflict'), 'validation_failed', state.status);
	else if (state.status === 'blocked') span.failure(
		new Error(`inventory_preferences_${state.code}`),
		state.code === 'unavailable' ? 'storage_failure' : 'validation_failed',
		state.code,
	);
	else span.skip('skipped', state.status);
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}

function sameScope(left: InventoryPreferenceScope, right: InventoryPreferenceScope): boolean {
	return left.vaultId === right.vaultId && left.accountId === right.accountId;
}

function clone<T>(value: T): T { return structuredClone(value); }
