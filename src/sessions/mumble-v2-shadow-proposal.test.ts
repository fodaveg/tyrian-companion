import { describe, expect, it } from 'vitest';

import type { MumbleV2PresenceSignal } from '../platform/mumble-v2-presence-policy';
import { createMumbleV2ShadowProposal, isMumbleV2ShadowProposal } from './mumble-v2-shadow-proposal';

const FROM = Date.parse('2026-10-20T18:00:00.000Z');
const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('H8.8 Mumble shadow proposal DTO', () => {
	it('creates a minimal human-only start proposal with limited evidence', () => {
		const signal = presence();
		const before = structuredClone(signal);
		const proposal = createMumbleV2ShadowProposal(signal, {
			createProposalId: () => UUID,
		});
		expect(proposal).toEqual({
			version: 1,
			source: 'mumble_v2_shadow',
			phase: 'start',
			proposalId: UUID,
			accountId: 'account-a',
			targetMapId: 866,
			binding: { kind: 'idle' },
			window: {
				from: '2026-10-20T18:00:00.000Z',
				to: '2026-10-20T18:00:05.000Z',
				uncertaintyMs: 5_000,
			},
			thresholdMs: 5_000,
			detectedAt: '2026-10-20T18:00:05.000Z',
			continuity: 'continuous',
			evidenceQuality: 'limited',
			rollout: 'shadow',
			retention: 'none',
			review: 'human_required',
			effect: 'proposal_only',
		});
		expect(signal).toEqual(before);
		expect(isMumbleV2ShadowProposal(proposal)).toBe(true);
	});

	it('keeps an exact active-session binding for stop review', () => {
		const proposal = createMumbleV2ShadowProposal(absence(), {
			createProposalId: () => UUID,
		});
		expect(proposal).toMatchObject({
			phase: 'stop',
			thresholdMs: 60_000,
			binding: { kind: 'session', sessionId: 'session-a', baselineSnapshotId: 'snapshot-a' },
			continuity: 'degraded',
		});
		expect(isMumbleV2ShadowProposal(proposal)).toBe(true);
	});

	it('fails closed before requesting an id for invalid bound account, signal or window', () => {
		let calls = 0;
		const createProposalId = () => { calls += 1; return UUID; };
		expect(createMumbleV2ShadowProposal({
			...presence(), binding: { kind: 'idle', accountId: '' },
		}, { createProposalId })).toBeNull();
		expect(createMumbleV2ShadowProposal({ ...presence(), targetMapId: 1 } as unknown as MumbleV2PresenceSignal,
			{ createProposalId })).toBeNull();
		expect(createMumbleV2ShadowProposal({
			...presence(), window: { fromMs: FROM, toMs: FROM + 4_999 },
		}, { createProposalId })).toBeNull();
		expect(calls).toBe(0);
	});

	it('rejects invalid generated ids and contains no raw transport or activity fields', () => {
		for (const proposalId of ['', 'not-a-uuid', '123e4567-e89b-12d3-a456-426614174000']) {
			expect(createMumbleV2ShadowProposal(presence(), {
				createProposalId: () => proposalId,
			})).toBeNull();
		}
		const proposal = createMumbleV2ShadowProposal(presence(), {
			createProposalId: () => UUID,
		});
		const serialized = JSON.stringify(proposal);
		for (const rawField of ['nonce', 'sequence', 'tick', 'activity', 'raw', 'frame']) {
			expect(serialized).not.toContain(JSON.stringify(rawField));
		}
	});

	it('rejects extra fields, altered authority literals and inconsistent phase bindings', () => {
		const proposal = createMumbleV2ShadowProposal(presence(), {
			createProposalId: () => UUID,
		});
		expect(proposal).not.toBeNull();
		for (const changed of [
			{ ...proposal, raw: true },
			{ ...proposal, proposalId: 'not-a-uuid' },
			{ ...proposal, review: 'automatic' },
			{ ...proposal, effect: 'start_session' },
			{ ...proposal, evidenceQuality: 'complete' },
			{ ...proposal, rollout: 'active' },
			{ ...proposal, retention: 'indexeddb' },
			{ ...proposal, binding: { kind: 'session', sessionId: 's', baselineSnapshotId: 'b' } },
			{ ...proposal, thresholdMs: 60_000 },
			{ ...proposal, window: {
				from: '2026-10-20T18:00:00.000Z',
				to: '2026-10-20T18:00:04.999Z',
				uncertaintyMs: 4_999,
			}, detectedAt: '2026-10-20T18:00:04.999Z' },
		]) expect(isMumbleV2ShadowProposal(changed), JSON.stringify(changed)).toBe(false);
	});
});

function presence(): MumbleV2PresenceSignal {
	return {
		version: 1,
		phase: 'presence',
		targetMapId: 866,
		thresholdMs: 5_000,
		window: { fromMs: FROM, toMs: FROM + 5_000 },
		continuity: 'continuous',
		binding: { kind: 'idle', accountId: 'account-a' },
	};
}

function absence(): MumbleV2PresenceSignal {
	return {
		version: 1,
		phase: 'absence',
		targetMapId: 866,
		thresholdMs: 60_000,
		window: { fromMs: FROM, toMs: FROM + 60_000 },
		continuity: 'degraded',
		binding: {
			kind: 'session', accountId: 'account-a', sessionId: 'session-a', baselineSnapshotId: 'snapshot-a',
		},
	};
}
