import { describe, expect, it } from 'vitest';

import { classMethodBody, forbiddenBoundaryUses, type ModuleBoundary, readModuleSource } from '../test/module-boundary';

const BACKGROUND_FILES = [
	'src/sessions/pending-proposal-model.ts',
	'src/sessions/pending-proposal-service.ts',
	'src/sessions/pending-proposal-store.ts',
] as const;

describe('pending confirmation background boundary', () => {
	// Route 1: `companion-view.test.ts`'s pending-confirmation coverage already calls the real
	// `refreshBackgroundStatus()` (via `TyrianCompanionView.prototype`) and observes the pending
	// section's buttons and focus survive untouched, which is exactly "an in-place refresh, not a
	// repaint" observed from the outside instead of asserted over the method's characters.

	it.each(BACKGROUND_FILES)('%s cannot import UI or side-effect surfaces', (path) => {
		const boundary: ModuleBoundary = {
			path,
			forbiddenImports: ['obsidian'],
			forbiddenNames: ['Notice', 'Notification', 'Modal', 'focus', 'revealLeaf', 'requestUrl', 'fetch'],
		};
		expect(forbiddenBoundaryUses(readModuleSource(path), boundary)).toEqual([]);
	});

	it('routes detector background changes through the in-place status port', () => {
		const source = readModuleSource('src/main.ts');
		const composition = readModuleSource('src/runtime/assemble-sessions.ts');
		// The detector's state change is an in-place status refresh, never a repaint: the
		// composition forwards it untouched and the plugin answers with the status port.
		expect(classMethodBody(source, 'TyrianCompanionPlugin', 'initializeRuntime'))
			.toContain('onDetectionStateChange: () => this.refreshBackgroundIndicators()');
		expect(composition).toMatch(/new AssistedDetectionService\(\{[\s\S]*onStateChange: input\.onDetectionStateChange/u);
		expect(composition).not.toContain('renderViews');

		const view = readModuleSource('src/ui/companion-view.ts');
		const refresh = classMethodBody(view, 'TyrianCompanionView', 'refreshBackgroundStatus');
		expect(refresh).toContain('this.refreshDynamicStatus()');
		expect(refresh).not.toMatch(/\.render\s*\(|contentEl\.empty/u);
	});

	it('keeps ordinary manual workflows independent from pending queue receipts', () => {
		const source = readModuleSource('src/main.ts');
		const stop = classMethodBody(source, 'TyrianCompanionPlugin', 'performStopManualSession');
		const start = classMethodBody(source, 'TyrianCompanionPlugin', 'startManualSession');
		for (const workflow of [stop, start]) {
			expect(workflow).toContain('const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null');
			expect(workflow).toContain('if (intent && pendingClaim)');
			expect(workflow).not.toMatch(/getPendingProposalState|getState\(\)\.next/u);
		}
	});

	it('registers claim renewal timers with plugin unload lifecycle', () => {
		const source = readModuleSource('src/main.ts');
		expect(classMethodBody(source, 'TyrianCompanionPlugin', 'initializeRuntime'))
			.toContain('this.pendingClaimRenewals = sessionServices.pendingClaimRenewals');
		expect(readModuleSource('src/runtime/assemble-sessions.ts'))
			.toContain('new PendingProposalRenewalRegistry({');
		expect(classMethodBody(source, 'TyrianCompanionPlugin', 'shutdownRuntime'))
			.toContain('this.pendingClaimRenewals?.dispose()');
		expect(classMethodBody(source, 'TyrianCompanionPlugin', 'acquirePendingIntent'))
			.toContain('const stopRenewal = this.pendingClaimRenewals.start');
		expect(source).not.toMatch(/window\.setInterval\(\(\) => \{\s*void this\.pendingProposals\.renew/u);
	});
});
