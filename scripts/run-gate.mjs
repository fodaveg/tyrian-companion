import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAILED, GATE_GROUPS, NOT_EXECUTED, PASSED, stepsForGroup } from './gate-steps.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs every step of a gate group, always, and reports each one on its own line.
 *
 * The invariant this exists to hold: a step that did not run must be NAMED as
 * NO EJECUTADO. An absent line is indistinguishable from a green one when you
 * read a log quickly, and that is exactly how six green steps hid behind one red
 * census. So the ledger is built complete BEFORE anything is executed, and the
 * summary is printed from an exit handler, which means even a crash or a Ctrl-C
 * leaves a summary naming the steps that never started.
 */
export function runGate({ group, root = REPOSITORY_ROOT, spawn = spawnSync, out = process.stdout, err = process.stderr } = {}) {
	const steps = stepsForGroup(group);
	if (steps === null) {
		err.write(`gate: grupo desconocido '${group}'; los grupos son ${GATE_GROUPS.join(', ')}\n`);
		return { code: 1, ledger: [] };
	}

	const ledger = steps.map((step) => ({ step, status: NOT_EXECUTED, exitCode: null, durationMs: null }));
	let summaryPrinted = false;
	const printSummary = () => {
		if (summaryPrinted) return;
		summaryPrinted = true;
		writeSummary(ledger, group, out);
	};
	process.on('exit', printSummary);

	out.write(`\n=== GATE '${group}': ${ledger.length} pasos, todos se ejecutan ===\n`);
	try {
		for (const entry of ledger) {
			out.write(`\n--- [${position(ledger, entry)}] ${entry.step.id}: ${entry.step.label}\n`);
			const started = Date.now();
			const result = spawn(binaryFor(entry.step.command[0], root), entry.step.command.slice(1), {
				cwd: root,
				stdio: 'inherit',
				env: process.env,
			});
			entry.durationMs = Date.now() - started;
			entry.exitCode = exitCodeOf(result);
			entry.status = entry.exitCode === 0 ? PASSED : FAILED;
			out.write(`--- [${position(ledger, entry)}] ${entry.step.id}: ${entry.status} (exit=${entry.exitCode}, ${entry.durationMs} ms)\n`);
		}
	} finally {
		printSummary();
		process.off('exit', printSummary);
	}
	const failed = ledger.filter((entry) => entry.status !== PASSED);
	return { code: failed.length === 0 ? 0 : 1, ledger };
}

/**
 * A spawn that could not start (missing binary, ENOENT) has a null status. That
 * is a failure, never a pass: reading `result.status === 0` on such a result
 * would silently green-light a step whose command does not exist.
 */
function exitCodeOf(result) {
	if (result === null || result === undefined) return 1;
	if (result.error !== undefined && result.error !== null) return 1;
	if (typeof result.status === 'number') return result.status;
	if (typeof result.signal === 'string' && result.signal !== '') return 1;
	return 1;
}

/** Prefers the locally installed binary so the gate never silently uses a global one. */
function binaryFor(command, root) {
	if (command === 'node') return process.execPath;
	if (command === 'bash') return 'bash';
	const local = resolve(root, 'node_modules', '.bin', command);
	return existsSync(local) ? local : command;
}

function position(ledger, entry) {
	return `${ledger.indexOf(entry) + 1}/${ledger.length}`;
}

function writeSummary(ledger, group, out) {
	const passed = ledger.filter((entry) => entry.status === PASSED);
	const failed = ledger.filter((entry) => entry.status === FAILED);
	const notExecuted = ledger.filter((entry) => entry.status === NOT_EXECUTED);

	out.write(`\n=== RESUMEN DEL GATE '${group}' ===\n`);
	for (const entry of ledger) {
		const detail = entry.status === NOT_EXECUTED
			? 'el gate no llego a este paso'
			: `exit=${entry.exitCode}, ${entry.durationMs} ms`;
		out.write(`  ${entry.status.padEnd(12)} ${entry.step.id.padEnd(34)} ${detail}\n`);
	}
	out.write(`\n  declarados: ${ledger.length}   OK: ${passed.length}   FALLO: ${failed.length}   NO EJECUTADO: ${notExecuted.length}\n`);
	if (failed.length > 0) out.write(`  fallaron: ${failed.map((entry) => entry.step.id).join(', ')}\n`);
	if (notExecuted.length > 0) out.write(`  NO se ejecutaron: ${notExecuted.map((entry) => entry.step.id).join(', ')}\n`);
	out.write(
		failed.length === 0 && notExecuted.length === 0
			? `  VEREDICTO: VERDE (${passed.length}/${ledger.length})\n\n`
			: `  VEREDICTO: ROJO (${passed.length}/${ledger.length} en verde)\n\n`,
	);
}

const isDirectExecution = process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
	const group = process.argv[2] ?? 'test';
	process.exitCode = runGate({ group }).code;
}
