import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

/**
 * The only network the note pipeline still touches at write time is the public item catalog; the
 * prices already travelled inside the runtime record. Answering it here is what lets this test
 * exercise the real `main.ts` wiring instead of a hand-built note input.
 */
const publicApi = vi.hoisted(() => ({
	items: new Map<number, Record<string, unknown>>(),
	requestedItemIds: [] as number[][],
}));

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	requestUrl: async ({ url }: { url: string }) => {
		const ids = itemIdsFromUrl(url);
		if (ids === null) return { status: 404, headers: {}, json: [] };
		publicApi.requestedItemIds.push(ids);
		return { status: 200, headers: {}, json: ids.flatMap((id) => publicApi.items.get(id) ?? []) };
	},
}));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { DEFAULT_SETTINGS } from './core/settings';
import type { PublicCatalogGateway } from './catalog/public-catalog-client';
import type { HttpResponse } from './core/http';
import {
	SessionPriceSnapshotService,
	type SessionPriceSnapshot,
} from './economy/session-price-snapshot';
import { HALLOWEEN_TOT_BAG_ITEM_ID } from './economy/session-valuation';
import TyrianCompanionPlugin from './main';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import type { StorageSnapshot } from './account/storage-snapshot-model';
import type { StorageDelta } from './account/storage-delta-model';
import type { CompleteSessionState, SessionSnapshotReference } from './sessions/session';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import { inspectDurableSessionNote } from './sessions/session-history';
import { buildSessionHistoryAggregate } from './sessions/session-history-summary';
import {
	createSessionRuntimeRecord,
	IndexedDbSessionRuntimeStore,
	type SessionRuntimeRecord,
} from './sessions/session-runtime-store';

const BLOOD_ITEM_ID = 24_295;
const SACKS_GAINED = 240;
const BLOOD_GAINED = 12;
/** Baseline close to the player's stop: exactly one hour of farming. */
const BASELINE_COMPLETED_AT = '2026-08-13T08:00:00.000Z';
const STOPPED_AT = '2026-08-13T09:00:00.000Z';
/** The closing capture only starts reading after the settlement window, ten minutes later. */
const FINAL_STARTED_AT = '2026-08-13T09:10:00.000Z';
const FINAL_COMPLETED_AT = '2026-08-13T09:10:01.000Z';
const ONE_HOUR_MS = 3_600_000;

interface NoteHarness {
	initializeRuntime(): Promise<void>;
	retrySessionSummarySave(): Promise<void>;
	getSavedSessionNotePath(): string | null;
	getSessionSummarySaveState(): 'unknown' | 'saving' | 'saved' | 'failed';
}

describe('a closed session publishes real money in its note', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		publicApi.items.clear();
		publicApi.requestedItemIds.length = 0;
	});

	it('writes gold, gold per hour, sacks and sacks per hour instead of not_evaluated', async () => {
		seedCatalog();
		const factory = new IDBFactory();
		const record = await valuedSessionRecord();
		await persist(factory, record);
		const notes = new Map<string, string>();
		const plugin = notePlugin(factory, notes);

		await plugin.initializeRuntime();
		await plugin.retrySessionSummarySave();

		expect(plugin.getSessionSummarySaveState()).toBe('saved');
		const path = plugin.getSavedSessionNotePath();
		expect(path).not.toBeNull();
		const frontmatter = readFrontmatter(notes.get(path!) ?? '');

		// The bug this test exists for: every one of these was null, and the coverage said
		// `not_evaluated`, because `main.ts` built the note input with `valuation: null`.
		expect(frontmatter.tc_valuation_coverage).toBe('complete');
		expect(frontmatter.tc_sacks).toBe(SACKS_GAINED);
		expect(frontmatter.tc_duration_ms).toBe(ONE_HOUR_MS);
		expect(frontmatter.tc_sacks_per_hour_milli).toBe(SACKS_GAINED * 1_000);
		expect(typeof frontmatter.tc_observed_immediate_copper).toBe('number');
		expect(frontmatter.tc_observed_immediate_copper as number).toBeGreaterThan(0);
		expect(typeof frontmatter.tc_observed_listing_copper).toBe('number');
		expect(frontmatter.tc_observed_listing_copper as number).toBeGreaterThan(0);
		// One hour of farming: the per-hour rate is the total, which is what makes this an
		// assertion about arithmetic on real evidence rather than about a non-null field.
		expect(frontmatter.tc_immediate_copper_per_hour).toBe(frontmatter.tc_observed_immediate_copper);
		expect(frontmatter.tc_listing_copper_per_hour).toBe(frontmatter.tc_observed_listing_copper);
		expect(frontmatter.tc_price_source).toBe('gw2-commerce-prices');
	});

	it('renders an economy block a reader can spend, not the not-evaluated placeholder', async () => {
		seedCatalog();
		const factory = new IDBFactory();
		await persist(factory, await valuedSessionRecord());
		const notes = new Map<string, string>();
		const plugin = notePlugin(factory, notes);

		await plugin.initializeRuntime();
		await plugin.retrySessionSummarySave();

		const content = notes.get(plugin.getSavedSessionNotePath() ?? '') ?? '';
		// The harness runs on the default locale, English. `Observed total` is the label the economy
		// block prints only when the valuation is valid; before the wiring it printed `Not evaluated`
		// and then, with only the valuation, `Economic evidence is invalid`, because the block needs
		// every gained row to resolve an allocation.
		expect(content).toMatch(/\*\*Observed total\*\*/u);
		expect(content).not.toMatch(/Economic evidence is invalid/u);
		expect(content).not.toMatch(/\*\*Not evaluated\*\*/u);
		expect(content).toMatch(/- Immediate net per hour: \d+g \d+s \d+c/u);
		expect(content).toMatch(/\| Reserved 0 · Hold 0 · Free 240 \|/u);
	});

	it('produces a durable record the history performance panel actually accepts', async () => {
		seedCatalog();
		const factory = new IDBFactory();
		await persist(factory, await valuedSessionRecord());
		const notes = new Map<string, string>();
		const plugin = notePlugin(factory, notes);

		await plugin.initializeRuntime();
		await plugin.retrySessionSummarySave();

		const inspected = await inspectDurableSessionNote(notes.get(plugin.getSavedSessionNotePath() ?? '') ?? '');
		if (inspected.status !== 'ok') throw new Error(`The written note is not durable: ${inspected.status}.`);
		const session = inspected.session;
		// The three economic filters of `performanceGroup`, measured on the note the plugin wrote.
		expect(session.classification).toBe('exact');
		expect(session.confidence).toBe('high');
		expect(session.valuationCoverage).toBe('complete');
		expect(session.sacks).toBe(SACKS_GAINED);
		expect(session.observedImmediateCopper).not.toBeNull();

		// Grouping happens before those filters and needs a declared activity. Nothing in the
		// runtime declares one for a manually started session, so the activity is supplied here to
		// measure the economic filters; without it every session lands in `missingContextSessions`.
		const grouped = buildSessionHistoryAggregate([
			{ ...session, sessionRef: 'a'.repeat(64), activity: 'halloween' },
			{ ...session, sessionRef: 'b'.repeat(64), activity: 'halloween' },
		]);
		expect(grouped.performance.groups).toHaveLength(1);
		expect(grouped.performance.groups[0]).toMatchObject({
			build: 'Farm', eligibleSessions: 2, status: 'ready', exclusions: [],
			sacksPerHourMilli: SACKS_GAINED * 1_000,
		});
		expect(buildSessionHistoryAggregate([session]).performance.missingContextSessions).toBe(1);
	});

	it('resolves the catalog for the gained items only', async () => {
		seedCatalog();
		const factory = new IDBFactory();
		await persist(factory, await valuedSessionRecord());
		const plugin = notePlugin(factory, new Map<string, string>());

		await plugin.initializeRuntime();
		await plugin.retrySessionSummarySave();

		expect(publicApi.requestedItemIds.length).toBeGreaterThan(0);
		for (const batch of publicApi.requestedItemIds) {
			expect(batch).toEqual([BLOOD_ITEM_ID, HALLOWEEN_TOT_BAG_ITEM_ID]);
		}
	});

	it('leaves a session the catalog could not describe unvalued instead of publishing a guess', async () => {
		const factory = new IDBFactory();
		await persist(factory, await valuedSessionRecord());
		const notes = new Map<string, string>();
		const plugin = notePlugin(factory, notes);

		await plugin.initializeRuntime();
		await plugin.retrySessionSummarySave();

		const frontmatter = readFrontmatter(notes.get(plugin.getSavedSessionNotePath() ?? '') ?? '');
		expect(frontmatter.tc_valuation_coverage).toBe('partial');
		expect(frontmatter.tc_observed_immediate_copper).toBe(0);
		expect(frontmatter.tc_sacks).toBe(SACKS_GAINED);
	});
});

function seedCatalog(): void {
	publicApi.items.set(HALLOWEEN_TOT_BAG_ITEM_ID, catalogPayload(HALLOWEEN_TOT_BAG_ITEM_ID, 'Bolsa de truco o trato', 10));
	publicApi.items.set(BLOOD_ITEM_ID, catalogPayload(BLOOD_ITEM_ID, 'Vial de sangre poderosa', 33));
}

function catalogPayload(id: number, name: string, vendorValue: number): Record<string, unknown> {
	return {
		id, name, type: 'Trophy', rarity: 'Fine', level: 0, vendor_value: vendorValue,
		flags: [], game_types: ['Activity', 'Pve'], restrictions: [],
	};
}

/** Quotes and order-book depth the session captured when the player closed it. */
function marketGateway(): PublicCatalogGateway {
	const quotes: Record<number, { bid: number; ask: number }> = {
		[HALLOWEEN_TOT_BAG_ITEM_ID]: { bid: 60, ask: 96 },
		[BLOOD_ITEM_ID]: { bid: 2_000, ask: 2_400 },
	};
	return {
		requestDetailed: async (path: string): Promise<HttpResponse> => {
			const ids = idsFromQuery(path);
			if (ids === null) return { status: 404, headers: {}, body: [] };
			if (path.startsWith('commerce/prices')) {
				return { status: 200, headers: {}, body: ids.map((id) => ({
					id, whitelisted: true,
					buys: { quantity: 100_000, unit_price: quotes[id]?.bid ?? 1 },
					sells: { quantity: 100_000, unit_price: quotes[id]?.ask ?? 2 },
				})) };
			}
			if (path.startsWith('commerce/listings')) {
				return { status: 200, headers: {}, body: ids.map((id) => ({
					id,
					buys: [{ listings: 1, unit_price: quotes[id]?.bid ?? 1, quantity: 100_000 }],
					sells: [{ listings: 1, unit_price: quotes[id]?.ask ?? 2, quantity: 100_000 }],
				})) };
			}
			return { status: 404, headers: {}, body: [] };
		},
	};
}

async function valuedSessionRecord(): Promise<SessionRuntimeRecord> {
	const baseline = storageDeltaSnapshot({
		startedAt: '2026-08-13T07:59:59.000Z',
		completedAt: BASELINE_COMPLETED_AT,
	});
	const final = afterSnapshot({
		startedAt: FINAL_STARTED_AT,
		completedAt: FINAL_COMPLETED_AT,
		holdings: [
			...baseline.holdings,
			looseHolding(HALLOWEEN_TOT_BAG_ITEM_ID, SACKS_GAINED, { source: 'bank', slot: 1 }),
			looseHolding(BLOOD_ITEM_ID, BLOOD_GAINED, { source: 'materials', category: 5 }),
		],
	});
	const delta = compareStorageSnapshots(baseline, final);
	const reviewedAt = '2026-08-13T09:10:05.000Z';
	const review = createSessionContaminationReview(baseline, final, delta, {
		certainty: 'confirmed',
		activities: {
			open: false, salvage: false, consume: false, craft: false, tpBuy: false,
			tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
		},
	}, reviewedAt);
	if (delta.status === 'invalid' || review === null || review.classification.status !== 'exact') {
		throw new Error('The valued-session fixture must classify as exact.');
	}
	const record = createSessionRuntimeRecord(
		completeState(baseline, final, review.classification.status, reviewedAt),
		baseline, final, delta, Date.parse(reviewedAt), review,
		await priceSnapshot(delta),
	);
	if (record === null) throw new Error('The valued-session fixture is invalid.');
	return record;
}

async function priceSnapshot(delta: StorageDelta): Promise<SessionPriceSnapshot> {
	const captured = await new SessionPriceSnapshotService(
		marketGateway(), () => Date.parse(FINAL_COMPLETED_AT),
	).capture('session-1', delta);
	if (captured.status !== 'complete') {
		throw new Error(`The price fixture must be complete, not ${captured.status}.`);
	}
	return captured;
}

function completeState(
	baseline: StorageSnapshot,
	final: StorageSnapshot,
	classification: CompleteSessionState['classification'],
	finalizedAt: string,
): CompleteSessionState {
	const reference = (snapshot: StorageSnapshot): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion, startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	return {
		version: 1, status: 'complete', sessionId: 'session-1',
		authority: {
			machineId: 'machine-1', instanceId: 'instance-1', sessionId: 'session-1',
			fence: 1, acquiredAt: Date.parse('2026-08-13T07:59:58.000Z'),
		},
		requestedAt: '2026-08-13T07:59:58.500Z',
		baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno',
			magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] }, { id: 52, traits: [4, 5, 6] }, { id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: STOPPED_AT,
		stoppedAt: STOPPED_AT,
		finalSnapshot: reference(final),
		finalizedAt,
		classification,
	};
}

async function persist(factory: IDBFactory, record: SessionRuntimeRecord): Promise<void> {
	const store = new IndexedDbSessionRuntimeStore(factory);
	const saved = await store.save(record);
	store.close();
	if (saved.status !== 'saved') throw new Error('The session fixture could not be persisted.');
}

function readFrontmatter(content: string): Record<string, unknown> {
	const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
	if (match === null) throw new Error('The written note has no frontmatter.');
	return parseDocument(match[1] ?? '').toJS() as Record<string, unknown>;
}

function itemIdsFromUrl(url: string): number[] | null {
	const path = url.split('/v2/')[1];
	return path !== undefined && path.startsWith('items?') ? idsFromQuery(path) : null;
}

function idsFromQuery(path: string): number[] | null {
	const ids = /[?&]ids=([0-9,]+)/u.exec(path)?.[1];
	return ids === undefined ? null : ids.split(',').map(Number);
}

function notePlugin(factory: IDBFactory, notes: Map<string, string>): NoteHarness {
	const files = (): TFile[] => [...notes.keys()].map((path) => Object.assign(new TFile(), { path }));
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => notes.get(file.path) ?? ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => {
			notes.set(path, content);
			return Object.assign(new TFile(), { path });
		}),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			return updated;
		}),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as NoteHarness & {
		app: App;
		manifest: PluginManifest;
		settings: typeof DEFAULT_SETTINGS;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		registerEvent(event: unknown): void;
	};
	target.app = app;
	target.manifest = manifest;
	target.settings = structuredClone(DEFAULT_SETTINGS);
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.registerEvent = vi.fn();

	vi.stubGlobal('window', {
		indexedDB: factory,
		setInterval: vi.fn(() => 1),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });
	return target;
}
