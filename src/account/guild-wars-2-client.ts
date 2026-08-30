import {
	HttpTransportError,
	type HttpLogicalEndpoint,
	type HttpResponse,
	type HttpTransport,
} from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import type { ApiKeyProvider } from '../core/secret-provider';

export const OFFICIAL_GW2_API_URL = 'https://api.guildwars2.com/v2';

export class MissingApiKeyError extends Error {
	constructor() {
		super('Select an existing Guild Wars 2 API key in the plugin settings.');
		this.name = 'MissingApiKeyError';
	}
}

export interface GuildWars2Operation {
	request(
		path: string,
		retryStatuses?: ReadonlySet<number>,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<unknown>;
	requestDetailed(
		path: string,
		retryStatuses?: ReadonlySet<number>,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<HttpResponse>;
}

/** Creates authenticated operations that pin one ephemeral key value for their full lifetime. */
export class GuildWars2Client {
	constructor(
		private readonly transport: HttpTransport,
		private readonly apiKeyProvider: ApiKeyProvider,
	) {}

	isConfigured(): boolean {
		return this.apiKeyProvider.hasSelection();
	}

	beginOperation(actionContext?: ResolvedLocalDebugActionContext): GuildWars2Operation {
		const apiKey = this.apiKeyProvider.readSelectedApiKey();
		if (!apiKey) {
			throw new MissingApiKeyError();
		}

		return {
			request: (path, retryStatuses = new Set(), requestContext) =>
				this.requestWithKey(apiKey, path, retryStatuses, requestContext ?? actionContext),
			requestDetailed: (path, retryStatuses = new Set(), requestContext) =>
				this.requestDetailedWithKey(apiKey, path, retryStatuses, requestContext ?? actionContext),
		};
	}

	private async requestWithKey(
		apiKey: string,
		path: string,
		retryStatuses: ReadonlySet<number>,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<unknown> {
		return (await this.requestDetailedWithKey(apiKey, path, retryStatuses, actionContext)).body;
	}

	private async requestDetailedWithKey(
		apiKey: string,
		path: string,
		retryStatuses: ReadonlySet<number>,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<HttpResponse> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.send(apiKey, path, actionContext);
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

	private send(
		apiKey: string,
		path: string,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<HttpResponse> {
		const request = {
			url: this.buildUrl(path),
			method: 'GET' as const,
			endpoint: guildWars2LogicalEndpoint(path),
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		};
		return actionContext === undefined
			? this.transport.send(request)
			: this.transport.send(request, actionContext);
	}

	private buildUrl(path: string): string {
		if (/^https?:\/\//iu.test(path)) {
			throw new Error('Guild Wars 2 API paths must be relative.');
		}

		return `${OFFICIAL_GW2_API_URL}/${path.replace(/^\//u, '')}`;
	}
}

/** Maps reviewed GW2 routes to a closed diagnostic identifier without retaining route parameters. */
export function guildWars2LogicalEndpoint(path: string): HttpLogicalEndpoint {
	const route = path.split('?', 1)[0]?.replace(/^\/+|\/+$/gu, '') ?? '';
	switch (route) {
		case 'tokeninfo': return 'token_info';
		case 'account': return 'account';
		case 'characters': return 'characters';
		case 'account/bank': return 'account_bank';
		case 'account/materials': return 'account_materials';
		case 'account/inventory': return 'account_inventory';
		case 'account/wallet': return 'account_wallet';
		case 'commerce/delivery': return 'commerce_delivery';
		case 'account/skins': return 'account_skins';
		case 'account/minis': return 'account_minis';
		case 'account/recipes': return 'account_recipes';
		case 'account/achievements': return 'account_achievements';
		default:
			if (/^characters\/[^/]+\/inventory$/u.test(route)) return 'character_inventory';
			if (/^characters\/[^/]+\/buildtabs\/active$/u.test(route)) return 'character_build';
			if (/^commerce\/transactions\/current\/(?:buys|sells)$/u.test(route)) return 'commerce_transactions_current';
			if (/^commerce\/transactions\/history\/(?:buys|sells)$/u.test(route)) return 'commerce_transactions_history';
			return 'unknown';
	}
}
