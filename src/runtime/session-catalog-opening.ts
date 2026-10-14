/**
 * One opening of the session catalog for everyone who asks while it is being opened. The factory opens an IndexedDB
 * connection; `sessionCatalog ??= await factory()` let two concurrent readers (the live summary reads names and metadata
 * with `Promise.all`) each call it, and the one that lost the assignment was never disposed. The pending promise is shared
 * by factory, so the session note runtime and the price history runtime (same factory, separate ports) join the same opening.
 */
import type { PublicCatalogService } from '../catalog/public-catalog-service';

export interface SessionCatalogPort {
	readonly sessionCatalogFactory: (() => Promise<PublicCatalogService>) | null;
	sessionCatalog: PublicCatalogService | null;
}

const openings = new WeakMap<object, Promise<PublicCatalogService>>();
const released = new WeakSet<PublicCatalogService>();

export async function openSessionCatalog(port: SessionCatalogPort): Promise<PublicCatalogService> {
	if (port.sessionCatalog !== null) return port.sessionCatalog;
	const factory = port.sessionCatalogFactory;
	// The unload drops the factory: nothing is opened (or reopened) once the plugin has been released.
	if (factory === null) throw new Error('The session catalog is not available.');
	let opening = openings.get(factory);
	if (opening === undefined) {
		const started = factory();
		opening = started;
		openings.set(factory, started);
		// A failed opening is not kept: the next reader tries again.
		started.catch(() => { if (openings.get(factory) === started) openings.delete(factory); });
	}
	const service = await opening;
	if (port.sessionCatalog !== null) return port.sessionCatalog;
	if (port.sessionCatalogFactory !== factory) {
		// Released while it was opening: what was opened has no owner any more.
		if (!released.has(service)) { released.add(service); service.dispose(); }
		throw new Error('The session catalog was released while it was opening.');
	}
	port.sessionCatalog = service;
	return service;
}
