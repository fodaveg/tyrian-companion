import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const SOURCE_TEXT_ASSERTION_CONTRACT_VERSION = 1;

/**
 * Where the frontier sits.
 *
 * A test that reads a data file (`.json`), a stylesheet (`.css`), a document
 * (`.md`) or any fixture is legitimate: those artefacts ARE the contract under
 * test and they have no other representation. A test that reads the SOURCE
 * MODULE of another unit and asserts over its characters is not testing
 * behaviour, it is testing how somebody typed the implementation: it stays
 * green while the function is dead and it turns red when a private member is
 * renamed.
 *
 * So the rule is scoped to executable module extensions only. The list below is
 * the whole frontier; anything absent from it is allowed without discussion.
 */
export const SOURCE_MODULE_EXTENSIONS = Object.freeze([
	'.cjs',
	'.cts',
	'.js',
	'.jsx',
	'.mjs',
	'.mts',
	'.ts',
	'.tsx',
]);

const READ_FUNCTION_NAMES = Object.freeze(['readFile', 'readFileSync']);
const TEST_SUFFIX = '.test.ts';
const ALLOWLIST_PATH = 'scripts/source-text-assertion-allowlist.json';
const SCAN_ROOT = 'src';

/**
 * Detection is done over the TypeScript AST, never over the raw characters of
 * the file. A regex over the text would match the rule's own prose the moment
 * somebody documented it inside a test, which is the classic way these
 * guardrails die. An AST has no comments, so a comment cannot arm or disarm it.
 */
export function fileAssertsOverSourceText(source, fileName = 'input.test.ts') {
	const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let readsAFile = false;
	const sourceModuleLiterals = [];

	const visit = (node) => {
		if (ts.isCallExpression(node) && isFileReadCallee(node.expression)) readsAFile = true;
		const literal = literalText(node);
		if (literal !== null && isSourceModulePath(literal)) sourceModuleLiterals.push(literal);
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(tree, visit);

	return {
		violates: readsAFile && sourceModuleLiterals.length > 0,
		readsAFile,
		sourceModuleLiterals: [...new Set(sourceModuleLiterals)].sort(),
	};
}

function isFileReadCallee(expression) {
	if (ts.isIdentifier(expression)) return READ_FUNCTION_NAMES.includes(expression.text);
	if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
		return READ_FUNCTION_NAMES.includes(expression.name.text);
	}
	return false;
}

function literalText(node) {
	if (ts.isStringLiteral(node)) return node.text;
	if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
	return null;
}

function isSourceModulePath(value) {
	const trimmed = value.trim();
	if (trimmed === '') return false;
	return SOURCE_MODULE_EXTENSIONS.some((extension) => trimmed.toLowerCase().endsWith(extension));
}

/** Lists every `*.test.ts` under the scan root, in stable repository-relative form. */
export function listTestFiles(root) {
	const scanRoot = resolve(root, SCAN_ROOT);
	const found = [];
	const walk = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
				found.push(relative(resolve(root), path).split(sep).join('/'));
			}
		}
	};
	if (safeIsDirectory(scanRoot)) walk(scanRoot);
	return found.sort();
}

function safeIsDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Returns every test file that currently asserts over another module's source text. */
export function scanRepository(root) {
	const offenders = [];
	for (const path of listTestFiles(root)) {
		let source;
		try {
			source = readFileSync(resolve(root, path), 'utf8');
		} catch {
			continue;
		}
		if (fileAssertsOverSourceText(source, path).violates) offenders.push(path);
	}
	return offenders;
}

/**
 * Compares the live scan against the frozen allowlist. A file that is not on
 * the list is a new violation. A file that IS on the list but no longer
 * violates is a stale entry: it has to be removed and the count decremented, so
 * the frozen number can only travel downwards.
 */
export function validateSourceTextAssertions(root = process.cwd()) {
	const findings = [];
	const allowlist = readAllowlist(root, findings);
	if (allowlist === null) return { version: SOURCE_TEXT_ASSERTION_CONTRACT_VERSION, findings, offenders: [] };

	const offenders = scanRepository(root);
	const frozen = new Set(allowlist.frozen);

	for (const path of offenders) {
		if (!frozen.has(path)) findings.push(`new-source-text-assertion:${path}`);
	}
	for (const path of allowlist.frozen) {
		if (!offenders.includes(path)) findings.push(`stale-allowlist-entry:${path}`);
	}
	if (allowlist.frozen.length !== allowlist.frozenCount) findings.push('allowlist-count-mismatch');
	if (offenders.length > allowlist.frozenCount) findings.push('frozen-count-exceeded');

	return {
		version: SOURCE_TEXT_ASSERTION_CONTRACT_VERSION,
		findings: [...new Set(findings)].sort(),
		offenders,
	};
}

function readAllowlist(root, findings) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(resolve(root, ALLOWLIST_PATH), 'utf8'));
	} catch {
		findings.push('allowlist-unavailable');
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		findings.push('allowlist-shape');
		return null;
	}
	const frozen = parsed.frozen;
	if (!Array.isArray(frozen) || frozen.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
		findings.push('allowlist-shape');
		return null;
	}
	if (!Number.isSafeInteger(parsed.frozenCount) || parsed.frozenCount < 0) {
		findings.push('allowlist-shape');
		return null;
	}
	if (new Set(frozen).size !== frozen.length) {
		findings.push('allowlist-duplicate-entry');
		return null;
	}
	return { frozen: [...frozen].sort(), frozenCount: parsed.frozenCount };
}

export function runCli(root = process.cwd()) {
	const result = validateSourceTextAssertions(root);
	if (result.findings.length > 0) {
		for (const finding of result.findings) {
			process.stderr.write(`source text assertion contract: ${finding}\n`);
		}
		process.stderr.write(
			'source text assertion contract: a test may read .json, .css or .md fixtures; it may not read another module\'s source and assert over its characters. Test the behaviour instead.\n',
		);
		return 1;
	}
	process.stdout.write(
		`source text assertion contract: PASS (frozen=${result.offenders.length}; scanned=${listTestFiles(root).length})\n`,
	);
	return 0;
}

const isDirectExecution = process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = runCli();
