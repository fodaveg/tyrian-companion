import type { HttpResponse, HttpTransport } from '../core/http';

const DEFAULT_API_URL = 'https://api.guildwars2.com/v2';

export interface PublicCatalogGateway {
	requestDetailed(path: string): Promise<HttpResponse>;
}

/** Public GW2 transport. It deliberately has no API-key provider or Authorization header. */
export class GuildWars2PublicCatalogClient implements PublicCatalogGateway {
	constructor(
		private readonly transport: HttpTransport,
		private readonly apiUrl = DEFAULT_API_URL,
	) {}

	requestDetailed(path: string): Promise<HttpResponse> {
		if (/^https?:\/\//iu.test(path)) {
			throw new Error('Guild Wars 2 API paths must be relative.');
		}
		return this.transport.send({
			url: `${this.apiUrl.replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`,
			method: 'GET',
		});
	}
}
