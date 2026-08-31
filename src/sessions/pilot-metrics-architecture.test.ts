import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CORE = [
	'src/sessions/pilot-metrics-model.ts',
	'src/sessions/pilot-metrics-statistics.ts',
	'src/sessions/pilot-metrics-store.ts',
	'src/sessions/pilot-metrics-recorder.ts',
];

describe('pilot metrics architecture', () => {
	it('keeps the journal and aggregation island free of network, secrets, uploaders and Vault writes', () => {
		for (const file of CORE) {
			const source = readFileSync(file, 'utf8');
			expect(source).not.toMatch(/\bfetch\b|requestUrl|XMLHttpRequest|WebSocket|secret-provider|SecretStorage|uploader|telemetry/iu);
			expect(source).not.toMatch(/app\.vault|\.createFolder\(|\.create\(/u);
		}
	});

	it('keeps all Vault writes inside the explicit exporter', () => {
		const source = readFileSync('src/sessions/pilot-metrics-export.ts', 'utf8');
		expect(source).toContain('class PilotMetricsExporter');
		expect(source).toContain('async export(');
		expect(source).not.toMatch(/\bfetch\b|requestUrl|SecretStorage|uploader|telemetry/iu);
	});

	it('keeps H5.3 receipts unchanged and wires every H0.6 lifecycle source fail-open', () => {
		const receipts = readFileSync('src/sessions/pending-proposal-model.ts', 'utf8');
		expect(receipts).toContain("PROPOSAL_RECEIPT_VERSION = 1");
		expect(receipts).not.toContain('accepted_workflow_failed');
		const main = readFileSync('src/main.ts', 'utf8');
		for (const hook of [
			'proposalPresented', "workflow: 'succeeded'", "workflow: 'failed'", 'sessionStarted',
			'sessionCompleted', 'recoveryPresented', 'recoveryFinished', 'proposalExpired',
		]) expect(main).toContain(hook);
	});

	it('attempts review-presented when a proposal card materializes before enabling its decisions', () => {
		const view = readFileSync('src/ui/companion-view.ts', 'utf8');
		const pending = view.slice(view.indexOf('private renderPendingConfirmation'), view.indexOf('private refreshDynamicStatus'));
		expect(pending).toContain('review.disabled = true');
		expect(pending).toContain('dismiss.disabled = true');
		expect(pending.indexOf('recordPendingProposalPresented')).toBeLessThan(pending.indexOf('review.disabled = false'));
		expect(pending.indexOf('recordPendingProposalPresented')).toBeLessThan(pending.indexOf('dismiss.disabled = false'));
		const main = readFileSync('src/main.ts', 'utf8');
		const review = main.slice(main.indexOf('private async reviewPendingProposalOutcome'), main.indexOf('async dismissPendingProposal'));
		expect(review).not.toContain('proposalPresented');
	});

	it('scopes the journal by the already-derived vault id and exposes atomic opt-out', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		expect(main).toContain('new IndexedDbPilotMetricsStore(window.indexedDB, vaultId)');
		const store = readFileSync('src/sessions/pilot-metrics-store.ts', 'utf8');
		expect(store).toContain('async disable()');
		expect(store).toContain('PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE');
	});
});
