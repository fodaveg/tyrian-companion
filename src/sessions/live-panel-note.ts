/**
 * The live panel note (David, 14 Oct 2026): ONE note at a fixed path that the collector rewrites while a session runs, so the
 * figures can be read from a phone or a tablet in real time. This module is the pure half: the same data always give the same
 * bytes, and the text only has the resolution of a minute (duration, «dato de las 18:42»), so a connected session with nothing new
 * rewrites it at most once a minute (`runtime/live-panel-runtime.ts` writes only when the text changed).
 *
 * Layout, top to bottom: the fixed title, the estimated value as the big heading, gold per hour and duration, the addon state
 * and its freshness, the last valuable drop, three consecutive callouts (Hebra and Obsidian's dashboard class paint them as a
 * grid of cards: 3, 2 or 1 columns by width) and the value chart OUTSIDE the cards, at full width, because Mermaid does not
 * draw inside a card. No character, no account, no map: the note travels through sync.
 */

import { parseDocument } from 'yaml';

import { formatCopperVisual } from '../core/copper-format';
import { createTranslator, type Locale, type Translator } from '../core/i18n';
import { liveItemRateEligible, type LiveSessionViewV1 } from './live-session-model';
import { renderSummaryChart } from './live-session-summary-chart';

/** The note, RELATIVE to the output folder, next to `Collector status.md`. */
export const LIVE_PANEL_NOTE_RELATIVE_PATH = 'Live panel.md';
export const LIVE_PANEL_NOTE_KIND = 'gw2_live_panel';
/** The loot card lists this many items, the most valuable first. */
export const LIVE_PANEL_LOOT_ROWS = 5;
const MINUTE_MS = 60_000;
const DASH = '—';

/** `<root>/Live panel.md`. */
export function livePanelNotePath(root: string): string {
	return `${root}/${LIVE_PANEL_NOTE_RELATIVE_PATH}`;
}

/** What the panel says about the session, kept in the frontmatter so a later write can tell a finished note from a stale one. */
export type LivePanelState = 'none' | 'live' | 'stale' | 'disconnected' | 'ended';

export interface LivePanelLootRow {
	readonly name: string;
	readonly quantity: number;
	/** What selling the whole pile nets; null while unpriced. */
	readonly totalCopper: number | null;
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
	/** Observed Halloween bag gains, or null when the tracker has no count. */
	readonly sacks: number | null;
}

/** The state a view and its clock put the panel in. A finished session is `ended`; no session at all is `none`. */
export function livePanelState(view: LiveSessionViewV1): LivePanelState {
	if (view.phase === 'complete') return 'ended';
	if (view.phase !== 'active' && view.phase !== 'stopping') return 'none';
	if (view.connection === 'disconnected') return 'disconnected';
	return view.sourceState === 'ready' ? 'live' : 'stale';
}

/** The panel note for a view that is not a session (never started, or cleared before this run saw it end). */
export function renderLivePanelEmptyNote(locale: Locale): string {
	const t = createTranslator(locale);
	return [...frontmatter('none'), `# ${t.t('livePanel.title')}`, '', t.t('livePanel.none'), ''].join('\n');
}

/** The whole note. Same input, same bytes. */
export function renderLivePanelNote(input: LivePanelInput): string {
	const { view } = input;
	const state = livePanelState(view);
	if (state === 'none' || view.startedAt === null) return renderLivePanelEmptyNote(input.locale);
	const t = createTranslator(input.locale);
	const out = [...frontmatter(state), `# ${t.t('livePanel.title')}`, '', `# ${valueText(input)}`, ''];
	out.push(t.t('livePanel.rate', {
		rate: input.ratePerHourCopper === null ? DASH : formatCopperVisual(Math.round(input.ratePerHourCopper)),
		duration: durationText(view.elapsedMs ?? 0),
	}), '');
	out.push(statusText(t, state, input), '');
	if (state !== 'ended') out.push(dropText(t, input.lastDrop), '');
	out.push(...callout(t.t('livePanel.card.loot'), lootLines(t, input.loot)), '');
	out.push(...callout(t.t('livePanel.card.coins'), coinLines(t, view)), '');
	out.push(...callout(t.t('livePanel.card.halloween'), halloweenLines(t, input)), '');
	const chart = renderSummaryChart({
		points: view.chartPoints, startedAt: view.startedAt, locale: input.locale, gaps: view.gaps,
		endedAt: state === 'ended' && view.endedAt !== null ? view.endedAt : new Date(Math.floor(input.nowMs / MINUTE_MS) * MINUTE_MS).toISOString(),
	});
	if (chart !== null) out.push(...chart, '');
	return out.join('\n');
}

/** Whether `text` is a live panel note (the only kind this module may overwrite), and in what state it was left. */
export function parseLivePanelNote(text: string): { readonly state: LivePanelState } | null {
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
	const state = record.tc_live_state;
	return { state: state === 'live' || state === 'stale' || state === 'disconnected' || state === 'ended' ? state : 'none' };
}

function frontmatter(state: LivePanelState): string[] {
	return ['---', `tc_kind: ${LIVE_PANEL_NOTE_KIND}`, `tc_live_state: ${state}`, 'cssclasses:', '  - dashboard', 'obsidianUIMode: preview', '---'];
}

function valueText(input: LivePanelInput): string {
	const { valuation } = input.view;
	if (valuation.capturedAt === null && valuation.knownNetValueCopper === null) return DASH;
	return formatCopperVisual(input.valueCopper);
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

function statusText(t: Translator, state: LivePanelState, input: LivePanelInput): string {
	const { view } = input;
	switch (state) {
		case 'ended': return t.t('livePanel.status.ended', { time: clock(view.endedAt), value: valueText(input) });
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
		time: clock(drop.observedAt), name: plain(drop.name), quantity: drop.quantity, value: copperOrDash(drop.totalCopper),
	});
}

function copperOrDash(copper: number | null): string {
	return copper === null ? DASH : formatCopperVisual(copper);
}

function lootLines(t: Translator, loot: readonly LivePanelLootRow[]): string[] {
	const ranked = [...loot].sort((a, b) => (b.totalCopper ?? -1) - (a.totalCopper ?? -1) || a.name.localeCompare(b.name, 'en'));
	if (ranked.length === 0) return [t.t('livePanel.loot.empty')];
	return ranked.slice(0, LIVE_PANEL_LOOT_ROWS).map((row) => `- ${t.t('livePanel.loot.row', {
		name: plain(row.name), quantity: row.quantity, value: copperOrDash(row.totalCopper),
	})}`);
}

function coinLines(t: Translator, view: LiveSessionViewV1): string[] {
	return [
		`- ${t.t('livePanel.coins.gold', { value: copperOrDash(view.valuation.coinNetCopper) })}`,
		`- ${t.t('livePanel.coins.items', { value: formatCopperVisual(view.valuation.netItemValueKnownCopper) })}`,
	];
}

function halloweenLines(t: Translator, input: LivePanelInput): string[] {
	const { sacks, view } = input;
	const perHour = sacks !== null && liveItemRateEligible(view) ? String(Math.round(sacks * 36_000_000 / view.observedItemsMs) / 10) : DASH;
	return [`- ${t.t('livePanel.sacks', { count: sacks ?? DASH })}`, `- ${t.t('livePanel.sacksPerHour', { rate: perHour })}`];
}

/** A callout card: `> [!info] Title` and its lines. */
function callout(title: string, lines: readonly string[]): string[] {
	return [`> [!info] ${title}`, ...lines.map((line) => `> ${line}`)];
}

/** An item name as one safe line of text: no newlines and none of the characters that open Markdown or HTML. */
function plain(name: string): string {
	return name.replace(/\s+/gu, ' ').trim().replace(/[\\`*_[\]<>|]/gu, (char) => `\\${char}`);
}
