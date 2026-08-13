export type AdvisorStatus = 'needs-api-key' | 'ready';

export interface AdvisorSnapshot {
	status: AdvisorStatus;
	title: string;
	detail: string;
}

export interface AdvisorReadiness {
	isConfigured(): boolean;
}

/** Reports foundation readiness; recommendation logic deliberately lives in a later vertical. */
export class AdvisorService {
	constructor(private readonly readiness: AdvisorReadiness) {}

	getSnapshot(): AdvisorSnapshot {
		if (!this.readiness.isConfigured()) {
			return {
				status: 'needs-api-key',
				title: 'API key required',
				detail: 'Choose a Guild Wars 2 API key in the plugin settings to prepare account access.',
			};
		}

		return {
			status: 'ready',
			title: 'Foundation ready',
			detail: 'Account sync and recommendations are not enabled in this version.',
		};
	}
}
