import { requestUrl } from 'obsidian';

import type { TyrianHttpPort } from '../tyrian-host';

/**
 * `TyrianHttpPort` over Obsidian's CORS-free `requestUrl`, the plugin's one outbound HTTP call.
 *
 * `throw: false`, so a 4xx/5xx resolves with its status and only a transport failure rejects.
 * The body goes back as text (Obsidian decodes it as UTF-8); `HostRequestTransport` in
 * `src/core/http.ts` owns the size cap, the JSON decode, the timeout and the retries.
 */
export function createObsidianHttpPort(): TyrianHttpPort {
	return {
		request: async (request) => {
			const response = await requestUrl({
				url: request.url,
				method: request.method,
				throw: false,
				...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
				...(request.body === undefined ? {} : { body: request.body }),
			});
			return { status: response.status, headers: response.headers, text: response.text };
		},
	};
}
