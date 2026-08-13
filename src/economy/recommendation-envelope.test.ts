import { describe, expect, it, vi } from 'vitest';

import {
	createRecommendationEnvelope,
	isRecommendationEnvelope,
	type RecommendationDecision,
} from './recommendation-envelope';

describe('recommendation envelope', () => {
	it('builds an exact manual, side-effect-free JSON handoff', () => {
		const decisions: RecommendationDecision[] = [
			{ action: 'reserve', itemId: 999, quantity: 2, explanationRef: '#/recommendation/allocations/reserved/0' },
			{ action: 'hold', itemId: 999, quantity: 3, route: 'listing', explanationRef: '#/recommendation/allocations/held/0' },
			{ action: 'sell', itemId: 999, quantity: 4, route: 'instant_sell', explanationRef: '#/recommendation/explanation' },
		];
		const envelope = createRecommendationEnvelope(decisions);
		expect(envelope).toEqual({
			version: 1,
			kind: 'recommendation',
			execution: 'manual_in_game',
			sideEffects: 'none',
			requiresUserAction: true,
			decisions,
		});
		expect(isRecommendationEnvelope(envelope)).toBe(true);
		expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
	});

	it('isolates the envelope from later mutation of its decision input', () => {
		const decisions: RecommendationDecision[] = [
			{ action: 'open', itemId: 1, quantity: 2, explanationRef: '#/recommendation/explanation' },
		];
		const envelope = createRecommendationEnvelope(decisions)!;
		decisions[0]!.quantity = 99;
		expect(envelope.decisions[0]!.quantity).toBe(2);
	});

	it('accepts every closed action and route variant without adding behavior', () => {
		const decisions: RecommendationDecision[] = [
			{ action: 'open', itemId: 1, quantity: 1, explanationRef: '#/open' },
			{ action: 'sell', itemId: 2, quantity: 1, route: 'instant_sell', explanationRef: '#/sell/instant' },
			{ action: 'sell', itemId: 3, quantity: 1, route: 'vendor', explanationRef: '#/sell/vendor' },
			{ action: 'reserve', itemId: 4, quantity: 1, explanationRef: '#/reserve' },
			{ action: 'hold', itemId: 5, quantity: 1, route: 'instant_sell', explanationRef: '#/hold/instant' },
			{ action: 'hold', itemId: 6, quantity: 1, route: 'listing', explanationRef: '#/hold/listing' },
			{ action: 'review', itemId: 7, quantity: 0, explanationRef: '#/review' },
		];
		expect(createRecommendationEnvelope(decisions)?.decisions).toEqual(decisions);
		expect(createRecommendationEnvelope([
			{ action: 'none', itemId: 1, quantity: 0, explanationRef: '#/none' },
		])).not.toBeNull();
	});

	it('rejects external references, callbacks, secrets, order ids and execution claims', () => {
		const decision = { action: 'sell', itemId: 1, quantity: 1, route: 'vendor', explanationRef: '#/explanation' };
		for (const corrupt of [
			{ ...decision, explanationRef: 'https://example.com/action' },
			{ ...decision, callback: () => undefined },
			{ ...decision, apiKey: 'secret' },
			{ ...decision, orderId: '123' },
			{ ...decision, executed: true },
		]) expect(createRecommendationEnvelope([corrupt])).toBeNull();
	});

	it('rejects malformed quantities, ids, routes and action-specific combinations', () => {
		for (const decision of [
			{ action: 'open', itemId: 1, quantity: 0, explanationRef: '#/x' },
			{ action: 'sell', itemId: 0, quantity: 1, explanationRef: '#/x' },
			{ action: 'hold', itemId: 1, quantity: 1.5, explanationRef: '#/x' },
			{ action: 'hold', itemId: 1, quantity: 1, route: 'mail', explanationRef: '#/x' },
			{ action: 'reserve', itemId: 1, quantity: 1, route: 'vendor', explanationRef: '#/x' },
			{ action: 'open', itemId: 1, quantity: 1, route: 'instant_sell', explanationRef: '#/x' },
			{ action: 'sell', itemId: 1, quantity: 1, explanationRef: '#/x' },
			{ action: 'hold', itemId: 1, quantity: 1, explanationRef: '#/x' },
			{ action: 'hold', itemId: 1, quantity: 1, route: 'vendor', explanationRef: '#/x' },
			{ action: 'sell', itemId: 1, quantity: 1, route: 'listing', explanationRef: '#/x' },
			{ action: 'none', itemId: 1, quantity: 1, explanationRef: '#/x' },
		]) expect(createRecommendationEnvelope([decision])).toBeNull();
	});

	it('rejects duplicate refs, mixed none decisions, extra envelope keys and non-JSON objects', () => {
		const duplicate = { action: 'review', itemId: 1, quantity: 0, explanationRef: '#/review' };
		expect(createRecommendationEnvelope([duplicate, duplicate])).toBeNull();
		expect(createRecommendationEnvelope([
			{ action: 'none', itemId: 1, quantity: 0, explanationRef: '#/none' }, duplicate,
		])).toBeNull();
		const envelope = createRecommendationEnvelope([duplicate])!;
		expect(isRecommendationEnvelope({ ...envelope, executor: 'hidden' })).toBe(false);
		expect(isRecommendationEnvelope(new (class Envelope { version = 1; })())).toBe(false);
		const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile'); } });
		expect(isRecommendationEnvelope(hostile)).toBe(false);
		expect(createRecommendationEnvelope([hostile])).toBeNull();
	});

	it('does not perform I/O while building or validating an envelope', () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		try {
			const envelope = createRecommendationEnvelope([
				{ action: 'review', itemId: 1, quantity: 0, explanationRef: '#/review' },
			]);
			expect(isRecommendationEnvelope(envelope)).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
