import { formatCopperVisual } from '../core/copper-format';
import { errorClassName } from '../core/local-debug-error-details';
import { ensureFoldersBySegments } from '../core/vault-folders';
import { computeSummaryFigures, formatSummaryDuration as duration, SUMMARY_FOLD_COVERAGE, SUMMARY_SHORT_GAP_MS, summaryMainMap,
	type SummaryCharacter, type SummaryItemMetaMap, type SummaryMapRow, type SummaryMapStretch } from './live-session-summary-figures';
import { liveSessionLocalTime, liveSessionTitleStamp, systemUtcOffsetMinutes, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { LIVE_RATE_MIN_OBSERVED_MS } from './live-session-model';
import { MAX_SUMMARIES_READ } from './live-session-summary-history';
import { normalizeSessionOutputFolder } from './session-note-model';
import type { SessionNoteVault } from './session-note-writer';

/**
 * The short summary note of a closed live session (David, 2026-10-08), in a subfolder of the folder
 * chosen in settings. It is built only from the stored payload the full note already carries plus
 * what the caller read from caches (item flags and types, map names, previous summaries): it invents
 * nothing, and a figure that cannot be trusted is written as unavailable, with its reason.
 *
 * Its frontmatter deliberately has NO key starting with `tc_`. The history reads every note of the
 * vault: `inspectLiveSessionNote` takes `tc_schema`/`tc_kind`/`tc_source` as a session candidate, and
 * `inspectDurableSessionNote` (`hasTcHint`) treats ANY other `tc_*` key without a known `tc_kind` as an
 * invalid session note, which leaves the whole history out of service (measured). Hebra's adoption
 * likewise flags a Tyrian `tc_kind` it cannot map to a path. The keys here are `tyrian_summary_*`.
 */

/** Fixed subfolder of the output folder, next to `sessions/` (the repo's subfolders are not localized). */
export const LIVE_SESSION_SUMMARY_FOLDER = 'summaries';
const TOP_ITEMS = 5;
/** Below 90 % observed, this many unobserved stretches are written one per line, the longest first; the rest are counted. */
const MAX_LISTED_GAPS = 5;
/** Up to this many account-bound item types are named, all of them; with more the line counts them and names the first three. */
const MAX_NAMED_BOUND = 5;
const BOUND_NAMED_WHEN_COUNTED = 3;

export interface LiveSessionSummaryInput {
	session: StoredLiveSessionPayloadV1;
	locale: 'es' | 'en';
	outputFolder: string;
	/** Vault path of the full session note, as the receipt records it. */
	fullNotePath: string;
	/** The host's own link target for the full note (`TyrianVault.linkTarget`); absent, the link is by `fullNotePath`. */
	fullNoteLinkTarget?: string | null;
	displayNames?: Readonly<Record<string, string>>;
	/** Characters of the session in order of appearance (the runtime record's list); absent or empty means unknown. */
	characters?: readonly SummaryCharacter[];
	/** Item flags and types read from the catalog cache; an item without an entry is one the plugin could not read. */
	itemMeta?: SummaryItemMetaMap;
	/** Map names read from the cache or the public API; without one the note writes «Mapa <id>». */
	mapNames?: Readonly<Record<string, string>>;
	/** «Per hour» of earlier summaries with the same main map; the average is written from three of them. */
	comparablePerHour?: readonly number[];
	/** The average was read from the most recent summaries only (the read limit was reached): the line says of how many. */
	comparablesCapped?: boolean;
	/** The character list stopped growing at its cap: the line says so. */
	charactersCapped?: boolean;
	/** Offset of the machine's time zone from UTC, in minutes, at that instant. Defaults to the system's. */
	utcOffsetMinutes?: (atMs: number) => number;
}
export interface RenderedLiveSessionSummary { path: string; content: string; sessionRef: string; mainMapId: number | null }

export type LiveSessionSummaryWriteResult =
	| { status: 'written' | 'unchanged' | 'kept'; path: string }
	| { status: 'invalid'; reason: string }
	| { status: 'conflict' | 'unavailable'; message: string; errorName?: string };

/** The vault calls the writer needs; the common vault port satisfies it in Obsidian and in Hebra. */
export type LiveSessionSummaryVault = Pick<SessionNoteVault, 'file' | 'read' | 'createFolder' | 'create'> & Partial<Pick<SessionNoteVault, 'process'>>
	& { linkTarget?(path: string): string | null };

/** Minimum comparable sessions before «tu media» is written. */
export const SUMMARY_MIN_COMPARABLES = 3;

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
		const currencyName = (id: number): string => escapeMarkdown(names[`currency:${String(id)}`] ?? `${label('Moneda', 'Currency')} ${String(id)}`);
		// A name that arrived empty is no name: the map gets the reserve one, like a map nobody could name, never an empty cell or title.
		const rawMapName = (id: number): string => { const name = input.mapNames?.[String(id)]; return name !== undefined && name.trim() !== '' ? name : `${label('Mapa', 'Map')} ${String(id)}`; };
		const mapName = (id: number): string => escapeMarkdown(rawMapName(id));
		const offset = input.utcOffsetMinutes ?? systemUtcOffsetMinutes;
		const day = (iso: string): string => liveSessionLocalTime(iso, offset).day;
		const clock = (iso: string): string => liveSessionLocalTime(iso, offset).clock;
		const money = (copper: number): string => formatCopperVisual(copper);
		const signed = (copper: number): string => `${copper > 0 ? '+' : ''}${money(copper)}`;
		const characters = input.characters ?? [];
		const f = computeSummaryFigures(session, input.itemMeta ?? {}, characters);
		const several = characters.length > 1;
		// Read from the intervals as they are saved, like the main map: the title and `tyrian_summary_map` do not move with the breakdown.
		const noMapKnown = !session.mapIntervals.some((interval) => interval.mapId !== null);
		const mapHeading = f.mainMapId !== null ? mapName(f.mainMapId) : noMapKnown ? label('Mapa desconocido', 'Unknown map') : label('Varios mapas', 'Several maps');
		// The local day and hour of the start first (the same ones as the line below), so one summary is told from another in a list.
		const heading = `${liveSessionTitleStamp(session.startedAt, offset)} · ${label('Resumen', 'Summary')} · ${mapHeading}${characters.length === 1 ? ` · ${escapeMarkdown(characters[0]!.name)}` : ''}`;
		const out: string[] = [`# ${heading}`, '',
			`${day(session.startedAt)} · ${clock(session.startedAt)}–${clock(session.endedAt)} · ${duration(f.durationMs)} · ${String(f.observedPercent)} % ${label('observado', 'observed')}`];
		if (several) out.push('', `${label('Personajes', 'Characters')}: ${characters.map((entry) => escapeMarkdown(entry.name)).join(' → ')}${input.charactersCapped === true ? label(' … y más', ' … and more') : ''}`,
			label('Al cambiar de personaje no se mide lo que cambió entre uno y otro: las bolsas del nuevo no cuentan como ganadas ni las del anterior como perdidas.',
				'Switching character measures nothing across the switch: the new character\'s bags do not count as gained nor the previous one\'s as lost.'));

		const comparables = input.comparablePerHour ?? [];
		const average = comparables.length >= SUMMARY_MIN_COMPARABLES && f.mainMapId !== null
			? Math.round(comparables.reduce((sum, value) => sum + value, 0) / comparables.length) : null;
		const bound = f.unknownBindingIds.length > 0;
		const maxNote = bound ? ` (${label('como máximo: puede incluir objetos ligados a cuenta', 'at most: may include account-bound items')})` : '';
		// Every label says what its figure counts: the value and the pace are of the items the session observed (never the gold, which
		// has its own line, nor a balance of the wallet), and the hour is an observed hour, not one of the session's length.
		const netLabel = label('Valor neto de objetos observados', 'Net value of observed items');
		const rateLabel = label('Objetos por hora observada', 'Items per observed hour');
		const balance: string[] = [];
		const gold = f.goldCopper === null ? null : `${label('Cambio de oro observado', 'Observed gold change')}: ${signed(f.goldCopper)}`;
		if (f.salesSession && gold !== null) balance.push(`- **${gold}**`);
		if (f.dominantCurrency !== null) balance.push(`- **${currencyName(f.dominantCurrency.id)}: +${String(f.dominantCurrency.net)}** (${label('lo principal de la sesión', 'the main result of the session')})`);
		const shownNet = f.hasNewItems && !f.noPrices ? f.netCopper : null;
		const shownPerHour = shownNet === null ? null : f.perHour.copper;
		if (f.hasNewItems && f.noPrices) balance.push(`- ${label('Sin precios de bazar: no hay valor neto de objetos observados.', 'No bazaar prices: there is no net value of observed items.')}`);
		if (shownNet !== null) {
			balance.push(`- ${netLabel}: ${money(shownNet)}${maxNote}`);
			balance.push(`- ${rateLabel}: ${shownPerHour !== null ? `${money(shownPerHour)}${maxNote}`
				: label(`no disponible (menos de ${String(LIVE_RATE_MIN_OBSERVED_MS / 60_000)} min observados)`, `unavailable (under ${String(LIVE_RATE_MIN_OBSERVED_MS / 60_000)} observed min)`)}`);
			if (f.withoutDominant !== null) {
				const { itemId, netCopper: rest, perHourCopper: restPerHour } = f.withoutDominant;
				// With nothing positive left there is no pace to state: the line says what the value comes to without the item, and why.
				balance.push(restPerHour !== null
					? `- ${rateLabel} ${label('sin', 'without')} ${itemName(itemId)}: ${money(restPerHour)} (${label('ese objeto es más de la mitad del valor', 'that item is over half the value')})`
					: `- ${label('Sin', 'Without')} ${itemName(itemId)} ${label('el valor neto de objetos observados queda en', 'the net value of observed items comes to')} ${money(rest)} (${rest < 0
						? label('ese objeto vale más que todo el valor neto', 'that item is worth more than the whole net value')
						: label('ese objeto es todo el valor neto', 'that item is the whole net value')})`);
			}
			if (average !== null) balance.push(`- ${label('Tu media en sesiones parecidas', 'Your average in similar sessions')}: ${money(average)}/h (${label(`${String(comparables.length)} sesiones en este mapa`, `${String(comparables.length)} sessions on this map`)}${input.comparablesCapped === true ? label(`, entre tus ${String(MAX_SUMMARIES_READ)} resúmenes más recientes`, `, among your ${String(MAX_SUMMARIES_READ)} most recent summaries`) : ''})`);
		}
		if (gold !== null && !f.salesSession) balance.push(`- ${gold}`);
		if (f.staple !== null) balance.push(`- ${label('Lo que más entró', 'Most gained')}: ${itemName(f.staple.itemId)} ×${String(f.staple.quantity)} (${label(`entró ${String(f.staple.entries)} veces`, `came in ${String(f.staple.entries)} times`)}${f.staple.perHour !== null ? ` · ${String(f.staple.perHour)}/h` : ''})`);
		if (balance.length > 0) out.push('', `## ${label('Balance observado', 'Observed balance')}`, '', ...balance);

		if (f.hasNewItems) {
			const top = f.sellable.slice(0, TOP_ITEMS);
			// Not «to sell now»: the note is a record of what came in, and it does not know what is still in the bags when it is read.
			out.push('', `## ${label('Objetos observados de más valor', 'Most valuable observed items')}`, '');
			if (top.length === 0) out.push(label('Ningún objeto nuevo tiene precio de bazar.', 'No new item has a bazaar price.'));
			else out.push(`| ${label('Objeto', 'Item')} | ${label('Cantidad', 'Quantity')} | ${label('Valor neto de comisión', 'Value net of fees')} |`, '|---|---:|---:|',
				...top.map((row) => `| ${itemName(row.itemId)}${row.container ? ` (${label('sin abrir', 'unopened')})` : ''} | ${String(row.quantity)} | ${money(row.valueCopper!)} |`));
			if (f.unpriced.length > 0) out.push('', `${label('Sin precio de bazar (fuera del valor)', 'No bazaar price (outside the value)')}: ${f.unpriced.map((row) => `${itemName(row.itemId)} ×${String(row.quantity)}${row.container ? ` (${label('sin abrir', 'unopened')})` : ''}`).join(', ')}`);
			// A handful is named whole; a farming session binds dozens, and then the line is a count with the first three, in the order they came.
			const boundCount = f.boundItemIds.length;
			if (boundCount > MAX_NAMED_BOUND) {
				const named = f.boundItemIds.slice(0, BOUND_NAMED_WHEN_COUNTED).map(itemName).join(', '); const more = String(boundCount - BOUND_NAMED_WHEN_COUNTED);
				out.push('', label(`${String(boundCount)} tipos de objeto ligados a cuenta, fuera de la lista y del valor: ${named} y ${more} más.`,
					`${String(boundCount)} account-bound item types, outside the list and the value: ${named} and ${more} more.`));
			} else if (boundCount > 0) out.push('', `${label('Ligados a cuenta (fuera de la lista y del valor)', 'Account-bound (outside the list and the value)')}: ${f.boundItemIds.map(itemName).join(', ')}`);
		}

		if (f.currencies.length > 0) out.push('', `## ${label('Cambios de otras monedas', 'Other currency changes')}`, '',
			...f.currencies.map((row) => `- ${currencyName(row.id)}: ${row.net > 0 ? '+' : ''}${String(row.net)}`));

		if (f.alerts.length > 0) out.push('', `## ${label('Lo bueno', 'The good')}`, '',
			...f.alerts.map((alert) => `- ${clock(alert.at)} · ${itemName(alert.itemId)} ×${String(alert.quantity)}${alert.totalCopper === null ? '' : ` · ${money(alert.totalCopper)}`}`));

		// Units and item types, both counted: «5 objetos» read as five items when it was five units of four. One unit is of one item.
		if (f.outCount === 1) out.push('', label('Salió del inventario 1 unidad de un objeto; no se distingue si se vendió, se consumió o se depositó.',
			'1 unit of one item left the inventory; it cannot tell whether it was sold, consumed or deposited.'));
		else if (f.outCount > 0) out.push('', label(`Salieron del inventario ${String(f.outCount)} unidades de ${String(f.outKinds)} ${f.outKinds === 1 ? 'tipo' : 'tipos'} de objeto; no se distingue si se vendieron, se consumieron o se depositaron.`,
			`${String(f.outCount)} units of ${String(f.outKinds)} item ${f.outKinds === 1 ? 'type' : 'types'} left the inventory; it cannot tell whether they were sold, consumed or deposited.`));

		const byMap = f.mapBreakdown;
		if (byMap.rows.length > 0) {
			// The value columns go with the balance: a note that states no net value of items states none by map either.
			const valued = shownNet !== null;
			const unidentified = (capital: boolean): string => capital ? label('Sin mapa identificado', 'No identified map') : label('sin mapa identificado', 'no identified map');
			// What was observed on no identified map is a row when there is any (the figures give it time only for a stretch, the same one
			// the route steps on), or when it holds value the rows above would not add up without: units no journal entry accounts for.
			// It is what says the maps above are not the whole session: nothing else is written about a map that may be missing.
			const rows = [...byMap.rows, ...(byMap.unidentified.observedMs > 0 || valued && byMap.unidentified.netCopper !== 0 ? [byMap.unidentified] : [])];
			// The table as data: a column is its heading, its alignment and how it writes a row, so a label, the order or a column is one
			// line to change. Every time is observed item time and every value a part of the net value above: each column adds up to it.
			const columns: { heading: string; align: '---' | '---:'; cell: (row: SummaryMapRow) => string }[] = [
				{ heading: label('Mapa', 'Map'), align: '---', cell: (row) => row.mapId === null ? unidentified(true) : mapName(row.mapId) },
				{ heading: label('Tiempo observado', 'Observed time'), align: '---:', cell: (row) => duration(row.observedMs) },
				...(valued ? [
					{ heading: label('Valor neto de objetos', 'Net item value'), align: '---:' as const, cell: (row: SummaryMapRow): string => row.netCopper === null ? '—' : money(row.netCopper) },
					// No pace under the 15 minutes observed on that map every live rate needs.
					{ heading: label('Por hora observada', 'Per observed hour'), align: '---:' as const, cell: (row: SummaryMapRow): string => row.perHourCopper === null ? '—' : money(row.perHourCopper) }] : [])];
			out.push('', `## ${label('Mapas', 'Maps')}`, '');
			// One map and nothing outside it: its value and its pace are the balance's own, so one line says all the table would.
			if (rows.length === 1) out.push(`${columns[0]!.cell(rows[0]!)} · ${label('tiempo observado', 'observed time')}: ${columns[1]!.cell(rows[0]!)}`);
			else out.push(`| ${columns.map((column) => column.heading).join(' | ')} |`, `|${columns.map((column) => column.align).join('|')}|`,
				...rows.map((row) => `| ${columns.map((column) => column.cell(row)).join(' | ')} |`));
			// The route: every entry with its local hour, returns to a map included. A blank line first, as before every paragraph under a table.
			if (byMap.visits.length > 1) out.push('', byMap.visits.map((visit) => `${clock(visit.at)} ${visit.mapId === null ? unidentified(false) : mapName(visit.mapId)}`).join(' → '));
			// The limit of the split, only where there is a split of value to misread.
			if (valued && rows.length > 1) out.push('', label('Lo que llega durante la carga de un mapa, o lo que se abre en el mapa siguiente, cuenta en el mapa donde se observó.',
				'What arrives while a map loads, or is opened on the next map, counts on the map where it was observed.'));
		}

		// Each stretch on a map with the hours it was entered and left (David, 10 Oct 2026): the table above adds a map's visits together
		// and the route only says when each began. With one identified map there is nothing to tell apart, and nothing is added.
		if (byMap.rows.length > 1) {
			const when = (at: string): string => day(at) === day(session.startedAt) ? clock(at) : `${day(at)} ${clock(at)}`;
			const stretchValue = (stretch: SummaryMapStretch): string => stretch.netCopper !== null ? money(stretch.netCopper)
				: stretch.changes === 0 ? label('sin cambios de objetos', 'no item changes')
					: !stretch.priced && f.hasNewItems ? label('sin precios de bazar', 'no bazaar prices') : '—';
			// The value goes with the balance, as in the table of maps: a note that states no net value of items states none by stretch.
			const withValue = f.hasNewItems;
			out.push('', `## ${label('Tramos de mapa', 'Map stretches')}`, '',
				`| ${label('Mapa', 'Map')} | ${label('Entrada', 'Entered')} | ${label('Salida', 'Left')} | ${label('Duración', 'Length')}${withValue ? ` | ${label('Valor neto de objetos', 'Net value of items')}` : ''} |`,
				`|---|---:|---:|---:${withValue ? '|---:' : ''}|`,
				...byMap.stretches.map((stretch) => `| ${stretch.mapId === null ? label('Sin mapa identificado', 'No identified map') : mapName(stretch.mapId)} | ${when(stretch.fromAt)} | ${when(stretch.toAt)} | ${duration(stretch.ms)}${withValue ? ` | ${stretchValue(stretch)}` : ''} |`));
		}

		const extra: string[] = [];
		if (session.magicFind.source === 'verified' && session.magicFind.value !== null) extra.push(`- ${label('Hallazgo mágico', 'Magic find')}: ${String(session.magicFind.value)}`);
		if (session.coverage.freeSlots !== null) extra.push(`- ${label('Huecos libres al cerrar', 'Free slots at close')}: ${String(session.coverage.freeSlots)}`);
		if (extra.length > 0) out.push('', `## ${label('Al cerrar', 'At close')}`, '', ...extra);

		out.push('', `## ${label('Cobertura', 'Coverage')}`, '');
		// The same truncated percent as the header, so the two never disagree: «no unobserved interval» alone is said only
		// of a session observed in full, and any stretch on record keeps the header at 99 % or less.
		const percent = String(f.observedPercent);
		if (f.gapStretches === 0) {
			out.push(f.observedPercent === 100 ? label('Sin tramos sin observar.', 'No unobserved intervals.')
				: label(`Se observó el ${percent} % de la sesión; ningún tramo sin observar quedó registrado.`, `${percent} % of the session was observed; no unobserved interval was recorded.`));
		} else if (f.observedShare >= SUMMARY_FOLD_COVERAGE) {
			out.push(label(`${String(f.gapStretches)} ${f.gapStretches === 1 ? 'tramo' : 'tramos'} sin observar, en total ${duration(f.gapsMs)}.`,
				`${String(f.gapStretches)} unobserved ${f.gapStretches === 1 ? 'interval' : 'intervals'}, ${duration(f.gapsMs)} in total.`));
		} else {
			// How much was observed and how much was not, then what explains it: the long stretches one per line, the longest first,
			// each once whatever the channels it took, and the cuts of a few seconds counted together instead of filling the list.
			const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
			const total = (stretches: readonly { ms: number }[]): string => minutesSeconds(stretches.reduce((sum, stretch) => sum + stretch.ms, 0));
			out.push(label(`Objetos observados durante ${minutesSeconds(session.observedItemsMs)} de una sesión de ${minutesSeconds(f.durationMs)}: ${percent} %.`,
				`Items observed for ${minutesSeconds(session.observedItemsMs)} of a session of ${minutesSeconds(f.durationMs)}: ${percent} %.`),
			// The time above is of items and this one is of either channel: what is of currencies alone is said here, so that the
			// reader can take it off and see the two lines add up to the session's length. Under a second it is not worth a clause.
			`${label(`Sin observar: ${minutesSeconds(f.gapsMs)}, en ${count(f.gapStretches, 'tramo', 'tramos')}`, `Unobserved: ${minutesSeconds(f.gapsMs)}, in ${count(f.gapStretches, 'interval', 'intervals')}`)}${
				Math.round(f.gapsCurrencyOnlyMs / 1000) > 0 ? label(`; ${minutesSeconds(f.gapsCurrencyOnlyMs)} de ellos solo de monedas`, `; ${minutesSeconds(f.gapsCurrencyOnlyMs)} of it of currencies only`) : ''}.`);
			const long = f.stretches.filter((stretch) => stretch.ms >= SUMMARY_SHORT_GAP_MS).sort((a, b) => b.ms - a.ms || Date.parse(a.fromAt) - Date.parse(b.fromAt));
			const cuts = f.stretches.filter((stretch) => stretch.ms < SUMMARY_SHORT_GAP_MS);
			const listed = long.slice(0, MAX_LISTED_GAPS); const unlisted = long.slice(MAX_LISTED_GAPS);
			for (const stretch of listed) {
				// A stretch inside one minute is written with that minute once: its length is on the line, so «08:54–08:54» says nothing.
				const from = clock(stretch.fromAt); const to = clock(stretch.toAt);
				// The section is about items, so «solo monedas» is the exception worth a word. «Solo objetos» is said only of a session that
				// followed currencies at all: without them every stretch is of items alone, and the label would be on every line.
				const channel = stretch.onlyChannel === 'currencies' ? ` · ${label('solo monedas', 'currencies only')}`
					: stretch.onlyChannel === 'items' && session.observedCurrenciesMs > 0 ? ` · ${label('solo objetos', 'items only')}` : '';
				out.push(`- ${from === to ? from : `${from}–${to}`} · ${minutesSeconds(stretch.ms)} · ${stretch.characterChange ? label('cambio de personaje', 'character change') : gapReason(stretch.reason, es)}${channel}`);
			}
			const shortLimit = `${String(SUMMARY_SHORT_GAP_MS / 1000)} s`;
			const rest = [...(unlisted.length > 0 ? [label(`${count(unlisted.length, 'tramo', 'tramos')} más, en total ${total(unlisted)}`, `${count(unlisted.length, 'more interval', 'more intervals')}, ${total(unlisted)} in total`)] : []),
				...(cuts.length > 0 ? [label(`${count(cuts.length, 'corte', 'cortes')} de menos de ${shortLimit}, en total ${total(cuts)}`, `${count(cuts.length, 'cut', 'cuts')} under ${shortLimit}, ${total(cuts)} in total`)] : [])];
			// With no stretch listed everything is a cut, and the line above already gave their number and their time.
			if (listed.length === 0) out.push(cuts.length === 1 ? label(`Es un corte de menos de ${shortLimit}.`, `It is a cut under ${shortLimit}.`)
				: label(`Todos son cortes de menos de ${shortLimit}.`, `All of them are cuts under ${shortLimit}.`));
			else if (rest.length > 0) out.push('', label(`Y ${rest.join(', y ')}.`, `And ${rest.join(', and ')}.`));
		}

		// The host's own target (Hebra: `id:<uuid>`) when it gave one; otherwise the vault path, which Obsidian resolves.
		const hostTarget = input.fullNoteLinkTarget !== undefined && input.fullNoteLinkTarget !== '' ? input.fullNoteLinkTarget : null;
		const link = hostTarget ?? input.fullNotePath.replace(/\.md$/u, '');
		// The link reads as what it opens. A path a wikilink cannot carry is written as text, and then it needs the label in front.
		const fullSession = label('Sesión completa', 'Full session');
		out.push('', /[[\]|#^]/u.test(link) ? `${fullSession}: \`${link}\`` : `[[${link}|${fullSession}]]`);

		const raw = (id: number, kind: 'item' | 'map'): string => kind === 'map' ? rawMapName(id) : (names[`item:${String(id)}`] ?? `${label('Objeto', 'Item')} ${String(id)}`);
		const mapText = f.mainMapId !== null ? raw(f.mainMapId, 'map') : noMapKnown ? label('Mapa desconocido', 'Unknown map') : label('Varios mapas', 'Several maps');
		const topItem = f.staple !== null ? { id: f.staple.itemId, count: f.staple.quantity } : f.sellable[0] !== undefined ? { id: f.sellable[0].itemId, count: f.sellable[0].quantity } : null;
		const goldText = (copper: number | null): string => copper === null ? 'null' : String(Number((copper / 10_000).toFixed(4)));
		const fm = ['---', 'tyrian_summary_version: 3', `tyrian_summary_of: ${JSON.stringify(session.sessionRef)}`,
			`tyrian_summary_locale: ${JSON.stringify(input.locale)}`, `tyrian_summary_started_at: ${JSON.stringify(session.startedAt)}`,
			`tyrian_summary_ended_at: ${JSON.stringify(session.endedAt)}`, `tyrian_summary_main_map: ${f.mainMapId === null ? 'null' : String(f.mainMapId)}`,
			`tyrian_summary_net_copper: ${shownNet === null ? 'null' : String(shownNet)}`, `tyrian_summary_per_hour_copper: ${shownPerHour === null ? 'null' : String(shownPerHour)}`,
			`tyrian_summary_observed_minutes: ${String(Math.round(session.observedItemsMs / 60_000))}`,
			`tyrian_summary_date: ${day(session.startedAt)}`, `tyrian_summary_map: ${JSON.stringify(mapText)}`,
			`tyrian_summary_characters: ${JSON.stringify(characters.map((entry) => entry.name))}`,
			`tyrian_summary_duration_minutes: ${String(Math.round(f.durationMs / 60_000))}`, `tyrian_summary_observed_percent: ${String(f.observedPercent)}`,
			`tyrian_summary_net_gold: ${goldText(shownNet)}`, `tyrian_summary_per_hour_gold: ${goldText(shownPerHour)}`, `tyrian_summary_wallet_gold: ${goldText(f.goldCopper)}`,
			`tyrian_summary_top_item: ${topItem === null ? 'null' : JSON.stringify(raw(topItem.id, 'item'))}`, `tyrian_summary_top_item_count: ${topItem === null ? 'null' : String(topItem.count)}`,
			`tyrian_summary_top_item_icon: ${topItem === null ? 'null' : iconText(input.itemMeta?.[topItem.id]?.icon)}`,
			`tyrian_summary_top_item_id: ${topItem === null ? 'null' : String(topItem.id)}`, `tyrian_summary_map_ids: ${JSON.stringify(f.mapBreakdown.rows.flatMap((row) => row.mapId === null ? [] : [row.mapId]))}`,
			`tyrian_summary_alerts: ${String(f.alerts.length)}`, `tyrian_summary_free_slots: ${session.coverage.freeSlots === null ? 'null' : String(session.coverage.freeSlots)}`,
			'tags: ["gw2/session-summary"]', '---', ''].join('\n');
		return { status: 'ok', note: { sessionRef: session.sessionRef, mainMapId: summaryMainMap(session), content: `${fm}${out.join('\n')}\n`,
			path: `${folder}/${liveSessionSummaryRelativePath(session.startedAt, session.sessionRef)}` } };
	} catch { return { status: 'invalid', reason: 'summary_unavailable' }; }
}

const BACK_LINK_PATTERN = /\|(?:Resumen|Summary)\]\]|^(?:Resumen|Summary): /mu;

/**
 * Links the full note of a session back to its summary, by the same rule the summary links forward (the host's own target when it
 * has one, which on Hebra is `id:<uuid>`; the vault path otherwise, which Obsidian resolves). It can only be written once the
 * summary exists, because a host that names notes by id knows the summary's only then. The line goes under the title and outside every
 * managed block, so writing the session again keeps it and no hash changes; the payload, the frontmatter and the path are not touched.
 *
 * It touches only a live note of THIS session (`sessionRef` in its frontmatter) that has its managed blocks, and writes nothing when the
 * link is already there. `linked`: written; `present`: already there; `skipped`: not a note it may edit, or the vault cannot edit.
 */
export async function linkFullNoteToSummary(vault: LiveSessionSummaryVault,
	input: { fullNotePath: string; summaryPath: string; sessionRef: string; locale: 'es' | 'en' }): Promise<'linked' | 'present' | 'skipped'> {
	const file = vault.file(input.fullNotePath);
	if (file === null || vault.process === undefined) return 'skipped';
	const hostTarget = vault.linkTarget?.(input.summaryPath);
	const target = hostTarget !== undefined && hostTarget !== null && hostTarget !== '' ? hostTarget : input.summaryPath.replace(/\.md$/u, '');
	const word = input.locale === 'es' ? 'Resumen' : 'Summary';
	const line = /[[\]|#^]/u.test(target) ? `${word}: \`${target}\`` : `[[${target}|${word}]]`;
	let outcome: 'linked' | 'present' | 'skipped' = 'skipped';
	// The host may run the update again on a fresh read: the outcome is that of the run whose text was written.
	await vault.process(file, (current) => {
		outcome = 'skipped';
		const end = current.startsWith('---\n') ? current.indexOf('\n---\n', 4) : -1;
		const marker = current.indexOf('<!-- tyrian-companion:managed:start:summary');
		if (end < 0 || marker < end) return current;
		const frontmatter = current.slice(4, end);
		if (!/^tc_source: "?nexus_inventory"?$/mu.test(frontmatter) || !frontmatter.includes(input.sessionRef)) return current;
		if (BACK_LINK_PATTERN.test(current.slice(end, marker))) { outcome = 'present'; return current; }
		outcome = 'linked';
		return `${current.slice(0, marker)}${line}\n\n${current.slice(marker)}`;
	});
	return outcome;
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

/**
 * Minutes and seconds, to the second and with no hours: «81 min 12 s». The coverage states what was observed, what was not
 * and the session's length, and those add up only if none is rounded to the minute (`duration` drops the seconds past the hour).
 */
function minutesSeconds(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60); const seconds = total % 60;
	return [...(minutes > 0 ? [`${String(minutes)} min`] : []), ...(seconds > 0 || minutes === 0 ? [`${String(seconds)} s`] : [])].join(' ');
}

function gapReason(reason: StoredLiveSessionPayloadV1['gaps'][number]['reason'], es: boolean): string {
	const labels = { disconnect: ['desconexión', 'disconnect'], source_stale: ['fuente sin muestras recientes', 'source stale'],
		read_failed: ['lectura no disponible', 'read unavailable'], partial_inventory: ['inventario parcial', 'partial inventory'],
		context_changed: ['cambio de contexto', 'context changed'], host_restart: ['reinicio', 'restart'],
		storage_unavailable: ['almacenamiento no disponible', 'storage unavailable'], unsupported_build: ['versión no compatible', 'unsupported version'],
		source_missing: ['fuente ausente', 'source missing'], cursor_gap: ['continuidad perdida', 'continuity lost'] };
	return labels[reason][es ? 0 : 1]!;
}

/**
 * The top item's icon as a YAML scalar: the URL quoted when it is on the public GW2 render host with
 * no credentials, `null` otherwise (no cache record, no icon, another origin). Same check as the UI's.
 */
function iconText(icon: string | undefined): string {
	// A path must follow the host directly (so no `user@` or `.evil` suffix) and nothing may need escaping.
	return icon !== undefined && /^https:\/\/render\.guildwars2\.com\/[^\s"\\@\p{Cc}]*$/u.test(icon) ? JSON.stringify(icon) : 'null';
}

function escapeMarkdown(value: string): string { return value.replace(/[\p{Cc}]/gu, ' ').replace(/[\\|<>]/gu, (match) => `\\${match}`); }
