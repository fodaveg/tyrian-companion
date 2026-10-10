import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateReleaseWorkflow } from '../release-workflow-contract.mjs';

const root = process.cwd();
const workflowDirectory = '.github/workflows';
const failures = [];
const testRoot = mkdtempSync(join(tmpdir(), 'release-workflow-'));
const releaseSource = readFileSync(resolve(root, workflowDirectory, 'release.yml'), 'utf8');

try {
	testRepositoryIsGreen();
	testGateMustPrecedePublication();
	testGuardrailsMustRunBeforePackaging();
	testMissingGateIsRed();
	testShellCommentDoesNotSatisfyTheGate();
	testWriteAccessIsRequiredAndConfined();
	testTagTriggerIsRequired();
	testPlanningIsRequired();
	testNodeComesFromOneFile();
	testCiKeepsWhatTheGateGaveUp();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`release workflow suite: ${failure}\n`);
	process.stderr.write(`release workflow suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('release workflow suite: PASS\n');
}

function testRepositoryIsGreen() {
	const result = validateReleaseWorkflow(root);
	assert(result.findings.length === 0, `the repository workflows are red: [${result.findings.join(', ')}]`);
}

/**
 * The whole point of the job. `brat-release-contract.mjs` already existed and
 * already worked; what it never did was run BEFORE the release was created, so
 * 0.1.19 published without assets and the contract only confirmed it afterwards.
 * Moving the gate after the publication has to be red.
 */
function testGateMustPrecedePublication() {
	const inverted = moveGateAfterPublication(releaseSource);
	assert(inverted !== releaseSource, 'the suite could not build the inverted-order workflow, so it proves nothing');
	assertFinding('a gate placed after the publication', inverted, 'release-gate-after-publication');
}

/**
 * GR-02: `check` alone leaves the guardrail suites out, and a tag push does not
 * trigger `ci.yml`. Removing the step, putting it after the package, or leaving
 * only a shell comment about it has to be red.
 */
function testGuardrailsMustRunBeforePackaging() {
	const without = removeStep(releaseSource, 'Guardrails');
	assert(without !== releaseSource, 'the suite could not remove the guardrails step, so it proves nothing');
	assertFinding('a release that never runs check:guardrails', without, 'release-missing-guardrails');

	const guardrails = extractStep(releaseSource, 'Guardrails');
	const packaging = extractStep(releaseSource, 'Build the release package');
	assert(guardrails !== null && packaging !== null, 'the suite could not find the guardrails and packaging steps');
	const late = releaseSource.replace(guardrails, '@@G@@').replace(packaging, packaging + guardrails).replace('@@G@@', '');
	assert(late !== releaseSource, 'the suite could not build the late-guardrails workflow, so it proves nothing');
	assertFinding('guardrails that run after the package is built', late, 'release-guardrails-after-package');

	const commented = releaseSource.replace(
		'        run: npm run check:guardrails',
		'        run: |\n          # npm run check:guardrails\n          echo skipped',
	);
	assert(commented !== releaseSource, 'the suite could not comment the guardrails out, so it proves nothing');
	assertFinding('guardrails that only exist inside a shell comment', commented, 'release-missing-guardrails');
}

/**
 * Deleting the pre-publication gate leaves only the post-publication
 * confirmation. That is precisely the 0.1.19 arrangement, and the contract has
 * to name it as such rather than shrug because a contract run still exists.
 */
function testMissingGateIsRed() {
	const onlyPostCheck = removeStep(releaseSource, 'BRAT contract as a pre-publication gate');
	assert(onlyPostCheck !== releaseSource, 'the suite could not remove the gate step, so it proves nothing');
	assertFinding('a workflow that only verifies after publishing', onlyPostCheck, 'release-gate-after-publication');

	const noContractAtAll = removeStep(onlyPostCheck, 'Confirm the published release against the contract');
	assert(noContractAtAll !== onlyPostCheck, 'the suite could not remove the confirmation step');
	assertFinding('a workflow with no BRAT contract run at all', noContractAtAll, 'release-missing-brat-gate');
}

/**
 * The guardrail must not be satisfied by its own documentation. A step whose
 * `run` only MENTIONS the contract in a shell comment has not run it.
 */
function testShellCommentDoesNotSatisfyTheGate() {
	let stripped = removeStep(releaseSource, 'BRAT contract as a pre-publication gate');
	stripped = removeStep(stripped, 'Confirm the published release against the contract');
	const commented = stripped.replace(
		'      - name: Publish',
		[
			'      - name: Pretend to gate',
			'        run: |',
			'          # node scripts/brat-release-contract.mjs --release-json .release/planned-release.json',
			'          echo skipped',
			'      - name: Publish',
		].join('\n'),
	);
	assert(commented !== stripped, 'the suite could not inject the commented-out gate, so it proves nothing');
	assertFinding('a gate that only exists inside a shell comment', commented, 'release-missing-brat-gate');
}

function testWriteAccessIsRequiredAndConfined() {
	const withoutWrite = releaseSource.replace('    permissions:\n      contents: write\n', '');
	assert(withoutWrite !== releaseSource, 'the suite could not strip the job permissions, so it proves nothing');
	assertFinding('a publishing job without contents: write', withoutWrite, 'release-job-missing-write');

	const escalatedTopLevel = releaseSource.replace('permissions:\n  contents: read', 'permissions:\n  contents: write');
	assert(escalatedTopLevel !== releaseSource, 'the suite could not escalate the top level permission');
	assertFinding('a release workflow granting write at the top level', escalatedTopLevel, 'release-top-level-permission');

	// The other workflow runs on every branch and pull request. It must stay read-only.
	const directory = buildRoot('ci-escalated', releaseSource);
	const ciPath = join(directory, workflowDirectory, 'ci.yml');
	writeFileSync(ciPath, readFileSync(ciPath, 'utf8').replace('permissions:\n  contents: read', 'permissions:\n  contents: write'));
	const result = validateReleaseWorkflow(directory);
	assert(
		result.findings.some((finding) => finding.startsWith('workflow-write-permission:')),
		`ci.yml with contents: write was accepted; findings were [${result.findings.join(', ')}]`,
	);
}

function testTagTriggerIsRequired() {
	assertFinding('a workflow that does not fire on tags', releaseSource.replace("    tags: ['*']", '    branches: [main]'), 'release-not-triggered-by-tag');
}

/**
 * GR-06: a literal Node in either workflow is how the publishing gate and the push gate diverged.
 * Both must read `.nvmrc`, and `.nvmrc` must exist.
 */
function testNodeComesFromOneFile() {
	const literal = releaseSource.replace("node-version-file: '.nvmrc'", "node-version: '22.20.0'");
	assert(literal !== releaseSource, 'the suite could not put a literal Node in release.yml, so it proves nothing');
	assertFinding('a release.yml with its own Node version', literal, 'workflow-node-not-from-nvmrc:release.yml');
	assertCiFinding(
		'a ci.yml job with its own Node version',
		(ci) => ci.replace("node-version-file: '.nvmrc'", "node-version: '24.12.0'"),
		'workflow-node-not-from-nvmrc:ci.yml',
	);
	const directory = buildRoot('no-nvmrc', releaseSource);
	rmSync(join(directory, '.nvmrc'));
	assert(
		validateReleaseWorkflow(directory).findings.includes('nvmrc-missing-or-malformed'),
		'a repository without .nvmrc was accepted',
	);
}

/**
 * GR-15 and GR-03: `ci.yml` carries the H8 spike (conditioned on the diff) and the slow-engine run.
 * Removing either, or making the spike unconditional, has to be red.
 */
function testCiKeepsWhatTheGateGaveUp() {
	assertCiFinding(
		'a ci.yml that no longer runs the H8 spike',
		(ci) => ci.replace('      - run: npm run test:h8-crossover-spike\n', '      - run: echo skipped\n'),
		'ci-missing-h8-spike-job',
	);
	assertCiFinding(
		'a ci.yml whose H8 spike runs on every push',
		(ci) => ci.replace("    if: needs.detect-spike-changes.outputs.changed == 'true'\n", ''),
		'ci-h8-spike-job-not-conditioned',
	);
	assertCiFinding(
		'a ci.yml without the slow-engine run',
		(ci) => ci.replace("TYRIAN_TEST_ENGINE_LATENCY_MS: '30'", "TYRIAN_TEST_ENGINE_LATENCY_MS: '0'"),
		'ci-missing-slow-engine-step',
	);
}

function testPlanningIsRequired() {
	let stripped = releaseSource;
	for (const name of ['Plan the BRAT release', 'Collect the exact asset paths']) stripped = removeStep(stripped, name);
	assertFinding('a workflow that never plans its asset set', stripped, 'release-assets-not-planned');
}

/** Rebuilds the publish step above the gate step, keeping both intact. */
function moveGateAfterPublication(source) {
	const gate = extractStep(source, 'BRAT contract as a pre-publication gate');
	const publish = extractStep(source, 'Publish');
	if (gate === null || publish === null) return source;
	return source.replace(gate, '@@GATE@@').replace(publish, gate).replace('@@GATE@@', publish);
}

function extractStep(source, name) {
	const start = source.indexOf(`      - name: ${name}\n`);
	if (start === -1) return null;
	const next = source.indexOf('\n      - name: ', start + 1);
	return next === -1 ? source.slice(start) : source.slice(start, next + 1);
}

function removeStep(source, name) {
	const step = extractStep(source, name);
	return step === null ? source : source.replace(step, '');
}

function assertFinding(label, source, finding) {
	const directory = buildRoot(finding.replace(/[^a-z-]/gu, '-') + Math.random().toString(36).slice(2, 8), source);
	const result = validateReleaseWorkflow(directory);
	assert(
		result.findings.includes(finding),
		`${label} did not turn red with ${finding}; got [${result.findings.join(', ')}]`,
	);
}

function assertCiFinding(label, mutate, finding) {
	const original = readFileSync(resolve(root, workflowDirectory, 'ci.yml'), 'utf8');
	const mutated = mutate(original);
	assert(mutated !== original, `the suite could not build "${label}", so it proves nothing`);
	const directory = buildRoot(finding.replace(/[^a-z-]/gu, '-') + Math.random().toString(36).slice(2, 8), releaseSource);
	writeFileSync(join(directory, workflowDirectory, 'ci.yml'), mutated);
	const result = validateReleaseWorkflow(directory);
	assert(
		result.findings.includes(finding),
		`${label} did not turn red with ${finding}; got [${result.findings.join(', ')}]`,
	);
}

function buildRoot(name, releaseYaml) {
	const directory = join(testRoot, name);
	mkdirSync(join(directory, workflowDirectory), { recursive: true });
	cpSync(resolve(root, workflowDirectory), join(directory, workflowDirectory), { recursive: true });
	cpSync(resolve(root, '.nvmrc'), join(directory, '.nvmrc'));
	writeFileSync(join(directory, workflowDirectory, 'release.yml'), releaseYaml);
	return directory;
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
