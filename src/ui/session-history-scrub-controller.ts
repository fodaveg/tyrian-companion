import type {
	SessionHistoryScrubPreview,
	SessionHistoryScrubResult,
} from '../sessions/session-history';

export type SessionHistoryScrubWorkflowResult =
	| { status: 'preview_rejected'; preview: Exclude<SessionHistoryScrubPreview, { status: 'ready' }> }
	| { status: 'cancelled'; preview: Extract<SessionHistoryScrubPreview, { status: 'ready' }> }
	| {
		status: 'completed';
		preview: Extract<SessionHistoryScrubPreview, { status: 'ready' }>;
		result: SessionHistoryScrubResult;
	};

export interface SessionHistoryScrubControllerPorts {
	preview(): Promise<SessionHistoryScrubPreview>;
	confirm(preview: Extract<SessionHistoryScrubPreview, { status: 'ready' }>): Promise<boolean>;
	cancelPreview(token: string): void;
	scrub(token: string): Promise<SessionHistoryScrubResult>;
}

/** Owns the whole destructive UI flight, including its preview and confirmation. */
export class SessionHistoryScrubController {
	private flight: Promise<SessionHistoryScrubWorkflowResult> | null = null;

	constructor(private readonly ports: SessionHistoryScrubControllerPorts) {}

	run(): Promise<SessionHistoryScrubWorkflowResult> {
		if (this.flight) return this.flight;
		const flight = Promise.resolve().then(async (): Promise<SessionHistoryScrubWorkflowResult> => {
			const preview = await this.ports.preview();
			if (preview.status !== 'ready') return { status: 'preview_rejected', preview };
			if (!await this.ports.confirm(preview)) {
				this.ports.cancelPreview(preview.token);
				return { status: 'cancelled', preview };
			}
			return { status: 'completed', preview, result: await this.ports.scrub(preview.token) };
		}).finally(() => {
			if (this.flight === flight) this.flight = null;
		});
		this.flight = flight;
		return flight;
	}
}
