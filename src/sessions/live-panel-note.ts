/**
 * The live panel note (David, 14 Oct 2026): ONE note at a fixed path that the collector rewrites while a session runs, so
 * the figures can be read from a phone or a tablet in real time. This module is the pure half: the same data always give the
 * same bytes (`runtime/live-panel-runtime.ts` writes only when the text changed).
 *
 * The note is two things at once:
 * - the TRANSPORT of the «En vivo» HUD (`ui/live-hud-view.ts`): its frontmatter carries the figures the HUD shows, as
 *   structured `tc_live_*` fields (`LivePanelLiveV1`), so a device in consult mode paints the same numbers the collector sees.
 *   A field changes only when a VISIBLE figure changes (the value, a bag, the state) or once a minute (the last reading's minute,
 *   the duration of the body); nothing in it moves every second, so a quiet session costs one write a minute and a drop costs one
 *   write within the floor. The duration is not sent: the start is, and the HUD counts;
 * - a readable note for whoever opens it: the fixed title, the estimated value as the big heading, gold per hour and duration,
 *   the addon state and its freshness, the last valuable drop, three consecutive callouts (Hebra and Obsidian's dashboard
 *   class paint them as a grid of cards: 3, 2 or 1 columns by width) and the value chart OUTSIDE the cards, at full width,
 *   because Mermaid does not draw inside a card.
 * No character, no account, no map: the note travels through sync. Under 4 KB with every loot row and a three-hour chart.
 */

import { Document as YamlDocument, isSeq, parseDocument } from 'yaml';

import { formatCopperVisual } from '../core/copper-format';
import { createTranslator, type Locale, type Translator } from '../core/i18n';
import { liveBagsPerHourMilli, liveObservedBags, type LiveSessionViewV1 } from './live-session-model';
import { renderSummaryChart } from './live-session-summary-chart';

/** The note, RELATIVE to the output folder, next to `Collector status.md`. */
export const LIVE_PANEL_NOTE_RELATIVE_PATH = 'Live panel.md';
export const LIVE_PANEL_NOTE_KIND = 'gw2_live_panel';
/** `tc_live_v`: the format of the `tc_live_*` fields. A reader sets aside a later one, never reads it as broken. */
export const LIVE_PANEL_TRANSPORT_VERSION = 1;
/** The loot card and the transport list this many items, the most valuable first. */
export const LIVE_PANEL_LOOT_ROWS = 5;
/** An item name longer than this is cut in the transport: the HUD shows one line per item and the note stays under 4 KB. */
export const LIVE_PANEL_NAME_LIMIT = 60;
const MINUTE_MS = 60_000;
const DASH = '—';

/** `<root>/Live panel.md`. */
export function livePanelNotePath(root: string): string {
	return `${root}/${LIVE_PANEL_NOTE_RELATIVE_PATH}`;
}

/** What the panel says about the session, kept in the frontmatter so a later write can tell a finished note from a stale one. */
export type LivePanelState = 'none' | 'live' | 'stale' | 'disconnected' | 'ended';
const LIVE_PANEL_STATES: readonly LivePanelState[] = ['none', 'live', 'stale', 'disconnected', 'ended'];

/**
 * Where the magic find figure comes from. `manual`, `verified` and `unknown` are the account's (`LiveSessionViewV1.magicFind`);
 * `game` is the in-game total with buffs that only the Nexus addon knows, while its last report over `mf1` is fresh
 * (`live-game-magic-find.ts`).
 */
export type LivePanelMagicFindSource = LiveSessionViewV1['magicFind']['source'] | 'game';
const MAGIC_FIND_SOURCES: readonly LivePanelMagicFindSource[] = ['manual', 'verified', 'unknown', 'game'];

export interface LivePanelLootRow {
	readonly itemId: number;
	readonly name: string;
	readonly quantity: number;
	/** What selling the whole pile nets; null while unpriced. */
	readonly totalCopper: number | null;
	/**
	 * The item's icon on the official render host (`liveLootIconUrl`), or null/absent when unknown. The transport carries it in
	 * `tc_live_loot_icons`, by row position, apart from the rows: a device in consult has no entity cache to look it up in.
	 */
	readonly icon?: string | null;
}

export interface LivePanelLastDrop extends LivePanelLootRow {
	readonly observedAt: string;
}

export interface LivePanelInput {
	readonly locale: Locale;
	/** The instant the text describes. Only its minute reaches the text. */
	readonly nowMs: number;
	/** The LIVE session's view (never a saved session the player is browsing). */
	readonly view: LiveSessionViewV1;
	/** `liveSessionValue(view)`. */
	readonly valueCopper: number;
	/** `liveSessionRatePerHour(view)`: null when not eligible. */
	readonly ratePerHourCopper: number | null;
	/** Every loot row; the card keeps the most valuable `LIVE_PANEL_LOOT_ROWS`. */
	readonly loot: readonly LivePanelLootRow[];
	readonly lastDrop: LivePanelLastDrop | null;
	/**
	 * The game's Magic Find in whole points, already checked for freshness (`LiveGameMagicFind.current`); null or absent when there
	 * is none, and then the account's figure is shown. A finished session always shows the account's.
	 */
	readonly gameMagicFind?: number | null;
}

/**
 * The figures of the HUD, as the frontmatter carries them and as the collector computes them locally: the ONE shape both
 * devices paint from. Every absent figure is null, never 0: the HUD shows a dash for it.
 */
export interface LivePanelLiveV1 {
	readonly version: typeof LIVE_PANEL_TRANSPORT_VERSION;
	readonly state: LivePanelState;
	/** The last reading, to the minute (its seconds never reach the note). Null before the first one. */
	readonly observedAt: string | null;
	readonly startedAt: string | null;
	/** Only once the session ended. */
	readonly endedAt: string | null;
	/** `liveSessionValue`, or null while nothing is priced. */
	readonly valueCopper: number | null;
	/** Gold per hour in copper, whole; null when not eligible. */
	readonly ratePerHourCopper: number | null;
	/** `liveObservedBags`. */
	readonly bags: number | null;
	/** `liveBagsPerHourMilli`. */
	readonly bagsPerHourMilli: number | null;
	readonly magicFind: { readonly value: number | null; readonly source: LivePanelMagicFindSource };
	/** The most valuable `LIVE_PANEL_LOOT_ROWS`, most valuable first. */
	readonly loot: readonly LivePanelLootRow[];
}

/** The state a view and its clock put the panel in. A finished session is `ended`; no session at all is `none`. */
export function livePanelState(view: LiveSessionViewV1): LivePanelState {
	if (view.phase === 'complete') return 'ended';
	if (view.phase !== 'active' && view.phase !== 'stopping') return 'none';
	if (view.connection === 'disconnected') return 'disconnected';
	return view.sourceState === 'ready' ? 'live' : 'stale';
}

/** The transport of a view that is not a session: everything null, the state `none`. */
export function emptyLivePanelLive(): LivePanelLiveV1 {
	return {
		version: LIVE_PANEL_TRANSPORT_VERSION, state: 'none', observedAt: null, startedAt: null, endedAt: null, valueCopper: null,
		ratePerHourCopper: null, bags: null, bagsPerHourMilli: null, magicFind: { value: null, source: 'unknown' }, loot: [],
	};
}

/**
 * The HUD figures of a live session. The collector paints its HUD from this and writes it into the note's frontmatter; a device
 * in consult reads it back with `parseLivePanelNote`. Same input, same figures.
 */
export function livePanelLive(
	input: Pick<LivePanelInput, 'view' | 'valueCopper' | 'ratePerHourCopper' | 'loot' | 'gameMagicFind'>,
): LivePanelLiveV1 {
	const { view } = input;
	const state = livePanelState(view);
	if (state === 'none' || view.startedAt === null) return emptyLivePanelLive();
	const { valuation } = view;
	const unpriced = valuation.capturedAt === null && valuation.knownNetValueCopper === null;
	const game = state === 'ended' ? null : input.gameMagicFind ?? null;
	return {
		version: LIVE_PANEL_TRANSPORT_VERSION, state,
		observedAt: minuteOf(view.lastObservationAt), startedAt: view.startedAt,
		endedAt: state === 'ended' ? view.endedAt : null,
		valueCopper: unpriced ? null : Math.round(input.valueCopper),
		ratePerHourCopper: input.ratePerHourCopper === null ? null : Math.round(input.ratePerHourCopper),
		bags: liveObservedBags(view), bagsPerHourMilli: liveBagsPerHourMilli(view),
		magicFind: game === null ? { value: view.magicFind.value, source: view.magicFind.source } : { value: game, source: 'game' },
		loot: rankLoot(input.loot).map((row) => ({ ...row, name: plainName(row.name), icon: liveLootIconUrl(row.icon) })),
	};
}

const LOOT_ICON_PATTERN = /^https:\/\/render\.guildwars2\.com\/file\/[0-9A-Fa-f]+\/[0-9]+\.png$/u;

/**
 * An item icon the transport may carry and the HUD may paint: exactly `https://render.guildwars2.com/file/<hex>/<digits>.png`.
 * Anything else (another host, a query, a fragment, another scheme, text that is not a URL) is null: the note travels through
 * sync, so a URL read from it is never drawn unless it passes this.
 */
export function liveLootIconUrl(value: unknown): string | null {
	return typeof value === 'string' && value.length <= 120 && LOOT_ICON_PATTERN.test(value) ? value : null;
}

/** The panel note for a view that is not a session (never started, or cleared before this run saw it end). */
export function renderLivePanelEmptyNote(locale: Locale): string {
	const t = createTranslator(locale);
	return [...frontmatter(emptyLivePanelLive()), `# ${t.t('livePanel.title')}`, '', t.t('livePanel.none'), ''].join('\n');
}

/** The whole note. Same input, same bytes. */
export function renderLivePanelNote(input: LivePanelInput): string {
	const { view } = input;
	const live = livePanelLive(input);
	const state = live.state;
	if (state === 'none' || view.startedAt === null) return renderLivePanelEmptyNote(input.locale);
	const t = createTranslator(input.locale);
	const out = [...frontmatter(live), `# ${t.t('livePanel.title')}`, '', `# ${valueText(live)}`, ''];
	out.push(t.t('livePanel.rate', {
		rate: live.ratePerHourCopper === null ? DASH : formatCopperVisual(live.ratePerHourCopper),
		duration: durationText(view.elapsedMs ?? 0),
	}), '');
	out.push(statusText(t, state, input, live), '');
	if (state !== 'ended') out.push(dropText(t, input.lastDrop), '');
	out.push(...callout(t.t('livePanel.card.loot'), lootLines(t, live.loot)), '');
	out.push(...callout(t.t('livePanel.card.coins'), coinLines(t, view)), '');
	out.push(...callout(t.t('livePanel.card.halloween'), halloweenLines(t, live)), '');
	const chart = renderSummaryChart({
		points: view.chartPoints, startedAt: view.startedAt, locale: input.locale, gaps: view.gaps,
		endedAt: state === 'ended' && view.endedAt !== null ? view.endedAt : new Date(Math.floor(input.nowMs / MINUTE_MS) * MINUTE_MS).toISOString(),
	});
	if (chart !== null) out.push(...chart, '');
	return out.join('\n');
}

/**
 * Whether `text` is a live panel note (the only kind this module may overwrite), in what state it was left, and the HUD
 * figures it carries. `live` is null for a note of this kind without readable figures: one from a build before the transport,
 * one of a later `tc_live_v`, or one whose fields do not pass the strict reading (a wrong type, a negative count, a name that is
 * not text); the HUD then says the note is not readable instead of painting half of it. Null for anything that is not this kind.
 */
export function parseLivePanelNote(text: string): { readonly state: LivePanelState; readonly live: LivePanelLiveV1 | null } | null {
	const normalized = text.replace(/\r\n/gu, '\n');
	if (!normalized.startsWith('---\n')) return null;
	const end = normalized.indexOf('\n---\n', 3);
	if (end < 0) return null;
	const document = parseDocument(normalized.slice(4, end));
	if (document.errors.length > 0) return null;
	const data = document.toJS() as unknown;
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	if (record.tc_kind !== LIVE_PANEL_NOTE_KIND) return null;
	const state = LIVE_PANEL_STATES.find((candidate) => candidate === record.tc_live_state) ?? 'none';
	return { state, live: readLive(record, state) };
}

/** The `tc_live_*` fields, each checked; one wrong field makes the whole transport unreadable (null). */
function readLive(record: Record<string, unknown>, state: LivePanelState): LivePanelLiveV1 | null {
	if (record.tc_live_v !== LIVE_PANEL_TRANSPORT_VERSION) return null;
	const observedAt = optionalIso(record.tc_live_observed_at);
	const startedAt = optionalIso(record.tc_live_started_at);
	const endedAt = optionalIso(record.tc_live_ended_at);
	const valueCopper = optionalInteger(record.tc_live_value_c, true);
	const ratePerHourCopper = optionalInteger(record.tc_live_rate_c, true);
	const bags = optionalInteger(record.tc_live_bags, false);
	const bagsPerHourMilli = optionalInteger(record.tc_live_bags_h_milli, false);
	const mf = optionalInteger(record.tc_live_mf, false);
	const source = MAGIC_FIND_SOURCES.find((candidate) => candidate === record.tc_live_mf_src);
	const loot = readLoot(record.tc_live_loot);
	if ([observedAt, startedAt, endedAt, valueCopper, ratePerHourCopper, bags, bagsPerHourMilli, mf].includes(undefined)
		|| source === undefined || loot === undefined) return null;
	if (state !== 'none' && startedAt === null) return null;
	return {
		version: LIVE_PANEL_TRANSPORT_VERSION, state, observedAt: observedAt!, startedAt: startedAt!, endedAt: endedAt!,
		valueCopper: valueCopper!, ratePerHourCopper: ratePerHourCopper!, bags: bags!, bagsPerHourMilli: bagsPerHourMilli!,
		magicFind: { value: mf!, source }, loot: readLootIcons(record.tc_live_loot_icons, loot),
	};
}

/** Absent → null; an ISO instant → itself; anything else → undefined (unreadable). */
function optionalIso(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	// The yaml library reads a bare timestamp as a Date; the note writes ISO text, and both are accepted.
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
	return value;
}

/** Absent → null; a safe integer (negative only where `signed`) → itself; anything else → undefined (unreadable). */
function optionalInteger(value: unknown, signed: boolean): number | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!signed && value < 0)) return undefined;
	return value;
}

/**
 * `[[id, name, quantity, copper|null], …]`, at most `LIVE_PANEL_LOOT_ROWS` rows; undefined when any row is not that. The rows
 * keep the exact 4-field shape of 0.6.59 and 0.6.60, whose readers reject any other; the icons travel apart (`readLootIcons`).
 */
function readLoot(value: unknown): LivePanelLootRow[] | undefined {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > LIVE_PANEL_LOOT_ROWS) return undefined;
	const rows: LivePanelLootRow[] = [];
	for (const entry of value as unknown[]) {
		if (!Array.isArray(entry) || entry.length !== 4) return undefined;
		const [itemId, name, quantity, totalCopper] = entry as unknown[];
		if (!Number.isSafeInteger(itemId) || (itemId as number) < 0 || typeof name !== 'string' || name.length > LIVE_PANEL_NAME_LIMIT) return undefined;
		if (!Number.isSafeInteger(quantity)) return undefined;
		const copper = optionalInteger(totalCopper, true);
		if (copper === undefined) return undefined;
		rows.push({ itemId: itemId as number, name, quantity: quantity as number, totalCopper: copper, icon: null });
	}
	return rows;
}

/**
 * `tc_live_loot_icons`: one icon per loot row, by position. A key that 0.6.59 and 0.6.60 readers never look at, so the loot
 * rows stay readable for them. Absent, not a list of the same length as the rows, or a value that is not an official render
 * URL: that icon is null. It never makes the note unreadable.
 */
function readLootIcons(value: unknown, rows: readonly LivePanelLootRow[]): LivePanelLootRow[] {
	if (!Array.isArray(value) || value.length !== rows.length) return [...rows];
	return rows.map((row, index) => ({ ...row, icon: liveLootIconUrl((value as unknown[])[index]) }));
}

/**
 * The frontmatter: the kind and state first (what `parseLivePanelNote` always reads), the `tc_live_*` transport, then the
 * display hints of the hosts. Built with the yaml library so an item name with quotes or colons is quoted for it; the loot
 * rows go as flow sequences (`- [ id, name, qty, copper ]`), one line each; the icons go in `tc_live_loot_icons`, left out when no row has one.
 */
function frontmatter(live: LivePanelLiveV1): string[] {
	const fields: Record<string, unknown> = { tc_kind: LIVE_PANEL_NOTE_KIND, tc_live_state: live.state, tc_live_v: live.version };
	const put = (key: string, value: unknown): void => { if (value !== null) fields[key] = value; };
	put('tc_live_observed_at', live.observedAt);
	put('tc_live_started_at', live.startedAt);
	put('tc_live_ended_at', live.endedAt);
	put('tc_live_value_c', live.valueCopper);
	put('tc_live_rate_c', live.ratePerHourCopper);
	put('tc_live_bags', live.bags);
	put('tc_live_bags_h_milli', live.bagsPerHourMilli);
	put('tc_live_mf', live.magicFind.value);
	fields.tc_live_mf_src = live.magicFind.source;
	if (live.loot.length > 0) fields.tc_live_loot = live.loot.map((row) => [row.itemId, row.name, row.quantity, row.totalCopper]);
	if (live.loot.some((row) => row.icon)) fields.tc_live_loot_icons = live.loot.map((row) => row.icon ?? null);
	fields.cssclasses = ['dashboard'];
	fields.obsidianUIMode = 'preview';
	const document = new YamlDocument(fields);
	const loot = document.get('tc_live_loot', true);
	if (isSeq(loot)) for (const row of loot.items) if (isSeq(row)) row.flow = true;
	return ['---', ...document.toString({ lineWidth: 0 }).trimEnd().split('\n'), '---'];
}

/** The instant floored to its minute, as ISO; null when missing or unreadable. */
function minuteOf(value: string | null): string | null {
	if (value === null) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString() : null;
}

/** The loot by value, most valuable first (unpriced last, then by name), cut to the rows the card and the transport keep. */
function rankLoot(loot: readonly LivePanelLootRow[]): LivePanelLootRow[] {
	return [...loot].sort((a, b) => (b.totalCopper ?? -1) - (a.totalCopper ?? -1) || a.name.localeCompare(b.name, 'en')).slice(0, LIVE_PANEL_LOOT_ROWS);
}

function valueText(live: LivePanelLiveV1): string {
	return live.valueCopper === null ? DASH : formatCopperVisual(live.valueCopper);
}

function durationText(elapsedMs: number): string {
	const minutes = Math.max(0, Math.floor(elapsedMs / MINUTE_MS));
	return minutes >= 60 ? `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min` : `${String(minutes)} min`;
}

/** Local HH:MM of an instant, or the dash when it is missing or unreadable. */
function clock(value: string | number | null): string {
	if (value === null) return DASH;
	const at = new Date(value);
	if (!Number.isFinite(at.getTime())) return DASH;
	return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function statusText(t: Translator, state: LivePanelState, input: LivePanelInput, live: LivePanelLiveV1): string {
	const { view } = input;
	switch (state) {
		case 'ended': return t.t('livePanel.status.ended', { time: clock(view.endedAt), value: valueText(live) });
		case 'live': return t.t('livePanel.status.live', { time: clock(view.lastObservationAt) });
		case 'stale': return view.lastObservationAt === null ? t.t('livePanel.status.noData')
			: t.t('livePanel.status.stale', { time: clock(view.lastObservationAt) });
		default: return view.lastObservationAt === null ? t.t('livePanel.status.noData')
			: t.t('livePanel.status.disconnected', { time: clock(view.lastObservationAt) });
	}
}

function dropText(t: Translator, drop: LivePanelLastDrop | null): string {
	if (drop === null) return t.t('livePanel.lastDrop.none');
	return t.t('livePanel.lastDrop', {
		time: clock(drop.observedAt), name: markdownSafe(plainName(drop.name)), quantity: drop.quantity, value: copperOrDash(drop.totalCopper),
	});
}

function copperOrDash(copper: number | null): string {
	return copper === null ? DASH : formatCopperVisual(copper);
}

/** The ranked rows of the transport, as the card lists them. */
function lootLines(t: Translator, loot: readonly LivePanelLootRow[]): string[] {
	if (loot.length === 0) return [t.t('livePanel.loot.empty')];
	return loot.map((row) => `- ${t.t('livePanel.loot.row', { name: markdownSafe(row.name), quantity: row.quantity, value: copperOrDash(row.totalCopper) })}`);
}

function coinLines(t: Translator, view: LiveSessionViewV1): string[] {
	return [
		`- ${t.t('livePanel.coins.gold', { value: copperOrDash(view.valuation.coinNetCopper) })}`,
		`- ${t.t('livePanel.coins.items', { value: formatCopperVisual(view.valuation.netItemValueKnownCopper) })}`,
	];
}

/** Bags and bags per hour, the same figures the transport carries (one decimal for the rate, as the game shows it). */
function halloweenLines(t: Translator, live: LivePanelLiveV1): string[] {
	const perHour = live.bagsPerHourMilli === null ? DASH : String(Math.round(live.bagsPerHourMilli / 100) / 10);
	return [`- ${t.t('livePanel.sacks', { count: live.bags ?? DASH })}`, `- ${t.t('livePanel.sacksPerHour', { rate: perHour })}`];
}

/** A callout card: `> [!info] Title` and its lines. */
function callout(title: string, lines: readonly string[]): string[] {
	return [`> [!info] ${title}`, ...lines.map((line) => `> ${line}`)];
}

/** An item name as one line of plain text, cut to `LIVE_PANEL_NAME_LIMIT`: the shape the transport carries. */
function plainName(name: string): string {
	const line = name.replace(/\s+/gu, ' ').trim();
	return line.length > LIVE_PANEL_NAME_LIMIT ? `${line.slice(0, LIVE_PANEL_NAME_LIMIT - 1)}…` : line;
}

/** A plain name as safe Markdown: none of the characters that open Markdown or HTML. */
function markdownSafe(name: string): string {
	return name.replace(/[\\`*_[\]<>|]/gu, (char) => `\\${char}`);
}
