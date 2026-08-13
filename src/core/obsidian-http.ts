import { requestUrl } from 'obsidian';

import { ResilientHttpTransport, type TransportOptions } from './http';

type AdapterOptions = Omit<TransportOptions, 'request'>;

/** Wires the resilient transport policy to Obsidian's CORS-free request API. */
export class ObsidianRequestTransport extends ResilientHttpTransport {
	constructor(options: AdapterOptions = {}) {
		super({
			...options,
			request: async (request) => {
				const response = await requestUrl(request);
				return {
					status: response.status,
					headers: response.headers,
					json: response.json as unknown,
				};
			},
		});
	}
}
