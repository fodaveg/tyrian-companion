/**
 * «Logros» composition, lifted out of `initializeRuntime` like the sessions, advisor, price history
 * and Halloween assemblies: the three pieces of `src/achievements/` the section runs on, built from
 * explicit inputs and handed back inert. Nothing opens IndexedDB or asks the network here; the
 * store opens on first use and the services only when the view asks.
 */

import { AchievementCatalogService } from '../achievements/achievement-catalog-service';
import { IndexedDbAchievementStore } from '../achievements/achievement-store';
import { TrackedProgressService } from '../achievements/tracked-progress-service';
import type { GuildWars2Client } from '../account/guild-wars-2-client';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';

export interface AchievementsAssemblyInput {
	/** The IndexedDB factory the achievements store opens against. */
	factory: IDBFactory;
	/** The keyed client; only `TrackedProgressService.refresh` ever uses it (docs/PRODUCT.md:9). */
	client: Pick<GuildWars2Client, 'beginOperation'>;
	/** The public catalog gateway: groups, categories, index pages and details, with no key. */
	publicGateway: PublicCatalogGateway;
	diagnostics?: LocalDebugPersistenceProbe;
}

export interface AchievementsAssembly {
	readonly store: IndexedDbAchievementStore;
	readonly catalog: AchievementCatalogService;
	readonly progress: TrackedProgressService;
	/** On plugin unload: a build in flight stops before its next page, and the store closes. */
	dispose(): void;
}

/** Builds the store and the two services of the section. Nothing is opened, fetched or started here. */
export function assembleAchievements(input: AchievementsAssemblyInput): AchievementsAssembly {
	const store = new IndexedDbAchievementStore(input.factory, undefined, input.diagnostics);
	const catalog = new AchievementCatalogService(input.publicGateway, store);
	const progress = new TrackedProgressService(input.client, store);
	return {
		store, catalog, progress,
		dispose: () => {
			catalog.dispose();
			store.dispose();
		},
	};
}
