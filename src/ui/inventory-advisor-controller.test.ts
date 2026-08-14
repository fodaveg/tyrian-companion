import { describe, expect, it, vi } from 'vitest';

import type { InventoryAdvisorPresentationSource } from '../advisor/inventory-advisor-presentation';
import type { InventoryAdvisorPresentationOptions } from '../advisor/inventory-advisor-presentation-model';
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
		const first = deferred<InventoryAdvisorPresentationSource>();
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
		const capture = deferred<InventoryAdvisorPresentationSource>();
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

	it('makes New win when Old completes after the newer explicit refresh', async () => {
		const a = deferred<InventoryAdvisorPresentationSource>();
		const b = deferred<InventoryAdvisorPresentationSource>();
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
		const ports = { load: vi.fn(async () => hostile as InventoryAdvisorPresentationSource) } satisfies InventoryAdvisorControllerPorts;
		await expect(new InventoryAdvisorPresentationController(ports).refresh()).resolves.toMatchObject({ status: 'invalid', groups: [] });
	});
});

function invalidSource(): InventoryAdvisorPresentationSource {
	return { input: {} as never, result: { status: 'invalid', reasons: [], report: null, envelope: null } };
}

function sourceNamed(fixtureName: string): InventoryAdvisorPresentationSource {
	return { input: { fixtureName } as never, result: invalidSource().result };
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
