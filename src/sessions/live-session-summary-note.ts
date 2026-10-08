import { formatCopperVisual } from '../core/copper-format';
import { errorClassName } from '../core/local-debug-error-details';
import { ensureFoldersBySegments } from '../core/vault-folders';
import type { LiveGapV1 } from './live-session-model';
import { sortLiveItemsByValue } from './live-session-history';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { normalizeSessionOutputFolder } from './session-note-model';
import type { SessionNoteVault } from './session-note-writer';

/**
 * The short summary note of a closed live session (David, 2026-10-08: «una nota resumen cada vez
 * que se cierra la sesión», in a subfolder of the folder chosen in settings).
 *
 * It is built only from the stored payload the full note already carries, so it invents nothing:
 * the figures follow the Session tab's own validity rules (`liveSessionValue`,
 * `liveSessionRatePerHour`) and a figure that tab would not show is written as unavailable, with
 * its reason, never as a zero.
 *
 * Its frontmatter deliberately has NO key starting with `tc_`. The history reads every note of the
 * vault: `inspectLiveSessionNote` takes `tc_schema`/`tc_kind`/`tc_source` as a session candidate, and
 * `inspectDurableSessionNote` (`hasTcHint`) treats ANY other `tc_*` key without a known `tc_kind` as an
 * invalid session note, which leaves the whole history out of service (measured: a `tc_summary_of`
 * key made `LiveSessionHistoryService.list()` answer `conflict`). Hebra's adoption likewise flags a
 * Tyrian `tc_kind` it cannot map to a path. The keys here are `tyrian_summary_*`.
 */

/** Fixed subfolder of the output folder, next to `sessions/` (the repo's subfolders are not localized). */
export const LIVE_SESSION_SUMMARY_FOLDER = 'summaries';
/** The Halloween bag item (`projectLiveFarmingIngameState` reads the same id). */
const HALLOWEEN_BAG_ITEM_ID = 36038;
const TOP_ITEMS = 5;
const TOP_MAPS = 5;

export interface LiveSessionSummaryInput {
	session: StoredLiveSessionPayloadV1;
	locale: 'es' | 'en';
	outputFolder: string;
	/** Vault path of the full session note, as the receipt records it. */
	fullNotePath: string;
	displayNames?: Readonly<Record<string, string>>;
}
export interface RenderedLiveSessionSummary { path: string; content: string; sessionRef: string }

export type LiveSessionSummaryWriteResult =
	| { status: 'written' | 'unchanged' | 'kept'; path: string }
	| { status: 'invalid'; reason: string }
	| { status: 'conflict' | 'unavailable'; message: string; errorName?: string };

/** The four vault calls the writer needs; the common vault port satisfies it in Obsidian and in Hebra. */
export type LiveSessionSummaryVault = Pick<SessionNoteVault, 'file' | 'read' | 'createFolder' | 'create'>;

/** `summaries/2026-10-08 153000Z - 0123456789abcdef - summary.md`: the full note's UTC stamp and ref prefix, no forbidden character. */
export function liveSessionSummaryRelativePath(startedAt: string, sessionRef: string): string {
	const started = new Date(startedAt);
	const pad = (value: number): string => String(value).padStart(2, '0');
	const date = `${String(started.getUTCFullYear()).padStart(4, '0')}-${pad(started.getUTCMonth() + 1)}-${pad(started.getUTCDate())}`;
	const time = `${pad(started.getUTCHours())}${pad(started.getUTCMinutes())}${pad(started.getUTCSeconds())}Z`;
	return `${LIVE_SESSION_SUMMARY_FOLDER}/${date} ${time} - ${sessionRef.slice(0, 16)} - summary.md`;
}

export async function renderLiveSessionSummary(input: LiveSessionSummaryInput): Promise<
	{ status: 'ok'; note: RenderedLiveSessionSummary } | { status: 'invalid'; reason: string }> {
	try {
		const folder = normalizeSessionOutputFolder(input.outputFolder);
		const { session } = input;
		if (folder === null || !['es', 'en'].includes(input.locale) || !Number.isFinite(Date.parse(session.startedAt))
			|| !/^[a-f0-9]{64}$/u.test(session.sessionRef)) return { status: 'invalid', reason: 'invalid_input' };
		const es = input.locale === 'es';
		const label = (spanish: string, english: string): string => es ? spanish : english;
		const names = input.displayNames ?? {};
		const itemName = (id: number): string => escapeMarkdown(names[`item:${String(id)}`] ?? `${label('Objeto', 'Item')} ${String(id)}`);
		const money = (copper: number): string => formatCopperVisual(copper);
		const start = new Date(session.startedAt); const end = new Date(session.endedAt);
		const day = (value: Date): string => value.toISOString().slice(0, 10);
		const clock = (value: Date): string => `${value.toISOString().slice(11, 16)} UTC`;
		const durationMs = Date.parse(session.endedAt) - Date.parse(session.startedAt);
		const valuation = session.valuation;
		const lines: string[] = [`# ${label('Resumen de sesión', 'Session summary')} · ${day(start)}`, '',
			`- ${label('Fecha', 'Date')}: ${day(start)}`,
			`- ${label('Inicio', 'Start')}: ${clock(start)} · ${label('Fin', 'End')}: ${clock(end)}`,
			`- ${label('Duración', 'Duration')}: ${duration(durationMs)}`,
			`- ${label('Tiempo realmente observado (objetos)', 'Time actually observed (items)')}: ${duration(session.observedItemsMs)}`];

		const bags = session.totals.find((row) => row.kind === 'item' && row.idNumber === HALLOWEEN_BAG_ITEM_ID);
		if (bags !== undefined && bags.positive > 0) {
			const rate = session.observedItemsMs > 0 && session.coverage.items === 'complete'
				? `${(bags.positive * 3_600_000 / session.observedItemsMs).toFixed(1)}/h`
				: label('no disponible (cobertura de objetos incompleta o sin tiempo observado)', 'unavailable (incomplete item coverage or no observed time)');
			lines.push(`- ${label('Bolsas de Halloween', 'Halloween bags')}: ${String(bags.positive)} · ${label('ritmo', 'rate')}: ${rate}`);
		}

		const hasItems = session.totals.some((row) => row.kind === 'item' && (row.net !== 0 || row.positive !== 0));
		if (hasItems && (valuation.capturedAt === null || valuation.prices.length === 0)) {
			lines.push(`- ${label('Valor estimado', 'Estimated value')}: ${label('no disponible (sin precios)', 'unavailable (no prices)')}`,
				`- ${label('Valor por hora', 'Value per hour')}: ${label('no disponible (sin precios)', 'unavailable (no prices)')}`);
		} else {
			const value = valuation.knownNetValueCopper ?? valuation.netItemValueKnownCopper;
			const unpriced = valuation.unpricedItemIds.length;
			lines.push(`- ${label('Valor estimado', 'Estimated value')}: ${money(value)}${unpriced > 0
				? ` (${label(`parcial: ${String(unpriced)} objetos sin precio`, `partial: ${String(unpriced)} unpriced items`)})` : ''}`);
			const reason = session.observedItemsMs <= 0 ? label('sin tiempo observado', 'no observed time')
				: unpriced > 0 ? label('hay objetos sin precio', 'some items have no price')
				: session.coverage.items !== 'complete' ? label('cobertura de objetos incompleta', 'incomplete item coverage') : null;
			lines.push(`- ${label('Valor por hora', 'Value per hour')}: ${reason === null
				? money(Math.round(value * 3_600_000 / session.observedItemsMs)) : `${label('no disponible', 'unavailable')} (${reason})`}`);
		}
		if (valuation.coinNetCopper !== null) lines.push(`- ${label('Oro ganado', 'Gold gained')}: ${money(valuation.coinNetCopper)}`);

		const itemRows = session.totals.filter((row) => row.kind === 'item' && row.net !== 0);
		const prices = new Map(valuation.prices.map((price) => [price.itemId, price.unitCopper]));
		const top = sortLiveItemsByValue(session.totals, valuation.prices).filter((row) => row.net > 0).slice(0, TOP_ITEMS);
		lines.push('', `## ${label('Objetos de más valor', 'Most valuable items')}`, '');
		if (top.length === 0) lines.push(label('No se observaron objetos nuevos.', 'No new items were observed.'));
		else lines.push(`| ${label('Objeto', 'Item')} | ${label('Cantidad', 'Quantity')} | ${label('Valor', 'Value')} |`, '|---|---:|---:|',
			...top.map((row) => {
				const unit = prices.get(row.idNumber);
				return `| ${itemName(row.idNumber)} | ${String(row.net)} | ${unit === null || unit === undefined ? '—' : money(unit * row.net)} |`;
			}));
		lines.push('', `${label('Objetos distintos', 'Distinct items')}: ${String(itemRows.length)}`);

		const maps = mapTimes(session.mapIntervals);
		if (maps.length > 0) lines.push('', `## ${label('Mapas visitados', 'Maps visited')}`, '',
			...maps.slice(0, TOP_MAPS).map(([mapId, ms]) => `- ${label('Mapa', 'Map')} ${String(mapId)} · ${duration(ms)}`),
			...(session.mapCoveragePartial ? [label('La lista puede estar incompleta.', 'The list may be incomplete.')] : []));

		const gaps = gapSummary(session.gaps, session.endedAt);
		lines.push('', `## ${label('Cobertura', 'Coverage')}`, '', gaps.count === 0
			? label('Sin tramos sin observar.', 'No unobserved intervals.')
			: label(`${String(gaps.count)} tramos sin observar, en total ${duration(gaps.ms)}.`,
				`${String(gaps.count)} unobserved intervals, ${duration(gaps.ms)} in total.`));

		const link = input.fullNotePath.replace(/\.md$/u, '');
		lines.push('', `${label('Nota completa', 'Full note')}: ${/[[\]|#^]/u.test(link) ? `\`${link}\`` : `[[${link}|${label('Sesión de inventario observado', 'Observed inventory session')}]]`}`);

		const frontmatter = ['---', 'tyrian_summary_version: 1', `tyrian_summary_of: ${JSON.stringify(session.sessionRef)}`,
			`tyrian_summary_locale: ${JSON.stringify(input.locale)}`, `tyrian_summary_started_at: ${JSON.stringify(session.startedAt)}`,
			`tyrian_summary_ended_at: ${JSON.stringify(session.endedAt)}`, 'tags: ["gw2/session-summary"]', '---', ''].join('\n');
		const content = `${frontmatter}${lines.join('\n')}\n`;
		return { status: 'ok', note: { sessionRef: session.sessionRef, content,
			path: `${folder}/${liveSessionSummaryRelativePath(session.startedAt, session.sessionRef)}` } };
	} catch { return { status: 'invalid', reason: 'summary_unavailable' }; }
}

/**
 * Writes the summary once per session. An existing file is never overwritten: identical content
 * is `unchanged`; anything else (the user's edit, or an older render) is `kept` as it is.
 */
export class LiveSessionSummaryWriter {
	constructor(private readonly vault: LiveSessionSummaryVault) {}

	async write(input: LiveSessionSummaryInput): Promise<LiveSessionSummaryWriteResult> {
		const rendered = await renderLiveSessionSummary(input);
		if (rendered.status !== 'ok') return rendered;
		const { path, content, sessionRef } = rendered.note;
		try {
			const existing = this.vault.file(path);
			if (existing !== null) return await this.compare(existing, path, content, sessionRef);
			await ensureFoldersBySegments(this.vault, path.slice(0, path.lastIndexOf('/')), 'Folder creation failed.');
			try {
				await this.vault.create(path, content);
				return { status: 'written', path };
			} catch (error) {
				const raced = this.vault.file(path);
				if (raced === null) return { status: 'unavailable', message: 'The summary note could not be created.', errorName: errorClassName(error) };
				return await this.compare(raced, path, content, sessionRef);
			}
		} catch (error) {
			return { status: 'unavailable', message: 'The summary note could not be written safely.', errorName: errorClassName(error) };
		}
	}

	private async compare(file: { path: string }, path: string, content: string, sessionRef: string): Promise<LiveSessionSummaryWriteResult> {
		const current = await this.vault.read(file);
		if (current === content) return { status: 'unchanged', path };
		if (!current.includes(`tyrian_summary_of: ${JSON.stringify(sessionRef)}`)) {
			return { status: 'conflict', message: 'The summary path is occupied by another note.' };
		}
		return { status: 'kept', path };
	}
}

function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600); const minutes = Math.floor(total % 3600 / 60); const seconds = total % 60;
	const parts = [...(hours > 0 ? [`${String(hours)} h`] : []), ...(minutes > 0 ? [`${String(minutes)} min`] : []),
		...(hours === 0 && seconds > 0 || total === 0 ? [`${String(seconds)} s`] : [])];
	return parts.join(' ');
}

/** Time per map, longest first; a null map (unknown place) is not a place. */
function mapTimes(intervals: StoredLiveSessionPayloadV1['mapIntervals']): [number, number][] {
	const totals = new Map<number, number>();
	for (const interval of intervals) if (interval.mapId !== null) totals.set(interval.mapId, (totals.get(interval.mapId) ?? 0) + interval.toMs - interval.fromMs);
	return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/** Count and union duration of the unobserved intervals, whatever their channel; overlaps count once. */
function gapSummary(gaps: readonly LiveGapV1[], endedAt: string): { count: number; ms: number } {
	let end = Number.NEGATIVE_INFINITY; let ms = 0;
	for (const gap of [...gaps].sort((a, b) => a.fromAt.localeCompare(b.fromAt))) {
		const from = Date.parse(gap.fromAt); const to = Date.parse(gap.toAt ?? endedAt);
		ms += Math.max(0, to - Math.max(from, end)); end = Math.max(end, to);
	}
	return { count: gaps.length, ms };
}

function escapeMarkdown(value: string): string { return value.replace(/[\p{Cc}]/gu, ' ').replace(/[\\|<>]/gu, (match) => `\\${match}`); }
