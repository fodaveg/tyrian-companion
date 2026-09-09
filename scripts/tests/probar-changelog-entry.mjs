import { extractChangelogEntry, ChangelogEntryError, renderReleaseNotes } from '../changelog-entry.mjs';

const failures = [];

const SAMPLE = [
	'# Changelog',
	'',
	'## Release beta 0.1.30 - los precios llegan',
	'',
	'- fixed price parsing.',
	'',
	'## Release beta 0.1.29 - los ajustes caben en seis pestañas',
	'',
	'- flattened settings.',
	'',
].join('\n');

try {
	testExtractsTheNamedVersionOnly();
	testExtractsTheLastEntryToEndOfFile();
	testRejectsAMissingVersion();
	testRejectsAnEmptyEntry();
	testHandlesAHeadingWithNoSubtitle();
	testRendersTheSubtitleAsABoldFirstLine();
} finally {
	// no external resources to close
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`changelog-entry suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('changelog-entry suite: PASS\n');
}

function testExtractsTheNamedVersionOnly() {
	const entry = extractChangelogEntry(SAMPLE, '0.1.29');
	assert(entry.subtitle === 'los ajustes caben en seis pestañas', 'wrong subtitle extracted');
	assert(entry.body === '- flattened settings.', `wrong body extracted: ${JSON.stringify(entry.body)}`);
	assert(!entry.body.includes('los precios llegan'), 'entry leaked content from the newer, unrelated release');
}

function testExtractsTheLastEntryToEndOfFile() {
	const entry = extractChangelogEntry(SAMPLE, '0.1.30');
	assert(entry.body === '- fixed price parsing.', 'the newest entry did not stop before the next heading');
}

function testRejectsAMissingVersion() {
	assertThrowsCode(() => extractChangelogEntry(SAMPLE, '9.9.9'), 'version-not-found', 'a version absent from the changelog was accepted');
}

function testRejectsAnEmptyEntry() {
	const emptyEntry = '## Release beta 0.2.0 - nothing here\n\n## Release beta 0.1.30 - x\n\nbody\n';
	assertThrowsCode(() => extractChangelogEntry(emptyEntry, '0.2.0'), 'empty-entry', 'a heading with no body was accepted');
}

function testHandlesAHeadingWithNoSubtitle() {
	const noSubtitle = '## Release beta 0.1.5\n\nplain body\n';
	const entry = extractChangelogEntry(noSubtitle, '0.1.5');
	assert(entry.subtitle === null, 'a heading without " - subtitle" should report no subtitle');
	assert(entry.body === 'plain body', 'body was not extracted for a subtitle-less heading');
}

function testRendersTheSubtitleAsABoldFirstLine() {
	const rendered = renderReleaseNotes({ subtitle: 'x', body: 'y' });
	assert(rendered === '**x**\n\ny', `unexpected render: ${JSON.stringify(rendered)}`);
	const renderedNoSubtitle = renderReleaseNotes({ subtitle: null, body: 'y' });
	assert(renderedNoSubtitle === 'y', `unexpected render without subtitle: ${JSON.stringify(renderedNoSubtitle)}`);
}

function assertThrowsCode(fn, expectedCode, message) {
	try {
		fn();
	} catch (error) {
		if (error instanceof ChangelogEntryError && error.code === expectedCode) return;
		failures.push(`${message} (got: ${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	failures.push(message);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
