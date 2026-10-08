// Builds Tyrian as an EXTERNAL Hebra plugin (Hebra's SPEC-PLUGINS-EXTERNOS.md sections 3, 6 and
// 11.3; R1a before it): bundles `src/host/hebra/entry.ts`, the core plus its Hebra adapter, the way
// Hebra loads it (ONE ES module, browser platform, everything bundled, imported from a `blob:` URL
// where a relative or dynamic import has no base) into `hebra-main.mjs` at the repository root,
// with `hebraShared()` from `hebra-plugin-api` (Tyrian borrows nothing, so it changes nothing and
// `hebra.json` says `shared: {}`), and writes `hebra-styles.css` next to it: `tyrian-host.css`, a
// newline, `styles.css`, a newline, the order Hebra injected them in so Tyrian's rule wins at equal
// specificity. Both files are generated and git-ignored; `release:package` hashes them into
// `hebra.json`.
//
// It FAILS when the bundle would need anything a webview without Node or Electron does not have:
//
// - an import of `obsidian`, `electron`, `net` or any Node builtin (bare or `node:`-prefixed);
// - a free reference to the `Buffer` or `process` globals (a member such as `vault.process` or a
//   local binding of that name is not one: esbuild's `define` only rewrites global references,
//   so each one is replaced by a marker this script then looks for). A bare `typeof process`
//   feature test is allowed; the guarded use behind it is not;
// - `Buffer`, `process` or `require` read off `globalThis`/`window`/`self`/`global`, and any
//   `require`/`__require` call left in the output (a require esbuild could not resolve);
// - any import left in the output (Hebra resolves none), or a bundled copy of a module Hebra lends
//   (`@codemirror/*`, `@lezer/*`): two copies of `@codemirror/state` break Hebra's editor;
// - a CSS import, or a package that is not declared in package.json;
// - for the plugin entry, an output that does not export `activate`.
//
// Run: `npm run build:host-esm` (exit 0 and a one-line summary when clean; exit 1 listing every
// violation otherwise). `--entry=<file>` and `--no-write` exist for `scripts/tests/probar-build-host-esm.mjs`.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import esbuild from 'esbuild';
import { hebraShared } from 'hebra-plugin-api/build';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_ESM_ENTRY = 'src/host/hebra/entry.ts';
export const HOST_ESM_OUTFILE = 'hebra-main.mjs';
export const HEBRA_STYLES_FILE = 'hebra-styles.css';
/** The stylesheets concatenated into `hebra-styles.css`, in this order. */
export const HEBRA_STYLES_SOURCES = Object.freeze(['src/host/hebra/tyrian-host.css', 'styles.css']);
/** What the plugin entry has to export for Hebra (`HebraPluginModule`). */
const PLUGIN_EXPORTS = ['activate'];
/** Packages Hebra lends to plugins (`hebra-plugin-api/shared`): never bundled. */
const LENT_PACKAGE = /(?:^|\/)node_modules\/(?:@codemirror|@lezer)\//u;

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
export async function buildHostEsm({
	root = REPOSITORY_ROOT,
	entry = HOST_ESM_ENTRY,
	outfile = HOST_ESM_OUTFILE,
	write = true,
	requiredExports = entry === HOST_ESM_ENTRY ? PLUGIN_EXPORTS : [],
} = {}) {
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
		// Whitespace and syntax only: renaming identifiers would hide esbuild's `__require` shim from `outputViolations`.
		minifyWhitespace: true,
		minifySyntax: true,
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
		}, hebraShared()],
	});

	const violations = forbiddenImports.map(({ specifier, importer }) => `import '${specifier}' from ${importer}`);
	const text = result.outputFiles?.[0]?.text ?? readFileSync(resolve(root, outfile), 'utf8');
	violations.push(...outputViolations(text));
	const output = Object.values(result.metafile.outputs)[0];
	const reported = new Set(forbiddenImports.map(({ specifier }) => specifier));
	for (const imported of output?.imports ?? []) {
		if (!reported.has(imported.path)) violations.push(`unresolved import '${imported.path}' (${imported.kind}) left in the bundle`);
	}
	for (const name of requiredExports.filter((name) => !(output?.exports ?? []).includes(name))) {
		violations.push(`the bundle does not export '${name}'`);
	}
	const inputs = Object.keys(result.metafile.inputs);
	for (const input of inputs.filter((path) => path.endsWith('.css'))) violations.push(`CSS import ${input}`);
	for (const input of inputs.filter((path) => LENT_PACKAGE.test(path))) violations.push(`bundled copy of ${input}, which Hebra lends`);
	const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const declared = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
	const packages = [...new Set(inputs.flatMap((path) => packageOf(path) ?? []))].sort();
	for (const name of packages.filter((name) => !declared.has(name))) violations.push(`package ${name} is not declared in package.json`);
	const bytes = text.length;
	return { violations, inputs: inputs.length, packages, bytes, outfile, exports: [...(output?.exports ?? [])].sort() };
}

/**
 * `hebra-styles.css`: `tyrian-host.css`, a newline, `styles.css`, a newline. The same text Hebra's
 * compiled module injected (`tyrianStyleSheet(hostCss, tyrianCss)`), the Obsidian sheet last so
 * that, at equal specificity, Tyrian's own rule wins.
 */
export function hebraStyleSheet(root = REPOSITORY_ROOT) {
	return HEBRA_STYLES_SOURCES.map((source) => `${readFileSync(resolve(root, source), 'utf8')}\n`).join('');
}

/** Writes `hebra-styles.css` at the repository root and returns its byte length. */
export function writeHebraStyles(root = REPOSITORY_ROOT) {
	const css = hebraStyleSheet(root);
	writeFileSync(resolve(root, HEBRA_STYLES_FILE), css);
	return Buffer.byteLength(css);
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
		// A bundle that failed the guard must not stay where `release:package` would pick it up.
		if (write) rmSync(resolve(REPOSITORY_ROOT, outcome.outfile), { force: true });
		process.stderr.write(`host ESM bundle: FAIL (${String(outcome.violations.length)} violation(s))\n`);
		for (const violation of outcome.violations) process.stderr.write(`- ${violation}\n`);
		return 1;
	}
	const styles = write && entry === undefined ? writeHebraStyles() : null;
	process.stdout.write(
		`host ESM bundle: PASS (${String(outcome.inputs)} inputs, ${String(outcome.bytes)} bytes`
		+ `${write ? ` -> ${outcome.outfile}` : ''}; exports: ${outcome.exports.join(', ') || 'none'}`
		+ `; npm packages: ${outcome.packages.join(', ') || 'none'})\n`,
	);
	if (styles !== null) process.stdout.write(`hebra styles: ${String(styles)} bytes -> ${HEBRA_STYLES_FILE}\n`);
	return 0;
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = await main(process.argv.slice(2));
