import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export const defaultProjectFiles = [
	'eslint.config.mts',
	'manifest.json',
	'scripts/release-preflight.mjs',
	'scripts/release-package.mjs',
	'scripts/release-identity-contract.mjs',
	'scripts/brat-release-contract.mjs',
	'scripts/beta-channel-contract.mjs',
	'scripts/install-beta.mjs',
	'scripts/prepare-beta-artifact.mjs',
	'scripts/verify-beta-runtime.mjs',
	'scripts/security-scan.mjs',
	'scripts/action-observability-census.mjs',
	'scripts/reindex-action-observability-baseline.mjs',
	'scripts/support-contract.mjs',
	'scripts/h8-native-decision-contract.mjs',
	'scripts/tests/probar-release-package.mjs',
	'scripts/tests/probar-release-identity-contract.mjs',
	'scripts/tests/probar-brat-release-contract.mjs',
	'scripts/tests/probar-beta-channel.mjs',
	'scripts/tests/probar-beta-runtime.mjs',
	'scripts/tests/probar-h8-helper-decision-contract.mjs',
	'scripts/tests/probar-security-scan.mjs',
	'scripts/tests/probar-action-observability-census.mjs',
	'scripts/tests/probar-support-contract.mjs',
	'scripts/gate-steps.mjs',
	'scripts/run-gate.mjs',
	'scripts/source-text-assertion-contract.mjs',
	'scripts/brat-release-plan.mjs',
	'scripts/release-workflow-contract.mjs',
	'scripts/tests/probar-run-gate.mjs',
	'scripts/tests/probar-source-text-assertion-contract.mjs',
	'scripts/tests/probar-brat-release-plan.mjs',
	'scripts/tests/probar-release-workflow.mjs',
	'spikes/h8-mumble-crossover/validate-preprocessed.mjs',
] as const;

// Raised from 28 to 37 when the gate runner, the source text assertion contract
// and the release publication gate added nine scripts, and to 38 for H13.2's
// census reindexer. The headroom below is unchanged on purpose: the point of
// this bound is that growing it stays a deliberate edit rather than something
// that drifts.
export const defaultProjectCapacity = 38;
export const defaultProjectReservedHeadroom = 4;

export function assertDefaultProjectCapacity(
	files: readonly string[],
	capacity: number,
	reservedHeadroom: number,
): void {
	const requiredCapacity = files.length + reservedHeadroom;
	if (requiredCapacity > capacity) {
		throw new Error(
			`allowDefaultProject lists ${files.length} files and reserves ${reservedHeadroom} slots, ` +
				`but its explicit capacity is ${capacity}; move files into tsconfig or review the ESLint capacity`,
		);
	}
}

// This bounds an intentionally slow escape hatch; it does not prove that every entry belongs outside tsconfig.
assertDefaultProjectCapacity(defaultProjectFiles, defaultProjectCapacity, defaultProjectReservedHeadroom);

export default defineConfig(
	globalIgnores([
		'.beta-artifact',
		'.claude/**',
		'.release',
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
			projectService: {
					allowDefaultProject: [...defaultProjectFiles],
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: defaultProjectCapacity,
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
);
