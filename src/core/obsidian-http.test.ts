import { afterEach, describe, expect, it } from 'vitest';

import { HttpTransportError } from './http';
import { ObsidianRequestTransport } from './obsidian-http';
// Vitest aliases `obsidian` onto this same module, so the responder drives what
// `obsidian-http.ts` receives from `requestUrl`.
import { setMockRequestUrl, type MockRequestUrlResponse } from '../test/obsidian-mock';

const CAP = 1_024;

afterEach(() => {
	setMockRequestUrl(null);
});

/**
 * The cap is a promise about what the plugin PARSES, so that is what is measured.
 *
 * `json` is answered by a getter that counts its reads, exactly like the real
 * `RequestUrlResponse`, and the assertion is that the count stays at zero. An
 * assertion on the thrown error alone would stay green if the adapter parsed
 * the body first and refused it afterwards, which is the whole cost this exists
 * to avoid: the transfer is already spent by then, the parse is what turns 2.2
 * MB of text into an object graph many times its size.
 */
describe('response size cap', () => {
	it('refuses to parse a body over the declared cap and never reads it', async () => {
		const probe = countedBody(CAP + 1);
		setMockRequestUrl(probe.responder);
		const transport = new ObsidianRequestTransport({ maxRetries: 2, ...inertTimer() });

		const error = await sendSeedRequest(transport, CAP).catch((thrown: unknown) => thrown);

		expect(probe.jsonReads, 'the oversized body was parsed instead of being refused').toBe(0);
		// Refusing it twice would spend the download twice, which is the cost the
		// cap exists to bound. `maxRetries: 2` above is what makes this an answer.
		expect(probe.requests, 'the oversized answer was fetched more than once').toBe(1);
		expect(error).toBeInstanceOf(HttpTransportError);
		expect((error as HttpTransportError).kind).toBe('network');
		expect((error as HttpTransportError).status).toBeNull();
	});

	it('parses a body of exactly the cap', async () => {
		const probe = countedBody(CAP);
		setMockRequestUrl(probe.responder);
		const transport = new ObsidianRequestTransport(inertTimer());

		const response = await sendSeedRequest(transport, CAP);

		expect(response.body).toEqual([{ date: '2026-09-03' }]);
		expect(probe.jsonReads).toBe(1);
	});

	/**
	 * The control that makes the two above mean something: the same oversized
	 * answer goes through untouched when no cap is declared, so what refuses it
	 * is the number the caller asked for and not the size by itself. Every
	 * ArenaNet route in the plugin declares no cap.
	 */
	it('parses an answer of any size when the caller declares no cap', async () => {
		const probe = countedBody(CAP * 1_000);
		setMockRequestUrl(probe.responder);
		const transport = new ObsidianRequestTransport(inertTimer());

		const response = await transport.send({
			url: 'https://api.guildwars2.com/v2/account/materials',
			method: 'GET',
			endpoint: 'account_materials',
		});

		expect(response.status).toBe(200);
		expect(response.body).toEqual([{ date: '2026-09-03' }]);
		expect(probe.jsonReads).toBe(1);
	});
});

async function sendSeedRequest(transport: ObsidianRequestTransport, maxResponseBytes: number) {
	return await transport.send({
		url: 'https://api.datawars2.ie/gw2/v1/history?itemID=36038',
		method: 'GET',
		endpoint: 'price_history_seed',
		maxResponseBytes,
	});
}

/** A response of `byteLength` bytes whose `json` getter records every read. */
function countedBody(byteLength: number) {
	const probe = {
		jsonReads: 0,
		requests: 0,
		responder: (): MockRequestUrlResponse => {
			probe.requests += 1;
			return {
				status: 200,
				headers: {},
				arrayBuffer: new ArrayBuffer(byteLength),
				get json(): unknown {
					probe.jsonReads += 1;
					return [{ date: '2026-09-03' }];
				},
			};
		},
	};
	return probe;
}

/** Timers that never fire: these tests are about the body, not about the deadline. */
function inertTimer() {
	return { scheduleTimeout: () => 1, cancelTimeout: () => undefined };
}
