import { describe, expect, it } from 'vitest';
import { TFile, type Plugin } from 'obsidian';

import type { TyrianVaultChange } from '../tyrian-host';
import { createObsidianVault } from './obsidian-vault';

type VaultHandler = (file: unknown, oldPath?: string) => void;

function fakePlugin(): { plugin: Plugin; emit: (event: string, file: unknown, oldPath?: string) => void } {
	const handlers = new Map<string, VaultHandler>();
	const vault = {
		on: (event: string, handler: VaultHandler) => { handlers.set(event, handler); return { event }; },
		offref: () => undefined,
	};
	const plugin = { app: { vault }, registerEvent: () => undefined } as unknown as Plugin;
	return { plugin, emit: (event, file, oldPath) => handlers.get(event)?.(file, oldPath) };
}

function fileAt(path: string): TFile {
	return Object.assign(new TFile(), { path });
}

function watched(root: string, paths: string[]): TyrianVaultChange[] {
	const { plugin, emit } = fakePlugin();
	const changes: TyrianVaultChange[] = [];
	createObsidianVault(plugin).onChange(root, (change) => changes.push(change));
	for (const path of paths) emit('modify', fileAt(path));
	return changes;
}

describe('createObsidianVault onChange root filter', () => {
	it('reports files inside the watched folder', () => {
		expect(watched('Tyrian', ['Tyrian/a.md']).map((change) => change.path)).toEqual(['Tyrian/a.md']);
	});

	it('does not report a sibling folder that merely shares the root as a prefix', () => {
		expect(watched('Tyrian', ['Tyrian Old/a.md'])).toEqual([]);
	});

	it('accepts a root written with a trailing slash with the same boundary', () => {
		expect(watched('Tyrian/', ['Tyrian Old/a.md', 'Tyrian/a.md']).map((change) => change.path)).toEqual(['Tyrian/a.md']);
	});

	it('reports everything for the empty root', () => {
		expect(watched('', ['Other/a.md']).map((change) => change.path)).toEqual(['Other/a.md']);
	});

	it('reports a rename that moves a note out of the watched folder', () => {
		const { plugin, emit } = fakePlugin();
		const changes: TyrianVaultChange[] = [];
		createObsidianVault(plugin).onChange('Tyrian', (change) => changes.push(change));
		emit('rename', fileAt('Elsewhere/a.md'), 'Tyrian/a.md');
		expect(changes).toEqual([{ kind: 'rename', path: 'Elsewhere/a.md', oldPath: 'Tyrian/a.md' }]);
	});
});
