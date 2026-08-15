import { describe, expect, it } from 'vitest';

import { MumbleV2ShadowObservation } from './mumble-v2-observation';

const FRAME = {
	version: 1,
	nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
	sequence: 8,
	tick: 99,
	mapId: 866,
	activity: 'link_stalled',
} as const;

describe('MumbleV2ShadowObservation', () => {
	it('requires both enabled and armed before observing', () => {
		const observation = new MumbleV2ShadowObservation();
		expect(observation.observe(FRAME)).toBeNull();
		observation.configure({ enabled: true, armed: false });
		expect(observation.observe(FRAME)).toBeNull();
		observation.configure({ enabled: false, armed: true });
		expect(observation.observe(FRAME)).toBeNull();
		observation.configure({ enabled: true, armed: true });
		expect(observation.observe(FRAME)).toEqual({ mapId: 866, activity: 'link_stalled' });
	});

	it('retains only mapId and activity in memory and clears on disarm', () => {
		const observation = new MumbleV2ShadowObservation();
		observation.configure({ enabled: true, armed: true });
		observation.observe(FRAME);
		expect(Object.keys(observation.getSnapshot() ?? {}).sort()).toEqual(['activity', 'mapId']);
		expect(JSON.stringify(observation.getSnapshot())).not.toMatch(/nonce|sequence|tick/u);
		observation.configure({ enabled: true, armed: false });
		expect(observation.getSnapshot()).toBeNull();
	});

	it('returns copies so callers cannot mutate the retained projection', () => {
		const observation = new MumbleV2ShadowObservation();
		observation.configure({ enabled: true, armed: true });
		const projected = observation.observe(FRAME)!;
		projected.mapId = 1;
		expect(observation.getSnapshot()).toEqual({ mapId: 866, activity: 'link_stalled' });
	});
});
