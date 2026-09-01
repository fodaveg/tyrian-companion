import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAILED, GATE_STEPS, NOT_EXECUTED, PASSED, stepsForGroup } from '../gate-steps.mjs';
import { runGate } from '../run-gate.mjs';

const failures = [];

testEveryStepRunsEvenAfterARed();
testGreenGateIsGreen();
testUnreachedStepsAreNamed();
testFailedSpawnIsNotAPass();
testUnknownGroupIsRed();
testNoDuplicatedWorkInsideAGroup();
testManifestCoversDeclaredScripts();
testTestGroupIsContainedInCheck();

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`run gate suite: ${failure}\n`);
	process.stderr.write(`run gate suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('run gate suite: PASS\n');
}

/**
 * The whole reason this runner exists. With the old `&&` chain a red step one
 * skipped eleven steps and the log showed nothing about them. Here a red step
 * must not stop anything: every declared step still gets a verdict.
 */
function testEveryStepRunsEvenAfterARed() {
	const attempted = [];
	const steps = stepsForGroup('test');
	const redStepId = steps[0].id;
	const { code, ledger } = runGate({
		group: 'test',
		spawn: recordingSpawn(steps, attempted, (step) => (step.id === redStepId ? 1 : 0)),
		out: sink(),
		err: sink(),
	});

	assert(code === 1, 'a gate with a red step returned a green exit code');
	assert(
		attempted.length === ledger.length,
		`only ${attempted.length} of ${ledger.length} steps were attempted after a red one`,
	);
	assert(
		ledger.every((entry) => entry.status !== NOT_EXECUTED),
		'a step was left as NO EJECUTADO although nothing interrupted the run',
	);
	assert(
		ledger.filter((entry) => entry.status === FAILED).length === 1,
		'the red step did not end as the only failure',
	);
}

function testGreenGateIsGreen() {
	for (const group of ['test', 'check']) {
		const { code, ledger } = runGate({ group, spawn: recordingSpawn(stepsForGroup(group), [], () => 0), out: sink(), err: sink() });
		assert(code === 0, `the ${group} group returned red with every step green`);
		assert(ledger.every((entry) => entry.status === PASSED), `the ${group} group left a step without a green verdict`);
		assert(ledger.length > 0, `the ${group} group declared no steps at all`);
	}
}

/**
 * The invariant the summary exists for: a step the runner never reached is
 * printed by NAME as NO EJECUTADO. An omitted line reads exactly like a green
 * one, which is the confusion this whole job is about.
 */
function testUnreachedStepsAreNamed() {
	const steps = stepsForGroup('test');
	const stopAt = steps[2].id;
	const written = [];
	const out = sink(written);
	let threw = false;
	try {
		runGate({
			group: 'test',
			spawn: recordingSpawn(steps, [], (step) => {
				if (step.id === stopAt) throw new Error('runner died on purpose');
				return 0;
			}),
			out,
			err: sink(),
		});
	} catch {
		threw = true;
	}

	assert(threw, 'the runner swallowed a crash instead of propagating it');
	const summary = written.join('');
	assert(summary.includes('NO EJECUTADO'), 'the summary after a crash never printed NO EJECUTADO');
	for (const step of steps.slice(3)) {
		assert(
			summary.includes(`${NOT_EXECUTED.padEnd(12)} ${step.id.padEnd(34)}`),
			`the step ${step.id} was omitted from the summary instead of being named NO EJECUTADO`,
		);
	}
	assert(summary.includes('VEREDICTO: ROJO'), 'a crashed gate did not print a red verdict');
}

/** A spawn that could not start has `status === null`. Reading it as 0 would green-light a missing binary. */
function testFailedSpawnIsNotAPass() {
	const cases = [
		['enoent', () => ({ status: null, error: new Error('spawn ENOENT') })],
		['signal', () => ({ status: null, signal: 'SIGKILL' })],
		['undefined-result', () => undefined],
	];
	for (const [name, result] of cases) {
		const { code, ledger } = runGate({ group: 'test', spawn: () => result(), out: sink(), err: sink() });
		assert(code === 1, `a gate whose steps could not start (${name}) reported green`);
		assert(ledger.every((entry) => entry.status === FAILED), `a step that could not start (${name}) was not marked as failed`);
	}
}

function testUnknownGroupIsRed() {
	const written = [];
	const { code } = runGate({ group: 'no-existe', spawn: () => ({ status: 0 }), out: sink(), err: sink(written) });
	assert(code === 1, 'an unknown gate group returned green');
	assert(written.join('').includes('grupo desconocido'), 'an unknown gate group did not say so');
}

/** `check` used to run the observability census twice, once via `test` and once via `security:scan`. */
function testNoDuplicatedWorkInsideAGroup() {
	for (const group of ['test', 'check']) {
		const steps = stepsForGroup(group);
		const ids = steps.map((step) => step.id);
		assert(new Set(ids).size === ids.length, `the ${group} group declares a duplicated step id`);
		const commands = steps.map((step) => step.command.join(' '));
		assert(new Set(commands).size === commands.length, `the ${group} group runs the same command twice`);
	}
	const censusInCheck = stepsForGroup('check')
		.filter((step) => step.command.join(' ') === 'node scripts/action-observability-census.mjs');
	assert(censusInCheck.length === 1, `the observability census appears ${censusInCheck.length} times in check, it must appear once`);
}

/**
 * Closes the half of the guarantee the identity contract cannot see: that
 * contract freezes the list of `test:*` scripts in package.json, and this proves
 * the runner's manifest actually covers every one of them. Without this, a step
 * could stay declared in package.json and quietly stop being executed.
 */
function testManifestCoversDeclaredScripts() {
	const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
	const manifestCommands = new Set(GATE_STEPS.map((step) => step.command.join(' ')));
	const uncovered = [];
	for (const [name, command] of Object.entries(packageJson.scripts)) {
		if (!name.startsWith('test:')) continue;
		if (name === 'test:bench:h6-performance-red') continue;
		for (const piece of command.split('&&').map((part) => part.trim())) {
			if (!manifestCommands.has(piece)) uncovered.push(`${name} -> ${piece}`);
		}
	}
	assert(
		uncovered.length === 0,
		`these declared test scripts are not covered by the gate manifest: ${uncovered.join('; ')}`,
	);
}

function testTestGroupIsContainedInCheck() {
	const testIds = new Set(stepsForGroup('test').map((step) => step.id));
	const checkIds = new Set(stepsForGroup('check').map((step) => step.id));
	const missing = [...testIds].filter((id) => !checkIds.has(id));
	assert(missing.length === 0, `check does not include these test steps: ${missing.join(', ')}`);
	assert(checkIds.size > testIds.size, 'check does not add lint, typecheck or bundle on top of test');
}

/**
 * The fake spawn receives argv, not the step object, so it maps the command back
 * onto the manifest. Matching by command rather than by call order means a
 * runner that reordered or skipped steps cannot fool the recorder.
 */
function recordingSpawn(steps, attempted, statusFor) {
	const byCommand = new Map(steps.map((step) => [commandKey(step.command[0], step.command.slice(1)), step]));
	return (binary, args) => {
		const step = byCommand.get(commandKey(binary, args));
		if (step === undefined) {
			failures.push(`the runner spawned a command absent from the manifest: ${binary} ${args.join(' ')}`);
			return { status: 1 };
		}
		attempted.push(step.id);
		return { status: statusFor(step) };
	};
}

/** Normalises the resolved binary back to its manifest name (node, bash, or a local .bin entry). */
function commandKey(binary, args) {
	const name = binary === process.execPath ? 'node' : binary.split(/[\\/]/u).pop();
	return [name, ...args].join(' ');
}

function sink(collected = []) {
	return { write: (chunk) => collected.push(chunk) };
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
