import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	ACTION_BOUNDARY_KINDS,
	collectActionBoundaryCensus,
	reviewActionBoundaryCensus,
	runActionBoundaryCensusCli,
	verifyActionBoundaryCensus,
} from '../action-observability-census.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-action-census-'));

try {
	write(testRoot, 'src/reviewed.ts', 'export const reviewed = true;\n');
	writeReviewedBaseline(testRoot);
	assert(verifyActionBoundaryCensus(testRoot).length === 0, 'reviewed baseline did not start green');

	const sabotages = new Map([
		['catch_clause', 'export async function caught() { try { await Promise.resolve(); } catch { return; } }\n'],
		['promise_catch', 'export const caught = Promise.resolve().catch(() => undefined);\n'],
		['void_expression', 'export function detached() { void Promise.resolve(); }\n'],
		['callback_registration', 'export function callback() { setTimeout(() => undefined, 1); }\n'],
	]);
	for (const kind of ACTION_BOUNDARY_KINDS) {
		const path = `src/sabotage-${kind}.ts`;
		write(testRoot, path, sabotages.get(kind));
		const findings = verifyActionBoundaryCensus(testRoot);
		assert(findings.some((finding) => finding.path === path && finding.kind === 'new_production_file'), `${kind} new-file sabotage stayed green`);
		rmSync(resolve(testRoot, path));

		write(testRoot, 'src/reviewed.ts', sabotages.get(kind));
		const boundaryFindings = verifyActionBoundaryCensus(testRoot);
		assert(boundaryFindings.some((finding) => finding.path === 'src/reviewed.ts' && finding.kind === kind), `${kind} boundary sabotage stayed green`);
		write(testRoot, 'src/reviewed.ts', 'export const reviewed = true;\n');
	}

	write(testRoot, 'src/new-empty.ts', 'export const stillProduction = true;\n');
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.kind === 'new_production_file'), 'boundary-free production file stayed green');
	rmSync(resolve(testRoot, 'src/new-empty.ts'));
	rmSync(resolve(testRoot, 'src/reviewed.ts'));
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.kind === 'missing_production_file'), 'deleted production file stayed green');
	write(testRoot, 'src/reviewed.ts', 'export const reviewed = true;\n');

	write(testRoot, 'src/reviewed.test.ts', 'void Promise.resolve().catch(() => undefined);\n');
	assert(verifyActionBoundaryCensus(testRoot).length === 0, 'test-only boundaries polluted production census');
	rmSync(resolve(testRoot, 'src/reviewed.test.ts'));

	write(testRoot, 'src/reviewed.ts', '\nexport const reviewed = true;\n');
	assert(verifyActionBoundaryCensus(testRoot).length === 0, 'boundary-free source movement changed the manifest');
	write(testRoot, 'src/reviewed.ts', 'export const reviewed = true;\n');

	assertInvalidBaseline(testRoot, 'invalid JSON', '{', 'invalid_json');
	rmSync(resolve(testRoot, 'scripts/action-observability-baseline.json'));
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.kind === 'missing_baseline'), 'missing baseline stayed green');
	writeReviewedBaseline(testRoot);
	assertInvalidMutation(testRoot, 'wrong version', (baseline) => { baseline.version += 1; }, 'version');
	assertInvalidMutation(testRoot, 'missing file classification', (baseline) => { delete baseline.files['src/reviewed.ts'].classification; }, 'file_shape');
	assertInvalidMutation(testRoot, 'blank file reason', (baseline) => { baseline.files['src/reviewed.ts'].reason = ''; }, 'file_reason');
	assertInvalidMutation(testRoot, 'mutilated file inventory', (baseline) => { delete baseline.files['src/reviewed.ts']; }, undefined, 'new_production_file');

	write(testRoot, 'src/reviewed.ts', 'export function detached() { void Promise.resolve(); }\n');
	writeReviewedBaseline(testRoot);
	assertInvalidMutation(testRoot, 'blank boundary reason', (baseline) => { baseline.files['src/reviewed.ts'].boundaries[0].reason = ''; }, 'boundary_reason');
	assertInvalidMutation(testRoot, 'unknown boundary classification', (baseline) => { baseline.files['src/reviewed.ts'].boundaries[0].classification = 'approved'; }, 'boundary_classification');
	assertInvalidMutation(testRoot, 'mutilated semantic evidence', (baseline) => {
		const boundary = baseline.files['src/reviewed.ts'].boundaries[0];
		boundary.evidence.target = 'other';
		boundary.evidence.justification = `The "${boundary.evidence.scope}" owner deliberately detaches "other"; that named operation owns rejection and terminal diagnostics.`;
		boundary.reason = `Allowlisted void_expression: ${boundary.evidence.justification} Verified target: "other" in "${boundary.evidence.scope}".`;
	}, 'allowlist_evidence_mismatch');
	assertInvalidMutation(testRoot, 'mutilated boundary list', (baseline) => { baseline.files['src/reviewed.ts'].boundaries = []; }, 'totals_mismatch');
	assertInvalidMutation(testRoot, 'blindly altered total', (baseline) => { baseline.totals.void_expression += 1; }, 'totals_mismatch');
	assertInvalidMutation(testRoot, 'duplicate boundary', (baseline) => { baseline.files['src/reviewed.ts'].boundaries.push({ ...baseline.files['src/reviewed.ts'].boundaries[0] }); }, 'duplicate_boundary');

	writeCandidateBaseline(testRoot);
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.issue === 'boundary_unreviewed'), 'new unreviewed boundary candidate stayed green');

	write(testRoot, 'src/reviewed.ts', 'export async function caught() { try { await Promise.resolve(); } catch { return; } }\n');
	writeClaimedObservedBaseline(testRoot, 'this.localDebugActions.event');
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.issue === 'observability_evidence_missing'), 'catch without a diagnostic call could claim observed');

	write(testRoot, 'src/reviewed.ts', 'export function callback() { setTimeout(() => { sideEffect(); }, 1); }\ndeclare function sideEffect(): void;\n');
	writeCandidateBaseline(testRoot);
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.issue === 'boundary_unreviewed'), 'callback side effect without an event was auto-approved');
	writeUnjustifiedAllowlistBaseline(testRoot);
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.issue === 'boundary_evidence'), 'callback side effect passed with a generic allowlist decision');
	writeClaimedObservedBaseline(testRoot, 'this.localDebugActions.event');
	assert(verifyActionBoundaryCensus(testRoot).some((finding) => finding.issue === 'observability_evidence_missing'), 'callback side effect without an event could claim observed');

	write(testRoot, 'src/reviewed.ts', 'export function callback() { setTimeout(() => { diagnostics.record(); }, 1); }\ndeclare const diagnostics: { record(): void };\n');
	writeObservedBaseline(testRoot);
	assert(verifyActionBoundaryCensus(testRoot).length === 0, 'direct diagnostic evidence was not accepted');

	const greenCli = runCli(testRoot);
	assert(greenCli.status === 0, 'CLI rejected the reviewed manifest');
	write(testRoot, 'src/reviewed.ts', 'export function callback() {\n\tsetTimeout(() => { diagnostics.record(); }, 1);\n}\ndeclare const diagnostics: { record(): void };\n');
	const redCli = runCli(testRoot);
	assert(redCli.status === 1, 'CLI behaved as an always-green scanner');
	assert(redCli.stderr.includes('callback_registration'), 'CLI omitted the content-free causal boundary kind');
	assert(!redCli.stderr.includes('diagnostics.record'), 'CLI exposed semantic or source content');

	process.stdout.write('action observability census suite: PASS\n');
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

function assertInvalidMutation(root, name, mutate, expectedIssue, alternativeKind) {
	const baseline = reviewActionBoundaryCensus(root, (boundary) => boundary.directObservabilityCalls.length > 0
		? { classification: 'observed', callee: boundary.directObservabilityCalls[0] }
		: allowlistDecision(boundary));
	mutate(baseline);
	write(root, 'scripts/action-observability-baseline.json', `${JSON.stringify(baseline, null, '\t')}\n`);
	const findings = verifyActionBoundaryCensus(root);
	assert(findings.some((finding) => finding.issue === expectedIssue || finding.kind === alternativeKind), `${name} did not fail closed with ${expectedIssue ?? alternativeKind}`);
	writeReviewedBaseline(root);
}

function assertInvalidBaseline(root, name, contents, expectedIssue) {
	write(root, 'scripts/action-observability-baseline.json', contents);
	const findings = verifyActionBoundaryCensus(root);
	assert(findings.some((finding) => finding.issue === expectedIssue), `${name} did not fail closed with ${expectedIssue}`);
	writeReviewedBaseline(root);
}

function writeCandidateBaseline(root) {
	write(root, 'scripts/action-observability-baseline.json', `${JSON.stringify(collectActionBoundaryCensus(root), null, '\t')}\n`);
}

function writeReviewedBaseline(root) {
	const baseline = reviewActionBoundaryCensus(root, (boundary) => boundary.directObservabilityCalls.length > 0
		? { classification: 'observed', callee: boundary.directObservabilityCalls[0] }
		: allowlistDecision(boundary));
	write(root, 'scripts/action-observability-baseline.json', `${JSON.stringify(baseline, null, '\t')}\n`);
}

function allowlistDecision(boundary) {
	const evidence = boundary.allowlistEvidence;
	if (boundary.kind === 'catch_clause' || boundary.kind === 'promise_catch') {
		return {
			classification: 'allowlisted',
			justification: `The "${evidence.scope}" owner explicitly handles "${evidence.behavior}" as local recovery; its enclosing action owns terminal diagnostics.`,
		};
	}
	if (boundary.kind === 'void_expression') {
		return {
			classification: 'allowlisted',
			justification: `The "${evidence.scope}" owner deliberately detaches "${evidence.target}"; that named operation owns rejection and terminal diagnostics.`,
		};
	}
	return {
		classification: 'allowlisted',
		justification: `The "${evidence.scope}" owner registers "${evidence.registration}" as a framework callback; its invoked action or state transition owns diagnostics.`,
	};
}

function writeClaimedObservedBaseline(root, callee) {
	const baseline = reviewActionBoundaryCensus(root, () => ({ classification: 'observed', callee }));
	write(root, 'scripts/action-observability-baseline.json', `${JSON.stringify(baseline, null, '\t')}\n`);
}

function writeUnjustifiedAllowlistBaseline(root) {
	const baseline = reviewActionBoundaryCensus(root, () => ({ classification: 'allowlisted' }));
	write(root, 'scripts/action-observability-baseline.json', `${JSON.stringify(baseline, null, '\t')}\n`);
}

function writeObservedBaseline(root) {
	const baseline = reviewActionBoundaryCensus(root, ({ directObservabilityCalls }) => ({
		classification: 'observed',
		callee: directObservabilityCalls[0],
	}));
	write(root, 'scripts/action-observability-baseline.json', `${JSON.stringify(baseline, null, '\t')}\n`);
}

function write(root, path, source) {
	const absolute = resolve(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, source);
}

function runCli(root) {
	let stdout = '';
	let stderr = '';
	const maxCapturedCharacters = 256 * 1024;
	const append = (current, chunk) => {
		const next = current + String(chunk);
		if (next.length > maxCapturedCharacters) throw new Error('CLI output exceeded the bounded test capture');
		return next;
	};
	const status = runActionBoundaryCensusCli([`--root=${root}`], {
		stdout: { write: (chunk) => { stdout = append(stdout, chunk); } },
		stderr: { write: (chunk) => { stderr = append(stderr, chunk); } },
	});
	return { status, stdout, stderr };
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}
