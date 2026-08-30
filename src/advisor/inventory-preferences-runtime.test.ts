import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { InventoryPreferencesRuntime } from './inventory-preferences-runtime';
import { InventoryPreferencesService } from './inventory-preferences-service';
import { IndexedDbInventoryPreferencesStore } from './inventory-preferences-store';
import type {
	InventoryPreferencesActionContext,
	InventoryPreferenceScope,
	InventoryPreferencesReadResult,
	InventoryPreferencesStore,
	InventoryPreferencesV1,
	InventoryPreferencesWriteResult,
} from './inventory-preferences-model';
import type { InventoryAdvisorEvidenceCaptureResultV1 } from './inventory-advisor-evidence-model';
import type { ReservationGoal } from '../economy/reservation-model';
import type {
	LocalDebugActionContext,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import {
	LocalDebugPersistenceProbe,
	type LocalDebugPersistenceEvent,
} from '../core/local-debug-persistence';

describe('InventoryPreferencesRuntime', () => {
	it('propagates each runtime span context through preference reads and writes', async () => {
		const store = new MemoryPreferencesStore();
		const diagnostics = diagnosticHarness();
		const runtime = new InventoryPreferencesRuntime(
			new InventoryPreferencesService(store, () => NOW), 'vault-hash', diagnostics,
		);
		const root = rootContext();

		await runtime.load(capture('account-a'), root);
		await runtime.upsertGoal(goal('one'), undefined, root);

		expect(store.readContexts.map(contextIds)).toEqual([
			{ actionId: 'preference-span-1', correlationId: 'root-correlation' },
			{ actionId: 'preference-span-2', correlationId: 'root-correlation' },
		]);
		expect(store.writeContexts.map(contextIds)).toEqual([
			{ actionId: 'preference-span-2', correlationId: 'root-correlation' },
		]);
	});

	it('keeps root correlation while giving runtime, read and write/CAS spans unique action IDs, including editor closures', async () => {
		const readEvents: LocalDebugPersistenceEvent[] = [];
		const writeEvents: LocalDebugPersistenceEvent[] = [];
		let readSequence = 0;
		let writeSequence = 0;
		const store = new IndexedDbInventoryPreferencesStore(
			new IDBFactory(),
			'preferences-causal-diagnostics',
			{
				read: new LocalDebugPersistenceProbe({
					sink: (event) => readEvents.push(event),
					createId: () => `read-store-${String(++readSequence)}`,
				}),
				write: new LocalDebugPersistenceProbe({
					sink: (event) => writeEvents.push(event),
					createId: () => `write-store-${String(++writeSequence)}`,
				}),
			},
		);
		const diagnostics = diagnosticHarness();
		const runtime = new InventoryPreferencesRuntime(
			new InventoryPreferencesService(store, () => NOW), 'vault-hash', diagnostics,
		);
		const root = rootContext();

		await runtime.load(capture('account-a'), root);
		await runtime.upsertGoal(goal('runtime-write'), undefined, root);
		const editor = runtime.createEditorSession(root);
		await editor.load();
		await editor.upsertGoal(goal('editor-write'));

		const runtimeStarts = diagnostics.events.filter(({ phase }) => phase === 'start');
		const readStarts = readEvents.filter(({ phase, operation }) => phase === 'start' && operation === 'read');
		const writeStarts = writeEvents.filter(({ phase, operation }) => phase === 'start' && operation === 'write');
		const persistenceStarts = [...readEvents, ...writeEvents].filter(({ phase }) => phase === 'start');
		expect(runtimeStarts).toHaveLength(4);
		expect(readStarts).toHaveLength(4);
		expect(writeStarts).toHaveLength(2);
		expect(readEvents.every(({ operation }) => operation === 'read' || operation === 'open')).toBe(true);
		expect(writeEvents.every(({ operation }) => operation === 'write')).toBe(true);
		expect(runtimeStarts.every(({ correlationId }) => correlationId === 'root-correlation')).toBe(true);
		expect([...readEvents, ...writeEvents].every(({ context }) => context?.correlationId === 'root-correlation')).toBe(true);
		const actionIds = [
			...runtimeStarts.map(({ actionId }) => actionId),
			...persistenceStarts.map(({ context }) => context?.actionId),
		];
		expect(actionIds.every((actionId) => typeof actionId === 'string')).toBe(true);
		expect(new Set(actionIds).size).toBe(actionIds.length);
		store.dispose();
	});

	it('does not read local storage until capture has supplied an account scope', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		expect(runtime.current()).toEqual({ status: 'not_loaded', goals: [], keepExceptions: [] });
		expect(await runtime.loadCached()).toEqual({ status: 'needs_refresh', goals: [], keepExceptions: [] });
		expect(store.reads).toBe(0);
		await runtime.load(capture('account-a'));
		expect(store.reads).toBe(1);
		expect(runtime.current()).toEqual({ status: 'ready', goals: [], keepExceptions: [] });
	});

	it('rejects inconsistent captured identities before any IndexedDB read', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		const inconsistent = capture('account-a');
		if (inconsistent.evidence === null) throw new Error('Expected evidence fixture.');
		inconsistent.evidence.prices.accountId = 'account-b';
		await expect(runtime.load(inconsistent)).resolves.toEqual({ status: 'blocked', reason: 'preferences_unavailable' });
		expect(store.reads).toBe(0);
		expect(runtime.current()).toEqual({ status: 'blocked', code: 'unavailable', goals: [], keepExceptions: [] });
	});

	it('binds durable intent to the captured account and redacts scope/generation from the editor state', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await runtime.load(capture('account-a'));
		await runtime.upsertGoal(goal('one'));
		await runtime.load(capture('account-b'));
		expect(store.scopes).toContainEqual({ vaultId: 'vault-hash', accountId: 'account-a' });
		expect(store.scopes).toContainEqual({ vaultId: 'vault-hash', accountId: 'account-b' });
		expect(JSON.stringify(runtime.current())).not.toMatch(/vault-hash|account-a|generation/u);
	});

	it("always rereads the same scope so another window's write becomes visible", async () => {
		const store = new MemoryPreferencesStore();
		const first = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		const second = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await first.load(capture('account-a'));
		await second.load(capture('account-a'));
		await first.upsertGoal(goal('from-other-window'));
		const readsBeforeReload = store.reads;
		await second.load(capture('account-a'));
		expect(store.reads).toBe(readsBeforeReload + 1);
		expect(second.current()).toMatchObject({ status: 'ready', goals: [{ goalId: 'from-other-window' }] });
	});

	it('keeps two editor sessions on one runtime at their loaded CAS revision', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await runtime.load(capture('account-a'));
		const left = runtime.createEditorSession();
		const right = runtime.createEditorSession();
		await left.load(); await right.load();
		await expect(left.upsertGoal(goal('left'))).resolves.toMatchObject({ status: 'ready', goals: [{ goalId: 'left' }] });
		await expect(right.upsertGoal(goal('right'))).resolves.toMatchObject({ status: 'conflict', goals: [] });
		const observer = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await observer.load(capture('account-a'));
		expect(observer.current()).toMatchObject({ status: 'ready', goals: [{ goalId: 'left' }] });
		expect(JSON.stringify(right.current())).not.toMatch(/generation|vault-hash|account-a/u);
	});

	it('requires an explicit load for a session opened after the runtime is already ready', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await runtime.load(capture('account-a'));
		const laterLeaf = runtime.createEditorSession();
		expect(laterLeaf.current()).toEqual({ status: 'not_loaded', goals: [], keepExceptions: [] });
		await laterLeaf.load();
		await expect(laterLeaf.upsertGoal(goal('loaded-later'))).resolves.toMatchObject({ status: 'ready', goals: [{ goalId: 'loaded-later' }] });
	});

	it('expires an old editor session across invalidate and an account scope change before CAS', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await runtime.load(capture('account-a'));
		const accountA = runtime.createEditorSession();
		await accountA.load();
		runtime.invalidate();
		await runtime.load(capture('account-b'));
		const accountB = runtime.createEditorSession();
		await accountB.load();
		const writesBeforeOldAttempt = store.writes;
		expect(accountA.current()).toEqual({ status: 'needs_refresh', goals: [], keepExceptions: [] });
		await expect(accountA.upsertGoal(goal('must-not-cross-account'))).resolves.toEqual({ status: 'needs_refresh', goals: [], keepExceptions: [] });
		expect(store.writes).toBe(writesBeforeOldAttempt);
		expect(accountB.current()).toEqual({ status: 'ready', goals: [], keepExceptions: [] });
	});

	it('ignores a deferred old scope read after invalidation', async () => {
		const store = new MemoryPreferencesStore();
		const runtime = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		const gate = deferred<void>();
		store.readGate = gate.promise;
		const loading = runtime.load(capture('account-a'));
		await Promise.resolve();
		runtime.invalidate();
		gate.resolve();
		await expect(loading).resolves.toEqual({ status: 'blocked', reason: 'preferences_unavailable' });
		expect(runtime.current()).toEqual({ status: 'not_loaded', goals: [], keepExceptions: [] });
	});

	it('keeps a local draft state on CAS conflict and blocks future/corrupt/unavailable records', async () => {
		const store = new MemoryPreferencesStore();
		const first = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		const second = new InventoryPreferencesRuntime(new InventoryPreferencesService(store, () => NOW), 'vault-hash');
		await first.load(capture('account-a'));
		await second.load(capture('account-a'));
		await first.upsertGoal(goal('first'));
		expect((await second.upsertGoal(goal('second'))).status).toBe('conflict');
		expect(second.current().status).toBe('conflict');
		store.failure = 'future_schema';
		expect((await second.loadCached()).status).toBe('blocked');
		expect(await second.upsertGoal(goal('blocked'))).toMatchObject({ status: 'blocked', code: 'future_schema' });
	});
});

const NOW = '2026-08-14T12:00:00.000Z';

function capture(accountId: string): InventoryAdvisorEvidenceCaptureResultV1 {
	return {
		status: 'complete',
		evidence: {
			accountId,
			snapshot: { accountId },
			prices: { accountId },
			accountSignals: { accountId },
		},
	} as unknown as InventoryAdvisorEvidenceCaptureResultV1;
}

function goal(goalId: string): ReservationGoal {
	return {
		schemaVersion: 1, goalId, title: goalId, status: 'active', priority: 0, reason: 'personal',
		requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity: 1, creditedQuantity: 0, basis: 'available', intendedUse: 'hold' }],
	};
}

class MemoryPreferencesStore implements InventoryPreferencesStore {
	private readonly records = new Map<string, InventoryPreferencesV1>();
	reads = 0;
	writes = 0;
	scopes: InventoryPreferenceScope[] = [];
	failure: 'corrupt' | 'future_schema' | 'unavailable' | null = null;
	readGate: Promise<void> | null = null;
	readContexts: Array<InventoryPreferencesActionContext | undefined> = [];
	writeContexts: Array<InventoryPreferencesActionContext | undefined> = [];

	async read(scope: InventoryPreferenceScope, actionContext?: InventoryPreferencesActionContext): Promise<InventoryPreferencesReadResult> {
		this.reads += 1;
		this.scopes.push(structuredClone(scope));
		this.readContexts.push(actionContext === undefined ? undefined : { ...actionContext });
		await this.readGate;
		if (this.failure !== null) return { status: 'error', code: this.failure };
		return { status: 'ok', record: clone(this.records.get(key(scope)) ?? null) };
	}

	async compareAndSwap(
		scope: InventoryPreferenceScope,
		expected: number,
		next: InventoryPreferencesV1,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<InventoryPreferencesWriteResult> {
		this.writes += 1;
		this.writeContexts.push(actionContext === undefined ? undefined : { ...actionContext });
		if (this.failure !== null) return { status: 'error', code: this.failure };
		const current = this.records.get(key(scope)) ?? null;
		if ((current?.generation ?? 0) !== expected) return { status: 'conflict', generation: current?.generation ?? 0 };
		this.records.set(key(scope), clone(next));
		return { status: 'saved', record: clone(next) };
	}

	dispose(): void {}
}

function key(scope: InventoryPreferenceScope): string { return `${scope.vaultId}\u0000${scope.accountId}`; }
function clone<T>(value: T): T { return structuredClone(value); }
function contextIds(context: InventoryPreferencesActionContext | undefined): InventoryPreferencesActionContext | undefined {
	return context === undefined
		? undefined
		: { actionId: context.actionId, correlationId: context.correlationId };
}
function rootContext(): ResolvedLocalDebugActionContext {
	return {
		component: 'ui', action: 'command_execute', actionId: 'root-action', correlationId: 'root-correlation',
	};
}
function diagnosticHarness(): {
	createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext;
	event(context: LocalDebugEventContext): void;
	events: LocalDebugEventContext[];
} {
	let sequence = 0;
	return {
		events: [],
		createContext(context) {
			sequence += 1;
			const actionId = context.actionId ?? `preference-span-${String(sequence)}`;
			return {
				...context,
				actionId,
				correlationId: context.correlationId ?? context.parent?.correlationId ?? context.parent?.actionId ?? actionId,
			};
		},
		event(context): void { this.events.push(context); },
	};
}
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
	return { promise, resolve };
}
