/**
 * The audible half of an alert, synthesised instead of shipped.
 *
 * A BRAT release is a closed list of three files (`main.js`, `manifest.json`,
 * `styles.css`), so a `.wav` next to them is not a thing this plugin can
 * publish; the only way to ship bytes is to inline them in the bundle. A 32 kB
 * WAV becomes roughly 43 kB of base64 inside `main.js` and stays there for
 * every user forever. Two oscillators cost the code below and zero asset bytes,
 * they are sample-rate independent, and they cannot be corrupted by a bad
 * base64 paste. So: WebAudio, and the WAV fallback the brief allowed stays
 * unused.
 *
 * Nothing here reaches for a global. The context factory is injected so the
 * unit test observes the exact schedule instead of listening to a speaker.
 */

/** Minimal structural slice of WebAudio this module drives. */
export interface AlertAudioParam {
	setValueAtTime(value: number, startTime: number): unknown;
	linearRampToValueAtTime(value: number, endTime: number): unknown;
}

export interface AlertOscillatorNode {
	type: string;
	readonly frequency: AlertAudioParam;
	connect(destination: unknown): unknown;
	start(when: number): void;
	stop(when: number): void;
}

export interface AlertGainNode {
	readonly gain: AlertAudioParam;
	connect(destination: unknown): unknown;
}

export interface AlertAudioContext {
	readonly currentTime: number;
	readonly destination: unknown;
	createOscillator(): AlertOscillatorNode;
	createGain(): AlertGainNode;
	close(): unknown;
}

export type AlertAudioContextFactory = () => AlertAudioContext | null;

export type AlertSoundOutcome = 'played' | 'unavailable';

/**
 * Two rising tones. Short enough not to talk over the game, distinct enough to
 * be told apart from a system chime, and never louder than a third of full
 * scale because the player is wearing headphones in a raid.
 */
const TONES = Object.freeze([
	Object.freeze({ frequency: 880, startsAt: 0, duration: 0.11 }),
	Object.freeze({ frequency: 1_244.51, startsAt: 0.15, duration: 0.13 }),
]);
const PEAK_GAIN = 0.14;
const ATTACK_SECONDS = 0.012;
const TAIL_SECONDS = 0.05;

/** Schedules the alert chime. Returns `unavailable` instead of throwing when there is no audio. */
export function playAlertSound(createContext: AlertAudioContextFactory): AlertSoundOutcome {
	const context = createContext();
	if (context === null) return 'unavailable';
	const start = context.currentTime;
	for (const tone of TONES) {
		const oscillator = context.createOscillator();
		const envelope = context.createGain();
		const toneStart = start + tone.startsAt;
		const toneEnd = toneStart + tone.duration;
		oscillator.type = 'sine';
		oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
		// A square gain edge clicks; the ramp is what makes two beeps sound
		// deliberate rather than like a driver glitch.
		envelope.gain.setValueAtTime(0, toneStart);
		envelope.gain.linearRampToValueAtTime(PEAK_GAIN, toneStart + ATTACK_SECONDS);
		envelope.gain.linearRampToValueAtTime(0, toneEnd);
		oscillator.connect(envelope);
		envelope.connect(context.destination);
		oscillator.start(toneStart);
		oscillator.stop(toneEnd);
	}
	return 'played';
}

/** Total scheduled length, in milliseconds, including the release tail. */
export function alertSoundDurationMs(): number {
	const last = TONES[TONES.length - 1]!;
	return Math.round((last.startsAt + last.duration + TAIL_SECONDS) * 1_000);
}

/**
 * Builds the browser factory. Kept separate from `playAlertSound` so the pure
 * scheduler above never has to know that `window` exists.
 */
export function browserAlertAudioContextFactory(host: unknown): AlertAudioContextFactory {
	return () => {
		const constructor = audioContextConstructor(host);
		if (constructor === null) return null;
		try { return new constructor(); } catch { return null; }
	};
}

type AlertAudioContextConstructor = new () => AlertAudioContext;

function audioContextConstructor(host: unknown): AlertAudioContextConstructor | null {
	if (typeof host !== 'object' || host === null) return null;
	const candidate = (host as Record<string, unknown>).AudioContext ??
		(host as Record<string, unknown>).webkitAudioContext;
	return typeof candidate === 'function' ? candidate as AlertAudioContextConstructor : null;
}
