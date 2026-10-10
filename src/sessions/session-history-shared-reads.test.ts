import { describe, expect, it, vi } from 'vitest';

import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { LiveSessionHistoryService } from './live-session-history';
import { SessionHistoryService, type SessionHistoryNoteChange, type SessionHistoryVault } from './session-history';

/** A note whose text is exactly this makes the inspection throw: the decoder failing, not the read. */
const THROWS_ON_INSPECTION = vi.hoisted(() => 'the decoder throws on this note');
vi.mock('./live-session-note-renderer', async (original) => {
	const actual = await original<typeof import('./live-session-note-renderer')>();
	return {
		...actual,
		inspectLiveSessionNote: async (content: string) => {
			if (content === THROWS_ON_INSPECTION) throw new Error('decoder broke');
			return await actual.inspectLiveSessionNote(content);
		},
	};
});

/**
 * Z24: a vault of 1.000 notes that are not Tyrian's, on a host that reports every change and a real
 * mtime (Obsidian), counting every `read`. The durable history and the live one are wired the way the
 * runtime wires them: the live one reads through the durable one's shared reads.
 */
function vaultOfOtherNotes(count = 1000, options: { reportsChanges?: boolean; diagnostics?: LocalDebugActionPort } = {}) {
	const notes = new Map<string, string>();
	for (let index = 0; index < count; index += 1) notes.set(`Notas/n${String(index)}.md`, `---\ntitle: x${String(index)}\n---\nbody`);
	const listeners = new Set<(change: SessionHistoryNoteChange) => void>();
	let reads = 0;
	const state = { whileReading: null as ((path: string) => void) | null };
	// Without change events a host gives no mtime either (`sessionHistoryVault`): Hebra.
	const reportsChanges = options.reportsChanges ?? true;
	const vault: SessionHistoryVault = {
		markdownFiles: () => [...notes.keys()].map((path) => reportsChanges ? { path, mtime: 5 } : { path }),
		...(reportsChanges ? {
			onNoteChange: (listener: (change: SessionHistoryNoteChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		} : {}),
		exists: (path) => notes.has(path),
		file: (path) => notes.has(path) ? { path } : null,
		read: async (file) => {
			reads += 1;
			const content = notes.get(file.path) ?? '';
			state.whileReading?.(file.path);
			return content;
		},
		process: async () => undefined,
		createFolder: async () => undefined,
		create: async (path) => ({ path }),
	};
	const durable = new SessionHistoryService(vault, options.diagnostics);
	const live = new LiveSessionHistoryService(vault, undefined, durable.noteReads);
	return {
		durable, live, notes, state, listeners,
		takeReads: () => { const taken = reads; reads = 0; return taken; },
		/** The host reporting that `path` changed (its mtime does not move: only the event says so). */
		changed: (path: string) => { for (const listener of [...listeners]) listener({ path }); },
	};
}

describe('one read of each note per run, shared by the durable and the live history (Z24)', () => {
	it('opening the history, then the live list and the comparator, reads the vault once', async () => {
		const { durable, live, takeReads } = vaultOfOtherNotes();
		await expect(durable.scan('index')).resolves.toMatchObject({ status: 'ok', ignored: 1000 });
		const history = takeReads();
		await expect(live.list()).resolves.toMatchObject({ status: 'ok', ignored: 1000 });
		const list = takeReads();
		await expect(live.loadComparison()).resolves.toMatchObject({ status: 'ok', ignored: 1000 });
		expect({ history, list, comparison: takeReads() }).toEqual({ history: 1000, list: 0, comparison: 0 });
	});

	it('the history and the live list asked at the same time, as the panel does, read each note once', async () => {
		const { durable, live, takeReads } = vaultOfOtherNotes();
		await Promise.all([durable.scan('index'), live.list()]);
		expect(takeReads()).toBe(1000);
	});

	it('a start that looks for an old session without a receipt leaves the history and the live list at 0 reads', async () => {
		const { durable, live, takeReads } = vaultOfOtherNotes();
		await expect(durable.readSession('a'.repeat(64))).resolves.toEqual({ status: 'missing' });
		const start = takeReads();
		await durable.scan('index');
		const history = takeReads();
		await live.list();
		expect({ start, history, list: takeReads() }).toEqual({ start: 1000, history: 0, list: 0 });
	});

	it('a note the host names in a change while the live list reads it is read again by the history', async () => {
		const { durable, live, state, changed, takeReads } = vaultOfOtherNotes(3);
		state.whileReading = (path) => { if (path === 'Notas/n1.md') changed(path); };
		await live.list();
		state.whileReading = null;
		takeReads();
		await durable.scan('index');
		expect(takeReads(), 'only the note changed during the shared read').toBe(1);
	});

	it('a broken Tyrian note outside the output folder still blocks the history when the live list read it first', async () => {
		const { durable, live, notes, takeReads } = vaultOfOtherNotes(3);
		notes.set('Archivo/movida.md', '---\ntc_kind: "gw2_farming_session"\n---\n# Sesión\n');
		await expect(live.list()).resolves.toMatchObject({ status: 'ok', setAside: [{ path: 'Archivo/movida.md', reason: 'unreadable' }] });
		takeReads();
		await expect(durable.scan('index')).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		expect(takeReads()).toBe(0);
	});

	it('a note whose inspection throws still blocks the history, the scan reads the rest, and the failure is logged', async () => {
		const event = vi.fn();
		const { durable, notes, takeReads } = vaultOfOtherNotes(3, { diagnostics: { event } as unknown as LocalDebugActionPort });
		notes.set('Archivo/rota.md', THROWS_ON_INSPECTION);
		await expect(durable.scan('index')).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		expect(takeReads(), 'the other notes are still read').toBe(4);
		expect(event).toHaveBeenCalledOnce();
		expect(event).toHaveBeenCalledWith(expect.objectContaining({
			component: 'vault', action: 'vault_read', state: 'scan', phase: 'failure', level: 'error',
		}));
	});

	it('a read that fails is still an invalid note, and is not logged as a scan failure', async () => {
		const event = vi.fn();
		const { durable, state, takeReads } = vaultOfOtherNotes(3, { diagnostics: { event } as unknown as LocalDebugActionPort });
		state.whileReading = (path) => { if (path === 'Notas/n1.md') throw new Error('disk unavailable'); };
		await expect(durable.scan('index')).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		expect(takeReads()).toBe(3);
		expect(event).not.toHaveBeenCalled();
	});

	it.each(['scan', 'readSession'] as const)('a %s that ends after dispose leaves no subscription behind', async (action) => {
		const { durable, state, listeners } = vaultOfOtherNotes(3);
		state.whileReading = (path) => { if (path === 'Notas/n0.md') durable.dispose(); };
		await (action === 'scan' ? durable.scan('index') : durable.readSession('a'.repeat(64)));
		expect(listeners.size).toBe(0);
	});

	it('a host without change events or mtime shares nothing: each history reads the whole vault every time', async () => {
		const { durable, live, listeners, takeReads } = vaultOfOtherNotes(1000, { reportsChanges: false });
		await durable.readSession('a'.repeat(64));
		const start = takeReads();
		await durable.scan('index');
		const history = takeReads();
		await live.list();
		const list = takeReads();
		await Promise.all([durable.scan('index'), live.loadComparison()]);
		expect({ start, history, list, again: takeReads(), listeners: listeners.size })
			.toEqual({ start: 1000, history: 1000, list: 1000, again: 2000, listeners: 0 });
	});
});
