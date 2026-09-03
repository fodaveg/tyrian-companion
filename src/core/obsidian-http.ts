import { requestUrl } from 'obsidian';

import { HttpTransportError, ResilientHttpTransport, type TransportOptions } from './http';

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
				refuseOversizedBody(response, request.maxResponseBytes);
				return {
					status: response.status,
					headers: response.headers,
					json: response.json as unknown,
				};
			},
		});
	}
}

/**
 * Refuses to DECODE a body larger than the caller declared, before `json` is read.
 *
 * What this cannot do is stop the download: `requestUrl` has already buffered
 * the whole response by the time it resolves and exposes no abort handle, so a
 * host that answers with gigabytes still costs the transfer. What it does stop
 * is the amplification that follows, and that is where the renderer dies: `json`
 * is a getter that parses on first read, turning megabytes of text into an
 * object graph several times their size, which the parser then walks. So the
 * check goes here, ahead of the property access, and the caller gets the same
 * transport failure it already handles rather than a new outcome to route.
 *
 * `network` and not a status: no server said anything about the size. It is the
 * plugin refusing to read what arrived, and the diagnostic should say so
 * instead of inventing a 413 nobody sent. It is thrown rather than retried for
 * the same reason a timeout is not retried by size: downloading it twice is the
 * worse answer.
 *
 * The body is only MEASURED when a cap was declared, which is why the response
 * is passed whole instead of its length: reading `arrayBuffer` for the many
 * callers that declared none would be work nobody asked for.
 */
function refuseOversizedBody(response: { arrayBuffer: ArrayBuffer }, maxResponseBytes: number | undefined): void {
	if (maxResponseBytes === undefined) return;
	const byteLength = response.arrayBuffer.byteLength;
	if (byteLength <= maxResponseBytes) return;
	throw new HttpTransportError(
		'network',
		null,
		null,
		`Response body of ${String(byteLength)} bytes exceeds the ${String(maxResponseBytes)} byte cap declared for this request.`,
	);
}
