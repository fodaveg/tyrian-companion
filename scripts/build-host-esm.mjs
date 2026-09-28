// R1a (SPEC-TYRIAN-EN-HEBRA.md section 1): bundles the host-neutral entry `src/runtime/index.ts`
// the way Hebra's webview will load it (ESM, browser platform, everything bundled) into the
// git-ignored `.host-esm/`, and FAILS when the bundle would need anything a webview without Node
// or Electron does not have:
//
// - an import of `obsidian`, `electron`, `net` or any Node builtin (bare or `node:`-prefixed);
// - a free reference to the `Buffer` or `process` globals (a member such as `vault.process` or a
//   local binding of that name is not one: esbuild's `define` only rewrites global references,
//   so each one is replaced by a marker this script then looks for);
// - a CSS import, or a package that is not declared in package.json.
//
// Run: `npm run build:host-esm` (exit 0 and a one-line summary when clean; exit 1 listing every
// violation otherwise). `--entry=<file>` and `--no-write` exist for `scripts/tests/probar-build-host-esm.mjs`.

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_ESM_ENTRY = 'src/runtime/index.ts';
export const HOST_ESM_OUTFILE = '.host-esm/tyrian-runtime.js';

const FORBIDDEN_PACKAGES = new Set(['obsidian', 'electron', 'net']);
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const FORBIDDEN_GLOBALS = ['Buffer', 'process'];
const GLOBAL_MARKER = '__TYRIAN_HOST_ESM_FORBIDDEN_GLOBAL_';

/** True for `obsidian`, `electron`, `net` and every Node builtin, with or without `node:` and subpaths. */
export function isForbiddenSpecifier(specifier) {
	if (specifier.startsWith('node:')) return true;
	const root = specifier.split('/')[0];
	return FORBIDDEN_PACKAGES.has(root) || NODE_BUILTINS.has(root);
}

/**
 * Builds `entry` and returns every violation found; never throws for a violation, only for a
 * build that esbuild itself could not complete (an unresolvable import, a syntax error).
 */
export async function buildHostEsm({ root = REPOSITORY_ROOT, entry = HOST_ESM_ENTRY, outfile = HOST_ESM_OUTFILE, write = true } = {}) {
	const forbiddenImports = [];
	const result = await esbuild.build({
		absWorkingDir: root,
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2021',
		write,
		metafile: true,
		logLevel: 'silent',
		define: Object.fromEntries(FORBIDDEN_GLOBALS.map((name) => [name, `${GLOBAL_MARKER}${name}`])),
		plugins: [{
			name: 'tyrian-host-esm-forbidden-imports',
			setup(build) {
				// esbuild runs the filter as a Go regular expression, which rejects the `u` flag.
				build.onResolve({ filter: /.*/ }, (args) => {
					if (args.kind === 'entry-point' || !isForbiddenSpecifier(args.path)) return undefined;
					forbiddenImports.push({ specifier: args.path, importer: relative(root, args.importer) });
					return { path: args.path, external: true };
				});
			},
		}],
	});

	const violations = forbiddenImports.map(({ specifier, importer }) => `import '${specifier}' from ${importer}`);
	const text = result.outputFiles?.[0]?.text ?? readFileSync(resolve(root, outfile), 'utf8');
	for (const name of FORBIDDEN_GLOBALS) {
		const count = text.split(`${GLOBAL_MARKER}${name}`).length - 1;
		if (count > 0) violations.push(`global ${name} referenced ${String(count)} time(s)`);
	}
	const inputs = Object.keys(result.metafile.inputs);
	for (const input of inputs.filter((path) => path.endsWith('.css'))) violations.push(`CSS import ${input}`);
	const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const declared = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
	const packages = [...new Set(inputs.flatMap((path) => packageOf(path) ?? []))].sort();
	for (const name of packages.filter((name) => !declared.has(name))) violations.push(`package ${name} is not declared in package.json`);
	const bytes = text.length;
	return { violations, inputs: inputs.length, packages, bytes, outfile };
}

/** The npm package a bundled input file belongs to, or null for a repository source file. */
function packageOf(path) {
	const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(path);
	return match?.[1] ?? null;
}

async function main(argv) {
	const entry = argv.find((argument) => argument.startsWith('--entry='))?.slice('--entry='.length);
	const write = !argv.includes('--no-write');
	let outcome;
	try {
		outcome = await buildHostEsm({ ...(entry === undefined ? {} : { entry }), write });
	} catch (error) {
		process.stderr.write(`host ESM bundle: FAIL (esbuild could not build it)\n${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (outcome.violations.length > 0) {
		process.stderr.write(`host ESM bundle: FAIL (${String(outcome.violations.length)} violation(s))\n`);
		for (const violation of outcome.violations) process.stderr.write(`- ${violation}\n`);
		return 1;
	}
	process.stdout.write(
		`host ESM bundle: PASS (${String(outcome.inputs)} inputs, ${String(outcome.bytes)} bytes`
		+ `${write ? ` -> ${outcome.outfile}` : ''}; npm packages: ${outcome.packages.join(', ') || 'none'})\n`,
	);
	return 0;
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = await main(process.argv.slice(2));
