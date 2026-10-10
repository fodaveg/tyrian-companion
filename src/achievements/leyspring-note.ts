import { parseDocument, stringify as stringifyYaml } from 'yaml';

import { sha256Text } from '../assets/managed-asset-hash';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import { errorClassName } from '../core/local-debug-error-details';
import { ensureFoldersFromPrefixes } from '../core/vault-folders';
import { normalizeVaultRelativePath } from '../core/vault-path';
import type { LeyspringCapture } from './leyspring-capture';
import { LEYSPRING_MASTERY_ACHIEVEMENT_ID, LEYSPRING_TRACKED_ACHIEVEMENTS } from './leyspring-set';

export const ACHIEVEMENTS_NOTE_SCHEMA_VERSION = 1 as const;
export const ACHIEVEMENTS_NOTE_KIND = 'gw2_achievements' as const;
export const ACHIEVEMENTS_NOTE_MARKER = 'tyrian_companion_achievements' as const;
const LEYSPRING_SET = 'leyspring_hollows' as const;

/** Subfolder of the output folder; the note itself keeps one name in every language. */
export const ACHIEVEMENTS_FOLDER = 'Achievements';
export const LEYSPRING_NOTE_FILE = 'Leyspring Hollows.md';

const MARKER_PREFIX = '<!-- tyrian-companion-achievements';
const MARKER_PATTERN = /<!-- tyrian-companion-achievements schema=(\d+) marker=([^\s]+) set=([^\s]+) hash=([a-f0-9]{64}) -->/u;
/** Closes the managed block. Everything after this line is the user's text. */
const END_MARKER = '<!-- /tyrian-companion-achievements -->';
/** The managed frontmatter keys: the plugin owns their values; any other key is the user's. */
const MANAGED_KEY_LINE = /^(?:tc_schema|tc_kind|tc_marker|tc_set|tc_account|tc_account_ref|tc_captured_at|tc_done|tc_total|tc_mastery_current|tc_mastery_max):/u;

/** Minimal vault port: the note is the only file this feature reads or writes. */
export interface AchievementsVaultFile { path: string }
export interface AchievementsVaultPort {
	file(path: string): AchievementsVaultFile | null;
	read(file: AchievementsVaultFile): Promise<string>;
	createFolder(path: string): Promise<unknown>;
	create(path: string, content: string): Promise<AchievementsVaultFile>;
	process(file: AchievementsVaultFile, update: (content: string) => string): Promise<string>;
}

export interface LeyspringAchievementLine {
	id: number;
	name: string;
	url: string;
	done: boolean;
	/** `current/max` of a half-done achievement; null when it is done, untouched or the API gave no figures. */
	progress: { current: number; max: number } | null;
}

export interface LeyspringSummary {
	/** Tracked achievements the API says are done, and the size of the tracked set. */
	done: number;
	total: number;
	masteryName: string;
	/** The game's own progress of the mastery achievement; null current is "no data", never 0. */
	masteryCurrent: number | null;
	masteryMax: number | null;
}

export interface LeyspringView {
	pending: LeyspringAchievementLine[];
	done: LeyspringAchievementLine[];
	summary: LeyspringSummary;
}

/** Everything the note says, derived from one reading. Pending and done keep the checklist's order. */
export function buildLeyspringView(capture: LeyspringCapture): LeyspringView {
	const lines = LEYSPRING_TRACKED_ACHIEVEMENTS.map((tracked): LeyspringAchievementLine => {
		const entry = capture.progress.get(tracked.id);
		const done = entry?.done === true;
		const max = entry?.max ?? capture.thresholds.get(tracked.id) ?? null;
		const current = entry?.current ?? null;
		return {
			id: tracked.id,
			name: capture.names.get(tracked.id) ?? '',
			url: tracked.url,
			done,
			progress: !done && current !== null && current > 0 && max !== null && max > 0 ? { current, max } : null,
		};
	});
	const mastery = capture.progress.get(LEYSPRING_MASTERY_ACHIEVEMENT_ID);
	const masteryMax = capture.thresholds.get(LEYSPRING_MASTERY_ACHIEVEMENT_ID) ?? mastery?.max ?? null;
	return {
		pending: lines.filter((line) => !line.done),
		done: lines.filter((line) => line.done),
		summary: {
			done: lines.filter((line) => line.done).length,
			total: lines.length,
			masteryName: capture.names.get(LEYSPRING_MASTERY_ACHIEVEMENT_ID) ?? '',
			masteryCurrent: mastery === undefined ? null : mastery.current ?? (mastery.done ? masteryMax : null),
			masteryMax,
		},
	};
}

const NOTE_TEXT = {
	es: {
		title: 'Leyspring Hollows: logros del mapa',
		managed: 'Bloque gestionado por Tyrian Companion: cada actualización lo reescribe. Lo que escribas fuera de él se conserva.',
		account: 'Cuenta', lastRead: 'Última lectura', list: 'Logros de la lista', of: 'de',
		mastery: 'Maestría', noData: 'sin dato', pending: 'Pendientes', done: 'Hechos', none: 'Ninguno.',
		achievement: 'Logro', masteryFallback: 'Leyspring Hollows Mastery',
	},
	en: {
		title: 'Leyspring Hollows: map achievements',
		managed: 'Block managed by Tyrian Companion: every update rewrites it. Anything you write outside it is kept.',
		account: 'Account', lastRead: 'Last read', list: 'Achievements on the list', of: 'of',
		mastery: 'Mastery', noData: 'no data', pending: 'Pending', done: 'Done', none: 'None.',
		achievement: 'Achievement', masteryFallback: 'Leyspring Hollows Mastery',
	},
} as const satisfies Record<CatalogLocale, Record<string, string>>;

interface AchievementsNoteFields {
	tc_schema: typeof ACHIEVEMENTS_NOTE_SCHEMA_VERSION;
	tc_kind: typeof ACHIEVEMENTS_NOTE_KIND;
	tc_marker: typeof ACHIEVEMENTS_NOTE_MARKER;
	tc_set: typeof LEYSPRING_SET;
	tc_account: string;
	tc_account_ref: string;
	tc_captured_at: string;
	tc_done: number;
	tc_total: number;
	tc_mastery_current: number | null;
	tc_mastery_max: number | null;
}

/** The parts of a note that belong to the user; empty for a note the plugin creates. */
interface UserParts {
	/** The user's own frontmatter lines, verbatim, or null when there are none. */
	frontmatter: string | null;
	/** Text before the marker line and after the closing marker. */
	prefix: string;
	suffix: string;
}
const NO_USER_PARTS: UserParts = { frontmatter: null, prefix: '', suffix: '' };

/** Renders the managed block (heading, counts and checklist) from the reading alone. */
export function renderLeyspringBlock(capture: LeyspringCapture, view: LeyspringView = buildLeyspringView(capture)): string {
	const text = NOTE_TEXT[capture.locale];
	const { summary } = view;
	const masteryName = linkText(summary.masteryName) || text.masteryFallback;
	const masteryValue = summary.masteryCurrent === null ? text.noData
		: summary.masteryMax === null ? String(summary.masteryCurrent) : `${String(summary.masteryCurrent)}/${String(summary.masteryMax)}`;
	const line = (entry: LeyspringAchievementLine): string => {
		const name = linkText(entry.name) || `${text.achievement} ${String(entry.id)}`;
		const progress = entry.progress === null ? '' : ` · ${String(entry.progress.current)}/${String(entry.progress.max)}`;
		return `- [${entry.done ? 'x' : ' '}] [${name}](${entry.url})${progress}`;
	};
	const section = (heading: string, entries: readonly LeyspringAchievementLine[]): string[] => [
		`## ${heading} (${String(entries.length)})`, '',
		...(entries.length === 0 ? [text.none] : entries.map(line)), '',
	];
	return [
		`# ${text.title}`, '',
		text.managed, '',
		`- ${text.account}: ${cleanLine(capture.accountName)}`,
		`- ${text.lastRead}: ${formatReadAt(capture.capturedAt)}`,
		`- ${text.list}: ${String(summary.done)} ${text.of} ${String(summary.total)}`,
		`- ${text.mastery} (${masteryName}): ${masteryValue}`, '',
		...section(text.pending, view.pending),
		...section(text.done, view.done),
	].join('\n');
}

function fieldsFor(capture: LeyspringCapture, summary: LeyspringSummary): AchievementsNoteFields {
	return {
		tc_schema: ACHIEVEMENTS_NOTE_SCHEMA_VERSION,
		tc_kind: ACHIEVEMENTS_NOTE_KIND,
		tc_marker: ACHIEVEMENTS_NOTE_MARKER,
		tc_set: LEYSPRING_SET,
		tc_account: cleanLine(capture.accountName),
		tc_account_ref: capture.accountRef,
		tc_captured_at: capture.capturedAt,
		tc_done: summary.done,
		tc_total: summary.total,
		tc_mastery_current: summary.masteryCurrent,
		tc_mastery_max: summary.masteryMax,
	};
}

/**
 * The whole note: managed frontmatter first, then the user's own frontmatter lines, then the user's
 * text before the marker line, the marker line (its hash covers the managed block only, boxes aside), the block,
 * the closing marker and the user's text after it. The user's parts come back byte for byte.
 */
async function renderLeyspringNote(
	capture: LeyspringCapture,
	view: LeyspringView,
	user: UserParts,
): Promise<string> {
	const block = `${renderLeyspringBlock(capture, view)}\n`;
	const managed = stringifyYaml(fieldsFor(capture, view.summary), { lineWidth: 0 }).trimEnd();
	const frontmatter = user.frontmatter === null ? managed : `${managed}\n${user.frontmatter}`;
	const marker = `${MARKER_PREFIX} schema=${String(ACHIEVEMENTS_NOTE_SCHEMA_VERSION)} marker=${ACHIEVEMENTS_NOTE_MARKER} set=${LEYSPRING_SET} hash=${await blockHash(block)} -->`;
	return `---\n${frontmatter}\n---\n${user.prefix}${marker}\n${block}${END_MARKER}\n${user.suffix}`;
}

type NoteClassification =
	| { status: 'foreign' }
	/** Carries the marker but cannot be rewritten without losing what is in it. */
	| { status: 'edited' }
	| { status: 'owned'; accountRef: string; user: UserParts };

/**
 * Recognises the plugin's own note and splits it. An edit inside the managed block (its hash no
 * longer matches), a missing closing marker or frontmatter that does not parse make it `edited`:
 * rewriting would delete what the user typed. Text outside the block and the user's frontmatter
 * keys never block anything.
 */
async function classifyLeyspringNote(content: string): Promise<NoteClassification> {
	const marker = content.match(MARKER_PATTERN);
	if (!marker) return content.includes(MARKER_PREFIX) ? { status: 'edited' } : { status: 'foreign' };
	if (marker[1] !== String(ACHIEVEMENTS_NOTE_SCHEMA_VERSION) || marker[2] !== ACHIEVEMENTS_NOTE_MARKER || marker[3] !== LEYSPRING_SET) {
		return { status: 'edited' };
	}
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!frontmatter) return { status: 'edited' };
	const rest = content.slice(frontmatter[0].length);
	const markerAt = rest.indexOf(marker[0]);
	if (markerAt < 0 || (markerAt > 0 && rest[markerAt - 1] !== '\n') || rest[markerAt + marker[0].length] !== '\n') {
		return { status: 'edited' };
	}
	const afterMarker = rest.slice(markerAt + marker[0].length + 1);
	const endAt = endMarkerAt(afterMarker);
	if (endAt < 0) return { status: 'edited' };
	const block = afterMarker.slice(0, endAt);
	if (await blockHash(block) !== marker[4]) return { status: 'edited' };
	const split = splitFrontmatter(frontmatter[1]!);
	if (split === null) return { status: 'edited' };
	return {
		status: 'owned',
		accountRef: split.accountRef,
		user: {
			frontmatter: split.user,
			prefix: rest.slice(0, markerAt),
			suffix: afterMarker.slice(endAt + END_MARKER.length).replace(/^\n/u, ''),
		},
	};
}

/**
 * Separates the managed lines from the user's, which stay verbatim. Null when the managed values
 * do not name this note, when the frontmatter is not valid YAML, or when what is left would not be
 * a mapping free of managed keys (a managed value the user spread over several lines).
 */
function splitFrontmatter(text: string): { accountRef: string; user: string | null } | null {
	const whole = parseDocument(text);
	if (whole.errors.length > 0) return null;
	const values: unknown = whole.toJS();
	if (!isRecord(values) || values.tc_schema !== ACHIEVEMENTS_NOTE_SCHEMA_VERSION || values.tc_kind !== ACHIEVEMENTS_NOTE_KIND
		|| values.tc_marker !== ACHIEVEMENTS_NOTE_MARKER || typeof values.tc_account_ref !== 'string' || values.tc_account_ref.length === 0) return null;
	const userText = text.split('\n').filter((line) => !MANAGED_KEY_LINE.test(line)).join('\n');
	if (userText.trim().length === 0) return { accountRef: values.tc_account_ref, user: null };
	const rest = parseDocument(userText);
	if (rest.errors.length > 0) return null;
	const remaining: unknown = rest.toJS();
	if (remaining !== null && (!isRecord(remaining) || Object.keys(remaining).some((key) => MANAGED_KEY_LINE.test(`${key}:`)))) return null;
	return { accountRef: values.tc_account_ref, user: userText };
}

/**
 * The marker's hash covers the block with every checkbox read as unticked: the boxes mirror the
 * API and are rewritten on each pass, so one ticked by hand is not an edit to protect.
 */
async function blockHash(block: string): Promise<string> {
	return await sha256Text(block.replace(/^- \[[ xX]\] /gmu, '- [ ] '));
}

/** Where `END_MARKER` starts as a whole line of `text`, or -1. */
function endMarkerAt(text: string): number {
	let from = 0;
	for (;;) {
		const at = text.indexOf(END_MARKER, from);
		if (at < 0) return -1;
		const next = text[at + END_MARKER.length];
		if ((at === 0 || text[at - 1] === '\n') && (next === undefined || next === '\n')) return at;
		from = at + 1;
	}
}

export type LeyspringNoteConflictReason =
	/** The user typed inside the managed block (or the note is damaged): nothing is written. */
	| 'edited_block'
	/** A note without the plugin's marker already sits at the path. */
	| 'foreign_note'
	/** The note was written for another account: it is not updated. */
	| 'other_account'
	/** The note changed between the read and the write. */
	| 'changed_during_write';

export type LeyspringNoteResult =
	| { status: 'created' | 'updated' | 'unchanged'; summary: LeyspringSummary; path: string }
	| { status: 'conflict'; reason: LeyspringNoteConflictReason; path: string }
	| { status: 'invalid_root' }
	| { status: 'storage_failure'; errorName: string };

/**
 * Writes the one achievements note below the output folder. The managed block and managed
 * frontmatter values follow the reading; the user's text outside the block and their own
 * frontmatter keys are carried through unchanged. The checkboxes are rewritten from the API on
 * every pass, so a box ticked by hand goes back to its real state.
 */
export class LeyspringNoteWriter {
	constructor(
		private readonly vault: AchievementsVaultPort,
		private readonly configDir: string,
	) {}

	async write(root: string, capture: LeyspringCapture): Promise<LeyspringNoteResult> {
		const normalizedRoot = normalizeVaultRelativePath(root, { forbiddenPathPrefixes: [this.configDir], maxPathLength: 128 });
		if (normalizedRoot === null) return { status: 'invalid_root' };
		const folder = `${normalizedRoot}/${ACHIEVEMENTS_FOLDER}`;
		const path = `${folder}/${LEYSPRING_NOTE_FILE}`;
		const view = buildLeyspringView(capture);
		const conflict = (reason: LeyspringNoteConflictReason): LeyspringNoteResult => ({ status: 'conflict', reason, path });
		try {
			const existing = this.vault.file(path);
			if (existing === null) {
				const after = await renderLeyspringNote(capture, view, NO_USER_PARTS);
				await ensureFoldersFromPrefixes(this.vault, folder, 'achievements_folder_unavailable');
				try { await this.vault.create(path, after); }
				catch (error) {
					const raced = this.vault.file(path);
					if (raced === null) throw error;
					return normalizeLf(await this.vault.read(raced)) === after
						? { status: 'created', summary: view.summary, path } : conflict('changed_during_write');
				}
				return { status: 'created', summary: view.summary, path };
			}
			const raw = await this.vault.read(existing);
			const crlf = raw.includes('\r\n');
			const before = normalizeLf(raw);
			const classified = await classifyLeyspringNote(before);
			if (classified.status === 'foreign') return conflict('foreign_note');
			if (classified.status === 'edited') return conflict('edited_block');
			if (classified.accountRef !== capture.accountRef) return conflict('other_account');
			const after = await renderLeyspringNote(capture, view, classified.user);
			if (after === before) return { status: 'unchanged', summary: view.summary, path };
			let applied = false;
			await this.vault.process(existing, (current) => {
				applied = normalizeLf(current) === before;
				return applied ? (crlf ? after.replace(/\n/gu, '\r\n') : after) : current;
			});
			const verified = this.vault.file(path);
			if (!applied || verified === null || normalizeLf(await this.vault.read(verified)) !== after) {
				return conflict('changed_during_write');
			}
			return { status: 'updated', summary: view.summary, path };
		} catch (error) {
			return { status: 'storage_failure', errorName: errorClassName(error) };
		}
	}
}

/** A name as one safe line of Markdown link text: no line breaks, brackets or backslashes unescaped. */
function linkText(value: string): string {
	return cleanLine(value).replace(/[\\[\]]/gu, '\\$&');
}

function cleanLine(value: string): string {
	return value.replace(/[\p{Cc}\p{Cs}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** `2026-10-10T08:40:12.000Z` as `2026-10-10 08:40 UTC`. */
function formatReadAt(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, '\n'); }
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
