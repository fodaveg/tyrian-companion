import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * The history's link to a session's summary note: the note may have been moved or deleted after
 * the history was read, and opening a path that no longer exists would make the host create an
 * empty note. The core therefore asks the vault first and says so instead of opening.
 */
describe('openSessionHistoryNote (history row link)', () => {
	interface Harness {
		host: { vault: { file(path: string): { path: string } | null }; ui: { openNote(path: string): void } };
		settings: { language: 'en' | 'es' };
		emitNotice(message: string, source: string): void;
	}
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with an explicit isolated harness below.
	const open = (TyrianCompanionCore.prototype as unknown as {
		openSessionHistoryNote(this: Harness, path: string): void;
	}).openSessionHistoryNote;

	const harness = (existing: readonly string[], language: 'en' | 'es' = 'en') => {
		const openNote = vi.fn();
		const emitNotice = vi.fn();
		const self: Harness = {
			host: {
				vault: { file: (path) => existing.includes(path) ? { path } : null },
				ui: { openNote },
			},
			settings: { language },
			emitNotice,
		};
		return { self, openNote, emitNotice };
	};

	it('opens the note when the vault still has it', () => {
		const { self, openNote, emitNotice } = harness(['Sessions/a.md']);
		open.call(self, 'Sessions/a.md');
		expect(openNote).toHaveBeenCalledExactlyOnceWith('Sessions/a.md');
		expect(emitNotice).not.toHaveBeenCalled();
	});

	it('does not open a note that is gone and says so in the player language', () => {
		const en = harness([]);
		open.call(en.self, 'Sessions/a.md');
		expect(en.openNote).not.toHaveBeenCalled();
		expect(en.emitNotice).toHaveBeenCalledExactlyOnceWith(
			'That session note is no longer where it was saved. Refresh the history.', 'session_history_note',
		);
		const es = harness([], 'es');
		open.call(es.self, 'Sessions/a.md');
		expect(es.openNote).not.toHaveBeenCalled();
		expect(es.emitNotice).toHaveBeenCalledExactlyOnceWith(
			'Esa nota de sesión ya no está donde se guardó. Actualiza el historial.', 'session_history_note',
		);
	});
});
