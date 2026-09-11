import { describe, expect, it } from 'vitest';

import { readModuleSource } from '../test/module-boundary';

describe('H11-A architecture and UI contract', () => {
	it('keeps the domain/store/runtime free of Obsidian and Vault APIs', () => {
		for (const file of [
			'src/halloween/halloween-model.ts', 'src/halloween/halloween-policy.ts',
			'src/halloween/halloween-store.ts', 'src/halloween/halloween-runtime.ts',
		]) {
			const source = readModuleSource(file);
			expect(source).not.toMatch(/from ['"]obsidian['"]|vault\.|TFile|new\s+Notice\(/u);
			expect(source).not.toMatch(/apiKey|Authorization|accountId/u);
		}
	});

	it('keeps Notice in the foreground adapter and provisional wording explicit', () => {
		const runtime = readModuleSource('src/halloween/halloween-runtime.ts');
		const composition = readModuleSource('src/runtime/assemble-halloween.ts');
		const main = readModuleSource('src/main.ts');
		expect(runtime).toContain("wording: 'observed_change'");
		expect(runtime).not.toContain('new Notice');
		expect(composition).not.toContain('new Notice');
		expect(composition).toMatch(/onNotice:[\s\S]*emitPolicyAlert/u);
		expect(main).toContain('new Notice');
	});

	it('covers the 7-axis UI checklist without hardcoded assets or colors', () => {
		const panel = readModuleSource('src/ui/halloween-alert-panel.ts');
		const styles = readModuleSource('styles.css');
		expect(styles).toMatch(/tyrian-companion-halloween[\s\S]*var\(--/u); // tokens
		for (const state of ['disabled', 'learning', 'empty', 'pending', 'unread', 'partial', 'offline', 'backoff', 'store_unavailable']) {
			expect(readModuleSource('src/core/i18n-runtime-catalog.ts')).toContain(`halloween.state.${state}`);
		}
		expect(styles).toMatch(/@container \(max-width: 759px\)[\s\S]*@container \(max-width: 479px\)/u); // 760/480/320
		expect(panel).toContain("setAttr('aria-label'");
		expect(panel).toContain("setAttr('aria-live', 'polite')");
		expect(styles).toMatch(/min-block-size:\s*44px/u);
		expect(panel).toContain('unknownItem');
		expect(styles).toContain('overflow-wrap: anywhere');
		// The "Marcar como revisada" button and its disabled-while-pending feedback are gone (Lote S,
		// 2026-09-09: nobody marks an aviso reviewed anymore, the panel is read-only). The feedback
		// axis is still covered by the aria-live status region asserted above.
		expect(panel).not.toContain('button.disabled = true');
		expect(panel).not.toMatch(/<img|createEl\('img'\)|\.svg|\.png/u); // assets N/A
		expect(styles.slice(styles.indexOf('.tyrian-companion-halloween'))).not.toMatch(/#[0-9a-f]{3,8}/iu);
	});

	it('pins settings v13 and canonical session-note v3 evidence', () => {
		expect(readModuleSource('src/core/settings.ts')).toContain('SETTINGS_SCHEMA_VERSION = 14');
		expect(readModuleSource('src/sessions/session-note-model.ts')).toContain('SESSION_NOTE_SCHEMA_VERSION = 3');
		expect(readModuleSource('src/sessions/session-note-renderer.ts')).toContain('tc_positive_item_deltas_json');
	});

	it('wires opt-in note backfill and accepted-session gating into production composition', () => {
		const main = readModuleSource('src/main.ts');
		expect(readModuleSource('src/runtime/assemble-halloween.ts'))
			.toMatch(/loadBackfill:[\s\S]*scanHalloweenSessionNotes/u);
		expect(main).toContain('observeAcceptedHalloweenDelta(delta)');
		expect(main).toContain("`session:${session.sessionId}`");
		// The session-final episode key moved into `finishFinalizedSession` (Lote S, 2026-09-09: the
		// shared step both a live `stop()` and an auto-finalized `provisional` record go through),
		// which takes the id as its own `sessionId` parameter instead of reading `result.state.sessionId`.
		expect(main).toContain("`session:${sessionId}`");
		expect(main).toMatch(/vault\.on\('modify',[\s\S]*refreshHalloweenBackfill/u);
		expect(main).toMatch(/vault\.on\('rename',[\s\S]*refreshHalloweenBackfill/u);
		const store = readModuleSource('src/halloween/halloween-store.ts');
		expect(store).toContain('HALLOWEEN_DB_VERSION = 7');
		expect(store).toContain("HALLOWEEN_EPISODE_META_STORE = 'episode-meta-v1'");
		expect(store).toContain("HALLOWEEN_META_STORE = 'meta-v1'");
	});
});
