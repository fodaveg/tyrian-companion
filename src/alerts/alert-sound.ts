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
	readonly state?: string;
	resume?(): unknown;
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

/**
 * When the chime each factory last scheduled ends, on its own context's clock. Keyed by the
 * factory so a host that keeps one factory (`browserAlertAudioContextFactory` does) shares it, and
 * a test that hands a fresh arrow each time never sees another test's state.
 */
const chimes = new WeakMap<AlertAudioContextFactory, { context: AlertAudioContext; endsAt: number }>();

/**
 * Schedules the alert chime. Returns `unavailable` instead of throwing when there is no audio, and
 * never throws at all: an audio failure must not reach the alert emitter, which would count the
 * whole channel as failed. Several alerts of one sample arrive together: while a chime is still
 * sounding the next one is the same sound, so it is not stacked on top and reports `played`.
 */
export function playAlertSound(createContext: AlertAudioContextFactory): AlertSoundOutcome {
	try {
		return scheduleChime(createContext);
	} catch {
		return 'unavailable';
	}
}

/** Factories with a tone waiting for their suspended context to resume: at most one each. */
const resuming = new WeakSet<AlertAudioContextFactory>();

/**
 * A tone that waited for `resume()` longer than this is dropped: a suspended context can stay so
 * until the first click (Hebra, no user gesture), and a chime that sounds hours after the drop is
 * worse than none. The value is a product choice and can be changed by the owner.
 */
export const ALERT_SOUND_MAX_RESUME_WAIT_MS = 5_000;

function scheduleChime(createContext: AlertAudioContextFactory): AlertSoundOutcome {
	const context = createContext();
	if (context === null) return 'unavailable';
	// A context created outside a user gesture can start suspended (likely in Hebra, which is not
	// Electron), and a reused one can be suspended later. Its clock is stopped, so it is resumed
	// BEFORE any overlap check (a stopped clock would read every later alert as "still sounding"
	// forever), and THIS alert's tone is scheduled once the resume lands: the first valuable drop
	// must not be the one that is lost. The outcome cannot wait for that (`TyrianHost.notify.sound`
	// is synchronous), so it says `unavailable` (doubtful), never a `played` nobody heard. One tone
	// waits per factory: alerts arriving meanwhile do not queue more. A rejected resume, or one that
	// leaves the context suspended, leaves nothing pending, and the next alert starts from scratch.
	if (context.state === 'suspended') {
		if (resuming.has(createContext)) return 'unavailable';
		const alertedAt = Date.now();
		// The factory is taken only once `resume()` has returned: one that throws outright (`playAlertSound` answers
		// `unavailable`) leaves nothing pending either, or every later alert would find it taken until a reload.
		const pending: unknown = context.resume?.();
		resuming.add(createContext);
		// `Promise.resolve` adopts any thenable: `instanceof Promise` is false for a promise from
		// another realm (an Obsidian popout window, an iframe) and would resolve at once, suspended.
		const settled = Promise.resolve(pending);
		settled.then(() => {
			resuming.delete(createContext);
			if (context.state !== 'running') return;
			if (Date.now() - alertedAt > ALERT_SOUND_MAX_RESUME_WAIT_MS) return;
			try { scheduleTones(createContext, context); } catch { /* the next alert tries again */ }
		}, () => { resuming.delete(createContext); });
		return 'unavailable';
	}
	return scheduleTones(createContext, context);
}

function scheduleTones(createContext: AlertAudioContextFactory, context: AlertAudioContext): AlertSoundOutcome {
	const previous = chimes.get(createContext);
	if (previous !== undefined && previous.context === context && context.currentTime < previous.endsAt) return 'played';
	const start = context.currentTime;
	chimes.set(createContext, { context, endsAt: start + alertSoundDurationMs() / 1_000 });
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

const browserFactories = new WeakMap<object, AlertAudioContextFactory>();

/**
 * Builds the browser factory. Kept separate from `playAlertSound` so the pure
 * scheduler above never has to know that `window` exists.
 *
 * One factory per host and one `AudioContext` per factory: the hosts call this on every alert, and
 * a context per alert, never closed, leaves one open audio device handle behind for each of them
 * (browsers cap how many may exist). A context that could not be built is not remembered, so the
 * next alert tries again.
 */
export function browserAlertAudioContextFactory(host: unknown): AlertAudioContextFactory {
	const known = typeof host === 'object' && host !== null ? browserFactories.get(host) : undefined;
	if (known !== undefined) return known;
	let context: AlertAudioContext | null = null;
	const factory: AlertAudioContextFactory = () => {
		// A closed context can never sound again: it is dropped and a new one is built.
		if (context !== null && context.state !== 'closed') return context;
		context = null;
		const constructor = audioContextConstructor(host);
		if (constructor === null) return null;
		try { context = new constructor(); } catch { return null; }
		return context;
	};
	if (typeof host === 'object' && host !== null) browserFactories.set(host, factory);
	return factory;
}

type AlertAudioContextConstructor = new () => AlertAudioContext;

function audioContextConstructor(host: unknown): AlertAudioContextConstructor | null {
	if (typeof host !== 'object' || host === null) return null;
	const candidate = (host as Record<string, unknown>).AudioContext ??
		(host as Record<string, unknown>).webkitAudioContext;
	return typeof candidate === 'function' ? candidate as AlertAudioContextConstructor : null;
}
