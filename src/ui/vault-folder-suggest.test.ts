import { describe, expect, it } from 'vitest';

import { matchVaultFolders } from './vault-folder-suggest';

describe('matchVaultFolders', () => {
	const folders = [
		'02 - Áreas/Guild Wars 2/Tyrian Companion',
		'02 - Áreas/Guild Wars 2/Tyrian Companion/Inventory',
		'02 - Áreas/Notas',
		'Tyrian Companion',
		'',
	];

	it('matches case-insensitively against accented, multi-segment folder names', () => {
		expect(matchVaultFolders(folders, 'guild wars 2')).toEqual([
			'02 - Áreas/Guild Wars 2/Tyrian Companion',
			'02 - Áreas/Guild Wars 2/Tyrian Companion/Inventory',
		]);
	});

	it('returns every folder, sorted, for an empty query', () => {
		expect(matchVaultFolders(folders, '')).toEqual([
			'', '02 - Áreas/Guild Wars 2/Tyrian Companion', '02 - Áreas/Guild Wars 2/Tyrian Companion/Inventory',
			'02 - Áreas/Notas', 'Tyrian Companion',
		]);
	});

	it('caps the result to the given limit', () => {
		expect(matchVaultFolders(folders, '', 2)).toEqual(['', '02 - Áreas/Guild Wars 2/Tyrian Companion']);
	});

	it('returns nothing for a query that matches no folder', () => {
		expect(matchVaultFolders(folders, 'does-not-exist')).toEqual([]);
	});
});
