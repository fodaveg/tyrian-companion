/**
 * `http` of HebraHost (SPEC-TYRIAN-EN-HEBRA.md §2, SPEC-PLUGINS-EXTERNOS.md §7 and §8.4): the core's
 * request over `api.http`, Hebra's HTTP without CORS.
 *
 * Two kinds of destination:
 * - the two fixed APIs (`api.guildwars2.com`, `api.datawars2.ie`), declared in `network.hosts` of
 *   `hebra.json`: straight to `api.http.request`;
 * - anything else is the alert webhook the user typed in the settings. It is a host nobody knows
 *   when the plugin is published, so `hebra.json` declares `network.userHosts: true` and, before
 *   each call, the plugin asks `api.http.requestUserHost(url)`: the first time Hebra asks the user
 *   («Permitir» / «No permitir») and remembers a yes on this device. A no, an invalid URL (not
 *   `https:`, an IP) or a platform without HTTP fails THAT call with a clear reason, which the
 *   core records as a failed webhook delivery; nothing else breaks.
 *
 * Where Hebra has no plugin HTTP (`api.has('http')` false: the web until its relay exists), every
 * request refuses at once with `module-http-unavailable`, without reaching Hebra.
 */
import type { HebraPluginApi, PluginHttpRequest } from 'hebra-plugin-api';

import type { TyrianHttpPort, TyrianHttpRequest } from '../tyrian-host';

/** The hosts declared in `network.hosts` of `hebra.json`; any other is the webhook. */
export const TYRIAN_FIXED_HOSTS: readonly string[] = ['api.guildwars2.com', 'api.datawars2.ie'];

/** Ceiling when the core sends none (its `core/http.ts` already races its own timer). */
export const TYRIAN_DEFAULT_TIMEOUT_MS = 30_000;

/** Why a webhook request did not leave: the core records the message as the delivery failure. */
export const WEBHOOK_NOT_ALLOWED = 'module-http-webhook-not-allowed';
export const HTTP_UNAVAILABLE = 'module-http-unavailable';

export function isFixedHost(url: string): boolean {
	try {
		return TYRIAN_FIXED_HOSTS.includes(new URL(url).hostname.toLowerCase());
	} catch {
		return false;
	}
}

export function createTyrianHttpPort(api: Pick<HebraPluginApi, 'has' | 'http'>): TyrianHttpPort {
	return {
		async request(request: TyrianHttpRequest) {
			if (!api.has('http')) {
				throw new Error(`${HTTP_UNAVAILABLE}: this Hebra has no plugin HTTP here (the web waits for its relay)`);
			}
			if (!isFixedHost(request.url) && !await api.http.requestUserHost(request.url)) {
				throw new Error(`${WEBHOOK_NOT_ALLOWED}: the user has not allowed this webhook host in Hebra`);
			}
			const input: PluginHttpRequest = {
				url: request.url,
				method: request.method,
				timeoutMs: request.timeout ?? TYRIAN_DEFAULT_TIMEOUT_MS,
			};
			if (request.headers) input.headers = { ...request.headers };
			if (request.body !== undefined) input.body = request.body;
			const response = await api.http.request(input);
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
			return { status: response.status, headers, text: response.text };
		},
	};
}
