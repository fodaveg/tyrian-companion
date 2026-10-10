import { describe, expect, it, vi } from 'vitest';

import { createAcceptedDetectionEvent } from './session-detection-quality';
import { DetectionQualityRecorder } from './session-detection-quality-recorder';
import {
	DETECTION_QUALITY_MAX_EVENTS,
	MemoryDetectionQualityStore,
	type DetectionQualityStore,
} from './session-detection-quality-store';

const NOW = new Date('2026-08-13T12:00:00.000Z');

describe('DetectionQualityRecorder', () => {
	it('loads local events and exposes session and aggregate summaries', async () => {
		const recorder = new DetectionQualityRecorder(new MemoryDetectionQualityStore(), () => NOW);
		await expect(recorder.initialize()).resolves.toEqual({ status: 'ready' });
		await expect(recorder.recordAccepted('start', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(true);
		await expect(recorder.recordAccepted('stop', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(true);
		expect(recorder.getSessionSummary('session-1')).toMatchObject({
			mode: 'manual',
			totalUncertaintyMs: 10_000,
		});
		expect(recorder.getStats()).toMatchObject({ acceptedBoundaries: 2, correctedFalsePositives: 0 });
	});

	it('is idempotent for a repeated accepted boundary', async () => {
		const recorder = new DetectionQualityRecorder(new MemoryDetectionQualityStore(), () => NOW);
		await recorder.initialize();
		await expect(recorder.recordAccepted('start', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(true);
		await expect(recorder.recordAccepted('start', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(true);
		expect(recorder.getStats()?.acceptedBoundaries).toBe(1);
	});

	it('does not block product actions when local measurement is unavailable', async () => {
		const store: DetectionQualityStore = {
			load: vi.fn(async () => ({ status: 'error' as const, code: 'unavailable' as const })),
			append: vi.fn(async () => ({ status: 'error' as const, code: 'unavailable' as const })),
			close: vi.fn(),
		};
		const recorder = new DetectionQualityRecorder(store, () => NOW);
		await expect(recorder.initialize()).resolves.toMatchObject({ status: 'unavailable' });
		await expect(recorder.recordAccepted('start', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(false);
		expect(recorder.getSessionSummary('session-1')).toBeNull();
		expect(recorder.getStats()).toBeNull();
	});

	it('marks measurement unavailable after a conflicting append', async () => {
		const store: DetectionQualityStore = {
			load: vi.fn(async () => ({ status: 'empty' as const })),
			append: vi.fn(async () => ({ status: 'error' as const, code: 'conflict' as const })),
			close: vi.fn(),
		};
		const recorder = new DetectionQualityRecorder(store, () => NOW);
		await recorder.initialize();
		await expect(recorder.recordAccepted('start', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(false);
		expect(recorder.getState()).toMatchObject({ status: 'unavailable' });
	});

	it('contains unexpected storage failures inside the optional measurement layer', async () => {
		const loadFailure = new DetectionQualityRecorder({
			load: vi.fn(async () => { throw new Error('boom'); }),
			append: vi.fn(async () => { throw new Error('boom'); }),
			close: vi.fn(),
		}, () => NOW);
		await expect(loadFailure.initialize()).resolves.toMatchObject({ status: 'unavailable' });

		const appendFailure = new DetectionQualityRecorder({
			load: vi.fn(async () => ({ status: 'empty' as const })),
			append: vi.fn(async () => { throw new Error('boom'); }),
			close: vi.fn(),
		}, () => NOW);
		await appendFailure.initialize();
		await expect(appendFailure.recordAccepted(
			'start',
			'session-1',
			NOW.toISOString(),
			manualBoundary(),
		)).resolves.toBe(false);
		expect(appendFailure.getState()).toMatchObject({ status: 'unavailable' });
	});

	// DU-08: one row that no longer validates used to turn the measurement off for the whole run.
	it('stays ready over a stored row that no longer validates, and keeps measuring', async () => {
		const recorder = new DetectionQualityRecorder(new MemoryDetectionQualityStore([{ version: 1 }]), () => NOW);
		await expect(recorder.initialize()).resolves.toEqual({ status: 'ready' });
		await expect(recorder.recordAccepted('start', 'session-1', NOW.toISOString(), manualBoundary())).resolves.toBe(true);
		expect(recorder.getStats()).toMatchObject({ acceptedBoundaries: 1 });
	});

	// DU-08 review: the database keeps the newest 2,000 events; the copy in memory must not grow past the same bound.
	it('keeps in memory only the newest events up to the same bound as the database', async () => {
		const recorder = new DetectionQualityRecorder(new MemoryDetectionQualityStore(), () => NOW, 3);
		await recorder.initialize();
		for (let minute = 0; minute < 5; minute += 1) {
			const at = new Date(NOW.getTime() + minute * 60_000).toISOString();
			await expect(recorder.recordAccepted('start', `session-${String(minute)}`, at, manualBoundary())).resolves.toBe(true);
		}
		expect(recorder.getStats()).toMatchObject({ acceptedBoundaries: 3 });
		expect(recorder.getSessionSummary('session-1')).toMatchObject({ start: null });
		expect(recorder.getSessionSummary('session-4')).toMatchObject({ start: { sessionId: 'session-4' } });
	});

	it('bounds memory with DETECTION_QUALITY_MAX_EVENTS unless told otherwise', async () => {
		const stored = Array.from({ length: DETECTION_QUALITY_MAX_EVENTS + 1 }, (_, index) => createAcceptedDetectionEvent(
			'start', `session-${String(index)}`, new Date(NOW.getTime() + index * 1_000).toISOString(), manualBoundary(),
		));
		const recorder = new DetectionQualityRecorder(new MemoryDetectionQualityStore(stored), () => NOW);
		await recorder.initialize();
		await expect(recorder.recordAccepted('stop', 'session-x', new Date(NOW.getTime() + 10_000_000).toISOString(), manualBoundary()))
			.resolves.toBe(true);
		expect(recorder.getStats()).toMatchObject({ acceptedBoundaries: DETECTION_QUALITY_MAX_EVENTS });
	});

	it('closes the store on dispose', () => {
		const store = new MemoryDetectionQualityStore();
		const close = vi.spyOn(store, 'close');
		const recorder = new DetectionQualityRecorder(store, () => NOW);
		recorder.dispose();
		expect(close).toHaveBeenCalledOnce();
		expect(recorder.getState()).toMatchObject({ status: 'unavailable' });
	});
});

function manualBoundary() {
	return {
		mode: 'manual' as const,
		window: { from: '2026-08-13T11:59:55.000Z', to: NOW.toISOString() },
	};
}
