import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const NOTE_FILES = [
	'src/sessions/session-note-model.ts',
	'src/sessions/session-note-renderer.ts',
	'src/sessions/session-note-writer.ts',
] as const;

describe('session note architecture boundary', () => {
	it.each(NOTE_FILES)('%s has no network, secret, execution or direct filesystem capability', (path) => {
		const source = readFileSync(path, 'utf8');
		expect(source).not.toMatch(/from\s+['"](?:node:fs|obsidian)['"]|requestUrl|\bfetch\s*\(|SecretStorage|Authorization|placeOrder|buyOrder|sellOrder|executeOrder/u);
	});

	it('writes the completed note before clearing runtime', () => {
		const source = readFileSync('src/main.ts', 'utf8');
		const method = source.slice(source.indexOf('private async performClearCompletedSession'), source.indexOf('private refreshSessionRibbon'));
		expect(method).toContain('writeSessionNoteBeforeClear');
		expect(method).toContain('() => this.sessions.resetCompletedSession()');
		expect(method.indexOf('writeSessionNoteBeforeClear')).toBeLessThan(method.indexOf('resetCompletedSession'));
	});
});
