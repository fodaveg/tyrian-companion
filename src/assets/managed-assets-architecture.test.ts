import { describe, expect, it, vi } from 'vitest';

import { ManagedAssetsManager, type ManagedAssetsVault } from './managed-assets';
import { moduleBoundaryFacts, moduleBoundaryViolations, type ModuleBoundary } from '../test/module-boundary';

const IMPLEMENTATION = [
	'src/assets/managed-assets-model.ts',
	'src/assets/managed-assets.ts',
	'src/assets/generic-assets.ts',
	'src/assets/managed-assets-lifecycle.ts',
	'src/assets/managed-assets-pointer.ts',
	'src/assets/managed-assets-ui.ts',
];

const IMPLEMENTATION_BOUNDARIES: ModuleBoundary[] = IMPLEMENTATION.map((path) => ({
	path,
	forbiddenImports: ['fs', 'node:fs'],
	forbiddenNames: ['adapter', 'fetch', 'requestUrl', 'SecretStorage', 'SessionLease', 'ActiveSession'],
}));

describe('managed-assets architecture boundary', () => {
	it('uses only the injected Vault port and contains no network, filesystem adapter, or session lock', () => {
		expect(moduleBoundaryViolations(IMPLEMENTATION_BOUNDARIES)).toEqual([]);
		// Built by concatenation, not as a literal: a literal '.obsidian' string here would itself
		// trip the obsidianmd/hardcoded-config-path lint rule this assertion exists to enforce.
		const hardcodedConfigDirFragment = '.' + 'obsidian';
		for (const path of IMPLEMENTATION) {
			const facts = moduleBoundaryFacts(path);
			const mentions = [...facts.specifiers, ...facts.names];
			expect(mentions.some((value) => value.includes(hardcodedConfigDirFragment)), path).toBe(false);
		}
	});

	// H14.17: exercises the real constructor with a Vault that throws on every method,
	// instead of slicing the constructor's own source text. Any accidental read or
	// mutation added later fails this test by actually running, not by matching a string.
	it('does not inspect or mutate the vault during manager construction', () => {
		const untouchable: ManagedAssetsVault = {
			file: vi.fn(() => { throw new Error('vault touched during construction'); }),
			listFiles: vi.fn(() => { throw new Error('vault touched during construction'); }),
			read: vi.fn(() => { throw new Error('vault touched during construction'); }),
			createFolder: vi.fn(() => { throw new Error('vault touched during construction'); }),
			create: vi.fn(() => { throw new Error('vault touched during construction'); }),
			process: vi.fn(() => { throw new Error('vault touched during construction'); }),
			trashFile: vi.fn(() => { throw new Error('vault touched during construction'); }),
		};
		expect(() => new ManagedAssetsManager(untouchable, '.config', { bundleVersion: 1, locale: 'es', assets: [] }))
			.not.toThrow();
		for (const port of Object.values(untouchable)) expect(port).not.toHaveBeenCalled();
	});
});
