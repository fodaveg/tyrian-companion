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
const LIVE_SESSION_SUMMARY_FOLDER = 'summaries';
const TOP_ITEMS = 5;
/** Below 90 % observed, this many unobserved stretches are written one per line, the longest first; the rest are counted. */
const MAX_LISTED_GAPS = 5;
/** Up to this many account-bound item types are named, all of them; with more the line counts them and names the first three. */
const MAX_NAMED_BOUND = 5;
const BOUND_NAMED_WHEN_COUNTED = 3;
/** The items that decreased the most are named up to this many; the rest is counted in the sentence above them. */
const MAX_DECREASED_ITEMS = 3;
/** With this many free slots or fewer the close line says the bags are almost full. */
const ALMOST_FULL_SLOTS = 10;
/** Width of an item icon in a table, in px: up to 24 the line keeps the height of its neighbours in Hebra, before and after loading. */
const ICON_SIZE = 20;

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
	/**
	 * The host paints a remote image inside a line of the note (`![Nombre|20](https://…)`): Obsidian natively, Hebra where its plugin
	 * API answers `markdown.image.remote` (1.4). Only with true does an item table carry the icon the catalog cache holds for the item,
	 * in the item's cell and before its name; absent or false the note writes the name alone, as before (David, 9 Oct 2026).
	 */
	inlineIcons?: boolean;
}
interface RenderedLiveSessionSummary { path: string; content: string; sessionRef: string; mainMapId: number | null }

export type LiveSessionSummaryWriteResult =
	| { status: 'written' | 'unchanged' | 'kept'; path: string }
	| { status: 'invalid'; reason: string }
	| { status: 'conflict' | 'unavailable'; message: string; errorName?: string };

/** The vault calls the writer needs; the common vault port satisfies it in Obsidian and in Hebra. */
export type LiveSessionSummaryVault = Pick<SessionNoteVault, 'file' | 'read' | 'createFolder' | 'create'> & Partial<Pick<SessionNoteVault, 'process'>>
	& { linkTarget?(path: string): string | null };

/** Minimum comparable sessions before «tu media» is written. */
const SUMMARY_MIN_COMPARABLES = 3;

/** `summaries/2026-10-08 153000Z - 0123456789abcdef - summary.md`: the full note's UTC stamp and ref prefix, no forbidden character. */
export function liveSessionSummaryRelativePath(startedAt: string, sessionRef: string): string {
	const started = new Date(startedAt);
	const pad = (value: number): string => String(value).padStart(2, '0');
	const date = `${String(started.getUTCFullYear()).padStart(4, '0')}-${pad(started.getUTCMonth() + 1)}-${pad(started.getUTCDate())}`;
	const time = `${pad(started.getUTCHours())}${pad(started.getUTCMinutes())}${pad(started.getUTCSeconds())}Z`;
	return `${LIVE_SESSION_SUMMARY_FOLDER}/${date} ${time} - ${sessionRef.slice(0, 16)} - summary.md`;
}

/**
 * The identity a summary note carries for its path, read from its own frontmatter (`tyrian_summary_of`: the full session ref;
 * `tyrian_summary_started_at`), or null when the text is no summary or either value is unusable. A host that names notes by id (Hebra)
 * adopts a summary it did not write with this: the path it answers is the one `liveSessionSummaryRelativePath` writes.
 */
export function liveSessionSummaryPathIdentity(text: string): { sessionRef: string; startedAt: string } | null {
	if (!text.startsWith('---\n')) return null;
	const end = text.indexOf('\n---\n', 4);
	if (end < 0) return null;
	const frontmatter = text.slice(4, end);
	const read = (key: string): string | null => {
		// Both values are written with `JSON.stringify` and hold no character that would be escaped, so a plain quoted string is the only valid form.
		return new RegExp(`^tyrian_summary_${key}: "([^"\\\\]+)"[ \\t]*$`, 'mu').exec(frontmatter)?.[1] ?? null;
	};
	const sessionRef = read('of'); const startedAt = read('started_at');
	if (sessionRef === null || startedAt === null || !/^[a-f0-9]{64}$/u.test(sessionRef) || !Number.isFinite(Date.parse(startedAt))) return null;
	return { sessionRef, startedAt };
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
		// An item name that arrived empty or blank is no name, as for maps: «Objeto <id>», never an empty cell or an image without text.
		const rawItemName = (id: number): string => { const name = names[`item:${String(id)}`]; return name !== undefined && name.trim() !== '' ? name : `${label('Objeto', 'Item')} ${String(id)}`; };
		const itemName = (id: number): string => escapeMarkdown(rawItemName(id));
		// In a table cell: the item's icon, 20 px, in front of its name. The alternative text is the name itself, so an icon that does
		// not load leaves a name to read; a cached icon off the GW2 render host, or a host that would show the Markdown, leaves the name alone.
		// With the icon the name is written twice on one line, so a backtick or a `$` in it would pair with its copy (a code span, or
		// Obsidian's inline maths) and swallow the image: both copies escape them. Without the icon the cell stays as it always was.
		const iconUrl = (id: number): string | null => input.inlineIcons === true ? inlineIconUrl(input.itemMeta?.[id]?.icon) : null;
		const itemCell = (id: number): string => {
			const url = iconUrl(id); if (url === null) return itemName(id);
			const shown = escapeCodeAndMath(itemName(id));
			return `![${imageAlt(shown)}\\|${String(ICON_SIZE)}](${url}) ${shown}`;
		};
		const currencyName = (id: number): string => escapeMarkdown(names[`currency:${String(id)}`] ?? `${label('Moneda', 'Currency')} ${String(id)}`);
		// A name that arrived empty is no name: the map gets the reserve one, like a map nobody could name, never an empty cell or title.
		const rawMapName = (id: number): string => { const name = input.mapNames?.[String(id)]; return name !== undefined && name.trim() !== '' ? name : `${label('Mapa', 'Map')} ${String(id)}`; };
		const mapName = (id: number): string => escapeMarkdown(rawMapName(id));
		const offset = input.utcOffsetMinutes ?? systemUtcOffsetMinutes;
		const day = (iso: string): string => liveSessionLocalTime(iso, offset).day;
		const clock = (iso: string): string => liveSessionLocalTime(iso, offset).clock;
		const money = summaryMoney;
		const signed = (copper: number): string => `${copper > 0 ? '+' : ''}${money(copper)}`;
		const characters = input.characters ?? [];
		const f = computeSummaryFigures(session, input.itemMeta ?? {}, characters);
		const several = characters.length > 1;
		// Read from the intervals as they are saved, like the main map: the title and `tyrian_summary_map` do not move with the breakdown.
		const noMapKnown = !session.mapIntervals.some((interval) => interval.mapId !== null);
		const mapHeading = f.mainMapId !== null ? mapName(f.mainMapId) : noMapKnown ? label('Mapa desconocido', 'Unknown map') : label('Varios mapas', 'Several maps');
		// The local day and hour of the start first (the same ones as the line below), so one summary is told from another in a list.
		const heading = `${liveSessionTitleStamp(session.startedAt, offset)} · ${label('Resumen', 'Summary')} · ${mapHeading}${characters.length === 1 ? ` · ${escapeMarkdown(characters[0]!.name)}` : ''}`;
		// From 90 % observed the header carries what was not observed and the «Coverage» section is not written (version 4).
		const folded = f.observedShare >= SUMMARY_FOLD_COVERAGE;
		// Of ITEMS, the channel the percent is of: a cut of the wallet alone has its own sentence below.
		const itemsUnobservedMs = Math.max(0, f.gapsMs - f.gapsCurrencyOnlyMs);
		const unobserved = folded && f.gapStretches > 0 && Math.round(itemsUnobservedMs / 1000) > 0 ? ` (${minutesSeconds(itemsUnobservedMs)} ${label('sin observar', 'unobserved')})` : '';
		const out: string[] = [`# ${heading}`, '',
			`${day(session.startedAt)} · ${clock(session.startedAt)}–${clock(session.endedAt)} · ${duration(f.durationMs)} · ${String(f.observedPercent)} % ${label('observado', 'observed')}${unobserved}`];
		// What the bags and the build looked like at the close, in one line: it answers «do I have to sell now?» and is written only when it is known.
		const closing: string[] = [];
		if (session.coverage.freeSlots !== null) closing.push(`${label('Huecos libres', 'Free slots')}: ${String(session.coverage.freeSlots)}${session.coverage.freeSlots <= ALMOST_FULL_SLOTS ? ` (${label('bolsas casi llenas', 'bags almost full')})` : ''}`);
		if (session.magicFind.source === 'verified' && session.magicFind.value !== null) closing.push(`${label('Hallazgo mágico', 'Magic find')}: ${String(session.magicFind.value)}`);
		if (closing.length > 0) out.push('', closing.join(' · '));
		// The percent above is of ITEM time. The wallet is observed on its own channel: when it was out for longer than the items were, the gold is shorter than it looks.
		if (folded && Math.round(f.gapsCurrencyOnlyMs / 1000) > 0) out.push('', label(`Las monedas estuvieron ${minutesSeconds(f.gapsCurrencyOnlyMs)} sin observar mientras los objetos sí se observaban: el cambio de oro y de otras monedas puede estar incompleto.`,
			`Currencies went unobserved for ${minutesSeconds(f.gapsCurrencyOnlyMs)} while items were observed: the change of gold and of other currencies may be incomplete.`));
		if (several) out.push('', `${label('Personajes', 'Characters')}: ${characters.map((entry) => escapeMarkdown(entry.name)).join(' → ')}${input.charactersCapped === true ? label(' … y más', ' … and more') : ''}`,
			label('Al cambiar de personaje no se mide lo que cambió entre uno y otro: las bolsas del nuevo no cuentan como ganadas ni las del anterior como perdidas.',
				'Switching character measures nothing across the switch: the new character\'s bags do not count as gained nor the previous one\'s as lost.'));

		const comparables = input.comparablePerHour ?? [];
		const average = comparables.length >= SUMMARY_MIN_COMPARABLES && f.mainMapId !== null
			? Math.round(comparables.reduce((sum, value) => sum + value, 0) / comparables.length) : null;
		const bound = f.unknownBindingIds.length > 0;
		// «Result»: the change the session observed. The total is the wallet's gold plus the value of the items, the two parts in view; it is an
		// estimate of what was OBSERVED, not of what was farmed: the ledger keeps the cause of a movement as unknown (a deposit, a purchase or
		// a bazaar sale collected from the delivery box move gold and items all the same). The pace has the items' observed time as its hour.
		const goldCopper = f.goldCopper;
		const shownNet = f.hasNewItems && !f.noPrices ? f.netCopper : null;
		const shownPerHour = shownNet === null ? null : f.perHour.copper;
		const totalCopper = goldCopper !== null && shownNet !== null ? goldCopper + shownNet : null;
		const totalPerHour = totalCopper !== null && f.perHour.reason === null ? Math.round(totalCopper * 3_600_000 / session.observedItemsMs) : null;
		const unavailable = label(`no disponible (menos de ${String(LIVE_RATE_MIN_OBSERVED_MS / 60_000)} min observados)`, `unavailable (under ${String(LIVE_RATE_MIN_OBSERVED_MS / 60_000)} observed min)`);
		const rateLabel = label('Objetos por hora observada', 'Items per observed hour');
		const resultRows: string[] = [];
		if (totalCopper !== null) resultRows.push(`| **${label('Cambio neto estimado observado', 'Estimated net change observed')}** | **${signed(totalCopper)}** |`);
		if (goldCopper !== null) resultRows.push(`| ${label('Cambio de oro', 'Gold change')} | ${signed(goldCopper)} |`);
		if (shownNet !== null) resultRows.push(`| ${label('Cambio de valor de objetos', 'Item value change')} | ${signed(shownNet)} |`);
		if (totalCopper !== null) resultRows.push(`| **${label('Cambio neto por hora observada', 'Net change per observed hour')}** | **${totalPerHour !== null ? money(totalPerHour) : unavailable}** |`);
		if (shownNet !== null) resultRows.push(`| ${rateLabel} | ${shownPerHour !== null ? money(shownPerHour) : unavailable} |`);
		// A part that is missing is said, with its reason, instead of a total that would count it as zero.
		let missing: string | null = null;
		if (shownNet === null) {
			if (f.hasNewItems && f.noPrices) missing = goldCopper !== null ? label('Sin precios de bazar: no hay valor de objetos ni total.', 'No bazaar prices: there is no item value and no total.')
				: label('Sin precios de bazar: no hay valor de objetos.', 'No bazaar prices: there is no item value.');
			else if (goldCopper !== null) missing = label('Sin objetos nuevos con valor observado: no hay valor de objetos ni total.', 'No new items with an observed value: there is no item value and no total.');
		} else if (goldCopper === null) missing = label('Sin cambio de oro observado: no hay total.', 'No gold change observed: there is no total.');
		const afterResult: string[] = [];
		if (resultRows.length > 0) afterResult.push([
			label('Incluye todos los movimientos de bolsas y cartera durante la sesión (depósitos, compras, oro del bazar recogido); no distingue lo farmeado de lo demás.',
				'Includes every bag and wallet movement during the session (deposits, purchases, bazaar gold collected); it does not tell what was farmed from the rest.'),
			...(shownNet !== null ? [label('Valor de objetos: venta inmediata en el bazar con la comisión descontada.', 'Item value: instant sale on the bazaar with the fee deducted.')] : []),
			label('El oro del bazar aparece en la cartera cuando lo recoges, no cuando se vende.', 'Bazaar gold shows up in the wallet when you collect it, not when it sells.')].join(' '));
		// An item the plugin could not read may be bound to the account: the value, the total and both paces are then an upper bound.
		if (bound && shownNet !== null) afterResult.push(label('Como máximo: el valor de objetos, el total y sus tasas por hora pueden incluir objetos ligados a cuenta, porque no se pudo leer cuáles lo eran.',
			'At most: the item value, the total and their hourly paces may include account-bound items, because it could not be read which ones were.'));
		if (shownNet !== null && f.withoutDominant !== null) {
			const { itemId, netCopper: rest, perHourCopper: restPerHour } = f.withoutDominant;
			// With nothing positive left there is no pace to state: the line says what the value comes to without the item, and why.
			afterResult.push(restPerHour !== null
				? `${rateLabel} ${label('sin', 'without')} ${itemName(itemId)}: ${money(restPerHour)} (${label('ese objeto es más de la mitad del valor', 'that item is over half the value')})`
				: `${label('Sin', 'Without')} ${itemName(itemId)} ${label('el valor de objetos queda en', 'the item value comes to')} ${money(rest)} (${rest < 0
					? label('ese objeto vale más que todo el valor de objetos', 'that item is worth more than the whole item value')
					: label('ese objeto es todo el valor de objetos', 'that item is the whole item value')})`);
		}
		// The average is of the same main map and of ITEMS per hour, as the summaries it reads: never mixed with the total's pace.
		if (shownNet !== null && average !== null) afterResult.push(`${label('Tu media en sesiones parecidas (objetos por hora)', 'Your average in similar sessions (items per hour)')}: ${money(average)}/h (${label(`${String(comparables.length)} sesiones en este mapa`, `${String(comparables.length)} sessions on this map`)}${input.comparablesCapped === true ? label(`, entre tus ${String(MAX_SUMMARIES_READ)} resúmenes más recientes`, `, among your ${String(MAX_SUMMARIES_READ)} most recent summaries`) : ''})`);
		if (f.staple !== null) afterResult.push(`${label('Lo que más aumentó', 'Most increased')}: ${itemName(f.staple.itemId)} ×${String(f.staple.quantity)} (${label(`aumentó ${String(f.staple.entries)} veces`, `increased ${String(f.staple.entries)} times`)}${f.staple.perHour !== null ? ` · ${String(f.staple.perHour)}/h` : ''})`);
		if (f.dominantCurrency !== null) afterResult.push(`**${currencyName(f.dominantCurrency.id)}: +${String(f.dominantCurrency.net)}** (${label('lo principal de la sesión', 'the main result of the session')})`);
		// Each block of the section after a blank line: the table, the reason it has no total, and the paragraphs.
		const resultBlocks: string[][] = [...(resultRows.length > 0 ? [[`| ${label('Concepto', 'Figure')} | ${label('Valor', 'Value')} |`, '|---|---:|', ...resultRows]] : []),
			...(missing !== null ? [[missing]] : []), ...afterResult.map((paragraph) => [paragraph])];
		if (resultBlocks.length > 0) out.push('', `## ${label('Resultado', 'Result')}`, ...resultBlocks.flatMap((block) => ['', ...block]));

		if (f.hasNewItems) {
			const top = f.sellable.slice(0, TOP_ITEMS);
			// Not «to sell now»: the note is a record of what changed, and it does not know what is still in the bags when it is read.
			out.push('', `## ${label('Objetos de más valor', 'Most valuable items')}`, '');
			if (top.length === 0 && f.negativeCopper === 0) out.push(label('Ningún objeto nuevo tiene precio de bazar.', 'No new item has a bazaar price.'));
			else {
				// The table adds up to the value above: net increases (the best ones, then the rest), the net decreases that have a price, and the total.
				// With no decrease the increases ARE the total and there is no subtotal; with one, the four lines are what makes the sum readable.
				const restIncreases = f.positiveCopper - top.reduce((sum, row) => sum + row.valueCopper!, 0);
				const decreases = f.negativeCopper < 0;
				out.push(`| ${label('Objeto', 'Item')} | ${label('Cantidad', 'Quantity')} | ${label('Venta inmediata', 'Instant sale')} |`, '|---|---:|---:|',
					...top.map((row) => `| ${itemCell(row.itemId)}${row.container ? ` (${label('sin abrir', 'unopened')})` : ''} | ${String(row.quantity)} | ${money(row.valueCopper!)} |`),
					...(restIncreases !== 0 ? [`| ${label('Resto de aumentos netos', 'Other net increases')} | — | ${money(restIncreases)} |`] : []),
					...(decreases ? [`| **${label('Aumentos netos', 'Net increases')}** | | **${money(f.positiveCopper)}** |`, `| ${label('Disminuciones netas valoradas', 'Priced net decreases')} | — | ${money(f.negativeCopper)} |`] : []),
					...(shownNet !== null ? [`| **${label('Cambio de valor de objetos', 'Item value change')}** | | **${money(shownNet)}** |`] : []));
			}
			if (f.unpriced.length > 0) out.push('', `${label('Sin precio de bazar (fuera del valor)', 'No bazaar price (outside the value)')}: ${f.unpriced.map((row) => `${itemName(row.itemId)} ×${String(row.quantity)}${row.container ? ` (${label('sin abrir', 'unopened')})` : ''}`).join(', ')}`);
			// A handful is named whole; a farming session binds dozens, and then the line is a count with the first three, in the order they came.
			const boundCount = f.boundItemIds.length;
			if (boundCount > MAX_NAMED_BOUND) {
				const named = f.boundItemIds.slice(0, BOUND_NAMED_WHEN_COUNTED).map(itemName).join(', '); const more = String(boundCount - BOUND_NAMED_WHEN_COUNTED);
				out.push('', label(`${String(boundCount)} tipos de objeto ligados a cuenta, fuera de la lista y del valor: ${named} y ${more} más.`,
					`${String(boundCount)} account-bound item types, outside the list and the value: ${named} and ${more} more.`));
			} else if (boundCount > 0) out.push('', `${label('Ligados a cuenta (fuera de la lista y del valor)', 'Account-bound (outside the list and the value)')}: ${f.boundItemIds.map(itemName).join(', ')}`);
		}

		// What decreased, said as a decrease: the plugin sees the final balance, not the cause, so it never says «spent» or «sold».
		const decreasedCurrencies = f.currencies.filter((row) => row.net < 0).sort((a, b) => a.net - b.net);
		if (f.outCount > 0 || decreasedCurrencies.length > 0) {
			out.push('', `## ${label('Objetos y monedas que disminuyeron', 'Items and currencies that decreased')}`);
			// Units and item types, both counted: «5 objetos» read as five items when it was five units of four. One unit is of one item.
			if (f.outCount === 1) out.push('', label('En el inventario bajó 1 unidad de un objeto; no se distingue si se vendió, se consumió o se depositó.',
				'1 unit of one item went down in the inventory; it cannot tell whether it was sold, consumed or deposited.'));
			else if (f.outCount > 0) out.push('', label(`En el inventario bajaron ${String(f.outCount)} unidades de ${String(f.outKinds)} ${f.outKinds === 1 ? 'tipo' : 'tipos'} de objeto; no se distingue si se vendieron, se consumieron o se depositaron.`,
				`${String(f.outCount)} units of ${String(f.outKinds)} item ${f.outKinds === 1 ? 'type' : 'types'} went down in the inventory; it cannot tell whether they were sold, consumed or deposited.`));
			const lost = shownNet === null ? [] : f.decreased.slice(0, MAX_DECREASED_ITEMS);
			if (lost.length > 0) out.push('', `| ${label('Objeto que más disminuyó', 'Item that decreased most')} | ${label('Cantidad', 'Quantity')} | ${label('Venta inmediata', 'Instant sale')} |`, '|---|---:|---:|',
				...lost.map((row) => `| ${itemCell(row.itemId)} | -${String(row.quantity)} | ${money(row.valueCopper)} |`));
			if (decreasedCurrencies.length > 0) out.push('', `${label('Monedas que disminuyeron', 'Currencies that decreased')}: ${decreasedCurrencies.map((row) => `${currencyName(row.id)} ${String(row.net)}`).join(' · ')}`);
		}

		const byMap = f.mapBreakdown;
		if (byMap.rows.length > 0) {
			// The value columns go with the result: a note that states no net value of items states none by map either.
			const valued = shownNet !== null;
			const unidentified = (capital: boolean): string => capital ? label('Sin mapa identificado', 'No identified map') : label('sin mapa identificado', 'no identified map');
			// What was observed on no identified map is a row when there is any (the figures give it time only for a stretch, the same one
			// the route steps on), or when it holds value the rows above would not add up without: units no journal entry accounts for.
			// It is what says the maps above are not the whole session: nothing else is written about a map that may be missing.
			const all = [...byMap.rows, ...(byMap.unidentified.observedMs > 0 || valued && byMap.unidentified.netCopper !== 0 ? [byMap.unidentified] : [])];
			const mapLabel = (row: SummaryMapRow): string => row.mapId === null ? unidentified(true) : mapName(row.mapId);
			out.push('', `## ${label('Mapas', 'Maps')}`, '');
			// One map and nothing outside it: its value and its pace are the result's own, so one line says all the table would.
			if (all.length === 1) out.push(`${mapLabel(all[0]!)} · ${label('tiempo observado', 'observed time')}: ${duration(all[0]!.observedMs)}`);
			else {
				// Maps where no item changed at all are one row when there are two or more; a map whose changes have no price keeps its own row,
				// and a value of zero is no proof of «nothing happened» (what came in and went out nets to zero too).
				const quiet = valued ? all.filter((row) => row.mapId !== null && row.changes === 0) : [];
				const grouped = quiet.length >= 2 ? quiet : [];
				const unpricedRow = (row: SummaryMapRow): boolean => row.changes > 0 && !row.priced;
				// The map that yields most first; the ones with changes and no price after those that have a value, the grouped row last.
				const shown = all.filter((row) => !grouped.includes(row));
				if (valued) shown.sort((a, b) => Number(unpricedRow(a)) - Number(unpricedRow(b)) || (b.netCopper ?? 0) - (a.netCopper ?? 0) || b.observedMs - a.observedMs);
				const groupedNet = grouped.reduce((sum, row) => sum + (row.netCopper ?? 0), 0);
				const parts = shownNet !== null && shownNet > 0 && all.every((row) => (row.netCopper ?? 0) >= 0);
				const paced = shown.some((row) => row.perHourCopper !== null);
				const share = (copper: number): string => `${String(Math.round(copper * 100 / shownNet!))} %`;
				const columns: { heading: string; align: '---' | '---:' }[] = [{ heading: label('Mapa', 'Map'), align: '---' }, { heading: label('Tiempo observado', 'Observed time'), align: '---:' },
					...(valued ? [{ heading: label('Valor de objetos', 'Item value'), align: '---:' as const }] : []),
					...(valued && parts ? [{ heading: label('Parte del valor', 'Share of the value'), align: '---:' as const }] : []),
					...(valued && paced ? [{ heading: label('Por hora observada', 'Per observed hour'), align: '---:' as const }] : [])];
				const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
				const tableRow = (row: SummaryMapRow): string => line([mapLabel(row), duration(row.observedMs),
					...(valued ? [unpricedRow(row) ? label('sin valor de bazar', 'no trading post value') : money(row.netCopper ?? 0)] : []),
					...(valued && parts ? [unpricedRow(row) ? '—' : share(row.netCopper ?? 0)] : []),
					...(valued && paced ? [row.perHourCopper === null ? '—' : money(row.perHourCopper)] : [])]);
				out.push(line(columns.map((column) => column.heading)), `|${columns.map((column) => column.align).join('|')}|`, ...shown.map(tableRow),
					...(grouped.length > 0 ? [line([label(`${String(grouped.length)} mapas sin cambios de objetos`, `${String(grouped.length)} maps with no item changes`),
						duration(grouped.reduce((sum, row) => sum + row.observedMs, 0)), money(groupedNet), ...(parts ? [share(groupedNet)] : []), ...(paced ? ['—'] : [])])] : []));
				// The route: every entry with its local hour, returns to a map included. The stretches below write it too, so it is only here without them.
				if (byMap.rows.length <= 1 && byMap.visits.length > 1) out.push('', byMap.visits.map((visit) => `${clock(visit.at)} ${visit.mapId === null ? unidentified(false) : mapName(visit.mapId)}`).join(' → '));
				// The limit of the split, only where there is a split of value to misread.
				if (valued) out.push('', [label('Solo objetos: el oro de la cartera no se reparte por mapa.', 'Items only: the wallet gold is not split by map.'),
					label('Lo que llega durante la carga de un mapa cuenta en el mapa donde se observó.', 'What arrives while a map loads counts on the map where it was observed.'),
					...(all.some((row) => (row.netCopper ?? 0) < 0) ? [label('Un valor negativo es la disminución neta de objetos en ese mapa.', 'A negative value is the net decrease of items on that map.')] : []),
					...(grouped.length > 0 ? [`${label('Sin cambios de objetos', 'No item changes')}: ${joinNames(grouped.map(mapLabel), label('y', 'and'))}.`] : [])].join(' '));
			}
		}

		// Each stretch on a map with the hours it was entered and left (David, 10 Oct 2026): the table above adds a map's visits together
		// and the route only says when each began. With one identified map there is nothing to tell apart, and nothing is added.
		if (byMap.rows.length > 1) {
			const when = (at: string): string => day(at) === day(session.startedAt) ? clock(at) : `${day(at)} ${clock(at)}`;
			const stretchValue = (stretch: SummaryMapStretch): string => stretch.netCopper !== null ? money(stretch.netCopper)
				: stretch.changes === 0 ? label('sin cambios de objetos', 'no item changes')
					: !stretch.priced && f.hasNewItems ? label('sin precios de bazar', 'no bazaar prices') : '—';
			// The value goes with the result, as in the table of maps: a note that states no net value of items states none by stretch.
			const withValue = f.hasNewItems;
			out.push('', `## ${label('Tramos de mapa', 'Map stretches')}`, '',
				`| ${label('Mapa', 'Map')} | ${label('Entrada', 'Entered')} | ${label('Salida', 'Left')} | ${label('Duración', 'Length')}${withValue ? ` | ${label('Valor de objetos', 'Item value')}` : ''} |`,
				`|---|---:|---:|---:${withValue ? '|---:' : ''}|`,
				...byMap.stretches.map((stretch) => `| ${stretch.mapId === null ? label('Sin mapa identificado', 'No identified map') : mapName(stretch.mapId)} | ${when(stretch.fromAt)} | ${when(stretch.toAt)} | ${duration(stretch.ms)}${withValue ? ` | ${stretchValue(stretch)}` : ''} |`));
		}

		// One line, the biggest first. The ones that decreased are in their own section: a negative balance is not «another currency».
		const increasedCurrencies = f.currencies.filter((row) => row.net > 0).sort((a, b) => b.net - a.net);
		if (increasedCurrencies.length > 0) out.push('', `## ${label('Otras monedas', 'Other currencies')}`, '',
			`${label('Aumentaron', 'Increased')}: ${increasedCurrencies.map((row) => `${currencyName(row.id)} +${String(row.net)}`).join(' · ')}`);

		if (f.alerts.length > 0) out.push('', `## ${label('Lo bueno', 'The good')}`, '',
			...f.alerts.map((alert) => `- ${clock(alert.at)} · ${itemName(alert.itemId)} ×${String(alert.quantity)}${alert.totalCopper === null ? '' : ` · ${money(alert.totalCopper)}`}`));

		// From 90 % observed the header says it all; below it, the section lists what was not observed.
		if (!folded) {
			out.push('', `## ${label('Cobertura', 'Coverage')}`, '');
			// The same truncated percent as the header, so the two never disagree: «no unobserved interval» alone is said only
			// of a session observed in full, and any stretch on record keeps the header at 99 % or less.
			const percent = String(f.observedPercent);
			if (f.gapStretches === 0) {
				out.push(f.observedPercent === 100 ? label('Sin tramos sin observar.', 'No unobserved intervals.')
					: label(`Se observó el ${percent} % de la sesión; ningún tramo sin observar quedó registrado.`, `${percent} % of the session was observed; no unobserved interval was recorded.`));
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
					// The section is about items, so «solo monedas» is the exception worth a word. «Solo objetos» is said only of a session
					// that followed currencies at all: without them every stretch is of items alone, and the label would be on every line.
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
		}

		// The host's own target (Hebra: `id:<uuid>`) when it gave one; otherwise the vault path, which Obsidian resolves.
		const hostTarget = input.fullNoteLinkTarget !== undefined && input.fullNoteLinkTarget !== '' ? input.fullNoteLinkTarget : null;
		const link = hostTarget ?? input.fullNotePath.replace(/\.md$/u, '');
		// The link reads as what it opens. A path a wikilink cannot carry is written as text, and then it needs the label in front.
		const fullSession = label('Sesión completa', 'Full session');
		out.push('', /[[\]|#^]/u.test(link) ? `${fullSession}: \`${link}\`` : `[[${link}|${fullSession}]]`);

		const raw = (id: number, kind: 'item' | 'map'): string => kind === 'map' ? rawMapName(id) : rawItemName(id);
		const mapText = f.mainMapId !== null ? raw(f.mainMapId, 'map') : noMapKnown ? label('Mapa desconocido', 'Unknown map') : label('Varios mapas', 'Several maps');
		const topItem = f.staple !== null ? { id: f.staple.itemId, count: f.staple.quantity } : f.sellable[0] !== undefined ? { id: f.sellable[0].itemId, count: f.sellable[0].quantity } : null;
		const goldText = (copper: number | null): string => copper === null ? 'null' : String(Number((copper / 10_000).toFixed(4)));
		const topMap = f.mapTopId === null ? null : rawMapName(f.mapTopId);
		const centsOfGold = (copper: number | null): string => copper === null ? 'null' : String(Number((copper / 10_000).toFixed(2)));
		const buildLabel = session.declaredBuild?.label ?? null;
		const fm = ['---', 'tyrian_summary_version: 4', `tyrian_summary_of: ${JSON.stringify(session.sessionRef)}`,
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
			// Version 4: the total (gold plus items) and its pace, and what the Base needs to group and show a session by its map.
			`tyrian_summary_total_gold: ${centsOfGold(totalCopper)}`, `tyrian_summary_total_per_hour_gold: ${centsOfGold(totalPerHour)}`,
			`tyrian_summary_map_top: ${topMap === null ? 'null' : JSON.stringify(topMap)}`,
			`tyrian_summary_map_label: ${topMap === null ? 'null' : JSON.stringify(f.mapCount > 1 ? `${topMap} +${String(f.mapCount - 1)}` : topMap)}`,
			`tyrian_summary_map_count: ${String(f.mapCount)}`, `tyrian_summary_out_units: ${String(f.outCount)}`,
			`tyrian_summary_magic_find: ${session.magicFind.source === 'verified' && session.magicFind.value !== null ? String(session.magicFind.value) : 'null'}`,
			`tyrian_summary_build: ${buildLabel === null ? 'null' : JSON.stringify(buildLabel)}`,
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

/**
 * Money as this note writes it: the leading zero units go («98s 4c», «26c»), and a zero in the middle stays («2g 0s 26c», so that
 * 26 is not read as silver). It is local on purpose: `formatCopperVisual` is shared with other notes, whose text must not move.
 */
function summaryMoney(copper: number): string {
	const sign = copper < 0 ? '-' : '';
	const value = Math.abs(copper);
	const gold = Math.floor(value / 10_000); const silver = Math.floor(value / 100) % 100; const bronze = value % 100;
	return `${sign}${gold > 0 ? `${String(gold)}g ${String(silver)}s ${String(bronze)}c` : silver > 0 ? `${String(silver)}s ${String(bronze)}c` : `${String(bronze)}c`}`;
}

/** «A», «A y B», «A, B y C». */
function joinNames(names: readonly string[], and: string): string {
	return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)!}`;
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

/**
 * An item icon as the destination of a Markdown image, or null. The same host rule as `iconText` (https, the GW2 render host
 * right after the scheme, no credentials), and on top of it nothing that would end the destination or the table cell early:
 * no parenthesis, angle or square bracket, bar or backtick. A cached icon that fails it is not written; the name stays.
 */
function inlineIconUrl(icon: string | undefined): string | null {
	return icon !== undefined && /^https:\/\/render\.guildwars2\.com\/[^\s"\\@\p{Cc}()<>[\]|`]*$/u.test(icon) ? icon : null;
}

/**
 * The alternative text of an item icon: the name as the table cell already writes it (`escapeMarkdown`, which turns `|` into
 * `\|` for the cell), with its square brackets escaped too, so a `]` in a name does not close the text before `\|20`.
 */
function imageAlt(cellName: string): string { return cellName.replace(/[[\]]/gu, (match) => `\\${match}`); }

/**
 * A backtick or a `$` escaped (`` \` ``, `\$`: CommonMark escapes of ASCII punctuation, so the text reads the same). Only for the
 * item cell that carries an icon, where the name is written twice on one line; `escapeMarkdown` is shared with the currencies, the
 * maps and the characters, and changing it would rewrite what every other note already says.
 */
function escapeCodeAndMath(value: string): string { return value.replace(/[`$]/gu, (match) => `\\${match}`); }

function escapeMarkdown(value: string): string { return value.replace(/[\p{Cc}]/gu, ' ').replace(/[\\|<>]/gu, (match) => `\\${match}`); }
