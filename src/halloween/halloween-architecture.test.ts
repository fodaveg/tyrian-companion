import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('H11-A architecture and UI contract', () => {
	it('keeps the domain/store/runtime free of Obsidian and Vault APIs', () => {
		for (const file of [
			'src/halloween/halloween-model.ts', 'src/halloween/halloween-policy.ts',
			'src/halloween/halloween-store.ts', 'src/halloween/halloween-runtime.ts',
		]) {
			const source = readFileSync(file, 'utf8');
			expect(source).not.toMatch(/from ['"]obsidian['"]|vault\.|TFile|new\s+Notice\(/u);
			expect(source).not.toMatch(/apiKey|Authorization|accountId/u);
		}
	});

	it('keeps Notice in the foreground adapter and provisional wording explicit', () => {
		const runtime = readFileSync('src/halloween/halloween-runtime.ts', 'utf8');
		const main = readFileSync('src/main.ts', 'utf8');
		expect(runtime).toContain("wording: 'observed_change'");
		expect(runtime).not.toContain('new Notice');
		expect(main).toMatch(/onNotice:[\s\S]*new Notice/u);
	});

	it('covers the 7-axis UI checklist without hardcoded assets or colors', () => {
		const panel = readFileSync('src/ui/halloween-alert-panel.ts', 'utf8');
		const styles = readFileSync('styles.css', 'utf8');
		expect(styles).toMatch(/tyrian-companion-halloween[\s\S]*var\(--/u); // tokens
		for (const state of ['disabled', 'learning', 'empty', 'pending', 'unread', 'partial', 'offline', 'backoff', 'store_unavailable']) {
			expect(readFileSync('src/core/i18n-runtime-catalog.ts', 'utf8')).toContain(`halloween.state.${state}`);
		}
		expect(styles).toMatch(/@container \(max-width: 759px\)[\s\S]*@container \(max-width: 479px\)/u); // 760/480/320
		expect(panel).toContain("setAttr('aria-label'");
		expect(panel).toContain("setAttr('aria-live', 'polite')");
		expect(styles).toMatch(/min-block-size:\s*44px/u);
		expect(panel).toContain('unknownItem');
		expect(styles).toContain('overflow-wrap: anywhere');
		expect(panel).toContain('button.disabled = true'); // feedback
		expect(panel).not.toMatch(/<img|createEl\('img'\)|\.svg|\.png/u); // assets N/A
		expect(styles.slice(styles.indexOf('.tyrian-companion-halloween'))).not.toMatch(/#[0-9a-f]{3,8}/iu);
	});

	it('pins settings v8 and canonical session-note v3 evidence', () => {
		expect(readFileSync('src/core/settings.ts', 'utf8')).toContain('SETTINGS_SCHEMA_VERSION = 8');
		expect(readFileSync('src/sessions/session-note-model.ts', 'utf8')).toContain('SESSION_NOTE_SCHEMA_VERSION = 3');
		expect(readFileSync('src/sessions/session-note-renderer.ts', 'utf8')).toContain('tc_positive_item_deltas_json');
	});

	it('wires opt-in note backfill and accepted-session gating into production composition', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		expect(main).toMatch(/loadBackfill:[\s\S]*scanHalloweenSessionNotes/u);
		expect(main).toContain('observeAcceptedHalloweenDelta(delta)');
		expect(main).toContain("`session:${session.sessionId}`");
		expect(main).toContain("`session:${result.state.sessionId}`");
		expect(main).toMatch(/vault\.on\('modify',[\s\S]*refreshHalloweenBackfill/u);
		expect(main).toMatch(/vault\.on\('rename',[\s\S]*refreshHalloweenBackfill/u);
		const store = readFileSync('src/halloween/halloween-store.ts', 'utf8');
		expect(store).toContain('HALLOWEEN_DB_VERSION = 5');
		expect(store).toContain("HALLOWEEN_EPISODE_META_STORE = 'episode-meta-v1'");
		expect(store).toContain("HALLOWEEN_META_STORE = 'meta-v1'");
	});
});
