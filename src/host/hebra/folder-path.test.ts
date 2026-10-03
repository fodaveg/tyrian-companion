import { describe, expect, it } from 'vitest';

import { createFakeLibrary } from '../../test/hebra-plugin-fakes';
import { ensureFolderPath, folderRelativePaths, folderSegmentsOf, libraryFolderPaths, resolveFolderPath } from './folder-path';

// Ported from Hebra's `src/lib/modules/tyrian/folder-path.test.ts`, over `api.vault` folders.
// `isFolderUnderRoot` is not ported: nothing but its own test used it in Hebra.

describe('folderSegmentsOf', () => {
	it('drops the last part (the file name) and keeps the rest', () => {
		expect(folderSegmentsOf('Inventory/Positions/abc.md')).toEqual(['Inventory', 'Positions']);
		expect(folderSegmentsOf('abc.md')).toEqual([]);
	});
});

describe('ensureFolderPath', () => {
	it('without segments returns the root itself and creates nothing', async () => {
		const library = createFakeLibrary();
		expect(await ensureFolderPath(library, 'root', [])).toBe('root');
		expect(library.folders).toEqual([]);
	});

	it('creates the missing chain of folders under the root', async () => {
		const library = createFakeLibrary();
		const id = await ensureFolderPath(library, 'root', ['Inventory', 'Positions']);
		expect(library.folders.map((folder) => folder.name)).toEqual(['Inventory', 'Positions']);
		const positions = library.folders.find((folder) => folder.name === 'Positions');
		expect(id).toBe(positions?.id);
		expect(positions?.parentId).toBe(library.folders.find((folder) => folder.name === 'Inventory')?.id);
	});

	it('reuses an existing folder by name, case-insensitively, instead of duplicating it', async () => {
		const library = createFakeLibrary();
		library.addFolder('existing', 'root', 'Inventory');
		await ensureFolderPath(library, 'root', ['inventory', 'Positions']);
		const created = library.folders.filter((folder) => folder.name === 'Positions');
		expect(created).toHaveLength(1);
		expect(created[0]?.parentId).toBe('existing');
		expect(library.folders.filter((folder) => folder.parentId === 'root')).toHaveLength(1);
	});

	it('called twice with the same path creates no duplicate folders', async () => {
		const library = createFakeLibrary();
		const first = await ensureFolderPath(library, 'root', ['Inventory', 'Positions']);
		expect(await ensureFolderPath(library, 'root', ['Inventory', 'Positions'])).toBe(first);
		expect(library.folders).toHaveLength(2);
	});
});

describe('resolveFolderPath, folderRelativePaths and libraryFolderPaths', () => {
	const library = createFakeLibrary();
	library.addFolder('games', 'root', 'Games');
	library.addFolder('gw2', 'games', 'GW2');
	library.addFolder('tyrian', 'gw2', 'Tyrian');
	library.addFolder('inventory', 'tyrian', 'Inventory');
	library.addFolder('loose', null, 'Loose');

	it('finds a nested output folder from the library root without creating anything', () => {
		expect(resolveFolderPath(library.folders, 'root', 'Games/GW2/Tyrian')).toBe('tyrian');
		expect(resolveFolderPath(library.folders, 'root', 'games/gw2/tyrian')).toBe('tyrian');
		// A first-level folder without a parent counts as under the root.
		expect(resolveFolderPath(library.folders, 'root', 'Loose')).toBe('loose');
		expect(resolveFolderPath(library.folders, 'root', 'Games/Missing')).toBeNull();
		expect(resolveFolderPath(library.folders, 'root', '')).toBeNull();
	});

	it('gives every folder its path relative to the output folder, and every library folder its path from the root', () => {
		expect([...folderRelativePaths(library.folders, 'tyrian')]).toEqual([['inventory', 'Inventory']]);
		expect(libraryFolderPaths(library.folders, 'root')).toEqual(['Games', 'Games/GW2', 'Games/GW2/Tyrian', 'Games/GW2/Tyrian/Inventory', 'Loose']);
	});
});
