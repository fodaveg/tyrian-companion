import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	fileAssertsOverSourceText,
	listTestFiles,
	scanRepository,
	validateSourceTextAssertions,
} from '../source-text-assertion-contract.mjs';

const failures = [];
const testRoot = mkdtempSync(join(tmpdir(), 'source-text-assertion-'));

try {
	testDetectorPositives();
	testDetectorNegatives();
	testAllowlistRatchet();
	testAllowlistShape();
	testRealRepositoryIsGreen();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`source text assertion suite: ${failure}\n`);
	process.stderr.write(`source text assertion suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('source text assertion suite: PASS\n');
}

/** Every shape of "read a module and assert over its characters" has to be caught. */
function testDetectorPositives() {
	const cases = [
		['plain-relative-literal', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('src/main.ts', 'utf8');\nexpect(s).toContain('x');\n"],
		['url-relative-literal', "import { readFileSync } from 'node:fs';\nconst s = readFileSync(new URL('./companion-view.ts', import.meta.url), 'utf8');\n"],
		['async-read-file', "import { readFile } from 'node:fs/promises';\nconst s = await readFile('src/core/settings.ts', 'utf8');\n"],
		['namespaced-read', "import * as fs from 'node:fs';\nconst s = fs.readFileSync('src/ui/panel.ts', 'utf8');\n"],
		['template-literal-path', "import { readFileSync } from 'node:fs';\nconst s = readFileSync(`src/advisor/${name}.ts`, 'utf8');\n"],
		['indirect-through-list', "import { readFileSync } from 'node:fs';\nconst files = ['src/a.ts', 'src/b.ts'];\nconst sources = files.map((path) => readFileSync(path, 'utf8'));\n"],
		['bundler-module', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('scripts/security-scan.mjs', 'utf8');\n"],
	];
	for (const [name, source] of cases) {
		const verdict = fileAssertsOverSourceText(source, `${name}.test.ts`);
		assert(verdict.violates, `detector missed the violation ${name}`);
	}
}

/**
 * The control that matters as much as the red one: these must NOT be flagged,
 * or the rule stops being a rule and becomes a ban on reading files.
 */
function testDetectorNegatives() {
	const cases = [
		['json-fixture', "import { readFileSync } from 'node:fs';\nconst data = JSON.parse(readFileSync('src/test/fixture.json', 'utf8'));\n"],
		['stylesheet', "import { readFileSync } from 'node:fs';\nconst styles = readFileSync('styles.css', 'utf8');\n"],
		['markdown-document', "import { readFileSync } from 'node:fs';\nconst doc = readFileSync('README.md', 'utf8');\n"],
		['imports-a-module-without-reading-it', "import { thing } from './thing.ts';\nexpect(thing()).toBe(1);\n"],
		['reads-nothing', "expect(2 + 2).toBe(4);\n"],
		['module-name-only-in-a-line-comment', "import { readFileSync } from 'node:fs';\n// forbidden example: readFileSync('src/main.ts', 'utf8')\nconst data = readFileSync('src/test/fixture.json', 'utf8');\n"],
		['module-name-only-in-a-block-comment', "import { readFileSync } from 'node:fs';\n/* do not do this: read src/ui/companion-view.ts and assert over it */\nconst data = readFileSync('data.json', 'utf8');\n"],
	];
	for (const [name, source] of cases) {
		const verdict = fileAssertsOverSourceText(source, `${name}.test.ts`);
		assert(!verdict.violates, `detector produced a false positive for ${name}`);
	}
}

/** The frozen number must be a ratchet: a new offender is red, a cleaned one is red until pruned. */
function testAllowlistRatchet() {
	const baseline = new Map([
		['src/kept.test.ts', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('src/kept.ts', 'utf8');\n"],
		['src/clean.test.ts', "expect(1).toBe(1);\n"],
	]);

	const green = buildRoot('ratchet-green', baseline, { frozenCount: 1, frozen: ['src/kept.test.ts'] });
	assertNoFindings('a frozen offender alone', validateSourceTextAssertions(green));

	const added = new Map(baseline);
	added.set('src/new.test.ts', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('src/new.ts', 'utf8');\n");
	const withNew = buildRoot('ratchet-new', added, { frozenCount: 1, frozen: ['src/kept.test.ts'] });
	assertFinding('a new offender', validateSourceTextAssertions(withNew), 'new-source-text-assertion:src/new.test.ts');

	const cleaned = new Map(baseline);
	cleaned.set('src/kept.test.ts', "expect(1).toBe(1);\n");
	const withStale = buildRoot('ratchet-stale', cleaned, { frozenCount: 1, frozen: ['src/kept.test.ts'] });
	assertFinding('a cleaned file left on the list', validateSourceTextAssertions(withStale), 'stale-allowlist-entry:src/kept.test.ts');

	const pruned = buildRoot('ratchet-pruned', cleaned, { frozenCount: 0, frozen: [] });
	assertNoFindings('a pruned list', validateSourceTextAssertions(pruned));
}

function testAllowlistShape() {
	const baseline = new Map([['src/kept.test.ts', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('src/kept.ts', 'utf8');\n"]]);

	const miscounted = buildRoot('shape-count', baseline, { frozenCount: 9, frozen: ['src/kept.test.ts'] });
	assertFinding('a count that does not match the list', validateSourceTextAssertions(miscounted), 'allowlist-count-mismatch');

	const duplicated = buildRoot('shape-duplicate', baseline, { frozenCount: 2, frozen: ['src/kept.test.ts', 'src/kept.test.ts'] });
	assertFinding('a duplicated entry', validateSourceTextAssertions(duplicated), 'allowlist-duplicate-entry');

	const malformed = join(testRoot, 'shape-malformed');
	mkdirSync(join(malformed, 'scripts'), { recursive: true });
	writeFileSync(join(malformed, 'scripts/source-text-assertion-allowlist.json'), 'not json');
	assertFinding('an unreadable list', validateSourceTextAssertions(malformed), 'allowlist-unavailable');
}

/** The repository as it stands must be green, otherwise the gate is unusable today. */
function testRealRepositoryIsGreen() {
	const root = process.cwd();
	const scanned = listTestFiles(root);
	assert(scanned.length > 0, 'the scanner found no test files in the repository, so it is not looking anywhere');
	const offenders = scanRepository(root);
	assert(offenders.length > 0, 'the scanner found no offenders at all, which contradicts the measured baseline');
	assertNoFindings('the repository itself', validateSourceTextAssertions(root));
}

function buildRoot(name, files, allowlist) {
	const root = join(testRoot, name);
	for (const [path, source] of files) {
		const destination = join(root, path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, source);
	}
	const listPath = join(root, 'scripts/source-text-assertion-allowlist.json');
	mkdirSync(dirname(listPath), { recursive: true });
	writeFileSync(listPath, `${JSON.stringify(allowlist, null, '\t')}\n`);
	return root;
}

function assertFinding(label, result, finding) {
	assert(
		result.findings.includes(finding),
		`${label} did not turn red with ${finding}; got [${result.findings.join(', ')}]`,
	);
}

function assertNoFindings(label, result) {
	assert(result.findings.length === 0, `${label} turned red unexpectedly with [${result.findings.join(', ')}]`);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
