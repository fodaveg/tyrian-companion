import { describe, expect, it } from 'vitest';

import { initialMumbleV2Health, reduceMumbleV2Health } from './mumble-v2-health';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('Mumble v2 health axes', () => {
	it('does not turn a source failure into a channel failure', () => {
		const connected = reduceMumbleV2Health(initialMumbleV2Health(), {
			kind: 'channel', state: 'healthy',
		});
		const unavailable = reduceMumbleV2Health(connected, {
			kind: 'record',
			record: {
				kind: 'heartbeat', version: 1, nonce: NONCE, sequence: 0,
				sourceStatus: 'mapping_unavailable',
			},
		});
		expect(unavailable).toEqual({
			channel: { state: 'healthy', error: null },
			source: 'mapping_unavailable',
			activity: 'unknown',
		});
	});

	it('represents link_stalled only on the activity axis', () => {
		const stalled = reduceMumbleV2Health(initialMumbleV2Health(), {
			kind: 'record',
			record: {
				version: 1, nonce: NONCE, sequence: 4, tick: 7, mapId: 866,
				activity: 'link_stalled',
			},
		});
		expect(stalled.source).toBe('available');
		expect(stalled.activity).toBe('link_stalled');
		expect(stalled.channel.state).toBe('awaiting_bootstrap');
	});

	it('updates channel errors without collapsing the last source diagnosis', () => {
		const sourceFailure = reduceMumbleV2Health(initialMumbleV2Health(), {
			kind: 'record',
			record: {
				kind: 'heartbeat', version: 1, nonce: NONCE, sequence: 0,
				sourceStatus: 'sample_unstable',
			},
		});
		const reconnecting = reduceMumbleV2Health(sourceFailure, {
			kind: 'channel', state: 'reconnect_wait', error: 'heartbeat_timeout',
		});
		expect(reconnecting).toEqual({
			channel: { state: 'reconnect_wait', error: 'heartbeat_timeout' },
			source: 'sample_unstable',
			activity: 'unknown',
		});
	});
});
