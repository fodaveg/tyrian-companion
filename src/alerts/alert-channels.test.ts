import { afterEach, describe, expect, it, vi } from 'vitest';

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

	/** Z15: the hosts ask for a factory on every alert, so the context must outlive the call. */
	describe('one context, one chime at a time', () => {
		function countingHost() {
			const built: Array<{ currentTime: number }> = [];
			const oscillators = { count: 0 };
			class FakeContext implements AlertAudioContext {
				currentTime = 0;
				destination = {};
				constructor() { built.push(this); }
				createOscillator() {
					oscillators.count += 1;
					return {
						type: '', frequency: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
						connect: () => undefined, start: () => undefined, stop: () => undefined,
					};
				}
				createGain() {
					return { gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined };
				}
				close() { return undefined; }
			}
			return { host: { AudioContext: FakeContext }, built, oscillators };
		}

		it('opens a single AudioContext however many alerts sound', () => {
			const { host, built } = countingHost();
			for (let alert = 0; alert < 5; alert += 1) {
				for (const context of built) context.currentTime += 10;
				expect(playAlertSound(browserAlertAudioContextFactory(host))).toBe('played');
			}
			expect(built).toHaveLength(1);
		});

		it('does not stack a second chime on one still sounding, then plays again once it ended', () => {
			const { host, built, oscillators } = countingHost();
			expect(playAlertSound(browserAlertAudioContextFactory(host))).toBe('played');
			expect(oscillators.count).toBe(2);

			// Three more alerts of the same sample, 50 ms later: the chime is still going.
			built[0]!.currentTime = 0.05;
			for (let alert = 0; alert < 3; alert += 1) {
				expect(playAlertSound(browserAlertAudioContextFactory(host))).toBe('played');
			}
			expect(oscillators.count, 'a second chime was stacked').toBe(2);

			built[0]!.currentTime = alertSoundDurationMs() / 1_000 + 0.01;
			expect(playAlertSound(browserAlertAudioContextFactory(host))).toBe('played');
			expect(oscillators.count).toBe(4);
		});

		it('resumes a suspended context before the overlap check, and a tone that could not sound is not "played"', async () => {
			const { context, scheduled } = fakeAudioContext();
			// A suspended context keeps its clock stopped: currentTime never moves.
			const suspended = context as { state?: string; resume?: () => Promise<void> };
			suspended.state = 'suspended';
			let resumed = 0;
			let canResume = false;
			suspended.resume = async () => { resumed += 1; await Promise.resolve(); if (canResume) suspended.state = 'running'; };
			const factory = () => context;

			expect(playAlertSound(factory)).toBe('unavailable');
			expect(resumed).toBe(1);
			await flush();
			expect(scheduled.starts, 'a tone was scheduled on a context that stayed suspended').toEqual([]);

			canResume = true;
			expect(playAlertSound(factory), 'the resume call did not make it sound').toBe('unavailable');
			await flush();
			expect(playAlertSound(factory)).toBe('played');
			expect(resumed).toBe(2);
		});

		/** A host whose context is born suspended (Hebra is not Electron): the first alert must still sound. */
		describe('a context that starts suspended', () => {
			function suspendedContext(resume: (state: { state: string }) => Promise<void>) {
				const { context, scheduled } = fakeAudioContext();
				const handle = context as unknown as { state: string; resume: () => Promise<void> };
				handle.state = 'suspended';
				const calls = { resume: 0 };
				handle.resume = async () => { calls.resume += 1; await resume(handle); };
				return { factory: () => context, scheduled, handle, calls };
			}

			it('schedules the tone of the FIRST alert once the resume lands, and reports it as doubtful meanwhile', async () => {
				const { factory, scheduled, calls } = suspendedContext(async (handle) => { handle.state = 'running'; });

				expect(playAlertSound(factory)).toBe('unavailable');
				expect(scheduled.starts).toEqual([]);
				await flush();

				expect(calls.resume).toBe(1);
				expect(scheduled.starts, 'the first alert was lost').toEqual([10, 10.15]);
			});

			it('gives one tone for three alerts that arrive while it resumes', async () => {
				const { factory, scheduled, calls } = suspendedContext(async (handle) => { await Promise.resolve(); handle.state = 'running'; });

				for (let alert = 0; alert < 3; alert += 1) expect(playAlertSound(factory)).toBe('unavailable');
				await flush();

				expect(calls.resume).toBe(1);
				expect(scheduled.frequencies).toEqual([880, 1_244.51]);
			});

			it('leaves nothing pending when resume rejects: no tone, and a later alert on a running context sounds', async () => {
				let reject = true;
				const { factory, scheduled, handle } = suspendedContext(async (state) => {
					if (reject) throw new Error('not allowed to start');
					state.state = 'running';
				});

				expect(playAlertSound(factory)).toBe('unavailable');
				await flush();
				expect(scheduled.starts).toEqual([]);

				reject = false;
				handle.state = 'running';
				expect(playAlertSound(factory)).toBe('played');
				expect(scheduled.starts).toEqual([10, 10.15]);
			});

			it('leaves nothing pending when resume throws at once: the next alert asks again, and sounds', async () => {
				const { factory, scheduled, handle } = suspendedContext(async () => undefined);
				let attempts = 0;
				const resumes = async (): Promise<void> => { attempts += 1; handle.state = 'running'; };
				// Not a rejected promise: a `resume` that throws before returning one (a context the engine already tore down).
				handle.resume = () => { attempts += 1; throw new Error('InvalidStateError'); };

				expect(playAlertSound(factory), 'never thrown at the alert emitter').toBe('unavailable');
				await flush();
				expect(scheduled.starts).toEqual([]);

				handle.resume = resumes;
				expect(playAlertSound(factory)).toBe('unavailable');
				await flush();
				expect(attempts, 'the second alert called resume again instead of finding the factory taken').toBe(2);
				expect(scheduled.starts, 'the factory stayed mute after one resume that threw').toEqual([10, 10.15]);
			});

			it('does not call resume again while the first one is still pending', async () => {
				const { factory, scheduled, calls } = suspendedContext(() => new Promise<void>(() => {}));

				expect(playAlertSound(factory)).toBe('unavailable');
				expect(playAlertSound(factory)).toBe('unavailable');
				await flush();

				expect(calls.resume).toBe(1);
				expect(scheduled.starts).toEqual([]);
			});

			describe('a resume that lands late', () => {
				afterEach(() => { vi.useRealTimers(); });

				function lateResume(landsAfterMs: number) {
					vi.useFakeTimers();
					vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
					let release: () => void = () => {};
					const made = suspendedContext(async (handle) => {
						await new Promise<void>((resolve) => { release = resolve; });
						handle.state = 'running';
					});
					expect(playAlertSound(made.factory)).toBe('unavailable');
					vi.setSystemTime(Date.now() + landsAfterMs);
					release();
					return made;
				}

				it('sounds once when it resolves after 2 s', async () => {
					const { scheduled } = lateResume(2_000);
					await vi.advanceTimersByTimeAsync(0);
					expect(scheduled.starts).toEqual([10, 10.15]);
				});

				it('drops the tone when it resolves after 60 s', async () => {
					const { scheduled } = lateResume(60_000);
					await vi.advanceTimersByTimeAsync(0);
					expect(scheduled.starts).toEqual([]);
				});
			});

			it('waits for a thenable that is not an instance of Promise', async () => {
				const { context, scheduled } = fakeAudioContext();
				const handle = context as unknown as { state: string; resume: () => unknown };
				handle.state = 'suspended';
				let finish: () => void = () => {};
				handle.resume = () => ({ then: (ok: () => void) => { finish = ok; } });
				const factory = () => context;

				expect(playAlertSound(factory)).toBe('unavailable');
				await flush();
				expect(scheduled.starts, 'sounded before the resume resolved').toEqual([]);

				handle.state = 'running';
				finish();
				await flush();
				expect(scheduled.starts).toEqual([10, 10.15]);
			});

			it('tries again from scratch when a resume leaves the context suspended', async () => {
				let works = false;
				const { factory, scheduled, calls } = suspendedContext(async (handle) => { if (works) handle.state = 'running'; });

				playAlertSound(factory);
				await flush();
				works = true;
				playAlertSound(factory);
				await flush();

				expect(calls.resume).toBe(2);
				expect(scheduled.starts).toEqual([10, 10.15]);
			});
		});

		it('replaces a closed context with a new one', () => {
			const { host, built } = countingHost();
			const factory = browserAlertAudioContextFactory(host);
			const first = factory() as { state?: string };
			first.state = 'closed';
			expect(factory()).not.toBe(first);
			expect(built).toHaveLength(2);
		});

		it('never throws toward the alert emitter when the audio graph fails', () => {
			const { context } = fakeAudioContext();
			context.createOscillator = () => { throw new Error('device lost'); };
			expect(playAlertSound(() => context)).toBe('unavailable');
		});
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

async function flush(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}
