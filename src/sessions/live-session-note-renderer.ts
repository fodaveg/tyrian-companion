import { canonicalJson } from '../core/canonical-sha256';
import { normalizeSessionOutputFolder, type SessionNoteBlockId } from './session-note-model';
import { assembleNote, inspectStoredSessionNote, readStoredSessionBlocks, sha256Text, type RenderedSessionNote } from './session-note-renderer';
import { isStoredLiveSessionPayload, LIVE_SESSION_MAX_PAYLOAD_VERSION, prepareLiveSessionPayload, type LiveSessionNoteInput, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { keys } from './live-session-reducer';

const LIVE_NOTE_KEYS = ['tc_schema','tc_kind','tc_source','tc_session_ref','tc_account_ref','tc_locale','tc_started_at',
	'tc_ended_at','tc_payload_version','tc_payload_sha256'];
export type LiveSessionNoteInspection =
	| { status: 'ok'; session: StoredLiveSessionPayloadV1 }
	/** A live note of a payload format newer than this reader knows (`version`): set aside, neither read nor invalid, and never touched. */
	| { status: 'unsupported'; version: number }
	| { status: 'non_candidate' } | { status: 'invalid' };

/** Six established managed regions, with portable full evidence under the provenance hash. */
export async function renderLiveSessionNote(input: LiveSessionNoteInput): Promise<
	{ status: 'ok'; note: RenderedSessionNote<null>; session: StoredLiveSessionPayloadV1 } | { status: 'invalid'; reason: string }> {
	try {
		const folder = normalizeSessionOutputFolder(input.outputFolder);
		if (folder === null || !['es','en'].includes(input.locale)) return { status: 'invalid', reason: 'invalid_input' };
		const session = await prepareLiveSessionPayload(input);
		if (session === null) return { status: 'invalid', reason: 'invalid_live_evidence' };
		const payload = canonicalJson(session);
		const es = input.locale === 'es';
		const frontmatter = { tc_schema: 7, tc_kind: 'session', tc_source: 'nexus_inventory', tc_session_ref: session.sessionRef,
			tc_account_ref: null, tc_locale: input.locale, tc_started_at: session.startedAt, tc_ended_at: session.endedAt,
			tc_payload_version: session.version, tc_payload_sha256: await sha256Text(payload),
			descripcion: es ? 'Cambios de inventario observados durante la conexión al juego.' : 'Inventory changes observed during the game connection.' };
		const label = (spanish: string, english: string): string => es ? spanish : english;
		const money = (value: number | null): string => value === null ? '—' : `${String(value)} c`;
		const names = input.displayNames ?? {};
		const entity = (kind: 'item' | 'currency', id: number): string => escapeMarkdown(names[`${kind}:${String(id)}`] ?? `${label(kind === 'item' ? 'Objeto' : 'Moneda',kind === 'item' ? 'Item' : 'Currency')} ${String(id)}`);
		const valuation = session.valuation;
		const prices = new Map(valuation.prices.map((price) => [price.itemId,price.unitCopper]));
		const rows = session.journal.flatMap((entry) => entry.observations);
		const contents: Record<SessionNoteBlockId,string> = {
			summary: [
				`## ${label('Resumen','Summary')}`,
				`- ${label('Inicio','Started')}: ${session.startedAt}`,
				`- ${label('Fin','Ended')}: ${session.endedAt}`,
				`- ${label('Ámbito','Scope')}: ${label('bolsas del personaje controlado','controlled character bags')}`,
				`- ${label('Cambios observados','Observed changes')}: ${String(session.observationCount)}`,
				`- ${label('Tiempo con objetos observados','Observed item time')}: ${String(session.observedItemsMs / 1000)} s`,
				`- ${label('Tiempo con monedas cubiertas','Covered currency time')}: ${String(session.observedCurrenciesMs / 1000)} s`,
				`- MF: ${session.magicFind.value === null ? label('desconocido','unknown') : `${String(session.magicFind.value)} (${session.magicFind.source === 'manual' ? label('declarado','manual') : label('verificado','verified')})`}`,
			].join('\n'),
			evidence: [
				`## ${label('Cobertura y límites','Coverage and limits')}`,
				label('Los cambios entre muestras pueden quedar sin observar. Su causa es desconocida; no prueban adquisición, venta, apertura ni depósito.',
					'Changes between samples may go unobserved. Their cause is unknown; they do not establish acquisition, sale, opening or deposit.'),
				`- ${label('Última cobertura de objetos','Last item coverage')}: ${label(session.coverage.items === 'complete' ? 'cobertura completa' : session.coverage.items === 'partial' ? 'cobertura parcial' : 'sin cobertura',session.coverage.items === 'complete' ? 'complete coverage' : session.coverage.items === 'partial' ? 'partial coverage' : 'no coverage')}`,
				`- ${label('Última cobertura de monedas','Last currency coverage')}: ${session.coverage.currencies === 'none' ? label('sin cobertura','no coverage') : session.coverage.currencyIds.join(', ')}`,
				`- ${label('Últimos huecos libres observados','Last observed free slots')}: ${String(session.coverage.freeSlots ?? '—')}`,
				...session.gaps.map((gap) => `- ${label('Tramo sin observación','Unobserved interval')}: ${gap.fromAt} → ${gap.toAt!} · ${gap.channels[0] === 'items' ? label('objetos','items') : label('monedas','currencies')} · ${gapReason(gap.reason,es)}`),
			].join('\n'),
			results: [
				`## ${label('Cronología observada','Observed timeline')}`,
				`| ${label('Hora observada','Observed time')} | ${label('Elemento','Entity')} | ${label('Antes','Before')} | ${label('Después','After')} | ${label('Cambio','Change')} | ${label('Valor estimado','Estimated value')} |`,
				'|---|---|---:|---:|---:|---:|',
				...rows.map((row) => {
					const unit = row.kind === 'item' ? prices.get(row.idNumber) : null;
					const value = unit !== undefined && unit !== null && Number.isSafeInteger(unit * row.delta) ? unit * row.delta : null;
					return `| ${row.observedAt} | ${entity(row.kind,row.idNumber)} | ${String(row.before)} | ${String(row.after)} | ${String(row.delta)} | ${money(value)} |`;
				}),
				...(rows.length === 0 ? [label('No se observaron cambios de cantidad.','No quantity changes were observed.')] : []),
				`### ${label('Suma de cambios','Change totals')}`,
				`| ${label('Elemento','Entity')} | + | − | ${label('Neto','Net')} |`, '|---|---:|---:|---:|',
				...session.totals.map((total) => `| ${entity(total.kind,total.idNumber)} | ${String(total.positive)} | ${String(total.negative)} | ${String(total.net)} |`),
			].join('\n'),
			economy: [
				`## ${label('Valoración','Valuation')}`,
				`- ${label('Incrementos de objetos con precio conocido','Item increases with known prices')}: ${money(valuation.positiveItemValueKnownCopper)}`,
				`- ${label('Subtotal neto conocido de objetos','Known net item subtotal')}: ${money(valuation.netItemValueKnownCopper)}`,
				`- ${label('Cambio neto de oro observado','Observed net coin change')}: ${money(valuation.coinNetCopper)}`,
				`- ${label('Valor neto estimado completo','Complete estimated net value')}: ${money(valuation.knownNetValueCopper)}`,
				`- ${label('Objetos sin precio','Unpriced items')}: ${valuation.unpricedItemIds.map((id) => entity('item',id)).join(', ') || '—'}`,
				label('El valor de objetos refleja venta inmediata neta estimada; no equivale a beneficio ni riqueza de cuenta.',
					'Item value reflects estimated net instant selling; it is not profit or account wealth.'),
			].join('\n'),
			decision: [`## ${label('Contexto manual','Manual context')}`,
				...(session.declaredBuild === undefined ? [] : session.declaredBuild === null
					? [`- ${label('Build declarada','Declared build')}: ${label('desconocida','unknown')}`]
					: [`- ${label('Build declarada manualmente','Manually declared build')}: ${escapeMarkdown(session.declaredBuild.label ?? label('sin nombre','unnamed'))}`,
						`- ${label('Plantilla declarada','Declared template')}: \`${session.declaredBuild.templateCode}\``,
						label('Esta plantilla es una declaración manual; no verifica la build activa ni el equipo.',
							'This template is a manual declaration; it does not verify the active build or equipment.')]),
				`- ${label('Grupo','Group')}: ${session.groupContext === null ? label('desconocido','unknown') : session.groupContext === 'with_bosses' ? label('con jefes (declarado)','with bosses (declared)') : label('sin jefes (declarado)','without bosses (declared)')}`,
				label('Ninguna acción en el juego se ejecuta desde esta nota.','This note executes no action in the game.')].join('\n'),
			provenance: [
				`## ${label('Procedencia','Provenance')}`,
				`- ${label('Fuente','Source')}: Nexus · ${label('observación de inventario','inventory observation')}`,
				`- ${label('Precios capturados','Price snapshot')}: ${valuation.capturedAt ?? '—'} · ${label('venta inmediata neta','net instant selling')}`,
				label('El siguiente registro conserva la sesión completa para recuperarla y exportarla en otra instalación.',
					'The following record preserves the complete session for recovery and export on another installation.'),
				'```json',payload,'```',
			].join('\n'),
		};
		return { status: 'ok', session, note: await assembleNote(session.sessionRef,null,session.startedAt,folder,input.locale,frontmatter,contents,
			{ heading: label('Sesión de inventario observado','Observed inventory session'), notes: label('Mis notas','My notes') }) };
	} catch { return { status: 'invalid', reason: 'live_note_unavailable' }; }
}

/** Old regex `^```json\n([^\n]+)\n```$` (flags gmu) as a LINEAR scan: measured, the regex throws RangeError ("Maximum call stack size exceeded") on a two-byte string once the line passes 2^23 characters. */
export function provenanceJsonLines(text: string): string[] {
	const out: string[] = [], isBreak = (c: string | undefined): boolean => c === undefined || c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
	let from = 0;
	for (;;) {
		const at = text.indexOf('```json\n', from);
		if (at < 0) return out;
		const start = at + 8, end = text.indexOf('\n', start);
		if (at > 0 && !isBreak(text[at - 1]) || end <= start || !text.startsWith('```', end + 1) || !isBreak(text[end + 4])) { from = at + 1; continue; }
		out.push(text.slice(start, end)); from = end + 4;
	}
}

/** A valid live note is a distinct history source, never an API net-delta compatibility record. */
export async function inspectLiveSessionNote(content: string): Promise<LiveSessionNoteInspection> {
	const frontmatter = content.startsWith('---\n') ? content.slice(4,content.indexOf('\n---\n',4)) : '';
	if (!/^(?:tc_schema:.*7|tc_kind:.*session|tc_source:.*nexus_inventory)/mu.test(frontmatter)
		|| /^tc_kind: "gw2_farming_session"$/mu.test(frontmatter) && !/^tc_schema: 7$/mu.test(frontmatter)
			&& !/^tc_source:/mu.test(frontmatter)) return { status: 'non_candidate' };
	const note = await inspectStoredSessionNote(content);
	if (note === null) return { status: 'invalid' };
	if (note.frontmatter.tc_kind !== 'session' && note.frontmatter.tc_schema !== 7
		&& note.frontmatter.tc_source !== 'nexus_inventory') return { status: 'non_candidate' };
	const fm = note.frontmatter;
	// Decided before anything else about the note is checked: a later format may well change the keys and the blocks too.
	if (fm.tc_schema === 7 && fm.tc_kind === 'session' && fm.tc_source === 'nexus_inventory' && typeof fm.tc_payload_version === 'number'
		&& Number.isSafeInteger(fm.tc_payload_version) && fm.tc_payload_version > LIVE_SESSION_MAX_PAYLOAD_VERSION) {
		return { status: 'unsupported', version: fm.tc_payload_version };
	}
	if (note.hasInvalidScalar || !note.managedBlocksValid || !keys(note.frontmatter,LIVE_NOTE_KEYS)) return { status: 'invalid' };
	if (fm.tc_schema !== 7 || fm.tc_kind !== 'session' || fm.tc_source !== 'nexus_inventory' || fm.tc_account_ref !== null
		|| fm.tc_payload_version !== 1 && fm.tc_payload_version !== 2 || !['es','en'].includes(fm.tc_locale as string)) return { status: 'invalid' };
	const blocks = await readStoredSessionBlocks(content);
	const payloads = blocks === null ? [] : provenanceJsonLines(blocks.provenance);
	if (payloads.length !== 1) return { status: 'invalid' };
	try {
		const serialized = payloads[0]!;
		const session: unknown = JSON.parse(serialized);
		if (!isStoredLiveSessionPayload(session) || canonicalJson(session) !== serialized
			|| session.version !== fm.tc_payload_version || await sha256Text(serialized) !== fm.tc_payload_sha256 || session.sessionRef !== fm.tc_session_ref
			|| session.startedAt !== fm.tc_started_at || session.endedAt !== fm.tc_ended_at) return { status: 'invalid' };
		return { status: 'ok', session };
	} catch { return { status: 'invalid' }; }
}
function escapeMarkdown(value: string): string { return value.replace(/[\p{Cc}]/gu,' ').replace(/[\\|<>]/gu,(match) => `\\${match}`); }
function gapReason(reason: StoredLiveSessionPayloadV1['gaps'][number]['reason'], es: boolean): string {
	const labels = { disconnect: ['desconexión','disconnect'], source_stale: ['fuente sin muestras recientes','source stale'],
		read_failed: ['lectura no disponible','read unavailable'], partial_inventory: ['inventario parcial','partial inventory'],
		context_changed: ['cambio de contexto','context changed'], host_restart: ['reinicio','restart'],
		storage_unavailable: ['almacenamiento no disponible','storage unavailable'], unsupported_build: ['versión no compatible','unsupported version'],
		source_missing: ['fuente ausente','source missing'], cursor_gap: ['continuidad perdida','continuity lost'] };
	return labels[reason][es ? 0 : 1]!;
}
