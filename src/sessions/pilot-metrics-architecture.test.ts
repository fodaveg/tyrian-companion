import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TRANSLATIONS } from '../core/i18n';

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
			'sessionCompleted', 'recoveryPresented', 'recoveryFinished', 'proposalExcluded',
		]) expect(main).toContain(hook);
	});

	it('attempts review-presented when a card materializes without delaying any product action', () => {
		const view = readFileSync('src/ui/companion-view.ts', 'utf8');
		const pending = view.slice(view.indexOf('private renderPendingConfirmation'), view.indexOf('private refreshDynamicStatus'));
		expect(pending).toContain('recordPendingProposalPresented');
		expect(pending).not.toContain('review.disabled');
		expect(pending).not.toContain('dismiss.disabled');
		expect(pending).not.toContain('.finally(');
		expect(pending).not.toContain('PilotBoundaryModal');
		expect(pending).toContain('openPendingSessionStart(intent, null)');
		const recovery = view.slice(view.indexOf('private renderRecovery('), view.indexOf('private async runRecovery'));
		expect(recovery).toContain('recover.disabled = working');
		expect(recovery).not.toContain('recoveryKind === null');
		expect(recovery).toContain('select.disabled = working || recoveryKind !== null');
		const assisted = view.slice(view.indexOf('private renderAssistedDetection('), view.indexOf('private async armDetection'));
		expect(assisted).not.toContain('PilotBoundaryModal');
		expect(assisted).toContain('openManualSessionStart(null)');
		expect(assisted).toContain('stopManualSession(null)');
		const main = readFileSync('src/main.ts', 'utf8');
		const review = main.slice(main.indexOf('private async reviewPendingProposalOutcome'), main.indexOf('async dismissPendingProposal'));
		expect(review).not.toContain('proposalPresented');
		expect(main).not.toContain('if (recoveryId) await this.ensurePilotRecoveryPresented(recoveryId)');
	});

	it('scopes the journal by the already-derived vault id and exposes atomic opt-out', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		expect(main).toMatch(/assembleSessions\(\{\s*\n\s*factory: window\.indexedDB,\s*\n\s*vaultId,/u);
		expect(readFileSync('src/runtime/assemble-sessions.ts', 'utf8'))
			.toContain('new IndexedDbPilotMetricsStore(input.factory, input.vaultId)');
		const store = readFileSync('src/sessions/pilot-metrics-store.ts', 'utf8');
		expect(store).toContain('async disable()');
		expect(store).toContain('PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE');
	});

	it('states that clear resets the review and disable leaves prior Vault exports untouched', () => {
		for (const locale of ['es', 'en'] as const) {
			expect(TRANSLATIONS[locale]['settings.pilot.clear.desc']).toMatch(/revisi|review/iu);
			expect(TRANSLATIONS[locale]['settings.pilot.disable.desc']).toMatch(/Vault/u);
			expect(TRANSLATIONS[locale]['settings.pilot.disable.desc']).toMatch(/no se borran|not deleted/iu);
		}
	});

	it('closes every product invalidation of a live assisted proposal without changing successful workflow closure', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		const disarm = main.slice(main.indexOf('disarmAssistedDetection(): void'), main.indexOf('recordAssistedProposalPresented(): void'));
		expect(disarm).toContain("invalidateAndDisarmAssistedDetection('user')");
		const settings = main.slice(main.indexOf('async updateSettings('), main.indexOf('\n\tprivate async loadSettings('));
		expect(settings).toContain("invalidateAndDisarmAssistedDetection('mode_off')");
		expect(settings).toContain("invalidateAndDisarmAssistedDetection('connection_changed')");
		const shutdown = main.slice(main.indexOf('private async shutdownRuntime()'), main.indexOf('getConnectionState():'));
		expect(shutdown).toContain('const pilotProposalClosure = this.excludeLiveAssistedProposal()');
		const stopWorkflow = main.slice(main.indexOf('private async performStopManualSession'), main.indexOf('\n\topenManualSessionStart('));
		expect(stopWorkflow).toContain("this.assistedDetection.disarm('session_stopped')");
		expect(stopWorkflow).not.toContain("invalidateAndDisarmAssistedDetection('session_stopped')");
	});
});
