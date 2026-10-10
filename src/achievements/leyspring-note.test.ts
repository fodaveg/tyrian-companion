import { describe, expect, it } from 'vitest';

import type { AccountAchievementEntry } from '../account/account-achievements';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import type { LeyspringCapture } from './leyspring-capture';
import {
	LeyspringNoteWriter,
	buildLeyspringView,
	type AchievementsVaultFile,
	type AchievementsVaultPort,
} from './leyspring-note';
import { LeyspringAchievementsService } from './leyspring-service';
import { LEYSPRING_MASTERY_ACHIEVEMENT_ID, LEYSPRING_TRACKED_ACHIEVEMENTS } from './leyspring-set';

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const NOTE_PATH = `${ROOT}/Achievements/Leyspring Hollows.md`;
const IDS = LEYSPRING_TRACKED_ACHIEVEMENTS.map((entry) => entry.id);

class MemoryVault implements AchievementsVaultPort {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	writes = 0;
	failCreateWith: Error | null = null;
	file(path: string): AchievementsVaultFile | null { return this.files.has(path) || this.folders.has(path) ? { path } : null; }
	async read(file: AchievementsVaultFile): Promise<string> { return this.files.get(file.path) ?? ''; }
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<AchievementsVaultFile> {
		if (this.failCreateWith) throw this.failCreateWith;
		this.files.set(path, content); this.writes += 1; return { path };
	}
	async process(file: AchievementsVaultFile, update: (content: string) => string): Promise<string> {
		const next = update(this.files.get(file.path) ?? '');
		if (next !== this.files.get(file.path)) { this.files.set(file.path, next); this.writes += 1; }
		return next;
	}
	get note(): string { return this.files.get(NOTE_PATH) ?? ''; }
}

/** `done` ids are finished, `partial` maps an id to `[current, max]`; every other id has no progress. */
function captureWith(options: {
	done?: readonly number[]; partial?: Record<number, readonly [number, number]>;
	mastery?: AccountAchievementEntry | null; locale?: CatalogLocale; accountRef?: string; capturedAt?: string;
	accountName?: string; omitNames?: readonly number[];
} = {}): LeyspringCapture {
	const progress = new Map<number, AccountAchievementEntry>();
	for (const id of options.done ?? []) progress.set(id, entry(id, true, null, null));
	for (const [id, [current, max]] of Object.entries(options.partial ?? {})) progress.set(Number(id), entry(Number(id), false, current, max));
	const mastery = options.mastery === undefined ? entry(LEYSPRING_MASTERY_ACHIEVEMENT_ID, false, (options.done ?? []).length, 36) : options.mastery;
	if (mastery !== null) progress.set(LEYSPRING_MASTERY_ACHIEVEMENT_ID, mastery);
	const names = new Map<number, string>([[LEYSPRING_MASTERY_ACHIEVEMENT_ID, 'Leyspring Hollows Mastery']]);
	for (const id of IDS) if (!(options.omitNames ?? []).includes(id)) names.set(id, `Achievement ${String(id)}`);
	return {
		capturedAt: options.capturedAt ?? '2026-10-10T08:40:12.000Z',
		locale: options.locale ?? 'es',
		accountName: options.accountName ?? 'Tester.1234',
		accountRef: options.accountRef ?? 'a'.repeat(24),
		progress, names, thresholds: new Map([[LEYSPRING_MASTERY_ACHIEVEMENT_ID, 36]]),
	};
}
function entry(id: number, done: boolean, current: number | null, max: number | null): AccountAchievementEntry {
	return { id, done, current, max, repeated: null, bits: null };
}
function writer(vault: MemoryVault): LeyspringNoteWriter { return new LeyspringNoteWriter(vault, CONFIG_DIR); }

describe('Leyspring achievements note', () => {
	it('creates the note with pending achievements first, done ones after, in the checklist order', async () => {
		const vault = new MemoryVault();
		const done = [IDS[0]!, IDS[5]!, IDS[45]!];
		const result = await writer(vault).write(ROOT, captureWith({ done, partial: { [IDS[2]!]: [6, 13] } }));
		expect(result).toMatchObject({ status: 'created', path: NOTE_PATH, summary: { done: 3, total: 46 } });
		const lines = vault.note.split('\n').filter((line) => line.startsWith('- ['));
		expect(lines).toHaveLength(46);
		const firstDone = lines.findIndex((line) => line.startsWith('- [x]'));
		expect(lines.slice(0, firstDone).every((line) => line.startsWith('- [ ]'))).toBe(true);
		expect(lines.slice(firstDone).every((line) => line.startsWith('- [x]'))).toBe(true);
		expect(lines).toHaveLength(firstDone + 3);
		expect(lines.slice(firstDone).map((line) => line.match(/achievement(\d+)\)/u)?.[1])).toEqual(done.map(String));
		expect(vault.folders.has(`${ROOT}/Achievements`)).toBe(true);
	});

	it('writes one literal example: counts, account, read date, half-done progress and the wiki links', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({
			done: IDS.slice(0, 22), partial: { [IDS[22]!]: [6, 13] }, mastery: entry(LEYSPRING_MASTERY_ACHIEVEMENT_ID, false, 22, 36),
		}));
		const note = vault.note;
		expect(note).toContain('tc_account: Tester.1234');
		expect(note).toContain('- Cuenta: Tester.1234');
		expect(note).toContain('- Última lectura: 2026-10-10 08:40 UTC');
		expect(note).toContain('- Logros de la lista: 22 de 46');
		expect(note).toContain('- Maestría (Leyspring Hollows Mastery): 22/36');
		expect(note).toContain('## Pendientes (24)');
		expect(note).toContain('## Hechos (22)');
		expect(note).toContain(`- [ ] [Achievement ${String(IDS[22])}](https://wiki.guildwars2.com/wiki/Leyspring_Hollows_%28achievements%29#achievement${String(IDS[22])}) · 6/13`);
		expect(note).toContain(`- [x] [Achievement ${String(IDS[0])}](https://wiki.guildwars2.com/wiki/Castoran_Culture#achievement${String(IDS[0])})`);
		expect(note).not.toContain('- [x] [Achievement 9368](https://wiki.guildwars2.com/wiki/Castoran_Culture#achievement9368) ·');
	});

	it('counts the list and the mastery apart: 22 of 46 on the list, 30/36 from the game', async () => {
		const view = buildLeyspringView(captureWith({
			done: IDS.slice(0, 22), mastery: entry(LEYSPRING_MASTERY_ACHIEVEMENT_ID, false, 30, 36),
		}));
		expect(view.summary).toMatchObject({ done: 22, total: 46, masteryCurrent: 30, masteryMax: 36 });
	});

	it('says "sin dato" for a mastery the account has no entry for, never 0', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: IDS.slice(0, 3), mastery: null }));
		expect(vault.note).toContain('- Maestría (Leyspring Hollows Mastery): sin dato');
		expect(vault.note).toContain('tc_mastery_current: null');
		expect(vault.note).not.toMatch(/Maestría \(.*\): 0/u);
	});

	it('writes the English texts in an English plugin', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: IDS.slice(0, 2), locale: 'en', mastery: null }));
		for (const text of ['- Account: Tester.1234', '- Last read: 2026-10-10 08:40 UTC', '- Achievements on the list: 2 of 46',
			'- Mastery (Leyspring Hollows Mastery): no data', '## Pending (44)', '## Done (2)']) {
			expect(vault.note).toContain(text);
		}
		expect(vault.note).not.toContain('Pendientes');
	});

	it('falls back to the id when the catalog gave no name', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ omitNames: [IDS[0]!] }));
		expect(vault.note).toContain(`- [ ] [Logro ${String(IDS[0])}](`);
	});

	it('a second pass with the same data rewrites only the date', async () => {
		const vault = new MemoryVault();
		const first = captureWith({ done: IDS.slice(0, 5), capturedAt: '2026-10-10T08:40:12.000Z' });
		await writer(vault).write(ROOT, first);
		const before = vault.note;
		const result = await writer(vault).write(ROOT, captureWith({ done: IDS.slice(0, 5), capturedAt: '2026-10-11T09:15:00.000Z' }));
		expect(result.status).toBe('updated');
		const changed = vault.note.split('\n').filter((line, index) => line !== before.split('\n')[index]);
		expect(changed.every((line) => /tc_captured_at|Última lectura|hash=/u.test(line))).toBe(true);
		expect(changed.length).toBeGreaterThan(0);
	});

	it('an identical reading changes nothing and does not write', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: IDS.slice(0, 5) }));
		const writes = vault.writes;
		const result = await writer(vault).write(ROOT, captureWith({ done: IDS.slice(0, 5) }));
		expect(result.status).toBe('unchanged');
		expect(vault.writes).toBe(writes);
	});

	it('a box ticked or unticked by hand goes back to what the API says', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!] }));
		vault.files.set(NOTE_PATH, vault.note
			.replace(`- [ ] [Achievement ${String(IDS[1])}]`, `- [x] [Achievement ${String(IDS[1])}]`)
			.replace(`- [x] [Achievement ${String(IDS[0])}]`, `- [ ] [Achievement ${String(IDS[0])}]`));
		const result = await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!] }));
		expect(result.status).toBe('updated');
		expect(vault.note).toContain(`- [ ] [Achievement ${String(IDS[1])}]`);
		expect(vault.note).toContain(`- [x] [Achievement ${String(IDS[0])}]`);
	});

	it('an API change moves the line between sections and unticks what is no longer done', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!, IDS[1]!] }));
		await writer(vault).write(ROOT, captureWith({ done: [IDS[1]!], capturedAt: '2026-10-11T00:00:00.000Z' }));
		expect(vault.note).toContain(`- [ ] [Achievement ${String(IDS[0])}]`);
		expect(vault.note).toContain(`- [x] [Achievement ${String(IDS[1])}]`);
		expect(vault.note).toContain('## Hechos (1)');
	});

	it('keeps the text outside the block and the user frontmatter keys byte for byte', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!] }));
		const userFrontmatter = 'tags:\n  - gw2\n  - "leyspring"   # mine\nstatus: "en curso"\n# nota suelta';
		const prefix = 'Mis apuntes antes del bloque.\n\n';
		const suffix = '\nMis apuntes después.\n\n- [ ] algo mío\n';
		const created = vault.note;
		vault.files.set(NOTE_PATH, created
			.replace('\n---\n', `\n${userFrontmatter}\n---\n${prefix}`)
			.concat(suffix.slice(1) === '' ? '' : suffix));
		const result = await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!, IDS[1]!], capturedAt: '2026-10-11T00:00:00.000Z' }));
		expect(result.status).toBe('updated');
		const note = vault.note;
		expect(note).toContain(`\n${userFrontmatter}\n---\n${prefix}<!-- tyrian-companion-achievements`);
		expect(note.endsWith(`<!-- /tyrian-companion-achievements -->\n${suffix}`)).toBe(true);
		expect(note).toContain('## Hechos (2)');
	});

	it('refuses to write when the user typed inside the managed block', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!] }));
		vault.files.set(NOTE_PATH, vault.note.replace('## Hechos (1)', '## Hechos (1)\n\nmi comentario'));
		const edited = vault.note;
		const writes = vault.writes;
		const result = await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!, IDS[1]!], capturedAt: '2026-10-11T00:00:00.000Z' }));
		expect(result).toMatchObject({ status: 'conflict', reason: 'edited_block' });
		expect(vault.note).toBe(edited);
		expect(vault.writes).toBe(writes);
	});

	it('treats a lost closing marker or a mangled frontmatter as an edit and writes nothing', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!] }));
		const original = vault.note;
		for (const damaged of [
			original.replace('<!-- /tyrian-companion-achievements -->', ''),
			original.replace('tc_account_ref:', 'tc_account_ref: [unclosed\ntc_x:'),
			original.replace(/^---\n/u, ''),
		]) {
			vault.files.set(NOTE_PATH, damaged);
			const result = await writer(vault).write(ROOT, captureWith({ capturedAt: '2026-10-11T00:00:00.000Z' }));
			expect(result).toMatchObject({ status: 'conflict', reason: 'edited_block' });
			expect(vault.note).toBe(damaged);
		}
	});

	it('does not touch a note that belongs to another account', async () => {
		const vault = new MemoryVault();
		await writer(vault).write(ROOT, captureWith({ done: [IDS[0]!], accountRef: 'b'.repeat(24), accountName: 'Otra.5678' }));
		const before = vault.note;
		const result = await writer(vault).write(ROOT, captureWith({ done: IDS.slice(0, 9), capturedAt: '2026-10-11T00:00:00.000Z' }));
		expect(result).toMatchObject({ status: 'conflict', reason: 'other_account' });
		expect(vault.note).toBe(before);
	});

	it('does not touch a file at the path that is not the plugin\'s note', async () => {
		const vault = new MemoryVault();
		vault.files.set(NOTE_PATH, '# Mi lista a mano\n\n- [x] algo\n');
		const result = await writer(vault).write(ROOT, captureWith());
		expect(result).toMatchObject({ status: 'conflict', reason: 'foreign_note' });
		expect(vault.note).toBe('# Mi lista a mano\n\n- [x] algo\n');
	});

	it('refuses an output folder inside the configuration folder', async () => {
		const vault = new MemoryVault();
		expect(await writer(vault).write(CONFIG_DIR, captureWith())).toEqual({ status: 'invalid_root' });
		expect(vault.files.size).toBe(0);
	});

	it('reports a storage failure when the note cannot be created', async () => {
		const vault = new MemoryVault();
		vault.failCreateWith = new TypeError('EACCES');
		expect(await writer(vault).write(ROOT, captureWith())).toEqual({ status: 'storage_failure', errorName: 'TypeError' });
	});

	it('escapes brackets and line breaks of a name so it stays one link', async () => {
		const vault = new MemoryVault();
		const capture = captureWith();
		(capture.names as Map<number, string>).set(IDS[0]!, 'Odd [name]\nwith \\ break');
		await writer(vault).write(ROOT, capture);
		expect(vault.note).toContain(`- [ ] [Odd \\[name\\] with \\\\ break](https://wiki.guildwars2.com/wiki/Castoran_Culture#achievement${String(IDS[0])})`);
	});
});

describe('LeyspringAchievementsService', () => {
	const okCapture = { capture: async () => ({ status: 'ok' as const, capture: captureWith({ done: IDS.slice(0, 22) }) }) };

	it('keeps the last note, and unticks nothing, when the reading is unavailable', async () => {
		const vault = new MemoryVault();
		await new LeyspringAchievementsService(okCapture, writer(vault)).run(ROOT, 'es');
		const before = vault.note;
		const writes = vault.writes;
		for (const reason of ['missing_scope', 'request_failed', 'invalid_response', 'missing_key'] as const) {
			const failing = { capture: async () => ({ status: 'unavailable' as const, reason }) };
			expect(await new LeyspringAchievementsService(failing, writer(vault)).run(ROOT, 'es')).toEqual({ status: 'unavailable', reason });
		}
		expect(vault.note).toBe(before);
		expect(vault.note).toContain('## Hechos (22)');
		expect(vault.writes).toBe(writes);
	});

	it('answers busy while a run is in flight', async () => {
		const vault = new MemoryVault();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const slow = { capture: async () => { await gate; return { status: 'ok' as const, capture: captureWith() }; } };
		const service = new LeyspringAchievementsService(slow, writer(vault));
		const first = service.run(ROOT, 'es');
		expect(await service.run(ROOT, 'es')).toEqual({ status: 'busy' });
		release();
		expect((await first).status).toBe('created');
	});
});
