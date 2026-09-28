// R1a (SPEC-TYRIAN-EN-HEBRA.md section 1): bundles the host-neutral entry `src/runtime/index.ts`
// the way Hebra's webview will load it (ESM, browser platform, everything bundled) into the
// git-ignored `.host-esm/`, and FAILS when the bundle would need anything a webview without Node
// or Electron does not have:
//
// - an import of `obsidian`, `electron`, `net` or any Node builtin (bare or `node:`-prefixed);
// - a free reference to the `Buffer` or `process` globals (a member such as `vault.process` or a
//   local binding of that name is not one: esbuild's `define` only rewrites global references,
//   so each one is replaced by a marker this script then looks for). A bare `typeof process`
//   feature test is allowed; the guarded use behind it is not;
// - `Buffer`, `process` or `require` read off `globalThis`/`window`/`self`/`global`, and any
//   `require`/`__require` call left in the output (a require esbuild could not resolve);
// - a CSS import, or a package that is not declared in package.json.
//
// Run: `npm run build:host-esm` (exit 0 and a one-line summary when clean; exit 1 listing every
// violation otherwise). `--entry=<file>` and `--no-write` exist for `scripts/tests/probar-build-host-esm.mjs`.

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import esbuild from 'esbuild';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_ESM_ENTRY = 'src/runtime/index.ts';
export const HOST_ESM_OUTFILE = '.host-esm/tyrian-runtime.js';

const FORBIDDEN_PACKAGES = new Set(['obsidian', 'electron', 'net']);
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const FORBIDDEN_GLOBALS = ['Buffer', 'process'];
const GLOBAL_MARKER = '__TYRIAN_HOST_ESM_FORBIDDEN_GLOBAL_';
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
const GLOBAL_MEMBERS = new Set(['Buffer', 'process', 'require']);

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
	violations.push(...outputViolations(text));
	const inputs = Object.keys(result.metafile.inputs);
	for (const input of inputs.filter((path) => path.endsWith('.css'))) violations.push(`CSS import ${input}`);
	const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const declared = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
	const packages = [...new Set(inputs.flatMap((path) => packageOf(path) ?? []))].sort();
	for (const name of packages.filter((name) => !declared.has(name))) violations.push(`package ${name} is not declared in package.json`);
	const bytes = text.length;
	return { violations, inputs: inputs.length, packages, bytes, outfile };
}

/**
 * What the bundled OUTPUT still asks of a Node or Electron host, read from its AST (so a string
 * or a comment that merely names one of these never counts):
 *
 * - a global `Buffer`/`process` (esbuild's define turned each free reference into a marker); one
 *   under `typeof` is only a feature test and is allowed, the use it guards is not;
 * - `Buffer`, `process` or `require` read off `globalThis`, `window`, `self` or `global`, with a
 *   dot or a bracket (`(globalThis as any).Buffer`, `window.require('net')`), which `define` and
 *   the import check cannot see;
 * - a call to `require` or esbuild's `__require` shim: what is left of a `require` it could not
 *   resolve at bundle time, such as `require(name)` with a computed name.
 */
export function outputViolations(text) {
	const file = ts.createSourceFile('host-esm-output.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const counts = new Map();
	const count = (label) => { counts.set(label, (counts.get(label) ?? 0) + 1); };
	const memberName = (node) => {
		if (ts.isPropertyAccessExpression(node)) return node.name.text;
		if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
		return null;
	};
	const visit = (node) => {
		if (ts.isIdentifier(node) && node.text.startsWith(GLOBAL_MARKER) && !ts.isTypeOfExpression(node.parent)) {
			count(`global ${node.text.slice(GLOBAL_MARKER.length)} referenced`);
		}
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const owner = node.expression;
			const name = memberName(node);
			if (ts.isIdentifier(owner) && GLOBAL_OBJECTS.has(owner.text) && name !== null && GLOBAL_MEMBERS.has(name)) {
				count(`global object member ${owner.text}.${name} referenced`);
			}
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
			&& (node.expression.text === 'require' || node.expression.text === '__require')) {
			count(`unresolved ${node.expression.text}() call`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return [...counts].map(([label, total]) => `${label} ${String(total)} time(s)`);
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
