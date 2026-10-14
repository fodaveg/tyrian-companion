import { copyFileSync, existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { defaultHebraPluginsDirectory } from './verify-hebra-install.mjs';

/**
 * Summarises the plugin's local diagnostic log so a failure can be found quickly: time range, versions,
 * silence gaps, counts per level and a table grouped by (level, component, action, phase, code, state).
 *
 * Sources: an Obsidian vault (`--obsidian`), an exported JSONL (`--file`) or the Hebra IndexedDB
 * (`--hebra`, WebKitGTK SQLite). It never prints `message`, `stack` or any free text: every printed
 * field is a closed identifier (a value outside `[\w.:/-]{1,64}` prints as `?`). The live Hebra
 * database is never opened: `.sqlite3`, `-wal` and `-shm` are copied to a temp dir that is always removed.
 *
 * Run it with `--no-warnings=ExperimentalWarning` (`npm run diag:summary`): `node:sqlite` is experimental in Node 22.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];
const HEBRA_DB_NAME = 'hebra-tyrian-local-files';
const HEBRA_STORE = 'files';
const LOG_DIRECTORY = '.hebra/plugins/tyrian-companion/logs';
const SAFE_IDENTIFIER = /^[\w.:/-]{1,64}$/u;
/** A `suppressedKey` joins closed identifiers with `|`. */
const SAFE_KEY = /^[\w.:/|-]{1,160}$/u;
/** Same order as `readAll` in `src/core/local-debug-writer.ts`: the oldest rotation first, the active file last. */
const FILE_ORDER = ['debug.4.jsonl', 'debug.3.jsonl', 'debug.2.jsonl', 'debug.1.jsonl', 'debug.jsonl'];

export class DiagSummaryError extends Error {
	constructor(code) {
		super(code);
		this.name = 'DiagSummaryError';
		this.code = code;
	}
}

/** A closed identifier or `?`: free text never leaves this script. */
export function safe(value) {
	return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : '?';
}

/** Parses a local date (`2026-10-13`) or date-time (`2026-10-13 14:30[:05]`, `T` accepted). Returns ms or null. */
export function parseLocalTime(text, { endOfDay = false } = {}) {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text.trim());
	if (match === null) return null;
	const [, year, month, day, hour, minute, second] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0));
	if (Number.isNaN(date.getTime())) return null;
	if (hour === undefined && endOfDay) date.setDate(date.getDate() + 1);
	return date.getTime();
}

function pad(value) {
	return String(value).padStart(2, '0');
}

/** Local `YYYY-MM-DD HH:mm:ss`. */
export function formatLocal(ms) {
	const d = new Date(ms);
	return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Concatenates the retained files of one log in `readAll` order. `files` maps a file name to its text. */
export function orderedLogText(files) {
	return FILE_ORDER.map((name) => files.get(name)).filter((text) => typeof text === 'string').join('\n');
}

/** Reads `<vault>/.obsidian/plugins/tyrian-companion/logs/debug*.jsonl` into one source. */
export function readObsidianSource(vault) {
	const directory = resolve(vault, '.obsidian', 'plugins', 'tyrian-companion', 'logs');
	const files = new Map();
	for (const name of FILE_ORDER) {
		const path = join(directory, name);
		if (existsSync(path)) files.set(name, readFileSync(path, 'utf8'));
	}
	if (files.size === 0) throw new DiagSummaryError('no-log-files');
	return [{ label: 'obsidian', text: orderedLogText(files), files: files.size }];
}

export function readFileSource(path) {
	if (!existsSync(path)) throw new DiagSummaryError('file-not-found');
	return [{ label: 'file', text: readFileSync(path, 'utf8'), files: 1 }];
}

/** Decodes a WebKit SerializedScriptValue holding a string; null for any other value. */
export function decodeSerializedString(value) {
	const bytes = Buffer.from(value);
	if (bytes.length < 9 || bytes.readUInt32LE(0) !== 0x0f || bytes[4] !== 0x10) return null;
	const raw = bytes.readUInt32LE(5);
	const latin1 = (raw & 0x80000000) !== 0;
	const length = raw & 0x7fffffff;
	const width = latin1 ? 1 : 2;
	if (9 + length * width > bytes.length) return null;
	const body = bytes.subarray(9, 9 + length * width);
	return latin1 ? body.toString('latin1') : body.toString('utf16le');
}

/** Decodes an IndexedDB string key (`00 60`, u32le, UTF-16LE), given as hex because the column keeps NULs. */
export function decodeStringKey(hex) {
	const bytes = Buffer.from(hex, 'hex');
	if (bytes.length < 6 || bytes[0] !== 0x00 || bytes[1] !== 0x60) return null;
	return bytes.subarray(6).toString('utf16le');
}

const KEY_PATTERN = new RegExp(`^(.*)/${LOG_DIRECTORY.replaceAll('.', '\\.')}/(debug(?:\\.[1-4])?\\.jsonl)(?:\\u0000(\\d{8}))?$`, 'u');

/** Candidate Hebra databases: every IndexedDB.sqlite3 two levels down under the default location. */
export function defaultHebraDatabases(platform = process.platform, home = homedir(), xdgDataHome = process.env.XDG_DATA_HOME) {
	const plugins = platform === 'linux' ? defaultHebraPluginsDirectory(platform, home, xdgDataHome) : null;
	if (plugins === null) throw new DiagSummaryError('db-required');
	return globSync(join(dirname(plugins), 'databases', 'indexeddb', 'v1', '*', '*', 'IndexedDB.sqlite3')).sort();
}

function databaseName(db) {
	const row = db.prepare("SELECT value FROM IDBDatabaseInfo WHERE key = 'DatabaseName'").get();
	return row === undefined ? null : Buffer.from(row.value).toString('utf16le');
}

/** Reads one private copy of an IndexedDB; returns its libraries (`{ files: Map, ... }`) or null if it is another database. */
function readHebraCopy(copyPath) {
	const db = new DatabaseSync(copyPath, { readOnly: true });
	try {
		if (databaseName(db) !== HEBRA_DB_NAME) return null;
		const store = db.prepare('SELECT id FROM ObjectStoreInfo WHERE name = ?').get(HEBRA_STORE);
		if (store === undefined) return [];
		const libraries = new Map();
		// No ORDER BY and no key comparison: the IDBKEY collation is never needed for a full scan.
		for (const row of db.prepare('SELECT hex(key) AS hexkey, value FROM Records WHERE objectStoreID = ?').iterate(store.id)) {
			const key = decodeStringKey(row.hexkey);
			const match = key === null ? null : KEY_PATTERN.exec(key);
			if (match === null) continue;
			const text = decodeSerializedString(row.value);
			if (text === null) continue;
			const [, library, name, chunk] = match;
			const files = libraries.get(library) ?? new Map();
			libraries.set(library, files);
			const entry = files.get(name) ?? { whole: '', chunks: [] };
			files.set(name, entry);
			if (chunk === undefined) entry.whole = text;
			else entry.chunks.push([Number(chunk), text]);
		}
		return [...libraries.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, files]) => new Map([...files].map(([name, entry]) => [name, entry.whole + entry.chunks.sort((x, y) => x[0] - y[0]).map(([, text]) => text).join('')])));
	} finally {
		db.close();
	}
}

/** Copies `.sqlite3`, `-wal` and `-shm` to a temp dir, reads the copy and always removes it. */
export function readHebraSources(dbPaths) {
	const sources = [];
	let matched = 0;
	for (const dbPath of dbPaths) {
		if (!existsSync(dbPath)) throw new DiagSummaryError('db-not-found');
		const directory = mkdtempSync(join(tmpdir(), 'tyrian-diag-summary-'));
		try {
			const copy = join(directory, 'IndexedDB.sqlite3');
			copyFileSync(dbPath, copy);
			for (const suffix of ['-wal', '-shm']) {
				if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
			}
			let libraries;
			try {
				libraries = readHebraCopy(copy);
			} catch {
				throw new DiagSummaryError('db-unreadable');
			}
			if (libraries === null) continue;
			matched += 1;
			for (const files of libraries) {
				sources.push({ label: `lib#${String(sources.length + 1)}`, text: orderedLogText(files), files: files.size });
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	if (matched === 0) throw new DiagSummaryError('hebra-db-not-found');
	return sources;
}

function levelRank(level) {
	return LEVELS.indexOf(level);
}

/** Builds the summary of one log text under the given filters. */
export function summarize(text, { since = null, until = null, component = null, minLevel = 'debug', gapMin = 10 } = {}) {
	const records = [];
	let invalidLines = 0;
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			invalidLines += 1;
			continue;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			invalidLines += 1;
			continue;
		}
		const time = typeof parsed.timestampUtc === 'string' ? Date.parse(parsed.timestampUtc) : Number.NaN;
		if (Number.isNaN(time)) {
			invalidLines += 1;
			continue;
		}
		records.push({ time, record: parsed });
	}
	records.sort((a, b) => a.time - b.time);

	const levels = Object.fromEntries(LEVELS.map((level) => [level, 0]));
	const versions = new Map();
	const groups = new Map();
	const suppressed = new Map();
	const times = [];
	const minRank = levelRank(minLevel);
	for (const { time, record } of records) {
		if (since !== null && time < since) continue;
		if (until !== null && time >= until) continue;
		const level = LEVELS.includes(record.level) ? record.level : 'debug';
		if (levelRank(level) < minRank) continue;
		if (component !== null && record.component !== component) continue;
		times.push(time);
		levels[level] += 1;
		const version = safe(record.pluginVersion);
		const seen = versions.get(version) ?? { first: time, last: time };
		seen.last = time;
		versions.set(version, seen);
		if (record.component === 'local_debug' && [record.action, record.code, record.phase].includes('debug_suppress')) {
			const source = record.details !== null && typeof record.details === 'object' ? record.details : record;
			const count = Number.isFinite(source.count) ? Number(source.count) : Number.isFinite(record.count) ? Number(record.count) : 0;
			const raw = source.suppressedKey ?? record.suppressedKey;
			const key = typeof raw === 'string' && SAFE_KEY.test(raw) ? raw : '?';
			suppressed.set(key, (suppressed.get(key) ?? 0) + count);
		}
		const fields = [level, safe(record.component), safe(record.action), safe(record.phase), safe(record.code), record.state === undefined ? '-' : safe(record.state)];
		const id = fields.join('\u0001');
		const group = groups.get(id) ?? { level, component: fields[1], action: fields[2], phase: fields[3], code: fields[4], state: fields[5], count: 0, first: time, last: time, details: [] };
		group.count += 1;
		group.last = time;
		groups.set(id, group);
		if (level === 'error' && record.details !== null && typeof record.details === 'object' && !Array.isArray(record.details) && group.details.length < 3) {
			group.details.push(closedDetails(record.details));
		}
	}

	const gaps = [];
	for (let index = 1; index < times.length; index += 1) {
		const delta = times[index] - times[index - 1];
		if (delta > gapMin * 60_000) gaps.push({ from: times[index - 1], to: times[index], minutes: Math.round(delta / 60_000) });
	}
	const rows = [...groups.values()].sort((a, b) => levelRank(b.level) - levelRank(a.level) || b.count - a.count || a.first - b.first);
	return {
		range: times.length === 0 ? null : { first: times[0], last: times[times.length - 1] },
		records: times.length,
		invalidLines,
		levels,
		versions: [...versions.entries()].map(([version, range]) => ({ version, ...range })).sort((a, b) => a.first - b.first),
		gaps,
		rows,
		suppressed: [...suppressed.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
	};
}

/** `details` reduced to numbers, booleans and short closed identifiers; any other string prints as `?`. */
function closedDetails(details) {
	const out = {};
	for (const [key, value] of Object.entries(details).slice(0, 12)) {
		const name = safe(key);
		if (typeof value === 'number' || typeof value === 'boolean') out[name] = value;
		else if (typeof value === 'string') out[name] = safe(value);
		else out[name] = '?';
	}
	return out;
}

export function renderText(label, summary, { details = false } = {}) {
	const lines = [`== ${label} ==`];
	if (summary.range === null) {
		lines.push(`no records${summary.invalidLines > 0 ? ` (${String(summary.invalidLines)} unreadable lines)` : ''}`);
		return lines.join('\n');
	}
	lines.push(`range: ${formatLocal(summary.range.first)} .. ${formatLocal(summary.range.last)} (local)`);
	lines.push(`records: ${String(summary.records)} (unreadable lines: ${String(summary.invalidLines)})`);
	lines.push(`levels: ${LEVELS.map((level) => `${level}=${String(summary.levels[level])}`).join(' ')}`);
	lines.push('versions:');
	for (const v of summary.versions) lines.push(`  ${v.version}  ${formatLocal(v.first)} .. ${formatLocal(v.last)}`);
	lines.push(summary.gaps.length === 0 ? 'gaps: none' : 'gaps:');
	for (const g of summary.gaps) lines.push(`  ${formatLocal(g.from)} -> ${formatLocal(g.to)}  ${String(g.minutes)} min`);
	lines.push('count  level  component  action  phase  code  state  first  last');
	for (const row of summary.rows) {
		lines.push(`${String(row.count)}  ${row.level}  ${row.component}  ${row.action}  ${row.phase}  ${row.code}  ${row.state}  ${formatLocal(row.first)}  ${formatLocal(row.last)}`);
		if (details) for (const d of row.details) lines.push(`    details: ${JSON.stringify(d)}`);
	}
	if (summary.suppressed.length > 0) {
		lines.push('suppressed (local_debug/debug_suppress):');
		for (const s of summary.suppressed) lines.push(`  ${String(s.count)}  ${s.key}`);
	}
	return lines.join('\n');
}

function parseCli(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			strict: true,
			options: {
				obsidian: { type: 'string' },
				file: { type: 'string' },
				hebra: { type: 'boolean' },
				db: { type: 'string' },
				json: { type: 'boolean' },
				details: { type: 'boolean' },
				'gap-min': { type: 'string' },
				since: { type: 'string' },
				until: { type: 'string' },
				component: { type: 'string' },
				level: { type: 'string' },
			},
		}).values;
	} catch {
		throw new DiagSummaryError('bad-arguments');
	}
	const chosen = [parsed.obsidian !== undefined, parsed.file !== undefined, parsed.hebra === true].filter(Boolean).length;
	if (chosen !== 1 || (parsed.db !== undefined && parsed.hebra !== true)) throw new DiagSummaryError('choose-one-source');
	const gapMin = parsed['gap-min'] === undefined ? 10 : Number(parsed['gap-min']);
	if (!Number.isFinite(gapMin) || gapMin <= 0) throw new DiagSummaryError('bad-gap-min');
	const since = parsed.since === undefined ? null : parseLocalTime(parsed.since);
	const until = parsed.until === undefined ? null : parseLocalTime(parsed.until, { endOfDay: true });
	if ((parsed.since !== undefined && since === null) || (parsed.until !== undefined && until === null)) throw new DiagSummaryError('bad-date');
	if (parsed.level !== undefined && !LEVELS.includes(parsed.level)) throw new DiagSummaryError('bad-level');
	return { ...parsed, gapMin, since, until, minLevel: parsed.level ?? 'debug', component: parsed.component ?? null };
}

/** Runs the CLI; returns the text to print. */
export function run(argv) {
	const options = parseCli(argv);
	let sources;
	if (options.obsidian !== undefined) sources = readObsidianSource(options.obsidian);
	else if (options.file !== undefined) sources = readFileSource(options.file);
	else sources = readHebraSources(options.db === undefined ? defaultHebraDatabases() : [options.db]);
	const results = sources.map((source) => ({ source: source.label, files: source.files, ...summarize(source.text, options) }));
	if (options.json === true) {
		if (options.details !== true) for (const result of results) for (const row of result.rows) delete row.details;
		return JSON.stringify({ sources: results }, null, 2);
	}
	return results.map((result) => renderText(`${result.source} (${String(result.files)} files)`, result, { details: options.details === true })).join('\n\n');
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
	try {
		process.stdout.write(`${run(process.argv.slice(2))}\n`);
	} catch (error) {
		const code = error instanceof DiagSummaryError ? error.code : 'unexpected-failure';
		process.stderr.write(`diag-summary: ${code}\nUso: --obsidian <vault> | --file <ruta.jsonl> | --hebra [--db <IndexedDB.sqlite3>]  [--json] [--details] [--gap-min N] [--since F] [--until F] [--component C] [--level L]\n`);
		process.exitCode = code === 'db-required' ? 2 : 1;
	}
}
