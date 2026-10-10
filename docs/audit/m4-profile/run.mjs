// Bundles measure.ts (with a source map, so the profile reports src/ lines) and runs it once per
// note format, one process each, strictly one after the other.
//   node docs/audit/m4-profile/run.mjs <outDir> [--name=realista] [--items=40 --drops=1 --change-permille=16 ...]
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const [outDir, ...extra] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node run.mjs <outDir> [measure options]");
mkdirSync(outDir, { recursive: true });
const bundle = resolve(outDir, "measure.mjs");
await build({
	entryPoints: [new URL("./measure.ts", import.meta.url).pathname],
	bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: "external", outfile: bundle, logLevel: "warning",
	banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
});
for (const variant of [1, 2]) {
	const run = spawnSync(process.execPath, [bundle, `--variant=${String(variant)}`, `--out=${resolve(outDir)}`, ...extra], { stdio: ["ignore", "inherit", "inherit"] });
	if (run.status !== 0) process.exit(run.status ?? 1);
}
