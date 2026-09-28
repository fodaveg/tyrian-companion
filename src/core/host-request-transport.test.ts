import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TyrianHttpPort, TyrianHttpRequest, TyrianHttpResponse } from '../host/tyrian-host';
import { HostRequestTransport, HttpTransportError } from './http';

const CAP = 1_024;
const BODY = [{ date: '2026-09-03' }];

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The cap is a promise about what the plugin PARSES, so that is what is measured.
 *
 * The host port hands back text, and `HostRequestTransport` decodes it with `JSON.parse`, the
 * same decode Obsidian's own `json` getter runs. The assertion is that the body's parse never
 * happens: one on the thrown error alone would stay green if the adapter parsed the body first
 * and refused it afterwards, which is the whole cost this exists to avoid: the transfer is
 * already spent by then, the parse is what turns 2.2 MB of text into an object graph many times
 * its size.
 */
describe('response size cap', () => {
	it('refuses to parse a body over the declared cap and never reads it', async () => {
		const probe = sizedBody(CAP + 1);
		const parse = countBodyParses(probe.text);
		const transport = new HostRequestTransport(probe.port, { maxRetries: 2, ...inertTimer() });

		const error = await sendSeedRequest(transport, CAP).catch((thrown: unknown) => thrown);

		expect(parse.count(), 'the oversized body was parsed instead of being refused').toBe(0);
		// Refusing it twice would spend the download twice, which is the cost the
		// cap exists to bound. `maxRetries: 2` above is what makes this an answer.
		expect(probe.requests, 'the oversized answer was fetched more than once').toBe(1);
		expect(error).toBeInstanceOf(HttpTransportError);
		expect((error as HttpTransportError).kind).toBe('network');
		expect((error as HttpTransportError).status).toBeNull();
	});

	it('parses a body of exactly the cap', async () => {
		const probe = sizedBody(CAP);
		const parse = countBodyParses(probe.text);
		const transport = new HostRequestTransport(probe.port, inertTimer());

		const response = await sendSeedRequest(transport, CAP);

		expect(response.body).toEqual(BODY);
		expect(parse.count()).toBe(1);
	});

	/**
	 * The cap counts UTF-8 bytes, the unit the old `arrayBuffer.byteLength` counted, not UTF-16
	 * code units: a body of `CAP` characters with multi-byte ones in it is over a `CAP`-byte cap.
	 */
	it('measures the cap in UTF-8 bytes, not in characters', async () => {
		// 'ñ' is two UTF-8 bytes: about half the cap in characters, over the cap in bytes.
		const probe = bodyOf(JSON.stringify(['ñ'.repeat(CAP / 2 + 10)]));
		expect(probe.text.length).toBeLessThanOrEqual(CAP);
		expect(new TextEncoder().encode(probe.text).byteLength).toBeGreaterThan(CAP);
		const transport = new HostRequestTransport(probe.port, inertTimer());

		const error = await sendSeedRequest(transport, CAP).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(HttpTransportError);
		expect((error as HttpTransportError).kind).toBe('network');
	});

	/**
	 * A body longer (in UTF-16 units) than the cap is over it in UTF-8 bytes too, so it is refused
	 * without encoding a second copy of it: a 300 MB answer must not cost another 300 MB.
	 */
	it('refuses a body longer than the cap on its length alone, without encoding it', async () => {
		const encode = vi.spyOn(TextEncoder.prototype, 'encode');
		const probe = sizedBody(CAP * 10);
		const transport = new HostRequestTransport(probe.port, inertTimer());

		const error = await sendSeedRequest(transport, CAP).catch((thrown: unknown) => thrown);

		expect((error as HttpTransportError).kind).toBe('network');
		expect((error as Error).message).toContain('byte cap');
		expect(encode).not.toHaveBeenCalled();
	});

	/** The count stops being an estimate right at the cap: exactly what `TextEncoder` would say. */
	it.each([
		['ascii', 'plain text'],
		['two-byte', 'ññññ ç'],
		['three-byte', '€ 雪'],
		['surrogate pair', 'bag 🎃 bag'],
		['lone surrogate', 'broken \ud83c here'],
	])('counts a %s body exactly at the cap and one byte under it', async (_kind, content) => {
		const bytes = new TextEncoder().encode(content).byteLength;
		const refusal = async (cap: number): Promise<string> => {
			const transport = new HostRequestTransport(bodyOf(content).port, inertTimer());
			const error = await sendSeedRequest(transport, cap).catch((thrown: unknown) => thrown);
			return error instanceof Error ? error.message : 'no error';
		};
		// At the cap the size check lets it through (the non-JSON text then fails to parse instead).
		expect(await refusal(bytes)).not.toContain('byte cap');
		expect(await refusal(bytes - 1)).toContain('byte cap');
	});

	/**
	 * The control that makes the two above mean something: the same oversized
	 * answer goes through untouched when no cap is declared, so what refuses it
	 * is the number the caller asked for and not the size by itself. Every
	 * ArenaNet route in the plugin declares no cap.
	 */
	it('parses an answer of any size when the caller declares no cap', async () => {
		const probe = sizedBody(CAP * 1_000);
		const parse = countBodyParses(probe.text);
		const transport = new HostRequestTransport(probe.port, inertTimer());

		const response = await transport.send({
			url: 'https://api.guildwars2.com/v2/account/materials',
			method: 'GET',
			endpoint: 'account_materials',
		});

		expect(response.status).toBe(200);
		expect(response.body).toEqual(BODY);
		expect(parse.count()).toBe(1);
	});
});

describe('host port mapping', () => {
	it('hands the port only url, method, headers and body, and returns its status and headers', async () => {
		const seen: TyrianHttpRequest[] = [];
		const port: TyrianHttpPort = {
			request: async (request) => {
				seen.push(request);
				return { status: 200, headers: { 'x-page-total': '3' }, text: '{"ok":true}' };
			},
		};
		const transport = new HostRequestTransport(port, inertTimer());

		const response = await transport.send({
			url: 'https://api.guildwars2.com/v2/account', method: 'POST',
			headers: { Accept: 'application/json' }, body: '{}', endpoint: 'account', maxResponseBytes: CAP,
		});

		expect(seen).toEqual([{
			url: 'https://api.guildwars2.com/v2/account', method: 'POST', headers: { Accept: 'application/json' }, body: '{}',
		}]);
		expect(response).toEqual({ status: 200, headers: { 'x-page-total': '3' }, body: { ok: true } });
	});

	/** Same outcome Obsidian's throwing `json` getter always produced for a body that is not JSON. */
	it('turns a body that is not JSON into a network failure', async () => {
		const port: TyrianHttpPort = { request: async () => ({ status: 502, headers: {}, text: '<html>Bad gateway</html>' }) };
		const transport = new HostRequestTransport(port, { maxRetries: 2, ...inertTimer() });

		const error = await transport.send({ url: 'https://api.guildwars2.com/v2/account', method: 'GET' })
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(HttpTransportError);
		expect((error as HttpTransportError).kind).toBe('network');
		expect((error as HttpTransportError).status).toBeNull();
	});
});

async function sendSeedRequest(transport: HostRequestTransport, maxResponseBytes: number) {
	return await transport.send({
		url: 'https://api.datawars2.ie/gw2/v1/history?itemID=36038',
		method: 'GET',
		endpoint: 'price_history_seed',
		maxResponseBytes,
	});
}

/** `BODY` as JSON of exactly `byteLength` ASCII bytes, padded with trailing whitespace (valid JSON). */
function sizedBody(byteLength: number) {
	return bodyOf(JSON.stringify(BODY).padEnd(byteLength, ' '));
}

/** A port that answers every request with `text` and counts how often it was asked. */
function bodyOf(text: string) {
	const probe = {
		text,
		requests: 0,
		port: {
			request: async (): Promise<TyrianHttpResponse> => {
				probe.requests += 1;
				return { status: 200, headers: {}, text };
			},
		} satisfies TyrianHttpPort,
	};
	return probe;
}

/** Counts `JSON.parse` calls on this exact body; every other parse passes through untouched. */
function countBodyParses(body: string) {
	const original = JSON.parse.bind(JSON);
	let count = 0;
	vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
		if (text === body) count += 1;
		return original(text, reviver) as unknown;
	});
	return { count: () => count };
}

/** Timers that never fire: these tests are about the body, not about the deadline. */
function inertTimer() {
	return { scheduleTimeout: () => 1, cancelTimeout: () => undefined };
}
