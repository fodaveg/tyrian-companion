import { performance } from "node:perf_hooks";

import {
	assertH6LiveSessionBudget,
	H6_LIVE_SESSION_BUDGET,
	H6_LIVE_SESSION_LOOT_PER_LOOTED_SAMPLE,
	H6_LIVE_SESSION_SAMPLES_LONG,
	H6_LIVE_SESSION_SAMPLES_ONE_HOUR,
	H6_LIVE_SESSION_WINDOW_SAMPLES,
	summarizeH6LiveSessionWindow,
	type H6LiveSessionBudget,
	type H6LiveSessionMetrics,
} from "../src/performance/h6-live-session-contract";
import { RateLimitCoordinator } from "../src/core/rate-limit-coordinator";
import type { ActiveSessionLeaseHandle } from "../src/sessions/coordination-model";
import { LiveSessionEconomy } from "../src/sessions/live-session-economy";
import { LiveSessionLifecycle } from "../src/sessions/live-session-lifecycle";
import {
	LIVE_SESSION_NOTE_WRITE_VERSION,
	type LiveSessionPayloadVersion,
} from "../src/sessions/live-session-note-model";
import {
	inspectLiveSessionNote,
	renderLiveSessionNote,
} from "../src/sessions/live-session-note-renderer";
import {
	NEXUS_LIVE_BUILD,
	NEXUS_LIVE_PROFILE,
	type LiveInventorySampleV1,
	type LiveJournalEntryV1,
} from "../src/sessions/live-session-model";
import type { SessionLeaseCoordinator } from "../src/sessions/manual-session-start-service";
import { MemorySessionRuntimeStore } from "../src/sessions/session-runtime-store";

/**
 * "Long live session": the code that runs every second of a real Nexus session, over an in-memory
 * store, a price API without latency and deterministic data. One session of ninety minutes at one
 * sample per second; half the samples loot five of 400 distinct items. The first window, the
 * one-hour window and the last window are timed on the same per-sample path (commit, price
 * enrichment, chart), then the session is closed, its note rendered and read back.
 */
const DISTINCT_ITEMS = 400;
const FIRST_ITEM_ID = 12_000;
const SEED = 20_261_008;
const START_MS = Date.parse("2026-10-08T09:00:00.000Z");
const INSTANCE = "AQEBAQEBAQEBAQEBAQEBAQ";
const EPOCH = "AgICAgICAgICAgICAgICAg";
const MEBIBYTE = 1024 * 1024;
/** Cold-JIT samples that belong to neither window, so the early window is not penalised for warming up. */
const WARMUP_SAMPLES = 100;
/** The early window closes while the journal is still shorter than the 600-point chart cap. */
const START_WINDOW_END = 400;

const budget = readBudget();
const sabotageJournalClone = process.argv.includes("--sabotage-journal-clone");
const sabotageSink: number[] = [];
const SABOTAGE_JOURNAL_COPIES = 3;
const sampleCount = readLimit("--samples", H6_LIVE_SESSION_SAMPLES_LONG);
/** `--note-version=1|2` measures the other note format; absent, the one this build writes. */
const noteVersion = readNoteVersion();

await main();

async function main(): Promise<void> {
	let now = START_MS;
	let leaseFence = 0;
	let sessionOrdinal = 0;
	let committed: LiveJournalEntryV1 | null = null;
	let noteBytes = 0;
	let noteReadable = false;
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({
		machineId: "machine",
		instanceId: "host",
		sessionId,
		fence: ++leaseFence,
		acquiredAt: now,
		renewedAt: now,
		expiresAt: now + 120_000,
	});
	const coordinator: SessionLeaseCoordinator = {
		instanceId: "host",
		acquire: async (sessionId: string) => ({
			status: "acquired" as const,
			handle: handle(sessionId),
		}),
		renew: async (prior: ActiveSessionLeaseHandle) => ({
			status: "renewed" as const,
			handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 },
		}),
		assertOwned: async () => ({ status: "owned" as const }),
		release: async () => ({ status: "released" as const }),
		dispose: () => undefined,
	};
	const errors: unknown[] = [];
	const lifecycle: LiveSessionLifecycle = new LiveSessionLifecycle({
		coordinator,
		persistence: new MemorySessionRuntimeStore(),
		enabled: () => true,
		now: () => now,
		sessionId: () => (++sessionOrdinal === 1 ? "bench-session" : `bench-${sessionOrdinal}`),
		thresholdCopper: () => 50_000,
		setInterval: () => 1,
		clearInterval: () => undefined,
		onStateChange: () => undefined,
		onError: (error) => errors.push(error),
		noteVersion,
		onCommitted: (entry) => {
			committed = entry;
		},
		onComplete: async (record, journal) => {
			const rendered = await renderLiveSessionNote({
				record,
				journal,
				locale: "es",
				outputFolder: "Tyrian",
				payloadVersion: noteVersion,
			});
			if (rendered.status !== "ok") return null;
			const content = rendered.note.content;
			noteBytes = Buffer.byteLength(content, "utf8");
			// A RangeError here (the pre-fix 8 MiB line) must fail the case, not be swallowed by the lifecycle.
			noteReadable = (await inspectLiveSessionNote(content)).status === "ok";
			return "Sessions/bench-live.md";
		},
	});
	const economy = new LiveSessionEconomy({
		lifecycle,
		gateway: {
			requestDetailed: async (path: string) => ({
				status: 200,
				headers: {},
				body: pricesFor(path),
			}),
		},
		rateLimit: new RateLimitCoordinator({ now: () => now }),
		now: () => now,
		catalog: async () => ({}),
		cachedItems: async () => ({}),
		currencies: async () => ({ currencies: {}, coverage: {} }),
		cachedCurrencies: async () => ({}),
		emit: async () => ({ delivered: [], failed: [], rejected: false }),
		onError: (error) => errors.push(error),
		onChange: () => undefined,
	});

	const source = {
		sourceInstance: INSTANCE,
		epoch: EPOCH,
		build: NEXUS_LIVE_BUILD,
		profile: NEXUS_LIVE_PROFILE,
		context: { state: "gameplay" as const, mapId: 866, character: "Bench" },
	};
	const random = mulberry32(SEED);
	const quantities = new Array<number>(DISTINCT_ITEMS).fill(1);
	const sampleAt = (cursor: number): LiveInventorySampleV1 => ({
		...source,
		cursor,
		contextSeq: 0,
		sourceElapsedMs: cursor * 1000,
		mode: cursor === 0 ? "baseline" : "sample",
		itemCoverage: "complete",
		currencyCoverage: "none",
		unknownPositions: 0,
		freeSlots: null,
		rows: quantities.map((quantity, index) => ({
			kind: "item" as const,
			idNumber: FIRST_ITEM_ID + index,
			quantity,
		})),
		observedAt: new Date(now).toISOString(),
	});

	if ((await lifecycle.start("Bench")) === null)
		throw new Error("The benchmark session did not start.");
	if ((await lifecycle.open(source)) !== "ready")
		throw new Error("The benchmark source was not accepted.");
	if ((await lifecycle.commit(sampleAt(0))) !== "stored")
		throw new Error("The baseline sample was not stored.");

	const windows = {
		start: { from: WARMUP_SAMPLES + 1, to: START_WINDOW_END },
		oneHour: {
			from: H6_LIVE_SESSION_SAMPLES_ONE_HOUR - H6_LIVE_SESSION_WINDOW_SAMPLES + 1,
			to: H6_LIVE_SESSION_SAMPLES_ONE_HOUR,
		},
		end: { from: sampleCount - H6_LIVE_SESSION_WINDOW_SAMPLES + 1, to: sampleCount },
	};
	const durations = { start: [] as number[], oneHour: [] as number[], end: [] as number[] };
	const sessionStartedAt = performance.now();
	for (let cursor = 1; cursor <= sampleCount; cursor += 1) {
		now = START_MS + cursor * 1000;
		const loots = cursor % 2 === 1;
		if (loots) {
			for (let drop = 0; drop < H6_LIVE_SESSION_LOOT_PER_LOOTED_SAMPLE; drop += 1) {
				const index = Math.floor(random() * DISTINCT_ITEMS);
				quantities[index] = quantities[index]! + 1 + Math.floor(random() * 3);
			}
		}
		const sample = sampleAt(cursor);
		const startedAt = performance.now();
		committed = null;
		const result = await lifecycle.commit(sample);
		if (result !== "stored")
			throw new Error(`Sample ${String(cursor)} was ${result}, not stored.`);
		// Deliberate regression for the red: a full copy of the journal per sample, the shape the
		// audit found in `getAwaitingPriceEntries` (O(journal) work on every sample, so quadratic overall).
		if (sabotageJournalClone && cursor > windows.end.from && loots)
			for (let copy = 0; copy < SABOTAGE_JOURNAL_COPIES; copy += 1)
				sabotageSink.push(lifecycle.getJournal().length);
		if (committed !== null) economy.observe(committed);
		await economy.drain();
		const elapsed = performance.now() - startedAt;
		if (!loots) continue;
		for (const name of ["start", "oneHour", "end"] as const) {
			const window = windows[name];
			if (cursor >= window.from && cursor <= window.to)
				durations[name].push(elapsed);
		}
	}
	const sessionMs = performance.now() - sessionStartedAt;

	const journalEntries = lifecycle.getJournal().length;
	const closeStartedAt = performance.now();
	const closed = await lifecycle.stop(now);
	await economy.drain();
	const closeMs = performance.now() - closeStartedAt;
	if (!closed) throw new Error("The benchmark session did not close with a saved note.");
	if (errors.length > 0)
		throw new Error(`The benchmark session reported ${String(errors.length)} error(s): ${String(errors[0])}`);

	const start = summarizeH6LiveSessionWindow(durations.start);
	const oneHour = summarizeH6LiveSessionWindow(durations.oneHour);
	const end = summarizeH6LiveSessionWindow(durations.end);
	const metrics: H6LiveSessionMetrics = {
		start,
		oneHour,
		end,
		endToStartMedianRatio: end.medianMs / Math.max(start.medianMs, 0.001),
		closeMs,
		noteBytes,
		noteReadable,
	};
	process.stdout.write(
		JSON.stringify(
			{
				contract: {
					node: process.version,
					seed: SEED,
					samples: sampleCount,
					distinctItems: DISTINCT_ITEMS,
					lootedSamples: Math.ceil(sampleCount / 2),
					windowSamples: H6_LIVE_SESSION_WINDOW_SAMPLES,
					budget,
					sabotageJournalClone,
					noteVersion,
					outOfScope: [
						"real IndexedDB (an in-memory store is used)",
						"Electron / Obsidian host and the vault write",
						"Hebra WebKit",
						"painting and DOM",
					],
				},
				metrics,
				journalEntries,
				sessionMs,
			},
			null,
			2,
		) + "\n",
	);
	assertH6LiveSessionBudget(metrics, budget);
	await economy.dispose();
	await lifecycle.dispose();
}

function pricesFor(path: string): unknown[] {
	const ids = path
		.slice(path.indexOf("ids=") + 4)
		.split(",")
		.map(Number);
	return ids.map((id) => ({
		id,
		whitelisted: true,
		buys: { unit_price: 10 + (id % 97) * 3, quantity: 500 },
		sells: { unit_price: 14 + (id % 97) * 3, quantity: 500 },
	}));
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function readBudget(): H6LiveSessionBudget {
	return {
		maxEndMedianMs: readLimit("--max-end-median-ms", H6_LIVE_SESSION_BUDGET.maxEndMedianMs),
		maxEndP95Ms: readLimit("--max-end-p95-ms", H6_LIVE_SESSION_BUDGET.maxEndP95Ms),
		maxEndToStartMedianRatio: readLimit(
			"--max-end-to-start-ratio",
			H6_LIVE_SESSION_BUDGET.maxEndToStartMedianRatio,
		),
		maxCloseMs: readLimit("--max-close-ms", H6_LIVE_SESSION_BUDGET.maxCloseMs),
		maxNoteBytes:
			readLimit("--max-note-mib", H6_LIVE_SESSION_BUDGET.maxNoteBytes / MEBIBYTE) * MEBIBYTE,
	};
}

function readNoteVersion(): LiveSessionPayloadVersion {
	const value = process.argv.find((argument) => argument.startsWith("--note-version="));
	if (value === undefined) return LIVE_SESSION_NOTE_WRITE_VERSION;
	if (value !== "--note-version=1" && value !== "--note-version=2")
		throw new Error("--note-version must be 1 or 2.");
	return value === "--note-version=1" ? 1 : 2;
}

function readLimit(name: string, fallback: number): number {
	const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
	if (value === undefined) return fallback;
	const parsed = Number(value.slice(name.length + 1));
	if (!Number.isFinite(parsed) || parsed < 0)
		throw new Error(`${name} must be a non-negative finite number.`);
	return parsed;
}
