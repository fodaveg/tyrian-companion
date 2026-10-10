// Cuts the unprofiled A (or B) windows written by `measure.mjs --marks=1` out of a whole-process `node --cpu-prof` profile
// and prints the functions with the most self and total time inside them, with src/ lines through the bundle's source map.
//   node docs/audit/m4-profile/analyze-cpuprofile.mjs <profile.cpuprofile> <marks.json> <measure.mjs> [--label=A] [--top=15]
import { readFileSync } from "node:fs";
import { SourceMapConsumer } from "source-map-js";

const [profilePath, marksPath, bundlePath, ...rest] = process.argv.slice(2);
if (!profilePath || !marksPath || !bundlePath) throw new Error("usage: analyze-cpuprofile.mjs <cpuprofile> <marks.json> <measure.mjs> [--label=A] [--top=15]");
const opt = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const LABEL = opt("label", "A");
const TOP = Number(opt("top", "15"));

const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const windows = JSON.parse(readFileSync(marksPath, "utf8")).filter((m) => m.label === LABEL);
const map = new SourceMapConsumer(JSON.parse(readFileSync(`${bundlePath}.map`, "utf8")));

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const locate = (f) => {
	if (f.url === "") return "(native)";
	if (f.url.startsWith("node:")) return f.url;
	if (f.url.endsWith("measure.mjs")) {
		const o = map.originalPositionFor({ line: f.lineNumber + 1, column: f.columnNumber });
		if (o.source) return `${o.source.replace(/^(\.\.\/)+/, "").replace(/^.*?(src\/|docs\/|node_modules\/)/, "$1")}:${String(o.line)}`;
	}
	return `${f.url}:${String(f.lineNumber + 1)}`;
};

// A sample's time is the delta that FOLLOWS it (the interval it stood for), as Chrome DevTools counts it.
let t = profile.startTime;
const stamps = profile.timeDeltas.map((d) => (t += d));
const rows = new Map();
let windowUs = 0; let sampledUs = 0; let samples = 0;
for (const w of windows) windowUs += w.endUs - w.startUs;
for (let i = 0; i < profile.samples.length; i += 1) {
	const at = stamps[i];
	if (!windows.some((w) => at >= w.startUs && at < w.endUs)) continue;
	const us = (stamps[i + 1] ?? at) - at;
	const id = profile.samples[i];
	const leaf = byId.get(id).callFrame.functionName;
	if (leaf === "(idle)") continue;
	sampledUs += us; samples += 1;
	const seen = new Set();
	for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
		const f = byId.get(cur).callFrame;
		if (f.functionName === "(root)") break;
		const where = locate(f); const key = `${f.functionName}@${where}`;
		const row = rows.get(key) ?? { name: f.functionName || "(anonymous)", where, selfUs: 0, totalUs: 0 };
		if (cur === id) row.selfUs += us;
		if (!seen.has(key)) { row.totalUs += us; seen.add(key); }
		rows.set(key, row);
	}
}
const reps = windows.length;
const ms = (us) => (us / 1000 / reps).toFixed(1);
const pct = (us) => (100 * us / sampledUs).toFixed(1);
console.log(`Ventanas ${LABEL}: ${String(reps)}; ${ms(windowUs)} ms de reloj por repetición; ${ms(sampledUs)} ms muestreados por repetición (${String(samples)} muestras en total)`);
for (const [title, key, skip] of [
	["Tiempo propio", "selfUs", /^$/],
	["Tiempo acumulado", "totalUs", /^\((program|garbage collector)\)$/],
]) {
	console.log(`\n${title} (ms por repetición y porcentaje de lo muestreado)\n| # | función | fichero:línea | propio ms | propio % | acumulado ms | acumulado % |\n|--:|---|---|--:|--:|--:|--:|`);
	[...rows.values()].filter((r) => !skip.test(r.name)).sort((a, b) => b[key] - a[key]).slice(0, TOP)
		.forEach((r, i) => console.log(`| ${String(i + 1)} | \`${r.name}\` | ${r.where} | ${ms(r.selfUs)} | ${pct(r.selfUs)} % | ${ms(r.totalUs)} | ${pct(r.totalUs)} % |`));
}
