/**
 * The persistence half of `TyrianHost` (vault, kv, priceHistory), kept apart from the `secrets`
 * subport in `tyrian-host.ts` so the H6.7 persistence boundary stays secret-free. Types only.
 */

import type { ManagedAssetsVault } from '../assets/managed-assets';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import type { LocalDebugStoragePort } from '../core/local-debug-writer';
import type { IndexedDbPriceHistoryStore } from '../economy/price-history-store';
import type { IndexedDbPriceSeedCacheStore, IndexedDbPriceSeedNoSeedStore } from '../economy/price-seed-cache-store';
import type { HalloweenBackfillVault } from '../halloween/halloween-note-backfill';
import type { InventoryVaultPort } from '../inventory/inventory-vault-sync';
import type { PilotMetricsExportVault } from '../sessions/pilot-metrics-export';
import type { SessionHistoryVault } from '../sessions/session-history';
import type { SessionNoteVault } from '../sessions/session-note-writer';
import type { WalletVaultPort } from '../wallet/wallet-vault-sync';

/** Undoes one registration or subscription. */
export type TyrianDisposer = () => void;

// ---------------------------------------------------------------------------------------------
// vault
// ---------------------------------------------------------------------------------------------

/** Neutral stand-in for Obsidian's `TAbstractFile`: a path, plus `stat.mtime` when it is a file. */
export interface TyrianVaultFile {
	readonly path: string;
	readonly mtime?: number;
}

/** One `vault.on('create' | 'modify' | 'delete' | 'rename')` event, reduced to paths. */
export interface TyrianVaultChange {
	readonly kind: 'create' | 'modify' | 'delete' | 'rename';
	readonly path: string;
	/** Only on `rename`. */
	readonly oldPath?: string;
}

/** Every vault operation the seven path-based ports below use, addressed by vault-relative path. */
export interface TyrianVault {
	/** session-history.ts:229/256/392 (whole vault), halloween-note-backfill.ts:59, inventory-vault-sync.ts:882, wallet-vault-sync.ts:294. */
	markdownFiles(): readonly TyrianVaultFile[];
	/** managed-assets.ts:217 (every file, not only markdown). */
	listFiles(): TyrianVaultFile[];
	/** session-history.ts:438/446 (true for folders too). */
	exists(path: string): boolean;
	/** All seven ports; ALSO non-null for folders: inventory-vault-sync.ts:1357, wallet-vault-sync.ts:435, session-note-writer.ts:137, managed-assets.ts:740. */
	file(path: string): TyrianVaultFile | null;
	/** All seven ports. */
	read(file: TyrianVaultFile): Promise<string>;
	/** session-note-writer.ts:122, session-history.ts:368, inventory-vault-sync.ts:856, wallet-vault-sync.ts:270, managed-assets.ts:350/384/505/532. */
	process(file: TyrianVaultFile, update: (current: string) => string): Promise<string>;
	/** Every writing port (folders are created one segment at a time by the caller). */
	createFolder(path: string): Promise<void>;
	/** Every writing port; also non-markdown: pilot-metrics-export.ts:137-140 (.json/.csv), session-history.ts:419 (.csv), managed-assets.ts:375 (.base). */
	create(path: string, content: string): Promise<TyrianVaultFile>;
	/** inventory-vault-sync.ts:845, managed-assets.ts:508 (via `fileManager.trashFile` today). */
	trashFile(file: TyrianVaultFile): Promise<void>;
	/** main.ts:959-962 (Halloween backfill refresh, filtered to `<outputFolder>/sessions/*.md`). */
	onChange(root: string, listener: (change: TyrianVaultChange) => void): TyrianDisposer;
	/** core/settings.ts:241/608 (forbidden output prefix), local-debug-contract.ts:122, main.ts:2186. */
	readonly configDir: string;
	/** main.ts:742 (hashed into the `vaultId` every IndexedDB record is keyed by). */
	canonicalIdentity(): string;
	/** main.ts:675 (local-debug sanitizer strips it from messages); null where there is no filesystem. */
	basePath(): string | null;
	/** main.ts:1515 (absolute path handed to `shell.openPath`); null where there is no filesystem. */
	fullPath(path: string): string | null;
	/** main.ts:1566-1573 (support package under `<outputFolder>/diagnostics`), main.ts:2187 (advisor capture receipt under configDir). */
	readonly adapter: LocalDebugStoragePort;
}

/** Compile-time proof that one `TyrianVault` satisfies each of the seven existing ports. */
type Satisfies<Port, Contract extends Port> = Contract;
export type TyrianVaultPortConformance = [
	// Its `process` resolves to void: main.ts:1174 discards the text the other six ports return.
	Satisfies<Omit<SessionHistoryVault, 'process'>, TyrianVault>,
	Satisfies<SessionNoteVault, TyrianVault>,
	Satisfies<PilotMetricsExportVault, TyrianVault>,
	Satisfies<HalloweenBackfillVault, TyrianVault>,
	Satisfies<InventoryVaultPort, TyrianVault>,
	Satisfies<WalletVaultPort, TyrianVault>,
	Satisfies<ManagedAssetsVault, TyrianVault>,
];

// ---------------------------------------------------------------------------------------------
// kv
// ---------------------------------------------------------------------------------------------

export interface TyrianKvPort {
	/** main.ts:746-1136/2866 hand it to every store opened through core/indexed-db-open.ts. */
	readonly indexedDB: IDBFactory;
}

// ---------------------------------------------------------------------------------------------
// priceHistory: single writer (the collector); read wherever the library syncs
// ---------------------------------------------------------------------------------------------

/** The operations price-history-runtime.ts and price-history-capture.ts call on the store today. */
export type TyrianPriceHistoryStore = Pick<IndexedDbPriceHistoryStore,
	| 'ensureSeedWatchList'
	| 'observeItems'
	| 'applyDerivedWatchList'
	| 'readWatchList'
	| 'claimSlot'
	| 'commitSlot'
	| 'readDaily'
	| 'compactAndPrune'
	| 'close'>;

/** The datawars2 seed cache as price-seed-panel-service.ts, price-seed-bulk-refresh.ts and main.ts use it. */
export type TyrianPriceSeedCache = Pick<IndexedDbPriceSeedCacheStore, 'get' | 'put' | 'close'>;

/** The remembered `no_seed` answers as price-seed-bulk-refresh.ts uses them. */
export type TyrianPriceSeedNoSeedCache = Pick<IndexedDbPriceSeedNoSeedStore, 'get' | 'put' | 'delete' | 'close'>;

export interface TyrianPriceHistoryPort {
	/** price-history-runtime.ts:304 (capture via price-history-capture.ts, compaction, watch list, daily series for the chart). */
	open(diagnostics?: LocalDebugPersistenceProbe): Promise<TyrianPriceHistoryStore>;
	/** price-seed-panel-service.ts:165 (chart and `tyrian-price-history` block), price-seed-bulk-refresh.ts:233, main.ts:2866. */
	openSeedCache(): Promise<TyrianPriceSeedCache>;
	/** price-seed-bulk-refresh.ts:234. */
	openNoSeedCache(): Promise<TyrianPriceSeedNoSeedCache>;
}
