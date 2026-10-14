import { describe, expect, it, vi } from 'vitest';

import { alertSoundDurationMs } from '../../alerts/alert-sound';
import { createHebraAlertSound, encodeWav, HEBRA_ALERT_SOUND_ID, renderAlertChimeWav, type OfflineChimeContextConstructor } from './hebra-alert-sound';

// The chime under Hebra 2.0 (P10): rendered offline, registered once, played by Hebra. What Hebra does with it
// (the sound itself, autoplay, the user's mute switch) is Hebra's and only measurable in a real Hebra.

const param = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };

function offlineContext(samples?: (length: number) => Float32Array) {
	const created: Array<{ channels: number; length: number; sampleRate: number; oscillators: number }> = [];
	const Context = class {
		destination = {};
		readonly record: { channels: number; length: number; sampleRate: number; oscillators: number };
		constructor(channels: number, length: number, sampleRate: number) {
			this.record = { channels, length, sampleRate, oscillators: 0 };
			created.push(this.record);
		}
		createOscillator() { this.record.oscillators += 1; return { type: '', frequency: param, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }; }
		createGain() { return { gain: param, connect: vi.fn() }; }
		async startRendering() {
			return { sampleRate: this.record.sampleRate, getChannelData: () => samples?.(this.record.length) ?? new Float32Array(this.record.length) };
		}
	};
	return { Context: Context as unknown as OfflineChimeContextConstructor, created };
}

describe('encodeWav', () => {
	it('writes a 16-bit PCM mono RIFF/WAVE with the samples clamped', () => {
		const bytes = encodeWav(new Float32Array([0, 1, -1, 2]), 8000);
		const view = new DataView(bytes.buffer);
		const text = (from: number, to: number): string => new TextDecoder().decode(bytes.slice(from, to));
		expect({
			riff: text(0, 4), size: view.getUint32(4, true), wave: text(8, 12), fmt: text(12, 16), pcm: view.getUint16(20, true),
			channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true), data: text(36, 40),
			dataBytes: view.getUint32(40, true), samples: [0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true)),
		}).toEqual({
			riff: 'RIFF', size: 36 + 8, wave: 'WAVE', fmt: 'fmt ', pcm: 1, channels: 1, rate: 8000, bits: 16, data: 'data',
			dataBytes: 8, samples: [0, 32767, -32768, 32767],
		});
	});
});

describe('renderAlertChimeWav', () => {
	it('renders the same two tones as the Obsidian chime, mono at 44.1 kHz, for the whole chime, under 512 KiB', async () => {
		const { Context, created } = offlineContext();
		const wav = await renderAlertChimeWav(Context);
		expect(created).toEqual([{ channels: 1, length: Math.ceil(alertSoundDurationMs() / 1000 * 44_100), sampleRate: 44_100, oscillators: 2 }]);
		expect(wav.byteLength).toBeLessThan(512 * 1024);
	});
});

describe('createHebraAlertSound', () => {
	function api(has = true, play: () => Promise<'played' | 'muted' | 'unavailable'> = async () => 'played') {
		const register = vi.fn(async () => undefined);
		const playSpy = vi.fn(play);
		return {
			api: { has: (name: string) => name === 'notify.sound' && has, notify: { system: vi.fn(), sound: { register, play: playSpy, unregister: vi.fn() } } } as never,
			register,
			play: playSpy,
		};
	}

	it('retries the render and the registration on the next alert after a failure, and reports it', async () => {
		const { Context } = offlineContext();
		const target = api();
		target.register.mockRejectedValueOnce(new Error('quota'));
		const report = vi.fn();
		let now = 0;
		const sound = createHebraAlertSound({ api: target.api, OfflineAudioContext: Context, report, now: () => now });
		expect(sound()).toBe('pending');
		await vi.waitFor(() => { expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota' }), 'notify.sound'); });
		now += 10_000;
		expect(sound()).toBe('pending');
		await vi.waitFor(() => { expect(target.play).toHaveBeenCalledWith(HEBRA_ALERT_SOUND_ID, { volume: 1 }); });
		expect(target.register).toHaveBeenCalledTimes(2);
	});

	it('a play that rejects is reported, and `muted` or `unavailable` from Hebra are not', async () => {
		const { Context } = offlineContext();
		const report = vi.fn();
		let now = 0;
		for (const outcome of ['muted', 'unavailable'] as const) {
			const target = api(true, async () => outcome);
			createHebraAlertSound({ api: target.api, OfflineAudioContext: Context, report, now: () => now })();
			await vi.waitFor(() => { expect(target.play).toHaveBeenCalled(); });
		}
		expect(report).not.toHaveBeenCalled();
		const failing = api(true, () => Promise.reject(new Error('gone')));
		now += 10_000;
		createHebraAlertSound({ api: failing.api, OfflineAudioContext: Context, report, now: () => now })();
		await vi.waitFor(() => { expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'gone' }), 'notify.sound'); });
	});

	it('is unavailable, asking nothing, without notify.sound or a has that throws (reported)', () => {
		const { Context } = offlineContext();
		const off = api(false);
		const report = vi.fn();
		expect(createHebraAlertSound({ api: off.api, OfflineAudioContext: Context, report })()).toBe('unavailable');
		const throwing = { has: () => { throw new Error('boom'); }, notify: off.api } as never;
		expect(createHebraAlertSound({ api: throwing, OfflineAudioContext: Context, report })()).toBe('unavailable');
		expect(off.register).not.toHaveBeenCalled();
		expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), 'notify.sound detection');
	});
});
