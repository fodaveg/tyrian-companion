// Proves `scripts/build-host-esm.mjs` catches what it claims to catch (R1a): each probe entry is
// written under the git-ignored `.host-esm/probe/`, bundled without writing output, and must come
// back with exactly the violations it plants. The real entry must come back clean, and the
// look-alikes (a `process` member or key, a relative `./net` module) must not be flagged.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHostEsm, isForbiddenSpecifier } from '../build-host-esm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_DIR = '.host-esm/probe';
const failures = [];

function check(condition, message) {
	if (!condition) failures.push(message);
}

async function probe(name, files, expected) {
	const directory = resolve(ROOT, PROBE_DIR, name);
	mkdirSync(directory, { recursive: true });
	for (const [file, source] of Object.entries(files)) writeFileSync(resolve(directory, file), source);
	let outcome;
	try {
		outcome = await buildHostEsm({ root: ROOT, entry: `${PROBE_DIR}/${name}/entry.ts`, outfile: `${PROBE_DIR}/${name}/out.js`, write: false });
	} catch (error) {
		failures.push(`${name}: esbuild failed instead of reporting: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const got = [...outcome.violations].sort();
	const want = [...expected].sort();
	check(JSON.stringify(got) === JSON.stringify(want), `${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

try {
	for (const specifier of ['obsidian', 'electron', 'net', 'node:fs', 'fs', 'fs/promises', 'node:net', 'child_process']) {
		check(isForbiddenSpecifier(specifier), `${specifier} should be forbidden`);
	}
	for (const specifier of ['yaml', './net', '../obsidian-mock', 'obsidian-like', '@scope/net']) {
		check(!isForbiddenSpecifier(specifier), `${specifier} should be allowed`);
	}

	const clean = await buildHostEsm({ root: ROOT, write: false });
	check(clean.violations.length === 0, `the real entry has violations: ${clean.violations.join('; ')}`);
	check(clean.packages.includes('yaml'), 'the real entry no longer bundles yaml: update the relay\'s dependency list');

	await probe('obsidian-in-entry', {
		'entry.ts': "import 'obsidian';\nexport * from '../../../src/runtime/index';\n",
	}, [`import 'obsidian' from ${PROBE_DIR}/obsidian-in-entry/entry.ts`]);
	await probe('transitive-host', {
		'entry.ts': "export { createObsidianHost } from '../../../src/host/obsidian/obsidian-host';\n",
	}, [
		"import 'obsidian' from src/host/obsidian/obsidian-host.ts",
		"import 'electron' from src/host/obsidian/obsidian-host.ts",
		"import 'obsidian' from src/host/obsidian/obsidian-http.ts",
		"import 'net' from src/host/obsidian/obsidian-tcp-server.ts",
		"import 'obsidian' from src/host/obsidian/obsidian-ui.ts",
		"import 'obsidian' from src/host/obsidian/obsidian-vault.ts",
	]);
	await probe('node-builtins', {
		'entry.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'path';\nexport const read = [readFileSync, join];\n",
	}, [
		`import 'node:fs' from ${PROBE_DIR}/node-builtins/entry.ts`,
		`import 'path' from ${PROBE_DIR}/node-builtins/entry.ts`,
	]);
	await probe('globals', {
		'entry.ts': "export const bytes = Buffer.from('x');\nexport const env = process.env.NODE_ENV;\nexport const again = process.platform;\n",
	}, ['global Buffer referenced 1 time(s)', 'global process referenced 2 time(s)']);
	await probe('global-object-members', {
		'entry.ts': [
			"export const bytes = (globalThis as any).Buffer.from('x');",
			'export const env = (globalThis as any).process.env.NODE_ENV;',
			"export const socket = (window as any).require('net');",
			"export const bracket = (self as any)['process'];",
			'',
		].join('\n'),
	}, [
		'global object member globalThis.Buffer referenced 1 time(s)',
		'global object member globalThis.process referenced 1 time(s)',
		'global object member window.require referenced 1 time(s)',
		'global object member self.process referenced 1 time(s)',
	]);
	await probe('computed-require', {
		'entry.ts': "const name = ['n', 'et'].join('');\ndeclare const require: (id: string) => unknown;\nexport const socket = require(name);\n",
	}, ['unresolved __require() call 1 time(s)']);
	await probe('typeof-feature-test', {
		'entry.ts': "export const hasProcess = typeof process !== 'undefined';\nexport const hasBuffer = typeof Buffer === 'function';\n",
	}, []);
	await probe('typeof-guarded-use', {
		'entry.ts': "export const env = typeof process !== 'undefined' ? process.env : null;\n",
	}, ['global process referenced 1 time(s)']);
	await probe('look-alikes', {
		'net.ts': 'export const net = 1;\n',
		'entry.ts': [
			"import { net } from './net';",
			'export const shape = { process: net, Buffer: 2 };',
			'export function read(vault: { process(): number }): number { const process = vault.process(); return process; }',
			'',
		].join('\n'),
	}, []);
	await probe('css', {
		'style.css': '.a { color: red; }\n',
		'entry.ts': "import './style.css';\nexport const a = 1;\n",
	}, [`CSS import ${PROBE_DIR}/css/style.css`]);
} finally {
	rmSync(resolve(ROOT, PROBE_DIR), { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`- ${failure}\n`);
	process.stderr.write(`host ESM bundle suite: FAIL (${String(failures.length)})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('host ESM bundle suite: PASS\n');
}
