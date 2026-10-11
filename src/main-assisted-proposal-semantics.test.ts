// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { AssistedDetectionService, type AssistedDetectionState } from './sessions/assisted-detection-service';
import { proposalIntent, type PendingProposal } from './sessions/pending-proposal-model';
import { PendingProposalService } from './sessions/pending-proposal-service';
import { PilotMetricsRecorder } from './sessions/pilot-metrics-recorder';
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3d: what the frozen source-text assertions of `pending-proposal-architecture.test.ts`
 * and `pilot-metrics-architecture.test.ts` matched inside the core's proposal methods, run instead
 * over the real core and its real `initializeRuntime`, through the public methods the views call. So
 * the cases read the same whether the proposals live in the core or in a facade it delegates to.
 * - A confirmed proposal's claim is renewed through the boot's renewal registry, the one the unload
 *   disposes: a claim still running at unload leaves no timer behind.
 * - An assisted proposal on screen is journaled as presented; a reviewed pending one is not.
 * - Every product invalidation of a live assisted proposal (the user's disarm, the unload) closes it in
 *   the pilot journal as `invalidated`, and the disarm says why.
 */

/** A start proposal the detector holds; only its id and its window are read here. */
function liveProposal(): Extract<AssistedDetectionState, { status: 'start_proposed' }>['proposal'] {
	return {
		version: 1, proposalId: 'assisted-proposal', accountId: 'account', ruleSet: { id: 'rules', version: 1 },
		possibleStart: { from: '2026-10-11T00:00:00.000Z', to: '2026-10-11T00:01:00.000Z', uncertaintyMs: 60_000 },
		evidenceQuality: 'complete', confirmedAt: '2026-10-11T00:01:00.000Z',
	} as unknown as Extract<AssistedDetectionState, { status: 'start_proposed' }>['proposal'];
}

/** The detector's state while it shows that proposal. */
function proposing(): AssistedDetectionState {
	return { status: 'start_proposed', proposal: liveProposal(), pollingIntervalMs: 120_000 } as unknown as AssistedDetectionState;
}

/** A queued start proposal, as the pending queue hands it to a claim. */
function queued(): PendingProposal {
	return {
		version: 1, proposalId: 'queued-proposal', accountId: 'account', phase: 'start',
		binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 },
		proposal: liveProposal(),
		pollingIntervalMs: 120_000,
	} as unknown as PendingProposal;
}

describe('the core\'s assisted detection and pending proposals, run instead of matched (DE-01)', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	/** The real core, booted as a collector device, with no diagnostics runner. */
	async function booted(): Promise<RuntimeHarness> {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const setup = runtime.core as unknown as {
			localDebugActions: null;
			settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
		};
		setup.localDebugActions = null;
		setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined };
		runtime.core.settings = { ...runtime.core.settings, apiKeySecret: 'tyrian-test-key', language: 'es' };
		await runtime.initializeRuntime();
		return runtime;
	}

	/** The renewal timers still armed: the registry's are the only ones at a minute. */
	function renewalTimers(runtime: RuntimeHarness) {
		return runtime.timers().filter((timer) => timer.kind === 'interval' && timer.delayMs === 60_000);
	}

	it('renews a confirmed proposal\'s claim every minute through the registry the unload disposes', async () => {
		const runtime = await booted();
		vi.spyOn(PendingProposalService.prototype, 'reconcile').mockResolvedValue({ status: 'ready', pendingCount: 1, next: queued() });
		const claim = vi.spyOn(PendingProposalService.prototype, 'claim')
			.mockResolvedValue({ status: 'claimed', proposal: queued() });
		const renew = vi.spyOn(PendingProposalService.prototype, 'renew').mockResolvedValue(true);
		// The dismissal's journal write never settles, so the claim is still held when the plugin unloads.
		vi.spyOn(DetectionQualityRecorder.prototype, 'recordDismissed').mockReturnValue(new Promise(() => undefined));
		const before = renewalTimers(runtime).length;

		void runtime.core.dismissPendingProposal(proposalIntent(queued()), 'not_farming');
		await vi.waitFor(() => { expect(renewalTimers(runtime)).toHaveLength(before + 1); });
		const [timer] = renewalTimers(runtime).slice(before);
		runtime.fireTimer(timer!.id);
		const operationId = claim.mock.calls[0]?.[1];

		await runtime.shutdown();

		expect({
			renewed: renew.mock.calls,
			armedAfterUnload: renewalTimers(runtime).length,
		}).toEqual({
			renewed: [[proposalIntent(queued()), operationId]],
			armedAfterUnload: 0,
		});
	});

	it('journals the assisted proposal on screen as presented, with its window and cadence', async () => {
		const runtime = await booted();
		vi.spyOn(AssistedDetectionService.prototype, 'getState').mockReturnValue(proposing());
		const presented = vi.spyOn(PilotMetricsRecorder.prototype, 'proposalPresented').mockResolvedValue(true);

		runtime.core.recordAssistedProposalPresented();

		expect(presented).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			proposalId: 'assisted-proposal', phase: 'start', mode: 'assisted', pollingIntervalMs: 120_000,
			window: liveProposal().possibleStart, evidenceQuality: 'complete',
		}));
	});

	it('never journals a pending proposal as presented when it is reviewed', async () => {
		const runtime = await booted();
		vi.spyOn(PendingProposalService.prototype, 'acknowledge').mockResolvedValue(false);
		const presented = vi.spyOn(PilotMetricsRecorder.prototype, 'proposalPresented').mockResolvedValue(true);

		const reviewed = await runtime.core.reviewPendingProposal(proposalIntent(queued()));

		expect({ reviewed, presented: presented.mock.calls.length }).toEqual({ reviewed: false, presented: 0 });
	});

	it('never journals a pending proposal as presented when its review is accepted and opens the Companion', async () => {
		const runtime = await booted();
		vi.spyOn(PendingProposalService.prototype, 'acknowledge').mockResolvedValue(true);
		// The card the review opens is the queue's next proposal, the one reviewed: a journal entry
		// written from the queue (`recordPendingProposalPresented`) would find it.
		vi.spyOn(PendingProposalService.prototype, 'getState').mockReturnValue({ status: 'ready', pendingCount: 1, next: queued() });
		vi.spyOn(runtime.core as unknown as { activateView(): Promise<void> }, 'activateView').mockResolvedValue(undefined);
		const presented = vi.spyOn(PilotMetricsRecorder.prototype, 'proposalPresented').mockResolvedValue(true);

		const reviewed = await runtime.core.reviewPendingProposal(proposalIntent(queued()));

		expect({ reviewed, presented: presented.mock.calls.length }).toEqual({ reviewed: true, presented: 0 });
	});

	it('closes a live assisted proposal as invalidated before the user\'s disarm, and disarms as the user', async () => {
		const runtime = await booted();
		const events: string[] = [];
		vi.spyOn(AssistedDetectionService.prototype, 'getState').mockReturnValue(proposing());
		const disarm = vi.spyOn(AssistedDetectionService.prototype, 'disarm')
			.mockImplementation(() => { events.push('disarm'); return proposing(); });
		const excluded = vi.spyOn(PilotMetricsRecorder.prototype, 'proposalExcluded')
			.mockImplementation(async () => { events.push('excluded'); return true; });

		runtime.core.disarmAssistedDetection();

		expect({ events, excluded: excluded.mock.calls, disarmed: disarm.mock.calls }).toEqual({
			events: ['excluded', 'disarm'],
			excluded: [['assisted-proposal', 'invalidated']],
			disarmed: [['user']],
		});
	});

	it('closes a live assisted proposal as invalidated at unload, and closes the journal only after it', async () => {
		const runtime = await booted();
		const events: string[] = [];
		vi.spyOn(AssistedDetectionService.prototype, 'getState').mockReturnValue(proposing());
		let settle: (value: boolean) => void = () => undefined;
		const excluded = vi.spyOn(PilotMetricsRecorder.prototype, 'proposalExcluded')
			.mockImplementation(() => { events.push('excluded'); return new Promise<boolean>((resolve) => { settle = resolve; }); });
		vi.spyOn(PilotMetricsRecorder.prototype, 'dispose').mockImplementation(() => { events.push('journal closed'); });

		await runtime.shutdown();
		const atUnload = [...events];
		settle(true);
		await vi.waitFor(() => { expect(events).toContain('journal closed'); });

		expect({ atUnload, excluded: excluded.mock.calls, events }).toEqual({
			atUnload: ['excluded'],
			excluded: [['assisted-proposal', 'invalidated']],
			events: ['excluded', 'journal closed'],
		});
	});
});
