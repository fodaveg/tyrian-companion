/**
 * M4 profile: where the time of restoring a long live session (A) and of closing it and saving its
 * note (B) goes, for the journal as written today (note format 1: one entry per sample) and as the
 * sparse writer will write it (format 2: no entry for a sample that changed nothing).
 *
 * Node only, in-memory store, in-memory vault. It measures CPU of the plugin code, NOT real
 * IndexedDB, Obsidian's vault I/O, Hebra or the rest of `runtimeReady`. See README.md.
 *
 *   node measure.mjs --variant=1|2 [--samples=10800] [--change-permille=16] [--reps=7] [--prof-reps=5] [--out=DIR]
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { Session } from "node:inspector";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map-js";

import type { ActiveSessionLeaseHandle } from "../../../src/sessions/coordination-model";
import { LiveSessionLifecycle } from "../../../src/sessions/live-session-lifecycle";
import {
	NEXUS_LIVE_BUILD,
	NEXUS_LIVE_PROFILE,
	type LiveInventorySampleV1,
	type LiveJournalEntryV1,
} from "../../../src/sessions/live-session-model";
import type { LiveSessionPayloadVersion } from "../../../src/sessions/live-session-note-model";
import type { SessionLeaseCoordinator } from "../../../src/sessions/manual-session-start-service";
import { MemorySessionRuntimeStore } from "../../../src/sessions/session-runtime-store";
import {
	SessionNoteWriter,
	type SessionNoteFile,
	type SessionNoteVault,
} from "../../../src/sessions/session-note-writer";

const arg = (name: string, fallback: string): string =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const VARIANT = Number(arg("variant", "1")) as LiveSessionPayloadVersion;
const SAMPLES = Number(arg("samples", "10800")); // 3 h at one sample per second
const CHANGE_PERMILLE = Number(arg("change-permille", "16")); // real session: 75 of 4609 = 16.3 per mille
const REPS = Number(arg("reps", "7"));
const PROF_REPS = Number(arg("prof-reps", "5"));
const OUT = arg("out", ".");
/** Realistic default: 40 distinct items, one item changes per sample with change. The audit's heavy shape: --items=400 --drops=5 --change-permille=500. */
const DISTINCT_ITEMS = Number(arg("items", "40"));
const DROPS = Number(arg("drops", "1"));
const FIRST_ITEM = 12_000;
const START_MS = Date.parse("2026-10-09T09:00:00.000Z");
const INSTANCE = "AQEBAQEBAQEBAQEBAQEBAQ";
const EPOCH = "AgICAgICAgICAgICAgICAg";

let now = START_MS;
/** Shared by every lifecycle: a host that restarts gets a lease with a higher fence than the one the session was saved under. */
let fence = 0;

function makeLifecycle(
	store: MemorySessionRuntimeStore,
	onComplete: (record: never, journal: readonly LiveJournalEntryV1[]) => Promise<string | null>,
): LiveSessionLifecycle {
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({
		machineId: "machine", instanceId: "host", sessionId, fence: ++fence,
		acquiredAt: now, renewedAt: now, expiresAt: now + 120_000,
	});
	const coordinator: SessionLeaseCoordinator = {
		instanceId: "host",
		acquire: async (sessionId: string) => ({ status: "acquired" as const, handle: handle(sessionId) }),
		renew: async (prior: ActiveSessionLeaseHandle) => ({
			status: "renewed" as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 },
		}),
		assertOwned: async () => ({ status: "owned" as const }),
		release: async () => ({ status: "released" as const }),
		dispose: () => undefined,
	};
	return new LiveSessionLifecycle({
		coordinator, persistence: store, enabled: () => true, now: () => now,
		sessionId: () => "m4-session", thresholdCopper: () => 50_000,
		noteVersion: VARIANT,
		setInterval: () => 1, clearInterval: () => undefined,
		onStateChange: () => undefined,
		onError: (error) => { throw error instanceof Error ? error : new Error(String(error)); },
		onCommitted: () => undefined,
		onComplete: onComplete as never,
	});
}

class MapVault implements SessionNoteVault {
	readonly files = new Map<string, string>();
	file(path: string): SessionNoteFile | null { return this.files.has(path) ? { path } : null; }
	async read(file: SessionNoteFile): Promise<string> { return this.files.get(file.path)!; }
	async createFolder(): Promise<void> { return undefined; }
	async create(path: string, content: string): Promise<SessionNoteFile> { this.files.set(path, content); return { path }; }
	async process(file: SessionNoteFile, update: (c: string) => string): Promise<string> {
		const next = update(this.files.get(file.path)!); this.files.set(file.path, next); return next;
	}
}

/** Plays SAMPLES seconds of a session; ~CHANGE_PERMILLE of them loot or sell something. Returns the store left behind. */
async function buildStore(): Promise<{ store: MemorySessionRuntimeStore; changed: number; journalEntries: number }> {
	const store = new MemorySessionRuntimeStore();
	const lifecycle = makeLifecycle(store, async () => null);
	const source = {
		sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: "gameplay" as const, mapId: 866, character: "M4" },
	};
	const quantities = new Array<number>(DISTINCT_ITEMS).fill(50);
	let seed = 20_261_010;
	const random = (): number => { // mulberry32
		seed = (seed + 0x6d2b79f5) >>> 0; let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const sampleAt = (cursor: number): LiveInventorySampleV1 => ({
		...source, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000,
		mode: cursor === 0 ? "baseline" : "sample", itemCoverage: "complete", currencyCoverage: "none",
		unknownPositions: 0, freeSlots: null,
		rows: quantities.map((quantity, i) => ({ kind: "item" as const, idNumber: FIRST_ITEM + i, quantity })),
		observedAt: new Date(now).toISOString(),
	});
	if ((await lifecycle.start("M4")) === null) throw new Error("start");
	if ((await lifecycle.open(source)) !== "ready") throw new Error("open");
	await lifecycle.updatePrices(
		quantities.map((_, i) => ({ itemId: FIRST_ITEM + i, unitCopper: 100 + i * 37 })), new Date(now).toISOString());
	if ((await lifecycle.commit(sampleAt(0))) !== "stored") throw new Error("baseline");
	let changed = 0;
	for (let cursor = 1; cursor <= SAMPLES; cursor += 1) {
		now = START_MS + cursor * 1000;
		if (random() * 1000 < CHANGE_PERMILLE) {
			for (let drop = 0; drop < DROPS; drop += 1) {
				const i = Math.floor(random() * DISTINCT_ITEMS);
				quantities[i] = random() < 0.8 ? quantities[i]! + 1 + Math.floor(random() * 4) : Math.max(1, quantities[i]! - 2);
			}
			changed += 1;
		}
		if ((await lifecycle.commit(sampleAt(cursor))) !== "stored") throw new Error(`sample ${String(cursor)}`);
	}
	const journalEntries = lifecycle.getJournal().length;
	// The host that "dies": its lifecycle is simply left behind, as a closed Obsidian leaves it.
	return { store, changed, journalEntries };
}

const cloneStore = (store: MemorySessionRuntimeStore): MemorySessionRuntimeStore =>
	Object.setPrototypeOf(structuredClone(store), MemorySessionRuntimeStore.prototype) as MemorySessionRuntimeStore;

interface Prepared { lifecycle: LiveSessionLifecycle; vault: MapVault }
function prepare(base: MemorySessionRuntimeStore): Prepared {
	const vault = new MapVault();
	const writer = new SessionNoteWriter(vault);
	const lifecycle = makeLifecycle(cloneStore(base), async (record, journal) => {
		const result = await writer.writeLive({
			record, journal, locale: "es", outputFolder: "Tyrian", displayNames: undefined, payloadVersion: VARIANT,
		} as never);
		return result.status === "written" || result.status === "unchanged" ? result.path : null;
	});
	return { lifecycle, vault };
}

// ---------- profiler plumbing ----------
type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type ProfNode = { id: number; callFrame: CallFrame; children?: number[] };
type Profile = { nodes: ProfNode[]; samples: number[]; timeDeltas: number[] };
class Prof {
	private readonly session = new Session();
	private ready = false;
	private post<T>(method: string, params?: object): Promise<T> {
		return new Promise((resolve, reject) => this.session.post(method, params as never, (e, r) => (e ? reject(e) : resolve(r as T))));
	}
	async start(): Promise<void> {
		if (!this.ready) { this.session.connect(); await this.post("Profiler.enable"); await this.post("Profiler.setSamplingInterval", { interval: 100 }); this.ready = true; }
		await this.post("Profiler.start");
	}
	async stop(): Promise<Profile> { return (await this.post<{ profile: Profile }>("Profiler.stop")).profile; }
}

const here = fileURLToPath(import.meta.url);
const mapConsumer = (() => {
	try { return new SourceMapConsumer(JSON.parse(readFileSync(`${here}.map`, "utf8"))); } catch { return null; }
})();
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
function locate(frame: CallFrame): string {
	if (frame.url === "" ) return "(native)";
	if (frame.url.startsWith("node:")) return frame.url;
	if (frame.url.endsWith("measure.mjs") && mapConsumer) {
		const o = mapConsumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
		if (o.source) return `${o.source.replace(/^(\.\.\/)+/, "").replace(/^.*?(src\/|docs\/|node_modules\/)/, "$1")}:${String(o.line)}`;
	}
	return `${frame.url.replace("file://", "").replace(repoRoot, "")}:${String(frame.lineNumber + 1)}`;
}

interface Agg { name: string; where: string; selfUs: number; totalUs: number }
function aggregate(profiles: Profile[]): { rows: Map<string, Agg>; totalUs: number } {
	const rows = new Map<string, Agg>(); let totalUs = 0;
	for (const p of profiles) {
		const byId = new Map(p.nodes.map((n) => [n.id, n])); const parent = new Map<number, number>();
		for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
		const self = new Map<number, number>();
		p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i + 1] ?? p.timeDeltas[i]!)));
		for (const [id, us] of self) {
			const node = byId.get(id)!; const name = node.callFrame.functionName;
			if (name === "(idle)" || name === "(root)") continue;
			totalUs += us;
			const seen = new Set<string>();
			for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
				const f = byId.get(cur)!.callFrame; if (f.functionName === "(root)") break;
				const where = locate(f); const key = `${f.functionName}@${where}`;
				const row = rows.get(key) ?? { name: f.functionName || "(anonymous)", where, selfUs: 0, totalUs: 0 };
				if (cur === id) row.selfUs += us;
				if (!seen.has(key)) { row.totalUs += us; seen.add(key); }
				rows.set(key, row);
			}
		}
	}
	return { rows, totalUs };
}
function table(title: string, rows: Map<string, Agg>, totalUs: number, key: "selfUs" | "totalUs", skip: RegExp): string {
	const top = [...rows.values()].filter((r) => !skip.test(r.name)).sort((a, b) => b[key] - a[key]).slice(0, 10);
	const lines = [`${title} (porcentaje del tiempo muestreado)`, "| # | función | fichero:línea | propio | acumulado |", "|--:|---|---|--:|--:|"];
	top.forEach((r, i) => lines.push(`| ${String(i + 1)} | \`${r.name}\` | ${r.where} | ${(100 * r.selfUs / totalUs).toFixed(1)} % | ${(100 * r.totalUs / totalUs).toFixed(1)} % |`));
	return lines.join("\n");
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const fmt = (xs: number[]): string => `mediana ${median(xs).toFixed(0)} ms (mín ${Math.min(...xs).toFixed(0)}, máx ${Math.max(...xs).toFixed(0)}, n=${String(xs.length)}); 1.ª repetición ${xs[0]!.toFixed(0)} ms`;

async function main(): Promise<void> {
	mkdirSync(OUT, { recursive: true });
	const built = await buildStore();
	const base = built.store;
	const sizeBytes = JSON.stringify([...(base as never as { liveJournal: Map<string, unknown> }).liveJournal.values()]).length;
	const out: string[] = [];
	out.push(`## Formato ${String(VARIANT)}: ${String(SAMPLES)} muestras (${(SAMPLES / 3600).toFixed(1)} h), ${String(built.changed)} con cambio (${(built.changed * 100 / SAMPLES).toFixed(2)} %), ${String(built.journalEntries)} entradas en el diario (${(sizeBytes / 1048576).toFixed(1)} MiB de JSON), Node ${process.version}, carga de la máquina al empezar ${readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ")}`);

	const timeA: number[] = []; const timeB: number[] = []; let noteBytes = 0;
	const profA: Profile[] = []; const profB: Profile[] = []; const prof = new Prof();
	for (let rep = 0; rep < REPS + PROF_REPS; rep += 1) {
		const profiled = rep >= REPS;
		const { lifecycle, vault } = prepare(base);
		now = START_MS + (SAMPLES + 30) * 1000;
		if (profiled) await prof.start();
		let t0 = performance.now(); await lifecycle.initialize(); const a = performance.now() - t0;
		if (profiled) profA.push(await prof.stop());
		if (lifecycle.getRuntime()?.sampleCount !== SAMPLES + 1 || lifecycle.getRuntime()?.phase !== "active") throw new Error(`restore failed: ${JSON.stringify(lifecycle.getRuntime())}`);
		now += 1000;
		if (profiled) await prof.start();
		t0 = performance.now(); const closed = await lifecycle.stop(now); const b = performance.now() - t0;
		if (profiled) profB.push(await prof.stop());
		if (!closed || vault.files.size !== 1) throw new Error("close did not save one note");
		noteBytes = Buffer.byteLength([...vault.files.values()][0]!, "utf8");
		if (!profiled) { timeA.push(a); timeB.push(b); }
		await lifecycle.dispose();
	}
	out.push(`\nA. arrancar (LiveSessionLifecycle.initialize): ${fmt(timeA)}`);
	out.push(`B. cerrar y guardar la nota (stop + SessionNoteWriter.writeLive): ${fmt(timeB)}; nota de ${(noteBytes / 1048576).toFixed(2)} MiB`);
	for (const [label, profiles] of [["A", profA], ["B", profB]] as const) {
		const { rows, totalUs } = aggregate(profiles);
		out.push(`\n### Perfil ${label}, formato ${String(VARIANT)} (${String(profiles.length)} repeticiones perfiladas, ${(totalUs / 1000 / profiles.length).toFixed(0)} ms muestreados por repetición con el perfilador encendido)\n`);
		out.push(table("Top 10 por tiempo propio", rows, totalUs, "selfUs", /^$/));
		out.push("\n" + table("Top 10 por tiempo acumulado (sin la raíz del programa)", rows, totalUs, "totalUs", /^\((program|garbage collector)\)$/));
	}
	const text = out.join("\n") + "\n";
	writeFileSync(`${OUT}/${arg("name", "result")}-format${String(VARIANT)}.md`, text);
	process.stdout.write(text);
}
await main();
