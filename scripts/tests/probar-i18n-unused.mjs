import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectCodeFiles, extractCatalogKeys, findUnusedI18nKeys } from '../i18n-unused.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-i18n-unused-'));
const failures = [];

try {
	testExtractsKeysFromACatalogObject();
	testExactLiteralConsumerIsNotUnused();
	testMappedValueConsumerIsNotUnused();
	testDynamicPrefixConsumerIsNotUnused();
	testBareDynamicPrefixCoversItsOwnGenericVariant();
	testTrailingDotPrefixCoversAnAppendedSuffix();
	testAOneLetterTemplateElsewhereDoesNotHideAnUnrelatedKey();
	testAGenuinelyDeadKeyIsReported();
	testCollectCodeFilesSkipsANestedWorktreeByName();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`i18n-unused suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('i18n-unused suite: PASS\n');
}

function testExtractsKeysFromACatalogObject() {
	const keys = extractCatalogKeys("const ES = {\n\t'a.b': 'x', 'a.c': 'y',\n} as const;\n");
	assert(sameSet(keys, ['a.b', 'a.c']), 'did not extract both same-line keys');
}

function testExactLiteralConsumerIsNotUnused() {
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'commands.openCompanion': 'Abrir',\n};\n",
		'consumer.ts': "translator.t('commands.openCompanion');\n",
	});
	assert(unused(scenario).length === 0, 'an exact-literal consumer was still reported as unused');
}

function testMappedValueConsumerIsNotUnused() {
	// `session-note-renderer.ts` maps activity codes to catalog keys through a
	// plain object literal, never a `.t(` call directly on the key.
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'activity.consume': 'Consumir',\n};\n",
		'consumer.ts': "const labels = { consume: 'activity.consume' };\n",
	});
	assert(unused(scenario).length === 0, 'a mapped-value consumer was still reported as unused');
}

function testDynamicPrefixConsumerIsNotUnused() {
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'advisor.sync.status.error': 'x', 'advisor.sync.status.success': 'y',\n};\n",
		'consumer.ts': "translator.t(`advisor.sync.status.${lastRun.status}`);\n",
	});
	assert(unused(scenario).length === 0, 'a dynamic-prefix consumer was still reported as unused');
}

function testBareDynamicPrefixCoversItsOwnGenericVariant() {
	// `halloween-alert-panel.ts`: the same template covers both the bare key
	// (`labelScope === ''`) and its `.generic` sibling (`labelScope === '.generic'`).
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'halloween.title': 'x', 'halloween.title.generic': 'y',\n};\n",
		'consumer.ts': "t(`halloween.title${labelScope}`);\n",
	});
	assert(unused(scenario).length === 0, 'the bare prefix did not cover its own key or its .generic sibling');
}

function testTrailingDotPrefixCoversAnAppendedSuffix() {
	// `session-note-renderer.ts`: `noteText`, not `t`, and the prefix ends in a
	// bare dot with nothing captured after it in source before the `${`.
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'note.evidence.exact': 'x',\n};\n",
		'consumer.ts': "noteText(locale, `note.evidence.${status}`);\n",
	});
	assert(unused(scenario).length === 0, 'a trailing-dot dynamic prefix from a non-t() consumer was not recognised');
}

function testAOneLetterTemplateElsewhereDoesNotHideAnUnrelatedKey() {
	// Regression: an unrelated `` `s${minute}` `` template (built for a test
	// fixture id, nothing to do with i18n) must not supply a one-letter,
	// dot-free prefix that every `s`-initial catalog key then "starts with".
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'settings.connection.name': 'x',\n};\n",
		'consumer.ts': "detector.observe(delta(`s${minute}`, `s${minute + 1}`));\n",
	});
	assert(unused(scenario).length === 1 && unused(scenario)[0] === 'settings.connection.name',
		'a one-letter unrelated template prefix hid a genuinely dead key');
}

function testAGenuinelyDeadKeyIsReported() {
	const scenario = fixture({
		'i18n.ts': "const ES = {\n\t'notices.longGone': 'x',\n};\n",
		'consumer.ts': "// no reference to the dead key anywhere\n",
	});
	assert(unused(scenario).length === 1 && unused(scenario)[0] === 'notices.longGone',
		'a genuinely unreferenced key was not reported');
}

function testCollectCodeFilesSkipsANestedWorktreeByName() {
	const root = join(testRoot, `walk-${String(Math.random()).slice(2)}`);
	mkdirSync(join(root, 'src'), { recursive: true });
	mkdirSync(join(root, '.claude', 'worktrees', 'agent-x', 'src'), { recursive: true });
	writeFileSync(join(root, 'src', 'a.ts'), '// real\n');
	writeFileSync(join(root, '.claude', 'worktrees', 'agent-x', 'src', 'a.ts'), '// duplicate\n');
	const files = collectCodeFiles(root, ['.claude']);
	assert(files.length === 1, `expected only the non-nested file, got ${String(files.length)}`);
}

function fixture(files) {
	const dir = join(testRoot, `case-${String(Math.random()).slice(2)}`);
	mkdirSync(join(dir, 'src'), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'src', name), content);
	return {
		catalogFiles: [join(dir, 'src', 'i18n.ts')],
		searchRoots: [join(dir, 'src')],
	};
}

function unused(scenario) {
	return findUnusedI18nKeys(scenario);
}

function sameSet(actual, expected) {
	return actual.size === expected.length && expected.every((key) => actual.has(key));
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
