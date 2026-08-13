import { requestUrl } from 'obsidian';

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpTransport {
	send(request: HttpRequest): Promise<unknown>;
}

/** Adapts Obsidian's network API so domain clients remain independently testable. */
export class ObsidianRequestTransport implements HttpTransport {
	async send(request: HttpRequest): Promise<unknown> {
		const response = await requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.body,
		});

		return response.json;
	}
}
