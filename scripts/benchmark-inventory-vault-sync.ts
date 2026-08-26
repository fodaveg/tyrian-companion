import { performance } from "node:perf_hooks";

import { PINNED_SCHEMA, type StorageSnapshot } from "../src/account/storage-snapshot-model";
import {
	classifyInventoryAdvisor,
	sha256InventoryKnowledgePack,
} from "../src/advisor/inventory-advisor-classifier";
import type {
	InventoryAdvisorEngineInputV1,
	InventoryKnowledgePackV1,
} from "../src/advisor/inventory-advisor-classifier-model";
import { sha256InventoryRulePack } from "../src/advisor/inventory-advisor-contract";
import {
	InventoryAdvisorPresentationController,
	type InventoryAdvisorControllerPorts,
} from "../src/ui/inventory-advisor-controller";
import {
	InventoryVaultSyncService,
	type InventoryVaultFile,
	type InventoryVaultPort,
	type InventoryVaultSyncPlan,
	type InventoryVaultSyncStep,
} from "../src/inventory/inventory-vault-sync";

/**
 * H-perf: reproduces the real one-click inventory sync apply() path end to end
 * (pre-write conflict scan, write, post-write verification, and the onStep-driven
 * advisor re-render) against an in-memory vault, and buckets wall time by stage.
 *
 * Deliberately excludes real filesystem/network latency: the question this bench
 * answers is which stage's COST GROWS with N and by what shape, not the constant
 * factor a real disk or the Obsidian Sync adapter would add on top of every call.
 */

const ROOT = "Tyrian Companion";
const CONFIG_DIR = "vault-config";
const FOLDER = `${ROOT}/Inventory/Positions`;
const CAPTURED_AT = "2026-08-14T09:00:02.000Z";
// Matches the reported real run: 1616 created, 1167 updated.
const CREATE_RATIO = 1616 / (1616 + 1167);
const WARMUP_N = 20;

interface StageTimings {
	preVerifyReadMs: number;
	processMs: number;
	postVerifyReadMs: number;
	createWriteMs: number;
	renderOnStepMs: number;
	renderOnStepCalls: number;
	totalMs: number;
}

async function runOnce(n: number): Promise<{ n: number } & StageTimings> {
	const plan = buildPlan(n);
	const vault = new BenchInventoryVault();
	seedVault(vault, plan);
	const controller = buildAdvisorController(n);
	await controller.refresh(); // populate the cache once; excluded from onStep timing.

	let renderOnStepMs = 0;
	let renderOnStepCalls = 0;
	const onStep = (): void => {
		const startedAt = performance.now();
		// Mirrors `getInventoryAdvisorViewModel()` -> `this.inventoryAdvisor.open()`
		// on the live plugin: the exact call every onStep tick triggers via
		// `renderInventoryAdvisorViews()` -> `InventoryAdvisorItemView.render()`.
		controller.open();
		renderOnStepMs += performance.now() - startedAt;
		renderOnStepCalls += 1;
	};

	const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
	const startedAt = performance.now();
	const result = await service.apply(plan, onStep);
	const totalMs = performance.now() - startedAt;

	if (result.status !== "applied") {
		throw new Error(`Benchmark plan of size ${String(n)} did not apply cleanly: ${JSON.stringify(result)}`);
	}
	const expectedCreated = plan.steps.filter((step) => step.status === "create").length;
	const expectedUpdated = plan.steps.filter((step) => step.status === "update").length;
	if (result.created !== expectedCreated || result.updated !== expectedUpdated) {
		throw new Error(`Benchmark plan of size ${String(n)} applied an unexpected mix: ${JSON.stringify(result)}`);
	}

	return {
		n,
		preVerifyReadMs: vault.timings.preVerifyRead,
		processMs: vault.timings.process,
		postVerifyReadMs: vault.timings.postVerifyRead,
		createWriteMs: vault.timings.create,
		renderOnStepMs,
		renderOnStepCalls,
		totalMs,
	};
}

function buildPlan(n: number): InventoryVaultSyncPlan {
	const createCount = Math.round(n * CREATE_RATIO);
	const steps: InventoryVaultSyncStep[] = [];
	for (let index = 0; index < n; index += 1) {
		const isCreate = index < createCount;
		const path = `${FOLDER}/${isCreate ? "create" : "update"}-${String(index).padStart(5, "0")}.md`;
		if (isCreate) {
			steps.push({
				positionId: `${String(100_000 + index)}-s-account`,
				path, status: "create", before: null, after: noteContent(index, "new"),
			});
		} else {
			steps.push({
				positionId: `${String(100_000 + index)}-s-account`,
				path, status: "update", before: noteContent(index, "old"), after: noteContent(index, "new"),
			});
		}
	}
	return {
		schemaVersion: 1, root: ROOT, capturedAt: CAPTURED_AT, positions: n, canApply: true, steps,
	};
}

function seedVault(vault: BenchInventoryVault, plan: InventoryVaultSyncPlan): void {
	vault.folders.add(ROOT);
	vault.folders.add(`${ROOT}/Inventory`);
	vault.folders.add(FOLDER);
	for (const step of plan.steps) {
		if (step.status === "update" && step.before !== null) vault.contents.set(step.path, step.before);
	}
}

function noteContent(index: number, tag: string): string {
	// Representative size/shape of a real rendered inventory note: frontmatter,
	// marker line, and a short body. Not byte-identical to `renderInventoryNote`
	// (that helper is async and hashed; irrelevant to the timing question here).
	return `---\ntc_schema: 1\ntc_kind: gw2_inventory_position\ntc_position_id: pos-${String(index)}\n` +
		`tc_item_id: ${String(10_000 + index)}\ntc_quantity: ${String(10 + (index % 250))}\n` +
		`tc_item_name: Benchmark item ${String(index)}\ntag: ${tag}\n---\n` +
		`<!-- tyrian-companion-inventory schema=1 marker=tyrian_companion_inventory_position position=pos-${String(index)} hash=${"a".repeat(64)} -->\n` +
		`# Benchmark item ${String(index)}\n\nInventory holding managed by Tyrian Companion.\n`;
}

/** Instrumented in-memory vault. Buckets `read` by whether any write has landed
 * yet: `applyInternal` runs one full read-only conflict-check pass over every
 * step BEFORE any write, then a second pass that writes and re-reads to verify.
 * Those two passes never interleave, so the first write call is an unambiguous
 * boundary between "pre-write verify" and "post-write verify" reads. */
class BenchInventoryVault implements InventoryVaultPort {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly timings = { preVerifyRead: 0, postVerifyRead: 0, process: 0, create: 0 };
	private writesStarted = false;

	file(path: string): InventoryVaultFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	markdownFiles(): readonly InventoryVaultFile[] {
		return [...this.contents.keys()].filter((path) => path.endsWith(".md")).map((path) => ({ path }));
	}
	async read(file: InventoryVaultFile): Promise<string> {
		const startedAt = performance.now();
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error("not_file");
		const bucket = this.writesStarted ? "postVerifyRead" : "preVerifyRead";
		this.timings[bucket] += performance.now() - startedAt;
		return content;
	}
	async createFolder(path: string): Promise<void> {
		if (this.file(path)) throw new Error("exists");
		this.folders.add(path);
	}
	async create(path: string, content: string): Promise<InventoryVaultFile> {
		const startedAt = performance.now();
		this.writesStarted = true;
		if (this.file(path)) throw new Error("exists");
		this.contents.set(path, content);
		this.timings.create += performance.now() - startedAt;
		return { path };
	}
	async process(file: InventoryVaultFile, update: (content: string) => string): Promise<string> {
		const startedAt = performance.now();
		this.writesStarted = true;
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error("not_file");
		const next = update(current);
		if (next !== current) this.contents.set(file.path, next);
		this.timings.process += performance.now() - startedAt;
		return next;
	}
}

function buildAdvisorController(n: number): InventoryAdvisorPresentationController {
	const engineInput = advisorFixture(n);
	const result = classifyInventoryAdvisor(engineInput);
	const ports: InventoryAdvisorControllerPorts = {
		load: async () => ({ status: "ready", source: { input: engineInput.input, result } }),
	};
	return new InventoryAdvisorPresentationController(ports);
}

/** Same shape as the H5.11 presentation fixtures, scaled to N distinct items so the
 * cached advisor source (what `InventoryAdvisorPresentationController.current()`
 * clones on every read) is realistically sized for an inventory of N positions. */
function advisorFixture(n: number): InventoryAdvisorEngineInputV1 {
	const snapshot: StorageSnapshot = {
		snapshotId: "snapshot-1", accountId: "account-1",
		startedAt: "2026-08-14T11:59:00.000Z", completedAt: "2026-08-14T11:59:01.000Z",
		schemaVersion: PINNED_SCHEMA, quality: "stable", passes: 2,
		holdings: [], availableByItem: {}, ownedByItem: {}, currencies: [], currencyById: {},
		roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: "rules", version: 1,
		publishedAt: "2026-08-01T00:00:00.000Z", reviewedAt: "2026-08-02T00:00:00.000Z",
		validUntil: "2027-01-01T00:00:00.000Z", sha256: "", sources: [], rules: [],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: "knowledge", version: 1,
		publishedAt: "2026-08-01T00:00:00.000Z", reviewedAt: "2026-08-02T00:00:00.000Z",
		validUntil: "2027-01-01T00:00:00.000Z", sha256: "",
		sources: [{ id: "source", url: "https://wiki.guildwars2.com", retrievedAt: "2026-08-02T00:00:00.000Z" }],
		entries: [],
	};
	const catalogItems: Record<string, unknown> = {};
	const catalogCoverage: Record<string, unknown> = {};
	const priceItems: { itemId: number; whitelisted: true; bid: null; ask: null }[] = [];
	const requestedItemIds: number[] = [];
	for (let index = 0; index < n; index += 1) {
		const itemId = 10_000 + index;
		const key = String(itemId);
		snapshot.holdings.push({
			kind: "item", itemId, quantity: 10 + (index % 250), state: "loose",
			location: { source: "bank", slot: index }, metadata: {},
		});
		snapshot.ownedByItem[key] = 10 + (index % 250);
		snapshot.availableByItem[key] = 10 + (index % 250);
		catalogItems[key] = {
			kind: "item", id: itemId, name: `Benchmark item ${key}`, type: "Trophy", rarity: "Basic",
			level: 0, vendorValue: 5, flags: [], gameTypes: [], restrictions: [],
		};
		catalogCoverage[key] = { status: "resolved", source: "network" };
		requestedItemIds.push(itemId);
		priceItems.push({ itemId, whitelisted: true, bid: null, ask: null });
		knowledge.entries.push({
			itemId,
			use: { status: "not_applicable", assertionId: `use-none-${key}`, sourceIds: ["source"] },
			open: { status: "not_applicable", assertionId: `open-none-${key}`, sourceIds: ["source"] },
			salvage: { status: "not_applicable", assertionId: `salvage-none-${key}`, sourceIds: ["source"] },
		});
	}
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return {
		input: {
			version: 1, asOf: "2026-08-14T12:00:00.000Z", snapshot,
			catalog: {
				snapshotId: "snapshot-1", locale: "es", schemaVersion: PINNED_SCHEMA,
				resolvedAt: "2026-08-14T12:00:00.000Z", items: catalogItems, currencies: {}, materials: {},
				warnings: [], coverage: { items: catalogCoverage, currencies: {}, materials: {} },
			},
			prices: {
				version: 1, accountId: "account-1", snapshotId: "snapshot-1",
				capturedAt: "2026-08-14T12:00:00.000Z", source: "gw2-commerce-prices", schemaVersion: PINNED_SCHEMA,
				requestedItemIds, status: "complete", items: priceItems, missingItemIds: [],
			},
			goals: [], keepExceptions: [],
			accountSignals: {
				version: 1, source: "gw2-account-api", accountId: "account-1",
				capturedAt: "2026-08-14T12:00:00.000Z", schemaVersion: PINNED_SCHEMA, tradingPostAccess: "full",
				endpointCoverage: {
					account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence(),
				},
				unlockCoverage: "complete", unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
				achievementCoverage: "complete", completedAchievementBits: {}, achievementProgress: [],
			},
			rulePack,
			policy: {
				version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
				maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
				listingMinimumAdvantageBps: 1_000,
			},
		},
		knowledgePack: knowledge,
	} as InventoryAdvisorEngineInputV1;
}

function coverage() {
	const complete = { status: "complete" as const };
	return {
		sources: {
			characters: complete, shared_inventory: complete, bank: complete,
			materials: complete, wallet: complete, commerce_delivery: complete,
		},
		characters: {},
	};
}
function evidence() {
	return { status: "complete" as const, capturedAt: "2026-08-14T12:00:00.000Z", reason: null };
}

function readSizes(): number[] {
	const raw = process.argv.find((argument) => argument.startsWith("--sizes="));
	if (raw === undefined) return [100, 400, 1600];
	return raw
		.slice("--sizes=".length)
		.split(",")
		.map((entry) => Number(entry.trim()))
		.filter((value) => Number.isFinite(value) && value > 0);
}

function printTable(rows: ({ n: number } & StageTimings)[]): void {
	process.stdout.write("\nStage time (ms), summed across the whole apply() call:\n\n");
	const header = ["N", "preVerifyRead", "process", "postVerifyRead", "createWrite", "renderOnStep", "total"];
	process.stdout.write(`${header.join("\t")}\n`);
	for (const row of rows) {
		process.stdout.write([
			row.n,
			row.preVerifyReadMs.toFixed(1),
			row.processMs.toFixed(1),
			row.postVerifyReadMs.toFixed(1),
			row.createWriteMs.toFixed(1),
			`${row.renderOnStepMs.toFixed(1)} (${String(row.renderOnStepCalls)} calls)`,
			row.totalMs.toFixed(1),
		].join("\t") + "\n");
	}
}

function printScaling(rows: ({ n: number } & StageTimings)[]): void {
	process.stdout.write("\nScaling vs previous N (ratio of time / ratio of N; 1x = linear, (N-ratio)x = quadratic):\n\n");
	for (let index = 1; index < rows.length; index += 1) {
		const previous = rows[index - 1]!;
		const current = rows[index]!;
		const nRatio = current.n / previous.n;
		const stageRatio = (key: keyof StageTimings): string => {
			const before = previous[key];
			const after = current[key];
			if (before <= 0.05) return "n/a (negligible baseline)";
			return `${(after / before).toFixed(2)}x`;
		};
		process.stdout.write(
			`N ${String(previous.n)} -> ${String(current.n)} (N x${nRatio.toFixed(2)}): ` +
			`preVerifyRead ${stageRatio("preVerifyReadMs")}, ` +
			`process ${stageRatio("processMs")}, ` +
			`postVerifyRead ${stageRatio("postVerifyReadMs")}, ` +
			`createWrite ${stageRatio("createWriteMs")}, ` +
			`renderOnStep ${stageRatio("renderOnStepMs")}\n`,
		);
	}
}

const sizes = readSizes();

// One JIT warmup pass, excluded from every reported number.
await runOnce(WARMUP_N);

const results: ({ n: number } & StageTimings)[] = [];
for (const n of sizes) {
	results.push(await runOnce(n));
}

printTable(results);
printScaling(results);
process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
