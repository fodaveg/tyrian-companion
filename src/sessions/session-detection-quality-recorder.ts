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
import type { DetectionQualityStore } from './session-detection-quality-store';

export type DetectionQualityRecorderState =
	| { status: 'loading' }
	| { status: 'ready' }
	| { status: 'unavailable'; message: string };

export class DetectionQualityRecorder {
	private readonly events = new Map<string, DetectionQualityEvent>();
	private state: DetectionQualityRecorderState = { status: 'loading' };
	private initializeFlight: Promise<DetectionQualityRecorderState> | null = null;

	constructor(
		private readonly store: DetectionQualityStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	initialize(): Promise<DetectionQualityRecorderState> {
		if (this.initializeFlight) return this.initializeFlight;
		if (this.state.status !== 'loading') return Promise.resolve(this.getState());
		const flight = this.initializeInternal().finally(() => {
			if (this.initializeFlight === flight) this.initializeFlight = null;
		});
		this.initializeFlight = flight;
		return flight;
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
		this.store.close();
		this.state = { status: 'unavailable', message: 'Local detection quality measurement is closed.' };
	}

	private async initializeInternal(): Promise<DetectionQualityRecorderState> {
		let loaded: Awaited<ReturnType<DetectionQualityStore['load']>>;
		try {
			loaded = await this.store.load();
		} catch {
			this.state = {
				status: 'unavailable',
				message: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return this.getState();
		}
		if (loaded.status === 'error') {
			this.state = {
				status: 'unavailable',
				message: loaded.code === 'corrupt'
					? 'Local detection quality data is corrupt. Session controls still work.'
					: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return this.getState();
		}
		if (loaded.status === 'loaded') {
			for (const event of loaded.events) this.events.set(event.eventId, structuredClone(event));
		}
		this.state = { status: 'ready' };
		return this.getState();
	}

	private async append(event: DetectionQualityEvent): Promise<boolean> {
		if (this.state.status === 'loading') await this.initialize();
		if (this.state.status !== 'ready') return false;
		let result: Awaited<ReturnType<DetectionQualityStore['append']>>;
		try {
			result = await this.store.append(event);
		} catch {
			this.state = {
				status: 'unavailable',
				message: 'Local detection quality storage is unavailable. Session controls still work.',
			};
			return false;
		}
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
		return true;
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
