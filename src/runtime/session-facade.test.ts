import { describe, expect, it, vi } from 'vitest';

import { SessionRuntime, type SessionRuntimePort } from './session-facade';
import { TyrianCompanionCore } from './tyrian-companion-core';
import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { LocalDebugRecordInput } from '../core/local-debug-contract';
import type { LocalDebugLogger } from '../core/local-debug-logger';
import { DEFAULT_SETTINGS, type TyrianSettings } from '../core/settings';
import { DEFAULT_FARMING_PREPARATION } from '../sessions/farming-goal-preparation';
import { buildLiveSessionComparison } from '../sessions/live-session-comparison';
import type { SettingsUpdateResult } from '../ui/settings-panel-actions';
import { PILOT_METRICS_VERSION, PILOT_PLATFORMS, type PilotJournalSnapshotV1, type PilotRecoveryKind } from '../sessions/pilot-metrics-model';
import {
	SessionHistoryRuntimeAuthority,
	type SessionHistoryScrubPreview,
	type SessionHistoryScrubResult,
} from '../sessions/session-history';

/**
 * DE-01, step 3a: `SessionRuntime` on its own, over ports checked with `satisfies SessionRuntimePort`.
 * The pilot export, the recovery classification and the history row's link moved here from
 * `src/main.test.ts` and `src/main-session-history-open-note.test.ts`, where they drove the same
 * code as methods of `TyrianCompanionCore` on a plain object; titles and assertions are theirs.
 * The core's side (that the real core builds this runtime and reads its fields live) is
 * `src/main-session-runtime-wiring.test.ts`.
 */

/** Every member a case does not use throws, so a case reaching one by mistake says so. */
function unused(name: string): () => never {
	return () => { throw new Error(`${name} is not part of this case`); };
}

const SNAPSHOT: PilotJournalSnapshotV1 = {
	version: PILOT_METRICS_VERSION,
	profile: {
		version: PILOT_METRICS_VERSION, platform: PILOT_PLATFORMS[0], platformVersion: '1',
		obsidianVersion: '1.9.0', tyrianVersion: 'test',
	},
	sampleRevision: 1,
	verification: null,
	observations: [],
};

const SETTINGS: SessionRuntimePort['settings'] = {
	language: 'en', outputFolder: 'Tyrian Companion', farmingGoal: DEFAULT_SETTINGS.farmingGoal,
	farmingPreparation: DEFAULT_SETTINGS.farmingPreparation, farmingDeclaredBuild: DEFAULT_SETTINGS.farmingDeclaredBuild,
};

/** A ready collector with no live session, no recovery and every service stubbed out. */
function port(overrides: Partial<SessionRuntimePort> = {}): SessionRuntimePort {
	return {
		settings: SETTINGS,
		runtimeReady: true,
		collectorMode: 'collector',
		localDebugActions: null,
		host: {
			environment: { hostVersion: '1.9.0', pluginVersion: 'test' },
			vault: { file: unused('host.vault.file') },
			ui: { openNote: unused('host.ui.openNote') },
		},
		settingTab: { refreshSessionHistoryRow: () => undefined },
		sessionHistory: {
			export: unused('sessionHistory.export'),
			previewScrub: unused('sessionHistory.previewScrub'),
			revokeScrub: unused('sessionHistory.revokeScrub'),
			scrub: unused('sessionHistory.scrub'),
		},
		sessionHistoryRuntimeAuthority: new SessionHistoryRuntimeAuthority(() => ({
			sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed',
		})),
		pilotMetrics: {
			getState: () => ({ status: 'ready', observations: 0, limit: 100 }),
			profile: unused('pilotMetrics.profile'),
			inspect: unused('pilotMetrics.inspect'),
			configure: unused('pilotMetrics.configure'),
			clear: unused('pilotMetrics.clear'),
			reviewSilentLosses: unused('pilotMetrics.reviewSilentLosses'),
			disable: unused('pilotMetrics.disable'),
			recoveryClassified: unused('pilotMetrics.recoveryClassified'),
		},
		pilotMetricsExporter: { preview: unused('pilotMetricsExporter.preview'), export: unused('pilotMetricsExporter.export') },
		measuredPilotRecoveries: new Set<string>(),
		pilotRecoveryKinds: new Map<string, PilotRecoveryKind>(),
		liveSessions: null,
		liveHistory: null,
		notifyConsultMode: unused('notifyConsultMode'),
		notifyRuntimeStarting: unused('notifyRuntimeStarting'),
		emitNotice: unused('emitNotice'),
		renderViews: () => undefined,
		pilotRecoveryIdentity: () => null,
		ensurePilotRecoveryPresented: unused('ensurePilotRecoveryPresented'),
		updateSettings: unused('updateSettings'),
		...overrides,
	} satisfies SessionRuntimePort;
}

describe('persisted pilot recovery classification', () => {
	it('hydrates a reloaded classification and rejects an alternative without touching the journal', async () => {
		const recoveryClassified = vi.fn(async () => false);
		const recoveryId = 'session-a:7';
		// The reload's hydration is the core's own `ensurePilotRecoveryPresented` (it stays with the
		// recovery it measures); the classification it guards is `SessionRuntime`'s.
		const core = {
			pilotMetrics: {
				recoveryPresented: vi.fn(async () => true),
				recoveryKind: vi.fn(async () => 'forced_restart' as const),
			},
			measuredPilotRecoveries: new Set<string>(),
			pilotRecoveryKinds: new Map<string, PilotRecoveryKind>(),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated reload harness.
		const ensure = (TyrianCompanionCore.prototype as unknown as {
			ensurePilotRecoveryPresented(this: typeof core, id: string): Promise<boolean>;
		}).ensurePilotRecoveryPresented;
		const runtime = new SessionRuntime(port({
			pilotMetrics: { ...port().pilotMetrics, recoveryClassified },
			measuredPilotRecoveries: core.measuredPilotRecoveries,
			pilotRecoveryKinds: core.pilotRecoveryKinds,
			pilotRecoveryIdentity: () => recoveryId,
			ensurePilotRecoveryPresented: async (id) => await ensure.call(core, id),
		}));

		await expect(ensure.call(core, recoveryId)).resolves.toBe(true);
		expect(core.pilotRecoveryKinds.get(recoveryId)).toBe('forced_restart');
		await expect(runtime.classifyPilotRecovery('organic')).resolves.toBe(false);
		expect(recoveryClassified).not.toHaveBeenCalled();
		expect(core.pilotRecoveryKinds.get(recoveryId)).toBe('forced_restart');
	});
});

describe('pilot metrics export diagnostics', () => {
	// H15.23 (2026-09-10 incident): this ran entirely outside run(), so an 'unavailable' export
	// (a Vault write conflict, a corrupt plan) never reached the local debug log, only the UI.
	it('registers a session_projection failure when the export settles unavailable', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const runtime = new SessionRuntime(port({
			pilotMetrics: { ...port().pilotMetrics, inspect: async () => SNAPSHOT },
			pilotMetricsExporter: {
				preview: async () => ({
					digest: 'digest', observationCount: 0, platformCount: 0, files: [],
					included: ['sanitized_observations', 'platform_aggregates', 'version_strata', 'method_and_evidence'] as const,
					excluded: ['raw_proposal_ids', 'account_and_session_ids', 'secrets', 'paths', 'snapshots_and_payloads'] as const,
					pseudonymous: true as const,
				}),
				export: vi.fn(async () => ({ status: 'unavailable' as const, files: [] })),
			},
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'pilot-metrics-export' }),
		}));
		// The export only runs the plan its preview left; the core's harness used to set it directly.
		await runtime.previewPilotMetricsExport();

		await expect(runtime.exportPilotMetrics()).resolves.toMatchObject({ status: 'unavailable' });

		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'session' && input.action === 'session_projection' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'storage_failure', state: 'pilot_metrics_export' });
	});
});

/**
 * The history's link to a session's summary note: the note may have been moved or deleted after
 * the history was read, and opening a path that no longer exists would make the host create an
 * empty note. The runtime therefore asks the vault first and says so instead of opening.
 */
describe('openSessionHistoryNote (history row link)', () => {
	const harness = (existing: readonly string[], language: 'en' | 'es' = 'en') => {
		const openNote = vi.fn();
		const emitNotice = vi.fn();
		const runtime = new SessionRuntime(port({
			settings: { ...SETTINGS, language },
			host: {
				...port().host,
				vault: { file: (path) => existing.includes(path) ? { path } : null },
				ui: { openNote },
			},
			emitNotice,
		}));
		return { runtime, openNote, emitNotice };
	};

	it('opens the note when the vault still has it', () => {
		const { runtime, openNote, emitNotice } = harness(['Sessions/a.md']);
		runtime.openSessionHistoryNote('Sessions/a.md');
		expect(openNote).toHaveBeenCalledExactlyOnceWith('Sessions/a.md');
		expect(emitNotice).not.toHaveBeenCalled();
	});

	it('does not open a note that is gone and says so in the player language', () => {
		const en = harness([]);
		en.runtime.openSessionHistoryNote('Sessions/a.md');
		expect(en.openNote).not.toHaveBeenCalled();
		expect(en.emitNotice).toHaveBeenCalledExactlyOnceWith(
			'That session note is no longer where it was saved. Refresh the history.', 'session_history_note',
		);
		const es = harness([], 'es');
		es.runtime.openSessionHistoryNote('Sessions/a.md');
		expect(es.openNote).not.toHaveBeenCalled();
		expect(es.emitNotice).toHaveBeenCalledExactlyOnceWith(
			'Esa nota de sesión ya no está donde se guardó. Actualiza el historial.', 'session_history_note',
		);
	});
});

describe('the session history scrub and export through SessionRuntime', () => {
	it('shares one preview in flight, lands on its verdict and repaints the settings row on each step', async () => {
		let answer: (preview: SessionHistoryScrubPreview) => void = () => undefined;
		const previewScrub = vi.fn((_authority: SessionHistoryRuntimeAuthority) =>
			new Promise<SessionHistoryScrubPreview>((resolve) => { answer = resolve; }));
		const refreshSessionHistoryRow = vi.fn();
		const authority = port().sessionHistoryRuntimeAuthority;
		const runtime = new SessionRuntime(port({
			sessionHistory: { ...port().sessionHistory, previewScrub },
			sessionHistoryRuntimeAuthority: authority,
			settingTab: { refreshSessionHistoryRow },
		}));

		const first = runtime.previewSessionHistoryScrub();
		const second = runtime.previewSessionHistoryScrub();
		const during = runtime.getSessionHistoryView().status;
		answer({ status: 'ready', token: 'scrub-1', sessions: 3 });

		expect({ same: first === second, during, calls: previewScrub.mock.calls.length, authority: previewScrub.mock.calls[0]?.[0] === authority })
			.toEqual({ same: true, during: 'scrub_previewing', calls: 1, authority: true });
		await expect(first).resolves.toMatchObject({ status: 'ready' });
		expect(runtime.getSessionHistoryView()).toEqual({ status: 'scrub_ready', sessions: 3, erased: 0, alreadyAbsent: 0 });
		expect(refreshSessionHistoryRow).toHaveBeenCalledTimes(2);
	});

	it('turns a scrub that throws into an unavailable result instead of a rejection', async () => {
		const runtime = new SessionRuntime(port({
			sessionHistory: { ...port().sessionHistory, scrub: async (): Promise<SessionHistoryScrubResult> => { throw new Error('vault gone'); } },
		}));

		await expect(runtime.scrubSessionHistory('scrub-1')).resolves.toEqual({
			status: 'unavailable', erased: 0, alreadyAbsent: 0, message: 'History scrub could not be completed safely.',
		});
		expect(runtime.getSessionHistoryView()).toEqual({ status: 'scrub_unavailable', sessions: 0, erased: 0, alreadyAbsent: 0 });
	});

	it('refuses the scrub on a consult device and says so once, without reaching the history', async () => {
		const notifyConsultMode = vi.fn();
		const runtime = new SessionRuntime(port({ collectorMode: 'consult', notifyConsultMode }));

		await expect(runtime.previewSessionHistoryScrub()).resolves.toEqual({
			status: 'unavailable', message: 'This installation is in consult mode.',
		});
		expect(notifyConsultMode).toHaveBeenCalledOnce();
	});

	it('before the runtime is ready, says it is starting and leaves the history alone', async () => {
		const notifyRuntimeStarting = vi.fn();
		const runtime = new SessionRuntime(port({ runtimeReady: false, notifyRuntimeStarting }));

		await runtime.exportSessionHistory();

		expect(notifyRuntimeStarting).toHaveBeenCalledOnce();
		expect(runtime.getSessionHistoryView()).toEqual({ status: 'idle', sessions: 0, erased: 0, alreadyAbsent: 0 });
	});

	it('an export that throws leaves the row unavailable', async () => {
		const runtime = new SessionRuntime(port({
			sessionHistory: { ...port().sessionHistory, export: async () => { throw new Error('disk full'); } },
		}));

		await runtime.exportSessionHistory();

		expect(runtime.getSessionHistoryView()).toEqual({ status: 'unavailable', sessions: 0, erased: 0, alreadyAbsent: 0 });
	});
});

describe('the next session\'s farming preferences through SessionRuntime', () => {
	it('writes the three forms one after another, each merged by the core\'s own settings write', async () => {
		const writes: Array<Partial<TyrianSettings>> = [];
		let finish: () => void = () => undefined;
		const first = new Promise<void>((resolve) => { finish = resolve; });
		const updateSettings = vi.fn(async (settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult> => {
			writes.push(settings);
			if (writes.length === 1) await first;
			return { status: 'saved', inventoryAdvisor: 'unchanged' };
		});
		const runtime = new SessionRuntime(port({ updateSettings }));

		const goal = runtime.saveFarmingGoal({ version: 1, kind: 'bags', targetBags: 50 });
		const preparation = runtime.saveFarmingPreparationSettings({ ...DEFAULT_FARMING_PREPARATION, enabled: true });
		const build = runtime.saveFarmingDeclaredBuildPreference(null);
		await Promise.resolve();
		const whileTheFirstWaits = writes.length;
		finish();
		await Promise.all([goal, preparation, build]);

		expect({ whileTheFirstWaits, writes }).toEqual({ whileTheFirstWaits: 1, writes: [
			{ farmingGoal: { version: 1, kind: 'bags', targetBags: 50 } },
			{ farmingPreparation: { ...DEFAULT_FARMING_PREPARATION, enabled: true } },
			{ farmingDeclaredBuild: null },
		] });
	});

	it('a refused write rejects its own form and leaves the next one free to save', async () => {
		const updateSettings = vi.fn(async (): Promise<SettingsUpdateResult> => ({ status: 'saved', inventoryAdvisor: 'unchanged' }));
		updateSettings.mockResolvedValueOnce({ status: 'blocked', reason: 'settings_read_only' });
		const runtime = new SessionRuntime(port({ updateSettings }));

		await expect(runtime.saveFarmingGoal({ version: 1, kind: 'none' })).rejects.toThrow('Farming settings are unavailable.');
		await expect(runtime.saveFarmingGoal({ version: 1, kind: 'none' })).resolves.toBeUndefined();
	});

	it('reads the saved preferences as they stand, the goal normalized and the preparation as a copy', () => {
		const settings = { ...SETTINGS, farmingPreparation: { ...DEFAULT_FARMING_PREPARATION, enabled: true }, farmingDeclaredBuild: { raw: 'kept as stored' } };
		const runtime = new SessionRuntime(port({ settings }));

		const preparation = runtime.getFarmingPreparationSettings();

		expect({
			goal: runtime.getFarmingGoal(),
			preparation,
			copy: preparation !== settings.farmingPreparation,
			build: runtime.getFarmingDeclaredBuildPreference(),
		}).toEqual({
			goal: { version: 1, kind: 'none' },
			preparation: { ...DEFAULT_FARMING_PREPARATION, enabled: true },
			copy: true,
			build: { raw: 'kept as stored' },
		});
	});
});

describe('the saved live sessions through SessionRuntime', () => {
	const history = (overrides: Partial<NonNullable<SessionRuntimePort['liveHistory']>>): NonNullable<SessionRuntimePort['liveHistory']> => ({
		loadComparison: unused('liveHistory.loadComparison'),
		list: unused('liveHistory.list'),
		select: unused('liveHistory.select'),
		export: unused('liveHistory.export'),
		...overrides,
	});

	it('shares one comparison load in flight, lands ready with what it set aside, and repaints once', async () => {
		let answer: (load: Awaited<ReturnType<NonNullable<SessionRuntimePort['liveHistory']>['loadComparison']>>) => void = () => undefined;
		const loadComparison = vi.fn(() => new Promise<Parameters<typeof answer>[0]>((resolve) => { answer = resolve; }));
		const renderViews = vi.fn();
		const runtime = new SessionRuntime(port({ liveHistory: history({ loadComparison }), renderViews }));
		const setAside = [{ path: 'Sessions/newer.md', reason: 'newer_version' as const }];

		const first = runtime.loadLiveSessionComparison();
		const second = runtime.loadLiveSessionComparison();
		const during = runtime.getLiveSessionComparison().history.status;
		answer({ status: 'ok', comparison: buildLiveSessionComparison([]), ignored: 0, setAside });
		await Promise.all([first, second]);

		expect({
			calls: loadComparison.mock.calls.length, during,
			after: runtime.getLiveSessionComparison().history.status,
			setAside: runtime.getLiveSessionSetAside(), repaints: renderViews.mock.calls.length,
			provisional: runtime.getLiveSessionComparison().provisional,
		}).toEqual({ calls: 1, during: 'loading', after: 'ready', setAside, repaints: 1, provisional: null });
	});

	it('a comparison that throws reads unavailable and the next one may load again', async () => {
		const loadComparison = vi.fn(async () => { throw new Error('vault gone'); });
		const runtime = new SessionRuntime(port({ liveHistory: history({ loadComparison }) }));

		await runtime.loadLiveSessionComparison();
		await runtime.loadLiveSessionComparison();

		expect({ status: runtime.getLiveSessionComparison().history.status, calls: loadComparison.mock.calls.length })
			.toEqual({ status: 'unavailable', calls: 2 });
	});

	it('without a live session or a selection, the view is the empty one and there are no alerts or selection', () => {
		const runtime = new SessionRuntime(port());

		expect({
			phase: runtime.getLiveSessionView().phase,
			alerts: runtime.getLiveSessionAlerts(),
			selected: runtime.getSelectedLiveSessionHistory(),
		}).toEqual({ phase: 'idle', alerts: [], selected: null });
	});

	it('an unreadable saved list is refused, and an export with nothing to export says so', async () => {
		const runtime = new SessionRuntime(port({ liveHistory: history({ list: async () => ({ status: 'unavailable' }) }) }));

		await expect(runtime.listLiveSessionHistory()).rejects.toThrow('Live session history is unavailable.');
		await expect(runtime.exportLiveSession('summary', 'json')).rejects.toThrow('The live session export is unavailable.');
	});
});
