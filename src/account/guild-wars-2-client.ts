import type { ApiKeyProvider } from '../core/secret-provider';
import type { HttpTransport } from '../core/http';

const DEFAULT_API_URL = 'https://api.guildwars2.com/v2';

export class MissingApiKeyError extends Error {
	constructor() {
		super('Select a Guild Wars 2 API key in the Tyrian Companion settings.');
		this.name = 'MissingApiKeyError';
	}
}

/** Minimal authenticated client. No requests run until a feature explicitly calls request. */
export class GuildWars2Client {
	constructor(
		private readonly transport: HttpTransport,
		private readonly apiKeyProvider: ApiKeyProvider,
		private readonly apiUrl = DEFAULT_API_URL,
	) {}

	isConfigured(): boolean {
		return this.apiKeyProvider.hasSelection();
	}

	async request(path: string): Promise<unknown> {
		const apiKey = this.apiKeyProvider.getApiKey();
		if (!apiKey) {
			throw new MissingApiKeyError();
		}

		return this.transport.send({
			url: this.buildUrl(path),
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});
	}

	private buildUrl(path: string): string {
		if (/^https?:\/\//iu.test(path)) {
			throw new Error('Guild Wars 2 API paths must be relative.');
		}

		return `${this.apiUrl.replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`;
	}
}
