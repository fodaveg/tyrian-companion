import type {
	SessionClassificationReason,
	SessionClassificationReasonCode,
	SessionClassificationStatus,
} from '../account/contamination-model';
import { isMap, isScalar, parseDocument, type Scalar } from 'yaml';
import type { SnapshotQuality } from '../account/storage-snapshot-model';
import { createTranslator } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import { buildLootPresentation } from './loot-presentation';
import { renderLootMarkdown } from './loot-presentation-markdown';
import type { SessionActivityKey } from './session-contamination-review';
import {
	SESSION_NOTE_BLOCK_IDS,
	SESSION_NOTE_SCHEMA_VERSION,
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
		const heading = `# ${noteText(note.locale, 'note.heading')}`;
		const notes = `## ${noteText(note.locale, 'note.myNotes')}`;
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

/** Durable H5.4/H5.7 note codec for explicit history operations. */
export async function inspectStoredSessionNote(content: string): Promise<{
	frontmatter: Readonly<Record<string, string | number | null>>;
	managedBlocksValid: boolean;
	hasInvalidScalar: boolean;
} | null> {
	const parsed = parseFrontmatter(content);
	if (parsed === null) return null;
	const strict = parseStrictTcFrontmatter(content);
	return {
		frontmatter: strict?.frontmatter ?? parsed.frontmatter,
		managedBlocksValid: await managedBlockRanges(parsed.body) !== null,
		hasInvalidScalar: parsed.hasInvalidScalar || strict === null,
	};
}

export interface StoredSessionLootSummary {
	readonly locale: 'es' | 'en';
	readonly immediateCopper: number | null;
	readonly rows: readonly {
		readonly name: string;
		readonly netQuantity: number;
		readonly immediateLabel: string;
	}[];
}

/** Reads the producer-owned results block without regenerating or mutating the note. */
export async function inspectStoredSessionLootSummary(content: string): Promise<StoredSessionLootSummary | null> {
	const parsed = parseFrontmatter(content);
	if (parsed === null) return null;
	const ranges = await managedBlockRanges(parsed.body);
	const locale = parsed.frontmatter.tc_locale;
	const immediateCopper = parsed.frontmatter.tc_observed_immediate_copper;
	if (ranges === null || (locale !== 'es' && locale !== 'en') ||
		!(immediateCopper === null || (typeof immediateCopper === 'number' &&
			Number.isSafeInteger(immediateCopper) && immediateCopper >= 0))) return null;
	const results = ranges.find(({ id }) => id === 'results');
	if (results === undefined) return null;
	const lines = parsed.body.split('\n').slice(results.start + 1, results.end);
	const separator = lines.findIndex((line) => /^\|---\|---:\|/u.test(line));
	if (separator < 0) return null;
	const rows: StoredSessionLootSummary['rows'][number][] = [];
	for (const line of lines.slice(separator + 1)) {
		if (!line.startsWith('|')) break;
		const cells = parseMarkdownTableRow(line);
		if (cells === null || cells.length !== 6) return null;
		const netQuantity = Number(cells[1]);
		if (!Number.isSafeInteger(netQuantity)) return null;
		if (cells[0] === '—' && netQuantity === 0) continue;
		rows.push({ name: cells[0]!, netQuantity, immediateLabel: cells[3]! });
	}
	return { locale, immediateCopper, rows };
}

/**
 * Removes only Tyrian Companion's durable metadata and intact managed blocks.
 * The surviving frontmatter lines and all human body lines retain their original
 * byte sequence and ordering.
 */
export async function scrubStoredSessionNote(content: string): Promise<string | null> {
	const parsed = parseFrontmatter(content);
	if (parsed === null) return null;
	const ranges = await managedBlockRanges(parsed.body);
	if (ranges === null) return null;
	const frontmatterEnd = content.indexOf('\n---\n', 4);
	if (frontmatterEnd < 0) return null;
	const retainedFrontmatter = content.slice(4, frontmatterEnd).split('\n')
		.filter((line) => !/^tc_[A-Za-z0-9_-]+:(?:\s|$)/u.test(line));
	const bodyLines = parsed.body.split('\n');
	for (let index = ranges.length - 1; index >= 0; index -= 1) {
		const range = ranges[index]!;
		bodyLines.splice(range.start, range.end - range.start + 1);
	}
	return '---\n' + retainedFrontmatter.join('\n') + '\n---\n' + bodyLines.join('\n');
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
	const recommendationDecision = frontmatterRecommendation(note);
	const reservedQuantity = reservation ? safeSum(reservation.assets.flatMap((asset) =>
		asset.namespace === 'item' ? asset.allocations.map((allocation) => allocation.protectedAvailable) : [])) : null;
	const heldQuantity = hold ? safeSum(hold.items.map((item) => item.heldQuantity)) : null;
	const reservationStatus = reservation
		? reservation.coverage + ':' + reservation.satisfaction
		: note.reservation.status;
	return {
		tc_schema: SESSION_NOTE_SCHEMA_VERSION,
		tc_kind: 'gw2_farming_session',
		tc_event: note.eventDeclaration?.event ?? null,
		tc_event_source: note.eventDeclaration?.source ?? null,
		tc_positive_item_deltas_json: positiveItemDeltasJson(note),
		tc_session_ref: sessionRef,
		tc_account_ref: accountRef,
		tc_locale: note.locale,
		tc_started_at: note.runtime.delta.window!.from,
		// The session ends when the player closed it, not when the final capture managed to read
		// the account. Deriving it from the duration keeps the durable pair arithmetically
		// consistent, which is exactly what the history reader verifies.
		tc_ended_at: new Date(Date.parse(note.runtime.delta.window!.from) + note.durationMs).toISOString(),
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
		tc_reservation_status: reservationStatus,
		tc_reserved_quantity: reservedQuantity,
		tc_hold_status: hold ? aggregateHoldStatus(hold.allocations.map((allocation) => allocation.state)) : note.hold.status,
		tc_held_quantity: heldQuantity,
		tc_recommendation_status: recommendationStatus,
		tc_recommendation_action: recommendationDecision?.action ?? null,
		tc_recommendation_quantity: recommendationDecision?.quantity ?? null,
		tc_recommendation_route: recommendationDecision?.route ?? null,
		tc_execution: 'manual_in_game',
		tc_side_effects: 'none',
		descripcion: noteText(note.locale, 'note.description'),
	};
}

/** Canonical machine-readable H11.2 evidence. It records only positive net changes, never a snapshot. */
function positiveItemDeltasJson(note: PreparedSessionNote): string {
	return JSON.stringify(note.runtime.delta.itemChanges.filter(({ id, delta }) =>
		Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(delta) && delta > 0)
		.map(({ id, delta }) => [id, delta] as const).sort(([left], [right]) => left - right));
}

function frontmatterRecommendation(note: PreparedSessionNote):
	| { action: 'open' | 'sell'; quantity: number; route: 'instant_sell' | 'vendor' | null }
	| null {
	if (note.recommendation.status !== 'valid' || note.recommendation.value.status !== 'ready' ||
		note.envelope.status !== 'valid') return null;
	const recommendation = note.recommendation.value.recommendation;
	const decision = recommendation.economicDecision;
	if (decision === null) return null;
	const envelopeDecision = note.envelope.value.decisions.find((candidate) =>
		candidate.itemId === recommendation.itemId && candidate.action === decision.action &&
		candidate.quantity === decision.quantity &&
		(decision.action === 'open' ? candidate.route === undefined : candidate.route === decision.sellRoute));
	if (!envelopeDecision) return null;
	return {
		action: decision.action,
		quantity: decision.quantity,
		route: decision.action === 'sell' ? decision.sellRoute : null,
	};
}

function createBlocks(note: PreparedSessionNote): Record<SessionNoteBlockId, string> {
	const state = note.runtime.state;
	const classification = note.runtime.review.classification;
	const locale = note.locale;
	const loot = renderLootMarkdown(buildLootPresentation(note));
	return {
		summary: [
			`## ${noteText(locale, 'note.summary')}`,
			`- ${noteText(locale, 'note.character')}: ${text(state.startContext.characterName)}`,
			`- ${noteText(locale, 'note.profession')}: ${text(state.startContext.build.profession)}`,
			`- ${noteText(locale, 'note.duration')}: ${formatDuration(note.durationMs)}`,
			`- ${noteText(locale, 'note.classification')}: ${localizedClassification(classification.status, locale)}`,
		].join('\n'),
		evidence: renderEvidence(note),
		results: loot.results,
		economy: loot.economy,
		decision: loot.decision,
		provenance: renderProvenance(note),
	};
}

function renderEvidence(note: PreparedSessionNote): string {
	const classification = note.runtime.review.classification;
	const activities = Object.entries(note.runtime.review.answers.activities)
		.filter(([, active]) => active)
		.map(([key]) => localizedActivity(key as SessionActivityKey, note.locale));
	const confidence = localizedConfidence(classification.confidence, note.locale);
	const evidenceStatus = classification.status === 'exact' || classification.status === 'contaminated'
		? classification.status : 'estimated';
	return [
		`## ${noteText(note.locale, 'note.evidence')}`,
		noteText(note.locale, `note.evidence.${evidenceStatus}`),
		`- ${noteText(note.locale, 'note.confidence')}: ${confidence}`,
		`- ${noteText(note.locale, 'note.reasons')}: ${classification.reasons.length > 0 ? classification.reasons.map((reason) => reasonText(reason, note.locale)).join(', ') : '—'}`,
		`- ${noteText(note.locale, 'note.declaredActivity')}: ${activities.length > 0 ? activities.join(', ') : noteText(note.locale, 'note.none')}`,
	].join('\n');
}

function renderProvenance(note: PreparedSessionNote): string {
	const delta = note.runtime.delta;
	const baselineQuality = localizedSnapshotQuality(note.runtime.baselineSnapshot.quality, note.locale);
	const finalQuality = localizedSnapshotQuality(note.runtime.finalSnapshot.quality, note.locale);
	const deltaSurface = localizedDeltaSurface(delta.surface, note.locale);
	const currencySurface = localizedCurrencySurface(delta.currencySurface, note.locale);
	const priceSource = note.runtime.priceSnapshot
		? localizedPriceSource(note.runtime.priceSnapshot.source, note.locale)
		: noteText(note.locale, 'note.notEvaluated');
	const priceCapturedAt = note.runtime.priceSnapshot
		? localizedTimestamp(note.runtime.priceSnapshot.capturedAt, note.locale)
		: noteText(note.locale, 'note.notEvaluated');
	const valuationPolicy = note.valuation.status === 'valid'
		? noteText(note.locale, 'note.valuationPolicyVersion', { version: note.valuation.value.version })
		: noteText(note.locale, 'note.notEvaluated');
	const lines = [`## ${noteText(note.locale, 'note.provenance')}`,
		`- ${noteText(note.locale, 'note.baselineQuality')}: ${baselineQuality}`,
		`- ${noteText(note.locale, 'note.finalQuality')}: ${finalQuality}`,
		`- ${noteText(note.locale, 'note.deltaSurface')}: ${deltaSurface}`,
		`- ${noteText(note.locale, 'note.currencySurface')}: ${currencySurface}`,
		`- ${noteText(note.locale, 'note.priceSource')}: ${priceSource}`,
		`- ${noteText(note.locale, 'note.priceCapturedAt')}: ${priceCapturedAt}`,
		`- ${noteText(note.locale, 'note.valuationPolicy')}: ${valuationPolicy}`,
	];
	if (note.recommendation.status === 'valid' && note.recommendation.value.recommendation?.explanation) {
		const explanation = note.recommendation.value.recommendation.explanation;
		lines.push(`- ${noteText(note.locale, 'note.containerModel')}: ${text(explanation.open.modelId)} v${String(explanation.open.modelVersion)}`);
		lines.push(`- ${noteText(note.locale, 'note.modelSampleExclusions')}: ${String(explanation.open.sampleContainers)}/${String(explanation.open.excludedSampleUnits)}`);
		lines.push(`- ${noteText(note.locale, 'note.rareTreatment')}: ${localizedRareTreatment(explanation.open.rareTreatment, note.locale)}`);
		lines.push(`- ${noteText(note.locale, 'note.marginBps')}: ${String(explanation.threshold.marginBps)}`);
	}
	return lines.join('\n');
}

async function replaceManagedBlocks(
	body: string,
	blocks: RenderedSessionNote['blocks'],
): Promise<string | null> {
	const lines = body.split('\n');
	const ranges = await managedBlockRanges(body);
	if (ranges === null) return null;
	for (let index = ranges.length - 1; index >= 0; index -= 1) {
		const range = ranges[index]!;
		lines.splice(range.start, range.end - range.start + 1, blocks[range.id].serialized);
	}
	return lines.join('\n');
}

async function managedBlockRanges(body: string): Promise<Array<{ id: SessionNoteBlockId; start: number; end: number }> | null> {
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
			if (!open || end[1] !== open.id || await sha256Text(lines.slice(open.start + 1, index).join('\n')) !== open.hash) return null;
			ranges.push({ id: open.id, start: open.start, end: index });
			open = null;
		}
	}
	return open || ranges.length !== SESSION_NOTE_BLOCK_IDS.length ||
		ranges.some((range, index) => range.id !== SESSION_NOTE_BLOCK_IDS[index]) ? null : ranges;
}

function parseMarkdownTableRow(line: string): string[] | null {
	if (!line.startsWith('|') || !line.endsWith('|')) return null;
	const cells: string[] = [];
	let cell = '';
	let escaped = false;
	for (const character of line.slice(1, -1)) {
		if (escaped) {
			cell += character;
			escaped = false;
		} else if (character === '\\') escaped = true;
		else if (character === '|') {
			cells.push(decodeStoredMarkdown(cell.trim()));
			cell = '';
		} else cell += character;
	}
	if (escaped) return null;
	cells.push(decodeStoredMarkdown(cell.trim()));
	return cells;
}

function decodeStoredMarkdown(value: string): string {
	return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
}

function parseFrontmatter(content: string): {
	body: string; humanLines: string[]; tags: string[]; sessionRef: string | null;
	frontmatter: Record<string, string | number | null>; hasInvalidScalar: boolean;
} | null {
	if (!content.startsWith('---\n')) return null;
	const end = content.indexOf('\n---\n', 4);
	if (end < 0) return null;
	const source = content.slice(4, end);
	const lines = source.split('\n');
	const humanLines: string[] = [];
	const tags: string[] = [];
	let sessionRef: string | null = null;
	const frontmatter: Record<string, string | number | null> = {};
	let hasInvalidScalar = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
		if (match?.[1]?.startsWith('tc_')) {
			if (Object.prototype.hasOwnProperty.call(frontmatter, match[1])) return null;
			const scalar = frontmatterValue(match[2] ?? '');
			frontmatter[match[1]] = scalar.value;
			hasInvalidScalar ||= scalar.invalid;
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
	return { body: content.slice(end + 5), humanLines, tags, sessionRef, frontmatter, hasInvalidScalar };
}

/**
 * Parses producer-owned scalars with YAML Core and requires the renderer's exact scalar styles.
 *
 * The STYLE is the check, which is why this reads the document tree instead of
 * the values Obsidian's `parseYaml(yaml: string): any` would hand back: a
 * `tc_` string is only accepted as `QUOTE_DOUBLE` and a `tc_` number only as
 * `PLAIN`, and a parser that answers plain JavaScript has already thrown that
 * away by the time it returns. Nothing else in the host API carries it.
 */
function parseStrictTcFrontmatter(content: string): {
	frontmatter: Record<string, string | number | null>;
} | null {
	if (!content.startsWith('---\n')) return null;
	const end = content.indexOf('\n---\n', 4);
	if (end < 0) return null;
	try {
		const document = parseDocument(content.slice(4, end), {
			prettyErrors: false,
			schema: 'core',
			strict: true,
			uniqueKeys: true,
		});
		if (document.errors.length > 0 || !isMap(document.contents)) return null;
		const frontmatter: Record<string, string | number | null> = {};
		for (const pair of document.contents.items) {
			if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.key.value.startsWith('tc_')) continue;
			if (!isScalar(pair.value)) return null;
			const scalar = pair.value as Scalar;
			const value = scalar.value;
			if (typeof value === 'string') {
				if (scalar.type !== 'QUOTE_DOUBLE') return null;
				frontmatter[pair.key.value] = value;
			} else if (typeof value === 'number') {
				if (scalar.type !== 'PLAIN' || !Number.isSafeInteger(value)) return null;
				frontmatter[pair.key.value] = value;
			} else if (value === null && scalar.type === 'PLAIN') {
				frontmatter[pair.key.value] = null;
			} else return null;
		}
		return { frontmatter };
	} catch { return null; }
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

function reasonText(reason: SessionClassificationReason, locale: PreparedSessionNote['locale']): string {
	return localizedReason(reason.code, locale);
}

function noteText(
	locale: PreparedSessionNote['locale'],
	key: RuntimeTranslationKey,
	params?: Record<string, string | number>,
): string {
	return translateRuntime(createTranslator(locale), key, params);
}

function localizedClassification(
	status: SessionClassificationStatus,
	locale: PreparedSessionNote['locale'],
): string {
	const keys: Record<SessionClassificationStatus, RuntimeTranslationKey> = {
		exact: 'enum.classification.exact', estimated: 'enum.classification.estimated',
		contaminated: 'enum.classification.contaminated', invalid: 'enum.classification.invalid',
	};
	return noteText(locale, keys[status]);
}

function localizedConfidence(
	confidence: 'high' | 'medium' | 'low',
	locale: PreparedSessionNote['locale'],
): string {
	const keys: Record<'high' | 'medium' | 'low', RuntimeTranslationKey> = {
		high: 'enum.confidence.high', medium: 'enum.confidence.medium', low: 'enum.confidence.low',
	};
	return noteText(locale, keys[confidence]);
}

function localizedActivity(key: SessionActivityKey, locale: PreparedSessionNote['locale']): string {
	const keys: Record<SessionActivityKey, RuntimeTranslationKey> = {
		open: 'activity.open', salvage: 'activity.salvage', consume: 'activity.consume', craft: 'activity.craft',
		tpBuy: 'activity.tpBuy', tpSell: 'activity.tpSell', vendorBuy: 'activity.vendorBuy', vendorSell: 'activity.vendorSell',
		transfer: 'activity.transfer', other: 'activity.other',
	};
	return noteText(locale, keys[key]);
}

function localizedReason(code: SessionClassificationReasonCode, locale: PreparedSessionNote['locale']): string {
	const keys: Record<SessionClassificationReasonCode, RuntimeTranslationKey> = {
		delta_invalid: 'reason.delta_invalid', boundary_invalid: 'reason.boundary_invalid',
		boundary_delta_mismatch: 'reason.boundary_delta_mismatch', boundary_arithmetic_invalid: 'reason.boundary_arithmetic_invalid',
		delta_arithmetic_invalid: 'reason.delta_arithmetic_invalid', classification_context_invalid: 'reason.classification_context_invalid',
		trading_post_evidence_invalid: 'reason.trading_post_evidence_invalid', delivery_items_changed: 'reason.delivery_items_changed',
		delivery_coins_changed: 'reason.delivery_coins_changed', tp_buy_observed: 'reason.tp_buy_observed',
		tp_sell_observed: 'reason.tp_sell_observed', wallet_decreased: 'reason.wallet_decreased',
		consumable_currency_spent: 'reason.consumable_currency_spent',
		wallet_increased_ambiguous: 'reason.wallet_increased_ambiguous', wallet_increase_clean_confirmation_used: 'reason.wallet_increase_clean_confirmation_used',
		roster_changed: 'reason.roster_changed', character_unobserved: 'reason.character_unobserved',
		activity_declared: 'reason.activity_declared', open_activity_declared: 'reason.open_activity_declared',
		item_losses_observed: 'reason.item_losses_observed',
		clean_declaration_conflicts_with_evidence: 'reason.clean_declaration_conflicts_with_evidence', delta_limited: 'reason.delta_limited',
		boundary_not_manually_confirmed: 'reason.boundary_not_manually_confirmed',
		api_settlement_window_skipped: 'reason.api_settlement_window_skipped',
		api_settlement_window_exceeded: 'reason.api_settlement_window_exceeded',
		declaration_not_clean: 'reason.declaration_not_clean',
		trading_post_not_complete_clean_declaration_used: 'reason.trading_post_not_complete_clean_declaration_used',
	};
	return noteText(locale, keys[code]);
}

function localizedSnapshotQuality(quality: SnapshotQuality, locale: PreparedSessionNote['locale']): string {
	const keys: Record<SnapshotQuality, RuntimeTranslationKey> = {
		stable: 'enum.snapshotQuality.stable', stable_owned_placement_changed: 'enum.snapshotQuality.stable_owned_placement_changed',
		partial: 'enum.snapshotQuality.partial', unstable: 'enum.snapshotQuality.unstable',
	};
	return noteText(locale, keys[quality]);
}

function localizedDeltaSurface(
	surface: PreparedSessionNote['runtime']['delta']['surface'],
	locale: PreparedSessionNote['locale'],
): string {
	if (surface === null) return noteText(locale, 'enum.deltaSurface.unavailable');
	const keys: Record<NonNullable<PreparedSessionNote['runtime']['delta']['surface']>, RuntimeTranslationKey> = {
		core_and_delivery: 'enum.deltaSurface.core_and_delivery', core_only: 'enum.deltaSurface.core_only',
	};
	return noteText(locale, keys[surface]);
}

function localizedCurrencySurface(
	surface: PreparedSessionNote['runtime']['delta']['currencySurface'],
	locale: PreparedSessionNote['locale'],
): string {
	if (surface === null) return noteText(locale, 'enum.currencySurface.unavailable');
	const keys: Record<NonNullable<PreparedSessionNote['runtime']['delta']['currencySurface']>, RuntimeTranslationKey> = {
		wallet_and_delivery: 'enum.currencySurface.wallet_and_delivery', wallet_only: 'enum.currencySurface.wallet_only',
		unavailable: 'enum.currencySurface.unavailable',
	};
	return noteText(locale, keys[surface]);
}

function localizedPriceSource(_source: 'gw2-commerce-prices', locale: PreparedSessionNote['locale']): string {
	return noteText(locale, 'enum.priceSource.gw2Commerce');
}

function localizedRareTreatment(
	treatment: 'excluded' | 'observed_only' | 'bounded',
	locale: PreparedSessionNote['locale'],
): string {
	const keys: Record<'excluded' | 'observed_only' | 'bounded', RuntimeTranslationKey> = {
		excluded: 'enum.rareTreatment.excluded', observed_only: 'enum.rareTreatment.observed_only', bounded: 'enum.rareTreatment.bounded',
	};
	return noteText(locale, keys[treatment]);
}

function localizedTimestamp(value: string, locale: PreparedSessionNote['locale']): string {
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString(locale) : noteText(locale, 'note.notEvaluated');
}

function aggregateHoldStatus(states: string[]): string {
	if (states.some((state) => state === 'holding' || state === 'price_unavailable')) return 'active';
	if (states.some((state) => state === 'expired')) return 'expired';
	return 'released';
}
function formatDuration(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1_000);
	return `${pad(Math.floor(seconds / 3_600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
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
function yaml(value: string | number | null): string { return value === null ? 'null' : typeof value === 'number' ? String(value) : JSON.stringify(value); }
function yamlScalar(value: string): string {
	try { const parsed = JSON.parse(value) as unknown; return typeof parsed === 'string' ? parsed : value; } catch { return value.replace(/^['"]|['"]$/gu, ''); }
}
function frontmatterValue(value: string): { value: string | number | null; invalid: boolean } {
	const trimmed = value.trim();
	if (trimmed === 'null') return { value: null, invalid: false };
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (typeof parsed === 'string') return { value: parsed, invalid: false };
		if (typeof parsed === 'number' && Number.isSafeInteger(parsed)) return { value: parsed, invalid: false };
		return { value: null, invalid: true };
	} catch {
		const number = Number(trimmed);
		if (Number.isSafeInteger(number) && trimmed !== '') return { value: number, invalid: false };
		if (/^(?:true|false|~)$/iu.test(trimmed) || /^[[{]/u.test(trimmed)) return { value: null, invalid: true };
		return { value: yamlScalar(value), invalid: false };
	}
}
function pad(value: number): string { return String(value).padStart(2, '0'); }

export async function sha256Text(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
