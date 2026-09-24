import { describe, expect, it } from 'vitest';

import {
	API_SETTLEMENT_STALE_AFTER_MS,
	API_SETTLEMENT_WINDOW_BY_ENDPOINT_MS,
	API_SETTLEMENT_WINDOW_MS,
	captureSettlement,
	SETTLEMENT_ENDPOINTS,
	settlementRemainingSeconds,
	settlementWait,
	settlementWindowMs,
} from './session-api-settlement';

const STOP_REQUESTED_AT = '2026-08-13T09:00:00.000Z';
const requestedAt = Date.parse(STOP_REQUESTED_AT);

describe('session API settlement window', () => {
	it('waits the documented Guild Wars 2 cache ceiling of ten minutes', () => {
		expect(API_SETTLEMENT_WINDOW_MS).toBe(600_000);
		expect(API_SETTLEMENT_STALE_AFTER_MS).toBeGreaterThan(API_SETTLEMENT_WINDOW_MS);
	});

	it('counts down from the stop request and only becomes due at the window', () => {
		expect(settlementWait(STOP_REQUESTED_AT, requestedAt)).toEqual({
			status: 'waiting',
			windowMs: API_SETTLEMENT_WINDOW_MS,
			waitedMs: 0,
			remainingMs: API_SETTLEMENT_WINDOW_MS,
			dueAt: requestedAt + API_SETTLEMENT_WINDOW_MS,
		});
		expect(settlementWait(STOP_REQUESTED_AT, requestedAt + API_SETTLEMENT_WINDOW_MS - 1))
			.toMatchObject({ status: 'waiting', remainingMs: 1 });
		expect(settlementWait(STOP_REQUESTED_AT, requestedAt + API_SETTLEMENT_WINDOW_MS))
			.toMatchObject({ status: 'due', remainingMs: 0 });
	});

	it('never shortens the wait when the local clock jumps backwards', () => {
		expect(settlementWait(STOP_REQUESTED_AT, requestedAt - 3_600_000))
			.toMatchObject({ status: 'waiting', waitedMs: 0, remainingMs: API_SETTLEMENT_WINDOW_MS });
	});

	it('H18.11: keeps the wait per endpoint, every one at the unmeasured ten-minute ceiling', () => {
		expect(SETTLEMENT_ENDPOINTS).toHaveLength(6);
		for (const endpoint of SETTLEMENT_ENDPOINTS) {
			expect(API_SETTLEMENT_WINDOW_BY_ENDPOINT_MS[endpoint]).toBe(API_SETTLEMENT_WINDOW_MS);
		}
		expect(settlementWindowMs()).toBe(API_SETTLEMENT_WINDOW_MS);
	});

	it('H18.11: waits for the slowest endpoint the capture reads, never the fastest', () => {
		expect(settlementWindowMs({ account_wallet: 120_000 })).toBe(API_SETTLEMENT_WINDOW_MS);
		expect(settlementWindowMs({ account_bank: 900_000 })).toBe(900_000);
		const allAtTwoMinutes = Object.fromEntries(SETTLEMENT_ENDPOINTS.map((endpoint) => [endpoint, 120_000]));
		expect(settlementWindowMs(allAtTwoMinutes)).toBe(120_000);
	});

	it('H18.11: ignores an override that could shorten the wait by accident', () => {
		const broken = Object.fromEntries(SETTLEMENT_ENDPOINTS.map((endpoint) => [endpoint, -1]));
		expect(settlementWindowMs(broken)).toBe(API_SETTLEMENT_WINDOW_MS);
		expect(settlementWindowMs({ account_bank: Number.NaN, account_wallet: 1.5 })).toBe(API_SETTLEMENT_WINDOW_MS);
	});

	it('refuses to project a wait from an unusable boundary', () => {
		expect(settlementWait('not-a-date', requestedAt)).toBeNull();
		expect(settlementWait(STOP_REQUESTED_AT, Number.NaN)).toBeNull();
	});

	it('declares a capture settled, skipped or exceeded by how long it waited', () => {
		const at = (offsetMs: number): string => new Date(requestedAt + offsetMs).toISOString();
		expect(captureSettlement(STOP_REQUESTED_AT, at(0))).toBe('skipped');
		expect(captureSettlement(STOP_REQUESTED_AT, at(API_SETTLEMENT_WINDOW_MS - 1))).toBe('skipped');
		expect(captureSettlement(STOP_REQUESTED_AT, at(API_SETTLEMENT_WINDOW_MS))).toBe('settled');
		expect(captureSettlement(STOP_REQUESTED_AT, at(API_SETTLEMENT_STALE_AFTER_MS))).toBe('settled');
		expect(captureSettlement(STOP_REQUESTED_AT, at(API_SETTLEMENT_STALE_AFTER_MS + 1))).toBe('exceeded');
	});

	it('treats an unreadable boundary as a capture that did not wait', () => {
		expect(captureSettlement('not-a-date', STOP_REQUESTED_AT)).toBe('skipped');
		expect(captureSettlement(STOP_REQUESTED_AT, 'not-a-date')).toBe('skipped');
	});

	it('rounds the countdown up so it never reads zero while it is still waiting', () => {
		const wait = settlementWait(STOP_REQUESTED_AT, requestedAt + API_SETTLEMENT_WINDOW_MS - 1);
		expect(wait).not.toBeNull();
		expect(settlementRemainingSeconds(wait!)).toBe(1);
	});
});
