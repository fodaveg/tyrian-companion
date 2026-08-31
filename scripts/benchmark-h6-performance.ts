import { performance } from "node:perf_hooks";
import { runInThisContext } from "node:vm";

import {
	assertH6PerformanceBudget,
	H6_MEASURED_RUNS,
	H6_PERFORMANCE_BUDGET,
	H6_WARMUP_RUNS,
	summarizeH6Performance,
	type H6PerformanceBudget,
} from "../src/performance/h6-performance-contract";
import {
	buildBoundaryEvidence,
	classifySessionDelta,
} from "../src/account/contamination";
import type { SessionClassificationContext } from "../src/account/contamination-model";
import { compareStorageSnapshots } from "../src/account/storage-delta";
import {
	PINNED_SCHEMA,
	type SnapshotCoverage,
	type StorageSnapshot,
	type StorageSnapshotPass,
} from "../src/account/storage-snapshot-model";
import {
	buildStorageSnapshotPass,
	finalizeStorageSnapshot,
	qualifyStorageSnapshotPair,
	qualifyStorageSnapshotTriple,
} from "../src/account/storage-snapshot-pure";
import {
	parseCharacterInventory,
	parseDelivery,
	parseMaterials,
	parseRoster,
	parseSlotArray,
	parseWallet,
} from "../src/account/storage-snapshot-parsers";
import type { CatalogItem } from "../src/catalog/public-catalog-model";
import {
	calculateSessionValuation,
	type SessionValuationInput,
} from "../src/economy/session-valuation";
import type { SessionPriceSnapshot } from "../src/economy/session-price-snapshot";

const CHARACTER_COUNT = 48;
const BAGS_PER_CHARACTER = 4;
const SLOTS_PER_BAG = 20;
const SHARED_ITEMS = 250;
const BANK_ITEMS = 500;
const MATERIAL_ITEMS = 250;
const DELIVERY_ITEMS = 100;
const GAINED_ITEM_COUNT =
	CHARACTER_COUNT * BAGS_PER_CHARACTER * SLOTS_PER_BAG +
	SHARED_ITEMS +
	BANK_ITEMS +
	MATERIAL_ITEMS;
const NORMALIZED_HOLDING_COUNT =
	GAINED_ITEM_COUNT + CHARACTER_COUNT * BAGS_PER_CHARACTER + DELIVERY_ITEMS;
const MEBIBYTE = 1024 * 1024;

interface LargeAccountPayload {
	roster: unknown;
	sharedInventory: unknown;
	bank: unknown;
	materials: unknown;
	wallet: unknown;
	delivery: unknown;
	characters: ReadonlyMap<string, unknown>;
}

const fixture = createFixture();
const forceGc = requireGc();
const budget = readBudget();
const retainedHeapSabotageBytes = readRetainedHeapSabotageBytes();

for (let run = 0; run < H6_WARMUP_RUNS; run += 1) runPipeline();

const durationsMs: number[] = [];
const cumulativeRetainedHeapBytes: number[] = [];
forceGc();
const retainedHeapBaseline = process.memoryUsage().heapUsed;
const retainedHeapSabotage = retainHeapForSabotage(retainedHeapSabotageBytes);
for (let run = 0; run < H6_MEASURED_RUNS; run += 1) {
	const startedAt = performance.now();
	runPipeline();
	durationsMs.push(performance.now() - startedAt);
	forceGc();
	cumulativeRetainedHeapBytes.push(
		Math.max(0, process.memoryUsage().heapUsed - retainedHeapBaseline),
	);
}

const retainedHeapSabotageChecksum =
	retainedHeapSabotage[retainedHeapSabotage.length - 1] ?? null;
const metrics = summarizeH6Performance(
	durationsMs,
	cumulativeRetainedHeapBytes,
);
assertH6PerformanceBudget(metrics, budget);
process.stdout.write(
	JSON.stringify(
		{
			contract: {
				node: process.version,
				warmupRuns: H6_WARMUP_RUNS,
				measuredRuns: H6_MEASURED_RUNS,
				fixture: {
					characters: CHARACTER_COUNT,
					normalizedHoldings: NORMALIZED_HOLDING_COUNT,
					gainedItems: GAINED_ITEM_COUNT,
					snapshotPasses: 3,
					stages: [
						"parsing_and_three_pass_snapshot_stabilization",
						"delta",
						"boundary_and_classification",
						"valuation",
					],
				},
				budget,
				heapMeasurement:
					"post-GC cumulative retained heap against one post-warmup baseline, not peak allocation",
				heapSabotage: {
					requestedBytes: retainedHeapSabotageBytes,
					checksum: retainedHeapSabotageChecksum,
				},
				budgetIntent:
					"cross-runner collapse detector, not a micro-regression threshold",
			},
			metrics,
			samples: { durationsMs, cumulativeRetainedHeapBytes },
		},
		null,
		2,
	) + "\n",
);

function runPipeline(): void {
	const before = normalizeSnapshot(
		fixture.before,
		fixture.beforeDivergentFirstPass,
		"before",
		"2026-08-14T08:00:00.000Z",
		"2026-08-14T08:00:01.000Z",
	);
	const after = normalizeSnapshot(
		fixture.after,
		fixture.afterDivergentFirstPass,
		"after",
		"2026-08-14T09:00:00.000Z",
		"2026-08-14T09:00:01.000Z",
	);
	if (
		before.holdings.length !== NORMALIZED_HOLDING_COUNT ||
		after.holdings.length !== NORMALIZED_HOLDING_COUNT ||
		before.passes !== 3 ||
		after.passes !== 3
	) {
		throw new Error(
			"Large-account fixture did not produce the documented normalized holding count.",
		);
	}
	const delta = compareStorageSnapshots(before, after);
	if (
		delta.status !== "comparable" ||
		delta.itemChanges.length !== GAINED_ITEM_COUNT
	) {
		throw new Error(
			"Large-account fixture did not produce the expected comparable item delta.",
		);
	}
	const boundary = buildBoundaryEvidence(before, after);
	const classification = classifySessionDelta(delta, cleanContext(boundary));
	if (classification.status !== "exact") {
		throw new Error(
			`Large-account fixture classification was ${classification.status}, not exact.`,
		);
	}
	const valuation = calculateSessionValuation(valuationInput(delta));
	if (
		valuation.status !== "ok" ||
		valuation.valuation.lines.length !== GAINED_ITEM_COUNT
	) {
		throw new Error(
			"Large-account fixture did not produce a complete valuation.",
		);
	}
}

function normalizeSnapshot(
	payload: LargeAccountPayload,
	divergentFirstPassPayload: LargeAccountPayload,
	snapshotId: string,
	startedAt: string,
	completedAt: string,
): StorageSnapshot {
	const first = normalizePass(divergentFirstPassPayload);
	const second = normalizePass(payload);
	const pair = qualifyStorageSnapshotPair(first, second);
	if (pair.status !== "needs_third_pass") {
		throw new Error(
			"Worst-case fixture did not require the expected third snapshot pass.",
		);
	}
	const third = normalizePass(payload);
	const qualification = qualifyStorageSnapshotTriple(first, second, third);
	if (qualification.quality !== "stable") {
		throw new Error(
			`Worst-case fixture third pass qualified as ${qualification.quality}.`,
		);
	}
	return finalizeStorageSnapshot(qualification, {
		accountId: "benchmark-account",
		snapshotId,
		startedAt,
		completedAt,
	});
}

function normalizePass(payload: LargeAccountPayload): StorageSnapshotPass {
	const roster = parseRoster(payload.roster);
	const holdings = [
		...parseSlotArray(payload.sharedInventory, "shared_inventory"),
		...parseSlotArray(payload.bank, "bank"),
		...parseMaterials(payload.materials),
		...roster.flatMap((character) =>
			parseCharacterInventory(
				payload.characters.get(character),
				character,
			),
		),
	];
	const delivery = parseDelivery(payload.delivery);
	holdings.push(...delivery.holdings);
	const currencies = [...parseWallet(payload.wallet), ...delivery.currencies];
	return buildStorageSnapshotPass(
		holdings,
		currencies,
		completeCoverage(roster),
		roster,
	);
}

function createFixture(): {
	before: LargeAccountPayload;
	after: LargeAccountPayload;
	beforeDivergentFirstPass: LargeAccountPayload;
	afterDivergentFirstPass: LargeAccountPayload;
} {
	let nextItemId = 100_000;
	const item = (quantity: number): Record<string, number> => ({
		id: nextItemId++,
		count: quantity,
	});
	const sharedInventory = Array.from({ length: SHARED_ITEMS }, () =>
		item(10),
	);
	const bank = Array.from({ length: BANK_ITEMS }, () => item(10));
	const materials = Array.from({ length: MATERIAL_ITEMS }, (_, index) => ({
		...item(10),
		category: (index % 50) + 1,
	}));
	const deliveryItems = Array.from({ length: DELIVERY_ITEMS }, () =>
		item(10),
	);
	const roster = Array.from(
		{ length: CHARACTER_COUNT },
		(_, index) => `Character ${String(index + 1).padStart(2, "0")}`,
	);
	const characters = new Map<string, unknown>();
	for (const character of roster) {
		characters.set(character, {
			bags: Array.from({ length: BAGS_PER_CHARACTER }, (_, bagIndex) => ({
				id: 900_000 + bagIndex,
				inventory: Array.from({ length: SLOTS_PER_BAG }, () =>
					item(10),
				),
			})),
		});
	}
	const before: LargeAccountPayload = {
		roster,
		sharedInventory,
		bank,
		materials,
		wallet: [
			{ id: 1, value: 100_000 },
			{ id: 2, value: 50 },
		],
		delivery: { items: deliveryItems, coins: 500 },
		characters,
	};
	const after = increaseEveryRootQuantity(before);
	return {
		before,
		after,
		beforeDivergentFirstPass: increaseFirstSharedQuantity(before),
		afterDivergentFirstPass: increaseFirstSharedQuantity(after),
	};
}

function increaseFirstSharedQuantity(
	payload: LargeAccountPayload,
): LargeAccountPayload {
	if (!Array.isArray(payload.sharedInventory)) {
		throw new Error("Large-account shared inventory fixture must be an array.");
	}
	const sharedInventory = payload.sharedInventory as unknown[];
	const first = sharedInventory[0];
	if (!isRecord(first) || typeof first.count !== "number") {
		throw new Error("Large-account shared inventory fixture needs a first stack.");
	}
	return {
		...payload,
		sharedInventory: [
			{ ...first, count: first.count + 1 },
			...sharedInventory.slice(1),
		],
	};
}

function increaseEveryRootQuantity(
	payload: LargeAccountPayload,
): LargeAccountPayload {
	const increase = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(increase);
		if (isRecord(value)) {
			if (typeof value.count === "number")
				return { ...value, count: value.count + 1 };
			return Object.fromEntries(
				Object.entries(value).map(([key, child]) => [
					key,
					increase(child),
				]),
			);
		}
		return value;
	};
	return {
		roster: increase(payload.roster),
		sharedInventory: increase(payload.sharedInventory),
		bank: increase(payload.bank),
		materials: increase(payload.materials),
		wallet: increase(payload.wallet),
		// Delivery remains unchanged so the explicit clean declaration is consistent with H2.7.
		delivery: payload.delivery,
		characters: new Map(
			[...payload.characters].map(([name, value]) => [
				name,
				increase(value),
			]),
		),
	};
}

function completeCoverage(roster: string[]): SnapshotCoverage {
	const complete = { status: "complete" as const };
	return {
		sources: {
			characters: complete,
			shared_inventory: complete,
			bank: complete,
			materials: complete,
			wallet: complete,
			commerce_delivery: complete,
		},
		characters: Object.fromEntries(
			roster.map((character) => [character, complete]),
		),
	};
}

function cleanContext(
	boundary: ReturnType<typeof buildBoundaryEvidence>,
): SessionClassificationContext {
	return {
		boundary,
		tradingPost: { status: "complete", events: [] },
		declaration: { status: "confirmed_clean" },
		boundaryCertainty: "manual_confirmed",
	};
}

function valuationInput(
	delta: ReturnType<typeof compareStorageSnapshots>,
): SessionValuationInput {
	const catalogItems: Record<string, CatalogItem> = {};
	const bindingByItem: SessionValuationInput["bindingByItem"] = {};
	const prices: SessionPriceSnapshot["items"] = [];
	for (const change of delta.itemChanges) {
		if (change.delta <= 0) continue;
		catalogItems[String(change.id)] = {
			kind: "item",
			id: change.id,
			name: `Benchmark item ${change.id}`,
			type: "Consumable",
			rarity: "Basic",
			level: 0,
			vendorValue: 5,
			flags: [],
			gameTypes: [],
			restrictions: [],
		};
		bindingByItem[String(change.id)] = "unbound";
		prices.push({
			itemId: change.id,
			quantityGained: change.delta,
			whitelisted: true,
			bid: { quantity: 1_000, unitCopper: 20 },
			ask: { quantity: 1_000, unitCopper: 30 },
		});
	}
	return {
		sessionId: "benchmark-session",
		delta,
		prices: {
			version: 1,
			sessionId: "benchmark-session",
			capturedAt: "2026-08-14T09:00:02.000Z",
			source: "gw2-commerce-prices",
			schemaVersion: PINNED_SCHEMA,
			status: "complete",
			items: prices,
			missingItemIds: [],
			marketDepth: {
				version: 1,
				capturedAt: "2026-08-14T09:00:02.000Z",
				source: "gw2-commerce-listings",
				requestedItemIds: prices.map((price) => price.itemId),
				status: "complete",
				items: prices.map((price) => ({
					itemId: price.itemId,
					coverage: "complete",
					buys: [{ unitCopper: 20, quantity: 1_000 }],
					sells: [{ unitCopper: 30, quantity: 1_000 }],
				})),
			},
		},
		catalogItems,
		bindingByItem,
		sackItemIds: [100_000],
	};
}

function readBudget(): H6PerformanceBudget {
	return {
		maxMedianMs: readLimit(
			"--max-median-ms",
			H6_PERFORMANCE_BUDGET.maxMedianMs,
		),
		maxP95Ms: readLimit("--max-p95-ms", H6_PERFORMANCE_BUDGET.maxP95Ms),
		maxCumulativeRetainedHeapBytes:
			readLimit(
				"--max-cumulative-retained-heap-mib",
				H6_PERFORMANCE_BUDGET.maxCumulativeRetainedHeapBytes /
					MEBIBYTE,
			) * MEBIBYTE,
	};
}

function readRetainedHeapSabotageBytes(): number {
	return readLimit("--sabotage-retained-heap-mib", 0) * MEBIBYTE;
}

function retainHeapForSabotage(bytes: number): number[] {
	const wordCount = Math.ceil(bytes / 8);
	return Array.from({ length: wordCount }, (_value, index) => index);
}

function readLimit(name: string, fallback: number): number {
	const value = process.argv.find((argument) =>
		argument.startsWith(`${name}=`),
	);
	if (value === undefined) return fallback;
	const parsed = Number(value.slice(name.length + 1));
	if (!Number.isFinite(parsed) || parsed < 0)
		throw new Error(`${name} must be a non-negative finite number.`);
	return parsed;
}

function requireGc(): () => void {
	const gc = runInThisContext("gc") as unknown;
	if (typeof gc !== "function")
		throw new Error("Run this benchmark through Node with --expose-gc.");
	const collect = gc as () => void;
	return () => {
		collect();
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
