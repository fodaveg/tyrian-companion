/* eslint-disable @typescript-eslint/unbound-method -- Vitest spies intentionally occupy port method slots. */
import { describe, expect, it, vi } from 'vitest';

import type { InventoryVaultSyncLastRun } from '../core/settings';
import type { InventoryVaultSyncPlan, InventoryVaultSyncResult } from '../inventory/inventory-vault-sync';
import {
	InventoryVaultOneClickSyncController,
	type InventoryVaultSyncCaptureProgress,
	type InventoryVaultSyncRunPorts,
	type InventoryVaultSyncRunState,
} from './inventory-vault-sync-run-controller';

describe('inventory Vault one-click sync controller', () => {
	it('writes directly when the plan only creates and updates, never pausing for confirmation', async () => {
		const applied: InventoryVaultSyncResult = { status: 'applied', created: 1, updated: 1, deactivated: 0 };
		const ports = portsFor({
			previewSync: vi.fn(async () => planWith(['create', 'update'])),
			applySync: vi.fn(async (_plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => { onStep(2, 2); return applied; }),
		});
		const { controller, changes } = harness(ports);
		const final = await controller.run();
		expect(ports.previewSync).toHaveBeenCalledOnce();
		expect(ports.applySync).toHaveBeenCalledOnce();
		expect(changes.some((state) => state.status === 'confirm')).toBe(false);
		expect(final).toMatchObject({ status: 'idle', lastRun: { status: 'success' } });
	});

	it('pauses for explicit confirmation when the plan deactivates rows, and only writes after confirm()', async () => {
		const plan = planWith(['create', 'deactivate']);
		const applied: InventoryVaultSyncResult = { status: 'applied', created: 1, updated: 0, deactivated: 1 };
		const ports = portsFor({
			previewSync: vi.fn(async () => plan),
			applySync: vi.fn(async (_p: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => { onStep(2, 2); return applied; }),
		});
		const { controller } = harness(ports);
		const paused = await controller.run();
		expect(paused).toMatchObject({ status: 'confirm', summary: { deactivate: 1 } });
		expect(ports.applySync).not.toHaveBeenCalled();
		const done = await controller.confirm();
		expect(ports.applySync).toHaveBeenCalledOnce();
		expect(done).toMatchObject({ status: 'idle', lastRun: { status: 'success' } });
	});

	it('discards a pending destructive plan on cancel without ever calling applySync', async () => {
		const ports = portsFor({ previewSync: vi.fn(async () => planWith(['deactivate'])) });
		const { controller } = harness(ports);
		await controller.run();
		expect(controller.current().status).toBe('confirm');
		controller.cancel();
		expect(controller.current()).toMatchObject({ status: 'idle' });
		expect(await controller.confirm()).toMatchObject({ status: 'idle' });
		expect(ports.applySync).not.toHaveBeenCalled();
	});

	it('stops at conflict without writing when the plan has real conflicts, and again when canApply is false', async () => {
		const withConflicts = portsFor({ previewSync: vi.fn(async () => planWith(['create', 'conflict'], false)) });
		const conflictRun = harness(withConflicts);
		expect(await conflictRun.controller.run()).toMatchObject({ status: 'conflict', summary: { conflicts: 1 } });
		expect(withConflicts.applySync).not.toHaveBeenCalled();

		const blockedButNoConflictEntry = portsFor({
			previewSync: vi.fn(async () => ({ ...planWith(['create']), canApply: false })),
		});
		const blockedRun = harness(blockedButNoConflictEntry);
		expect(await blockedRun.controller.run()).toMatchObject({ status: 'conflict' });
		expect(blockedButNoConflictEntry.applySync).not.toHaveBeenCalled();
	});

	it('drives percent from the five real phases in order, never from a clock', async () => {
		const advisorPhases: Array<'capture' | 'preferences' | 'classification'> = [];
		const ports = portsFor({
			// Mirrors the real advisor workflow: it starts in 'capture' with no explicit
			// callback for that phase, then reports the two later transitions explicitly.
			refreshAdvisor: vi.fn(async (onPhase: (phase: 'capture' | 'preferences' | 'classification') => void) => {
				advisorPhases.push('capture');
				for (const phase of ['preferences', 'classification'] as const) {
					advisorPhases.push(phase);
					onPhase(phase);
				}
			}),
			previewSync: vi.fn(async () => planWith(['create'])),
			applySync: vi.fn(async (_p: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => { onStep(1, 1); return { status: 'applied', created: 1, updated: 0, deactivated: 0 } as const; }),
		});
		const { controller, changes } = harness(ports);
		await controller.run();
		const running = changes.filter((state): state is Extract<InventoryVaultSyncRunState, { status: 'running' }> => state.status === 'running');
		expect(running.map((state) => state.phase)).toEqual(['capture', 'preferences', 'classification', 'preview', 'apply', 'apply']);
		expect(running.map((state) => state.percent)).toEqual([0, 20, 40, 60, 80, 100]);
		expect(advisorPhases).toEqual(['capture', 'preferences', 'classification']);
		// Every intermediate step but the live apply step has no fabricated completed/total.
		for (const state of running.slice(0, -2)) expect([state.completed, state.total]).toEqual([null, null]);
		expect([running.at(-2)?.completed, running.at(-2)?.total]).toEqual([0, 1]);
		expect([running.at(-1)?.completed, running.at(-1)?.total]).toEqual([1, 1]);
	});

	it('raises the percent inside capture as simulated character inventories resolve, never past the phase’s own slice', async () => {
		const total = 12;
		const ports = portsFor({
			refreshAdvisor: vi.fn(async (
				onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
				onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
			) => {
				onCaptureProgress(captureTick({ accountStores: 0, characters: 0, charactersTotal: total }));
				for (let completed = 1; completed <= total; completed += 1) {
					onCaptureProgress(captureTick({ accountStores: Math.min(3, completed), characters: completed, charactersTotal: total }));
				}
				onCaptureProgress(captureTick({ accountStores: 3, characters: total, charactersTotal: total, catalogAndPrices: 4 }));
				onPhase('preferences'); onPhase('classification');
			}),
			previewSync: vi.fn(async () => planWith(['create'])),
			applySync: vi.fn(async (_p: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => { onStep(1, 1); return { status: 'applied', created: 1, updated: 0, deactivated: 0 } as const; }),
		});
		const { controller, changes } = harness(ports);
		await controller.run();
		const capturePercents = changes
			.filter((state): state is Extract<InventoryVaultSyncRunState, { status: 'running' }> => state.status === 'running' && state.phase === 'capture')
			.map((state) => state.percent);
		// It starts at 0 (nothing has landed yet) but moves well before the phase ends,
		// instead of sitting at 0 for the whole minute-long capture.
		expect(capturePercents[0]).toBe(0);
		expect(capturePercents.some((percent) => percent > 0 && percent < 20)).toBe(true);
		expect(Math.max(...capturePercents)).toBeLessThanOrEqual(20);
		for (let index = 1; index < capturePercents.length; index += 1) {
			expect(capturePercents[index]).toBeGreaterThanOrEqual(capturePercents[index - 1]!);
		}
	});

	it('does not divide by zero or ever regress when the capture reports zero characters', async () => {
		const ports = portsFor({
			refreshAdvisor: vi.fn(async (
				onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
				onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
			) => {
				onCaptureProgress(captureTick({ accountStores: 0, characters: 0, charactersTotal: 0 }));
				onCaptureProgress(captureTick({ accountStores: 3, characters: 0, charactersTotal: 0, catalogAndPrices: 4 }));
				onPhase('preferences'); onPhase('classification');
			}),
		});
		const { controller, changes } = harness(ports);
		await controller.run();
		const capture = changes.filter((state): state is Extract<InventoryVaultSyncRunState, { status: 'running' }> => state.status === 'running' && state.phase === 'capture');
		expect(capture.length).toBeGreaterThan(1);
		const percents = capture.map((state) => state.percent);
		for (const percent of percents) expect(Number.isNaN(percent)).toBe(false);
		for (let index = 1; index < percents.length; index += 1) expect(percents[index]).toBeGreaterThanOrEqual(percents[index - 1]!);
	});

	it('never lets the percent regress across a whole run, from capture through apply', async () => {
		const ports = portsFor({
			refreshAdvisor: vi.fn(async (
				onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
				onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
			) => {
				for (let completed = 0; completed <= 8; completed += 1) {
					onCaptureProgress(captureTick({ accountStores: Math.min(3, completed), characters: completed, charactersTotal: 8 }));
				}
				onPhase('preferences'); onPhase('classification');
			}),
			previewSync: vi.fn(async () => planWith(['create', 'create', 'update'])),
			applySync: vi.fn(async (plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => {
				for (let completed = 0; completed <= plan.steps.length; completed += 1) onStep(completed, plan.steps.length);
				return { status: 'applied', created: 2, updated: 1, deactivated: 0 } as const;
			}),
		});
		const { controller, changes } = harness(ports);
		await controller.run();
		const running = changes.filter((state): state is Extract<InventoryVaultSyncRunState, { status: 'running' }> => state.status === 'running');
		expect(running.length).toBeGreaterThan(10);
		for (let index = 1; index < running.length; index += 1) {
			expect(running[index]!.percent).toBeGreaterThanOrEqual(running[index - 1]!.percent);
		}
	});

	it.each([
		[3, 2], [30, 20],
	] as const)('persists the outcome exactly once per run, regardless of %i characters or %i plan steps', async (characters, steps) => {
		const finished: InventoryVaultSyncLastRun[] = [];
		const changesSeen: InventoryVaultSyncRunState[] = [];
		const ports = portsFor({
			refreshAdvisor: vi.fn(async (
				onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
				onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
			) => {
				for (let completed = 0; completed <= characters; completed += 1) {
					onCaptureProgress(captureTick({ accountStores: Math.min(3, completed), characters: completed, charactersTotal: characters }));
				}
				onPhase('preferences'); onPhase('classification');
			}),
			previewSync: vi.fn(async () => planWith(Array.from({ length: steps }, () => 'create' as const))),
			applySync: vi.fn(async (plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => {
				for (let completed = 0; completed <= plan.steps.length; completed += 1) onStep(completed, plan.steps.length);
				return { status: 'applied', created: steps, updated: 0, deactivated: 0 } as const;
			}),
		});
		const controller = new InventoryVaultOneClickSyncController(
			ports, null, (state) => changesSeen.push(state), (outcome) => finished.push(outcome), () => Date.now(),
		);
		await controller.run();
		// The DOM-facing onChange fires many times (once per live tick, by design); the
		// persistence-facing onFinished — the one port `main.ts` wires to `saveData` —
		// fires exactly once, however many characters or plan steps this run had.
		expect(changesSeen.length).toBeGreaterThan(characters);
		expect(finished).toHaveLength(1);
	});

	it('reports the apply phase completed/total straight from the plan the writer settles', async () => {
		const ticks: Array<[number, number]> = [];
		const ports = portsFor({
			previewSync: vi.fn(async () => planWith(['create', 'create', 'update'])),
			applySync: vi.fn(async (plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => {
				for (let completed = 0; completed <= plan.steps.length; completed += 1) onStep(completed, plan.steps.length);
				return { status: 'applied', created: 2, updated: 1, deactivated: 0 } as const;
			}),
		});
		const { controller, changes } = harness(ports);
		await controller.run();
		for (const state of changes) {
			if (state.status === 'running' && state.phase === 'apply') ticks.push([state.completed ?? -1, state.total ?? -1]);
		}
		expect(ticks).toEqual([[0, 3], [0, 3], [1, 3], [2, 3], [3, 3]]);
	});

	it('shows the persisted last run as idle before any click, and keeps it after invalidate/cancel', async () => {
		const lastRun: InventoryVaultSyncLastRun = {
			status: 'success', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 86694,
			summary: { positions: 2909, create: 1616, update: 1167, unchanged: 79, deactivate: 0, conflicts: 0 }, error: null,
		};
		const ports = portsFor();
		const { controller } = harness(ports, lastRun);
		expect(controller.current()).toEqual({ status: 'idle', lastRun });
		controller.invalidate();
		expect(controller.current()).toEqual({ status: 'idle', lastRun });
	});

	it('persists a fresh outcome through onFinished and keeps showing it as the new idle lastRun', async () => {
		const ports = portsFor({
			previewSync: vi.fn(async () => planWith(['create'])),
			applySync: vi.fn(async () => ({ status: 'applied', created: 1, updated: 0, deactivated: 0 } as const)),
		});
		const finished: InventoryVaultSyncLastRun[] = [];
		const { controller } = harness(ports, null, (outcome) => finished.push(outcome));
		const final = await controller.run();
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatchObject({ status: 'success', summary: { create: 1 } });
		expect(final).toEqual({ status: 'idle', lastRun: finished[0] });
	});

	it('redacts a thrown capture failure into a stable, safe error reason', async () => {
		const ports = portsFor({ refreshAdvisor: vi.fn(async () => { throw new Error('403 secret token'); }) });
		const finished: InventoryVaultSyncLastRun[] = [];
		const { controller } = harness(ports, null, (outcome) => finished.push(outcome));
		const final = await controller.run();
		expect(final).toMatchObject({ status: 'idle', lastRun: { status: 'error', error: 'capture_unavailable' } });
		expect(JSON.stringify(finished)).not.toMatch(/secret|403/u);
	});

	it('reports an automatic apply failure as an unexpected write failure, never as capture unavailable', async () => {
		const ports = portsFor({
			previewSync: vi.fn(async () => planWith(['create'])),
			applySync: vi.fn(async () => { throw new Error('vault write failed'); }),
		});
		const { controller } = harness(ports);
		const final = await controller.run();
		expect(final).toMatchObject({ status: 'idle', lastRun: { status: 'error', error: 'unexpected_failure' } });
	});

	it('fails closed before writing when the disabled reason changes during refresh', async () => {
		let disabledReason: 'missing_key' | null = null;
		const finished: InventoryVaultSyncLastRun[] = [];
		const ports = portsFor({
			disabledReason: () => disabledReason,
			refreshAdvisor: vi.fn(async () => { disabledReason = 'missing_key'; }),
		});
		const { controller } = harness(ports, null, (outcome) => finished.push(outcome));
		expect(await controller.run()).toEqual({ status: 'disabled', reason: 'missing_key' });
		expect(ports.applySync).not.toHaveBeenCalled();
		expect(finished).toEqual([]);
	});

	it('does not persist a successful last run when the sync becomes disabled during apply', async () => {
		let disabledReason: 'unsafe_root' | null = null;
		const finished: InventoryVaultSyncLastRun[] = [];
		const ports = portsFor({
			disabledReason: () => disabledReason,
			applySync: vi.fn(async () => {
				disabledReason = 'unsafe_root';
				return { status: 'applied', created: 1, updated: 0, deactivated: 0 } as const;
			}),
		});
		const { controller } = harness(ports, null, (outcome) => finished.push(outcome));
		expect(await controller.run()).toEqual({ status: 'disabled', reason: 'unsafe_root' });
		expect(ports.applySync).toHaveBeenCalledOnce();
		expect(finished).toEqual([]);
	});

	it.each(['missing_key', 'legacy_root', 'unsafe_root'] as const)(
		'reports disabled for %s and never calls a port',
		async (reason) => {
			const ports = portsFor({ disabledReason: () => reason });
			const { controller } = harness(ports);
			expect(controller.current()).toEqual({ status: 'disabled', reason });
			expect(await controller.run()).toEqual({ status: 'disabled', reason });
			expect(ports.refreshAdvisor).not.toHaveBeenCalled();
			expect(ports.previewSync).not.toHaveBeenCalled();
		},
	);

	it('ignores a second run() while already running or awaiting confirmation', async () => {
		const pending = deferred<void>();
		const ports = portsFor({ refreshAdvisor: vi.fn(() => pending.promise) });
		const { controller } = harness(ports);
		const first = controller.run();
		const second = controller.run();
		pending.resolve();
		await Promise.all([first, second]);
		expect(ports.refreshAdvisor).toHaveBeenCalledOnce();
	});

	it('ignores stale completion after dispose', async () => {
		const pending = deferred<InventoryVaultSyncPlan>();
		const ports = portsFor({ previewSync: vi.fn(() => pending.promise) });
		const { controller } = harness(ports);
		const result = controller.run();
		controller.dispose();
		pending.resolve(planWith(['create']));
		expect((await result).status).toBe('disabled');
	});
});

function harness(
	ports: InventoryVaultSyncRunPorts,
	initialLastRun: InventoryVaultSyncLastRun | null = null,
	onFinished: (outcome: InventoryVaultSyncLastRun) => void = () => undefined,
): { controller: InventoryVaultOneClickSyncController; changes: InventoryVaultSyncRunState[] } {
	const changes: InventoryVaultSyncRunState[] = [];
	let clock = 0;
	const controller = new InventoryVaultOneClickSyncController(
		ports, initialLastRun, (state) => changes.push(state), onFinished, () => { clock += 1; return clock; },
	);
	return { controller, changes };
}

function portsFor(overrides: Partial<InventoryVaultSyncRunPorts> = {}): InventoryVaultSyncRunPorts & {
	refreshAdvisor: ReturnType<typeof vi.fn>;
	previewSync: ReturnType<typeof vi.fn>;
	applySync: ReturnType<typeof vi.fn>;
} {
	return {
		disabledReason: overrides.disabledReason ?? (() => null),
		refreshAdvisor: (overrides.refreshAdvisor ?? vi.fn(async (onPhase: (phase: 'capture' | 'preferences' | 'classification') => void) => {
			onPhase('preferences'); onPhase('classification');
		})) as ReturnType<typeof vi.fn>,
		previewSync: (overrides.previewSync ?? vi.fn(async () => planWith(['create']))) as ReturnType<typeof vi.fn>,
		applySync: (overrides.applySync ?? vi.fn(async (_plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void) => {
			onStep(1, 1);
			return { status: 'applied', created: 1, updated: 0, deactivated: 0 } as const;
		})) as ReturnType<typeof vi.fn>,
	};
}

function planWith(
	statuses: InventoryVaultSyncPlan['steps'][number]['status'][],
	canApply = !statuses.includes('conflict'),
): InventoryVaultSyncPlan {
	return {
		schemaVersion: 1,
		root: 'Tyrian Companion',
		capturedAt: '2026-08-25T08:00:00.000Z',
		positions: statuses.length,
		canApply,
		steps: statuses.map((status, index) => ({
			positionId: `${String(index + 1)}-b-account`,
			path: `Tyrian Companion/Inventory/Positions/${String(index + 1)}-b-account.md`,
			status,
			before: status === 'create' ? null : `before-${String(index)}`,
			after: status === 'conflict' ? null : `after-${String(index)}`,
		})),
	};
}

function captureTick(
	values: { accountStores: number; characters: number; charactersTotal: number; catalogAndPrices?: number },
): InventoryVaultSyncCaptureProgress {
	return {
		roster: { completed: 1, total: 1 },
		accountStores: { completed: values.accountStores, total: 3 },
		characters: { completed: values.characters, total: values.charactersTotal },
		catalogAndPrices: { completed: values.catalogAndPrices ?? 0, total: 4 },
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
/* eslint-enable @typescript-eslint/unbound-method -- End intentional Vitest port-spy assertions. */
