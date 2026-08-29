import { describe, expect, it, vi } from 'vitest';

import type { InventoryAdvisorPresentationSource, InventoryAdvisorProducerPresentationSource } from '../advisor/inventory-advisor-presentation';
import type { InventoryAdvisorPresentationOptions } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowResult } from '../advisor/inventory-advisor-workflow';
import { ambientCapabilityUse } from '../test/ambient-capabilities';
import { InventoryAdvisorPresentationController, type InventoryAdvisorControllerPorts } from './inventory-advisor-controller';

const buildPresentationCalls = vi.fn();

vi.mock('../advisor/inventory-advisor-presentation', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../advisor/inventory-advisor-presentation')>();
	return {
		...actual,
		buildInventoryAdvisorPresentation(
			source: InventoryAdvisorPresentationSource,
			options: InventoryAdvisorPresentationOptions = {},
		) {
			buildPresentationCalls(options);
			const fixtureName = (source.input as unknown as { fixtureName?: string }).fixtureName;
			return fixtureName === undefined ? actual.buildInventoryAdvisorPresentation(source, options) : namedPresentation(fixtureName);
		},
	};
});

describe('H5.11 inventory advisor presentation controller', () => {
	it('opens and reads current state without I/O, refreshes explicitly, and never leaks a mutable cached value', async () => {
		const first = deferred<InventoryAdvisorWorkflowResult>();
		const ports = { load: vi.fn(() => first.promise) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		expect(controller.open()).toMatchObject({ status: 'loading', groups: [] });
		expect(controller.current()).toMatchObject({ status: 'loading', groups: [] });
		expect(ports.load).not.toHaveBeenCalled();
		const refresh = controller.refresh();
		await Promise.resolve();
		expect(ports.load).toHaveBeenCalledOnce();
		first.resolve(invalidSource());
		const firstModel = await refresh;
		firstModel.title = 'Mutated';
		const cached = controller.current();
		expect(ports.load).toHaveBeenCalledOnce();
		expect(cached.title).toBe('Inventory advisor');
	});

	it('bumps contentVersion only when the underlying content actually changes, never on a mere re-read', async () => {
		// `current()` clones on every call, so a UI layer that wants to skip rebuilding
		// expensive DOM for an unrelated re-render (e.g. a live sync-panel tick) needs a
		// number that stays stable across repeated reads and only moves on real content.
		const ports = { load: vi.fn(async () => sourceNamed('First')) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const beforeRefresh = controller.current().contentVersion;
		expect(controller.current().contentVersion).toBe(beforeRefresh);
		expect(controller.current().contentVersion).toBe(beforeRefresh);

		await controller.refresh();
		const afterRefresh = controller.current().contentVersion;
		expect(afterRefresh).not.toBe(beforeRefresh);
		expect(controller.current().contentVersion).toBe(afterRefresh);
		expect(controller.current().contentVersion).toBe(afterRefresh);

		controller.invalidate();
		expect(controller.current().contentVersion).not.toBe(afterRefresh);
	});

	it('memoizes the built model per contentVersion and options, and freezes it against nested mutation', async () => {
		// A live sync-panel tick calls `current()` once per written note while the
		// advisor's own content never moves; re-deriving and deep-cloning the whole
		// presentation on every one of those reads made progress reporting on a large
		// inventory quadratic in row count. This locks in that a stable `contentVersion`
		// reuses one build instead of repeating it.
		buildPresentationCalls.mockClear();
		const ports = { load: vi.fn(async () => sourceNamed('Memoized')) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		await controller.refresh();
		expect(buildPresentationCalls).toHaveBeenCalledOnce();

		for (let repeat = 0; repeat < 5; repeat += 1) expect(firstRowName(controller.current())).toBe('Memoized');
		expect(buildPresentationCalls).toHaveBeenCalledOnce();

		// A caller reaching into a nested structure of what it received (not just the
		// top-level field the older test already covers) is rejected outright, not
		// silently accepted and then leaked into a later read.
		const leaked = controller.current();
		expect(() => leaked.groups[0]!.rows[0]!.allocations.push({
			positionRef: '#/positions/intruder', quantity: 999, location: { source: 'bank', slot: 0 },
		})).toThrow(TypeError);
		expect(() => { leaked.groups[0]!.rows[0]!.name = 'Corrupted'; }).toThrow(TypeError);
		expect(firstRowName(controller.current())).toBe('Memoized');
		expect(controller.current().groups[0]!.rows[0]!.allocations).toHaveLength(1);

		// Different options are a different cache entry, and a later refresh rebuilds.
		controller.current({ sort: 'name_asc' });
		expect(buildPresentationCalls).toHaveBeenCalledTimes(2);
		await controller.refresh();
		expect(buildPresentationCalls).toHaveBeenCalledTimes(3);
	});

	it('shares a single loader flight across concurrent refreshes in one generation', async () => {
		const capture = deferred<InventoryAdvisorWorkflowResult>();
		const ports = { load: vi.fn(() => capture.promise) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const first = controller.refresh();
		const second = controller.refresh();
		await Promise.resolve();
		expect(ports.load).toHaveBeenCalledOnce();
		capture.resolve(sourceNamed('Shared'));
		expect(await first).toEqual(await second);
		expect(firstRowName(controller.current())).toBe('Shared');
	});

	it('queues a reclassification after an in-flight refresh so the final model uses the reclassified capture', async () => {
		const captured = deferred<InventoryAdvisorWorkflowResult>();
		const reclassified = deferred<InventoryAdvisorWorkflowResult>();
		const ports = {
			load: vi.fn(() => captured.promise), reclassify: vi.fn(() => reclassified.promise),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const refreshing = controller.refresh();
		await Promise.resolve();
		const reclassifying = controller.reclassify();
		expect(ports.reclassify).not.toHaveBeenCalled();
		captured.resolve(sourceNamed('Captured'));
		await settle();
		expect(ports.reclassify).toHaveBeenCalledOnce();
		reclassified.resolve(sourceNamed('Reclassified'));
		await Promise.all([refreshing, reclassifying]);
		expect(firstRowName(controller.current())).toBe('Reclassified');
	});

	it('queues a new refresh after an in-flight reclassification so fresh capture wins in the opposite order', async () => {
		const reclassified = deferred<InventoryAdvisorWorkflowResult>();
		const captured = deferred<InventoryAdvisorWorkflowResult>();
		const ports = {
			load: vi.fn().mockResolvedValueOnce(sourceNamed('Initial')).mockReturnValueOnce(captured.promise),
			reclassify: vi.fn(() => reclassified.promise),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		await controller.refresh();
		const reclassifying = controller.reclassify();
		await Promise.resolve();
		const refreshing = controller.refresh();
		expect(ports.load).toHaveBeenCalledOnce();
		reclassified.resolve(sourceNamed('Reclassified'));
		await settle();
		expect(ports.load).toHaveBeenCalledTimes(2);
		captured.resolve(sourceNamed('Fresh'));
		await Promise.all([reclassifying, refreshing]);
		expect(firstRowName(controller.current())).toBe('Fresh');
	});

	it('serializes two reclassifications so a later preference generation produces the final model', async () => {
		const first = deferred<InventoryAdvisorWorkflowResult>();
		const second = deferred<InventoryAdvisorWorkflowResult>();
		const ports = {
			load: vi.fn(async () => sourceNamed('Captured')),
			reclassify: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		await controller.refresh();
		const afterGenerationOne = controller.reclassify();
		const afterGenerationTwo = controller.reclassify();
		await Promise.resolve();
		expect(ports.reclassify).toHaveBeenCalledOnce();
		first.resolve(sourceNamed('Preference generation 1'));
		await settle();
		expect(ports.reclassify).toHaveBeenCalledTimes(2);
		second.resolve(sourceNamed('Preference generation 2'));
		await Promise.all([afterGenerationOne, afterGenerationTwo]);
		expect(firstRowName(controller.current())).toBe('Preference generation 2');
	});

	it('projects the explicit missing-rules result as blocked without inventing rows', async () => {
		const ports = { load: vi.fn(async () => ({ status: 'blocked', reason: 'missing_rules' } as const)) } satisfies InventoryAdvisorControllerPorts;
		await expect(new InventoryAdvisorPresentationController(ports).refresh())
			.resolves.toMatchObject({ status: 'blocked', blockedReason: 'missing_rules', groups: [] });
		expect(ports.load).toHaveBeenCalledOnce();
	});

	it('preserves safe block reasons without account-bound data', async () => {
		for (const reason of ['capture_unavailable', 'capture_invalid', 'preferences_unavailable'] as const) {
			const controller = new InventoryAdvisorPresentationController({ load: async () => ({ status: 'blocked', reason }) });
			const model = await controller.refresh();
			expect(model).toMatchObject({ status: 'blocked', blockedReason: reason, groups: [] });
			expect(JSON.stringify(model)).not.toMatch(/account|vault|token|secret/iu);
		}
	});

	it('defers a settings-triggered reclassification until the first explicit capture exists', async () => {
		const ports = {
			load: vi.fn(async () => sourceNamed('Captured later')),
			reclassify: vi.fn(async () => sourceNamed('Reclassified')),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		await expect(controller.reclassify()).resolves.toMatchObject({ status: 'loading', groups: [] });
		expect(ports.load).not.toHaveBeenCalled();
		expect(ports.reclassify).not.toHaveBeenCalled();
		await controller.refresh();
		await controller.reclassify();
		expect(ports.load).toHaveBeenCalledOnce();
		expect(ports.reclassify).toHaveBeenCalledOnce();
	});

	it('keeps the last valid result only when a later refresh has an explicitly transient capture failure', async () => {
		const ports = { load: vi.fn()
			.mockResolvedValueOnce(sourceNamed('Last good'))
			.mockResolvedValueOnce({ status: 'blocked', reason: 'capture_unavailable' } as const)
			.mockResolvedValueOnce({ status: 'blocked', reason: 'capture_invalid' } as const) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		expect(firstRowName(await controller.refresh())).toBe('Last good');
		const blocked = await controller.refresh();
		expect(blocked).toMatchObject({ status: 'ready', refreshWarning: 'capture_unavailable' });
		expect(firstRowName(blocked)).toBe('Last good');
		await expect(controller.refresh()).resolves.toMatchObject({ status: 'blocked', blockedReason: 'capture_invalid', groups: [] });
	});

	it('never preserves a result across preference reclassification failure or an unexpected rejection', async () => {
		const ports = {
			load: vi.fn(async () => sourceNamed('Last good')),
			reclassify: vi.fn(async () => ({ status: 'blocked', reason: 'preferences_unavailable' } as const)),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		expect(firstRowName(await controller.refresh())).toBe('Last good');
		await expect(controller.reclassify()).resolves.toMatchObject({
			status: 'blocked', blockedReason: 'preferences_unavailable', groups: [],
		});
		const rejected = new InventoryAdvisorPresentationController({
			load: vi.fn().mockResolvedValueOnce(sourceNamed('Old')).mockRejectedValueOnce(new Error('secret account detail')),
		});
		await rejected.refresh();
		const failed = await rejected.refresh();
		expect(failed).toMatchObject({ status: 'invalid', blockedReason: 'unexpected_failure', groups: [] });
		expect(JSON.stringify(failed)).not.toContain('secret account detail');
	});

	it('makes New win when Old completes after the newer explicit refresh', async () => {
		const a = deferred<InventoryAdvisorWorkflowResult>();
		const b = deferred<InventoryAdvisorWorkflowResult>();
		const ports = { load: vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const oldRefresh = controller.refresh();
		await Promise.resolve();
		controller.invalidate();
		const newRefresh = controller.refresh();
		b.resolve(sourceNamed('New'));
		expect(firstRowName(await newRefresh)).toBe('New');
		a.resolve(sourceNamed('Old'));
		const staleResult = await oldRefresh;
		expect(firstRowName(staleResult)).toBe('New');
		expect(firstRowName(controller.current())).toBe('New');
		expect(JSON.stringify([staleResult, controller.current()])).not.toContain('Old');
		expect(ports.load).toHaveBeenCalledTimes(2);
	});

	it('fails closed when an integration value cannot be cloned into the memory cache', async () => {
		const hostile = new Proxy({}, { ownKeys() { throw new Error('trap'); } });
		const ports = { load: vi.fn(async () => hostile as InventoryAdvisorWorkflowResult) } satisfies InventoryAdvisorControllerPorts;
		await expect(new InventoryAdvisorPresentationController(ports).refresh()).resolves.toMatchObject({ status: 'invalid', groups: [] });
	});

	it('fails closed on loader rejection and disposal prevents a late flight or later refresh from loading', async () => {
		const rejected = { load: vi.fn(async () => { throw new Error('unavailable'); }) } satisfies InventoryAdvisorControllerPorts;
		await expect(new InventoryAdvisorPresentationController(rejected).refresh())
			.resolves.toMatchObject({ status: 'invalid', blockedReason: 'unexpected_failure', groups: [] });
		const flight = deferred<InventoryAdvisorWorkflowResult>();
		const ports = { load: vi.fn(() => flight.promise) } satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const pending = controller.refresh();
		await Promise.resolve();
		controller.dispose();
		flight.resolve(sourceNamed('Late'));
		await expect(pending).resolves.toMatchObject({ status: 'invalid', groups: [] });
		await expect(controller.refresh()).resolves.toMatchObject({ status: 'invalid', groups: [] });
		expect(ports.load).toHaveBeenCalledOnce();
	});

	it('answers open and current from memory in every state without touching a single port', async () => {
		const ports = {
			load: vi.fn(async () => sourceNamed('Cached')),
			reclassify: vi.fn(async () => sourceNamed('Reclassified')),
			invalidate: vi.fn(),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const calls = () => [ports.load.mock.calls.length, ports.reclassify.mock.calls.length,
			ports.invalidate.mock.calls.length];
		controller.open();
		controller.current({ sort: 'name_asc' });
		expect(calls()).toEqual([0, 0, 0]);
		expect(firstRowName(await controller.refresh())).toBe('Cached');
		for (let repeat = 0; repeat < 3; repeat += 1) {
			expect(firstRowName(controller.open())).toBe('Cached');
			expect(firstRowName(controller.current({ filters: { groups: ['review'] } }))).toBe('Cached');
		}
		expect(calls()).toEqual([1, 0, 0]);
		controller.dispose();
		controller.open();
		controller.current();
		expect(calls()).toEqual([1, 0, 0]);
	});

	it('refreshes and reclassifies without reaching for any ambient capability', async () => {
		const names: (string | undefined)[] = [];
		const used = await ambientCapabilityUse(async () => {
			const ports = {
				load: vi.fn(async () => sourceNamed('Captured')),
				reclassify: vi.fn(async () => sourceNamed('Reclassified')),
				invalidate: vi.fn(),
			} satisfies InventoryAdvisorControllerPorts;
			const controller = new InventoryAdvisorPresentationController(ports);
			names.push(firstRowName(await controller.refresh()));
			names.push(firstRowName(await controller.reclassify()));
			controller.invalidate();
			names.push(firstRowName(controller.current()));
			controller.block();
			names.push(controller.current().blockedReason);
			controller.dispose();
		});
		expect(used).toEqual([]);
		expect(names).toEqual(['Captured', 'Reclassified', undefined, 'preferences_unavailable']);
	});
});

function invalidSource(): InventoryAdvisorWorkflowResult {
	return { status: 'ready', source: invalidPresentationSource() };
}

function invalidPresentationSource(): InventoryAdvisorProducerPresentationSource {
	return { input: {} as never, result: { status: 'invalid', reasons: [], report: null, envelope: null } };
}

function sourceNamed(fixtureName: string): InventoryAdvisorWorkflowResult {
	const source = invalidPresentationSource();
	return { status: 'ready', source: { input: { fixtureName } as never, result: source.result } };
}

function namedPresentation(name: string) {
	return {
		version: 1 as const, status: 'ready' as const, discardReview: { status: 'unavailable' as const },
		groups: [{ group: 'review' as const, rows: [{
			id: `#/fixtures/${name}`, itemId: 10, name, icon: null, ownedQuantity: 1, availableQuantity: 1,
			action: 'review' as const, quantity: 1,
			allocations: [{ positionRef: '#/positions/10/0', quantity: 1, location: { source: 'bank' as const, slot: 0 } }],
			reasonCodes: [], protectionReasons: [], coverage: { snapshot: 'complete' as const, inventory: 'complete' as const,
				catalog: 'complete' as const, prices: 'complete' as const, reservations: 'complete' as const,
				accountSignals: 'complete' as const, rules: 'complete' as const },
			group: 'review' as const, value: { status: 'unavailable' as const, route: null }, marketComparison: null,
			burden: null, irreversibleReviewOnly: false as const,
			discardProof: null,
		}] }],
	};
}

function firstRowName(model: Awaited<ReturnType<InventoryAdvisorPresentationController['refresh']>>): string | undefined {
	return model.groups[0]?.rows[0]?.name;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
	return { promise, resolve };
}

async function settle(): Promise<void> {
	/* A queued flight crosses the completion, finally, and chained `then` jobs. */
	for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}
