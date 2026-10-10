/**
 * Boot timings: one number per phase of the start, kept in memory and written ONCE as a single
 * `plugin_load` line of the debug log (`state: 'boot_timings'`, `details.bootMs`), so a slow start on
 * the real client can be read off one line instead of being inferred from three durations.
 *
 * A mark is `performance.now()` minus the origin, rounded, stored in a plain object: no I/O, no
 * formatting, nothing that costs measurably with the log off. Only numbers ever leave this module (the
 * sanitizer also refuses anything else under `bootMs`/`bootCounts`): no path, id or note name.
 */

/** Phases in the order the start reaches them; Hebra's come first because its `activate` runs before the core. */
export const BOOT_PHASES = [
	'module', 'hebraReady', 'hebraSettings', 'hebraIndex', 'hebraSeed', 'hebraHost',
	'onload', 'settings', 'diagnostics', 'registered', 'runtimeStart', 'mode', 'sessions', 'live', 'ready',
	'priceHistory', 'halloween', 'painted',
] as const;
export type BootPhase = typeof BOOT_PHASES[number];

/** Counters of Hebra's first walk of the library, written next to the timings. */
export type BootCounter = 'pages' | 'notesRead' | 'newlyAdopted';

export interface BootTimingsSnapshot {
	/** Milliseconds (integers) since the origin, per phase, in the order they were marked. */
	readonly bootMs: Readonly<Record<string, number>>;
	/** Counts of the Hebra walk; empty on Obsidian. */
	readonly bootCounts: Readonly<Record<string, number>>;
	/** The last phase reached: on a start that broke, the one it broke after. */
	readonly lastPhase: string | null;
}

export interface BootTrace {
	/** Marks `phase` now, or at `atMs` (a `performance.now()` reading taken earlier). The first mark of a phase stands. */
	mark(phase: BootPhase, atMs?: number): void;
	count(counter: BootCounter, value: number): void;
	/** The timings once; every later call answers `null`, so one start writes one line. */
	take(): BootTimingsSnapshot | null;
}

/** A reading of the platform clock: `performance.now()` where there is one. */
export function bootNow(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Taken when this module is evaluated, which the core imports before everything else it loads. */
export const BOOT_ORIGIN_MS = bootNow();

export function createBootTrace(clock: () => number = bootNow, originMs: number = BOOT_ORIGIN_MS): BootTrace {
	const bootMs: Record<string, number> = {};
	const bootCounts: Record<string, number> = {};
	let lastPhase: string | null = null;
	let taken = false;
	return {
		mark(phase, atMs) {
			if (taken || phase in bootMs) return;
			bootMs[phase] = Math.max(0, Math.round((atMs ?? clock()) - originMs));
			lastPhase = phase;
		},
		count(counter, value) {
			if (taken || !Number.isFinite(value)) return;
			bootCounts[counter] = Math.max(0, Math.round(value));
		},
		take() {
			if (taken) return null;
			taken = true;
			return { bootMs: { ...bootMs }, bootCounts: { ...bootCounts }, lastPhase };
		},
	};
}
