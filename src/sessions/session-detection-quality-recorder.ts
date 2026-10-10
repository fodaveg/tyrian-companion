import type { InactivityStopProposal } from './inactivity-stop-detector';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import {
	compareDetectionQualityEvents,
	createAcceptedDetectionEvent,
	createDismissedDetectionEvent,
	summarizeDetectionQuality,
	summarizeSessionDetectionQuality,
	type DetectionCorrectionCause,
	type AcceptedDetectionSource,
	type DetectionPhase,
	type DetectionQualityEvent,
	type DetectionQualityStats,
	type SessionDetectionQualitySummary,
} from './session-detection-quality';
import { DETECTION_QUALITY_MAX_EVENTS, type DetectionQualityStore } from './session-detection-quality-store';

export type DetectionQualityRecorderState =
	| { status: 'loading' }
	| { status: 'ready' }
	| { status: 'unavailable'; message: string };

/**
 * The measurement in memory, over its store. A store that failed is asked again by the next write (DU-05 review):
 * the store opens a new connection when the engine dropped its own, so `unavailable` lasts until storage answers,
 * not until the plugin is reloaded. Only `dispose()` ends it.
 */
export class DetectionQualityRecorder {
	private readonly events = new Map<string, DetectionQualityEvent>();
	private state: DetectionQualityRecorderState = { status: 'loading' };
	private initializeFlight: Promise<DetectionQualityRecorderState> | null = null;
	/** The store's events are in memory: a later failure is a write's, and the next write needs no load first. */
	private loaded = false;
	private disposed = false;

	/** `maximumEvents` bounds the events kept in memory, the same bound the store keeps (DU-08). */
	constructor(
		private readonly store: DetectionQualityStore,
		private readonly now: () => Date = () => new Date(),
		private readonly maximumEvents = DETECTION_QUALITY_MAX_EVENTS,
	) {}

	initialize(): Promise<DetectionQualityRecorderState> {
		if (this.initializeFlight) return this.initializeFlight;
		if (this.state.status !== 'loading') return Promise.resolve(this.getState());
		return this.load();
	}

	getState(): DetectionQualityRecorderState {
		return structuredClone(this.state);
	}

	getSessionSummary(sessionId: string): SessionDetectionQualitySummary | null {
		if (this.state.status !== 'ready') return null;
		return summarizeSessionDetectionQuality(this.sortedEvents(), sessionId);
	}

	getStats(): DetectionQualityStats | null {
		if (this.state.status !== 'ready') return null;
		return summarizeDetectionQuality(this.sortedEvents());
	}

	async recordAccepted(
		phase: DetectionPhase,
		sessionId: string,
		recordedAt: string,
		source: AcceptedDetectionSource,
	): Promise<boolean> {
		const event = createAcceptedDetectionEvent(phase, sessionId, recordedAt, source);
		return event !== null && await this.append(event);
	}

	async recordDismissed(
		phase: DetectionPhase,
		sessionId: string | null,
		cause: DetectionCorrectionCause,
		proposal: RelevantStartProposal | InactivityStopProposal,
	): Promise<boolean> {
		const event = createDismissedDetectionEvent(phase, sessionId, this.timestamp(), cause, proposal);
		return event !== null && await this.append(event);
	}

	dispose(): void {
		this.disposed = true;
		this.store.close();
		this.state = { status: 'unavailable', message: 'Local detection quality measurement is closed.' };
	}

	/** One load in flight at a time, whoever asks: `initialize()`, or a write after a load that failed. */
	private load(): Promise<DetectionQualityRecorderState> {
		if (this.initializeFlight) return this.initializeFlight;
		const flight = this.initializeInternal().finally(() => {
			if (this.initializeFlight === flight) this.initializeFlight = null;
		});
		this.initializeFlight = flight;
		return flight;
	}

	private async initializeInternal(): Promise<DetectionQualityRecorderState> {
		let loaded: Awaited<ReturnType<DetectionQualityStore['load']>>;
		try {
			loaded = await this.store.load();
		} catch {
			if (this.disposed) return this.getState();
			this.state = {
				status: 'unavailable',
				message: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return this.getState();
		}
		if (this.disposed) return this.getState();
		if (loaded.status === 'error') {
			this.state = {
				status: 'unavailable',
				message: loaded.code === 'corrupt'
					? 'Local detection quality data is corrupt. Session controls still work.'
					: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return this.getState();
		}
		// Anything written before the load answered stays: it is newer than what was stored.
		if (loaded.status === 'loaded') {
			for (const event of loaded.events) {
				if (!this.events.has(event.eventId)) this.events.set(event.eventId, structuredClone(event));
			}
		}
		this.trim();
		this.loaded = true;
		this.state = { status: 'ready' };
		return this.getState();
	}

	/**
	 * Writes `event`. A load that has not succeeded yet, the first or one that failed, is made first; a store that failed
	 * the last write is simply asked again. Whatever it answers sets the state, so the measurement comes back on its own.
	 */
	private async append(event: DetectionQualityEvent): Promise<boolean> {
		if (this.disposed) return false;
		if (!this.loaded) await this.load();
		if (!this.loaded || this.disposed) return false;
		let result: Awaited<ReturnType<DetectionQualityStore['append']>>;
		try {
			result = await this.store.append(event);
		} catch {
			if (this.disposed) return false;
			this.state = {
				status: 'unavailable',
				message: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return false;
		}
		if (this.disposed) return false;
		if (result.status === 'error') {
			this.state = {
				status: 'unavailable',
				message: result.code === 'conflict' || result.code === 'corrupt'
					? 'Local detection quality data is inconsistent. Session controls still work.'
					: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return false;
		}
		this.events.set(event.eventId, structuredClone(event));
		this.trim();
		this.state = { status: 'ready' };
		return true;
	}

	/** DU-08: keeps the newest `maximumEvents` in memory, oldest out first, as the store does on disk. */
	private trim(): void {
		const excess = this.events.size - this.maximumEvents;
		if (excess <= 0) return;
		for (const event of this.sortedEvents().slice(0, excess)) this.events.delete(event.eventId);
	}

	private sortedEvents(): DetectionQualityEvent[] {
		return [...this.events.values()]
			.map((event) => structuredClone(event))
			.sort(compareDetectionQualityEvents);
	}

	private timestamp(): string {
		return this.now().toISOString();
	}
}
