import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('H9.7 durable session history boundary', () => {
	it('keeps aggregation pure, identity-free, and unable to persist or operate on the account', () => {
		const source = readFileSync(new URL('../sessions/session-history-summary.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/from\s+['"]obsidian['"]|\bfetch\s*\(|requestUrl|localStorage|indexedDB|GuildWars2Client/u);
		expect(source).not.toMatch(/recommendationAction|recommendationQuantity|recommendationRoute/u);
		expect(source).not.toMatch(/sessionRef\s*:|accountRef\s*:/u);
	});

	it('routes the only scan through the explicit panel action instead of view open or render', () => {
		const panel = readFileSync(new URL('session-history-panel.ts', import.meta.url), 'utf8');
		const companion = readFileSync(new URL('companion-view.ts', import.meta.url), 'utf8');
		const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
		expect(panel).toContain("button.addEventListener('click', () => { void controller.load(); })");
		expect(companion).toContain('mountSessionHistoryPanel(surface, locale, this.sessionHistoryController)');
		expect(companion).not.toMatch(/onOpen\(\)[\s\S]{0,250}loadSessionHistory/u);
		expect(main).toContain('return await this.sessionHistory.scan();');
		expect(main.match(/this\.sessionHistory\.scan\(\)/gu)).toHaveLength(1);
	});

	it('uses local typed ES/EN copy and the required accessible responsive contracts', () => {
		const panel = readFileSync(new URL('session-history-panel.ts', import.meta.url), 'utf8');
		const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
		expect(panel).toContain('} as const;');
		expect(panel).toContain("stateRegion.setAttr('aria-live', 'polite')");
		expect(panel).toContain("header.setAttr('scope', 'col')");
		expect(panel).toContain("ended.setAttr('scope', 'row')");
		expect(styles).toContain('@container (max-width: 479px)');
		expect(styles).toMatch(/\.tyrian-session-history__header button\s*\{\s*min-height:\s*44px;/u);
		expect(styles).not.toMatch(/\.tyrian-session-history[^}]*#[a-f\d]{3,8}/iu);
	});
});
