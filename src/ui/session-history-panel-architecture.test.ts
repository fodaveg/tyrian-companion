import { describe, expect, it } from 'vitest';

import {
	classMethodCallChains, forbiddenBoundaryUses, type ModuleBoundary, propertyCallChains, readModuleSource,
} from '../test/module-boundary';

describe('H9.7 durable session history boundary', () => {
	// Route 1: the panel button's click-to-`controller.load()` wiring, its idle-state
	// `aria-live="polite"` region, and the loaded table's `scope="col"`/`scope="row"` header cells
	// are exercised for real by `session-history-panel.test.ts` ("does no load on mount and keeps
	// the focused action while rendering a ready result").

	it('keeps aggregation pure, identity-free, and unable to persist or operate on the account', () => {
		const boundary: ModuleBoundary = {
			path: 'src/sessions/session-history-summary.ts',
			forbiddenImports: ['obsidian'],
			forbiddenNames: [
				'fetch', 'requestUrl', 'localStorage', 'indexedDB', 'GuildWars2Client',
				'recommendationAction', 'recommendationQuantity', 'recommendationRoute',
				'sessionRef', 'accountRef',
			],
		};
		expect(forbiddenBoundaryUses(readModuleSource(boundary.path), boundary)).toEqual([]);
	});

	it('keeps history off the core surface, with global scans explicit and archival checks exact', () => {
		const companion = readModuleSource('src/ui/companion-view.ts');
		const main = readModuleSource('src/main.ts');
		// The panel is mounted by the Companion surface, but only the button may reach the Vault.
		expect(propertyCallChains(companion)).toContain('mountSessionHistoryPanel');
		expect(classMethodCallChains(companion, 'TyrianCompanionView', 'onOpen')
			.some((chain) => chain.endsWith('loadSessionHistory'))).toBe(false);
		expect(classMethodCallChains(main, 'TyrianCompanionPlugin', 'loadSessionHistory'))
			.toContain('this.sessionHistory.scan');
		expect(propertyCallChains(main).filter((chain) => chain === 'this.sessionHistory.scan')).toHaveLength(1);
		expect(classMethodCallChains(main, 'TyrianCompanionPlugin', 'inspectCompletedSessionSummary'))
			.toContain('this.sessionHistory.readSession');
		expect(propertyCallChains(main).filter((chain) => chain === 'this.sessionHistory.readSession')).toHaveLength(1);
	});

	it('uses local typed ES/EN copy and the required accessible responsive contracts', () => {
		const panel = readModuleSource('src/ui/session-history-panel.ts');
		const styles = readModuleSource('styles.css');
		expect(panel).toContain('} as const;');
		expect(styles).toContain('@container (max-width: 479px)');
		expect(styles).toMatch(/\.tyrian-session-history__header button\s*\{\s*min-height:\s*44px;/u);
		expect(styles).not.toMatch(/\.tyrian-session-history[^}]*#[a-f\d]{3,8}/iu);
	});
});
