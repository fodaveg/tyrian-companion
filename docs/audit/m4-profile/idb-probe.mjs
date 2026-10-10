// Loads a dumped live journal (`measure.mjs --dump-journal=1`) into a REAL IndexedDB engine (headless Chromium or WebKit
// through Playwright, on disk in a persistent profile) with the schema of the session runtime database, restarts the browser,
// and times reading it back the way `readLiveJournal` did up to 0.6.37 (index cursor + structuredClone per entry + sort) and
// the way it does since M4 (one `index.getAll` + sort). It does not run plugin code (no validation): it measures what the
// engine costs, nothing else.
//   node docs/audit/m4-profile/idb-probe.mjs <journal.json> <profile dir> --playwright=<dir of playwright-core>
//     [--engine=chromium|webkit] [--reps=5]
// Always headless.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [journalPath, profileDir, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const playwrightDir = opt("playwright", "");
if (!journalPath || !profileDir || !playwrightDir) throw new Error("usage: idb-probe.mjs <journal.json> <profile dir> --playwright=<playwright-core dir> [--engine=chromium] [--reps=5]");
const ENGINE = opt("engine", "chromium");
const REPS = Number(opt("reps", "5"));
const entries = JSON.parse(readFileSync(journalPath, "utf8"));
const { [ENGINE]: browserType } = await import(pathToFileURL(join(playwrightDir, "index.mjs")).href);
const userDataDir = join(profileDir, ENGINE);
mkdirSync(userDataDir, { recursive: true });

const ORIGIN = "http://m4.probe/";
async function withPage(run) {
	const context = await browserType.launchPersistentContext(userDataDir, { headless: true });
	try {
		const page = context.pages()[0] ?? await context.newPage();
		await page.route(`${ORIGIN}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>m4</title>" }));
		await page.goto(ORIGIN);
		return await run(page);
	} finally { await context.close(); }
}

const DB = "m4-probe";
// Same schema as SESSION_RUNTIME_SCHEMA: out-of-line keys [sessionId, epoch, cursor], index `session` on `sessionId`.
const written = await withPage(async (page) => await page.evaluate(async ({ entries, DB }) => {
	await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = resolve; r.onerror = () => reject(r.error); });
	const db = await new Promise((resolve, reject) => {
		const r = indexedDB.open(DB, 2);
		r.onupgradeneeded = () => {
			r.result.createObjectStore("active-session-v1");
			r.result.createObjectStore("live-inventory-journal-v1").createIndex("session", "sessionId");
		};
		r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
	});
	const tx = db.transaction("live-inventory-journal-v1", "readwrite", { durability: "strict" });
	for (const e of entries) tx.objectStore("live-inventory-journal-v1").add(e, [e.sessionId, e.epoch, e.cursor]);
	await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
	db.close();
	return entries.length;
}, { entries, DB }));

const sessionId = entries[0].sessionId;
const runs = [];
for (let rep = 0; rep < REPS; rep += 1) {
	// A new browser per repetition: nothing of the previous read is left in the engine's memory.
	runs.push(await withPage(async (page) => await page.evaluate(async ({ DB, sessionId }) => {
		const t0 = performance.now();
		const db = await new Promise((resolve, reject) => { const r = indexedDB.open(DB); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
		const t1 = performance.now();
		const cursorRead = await new Promise((resolve, reject) => {
			const tx = db.transaction("live-inventory-journal-v1", "readonly");
			const request = tx.objectStore("live-inventory-journal-v1").index("session").openCursor(sessionId);
			const result = [];
			request.onsuccess = () => { const c = request.result; if (!c) return; if (c.key === sessionId) result.push(structuredClone(c.value)); c.continue(); };
			tx.oncomplete = () => resolve(result.sort((l, r) => l.observedAt.localeCompare(r.observedAt) || l.epoch.localeCompare(r.epoch) || l.cursor - r.cursor));
			tx.onerror = tx.onabort = () => reject(tx.error);
		});
		const t2 = performance.now();
		const getAllRead = await new Promise((resolve, reject) => {
			const tx = db.transaction("live-inventory-journal-v1", "readonly");
			const request = tx.objectStore("live-inventory-journal-v1").index("session").getAll(sessionId);
			let result = [];
			request.onsuccess = () => { result = request.result; };
			tx.oncomplete = () => resolve(result.sort((l, r) => l.observedAt.localeCompare(r.observedAt) || l.epoch.localeCompare(r.epoch) || l.cursor - r.cursor));
			tx.onerror = tx.onabort = () => reject(tx.error);
		});
		const t3 = performance.now();
		db.close();
		return { openMs: t1 - t0, cursorMs: t2 - t1, getAllMs: t3 - t2, cursorCount: cursorRead.length, getAllCount: getAllRead.length };
	}, { DB, sessionId })));
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const line = (k) => `mediana ${median(runs.map((r) => r[k])).toFixed(1)} ms (${runs.map((r) => r[k].toFixed(1)).join(", ")})`;
console.log(`${ENGINE}: ${String(written)} entradas escritas; ${String(REPS)} lecturas, navegador nuevo en cada una`);
console.log(`  abrir la base: ${line("openMs")}`);
console.log(`  cursor del índice + structuredClone + orden (readLiveJournal hasta 0.6.37): ${line("cursorMs")}; leídas ${String(runs[0].cursorCount)}`);
console.log(`  index.getAll + orden (readLiveJournal desde M4): ${line("getAllMs")}; leídas ${String(runs[0].getAllCount)}`);
