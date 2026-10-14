/**
 * The live panel writer (David, 14 Oct 2026): keeps ONE note, `<outputFolder>/Live panel.md`, up to date while a session runs, so
 * its value, rate and loot can be read from a phone or a tablet (`sessions/live-panel-note.ts` renders it).
 *
 * - Only the COLLECTOR writes. A device in consult mode reads the note through sync and never touches it.
 * - It writes when the view changes (`notify`), at most once every `LIVE_PANEL_WRITE_FLOOR_MS`, and only when the text differs from
 *   what it last wrote. The text changes when a visible figure changes (the value, a bag, the state: the frontmatter carries them for
 *   the «En vivo» HUD) and otherwise once a minute, so a connected session with nothing new costs one write a minute; while a session
 *   is shown, a recheck every `LIVE_PANEL_TICK_MS` lets the minute-level text move on when the view itself is quiet.
 *   It arms no interval: a device that never shows a session (consult, or no session) keeps no timer at all.
 * - A note at that path that does not carry `tc_kind: gw2_live_panel` is the player's own and is never overwritten (the same rule
 *   as `collector-status.ts`). The note is never deleted: a deletion leaves a permanent tombstone in Hebra's sync. A finished session
 *   stays as «Sesión terminada»; with no session ever, nothing is created.
 * - A failed write is reported by the host (`run`) and never reaches the session; the next change tries again.
 * - `stop` (plugin unload) writes the final state once, ignoring the floor, and never rejects.
 */

import type { Locale } from '../core/i18n';
import { createTranslator } from '../core/i18n';
import type { LiveSessionLootState } from '../sessions/live-session-loot';
import type { LiveSessionAlertViewV1, LiveSessionViewV1 } from '../sessions/live-session-model';
import {
	livePanelNotePath,
	parseLivePanelNote,
	renderLivePanelEmptyNote,
	renderLivePanelNote,
	type LivePanelLastDrop,
	type LivePanelLootRow,
} from '../sessions/live-panel-note';
import { liveSessionRatePerHour, liveSessionValue } from '../ui/live-session-panel';
import type { CollectorStatusVault } from './collector-status';

/** The least time between two writes of the note. */
export const LIVE_PANEL_WRITE_FLOOR_MS = 10_000;
/** How often the writer looks again on its own, so «dato de las 18:42» and the duration move on while the view is quiet. */
export const LIVE_PANEL_TICK_MS = 30_000;

/** Everything one rendering needs, read from the live session (never a saved session the player is browsing). */
export interface LivePanelSnapshot {
	readonly view: LiveSessionViewV1;
	readonly valueCopper: number;
	readonly ratePerHourCopper: number | null;
	readonly loot: readonly LivePanelLootRow[];
	readonly lastDrop: LivePanelLastDrop | null;
	/** The game's Magic Find while fresh (`LivePanelInput.gameMagicFind`); null or absent shows the account's. */
	readonly gameMagicFind?: number | null;
}

/**
 * The snapshot of the live session from what the core already holds. The latest alert that was not skipped is the «last
 * valuable drop»; its name comes from the entity cache, then from the loot rows, then from the item id. The bag count is not
 * here: the note and the HUD read it from the view itself (`liveObservedBags`), the way the in-game panel does.
 */
export function livePanelSnapshot(parts: {
	readonly locale: Locale;
	readonly view: LiveSessionViewV1;
	readonly alerts: readonly LiveSessionAlertViewV1[];
	readonly loot: LiveSessionLootState;
	readonly itemName: (itemId: number) => string | null;
	/** The item's icon URL from the entity cache; the note keeps it only when it is an official render URL. Absent → no icons. */
	readonly itemIcon?: (itemId: number) => string | null;
	/** `LiveGameMagicFind.current(now)`: the game's figure while fresh, else null. */
	readonly gameMagicFind?: number | null;
}): LivePanelSnapshot {
	const rows = parts.loot.status === 'idle' ? [] : parts.loot.rows;
	const nameOf = (itemId: number): string => parts.itemName(itemId) ?? rows.find((row) => row.itemId === itemId)?.name
		?? createTranslator(parts.locale).t('livePanel.unknownItem', { id: itemId });
	let latest: LiveSessionAlertViewV1 | null = null;
	for (const alert of parts.alerts) if (alert.skipReason === null && (latest === null || alert.observedAt >= latest.observedAt)) latest = alert;
	return {
		view: parts.view, valueCopper: liveSessionValue(parts.view), ratePerHourCopper: liveSessionRatePerHour(parts.view),
		loot: rows.map((row) => ({ itemId: row.itemId, name: row.name, quantity: row.quantity, totalCopper: row.totalCopper, icon: parts.itemIcon?.(row.itemId) ?? null })),
		lastDrop: latest === null ? null
			: { itemId: latest.itemId, name: nameOf(latest.itemId), quantity: latest.quantity, totalCopper: latest.totalCopper, observedAt: latest.observedAt },
		gameMagicFind: parts.gameMagicFind ?? null,
	};
}

export interface LivePanelRuntimeOptions {
	readonly vault: CollectorStatusVault;
	/** The output folder, read on every write: it can move without a reload. */
	readonly root: () => string;
	/** The «Panel en vivo» setting. */
	readonly enabled: () => boolean;
	/** False on a device in consult mode: nothing is written there. */
	readonly collector: () => boolean;
	/** False while nothing may be written under the root (a pending legacy folder). */
	readonly writable?: () => boolean;
	readonly locale: () => Locale;
	/** The live session now; may throw, which the host reports like a failed write. */
	readonly read: () => LivePanelSnapshot;
	readonly now?: () => number;
	readonly setTimeout: (callback: () => void, delayMs: number) => number;
	readonly clearTimeout: (handle: number) => void;
	/** Runs one write off a timer; the host's diagnostics own its outcome and any rejection. */
	readonly run: (write: () => Promise<void>) => void;
}

export class LivePanelRuntime {
	private readonly now: () => number;
	private stopped = false;
	private started = false;
	private timer: number | null = null;
	/** When the pending timer fires. */
	private timerDue = 0;
	/** The last composition showed a session in progress: the minute-level text moves on by itself, so look again. */
	private active = false;
	private flushing: Promise<void> | null = null;
	private dirty = false;
	private lastWriteAt: number | null = null;
	/** What the note last held as far as this run knows; null before the first write or after a failed one. */
	private lastText: string | null = null;
	/** The last active snapshot, so a session cleared before this run saw it end can still be left as ended. */
	private lastActive: LivePanelSnapshot | null = null;
	/** The finished session's note text, kept until the next session starts. */
	private endedText: string | null = null;

	constructor(private readonly options: LivePanelRuntimeOptions) {
		this.now = options.now ?? Date.now;
	}

	/** Looks once now. Idempotent. */
	start(): void {
		if (this.stopped || this.started) return;
		this.started = true;
		this.notify();
	}

	/** The view changed: write soon, honouring the floor. Cheap enough to call on every repaint. */
	notify(): void {
		if (this.stopped) return;
		this.dirty = true;
		if (this.flushing !== null) return;
		if (this.timer !== null) {
			// A recheck waiting for the next tick must not hold back a change that is due as soon as the floor allows.
			if (this.timerDue <= this.now() + this.floorWait()) return;
			this.options.clearTimeout(this.timer);
		}
		this.arm(0);
	}

	/** Unload: stops the timers, lets a write in flight end, writes the final state once and never rejects. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer !== null) this.options.clearTimeout(this.timer);
		this.timer = null;
		await Promise.allSettled([this.flushing]);
		await new Promise<void>((resolve) => {
			this.options.run(async () => {
				try { await this.writeIfChanged(true); } finally { resolve(); }
			});
		});
	}

	/** How long the floor still asks to wait before the next write. */
	private floorWait(): number {
		return this.lastWriteAt === null ? 0 : Math.max(0, this.lastWriteAt + LIVE_PANEL_WRITE_FLOOR_MS - this.now());
	}

	/** Looks again after `delayMs`, but never sooner than the floor allows. */
	private arm(delayMs: number): void {
		const wait = Math.max(delayMs, this.floorWait());
		this.timerDue = this.now() + wait;
		this.timer = this.options.setTimeout(() => {
			this.timer = null;
			this.options.run(() => this.flush());
		}, wait);
	}

	private async flush(): Promise<void> {
		if (this.stopped || this.flushing !== null) return;
		this.dirty = false;
		const attempt = this.writeIfChanged(false);
		this.flushing = attempt;
		try { await attempt; } finally {
			this.flushing = null;
			if (!this.stopped && this.timer === null && (this.dirty || this.active)) this.arm(this.dirty ? 0 : LIVE_PANEL_TICK_MS);
		}
	}

	/** The text for the session as it stands, or null when there is nothing to say. `empty` marks the no-session note. */
	private compose(final: boolean): { readonly text: string; readonly empty: boolean } {
		const locale = this.options.locale();
		const nowMs = this.now();
		const snapshot = this.options.read();
		const { phase } = snapshot.view;
		this.active = phase === 'active' || phase === 'stopping';
		if (phase === 'active' || phase === 'stopping') {
			this.lastActive = snapshot;
			this.endedText = null;
			const view = final ? { ...snapshot.view, connection: 'disconnected' as const } : snapshot.view;
			return { text: renderLivePanelNote({ ...snapshot, view, locale, nowMs }), empty: false };
		}
		if (phase === 'complete') {
			this.lastActive = null;
			this.endedText = renderLivePanelNote({ ...snapshot, locale, nowMs });
			return { text: this.endedText, empty: false };
		}
		if (this.endedText === null && this.lastActive !== null) {
			// The session was cleared before this run saw it complete: leave it as ended, from the last thing seen.
			const seen = this.lastActive;
			const view = { ...seen.view, phase: 'complete' as const, connection: 'disconnected' as const, sourceState: 'unavailable' as const,
				endedAt: new Date(nowMs).toISOString() };
			this.endedText = renderLivePanelNote({ ...seen, view, locale, nowMs });
			this.lastActive = null;
		}
		return this.endedText === null ? { text: renderLivePanelEmptyNote(locale), empty: true } : { text: this.endedText, empty: false };
	}

	private async writeIfChanged(final: boolean): Promise<void> {
		const { options } = this;
		if (!options.enabled() || !options.collector()) {
			// Off, or another installation may own the note now: when this one writes again it re-reads and compares from scratch.
			this.lastText = null;
			this.active = false;
			return;
		}
		if (!(options.writable?.() ?? true)) return;
		const next = this.compose(final);
		if (next.text === this.lastText) return;
		const root = options.root();
		const path = livePanelNotePath(root);
		this.lastWriteAt = this.now();
		const file = options.vault.file(path);
		if (file === null) {
			// No session ever and no note: nothing to say, nothing created.
			if (!next.empty) {
				await this.ensureFolder(root);
				await options.vault.create(path, next.text);
			}
			this.lastText = next.text;
			return;
		}
		await options.vault.process(file, (current) => {
			const own = parseLivePanelNote(current);
			// Not a live panel note: the player's own. A no-session text only replaces a note left mid-session.
			if (own === null || (next.empty && (own.state === 'none' || own.state === 'ended'))) return current;
			return next.text;
		});
		this.lastText = next.text;
	}

	/** Creates the output folder one segment at a time, the way every writer does. */
	private async ensureFolder(folder: string): Promise<void> {
		let current = '';
		for (const segment of folder.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			if (this.options.vault.file(current) === null) await this.options.vault.createFolder(current);
		}
	}
}
