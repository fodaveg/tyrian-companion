import { describe, expect, it } from 'vitest';

import { readModuleSource } from '../test/module-boundary';

describe('H9.7 durable session history boundary', () => {
	it('keeps aggregation pure, identity-free, and unable to persist or operate on the account', () => {
		const source = readModuleSource('src/sessions/session-history-summary.ts');
		expect(source).not.toMatch(/from\s+['"]obsidian['"]|\bfetch\s*\(|requestUrl|localStorage|indexedDB|GuildWars2Client/u);
		expect(source).not.toMatch(/recommendationAction|recommendationQuantity|recommendationRoute/u);
		expect(source).not.toMatch(/sessionRef\s*:|accountRef\s*:/u);
	});

	it('keeps history off the core surface, with global scans explicit and archival checks exact', () => {
		const panel = readModuleSource('src/ui/session-history-panel.ts');
		const companion = readModuleSource('src/ui/companion-view.ts');
		const main = readModuleSource('src/main.ts');
		expect(panel).toContain("button.addEventListener('click', () => { void controller.load(); })");
		// The panel is mounted by the Companion surface, but only the button may reach the Vault.
		expect(companion).toContain('mountSessionHistoryPanel(');
		expect(companion).not.toMatch(/onOpen\(\)[\s\S]{0,250}loadSessionHistory/u);
		expect(main).toContain('return await this.sessionHistory.scan();');
		expect(main.match(/this\.sessionHistory\.scan\(\)/gu)).toHaveLength(1);
		expect(main).toContain('await this.sessionHistory.readSession(await sha256Text(runtime.state.sessionId))');
		expect(main.match(/this\.sessionHistory\.readSession\(/gu)).toHaveLength(1);
	});

	it('uses local typed ES/EN copy and the required accessible responsive contracts', () => {
		const panel = readModuleSource('src/ui/session-history-panel.ts');
		const styles = readModuleSource('styles.css');
		expect(panel).toContain('} as const;');
		expect(panel).toContain("stateRegion.setAttr('aria-live', 'polite')");
		expect(panel).toContain("header.setAttr('scope', 'col')");
		expect(panel).toContain("ended.setAttr('scope', 'row')");
		expect(styles).toContain('@container (max-width: 479px)');
		expect(styles).toMatch(/\.tyrian-session-history__header button\s*\{\s*min-height:\s*44px;/u);
		expect(styles).not.toMatch(/\.tyrian-session-history[^}]*#[a-f\d]{3,8}/iu);
	});
});
