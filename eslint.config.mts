import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export const defaultProjectFiles = [
	'eslint.config.mts',
	'manifest.json',
	'scripts/release-preflight.mjs',
	'scripts/release-package.mjs',
	'scripts/security-scan.mjs',
	'scripts/support-contract.mjs',
	'scripts/h8-native-decision-contract.mjs',
	'scripts/tests/probar-release-package.mjs',
	'scripts/tests/probar-h8-helper-decision-contract.mjs',
	'scripts/tests/probar-security-scan.mjs',
	'scripts/tests/probar-support-contract.mjs',
	'spikes/h8-mumble-crossover/validate-preprocessed.mjs',
] as const;

export const defaultProjectCapacity = 16;
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
