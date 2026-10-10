import { describe, expect, it } from 'vitest';

import {
	classMethodBody, classMethodCallChains, forbiddenBoundaryUses, type ModuleBoundary, readModuleSource,
} from '../test/module-boundary';

// Source-text half of `companion-status-model.test.ts` (GR-04): these two tests read module source
// as text, so they live in the frozen allowlist and run only under `vitest.guardrails.config.mts`.
// The projection behaviour stays in `companion-status-model.test.ts`, which `check` runs.
describe('status projection boundary', () => {
	it('has no live Obsidian, network, timer, or storage dependency', () => {
		const boundary: ModuleBoundary = {
			path: 'src/ui/companion-status-model.ts',
			forbiddenImports: ['obsidian'],
			forbiddenNames: ['requestUrl', 'fetch', 'setInterval', 'localStorage', 'indexedDB'],
		};
		expect(forbiddenBoundaryUses(readModuleSource(boundary.path), boundary)).toEqual([]);
	});

	it('prevents timer ticks from rebuilding the view and stealing focus', () => {
		const source = readModuleSource('src/ui/companion-view.ts');
		const schedule = classMethodCallChains(source, 'TyrianCompanionView', 'scheduleRefresh');
		expect(schedule).not.toContain('this.render');
		expect(schedule).toContain('this.contentEl.win.setInterval');
		expect(schedule).toContain('this.refreshDynamicStatus');
		const refresh = classMethodBody(source, 'TyrianCompanionView', 'refreshDynamicStatus');
		expect(refresh).toContain('this.checkButton.disabled');
		// Lote M/N (9 sep 2026): the incident line became the card's single callout, rebuilt in its
		// own retained slot instead of a full card rebuild — same in-place-repaint property, new node.
		expect(refresh).toContain('renderSessionCardCallout(this.calloutSlot');
	});
});
