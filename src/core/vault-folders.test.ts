import { describe, expect, it } from 'vitest';

import { ensureFoldersBySegments, ensureFoldersFromPrefixes, type FolderCreatingVault } from './vault-folders';

// Bodies of the four pre-extraction copies, verbatim except for the error message, which the
// extraction turned into a parameter. The prefix form was in the inventory and wallet vault syncs;
// the segment form in managed assets and the pilot metrics export.
async function legacyPrefixes(vault: FolderCreatingVault, path: string, message: string): Promise<void> {
	const segments = path.split('/');
	for (let index = 1; index <= segments.length; index += 1) {
		const folder = segments.slice(0, index).join('/');
		if (vault.file(folder)) continue;
		try { await vault.createFolder(folder); }
		catch { if (!vault.file(folder)) throw new Error(message); }
	}
}

async function legacySegmentsManagedAssets(vault: FolderCreatingVault, folder: string, message: string): Promise<void> {
	let current = '';
	for (const segment of folder.split('/')) {
		current = current ? `${current}/${segment}` : segment;
		if (!vault.file(current)) {
			try { await vault.createFolder(current); }
			catch { if (!vault.file(current)) throw new Error(message); }
		}
	}
}

async function legacySegmentsPilotExport(vault: FolderCreatingVault, path: string, message: string): Promise<void> {
	let current = '';
	for (const segment of path.split('/')) {
		current = current.length === 0 ? segment : `${current}/${segment}`;
		if (!vault.file(current)) {
			try { await vault.createFolder(current); }
			catch { if (!vault.file(current)) throw new Error(message); }
		}
	}
}

// Body of the session note writer's copy, verbatim except for the error message.
async function legacySegmentsSessionNoteWriter(vault: FolderCreatingVault, folder: string, message: string): Promise<void> {
	let current = '';
	for (const segment of folder.split('/')) {
		current = current ? `${current}/${segment}` : segment;
		if (!vault.file(current)) {
			try { await vault.createFolder(current); }
			catch { if (!vault.file(current)) throw new Error(message); }
		}
	}
}

type Behavior = 'creates' | 'rejects_but_appears' | 'rejects';

interface Trace { calls: string[]; error: string | null }

function fakeVault(existing: readonly string[], behavior: Behavior, calls: string[]): FolderCreatingVault {
	const present = new Set(existing);
	return {
		file(path) { calls.push(`file:${path}`); return present.has(path) ? { path } : null; },
		async createFolder(path) {
			calls.push(`create:${path}`);
			if (behavior === 'creates') present.add(path);
			else if (behavior === 'rejects_but_appears') { present.add(path); throw new Error('boom'); }
			else throw new Error('boom');
		},
	};
}

async function trace(
	run: (vault: FolderCreatingVault, path: string, message: string) => Promise<void>,
	path: string,
	existing: readonly string[],
	behavior: Behavior,
): Promise<Trace> {
	const calls: string[] = [];
	try { await run(fakeVault(existing, behavior, calls), path, 'unavailable'); return { calls, error: null }; }
	catch (error) { return { calls, error: error instanceof Error ? error.message : String(error) }; }
}

const PATHS = ['a', 'a/b/c', 'a/b/c/', '', '/a', '/a/b', 'a//b', '//a'];
const EXISTING: ReadonlyArray<readonly string[]> = [[], ['a'], ['a', 'a/b'], ['a', 'a/b', 'a/b/c']];
const BEHAVIORS: Behavior[] = ['creates', 'rejects_but_appears', 'rejects'];

describe('ensureFoldersFromPrefixes', () => {
	it('creates the missing ancestors shortest first and skips the existing ones', async () => {
		const result = await trace(ensureFoldersFromPrefixes, 'a/b/c', ['a'], 'creates');
		expect(result).toEqual({
			calls: ['file:a', 'file:a/b', 'create:a/b', 'file:a/b/c', 'create:a/b/c'],
			error: null,
		});
	});

	it('tolerates a failed create when the folder exists afterwards and throws the given message otherwise', async () => {
		expect((await trace(ensureFoldersFromPrefixes, 'a/b', [], 'rejects_but_appears')).error).toBeNull();
		expect((await trace(ensureFoldersFromPrefixes, 'a/b', [], 'rejects')).error).toBe('unavailable');
	});

	it('behaves exactly like the legacy body for every path, vault state and failure mode', async () => {
		for (const path of PATHS) for (const existing of EXISTING) for (const behavior of BEHAVIORS) {
			expect(await trace(ensureFoldersFromPrefixes, path, existing, behavior), `${path} ${existing.join(',')} ${behavior}`)
				.toEqual(await trace(legacyPrefixes, path, existing, behavior));
		}
	});
});

describe('ensureFoldersBySegments', () => {
	it('creates the missing ancestors shortest first and skips the existing ones', async () => {
		const result = await trace(ensureFoldersBySegments, 'a/b/c', ['a'], 'creates');
		expect(result).toEqual({
			calls: ['file:a', 'file:a/b', 'create:a/b', 'file:a/b/c', 'create:a/b/c'],
			error: null,
		});
	});

	it('tolerates a failed create when the folder exists afterwards and throws the given message otherwise', async () => {
		expect((await trace(ensureFoldersBySegments, 'a/b', [], 'rejects_but_appears')).error).toBeNull();
		expect((await trace(ensureFoldersBySegments, 'a/b', [], 'rejects')).error).toBe('unavailable');
	});

	it('behaves exactly like the three legacy bodies for every path, vault state and failure mode', async () => {
		for (const path of PATHS) for (const existing of EXISTING) for (const behavior of BEHAVIORS) {
			const actual = await trace(ensureFoldersBySegments, path, existing, behavior);
			const label = `${path} ${existing.join(',')} ${behavior}`;
			expect(actual, label).toEqual(await trace(legacySegmentsManagedAssets, path, existing, behavior));
			expect(actual, label).toEqual(await trace(legacySegmentsPilotExport, path, existing, behavior));
			expect(actual, label).toEqual(await trace(legacySegmentsSessionNoteWriter, path, existing, behavior));
		}
	});
});

describe('the two forms', () => {
	it('differ only for a leading empty segment, which is why they stay two helpers', async () => {
		for (const path of ['a', 'a/b/c', 'a//b', 'a/']) {
			expect(await trace(ensureFoldersFromPrefixes, path, [], 'creates')).toEqual(await trace(ensureFoldersBySegments, path, [], 'creates'));
		}
		expect((await trace(ensureFoldersFromPrefixes, '/a', [], 'creates')).calls).toContain('create:/a');
		expect((await trace(ensureFoldersBySegments, '/a', [], 'creates')).calls).not.toContain('create:/a');
	});
});
