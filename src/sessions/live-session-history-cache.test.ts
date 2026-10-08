import { describe, expect, it } from 'vitest';
import type { SessionHistoryVault } from './session-history';
import { LiveSessionHistoryService } from './live-session-history';

/** A vault of plain notes that counts reads; `mtime` moves only when a note is written. */
function countingVault(withMtime = true) {
	const notes = new Map<string, { content: string; mtime: number }>(); const reads: string[] = []; let clock = 1000;
	const vault: SessionHistoryVault = {
		markdownFiles: () => [...notes].map(([path, note]) => withMtime ? { path, mtime: note.mtime } : { path }),
		exists: (path: string) => notes.has(path), file: (path: string) => notes.has(path) ? { path } : null,
		read: async (file: { path: string }) => { reads.push(file.path); return notes.get(file.path)!.content; },
		createFolder: async () => undefined, create: async (path: string) => ({ path }), process: async () => undefined,
	} as unknown as SessionHistoryVault;
	return { vault, reads, write: (path: string, content: string) => { clock += 1; notes.set(path, { content, mtime: clock }); }, remove: (path: string) => { notes.delete(path); } };
}

describe('live session history reads', () => {
	it('does not reread unchanged notes, rereads a modified one and forgets a deleted one', async () => {
		const v = countingVault(); v.write('a.md', '# a'); v.write('b.md', '# b');
		const service = new LiveSessionHistoryService(v.vault);
		await expect(service.list()).resolves.toMatchObject({ status: 'ok', ignored: 2 });
		expect(v.reads.sort()).toEqual(['a.md', 'b.md']); v.reads.length = 0;
		await service.list(); await service.loadComparison(); expect(v.reads, 'a second and third read touch nothing').toEqual([]);
		v.write('b.md', '# b changed'); await service.list(); expect(v.reads, 'only the modified note is read again').toEqual(['b.md']);
		v.remove('a.md'); v.reads.length = 0; await expect(service.list()).resolves.toMatchObject({ ignored: 1 }); expect(v.reads).toEqual([]);
		v.write('a.md', '# a again'); v.reads.length = 0; await service.list(); expect(v.reads, 'a note that comes back is read').toEqual(['a.md']);
	});
	it('reads every note every time when the host reports no mtime', async () => {
		const v = countingVault(false); v.write('a.md', '# a'); const service = new LiveSessionHistoryService(v.vault);
		await service.list(); await service.list(); expect(v.reads).toEqual(['a.md', 'a.md']);
	});
});
