import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('H5.5 presentation boundary', () => {
	it('keeps the pure builder and Markdown renderer free from I/O and Obsidian', () => {
		for (const file of ['loot-presentation.ts', 'loot-presentation-markdown.ts']) {
			const source = readFileSync(new URL(file, import.meta.url), 'utf8');
			expect(source).not.toMatch(/from\s+['"]obsidian['"]|\bfetch\s*\(|requestUrl|\bVault\b|localStorage|indexedDB|Date\.now/u);
		}
	});

	it('feeds the note managed blocks and Companion adapter from the shared view model', () => {
		const note = readFileSync(new URL('session-note-renderer.ts', import.meta.url), 'utf8');
		const view = readFileSync(new URL('../ui/companion-view.ts', import.meta.url), 'utf8');
		expect(note).toContain('renderLootMarkdown(buildLootPresentation(note))');
		expect(view).toContain('renderLootPresentationView(contentEl, loot)');
	});
});
