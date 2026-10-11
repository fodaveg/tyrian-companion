import { describe, expect, it } from 'vitest';

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
		const main = readModuleSource('src/runtime/tyrian-companion-core.ts');
		// `recoveryFinished` is read from what a recovery and a discard hand the journal when they run,
		// in `src/runtime/live-session-runtime.test.ts`; `sessionStarted`, `sessionCompleted` and the
		// start's `workflow: 'succeeded'`/`'failed'` from a start and a finalization that run, in
		// `src/main-session-workflow-semantics.test.ts`, and the stop's workflow in `src/main.test.ts`
		// ('stop workflow outcome in the receipt and the pilot (H18.4)') (DE-01). `proposalPresented` is
		// read from a pending card and an assisted proposal that are journaled, in `src/main.test.ts`
		// ('journals a materialized pending-proposal card...') and
		// `src/main-assisted-proposal-semantics.test.ts` (DE-01).
		for (const hook of ['recoveryPresented', 'proposalExcluded']) expect(main).toContain(hook);
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
		// That reviewing a pending proposal never journals it as presented runs over the real core in
		// `src/main-assisted-proposal-semantics.test.ts`; that a recovery or a discard never waits for
		// the journal to record it as presented, in `src/runtime/live-session-runtime.test.ts` (DE-01).
	});

	it('scopes the journal by the already-derived vault id and exposes atomic opt-out', () => {
		const main = readModuleSource('src/runtime/tyrian-companion-core.ts');
		// R1a: the factory is the host's (`TyrianHost.kv.indexedDB`, `window.indexedDB` in Obsidian).
		const initializeRuntime = classMethodBody(main, 'TyrianCompanionCore', 'initializeRuntime');
		expect(initializeRuntime).toContain('const indexedDB = host.kv.indexedDB;');
		expect(initializeRuntime).toMatch(/assembleSessions\(\{\s*\n\s*factory: indexedDB,\s*\n\s*vaultId,/u);
		expect(readModuleSource('src/runtime/assemble-sessions.ts'))
			.toContain('new IndexedDbPilotMetricsStore(input.factory, input.vaultId)');
		const store = readModuleSource('src/sessions/pilot-metrics-store.ts');
		expect(store).toContain('async disable()');
		expect(store).toContain('PILOT_METRICS_PROFILE_STORE, PILOT_METRICS_OBSERVATION_STORE, PILOT_METRICS_VERIFICATION_STORE');
	});

	it('closes every product invalidation of a live assisted proposal without changing successful workflow closure', () => {
		const main = readModuleSource('src/runtime/tyrian-companion-core.ts');
		const settings = classMethodBody(main, 'TyrianCompanionCore', 'updateSettings');
		// `'mode_off'` is gone (Lote S, 2026-09-09): there is no more `detectionMode` toggle to turn
		// off, so `updateSettings` never invalidates a live proposal for that reason anymore.
		expect(settings).not.toContain("invalidateAndDisarmAssistedDetection('mode_off')");
		expect(settings).toContain("invalidateAndDisarmAssistedDetection('connection_changed')");
		// That the user's disarm closes the live proposal as `invalidated` before it disarms as `user`,
		// and that the unload closes it before the journal, run over the real core in
		// `src/main-assisted-proposal-semantics.test.ts` (DE-01).
		// That a stop disarms the detector as `session_stopped` and never invalidates the proposal it
		// accepted runs in `src/main-session-workflow-semantics.test.ts` (DE-01).
	});
});
