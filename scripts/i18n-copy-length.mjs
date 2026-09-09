// H14.20 (lote K): fails when a `settings.*` or `view.*` catalog string exceeds
// the 90-character UI copy limit, in either locale. Other namespaces (`status.*`,
// `modal.*`, `commands.*`, `advisor.*`...) are read by different surfaces with
// their own space budget and are out of scope for this specific limit.
//
// A visible row keeps only the copy that decides something (what the setting
// does, its unit, its default); longer rationale belongs in a `.tooltip` key
// wired through `Setting.setTooltip` or a `title` attribute, or gets dropped
// when `docs/PRODUCT.md` already documents it. This script only measures the
// character count of the catalog string itself: it cannot tell whether the
// author actually preserved the decisive part, only that they made it fit.
//
// Run: `node scripts/i18n-copy-length.mjs` (prints one violation per line,
// exit 1 if any; prints nothing and exits 0 when every string is in budget).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_COPY_LENGTH = 90;
const IN_SCOPE_PREFIXES = ['settings.', 'view.'];

// Captures `'key': 'value'` and `'key': "value"` pairs, tolerant of escaped
// quotes inside either delimiter. Values that use double quotes only appear
// because the copy itself contains an unescaped `'` (e.g. "Master's kit").
const ENTRY_RE = /'([a-zA-Z][\w.]*)':\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;

/** @param {string} source */
export function extractInScopeEntries(source) {
	const entries = [];
	for (const match of source.matchAll(ENTRY_RE)) {
		const key = match[1];
		if (!IN_SCOPE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		const raw = match[2] ?? match[3] ?? '';
		entries.push({ key, value: unescape(raw) });
	}
	return entries;
}

/** @param {string} value */
function unescape(value) {
	return value.replace(/\\(.)/gu, '$1');
}

/**
 * @param {{ catalogFiles: string[]; maxLength?: number }} options
 * @returns {Array<{ file: string; key: string; length: number; value: string }>}
 */
export function findOverlongCopy({ catalogFiles, maxLength = MAX_COPY_LENGTH }) {
	const violations = [];
	for (const file of catalogFiles) {
		const source = readFileSync(file, 'utf8');
		for (const { key, value } of extractInScopeEntries(source)) {
			if (value.length > maxLength) violations.push({ file, key, length: value.length, value });
		}
	}
	return violations.sort((a, b) => b.length - a.length);
}

async function main() {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const violations = findOverlongCopy({
		catalogFiles: [join(root, 'src/core/i18n.ts'), join(root, 'src/core/i18n-runtime-catalog.ts')],
	});
	for (const { file, key, length, value } of violations) {
		process.stdout.write(`${file}: ${key} (${String(length)} chars, max ${String(MAX_COPY_LENGTH)}): ${value}\n`);
	}
	process.exit(violations.length > 0 ? 1 : 0);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
