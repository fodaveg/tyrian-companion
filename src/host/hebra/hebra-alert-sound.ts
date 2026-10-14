/**
 * The alert chime inside Hebra 2.0 (capability `notify.sound`, SPEC-PLUGINS-EXTERNOS.md §5.5.6, P10).
 *
 * The plugin runs in a frame of its own origin, where an `AudioContext` that starts without a user
 * gesture depends on each webview's autoplay policy; Tyrian's alerts arrive with no gesture at all.
 * So Hebra plays the sound in its own document: the plugin renders the SAME two tones as
 * `alerts/alert-sound.ts` (`scheduleAlertTones`) with an `OfflineAudioContext`, which needs no gesture,
 * encodes them as a WAV once, registers it (`api.notify.sound.register`) and asks Hebra to play it
 * (`api.notify.sound.play`) on every alert.
 *
 * - `TyrianNotifyPort.sound` is synchronous and Hebra answers later, so an accepted chime is
 *   `pending` (heard or not is Hebra's to know); `unavailable` without `notify.sound` (not declared,
 *   not consented, or a Hebra without it) or without `OfflineAudioContext` in the frame;
 * - `muted` (the user silenced the plugin's sounds in Hebra's settings) and `unavailable` from Hebra
 *   are answers, not failures: nothing is reported. A rejection is reported, and a failed render or
 *   registration is tried again on the next alert;
 * - several alerts of one sample arrive together: while the last chime would still be sounding, the
 *   next one is that same sound and is not asked again (as `playAlertSound` does with its context).
 */
import type { HebraPluginApi } from 'hebra-plugin-api/v2';

import { alertSoundDurationMs, scheduleAlertTones, type AlertAudioContext, type AlertSoundOutcome } from '../../alerts/alert-sound';

/** The id the chime is registered under (one per plugin; Hebra keeps up to 16). */
export const HEBRA_ALERT_SOUND_ID = 'tyrian-alert-chime';

/** Mono, 16-bit, 44.1 kHz: the 330 ms chime is ~29 KB, well under Hebra's 512 KiB per sound. */
const SAMPLE_RATE = 44_100;

/** What is used of an `OfflineAudioContext` (injectable for tests). */
export interface OfflineChimeContext extends Pick<AlertAudioContext, 'createOscillator' | 'createGain' | 'destination'> {
	startRendering(): Promise<{ readonly sampleRate: number; getChannelData(channel: number): Float32Array }>;
}

export type OfflineChimeContextConstructor = new (channels: number, length: number, sampleRate: number) => OfflineChimeContext;

/** 16-bit PCM mono WAV of `samples` (each clamped to [-1, 1]). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string): void => {
		for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, samples.length * 2, true);
	for (let index = 0; index < samples.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
		view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
	}
	return bytes;
}

/** Renders the chime offline and returns it as a WAV. */
export async function renderAlertChimeWav(OfflineContext: OfflineChimeContextConstructor): Promise<Uint8Array> {
	const length = Math.ceil((alertSoundDurationMs() / 1_000) * SAMPLE_RATE);
	const context = new OfflineContext(1, length, SAMPLE_RATE);
	scheduleAlertTones(context, 0);
	const buffer = await context.startRendering();
	return encodeWav(buffer.getChannelData(0), buffer.sampleRate);
}

export interface HebraAlertSoundDeps {
	api: Pick<HebraPluginApi, 'has' | 'notify'>;
	/** The frame's `OfflineAudioContext`, or null where there is none. */
	OfflineAudioContext: OfflineChimeContextConstructor | null;
	report(error: unknown, where: string): void;
	/** Tests only: the clock that spaces chimes. */
	now?: () => number;
}

/** The host's `notify.sound()` under Hebra 2.0. */
export function createHebraAlertSound(deps: HebraAlertSoundDeps): () => AlertSoundOutcome {
	const now = deps.now ?? Date.now;
	let registered: Promise<void> | null = null;
	let soundingUntil = 0;
	const available = (): boolean => {
		try {
			return deps.api.has('notify.sound') === true;
		} catch (error) {
			deps.report(error, 'notify.sound detection');
			return false;
		}
	};
	return () => {
		const OfflineContext = deps.OfflineAudioContext;
		if (OfflineContext === null || !available()) return 'unavailable';
		const at = now();
		if (at < soundingUntil) return 'pending';
		soundingUntil = at + alertSoundDurationMs();
		const registration = registered ?? renderAlertChimeWav(OfflineContext)
			.then((bytes) => deps.api.notify.sound.register(HEBRA_ALERT_SOUND_ID, { bytes, mime: 'audio/wav' }));
		if (registered === null) {
			registered = registration;
			// A render or a registration that failed is tried again with the next alert.
			registration.catch(() => { if (registered === registration) registered = null; });
		}
		registration
			.then(() => deps.api.notify.sound.play(HEBRA_ALERT_SOUND_ID, { volume: 1 }))
			// `played`, `muted` (silenced by the user) and `unavailable` are Hebra's answers, never failures.
			.then(() => undefined, (error: unknown) => { deps.report(error, 'notify.sound'); });
		return 'pending';
	};
}
