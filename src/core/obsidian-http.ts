import { requestUrl } from 'obsidian';

import { ResilientHttpTransport, type TransportOptions } from './http';

type AdapterOptions = Omit<TransportOptions, 'request'>;

/** Wires the resilient transport policy to Obsidian's CORS-free request API. */
export class ObsidianRequestTransport extends ResilientHttpTransport {
	constructor(options: AdapterOptions = {}) {
		super({
			...options,
			request: async (request) => {
				const response = await requestUrl({
					url: request.url,
					method: request.method,
					throw: false,
					...(request.headers === undefined ? {} : { headers: request.headers }),
					...(request.body === undefined ? {} : { body: request.body }),
				});
				return {
					status: response.status,
					headers: response.headers,
					json: response.json as unknown,
				};
			},
		});
	}
}
