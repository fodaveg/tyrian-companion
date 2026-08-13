import { HttpTransportError, type HttpResponse, type HttpTransport } from '../core/http';
import type { ApiKeyProvider } from '../core/secret-provider';

const DEFAULT_API_URL = 'https://api.guildwars2.com/v2';

export class MissingApiKeyError extends Error {
	constructor() {
		super('Select an existing Guild Wars 2 API key in the plugin settings.');
		this.name = 'MissingApiKeyError';
	}
}

export interface GuildWars2Operation {
	request(path: string, retryStatuses?: ReadonlySet<number>): Promise<unknown>;
	requestDetailed(path: string, retryStatuses?: ReadonlySet<number>): Promise<HttpResponse>;
}

/** Creates authenticated operations that pin one ephemeral key value for their full lifetime. */
export class GuildWars2Client {
	constructor(
		private readonly transport: HttpTransport,
		private readonly apiKeyProvider: ApiKeyProvider,
		private readonly apiUrl = DEFAULT_API_URL,
	) {}

	isConfigured(): boolean {
		return this.apiKeyProvider.hasSelection();
	}

	beginOperation(): GuildWars2Operation {
		const apiKey = this.apiKeyProvider.readSelectedApiKey();
		if (!apiKey) {
			throw new MissingApiKeyError();
		}

		return {
			request: (path, retryStatuses = new Set()) =>
				this.requestWithKey(apiKey, path, retryStatuses),
			requestDetailed: (path, retryStatuses = new Set()) =>
				this.requestDetailedWithKey(apiKey, path, retryStatuses),
		};
	}

	private async requestWithKey(
		apiKey: string,
		path: string,
		retryStatuses: ReadonlySet<number>,
	): Promise<unknown> {
		return (await this.requestDetailedWithKey(apiKey, path, retryStatuses)).body;
	}

	private async requestDetailedWithKey(
		apiKey: string,
		path: string,
		retryStatuses: ReadonlySet<number>,
	): Promise<HttpResponse> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.send(apiKey, path);
			} catch (error) {
				if (
					!(error instanceof HttpTransportError) ||
					error.status === null ||
					!retryStatuses.has(error.status) ||
					attempt > 0
				) {
					throw error;
				}
			}
		}

		throw new HttpTransportError('network', null, null, 'Request failed.');
	}

	private send(apiKey: string, path: string): Promise<HttpResponse> {
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
