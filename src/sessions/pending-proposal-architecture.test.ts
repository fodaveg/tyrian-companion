import { describe, expect, it } from 'vitest';

import { readModuleSource } from '../test/module-boundary';

const BACKGROUND_FILES = [
	'src/sessions/pending-proposal-model.ts',
	'src/sessions/pending-proposal-service.ts',
	'src/sessions/pending-proposal-store.ts',
] as const;

describe('pending confirmation background boundary', () => {
	it.each(BACKGROUND_FILES)('%s cannot import UI or side-effect surfaces', (path) => {
		const source = readModuleSource(path);
		expect(source).not.toMatch(/from\s+['"]obsidian['"]|\b(?:Notice|Notification|Modal)\b|\.focus\s*\(|revealLeaf\s*\(|requestUrl\s*\(|fetch\s*\(/u);
	});

	it('routes detector background changes through the in-place status port', () => {
		const source = readModuleSource('src/main.ts');
		const composition = readModuleSource('src/runtime/assemble-sessions.ts');
		// The detector's state change is an in-place status refresh, never a repaint: the
		// composition forwards it untouched and the plugin answers with the status port.
		expect(source).toContain('onDetectionStateChange: () => this.refreshBackgroundIndicators()');
		expect(composition).toMatch(/new AssistedDetectionService\(\{[\s\S]*onStateChange: input\.onDetectionStateChange/u);
		expect(composition).not.toContain('renderViews');

		const view = readModuleSource('src/ui/companion-view.ts');
		const refresh = view.slice(view.indexOf('refreshBackgroundStatus(): void'), view.indexOf('private projectStatus'));
		expect(refresh).toContain('this.refreshDynamicStatus()');
		expect(refresh).not.toMatch(/\.render\s*\(|contentEl\.empty/u);
	});

	it('keeps ordinary manual workflows independent from pending queue receipts', () => {
		const source = readModuleSource('src/main.ts');
		const stop = source.slice(
			source.indexOf('private async performStopManualSession'),
			source.indexOf('\n\topenManualSessionStart('),
		);
		const start = source.slice(
			source.indexOf('private async startManualSession'),
			source.indexOf('\n\tasync updateSettings('),
		);
		for (const workflow of [stop, start]) {
			expect(workflow).toContain('const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null');
			expect(workflow).toContain('if (intent && pendingClaim)');
			expect(workflow).not.toMatch(/getPendingProposalState|getState\(\)\.next/u);
		}
	});

	it('registers claim renewal timers with plugin unload lifecycle', () => {
		const source = readModuleSource('src/main.ts');
		expect(source).toContain('this.pendingClaimRenewals = sessionServices.pendingClaimRenewals');
		expect(readModuleSource('src/runtime/assemble-sessions.ts'))
			.toContain('new PendingProposalRenewalRegistry({');
		expect(source).toContain('this.pendingClaimRenewals?.dispose()');
		expect(source).toContain('const stopRenewal = this.pendingClaimRenewals.start');
		expect(source).not.toMatch(/window\.setInterval\(\(\) => \{\s*void this\.pendingProposals\.renew/u);
	});
});
