import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const IMPLEMENTATION = [
	'src/assets/managed-assets-model.ts',
	'src/assets/managed-assets.ts',
	'src/assets/generic-assets.ts',
	'src/assets/managed-assets-lifecycle.ts',
	'src/assets/managed-assets-pointer.ts',
	'src/assets/managed-assets-ui.ts',
];

describe('managed-assets architecture boundary', () => {
	it('uses only the injected Vault port and contains no network, filesystem adapter, or session lock', () => {
		for (const path of IMPLEMENTATION) {
			const source = readFileSync(path, 'utf8');
			expect(source, path).not.toMatch(/from ['"](?:node:)?fs|\.adapter\b|\bfetch\s*\(|requestUrl|SecretStorage|SessionLease|ActiveSession|\.obsidian/u);
		}
	});

	it('does not inspect or mutate the vault during manager construction', () => {
		const source = readFileSync('src/assets/managed-assets.ts', 'utf8');
		const constructor = source.slice(source.indexOf('\tconstructor('), source.indexOf('\n\tasync inspect'));
		expect(constructor).not.toMatch(/\.file\(|\.read\(|\.create\(|\.process\(|trashFile/u);
	});
});
