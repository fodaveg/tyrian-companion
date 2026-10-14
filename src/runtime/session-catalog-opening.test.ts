import { describe, expect, it, vi } from 'vitest';
import type { PublicCatalogService } from '../catalog/public-catalog-service';
import { openSessionCatalog, type SessionCatalogPort } from './session-note-runtime';

function service() { const dispose = vi.fn(); return { instance: { dispose } as unknown as PublicCatalogService, dispose }; }
function deferred<T>() {
	let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe('openSessionCatalog', () => {
	it('opens one catalog for concurrent readers, also across two ports sharing the factory', async () => {
		const gate = deferred<PublicCatalogService>(); const factory = vi.fn(() => gate.promise);
		const a: SessionCatalogPort = { sessionCatalogFactory: factory, sessionCatalog: null };
		const b: SessionCatalogPort = { sessionCatalogFactory: factory, sessionCatalog: null };
		const reads = Promise.all([openSessionCatalog(a), openSessionCatalog(a), openSessionCatalog(b)]);
		const { instance: opened, dispose } = service(); gate.resolve(opened);
		const results = await reads;
		expect(factory).toHaveBeenCalledTimes(1);
		expect(results).toEqual([opened, opened, opened]);
		expect(dispose).not.toHaveBeenCalled();
		await openSessionCatalog(a);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it('does not open after the unload and disposes what was still opening', async () => {
		const gate = deferred<PublicCatalogService>(); const factory = vi.fn(() => gate.promise);
		const port: { sessionCatalogFactory: SessionCatalogPort['sessionCatalogFactory']; sessionCatalog: PublicCatalogService | null } = { sessionCatalogFactory: factory, sessionCatalog: null };
		const first = openSessionCatalog(port); const second = openSessionCatalog(port);
		const settled = Promise.allSettled([first, second]);
		// The core's shutdown: no catalog, no factory.
		port.sessionCatalogFactory = null;
		const { instance: opened, dispose } = service(); gate.resolve(opened);
		const [r1, r2] = await settled;
		expect(r1.status).toBe('rejected'); expect(r2.status).toBe('rejected');
		expect(dispose).toHaveBeenCalledOnce();
		expect(port.sessionCatalog).toBeNull();
		await expect(openSessionCatalog(port)).rejects.toThrow('not available');
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it('does not keep a failed opening: the next reader tries again', async () => {
		const { instance: opened } = service();
		const factory = vi.fn<() => Promise<PublicCatalogService>>().mockRejectedValueOnce(new Error('idb down')).mockResolvedValueOnce(opened);
		const port: SessionCatalogPort = { sessionCatalogFactory: factory, sessionCatalog: null };
		await expect(openSessionCatalog(port)).rejects.toThrow('idb down');
		await expect(openSessionCatalog(port)).resolves.toBe(opened);
		expect(factory).toHaveBeenCalledTimes(2);
	});
});
