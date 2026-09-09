import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractInScopeEntries, findOverlongCopy, MAX_COPY_LENGTH } from '../i18n-copy-length.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-i18n-copy-length-'));
const failures = [];

try {
	testExtractsSingleQuotedEntries();
	testExtractsDoubleQuotedEntriesForAnEmbeddedApostrophe();
	testIgnoresOutOfScopeNamespaces();
	testAnEntryAtExactlyTheLimitPasses();
	testAnEntryOneOverTheLimitIsReported();
	testChecksBothLocalesAcrossBothCatalogFiles();
	testInterpolationPlaceholdersCountAsLiteralText();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`i18n-copy-length suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('i18n-copy-length suite: PASS\n');
}

function testExtractsSingleQuotedEntries() {
	const entries = extractInScopeEntries("const ES = {\n\t'settings.a': 'x', 'view.b': 'y',\n};\n");
	assert(entries.length === 2, `expected 2 entries, got ${String(entries.length)}`);
	assert(entries.some((entry) => entry.key === 'settings.a' && entry.value === 'x'), 'missing settings.a');
	assert(entries.some((entry) => entry.key === 'view.b' && entry.value === 'y'), 'missing view.b');
}

function testExtractsDoubleQuotedEntriesForAnEmbeddedApostrophe() {
	// `settings.salvage.kit.master` in the real catalog uses double quotes for
	// exactly this reason: "Master's (61.44 copper/use)".
	const entries = extractInScopeEntries('const EN = {\n\t\'settings.kit\': "Master\'s kit",\n};\n');
	assert(entries.length === 1 && entries[0].value === "Master's kit", 'did not read a double-quoted value');
}

function testIgnoresOutOfScopeNamespaces() {
	const longNotice = 'x'.repeat(200);
	const entries = extractInScopeEntries(`const ES = {\n\t'notices.longOne': '${longNotice}',\n};\n`);
	assert(entries.length === 0, 'a notices.* key leaked into the settings/view scope');
}

function testAnEntryAtExactlyTheLimitPasses() {
	const scenario = fixture({ 'i18n.ts': `const ES = {\n\t'settings.exact': '${'x'.repeat(MAX_COPY_LENGTH)}',\n};\n` });
	assert(findOverlongCopy(scenario).length === 0, 'a string exactly at the limit was flagged');
}

function testAnEntryOneOverTheLimitIsReported() {
	const scenario = fixture({ 'i18n.ts': `const ES = {\n\t'settings.over': '${'x'.repeat(MAX_COPY_LENGTH + 1)}',\n};\n` });
	const violations = findOverlongCopy(scenario);
	assert(violations.length === 1 && violations[0].key === 'settings.over', 'a one-over-limit string was not reported');
}

function testChecksBothLocalesAcrossBothCatalogFiles() {
	const long = 'x'.repeat(MAX_COPY_LENGTH + 5);
	const scenario = fixture({
		'i18n.ts': `const ES = {\n\t'settings.fromCore': '${long}',\n};\n`,
		'i18n-runtime-catalog.ts': `const ES = {\n\t'view.fromRuntime': '${long}',\n};\n`,
	});
	const violations = findOverlongCopy(scenario);
	assert(violations.length === 2, `expected violations from both catalog files, got ${String(violations.length)}`);
}

function testInterpolationPlaceholdersCountAsLiteralText() {
	// A `{{param}}` placeholder is measured as written: the runtime value it
	// interpolates is unknown at authoring time, so the literal template is
	// the only length the author controls.
	const scenario = fixture({
		'i18n.ts': `const ES = {\n\t'settings.withParam': '${'x'.repeat(83)}{{count}}',\n};\n`,
	});
	const violations = findOverlongCopy(scenario);
	assert(violations.length === 1, 'a placeholder did not count toward the character budget');
}

function fixture(files) {
	const dir = join(testRoot, `case-${String(Math.random()).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const catalogFiles = [];
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, name);
		writeFileSync(path, content);
		catalogFiles.push(path);
	}
	return { catalogFiles };
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
