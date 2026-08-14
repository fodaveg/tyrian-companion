import { describe, expect, it, vi } from 'vitest';

import type { InventoryAdvisorPresentationSource, InventoryAdvisorProducerPresentationSource } from '../advisor/inventory-advisor-presentation';
import type { InventoryAdvisorPresentationOptions } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowResult } from '../advisor/inventory-advisor-workflow';
import { InventoryAdvisorPresentationController, type InventoryAdvisorControllerPorts } from './inventory-advisor-controller';

vi.mock('../advisor/inventory-advisor-presentation', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../advisor/inventory-advisor-presentation')>();
	return {
		...actual,
		buildInventoryAdvisorPresentation(
			source: InventoryAdvisorPresentationSource,
			options: InventoryAdvisorPresentationOptions = {},
		) {
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
			load: vi.fn(() => captured.promise), reclassify: vi.fn(() => reclassified.promise),
		} satisfies InventoryAdvisorControllerPorts;
		const controller = new InventoryAdvisorPresentationController(ports);
		const reclassifying = controller.reclassify();
		await Promise.resolve();
		const refreshing = controller.refresh();
		expect(ports.load).not.toHaveBeenCalled();
		reclassified.resolve(sourceNamed('Reclassified'));
		await settle();
		expect(ports.load).toHaveBeenCalledOnce();
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
			.resolves.toMatchObject({ status: 'blocked', groups: [] });
		expect(ports.load).toHaveBeenCalledOnce();
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
			.resolves.toMatchObject({ status: 'invalid', groups: [] });
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
			id: `#/fixtures/${name}`, itemId: 10, name, ownedQuantity: 1, availableQuantity: 1,
			action: 'review' as const, quantity: 1,
			allocations: [{ positionRef: '#/positions/10/0', quantity: 1, location: { source: 'bank' as const, slot: 0 } }],
			reasonCodes: [], coverage: { snapshot: 'complete' as const, inventory: 'complete' as const,
				catalog: 'complete' as const, prices: 'complete' as const, reservations: 'complete' as const,
				accountSignals: 'complete' as const, rules: 'complete' as const },
			group: 'review' as const, value: { status: 'unavailable' as const, route: null }, irreversibleReviewOnly: false as const,
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
