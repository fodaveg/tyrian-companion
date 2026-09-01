/**
 * The gate as data.
 *
 * Every step is an independent unit with its own verdict. Nothing here is
 * chained with `&&`: a chain stops at the first red and the eleven steps behind
 * it never run, which the log reports as silence rather than as failure. The
 * runner reads this list, gives every step a status before executing anything,
 * and can therefore say NOT EXECUTED out loud instead of omitting a line.
 *
 * `groups` is the set of entry points a step belongs to. A step listed in both
 * `test` and `check` runs exactly ONCE per invocation: the previous `check`
 * re-ran the observability census a second time because `security:scan` and
 * `test:action-observability` both invoked it.
 */

/** Status a step carries before the runner has reached it. */
export const NOT_EXECUTED = 'NO EJECUTADO';
export const PASSED = 'OK';
export const FAILED = 'FALLO';

export const GATE_GROUPS = Object.freeze(['test', 'check']);

export const GATE_STEPS = Object.freeze([
	step('lint', 'ESLint sobre todo el arbol', ['eslint', '.'], ['check']),
	step('typecheck', 'tsc --noEmit', ['tsc', '--noEmit', '--skipLibCheck'], ['check']),
	step('unit', 'Suite unitaria de vitest', ['vitest', 'run', '--configLoader', 'runner'], ['test', 'check']),
	step('h8-crossover-spike', 'Spike H8 de crossover', ['bash', 'scripts/tests/probar-h8-crossover-spike.sh'], ['test', 'check']),
	step('release-preflight', 'Preflight de release', ['bash', 'scripts/tests/probar-release-preflight.sh'], ['test', 'check']),
	step('brat-release-contract', 'Suite del contrato BRAT', ['node', 'scripts/tests/probar-brat-release-contract.mjs'], ['test', 'check']),
	step('brat-release-plan', 'Suite del plan de release BRAT (puerta previa a publicar)', ['node', 'scripts/tests/probar-brat-release-plan.mjs'], ['test', 'check']),
	step('release-workflow-contract', 'Contrato del workflow de publicacion', ['node', 'scripts/tests/probar-release-workflow.mjs'], ['test', 'check']),
	step('security-scan-suite', 'Suite del escaner de seguridad', ['node', 'scripts/tests/probar-security-scan.mjs'], ['test', 'check']),
	step('security-scan', 'Escaner de seguridad sobre el arbol', ['node', 'scripts/security-scan.mjs'], ['check']),
	step('action-observability-suite', 'Suite del censo de observabilidad', ['node', 'scripts/tests/probar-action-observability-census.mjs'], ['test', 'check']),
	step('action-observability-census', 'Censo de observabilidad sobre el arbol', ['node', 'scripts/action-observability-census.mjs'], ['test', 'check']),
	step('run-gate-suite', 'Suite del propio corredor del gate', ['node', 'scripts/tests/probar-run-gate.mjs'], ['test', 'check']),
	step('source-text-assertion-suite', 'Suite del contrato de asercion sobre codigo fuente', ['node', 'scripts/tests/probar-source-text-assertion-contract.mjs'], ['test', 'check']),
	step('source-text-assertion-contract', 'Contrato de asercion sobre codigo fuente', ['node', 'scripts/source-text-assertion-contract.mjs'], ['test', 'check']),
	step('release-package', 'Suite del paquete de release', ['node', 'scripts/tests/probar-release-package.mjs'], ['test', 'check']),
	step('release-identity-contract', 'Suite del contrato de identidad', ['node', 'scripts/tests/probar-release-identity-contract.mjs'], ['test', 'check']),
	step('beta-channel', 'Suite del canal beta', ['node', 'scripts/tests/probar-beta-channel.mjs'], ['test', 'check']),
	step('beta-runtime', 'Suite del runtime beta', ['bash', 'scripts/tests/probar-beta-runtime.sh'], ['test', 'check']),
	step('support-contract', 'Suite del contrato de soporte', ['node', 'scripts/tests/probar-support-contract.mjs'], ['test', 'check']),
	step('h8-helper-decision-contract', 'Suite del contrato de decision del helper H8', ['node', 'scripts/tests/probar-h8-helper-decision-contract.mjs'], ['test', 'check']),
	step('bundle', 'Bundle de produccion con esbuild', ['node', 'esbuild.config.mjs', 'production'], ['check']),
]);

function step(id, label, command, groups) {
	return Object.freeze({
		id,
		label,
		command: Object.freeze([...command]),
		groups: Object.freeze([...groups]),
	});
}

/** Steps that belong to a group, in declaration order. Unknown group returns null. */
export function stepsForGroup(group) {
	if (!GATE_GROUPS.includes(group)) return null;
	return GATE_STEPS.filter((entry) => entry.groups.includes(group));
}
