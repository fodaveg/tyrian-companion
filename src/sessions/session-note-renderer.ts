import type { SessionClassificationReason } from '../account/contamination-model';
import type { QuantityChange } from '../account/storage-delta-model';
import { isRecommendationEnvelope } from '../economy/recommendation-envelope';
import {
	SESSION_NOTE_BLOCK_IDS,
	SESSION_NOTE_SCHEMA_VERSION,
	canonical,
	type PreparedSessionNote,
	type SessionNoteBlockId,
} from './session-note-model';

const START_PATTERN = /^<!-- tyrian-companion:managed:start:([a-z]+) sha256=([a-f0-9]{64}) -->$/u;
const END_PATTERN = /^<!-- tyrian-companion:managed:end:([a-z]+) -->$/u;

export interface RenderedSessionNote {
	sessionRef: string;
	accountRef: string;
	preferredPath: string;
	collisionPath: string;
	frontmatter: Record<string, string | number | null>;
	blocks: Record<SessionNoteBlockId, { content: string; hash: string; serialized: string }>;
	content: string;
}

export type RenderSessionNoteResult =
	| { status: 'ok'; note: RenderedSessionNote }
	| { status: 'invalid'; reason: 'hash_unavailable' | 'arithmetic_invalid' };

export async function renderSessionNote(note: PreparedSessionNote): Promise<RenderSessionNoteResult> {
	try {
		const state = note.runtime.state;
		const sessionRef = await sha256Text(state.sessionId);
		const accountRef = await sha256Text(note.runtime.finalSnapshot.accountId);
		const started = new Date(state.baseline.completedAt);
		const year = String(started.getUTCFullYear()).padStart(4, '0');
		const date = `${year}-${pad(started.getUTCMonth() + 1)}-${pad(started.getUTCDate())}`;
		const time = `${pad(started.getUTCHours())}${pad(started.getUTCMinutes())}${pad(started.getUTCSeconds())}Z`;
		const base = `${note.outputFolder}/sessions/${year}/${date} ${time} - `;
		const frontmatter = createFrontmatter(note, sessionRef, accountRef);
		const contents = createBlocks(note);
		const blocks = {} as RenderedSessionNote['blocks'];
		for (const id of SESSION_NOTE_BLOCK_IDS) {
			const content = contents[id];
			const hash = await sha256Text(content);
			blocks[id] = {
				content,
				hash,
				serialized: `<!-- tyrian-companion:managed:start:${id} sha256=${hash} -->\n${content}\n<!-- tyrian-companion:managed:end:${id} -->`,
			};
		}
		const heading = note.locale === 'es' ? '# Sesión de farmeo en Guild Wars 2' : '# Guild Wars 2 farming session';
		const notes = note.locale === 'es' ? '## Mis notas' : '## My notes';
		const body = `${heading}\n\n${SESSION_NOTE_BLOCK_IDS.map((id) => blocks[id].serialized).join('\n\n')}\n\n${notes}\n`;
		return {
			status: 'ok',
			note: {
				sessionRef, accountRef,
				preferredPath: `${base}${sessionRef.slice(0, 16)}.md`,
				collisionPath: `${base}${sessionRef}.md`,
				frontmatter, blocks,
				content: `${serializeFrontmatter(frontmatter, [])}${body}`,
			},
		};
	} catch {
		return { status: 'invalid', reason: 'hash_unavailable' };
	}
}

export async function mergeRenderedSessionNote(
	existing: string,
	rendered: RenderedSessionNote,
): Promise<{ status: 'ok'; content: string } | { status: 'conflict' }> {
	const parsed = parseFrontmatter(existing);
	if (!parsed || parsed.sessionRef !== rendered.sessionRef) return { status: 'conflict' };
	const body = await replaceManagedBlocks(parsed.body, rendered.blocks);
	if (body === null) return { status: 'conflict' };
	return { status: 'ok', content: `${serializeFrontmatter(rendered.frontmatter, parsed.humanLines, parsed.tags)}${body}` };
}

export function frontmatterSessionRef(content: string): string | null {
	return parseFrontmatter(content)?.sessionRef ?? null;
}

function createFrontmatter(
	note: PreparedSessionNote,
	sessionRef: string,
	accountRef: string,
): Record<string, string | number | null> {
	const state = note.runtime.state;
	const classification = note.runtime.review.classification;
	const canValue = classification.permissions.valueNet && classification.status !== 'contaminated' && note.valuation.status === 'valid';
	const canRate = canValue && classification.permissions.grossPerHour;
	const valuation = note.valuation.status === 'valid' ? note.valuation.value : null;
	const reservation = note.reservation.status === 'valid' ? note.reservation.value.plan : null;
	const hold = note.hold.status === 'valid' ? note.hold.value : null;
	const recommendationStatus = note.recommendation.status === 'valid'
		? note.recommendation.value.status : note.recommendation.status;
	const reservedQuantity = reservation ? safeSum(reservation.assets.flatMap((asset) =>
		asset.namespace === 'item' ? asset.allocations.map((allocation) => allocation.protectedAvailable) : [])) : null;
	const heldQuantity = hold ? safeSum(hold.items.map((item) => item.heldQuantity)) : null;
	return {
		tc_schema: SESSION_NOTE_SCHEMA_VERSION,
		tc_kind: 'gw2_farming_session',
		tc_session_ref: sessionRef,
		tc_account_ref: accountRef,
		tc_locale: note.locale,
		tc_started_at: state.baseline.completedAt,
		tc_ended_at: state.finalSnapshot.completedAt,
		tc_duration_ms: note.durationMs,
		tc_character: state.startContext.characterName,
		tc_profession: state.startContext.build.profession,
		tc_build: state.startContext.build.name || null,
		tc_magic_find: state.startContext.magicFind.value,
		tc_detection_mode: null,
		tc_classification: classification.status,
		tc_confidence: classification.confidence,
		tc_scope: 'observed_storage_net',
		tc_valuation_coverage: valuation ? valuation.coverage : note.valuation.status,
		tc_price_source: valuation ? valuation.priceSource : null,
		tc_price_captured_at: valuation ? valuation.priceCapturedAt : null,
		tc_observed_immediate_copper: canValue && valuation ? valuation.totals.observedImmediateCopper : null,
		tc_observed_listing_copper: canValue && valuation ? valuation.totals.observedListingCopper : null,
		tc_sacks: canValue && valuation ? valuation.rates.sacks : null,
		tc_sacks_per_hour_milli: canRate && valuation ? valuation.rates.sacksPerHourMilli : null,
		tc_immediate_copper_per_hour: canRate && valuation ? valuation.rates.immediateCopperPerHour : null,
		tc_listing_copper_per_hour: canRate && valuation ? valuation.rates.listingCopperPerHour : null,
		tc_reservation_status: reservation ? `${reservation.coverage}:${reservation.satisfaction}` : note.reservation.status,
		tc_reserved_quantity: reservedQuantity,
		tc_hold_status: hold ? aggregateHoldStatus(hold.allocations.map((allocation) => allocation.state)) : note.hold.status,
		tc_held_quantity: heldQuantity,
		tc_recommendation_status: recommendationStatus,
		tc_execution: 'manual_in_game',
		tc_side_effects: 'none',
		descripcion: note.locale === 'es' ? 'Sesión de farmeo de Guild Wars 2 registrada por Tyrian Companion.' : 'Guild Wars 2 farming session recorded by Tyrian Companion.',
	};
}

function createBlocks(note: PreparedSessionNote): Record<SessionNoteBlockId, string> {
	const state = note.runtime.state;
	const classification = note.runtime.review.classification;
	const locale = note.locale;
	return {
		summary: [
			locale === 'es' ? '## Resumen' : '## Summary',
			`- ${locale === 'es' ? 'Personaje' : 'Character'}: ${text(state.startContext.characterName)}`,
			`- ${locale === 'es' ? 'Profesión' : 'Profession'}: ${text(state.startContext.build.profession)}`,
			`- ${locale === 'es' ? 'Duración' : 'Duration'}: ${formatDuration(note.durationMs)}`,
			`- ${locale === 'es' ? 'Clasificación' : 'Classification'}: ${classification.status}`,
		].join('\n'),
		evidence: renderEvidence(note),
		results: renderResults(note),
		economy: renderEconomy(note),
		decision: renderDecision(note),
		provenance: renderProvenance(note),
	};
}

function renderEvidence(note: PreparedSessionNote): string {
	const classification = note.runtime.review.classification;
	const copy = note.locale === 'es' ? {
		exact: 'Lectura exacta dentro del alcance observado. Describe el cambio neto del almacenamiento cubierto; no promete observar correo, almacén de clan, equipo ni operaciones activas fuera de esa superficie.',
		estimated: 'Lectura estimada. Puedes consultar el neto, pero no usarlo como rendimiento bruto por hora.',
		contaminated: 'Lectura contaminada. Hubo actividad externa declarada u observada; estas cifras son cambios netos, no botín obtenido.',
	} : {
		exact: 'Exact reading within the observed scope. It describes the covered storage net change; it does not claim to observe mail, guild storage, equipment, or active operations outside that surface.',
		estimated: 'Estimated reading. You may inspect the net change, but not use it as gross hourly performance.',
		contaminated: 'Contaminated reading. External activity was declared or observed; these figures are net changes, not loot obtained.',
	};
	const activities = Object.entries(note.runtime.review.answers.activities).filter(([, active]) => active).map(([key]) => text(key));
	const evidenceStatus = classification.status === 'exact' || classification.status === 'contaminated'
		? classification.status : 'estimated';
	return [
		note.locale === 'es' ? '## Evidencia' : '## Evidence',
		copy[evidenceStatus],
		`- ${note.locale === 'es' ? 'Confianza' : 'Confidence'}: ${classification.confidence}`,
		`- ${note.locale === 'es' ? 'Motivos' : 'Reasons'}: ${classification.reasons.length > 0 ? classification.reasons.map(reasonText).join(', ') : '—'}`,
		`- ${note.locale === 'es' ? 'Actividad declarada' : 'Declared activity'}: ${activities.length > 0 ? activities.join(', ') : (note.locale === 'es' ? 'ninguna' : 'none')}`,
	].join('\n');
}

function renderResults(note: PreparedSessionNote): string {
	const contaminated = note.runtime.review.classification.status === 'contaminated';
	const changes = [
		...note.runtime.delta.itemChanges.map((change) => ({ namespace: 'item' as const, change })),
		...note.runtime.delta.currencyChanges.map((change) => ({ namespace: 'currency' as const, change })),
	].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.change.id - b.change.id);
	const rows = (positive: boolean) => changes.filter(({ change }) => positive ? change.delta > 0 : change.delta < 0)
		.map(({ namespace, change }) => resultRow(note, namespace, change, contaminated));
	return [
		note.locale === 'es' ? '## Resultados' : '## Results',
		`### ${contaminated ? (note.locale === 'es' ? 'Cambios netos positivos' : 'Positive net changes') : (note.locale === 'es' ? 'Ganancias' : 'Gains')}`,
		'| Namespace | ID | Name | Quantity |', '|---|---:|---|---:|', ...(rows(true).length ? rows(true) : ['| — | — | — | 0 |']),
		`### ${contaminated ? (note.locale === 'es' ? 'Cambios netos negativos' : 'Negative net changes') : (note.locale === 'es' ? 'Pérdidas' : 'Losses')}`,
		'| Namespace | ID | Name | Quantity |', '|---|---:|---|---:|', ...(rows(false).length ? rows(false) : ['| — | — | — | 0 |']),
	].join('\n');
}

function renderEconomy(note: PreparedSessionNote): string {
	const title = note.locale === 'es' ? '## Economía observada' : '## Observed economy';
	const classification = note.runtime.review.classification;
	if (classification.status === 'contaminated' || !classification.permissions.valueNet) {
		return `${title}\n${note.locale === 'es' ? 'Valoración ocultada por los permisos de la clasificación.' : 'Valuation hidden by classification permissions.'}`;
	}
	if (note.valuation.status !== 'valid') return `${title}\n${statusCopy(note.locale, note.valuation.status)}`;
	const value = note.valuation.value;
	return [title,
		`- ${note.locale === 'es' ? 'Venta inmediata observada' : 'Observed immediate sale'}: ${money(value.totals.observedImmediateCopper)}`,
		`- ${note.locale === 'es' ? 'Listado observado (no inmediato)' : 'Observed listing (not immediate)'}: ${money(value.totals.observedListingCopper)}`,
		`- ${note.locale === 'es' ? 'Moneda neta' : 'Net coin'}: ${money(value.totals.coinNetCopper)}`,
		`- ${note.locale === 'es' ? 'Objetos no líquidos' : 'Non-liquid items'}: ${String(value.totals.nonLiquidQuantity)}`,
		`- ${note.locale === 'es' ? 'Cobertura' : 'Coverage'}: ${value.coverage}${value.coverage === 'partial' ? ' (known subtotal)' : ''}`,
	].join('\n');
}

function renderDecision(note: PreparedSessionNote): string {
	const lines = [note.locale === 'es' ? '## Decisión manual' : '## Manual decision'];
	if (note.reservation.status === 'valid') {
		for (const asset of note.reservation.value.plan.assets) for (const allocation of asset.allocations) {
			lines.push(`- Reserve ${text(asset.key)}: ${String(allocation.protectedAvailable)} (${text(allocation.goalId)}, ${allocation.intendedUse})`);
		}
	} else lines.push(`- Reservations: ${note.reservation.status}`);
	if (note.hold.status === 'valid') {
		for (const allocation of note.hold.value.allocations.filter((entry) => entry.allocatedQuantity > 0)) {
			lines.push(`- Hold item:${String(allocation.itemId)}: ${String(allocation.allocatedQuantity)} (${allocation.state})`);
		}
	} else lines.push(`- Holds: ${note.hold.status}`);
	if (note.recommendation.status !== 'valid') {
		lines.push(`- Recommendation: ${note.recommendation.status}`);
	} else {
		const result = note.recommendation.value;
		lines.push(`- Recommendation: ${result.status}`);
		if (result.status === 'ready' && result.recommendation.economicDecision) {
			const decision = result.recommendation.economicDecision;
			lines.push(`- ${decision.action} ${String(decision.quantity)} item:${String(result.recommendation.itemId)} via ${decision.sellRoute}`);
		} else if (result.status === 'blocked' || result.status === 'invalid') {
			lines.push(`- Reasons: ${result.reasons.map((reason) => text(reason.code)).join(', ') || '—'}`);
		}
	}
	const envelopeSafe = note.envelope.status === 'valid' && isRecommendationEnvelope(note.envelope.value);
	if (!envelopeSafe && note.envelope.status !== 'not_evaluated') lines.push('- Recommendation envelope: blocked');
	lines.push('', 'Tyrian Companion no abre objetos ni compra o vende en el bazar. Esta recomendación solo se ejecuta manualmente dentro de Guild Wars 2.');
	return lines.join('\n');
}

function renderProvenance(note: PreparedSessionNote): string {
	const delta = note.runtime.delta;
	const lines = [note.locale === 'es' ? '## Procedencia' : '## Provenance',
		`- Baseline quality: ${note.runtime.baselineSnapshot.quality}`,
		`- Final quality: ${note.runtime.finalSnapshot.quality}`,
		`- Delta surface: ${String(delta.surface)}`,
		`- Currency surface: ${String(delta.currencySurface)}`,
		`- Price source: ${note.runtime.priceSnapshot?.source ?? 'not_evaluated'}`,
		`- Price captured at: ${note.runtime.priceSnapshot?.capturedAt ?? 'not_evaluated'}`,
		`- Valuation policy: ${note.valuation.status === 'valid' ? `v${String(note.valuation.value.version)}; fee v1` : note.valuation.status}`,
	];
	if (note.recommendation.status === 'valid' && note.recommendation.value.recommendation?.explanation) {
		const explanation = note.recommendation.value.recommendation.explanation;
		lines.push(`- Container model: ${text(explanation.open.modelId)} v${String(explanation.open.modelVersion)}`);
		lines.push(`- Model sample/exclusions: ${String(explanation.open.sampleContainers)}/${String(explanation.open.excludedSampleUnits)}`);
		lines.push(`- Rare treatment: ${explanation.open.rareTreatment}`);
		lines.push(`- Margin bps: ${String(explanation.threshold.marginBps)}`);
	}
	return lines.join('\n');
}

async function replaceManagedBlocks(
	body: string,
	blocks: RenderedSessionNote['blocks'],
): Promise<string | null> {
	const lines = body.split('\n');
	const ranges: Array<{ id: SessionNoteBlockId; start: number; end: number }> = [];
	let open: { id: SessionNoteBlockId; start: number; hash: string } | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const start = START_PATTERN.exec(lines[index]!);
		const end = END_PATTERN.exec(lines[index]!);
		if (start) {
			if (open || !SESSION_NOTE_BLOCK_IDS.includes(start[1] as SessionNoteBlockId)) return null;
			open = { id: start[1] as SessionNoteBlockId, start: index, hash: start[2]! };
		} else if (end) {
			if (!open || end[1] !== open.id) return null;
			const content = lines.slice(open.start + 1, index).join('\n');
			if (await sha256Text(content) !== open.hash) return null;
			ranges.push({ id: open.id, start: open.start, end: index });
			open = null;
		}
	}
	if (open || ranges.length !== SESSION_NOTE_BLOCK_IDS.length ||
		ranges.some((range, index) => range.id !== SESSION_NOTE_BLOCK_IDS[index])) return null;
	for (let index = ranges.length - 1; index >= 0; index -= 1) {
		const range = ranges[index]!;
		lines.splice(range.start, range.end - range.start + 1, blocks[range.id].serialized);
	}
	return lines.join('\n');
}

function parseFrontmatter(content: string): { body: string; humanLines: string[]; tags: string[]; sessionRef: string | null } | null {
	if (!content.startsWith('---\n')) return null;
	const end = content.indexOf('\n---\n', 4);
	if (end < 0) return null;
	const source = content.slice(4, end);
	const lines = source.split('\n');
	const humanLines: string[] = [];
	const tags: string[] = [];
	let sessionRef: string | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
		if (match?.[1]?.startsWith('tc_')) {
			if (match[1] === 'tc_session_ref') {
				if (sessionRef !== null) return null;
				sessionRef = yamlScalar(match[2] ?? '');
			}
			continue;
		}
		if (match?.[1] === 'tags') {
			const raw = match[2]?.trim() ?? '';
			if (raw.startsWith('[') && raw.endsWith(']')) {
				for (const tag of raw.slice(1, -1).split(',').map((entry) => yamlScalar(entry.trim())).filter(Boolean)) tags.push(tag);
				continue;
			}
			while (index + 1 < lines.length && /^\s+-\s+/u.test(lines[index + 1]!)) {
				index += 1;
				tags.push(yamlScalar(lines[index]!.replace(/^\s+-\s+/u, '')));
			}
			continue;
		}
		humanLines.push(line);
	}
	return { body: content.slice(end + 5), humanLines, tags, sessionRef };
}

function serializeFrontmatter(
	values: Record<string, string | number | null>,
	humanLines: string[],
	humanTags: string[] = [],
): string {
	const lines = [...humanLines.filter((line, index, all) => !(line === '' && index === all.length - 1))];
	const humanDescription = humanLines.some((line) => /^descripcion\s*:/u.test(line));
	for (const [key, value] of Object.entries(values)) {
		if (key !== 'descripcion' || !humanDescription) lines.push(`${key}: ${yaml(value)}`);
	}
	const tags = [...new Set([...humanTags, 'gw2/session'])].sort();
	lines.push(`tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`);
	return `---\n${lines.join('\n')}\n---\n`;
}

function resultRow(note: PreparedSessionNote, namespace: 'item' | 'currency', change: QuantityChange, contaminated: boolean): string {
	const fallback = note.locale === 'es' ? `${namespace === 'item' ? 'Objeto' : 'Moneda'} #${String(change.id)}`
		: `${namespace === 'item' ? 'Item' : 'Currency'} #${String(change.id)}`;
	const name = note.displayNames[`${namespace}:${String(change.id)}`] || fallback;
	const quantity = contaminated ? change.delta : Math.abs(change.delta);
	return `| ${namespace} | ${String(change.id)} | ${table(name)} | ${String(quantity)} |`;
}

function reasonText(reason: SessionClassificationReason): string {
	return reason.detail ? `${text(reason.code)} (${text(reason.detail)})` : text(reason.code);
}
function aggregateHoldStatus(states: string[]): string {
	if (states.some((state) => state === 'holding' || state === 'price_unavailable')) return 'active';
	if (states.some((state) => state === 'expired')) return 'expired';
	return 'released';
}
function statusCopy(locale: 'es' | 'en', status: string): string {
	if (status === 'not_evaluated') return locale === 'es' ? 'No evaluado.' : 'Not evaluated.';
	return locale === 'es' ? 'La evidencia económica no es válida.' : 'Economic evidence is invalid.';
}
function formatDuration(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1_000);
	return `${pad(Math.floor(seconds / 3_600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
function money(copper: number): string {
	const sign = copper < 0 ? '-' : '';
	const value = Math.abs(copper);
	return `${sign}${String(Math.floor(value / 10_000))}g ${String(Math.floor(value / 100) % 100)}s ${String(value % 100)}c`;
}
function safeSum(values: number[]): number {
	const result = values.reduce((sum, value) => sum + value, 0);
	if (!Number.isSafeInteger(result)) throw new Error('Unsafe note aggregate.');
	return result;
}
function text(value: string): string {
	return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
		.replace(/([\\`*_{}()#+.!|])/gu, '\\$1').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]')
		.replace(/[\r\n]+/gu, ' ');
}
function table(value: string): string { return text(value).replace(/\|/gu, '\\|'); }
function yaml(value: string | number | null): string { return value === null ? 'null' : typeof value === 'number' ? String(value) : JSON.stringify(value); }
function yamlScalar(value: string): string {
	try { const parsed = JSON.parse(value) as unknown; return typeof parsed === 'string' ? parsed : value; } catch { return value.replace(/^['"]|['"]$/gu, ''); }
}
function pad(value: number): string { return String(value).padStart(2, '0'); }

export async function sha256Text(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalBlockFingerprint(value: unknown): string { return canonical(value); }
