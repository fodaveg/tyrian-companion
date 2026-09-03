import { describe, expect, it, vi } from 'vitest';

import {
	alertSoundDurationMs,
	browserAlertAudioContextFactory,
	playAlertSound,
	type AlertAudioContext,
} from './alert-sound';
import {
	hostSystemNotificationConstructor,
	showSystemNotification,
	systemNotificationOptions,
	type SystemNotificationConstructor,
} from './alert-system-notification';

describe('H13.4 sound channel', () => {
	it('schedules two rising tones with a click-free envelope', () => {
		const { context, scheduled } = fakeAudioContext();

		expect(playAlertSound(() => context)).toBe('played');
		expect(scheduled.frequencies).toEqual([880, 1_244.51]);
		expect(scheduled.starts).toEqual([10, 10.15]);
		expect(scheduled.stops).toEqual([10.11, 10.28]);
		// Zero, peak, zero: a square edge on the gain is what clicks.
		expect(scheduled.gains.map(([value]) => value)).toEqual([0, 0.14, 0, 0, 0.14, 0]);
		expect(scheduled.connections).toBe(4);
	});

	it('reports `unavailable` instead of throwing when the host has no audio', () => {
		expect(playAlertSound(() => null)).toBe('unavailable');
		expect(browserAlertAudioContextFactory(undefined)()).toBeNull();
		expect(browserAlertAudioContextFactory({})()).toBeNull();
		expect(browserAlertAudioContextFactory({ AudioContext: function fails() { throw new Error('no device'); } })())
			.toBeNull();
	});

	it('stays short enough not to talk over the game', () => {
		expect(alertSoundDurationMs()).toBeLessThanOrEqual(500);
	});
});

describe('H13.4 system notification channel', () => {
	it('asks for critical urgency on Linux and omits the option everywhere else', () => {
		expect(systemNotificationOptions({ title: 'T', body: 'B', platform: 'linux' }))
			.toEqual({ body: 'B', silent: true, urgency: 'critical' });
		expect(systemNotificationOptions({ title: 'T', body: 'B', platform: 'other' }))
			.toEqual({ body: 'B', silent: true });
	});

	it('constructs the banner with the title and body it was given', () => {
		const calls: unknown[][] = [];
		const constructor = function Notification(...args: unknown[]) { calls.push(args); } as unknown as SystemNotificationConstructor;

		expect(showSystemNotification(constructor, { title: 'Hallazgo', body: 'Bolsa ×3', platform: 'linux' })).toBe('shown');
		expect(calls).toEqual([['Hallazgo', { body: 'Bolsa ×3', silent: true, urgency: 'critical' }]]);
	});

	it('degrades to a status when the API is absent, denied, or throws', () => {
		const input = { title: 'T', body: 'B', platform: 'other' } as const;
		expect(showSystemNotification(null, input)).toBe('unavailable');
		const denied = Object.assign(vi.fn(), { permission: 'denied' }) as unknown as SystemNotificationConstructor;
		expect(showSystemNotification(denied, input)).toBe('denied');
		const throws = function Notification() { throw new Error('no compositor'); } as unknown as SystemNotificationConstructor;
		expect(showSystemNotification(throws, input)).toBe('unavailable');
	});

	it('reads the renderer constructor without assuming the host exposes one', () => {
		expect(hostSystemNotificationConstructor(undefined)).toBeNull();
		expect(hostSystemNotificationConstructor({})).toBeNull();
		const constructor = function Notification() { /* built by the test */ };
		expect(hostSystemNotificationConstructor({ Notification: constructor })).toBe(constructor);
	});
});

function fakeAudioContext() {
	const scheduled = {
		frequencies: [] as number[],
		starts: [] as number[],
		stops: [] as number[],
		gains: [] as [number, number][],
		connections: 0,
	};
	const context: AlertAudioContext = {
		currentTime: 10,
		destination: { id: 'speakers' },
		createOscillator: () => ({
			type: '',
			frequency: {
				setValueAtTime: (value: number) => scheduled.frequencies.push(value),
				linearRampToValueAtTime: () => undefined,
			},
			connect: () => { scheduled.connections += 1; },
			start: (when: number) => scheduled.starts.push(round(when)),
			stop: (when: number) => scheduled.stops.push(round(when)),
		}),
		createGain: () => ({
			gain: {
				setValueAtTime: (value: number, at: number) => scheduled.gains.push([value, round(at)]),
				linearRampToValueAtTime: (value: number, at: number) => scheduled.gains.push([value, round(at)]),
			},
			connect: () => { scheduled.connections += 1; },
		}),
		close: () => undefined,
	};
	return { context, scheduled };
}

function round(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}
