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
 *
 * `check` and `check:guardrails` are a deliberate split, not a subset (H14.16,
 * measured 8 sep: 74.7 s wall, 322 % CPU, 2.4 GB RSS for the old single
 * `check`). `check` is the fast smoke every push should afford: lint,
 * typecheck, the unit suite minus `src/platform` (0 bytes in the bundle) and
 * the frozen source-text-assertion tests, the security scanner and the
 * observability census over the tree, and the production bundle.
 * `check:guardrails` is everything else: the suites that test the gate's own
 * tooling (release, beta channel, BRAT, support, H8 helper decision, the
 * frozen architecture tests) rather than the product. Both run in CI; only
 * `check` is meant to be run locally on every save.
 */

/** Status a step carries before the runner has reached it. */
export const NOT_EXECUTED = 'NO EJECUTADO';
export const PASSED = 'OK';
export const FAILED = 'FALLO';

export const GATE_GROUPS = Object.freeze(['test', 'check', 'check:guardrails']);

export const GATE_STEPS = Object.freeze([
	step('lint', 'ESLint sobre todo el arbol', ['eslint', '.', '--cache', '--cache-location', 'node_modules/.cache/eslint'], ['check']),
	step('typecheck', 'tsc --noEmit', ['tsc', '--noEmit', '--skipLibCheck'], ['check']),
	step('unit', 'Suite unitaria de vitest (sin src/platform ni los tests de texto fuente congelados)', ['vitest', 'run', '--configLoader', 'runner'], ['test', 'check']),
	step('unit-guardrails', 'Suite unitaria de vitest sobre src/platform y los tests de texto fuente congelados', ['vitest', 'run', '--configLoader', 'runner', '--config', 'vitest.guardrails.config.mts'], ['test', 'check:guardrails']),
	step('h8-crossover-spike', 'Spike H8 de crossover', ['bash', 'scripts/tests/probar-h8-crossover-spike.sh'], ['test', 'check:guardrails']),
	step('release-preflight', 'Preflight de release', ['bash', 'scripts/tests/probar-release-preflight.sh'], ['test', 'check:guardrails']),
	step('brat-release-contract', 'Suite del contrato BRAT', ['node', 'scripts/tests/probar-brat-release-contract.mjs'], ['test', 'check:guardrails']),
	step('brat-release-plan', 'Suite del plan de release BRAT (puerta previa a publicar)', ['node', 'scripts/tests/probar-brat-release-plan.mjs'], ['test', 'check:guardrails']),
	step('release-workflow-contract', 'Contrato del workflow de publicacion', ['node', 'scripts/tests/probar-release-workflow.mjs'], ['test', 'check:guardrails']),
	step('security-scan-suite', 'Suite del escaner de seguridad', ['node', 'scripts/tests/probar-security-scan.mjs'], ['test', 'check:guardrails']),
	step('security-scan', 'Escaner de seguridad sobre el arbol', ['node', 'scripts/security-scan.mjs'], ['check']),
	step('action-observability-suite', 'Suite del censo de observabilidad', ['node', 'scripts/tests/probar-action-observability-census.mjs'], ['test', 'check:guardrails']),
	step('action-observability-census', 'Censo de observabilidad sobre el arbol', ['node', 'scripts/action-observability-census.mjs'], ['test', 'check']),
	step('run-gate-suite', 'Suite del propio corredor del gate', ['node', 'scripts/tests/probar-run-gate.mjs'], ['test', 'check:guardrails']),
	step('source-text-assertion-suite', 'Suite del contrato de asercion sobre codigo fuente', ['node', 'scripts/tests/probar-source-text-assertion-contract.mjs'], ['test', 'check:guardrails']),
	step('source-text-assertion-contract', 'Contrato de asercion sobre codigo fuente', ['node', 'scripts/source-text-assertion-contract.mjs'], ['test', 'check:guardrails']),
	step('release-package', 'Suite del paquete de release', ['node', 'scripts/tests/probar-release-package.mjs'], ['test', 'check:guardrails']),
	step('release-identity-contract', 'Suite del contrato de identidad', ['node', 'scripts/tests/probar-release-identity-contract.mjs'], ['test', 'check:guardrails']),
	step('beta-channel', 'Suite del canal beta', ['node', 'scripts/tests/probar-beta-channel.mjs'], ['test', 'check:guardrails']),
	step('beta-runtime', 'Suite del runtime beta', ['bash', 'scripts/tests/probar-beta-runtime.sh'], ['test', 'check:guardrails']),
	step('support-contract', 'Suite del contrato de soporte', ['node', 'scripts/tests/probar-support-contract.mjs'], ['test', 'check:guardrails']),
	step('h8-helper-decision-contract', 'Suite del contrato de decision del helper H8', ['node', 'scripts/tests/probar-h8-helper-decision-contract.mjs'], ['test', 'check:guardrails']),
	step('dev-install-suite', 'Suite de dev:install (copia + sha256 sobre un directorio temporal)', ['node', 'scripts/tests/probar-dev-install.mjs'], ['test', 'check:guardrails']),
	step('smoke-live-suite', 'Suite de smoke:live (log falso con una linea error)', ['node', 'scripts/tests/probar-smoke-live.mjs'], ['test', 'check:guardrails']),
	step('record-api-fixtures-suite', 'Suite de record-api-fixtures (sin red; fetch inyectado)', ['node', 'scripts/tests/probar-record-api-fixtures.mjs'], ['test', 'check:guardrails']),
	step('i18n-unused-suite', 'Suite del detector de claves i18n sin consumidor', ['node', 'scripts/tests/probar-i18n-unused.mjs'], ['test', 'check:guardrails']),
	step('i18n-unused', 'Claves i18n sin consumidor sobre el arbol', ['node', 'scripts/i18n-unused.mjs'], ['test', 'check']),
	step('i18n-copy-length-suite', 'Suite del limite de longitud de copy settings.*/view.*', ['node', 'scripts/tests/probar-i18n-copy-length.mjs'], ['test', 'check:guardrails']),
	step('i18n-copy-length', 'Longitud de copy settings.*/view.* sobre el arbol', ['node', 'scripts/i18n-copy-length.mjs'], ['test', 'check:guardrails']),
	step('changelog-entry-suite', 'Suite del extractor de notas de release desde el changelog', ['node', 'scripts/tests/probar-changelog-entry.mjs'], ['test', 'check:guardrails']),
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
