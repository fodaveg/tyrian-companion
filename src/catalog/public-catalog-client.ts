import type { HttpLogicalEndpoint, HttpResponse, HttpTransport } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';

const DEFAULT_API_URL = 'https://api.guildwars2.com/v2';

export interface PublicCatalogGateway {
	requestDetailed(
		path: string,
		actionContext?: ResolvedLocalDebugActionContext,
		/** Item ids this request covers, carried through to `HttpRequest.diagnosticItemIds`. See there for why. */
		diagnosticItemIds?: readonly number[],
	): Promise<HttpResponse>;
}

/** Public GW2 transport. It deliberately has no API-key provider or Authorization header. */
export class GuildWars2PublicCatalogClient implements PublicCatalogGateway {
	constructor(
		private readonly transport: HttpTransport,
		private readonly apiUrl = DEFAULT_API_URL,
	) {}

	requestDetailed(
		path: string,
		actionContext?: ResolvedLocalDebugActionContext,
		diagnosticItemIds?: readonly number[],
	): Promise<HttpResponse> {
		if (/^https?:\/\//iu.test(path)) {
			throw new Error('Guild Wars 2 API paths must be relative.');
		}
		const request = {
			url: `${this.apiUrl.replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`,
			method: 'GET' as const,
			endpoint: publicCatalogLogicalEndpoint(path),
			...(diagnosticItemIds === undefined ? {} : { diagnosticItemIds }),
		};
		return actionContext === undefined
			? this.transport.send(request)
			: this.transport.send(request, actionContext);
	}
}

/** Maps the three reviewed public-catalog families without retaining IDs, locale or schema queries. */
export function publicCatalogLogicalEndpoint(path: string): HttpLogicalEndpoint {
	const route = path.split('?', 1)[0]?.replace(/^\/+|\/+$/gu, '') ?? '';
	if (route === 'items') return 'items';
	if (route === 'currencies') return 'currencies';
	if (route === 'materials') return 'material_categories';
	if (route === 'commerce/prices') return 'commerce_prices';
	if (route === 'commerce/listings') return 'commerce_listings';
	if (route === 'recipes/search') return 'recipes_search';
	return 'unknown';
}
