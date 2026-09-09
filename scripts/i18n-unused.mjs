// H14.18: lists i18n catalog keys with no consumer anywhere in `src/` or `scripts/`.
//
// A key counts as used when either (a) its exact literal appears quoted
// (`'key'`, `"key"` or a non-interpolated `` `key` ``) somewhere outside the
// catalog files — including as a mapped value, e.g. `consume: 'activity.consume'` —
// or (b) a template literal like `` `advisor.view.${x}` `` establishes a
// dynamic prefix that the key starts with. `src/ui` builds a good third of
// its keys by interpolating a status/reason/kind suffix, and a naive
// exact-match scan would flag every one of them as dead.
//
// Run: `node scripts/i18n-unused.mjs` (prints one unused key per line, exit 1
// if any; prints nothing and exits 0 when the catalog is clean).
//
// KNOWN BLIND SPOT, measured 9 sep: a key reached through a DOUBLE dynamic
// build — `` `advisor.preferences.${cond ? 'quantityMode' : 'other'}.${option.value}` ``
// in `inventory-advisor-view.ts`, where neither the prefix nor the suffix is a
// source-code literal — cannot be recovered by this scanner and gets reported
// as dead. Deleting `advisor.preferences.quantityMode.all`/`.minimum` on that
// false signal broke two vitest specs at runtime with no typecheck error, since
// `TranslationKey` only widens to `string` through the `as never` cast in
// `preferenceText()`. Treat this script's output as a candidate list: run the
// full `vitest run` (not just typecheck) before trusting a deletion.

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);

const KEY_ENTRY_RE = /'([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)*)':\s*'/g;
// No requirement that the captured prefix end in a literal dot:
// `halloween-alert-panel.ts` builds both `halloween.aria` and its
// `halloween.aria.generic` sibling from the same `` `halloween.aria${labelScope}` ``,
// where `labelScope` is either `''` or `'.generic'`. Requiring a trailing dot
// here would miss the bare variant and flag it as dead.
//
// The prefix DOES require at least one literal dot, and deliberately does not
// anchor on a `t(`/`.t(` call: catalog consumers are not all named `t` (e.g.
// `noteText(note.locale, \`note.evidence.${status}\`)` in
// `session-note-renderer.ts`), so anchoring on the call site missed those and
// declared `note.evidence.exact` dead while it was live. Requiring a dot
// instead is what keeps an unrelated one-letter template — a test built
// `` `s${minute}` `` for a session id — from supplying a prefix that every
// `s`-initial catalog key then "starts with".
const DYNAMIC_PREFIX_RE = /`([a-zA-Z][\w]*(?:\.[\w]*)+)\$\{/g;

/**
 * Reviewed exceptions for the DOUBLE-dynamic blind spot above: neither the
 * prefix nor the suffix is a literal at either end of the interpolation, so no
 * static regex can recover them. Each entry names its one real call site;
 * add to this list only after checking `npx vitest run` still passes with the
 * key removed, the way `advisor.preferences.quantityMode.all`/`.minimum` did
 * not on 9 sep (see `inventory-advisor-view.ts`'s `updatePreferenceFormLabels`,
 * which builds `` `advisor.preferences.${select === form.quantityMode ? 'quantityMode' : …}.${option.value}` ``).
 */
const KNOWN_DOUBLE_DYNAMIC_KEYS = new Set([
	'advisor.preferences.quantityMode.all',
	'advisor.preferences.quantityMode.minimum',
]);

export function extractCatalogKeys(source) {
	const keys = new Set();
	for (const match of source.matchAll(KEY_ENTRY_RE)) keys.add(match[1]);
	return keys;
}

export function extractDynamicPrefixes(source) {
	const prefixes = new Set();
	for (const match of source.matchAll(DYNAMIC_PREFIX_RE)) prefixes.add(match[1]);
	return prefixes;
}

/**
 * Walks `root` for `.ts`/`.tsx`/`.mjs`/`.js` files, skipping any directory
 * whose bare NAME is in `excludeDirNames`. A substring match against the full
 * path is the wrong test here: this script itself normally runs from inside
 * an agent worktree under `.claude/worktrees/<id>/`, so the root path already
 * contains that segment and a substring exclude would empty the walk before
 * it starts. Matching the directory name instead only ever skips a NESTED
 * worktree found while walking, never the root the walk started from.
 */
export function collectCodeFiles(root, excludeDirNames = []) {
	const files = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (excludeDirNames.includes(entry.name)) continue;
				stack.push(path);
			} else if (CODE_EXTENSIONS.has(extname(entry.name))) files.push(path);
		}
	}
	return files;
}

/**
 * @param {{ catalogFiles: string[]; searchRoots: string[]; excludeDirNames?: string[] }} options
 */
export function findUnusedI18nKeys({ catalogFiles, searchRoots, excludeDirNames = [] }) {
	const keys = new Set();
	for (const file of catalogFiles) for (const key of extractCatalogKeys(readFileSync(file, 'utf8'))) keys.add(key);

	const files = searchRoots.flatMap((root) => collectCodeFiles(root, excludeDirNames))
		.filter((file) => !catalogFiles.includes(file));

	let corpus = '';
	const prefixes = new Set();
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		for (const prefix of extractDynamicPrefixes(text)) prefixes.add(prefix);
		corpus += text;
		corpus += '\n';
	}

	const unused = [];
	for (const key of keys) {
		if (KNOWN_DOUBLE_DYNAMIC_KEYS.has(key)) continue;
		const quoted = corpus.includes(`'${key}'`) || corpus.includes(`"${key}"`) || corpus.includes(`\`${key}\``);
		if (quoted) continue;
		if ([...prefixes].some((prefix) => key.startsWith(prefix))) continue;
		unused.push(key);
	}
	return unused.sort();
}

async function main() {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const unused = findUnusedI18nKeys({
		catalogFiles: [join(root, 'src/core/i18n.ts'), join(root, 'src/core/i18n-runtime-catalog.ts')],
		searchRoots: [join(root, 'src'), join(root, 'scripts')],
		excludeDirNames: ['.claude', 'node_modules'],
	});
	for (const key of unused) process.stdout.write(`${key}\n`);
	process.exit(unused.length > 0 ? 1 : 0);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
