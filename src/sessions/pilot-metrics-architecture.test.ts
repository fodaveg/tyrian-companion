import { describe, expect, it } from 'vitest';

import { TRANSLATIONS } from '../core/i18n';
import {
	classMemberNamesOf, classMethodBody, exportedDeclarationNameList, forbiddenBoundaryUses,
	type ModuleBoundary, readModuleSource,
} from '../test/module-boundary';

const CORE = [
	'src/sessions/pilot-metrics-model.ts',
	'src/sessions/pilot-metrics-statistics.ts',
	'src/sessions/pilot-metrics-store.ts',
	'src/sessions/pilot-metrics-recorder.ts',
];

// Shared by both the journal/aggregation island and the exporter: network calls, secrets and
// uploaders are forbidden everywhere in this feature, exported or not.
const NETWORK_AND_SECRET_NAMES = ['fetch', 'requestUrl', 'SecretStorage', 'uploader', 'telemetry'];

describe('pilot metrics architecture', () => {
	it('keeps the journal and aggregation island free of network, secrets, uploaders and Vault writes', () => {
		for (const path of CORE) {
			const boundary: ModuleBoundary = {
				path,
				forbiddenImports: ['secret-provider'],
				forbiddenNames: [...NETWORK_AND_SECRET_NAMES, 'XMLHttpRequest', 'WebSocket', 'vault', 'createFolder', 'create'],
			};
			expect(forbiddenBoundaryUses(readModuleSource(path), boundary)).toEqual([]);
		}
	});

	it('keeps all Vault writes inside the explicit exporter', () => {
		const source = readModuleSource('src/sessions/pilot-metrics-export.ts');
		expect(exportedDeclarationNameList(source)).toContain('PilotMetricsExporter');
		expect(classMemberNamesOf(source, 'PilotMetricsExporter')).toContain('export');
		const boundary: ModuleBoundary = {
			path: 'src/sessions/pilot-metrics-export.ts',
			forbiddenImports: [],
			forbiddenNames: NETWORK_AND_SECRET_NAMES,
		};
		expect(forbiddenBoundaryUses(source, boundary)).toEqual([]);
	});

	it('keeps H5.3 receipts unchanged and wires every H0.6 lifecycle source fail-open', () => {
		const receipts = readModuleSource('src/sessions/pending-proposal-model.ts');
		expect(receipts).toContain("PROPOSAL_RECEIPT_VERSION = 1");
		expect(receipts).not.toContain('accepted_workflow_failed');
		const main = readModuleSource('src/main.ts');
		for (const hook of [
			'proposalPresented', "workflow: 'succeeded'", "workflow: 'failed'", 'sessionStarted',
			'sessionCompleted', 'recoveryPresented', 'recoveryFinished', 'proposalExcluded',
		]) expect(main).toContain(hook);
	});

	it('attempts review-presented when a card materializes without delaying any product action', () => {
		const view = readModuleSource('src/ui/companion-view.ts');
		const pending = classMethodBody(view, 'TyrianCompanionView', 'renderPendingConfirmation');
		expect(pending).toContain('recordPendingProposalPresented');
		expect(pending).not.toContain('review.disabled');
		expect(pending).not.toContain('dismiss.disabled');
		expect(pending).not.toContain('.finally(');
		expect(pending).not.toContain('PilotBoundaryModal');
		expect(pending).toContain('openPendingSessionStart(intent, null)');
		// Lote M/N (9 sep 2026): `renderRecovery` became `buildRecoveryModel` (a session-card model
		// builder, not a DOM renderer) plus the unchanged `renderPilotRecoveryKind`; the two literal
		// disable conditions this test protects now live in each of those regions separately.
		const recovery = classMethodBody(view, 'TyrianCompanionView', 'buildRecoveryModel');
		expect(recovery).toContain('disabled: working || busy');
		expect(recovery).not.toContain('recoveryKind === null');
		const pilotKind = classMethodBody(view, 'TyrianCompanionView', 'renderPilotRecoveryKind');
		expect(pilotKind).toContain('select.disabled = working || recoveryKind !== null');
		const assisted = classMethodBody(view, 'TyrianCompanionView', 'renderAssistedDetection');
		expect(assisted).not.toContain('PilotBoundaryModal');
		expect(assisted).toContain('openManualSessionStart(null)');
		expect(assisted).toContain('stopManualSession(null)');
		const main = readModuleSource('src/main.ts');
		const review = classMethodBody(main, 'TyrianCompanionPlugin', 'reviewPendingProposalOutcome');
		expect(review).not.toContain('proposalPresented');
		expect(main).not.toContain('if (recoveryId) await this.ensurePilotRecoveryPresented(recoveryId)');
	});

	it('scopes the journal by the already-derived vault id and exposes atomic opt-out', () => {
		const main = readModuleSource('src/main.ts');
		expect(classMethodBody(main, 'TyrianCompanionPlugin', 'initializeRuntime'))
			.toMatch(/assembleSessions\(\{\s*\n\s*factory: window\.indexedDB,\s*\n\s*vaultId,/u);
		expect(readModuleSource('src/runtime/assemble-sessions.ts'))
			.toContain('new IndexedDbPilotMetricsStore(input.factory, input.vaultId)');
		const store = readModuleSource('src/sessions/pilot-metrics-store.ts');
		expect(store).toContain('async disable()');
		expect(store).toContain('PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE');
	});

	it('states that clear resets the review and disable leaves prior Vault exports untouched', () => {
		for (const locale of ['es', 'en'] as const) {
			expect(TRANSLATIONS[locale]['settings.pilot.clear.desc']).toMatch(/revisi|review/iu);
			expect(TRANSLATIONS[locale]['settings.pilot.disable.descExports']).toMatch(/Vault/u);
			expect(TRANSLATIONS[locale]['settings.pilot.disable.descExports']).toMatch(/no se tocan|not touched/iu);
		}
	});

	it('closes every product invalidation of a live assisted proposal without changing successful workflow closure', () => {
		const main = readModuleSource('src/main.ts');
		const disarm = classMethodBody(main, 'TyrianCompanionPlugin', 'disarmAssistedDetection');
		expect(disarm).toContain("invalidateAndDisarmAssistedDetection('user')");
		const settings = classMethodBody(main, 'TyrianCompanionPlugin', 'updateSettings');
		// `'mode_off'` is gone (Lote S, 2026-09-09): there is no more `detectionMode` toggle to turn
		// off, so `updateSettings` never invalidates a live proposal for that reason anymore.
		expect(settings).not.toContain("invalidateAndDisarmAssistedDetection('mode_off')");
		expect(settings).toContain("invalidateAndDisarmAssistedDetection('connection_changed')");
		const shutdown = classMethodBody(main, 'TyrianCompanionPlugin', 'shutdownRuntime');
		expect(shutdown).toContain('const pilotProposalClosure = this.excludeLiveAssistedProposal()');
		const stopWorkflow = classMethodBody(main, 'TyrianCompanionPlugin', 'performStopManualSession');
		expect(stopWorkflow).toContain("this.assistedDetection.disarm('session_stopped')");
		expect(stopWorkflow).not.toContain("invalidateAndDisarmAssistedDetection('session_stopped')");
	});
});
