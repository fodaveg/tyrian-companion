import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const script = resolve(process.cwd(), 'scripts/diag-summary.mjs');
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-diag-summary-test-'));
const failures = [];

function assert(condition, message) {
	if (!condition) failures.push(message);
}

function cli(...args) {
	return spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', script, ...args], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
}

/** One synthetic record; `message` and `stack` carry a canary that must never be printed. */
function record(minute, extra = {}) {
	const timestampUtc = new Date(Date.UTC(2026, 9, 13, 10, minute, 0)).toISOString();
	return JSON.stringify({ schemaVersion: 1, timestampUtc, sequence: minute, pluginVersion: '0.6.57', level: 'info', component: 'live', action: 'poll', phase: 'end', code: 'ok', message: 'CANARY-MESSAGE', stack: 'CANARY-STACK', ...extra });
}

function key(name) {
	const body = Buffer.from(name, 'utf16le');
	const head = Buffer.alloc(6);
	head[1] = 0x60;
	head.writeUInt32LE(body.length, 2);
	return Buffer.concat([head, body]);
}

function serialized(text, latin1) {
	const body = Buffer.from(text, latin1 ? 'latin1' : 'utf16le');
	const head = Buffer.alloc(9);
	head.writeUInt32LE(0x0f, 0);
	head[4] = 0x10;
	head.writeUInt32LE(((latin1 ? 0x80000000 : 0) | text.length) >>> 0, 5);
	return Buffer.concat([head, body]);
}

const logDirectory = '.hebra/plugins/tyrian-companion/logs';

function createHebraDatabase(path, { name = 'hebra-tyrian-local-files', libraries }) {
	const db = new DatabaseSync(path);
	db.exec('CREATE TABLE IDBDatabaseInfo (key TEXT NOT NULL, value NOT NULL)');
	db.exec('CREATE TABLE ObjectStoreInfo (id INTEGER PRIMARY KEY, name TEXT NOT NULL, keyPath BLOB, autoInc INTEGER)');
	db.exec('CREATE TABLE Records (objectStoreID INTEGER NOT NULL, key TEXT NOT NULL, value NOT NULL, recordID INTEGER PRIMARY KEY)');
	db.prepare('INSERT INTO IDBDatabaseInfo (key, value) VALUES (?, ?)').run('DatabaseName', Buffer.from(name, 'utf16le'));
	db.prepare('INSERT INTO ObjectStoreInfo (id, name, keyPath, autoInc) VALUES (7, ?, x\'00\', 0)').run('files');
	const insert = db.prepare('INSERT INTO Records (objectStoreID, key, value) VALUES (?, ?, ?)');
	for (const entry of libraries) insert.run(entry.store ?? 7, entry.key, entry.value);
	db.close();
}

try {
	// Obsidian folder: debug.2 is older than debug.1 which is older than debug.jsonl.
	const vault = join(testRoot, 'vault');
	const logs = join(vault, '.obsidian/plugins/tyrian-companion/logs');
	mkdirSync(logs, { recursive: true });
	writeFileSync(join(logs, 'debug.2.jsonl'), `${record(0, { pluginVersion: '0.6.56' })}\n${record(1, { pluginVersion: '0.6.56' })}\n`);
	writeFileSync(join(logs, 'debug.1.jsonl'), `${record(2)}\nthis is {not json CANARY-CORRUPT\n`);
	writeFileSync(join(logs, 'debug.jsonl'), [
		record(40, { level: 'error', code: 'http_500', state: 'failed', details: { status: 500, endpoint: 'prices', note: 'free text with spaces CANARY-DETAIL' } }),
		record(41, { level: 'error', code: 'http_500', state: 'failed' }),
		record(42, { level: 'warn', code: 'slow' }),
		record(43, { component: 'local_debug', action: 'debug_suppress', level: 'info', details: { suppressedKey: 'info|live|poll|end|ok|-', count: 5 } }),
		record(44, { component: 'local_debug', action: 'debug_suppress', level: 'info', details: { suppressedKey: 'info|live|poll|end|ok|-', count: 7 } }),
		'',
	].join('\n'));

	const text = cli('--obsidian', vault);
	assert(text.status === 0, `obsidian run failed: ${text.stderr}`);
	assert(text.stdout.includes('range: 2026-10-13 10:00:00 .. 2026-10-13 10:44:00'), 'range must cover all files in local time');
	assert(text.stdout.includes('0.6.56  2026-10-13 10:00:00 .. 2026-10-13 10:01:00'), 'old version range missing');
	assert(text.stdout.includes('0.6.57  2026-10-13 10:02:00 .. 2026-10-13 10:44:00'), 'new version range missing');
	assert(text.stdout.includes('2026-10-13 10:02:00 -> 2026-10-13 10:40:00  38 min'), 'silence gap missing');
	assert(text.stdout.includes('levels: debug=0 info=5 warn=1 error=2'), 'level counts wrong');
	assert(text.stdout.includes('unreadable lines: 1'), 'corrupt line must be counted');
	assert(text.stdout.includes('  12  info|live|poll|end|ok|-'), 'suppressed counts must be summed per suppressedKey');
	const rows = text.stdout.split('\n').filter((line) => /^\d+ {2}(error|warn|info)/u.test(line));
	assert(rows[0]?.startsWith('2  error') && rows[1]?.startsWith('1  warn'), 'errors and warnings must come first');
	for (const canary of ['CANARY-MESSAGE', 'CANARY-STACK', 'CANARY-CORRUPT', 'CANARY-DETAIL', 'endpoint']) {
		assert(!text.stdout.includes(canary), `${canary} leaked without --details`);
	}
	const detailed = cli('--obsidian', vault, '--details');
	assert(detailed.stdout.includes('"status":500') && detailed.stdout.includes('"endpoint":"prices"'), '--details must show closed details');
	assert(detailed.stdout.includes('"note":"?"') && !detailed.stdout.includes('CANARY'), '--details must hide free text');

	const gap = cli('--obsidian', vault, '--gap-min', '60');
	assert(gap.stdout.includes('gaps: none'), '--gap-min must raise the threshold');
	const onlyErrors = cli('--obsidian', vault, '--level', 'error', '--json');
	const parsed = JSON.parse(onlyErrors.stdout);
	assert(parsed.sources[0].records === 2 && parsed.sources[0].levels.error === 2, '--level error --json wrong');
	const live = cli('--obsidian', vault, '--component', 'live', '--json');
	assert(JSON.parse(live.stdout).sources[0].records === 6, '--component filter wrong');
	const since = cli('--obsidian', vault, '--since', '2026-10-13 10:41', '--json');
	assert(JSON.parse(since.stdout).sources[0].records === 4, '--since filter wrong');
	const until = cli('--obsidian', vault, '--until', '2026-10-13 10:02', '--json');
	assert(JSON.parse(until.stdout).sources[0].records === 2, '--until filter wrong');
	const nextDay = cli('--obsidian', vault, '--since', '2026-10-14', '--json');
	assert(JSON.parse(nextDay.stdout).sources[0].records === 0, 'a later --since must leave nothing');

	// --file
	writeFileSync(join(testRoot, 'export.jsonl'), `${record(5)}\n${record(6, { level: 'error', code: 'boom' })}\n`);
	const file = cli('--file', join(testRoot, 'export.jsonl'));
	assert(file.status === 0 && file.stdout.includes('records: 2'), '--file run failed');

	// Bad usage
	assert(cli().status !== 0, 'no source must fail');
	assert(cli('--file', 'a', '--hebra').status !== 0, 'two sources must fail');
	assert(cli('--hebra', '--db', join(testRoot, 'missing.sqlite3')).status !== 0, 'missing db must fail');
	assert(cli('--file', join(testRoot, 'export.jsonl'), '--since', 'ayer').status !== 0, 'bad date must fail');

	// Hebra IndexedDB: two libraries, chunks, Latin-1 and UTF-16 values, a decoy store and a decoy database.
	const libA = 'aaaaaaaa-0000-0000-0000-000000000001';
	const libB = 'bbbbbbbb-0000-0000-0000-000000000002';
	const chunked = (name) => `${name}/${logDirectory}/debug.jsonl`;
	const base = `${record(0, { details: { zone: 'Cañón' } })}\n`;
	const second = `${record(1, { level: 'error', code: 'ünï' })}\n`;
	const third = `${record(50, { level: 'warn', code: 'slow', details: { zone: 'Ñandú' } })}\nnot json\n`;
	const split = Math.floor(third.length / 2);
	const dbPath = join(testRoot, 'IndexedDB.sqlite3');
	createHebraDatabase(dbPath, {
		libraries: [
			{ key: key(chunked(libA)), value: serialized(base, true) },
			// chunks are inserted out of order on purpose
			{ key: key(`${chunked(libA)}\u000000000002`), value: serialized(third.slice(split), false) },
			{ key: key(`${chunked(libA)}\u000000000001`), value: serialized(second + third.slice(0, split), false) },
			{ key: key(`${libA}/${logDirectory}/debug.1.jsonl`), value: serialized(`${record(0, { code: 'rotated' })}\n`, true) },
			{ key: key(`${libB}/${logDirectory}/debug.jsonl`), value: serialized(`${record(3, { level: 'error', code: 'otra' })}\n`, false) },
			{ key: key(`${libB}/otra/ruta/debug.jsonl`), value: serialized(`${record(4)}\n`, false) },
			{ store: 99, key: key(chunked(libB)), value: serialized(`${record(9)}\n`, false) },
		],
	});
	const before = readdirSync(tmpdir()).filter((name) => name.startsWith('tyrian-diag-summary-') && !name.includes('-test-'));
	const hebra = cli('--hebra', '--db', dbPath, '--json');
	assert(hebra.status === 0, `hebra run failed: ${hebra.stderr}`);
	const result = JSON.parse(hebra.stdout);
	assert(result.sources.length === 2 && result.sources[0].source === 'lib#1' && result.sources[1].source === 'lib#2', 'libraries must print as lib#n in order');
	assert(result.sources[0].records === 4 && result.sources[0].invalidLines === 1, `library A records wrong: ${JSON.stringify(result.sources[0].records)}`);
	assert(result.sources[0].rows.some((row) => row.code === '?' && row.level === 'error'), 'non-identifier code must print as ?');
	assert(result.sources[1].records === 1, 'library B records wrong');
	assert(!hebra.stdout.includes(libA) && !hebra.stdout.includes(libB) && !hebra.stdout.includes('/.hebra/'), 'library names or paths leaked');
	const after = readdirSync(tmpdir()).filter((name) => name.startsWith('tyrian-diag-summary-') && !name.includes('-test-'));
	assert(after.length === before.length, 'temporary copy was not removed');

	// A database with another name is not Hebra's log; a copy must also be removed on failure.
	const otherPath = join(testRoot, 'other.sqlite3');
	createHebraDatabase(otherPath, { name: 'tyrian-companion-managed-assets', libraries: [] });
	assert(cli('--hebra', '--db', otherPath).status !== 0, 'another database must not match');
	const broken = join(testRoot, 'broken.sqlite3');
	writeFileSync(broken, 'not a database at all, long enough to be read as a header....');
	const failed = cli('--hebra', '--db', broken);
	assert(failed.status !== 0, 'unreadable db must fail');
	const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('tyrian-diag-summary-') && !name.includes('-test-'));
	assert(leftovers.length === before.length, 'temporary copy left behind after a failure');
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.exit(1);
}
process.stdout.write('diag-summary suite: PASS\n');
