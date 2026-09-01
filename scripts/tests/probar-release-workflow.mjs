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
	testMissingGateIsRed();
	testShellCommentDoesNotSatisfyTheGate();
	testWriteAccessIsRequiredAndConfined();
	testTagTriggerIsRequired();
	testPlanningIsRequired();
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

function buildRoot(name, releaseYaml) {
	const directory = join(testRoot, name);
	mkdirSync(join(directory, workflowDirectory), { recursive: true });
	cpSync(resolve(root, workflowDirectory), join(directory, workflowDirectory), { recursive: true });
	writeFileSync(join(directory, workflowDirectory, 'release.yml'), releaseYaml);
	return directory;
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
