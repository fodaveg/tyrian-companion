import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type {
	LocalDebugActionContext,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { ManagedAssetsResult } from './managed-assets';
import { ManagedAssetsLifecycle } from './managed-assets-lifecycle';
import { IndexedDbManagedAssetsPointerStore, MemoryManagedAssetsPointerStore } from './managed-assets-pointer';

describe('ManagedAssetsLifecycle', () => {
	it('records apply outcomes with the supplied action identity and no root metadata', async () => {
		const diagnostics = diagnosticHarness();
		const parent = actionContext('settings-action', 'settings-correlation');
		const lifecycle = new ManagedAssetsLifecycle(
			new FakeManager(), new MemoryManagedAssetsPointerStore(), diagnostics,
		);

		await expect(lifecycle.install('Private root', parent)).resolves.toMatchObject({ status: 'applied' });

		expect(diagnostics.created).toBe(1);
		expect(diagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'success']);
		expect(diagnostics.events).toEqual(expect.arrayContaining([
			expect.objectContaining({
				action: 'managed_assets_apply', component: 'assets',
				actionId: 'generated-1', correlationId: 'settings-correlation',
			}),
		]));
		expect(JSON.stringify(diagnostics.events)).not.toContain('Private root');
	});

	it('records a deliberate storage failure without changing the thrown error', async () => {
		const diagnostics = diagnosticHarness();
		const failure = new Error('injected pointer failure');
		const pointer = new MemoryManagedAssetsPointerStore();
		pointer.read = async () => { throw failure; };
		const lifecycle = new ManagedAssetsLifecycle(new FakeManager(), pointer, diagnostics);

		await expect(lifecycle.install('A')).rejects.toBe(failure);
		expect(diagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'failure']);
		expect(diagnostics.events.at(-1)).toMatchObject({ code: 'storage_failure', state: 'unavailable' });
	});

	it('coordinates two installs so only one durable root wins', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new FakeManager();
		const [a, b] = await Promise.all([
			new ManagedAssetsLifecycle(manager, pointer).install('A'),
			new ManagedAssetsLifecycle(manager, pointer).install('B'),
		]);
		expect([a.status, b.status]).toContain('applied');
		expect([a.status, b.status]).toContain('busy');
		expect((await pointer.read()).root).toBe('A');
		expect(manager.installed).toEqual(['A']);
	});

	it('serializes two installs of the same root without cleanup', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new FakeManager();
		const [a, b] = await Promise.all([
			new ManagedAssetsLifecycle(manager, pointer).install('A'),
			new ManagedAssetsLifecycle(manager, pointer).install('A'),
		]);
		expect([a.status, b.status].sort()).toEqual(['applied', 'busy']);
		expect((await pointer.read()).root).toBe('A');
		expect(manager.uninstalled).not.toContain('A');
	});

	it('converges same-destination moves without uninstalling the shared destination', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new FakeManager();
		await new ManagedAssetsLifecycle(manager, pointer).install('Origin');
		const [a, b] = await Promise.all([
			new ManagedAssetsLifecycle(manager, pointer).move('A'),
			new ManagedAssetsLifecycle(manager, pointer).move('A'),
		]);
		expect([a.status, b.status]).toContain('relocated');
		expect(['busy', 'unchanged', 'relocated']).toContain(b.status);
		expect((await pointer.read()).root).toBe('A');
		expect(manager.uninstalled).toEqual(['Origin']);
		expect(manager.uninstalled).not.toContain('A');
		expect(await new ManagedAssetsLifecycle(manager, pointer).move('A')).toMatchObject({ status: 'unchanged', root: 'A' });
		expect(manager.uninstalled).not.toContain('A');
	});

	it('serializes Remove Origin against Move Origin to B', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new FakeManager();
		const lifecycle = new ManagedAssetsLifecycle(manager, pointer);
		await lifecycle.install('Origin');
		const [remove, move] = await Promise.all([lifecycle.remove(), new ManagedAssetsLifecycle(manager, pointer).move('B')]);
		expect([remove.status, move.status]).toContain('removed');
		expect([remove.status, move.status]).toContain('busy');
		expect((await pointer.read()).root).toBeNull();
		expect(manager.installed).not.toContain('B');
	});

	it('treats a retry after detached final CAS response loss as successful unchanged', async () => {
		const pointer = new ResponseLossPointer();
		const manager = new FakeManager();
		const lifecycle = new ManagedAssetsLifecycle(manager, pointer);
		await lifecycle.install('Origin');
		pointer.loseNextReadyNull = true;
		await expect(lifecycle.remove()).rejects.toThrow('response_lost');
		await expect(lifecycle.remove()).resolves.toMatchObject({ status: 'unchanged', root: null });
	});

	it('persists the pointer across IndexedDB instances with generation CAS', async () => {
		const factory = new IDBFactory();
		const vaultId = 'a'.repeat(64);
		const first = new IndexedDbManagedAssetsPointerStore(factory, vaultId, 'pointer-test');
		const empty = await first.read();
		const installing = await first.compareAndSet(empty, { status: 'installing', root: null, targetRoot: 'A' });
		expect(installing?.generation).toBe(1);
		first.close();
		const second = new IndexedDbManagedAssetsPointerStore(factory, vaultId, 'pointer-test');
		expect(await second.read()).toEqual(installing);
		expect(await second.compareAndSet(empty, { status: 'installing', root: null, targetRoot: 'B' })).toBeNull();
		second.close();
	});

	it('namespaces two vault authorities inside the same IndexedDB database', async () => {
		const factory = new IDBFactory();
		const a = new IndexedDbManagedAssetsPointerStore(factory, 'a'.repeat(64), 'shared-pointer-test');
		const b = new IndexedDbManagedAssetsPointerStore(factory, 'b'.repeat(64), 'shared-pointer-test');
		const a0 = await a.read();
		const claim = await a.compareAndSet(a0, { status: 'installing', root: null, targetRoot: 'A' });
		expect(claim?.targetRoot).toBe('A');
		expect(await b.read()).toMatchObject({ status: 'ready', root: null, generation: 0 });
		a.close(); b.close();
	});

	it('retains installing authority after a journaled failure, blocks B, and resumes A after reopen', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new JournalFailureManager();
		await expect(new ManagedAssetsLifecycle(manager, pointer).install('A')).resolves.toMatchObject({ status: 'unavailable' });
		expect(await pointer.read()).toMatchObject({ status: 'installing', targetRoot: 'A' });
		await expect(new ManagedAssetsLifecycle(manager, pointer).install('B')).resolves.toMatchObject({ status: 'busy' });
		manager.fail = false;
		await expect(new ManagedAssetsLifecycle(manager, pointer).install('A')).resolves.toMatchObject({ status: 'applied', root: 'A' });
	});

	it('releases installing authority only when inspection proves no manifest was written', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new JournalFailureManager();
		manager.manifestStatus = 'missing';
		await new ManagedAssetsLifecycle(manager, pointer).install('A');
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: null });
	});

	it('adopts an empty pointer for an exact legacy manifest only inside Move', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new ExactLegacyManager('Legacy');
		const result = await new ManagedAssetsLifecycle(manager, pointer).move('Safe destination', 'Legacy');
		expect(result).toMatchObject({ status: 'relocated', root: 'Safe destination' });
		expect(manager.inspected).toEqual(['Legacy']);
		expect(manager.installed).toEqual(['Safe destination']);
		expect(manager.uninstalled).toEqual(['Legacy']);
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Safe destination' });
	});

	it('refuses legacy Move and Remove when the durable pointer names a different root', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new ExactLegacyManager('Legacy');
		await new ManagedAssetsLifecycle(manager, pointer).install('Other');
		await expect(new ManagedAssetsLifecycle(manager, pointer).move('Safe destination', 'Legacy')).resolves.toMatchObject({ status: 'conflict' });
		await expect(new ManagedAssetsLifecycle(manager, pointer).remove('Legacy')).resolves.toMatchObject({ status: 'conflict' });
		expect(manager.inspected).toEqual([]);
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Other' });
	});

	it('rejects a detached legacy Remove retry when its pointer changes during inspection', async () => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const manager = new BlockingDetachedLegacyManager('Legacy');
		const removal = new ManagedAssetsLifecycle(manager, pointer).remove('Legacy');
		await manager.waitUntilInspecting;
		const empty = await pointer.read();
		await pointer.compareAndSet(empty, { status: 'ready', root: 'Other', targetRoot: null });
		manager.resume();
		await expect(removal).resolves.toMatchObject({ status: 'conflict' });
		expect(manager.uninstalled).toEqual([]);
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Other' });
	});

	it.each(['detached', 'conflict'] as const)('rejects Move from pointer-owned legacy evidence that is %s without destination I/O', async (manifestStatus) => {
		const pointer = new MemoryManagedAssetsPointerStore();
		const empty = await pointer.read();
		await pointer.compareAndSet(empty, { status: 'ready', root: 'Legacy', targetRoot: null });
		const manager = new NonReadyLegacyManager('Legacy', manifestStatus);
		await expect(new ManagedAssetsLifecycle(manager, pointer).move('Destination', 'Legacy')).resolves.toMatchObject({ status: 'conflict' });
		expect(manager.installed).toEqual([]);
		expect(manager.uninstalled).toEqual([]);
		expect(await pointer.read()).toMatchObject({ status: 'ready', root: 'Legacy' });
	});
});

class FakeManager {
	readonly installed: string[] = [];
	readonly uninstalled: string[] = [];
	async apply(root: string): Promise<ManagedAssetsResult> { this.installed.push(root); return ok('applied', 'created'); }
	async uninstall(root: string): Promise<ManagedAssetsResult> { this.uninstalled.push(root); return ok('detached', 'existing'); }
	async inspect(root: string) { return inspection(root, 'ready'); }
	async inspectForLegacyTransition(root: string) { return await this.inspect(root); }
}

class JournalFailureManager extends FakeManager {
	fail = true;
	manifestStatus: 'missing' | 'applying' = 'applying';
	override async apply(root: string): Promise<ManagedAssetsResult> {
		if (this.fail) return { status: 'unavailable', message: 'injected' };
		return await super.apply(root);
	}
	override async inspect(root: string) { return inspection(root, this.fail ? this.manifestStatus : 'ready'); }
}

class ExactLegacyManager extends FakeManager {
	readonly inspected: string[] = [];
	constructor(private readonly ownedRoot: string) { super(); }
	override async inspectForLegacyTransition(root: string) {
		this.inspected.push(root);
		return { ...inspection(root, 'ready'), manifest: root === this.ownedRoot ? { root } as never : null };
	}
}

class BlockingDetachedLegacyManager extends ExactLegacyManager {
	private unblock: (() => void) | null = null;
	private resolveInspectionStarted: (() => void) | null = null;
	readonly waitUntilInspecting = new Promise<void>((resolve) => { this.resolveInspectionStarted = resolve; });
	override async inspectForLegacyTransition(root: string) {
		this.resolveInspectionStarted?.();
		await new Promise<void>((resolve) => { this.unblock = resolve; });
		return { ...inspection(root, 'ready'), manifestStatus: 'detached' as const, manifest: root === 'Legacy' ? { root } as never : null } as never;
	}
	resume(): void { this.unblock?.(); }
}

class NonReadyLegacyManager extends ExactLegacyManager {
	constructor(ownedRoot: string, private readonly status: 'detached' | 'conflict') { super(ownedRoot); }
	override async inspectForLegacyTransition(root: string) {
		return {
			...inspection(root, 'ready'),
			manifestStatus: this.status,
			manifest: this.status === 'detached' && root === 'Legacy' ? { root } as never : null,
		} as never;
	}
}

class ResponseLossPointer extends MemoryManagedAssetsPointerStore {
	loseNextReadyNull = false;
	override async compareAndSet(expected: Parameters<MemoryManagedAssetsPointerStore['compareAndSet']>[0], next: Parameters<MemoryManagedAssetsPointerStore['compareAndSet']>[1]) {
		const result = await super.compareAndSet(expected, next);
		if (this.loseNextReadyNull && next.status === 'ready' && next.root === null) { this.loseNextReadyNull = false; throw new Error('response_lost'); }
		return result;
	}
}

function ok(status: 'applied' | 'detached', ownership: 'created' | 'existing'): ManagedAssetsResult {
	return { status, ownership, inspection: {} as never };
}

function inspection(root: string, manifestStatus: 'ready' | 'applying' | 'missing') {
	return { root, manifestPath: `${root}/Tyrian Companion Assets.json`, manifest: null,
		manifestStatus, bundleVersion: 1, locale: 'es' as const, assets: [] };
}

function actionContext(actionId: string, correlationId: string): ResolvedLocalDebugActionContext {
	return { component: 'settings', action: 'command_execute', actionId, correlationId };
}

function diagnosticHarness(): {
	createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext;
	event(context: LocalDebugEventContext): void;
	events: LocalDebugEventContext[];
	created: number;
} {
	const harness = {
		events: [] as LocalDebugEventContext[],
		created: 0,
		createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext {
			if (context.actionId === undefined) this.created += 1;
			const actionId = context.actionId ?? `generated-${this.created}`;
			return {
				...context, actionId,
				correlationId: context.correlationId ?? context.parent?.correlationId ?? context.parent?.actionId ?? actionId,
			};
		},
		event(context: LocalDebugEventContext): void { this.events.push(context); },
	};
	return harness;
}
