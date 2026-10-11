import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import {
	HebraInstallError,
	defaultHebraDiagnosticsFile,
	defaultHebraPluginsDirectory,
	describeHebraLoad,
	judgeHebraLoad,
	loadVerdictFailsInstall,
	readHebraLoad,
	parseHebraInstallArguments,
	verifyHebraInstall,
} from '../verify-hebra-install.mjs';

// Everything here runs against a directory this suite builds in the temp folder: it never reads the
// plugins directory of a real Hebra and never calls `gh` (the release reader is injected).
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-hebra-install-'));
const failures = [];
const BYTES = { 'hebra.json': '', 'hebra-main.mjs': 'export const main = 1;\n', 'hebra-styles.css': '.tc-x{}\n' };
// As in the real thing: the manifest lists the hashes of the two code files and never its own.
BYTES['hebra.json'] = manifestText('0.6.35');

try {
	testMatchingInstallPasses();
	testReleaseDigestMismatchIsRed();
	testReleaseAssetProblemsAreRed();
	testRegistryProblemsAreRed();
	testFilesOnDiskProblemsAreRed();
	testOptOutOfTheReleaseCheckSkipsGh();
	testGhIsNamedTheRepository();
	testArgumentsAndPlatformDefaults();
	testLoadVerdicts();
	testLoadVerdictsByWindow();
	testLoadFileReading();
	testCommandLineExitCodes();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`hebra install suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('hebra install suite: PASS\n');
}

function testMatchingInstallPasses() {
	const dir = fakeHebra('pass');
	const result = verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => releaseAssets() });
	assert(result.version === '0.6.35' && result.previous === '0.6.34' && result.releaseChecked === true,
		'a registry, files and release that agree did not pass');
	let asked = null;
	verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: ({ tag }) => { asked = tag; return releaseAssets(); } });
	assert(asked === '0.6.35', `the release was asked for ${String(asked)} instead of the installed version`);
	verifyHebraInstall({ pluginsDir: dir, releaseTag: '0.6.34', readReleaseAssets: ({ tag }) => { asked = tag; return JSON.parse(releaseAssets()); } });
	assert(asked === '0.6.34', `an explicit --release-tag 0.6.34 asked the release ${String(asked)}`);
}

function testReleaseDigestMismatchIsRed() {
	for (const name of Object.keys(BYTES)) {
		assertCode(
			() => verifyHebraInstall({ pluginsDir: fakeHebra(`digest-${name}`), readReleaseAssets: () => releaseAssets({ [name]: 'other bytes' }) }),
			'installed-asset-mismatch', `${name} with other bytes than the release stayed green`,
		);
	}
}

function testReleaseAssetProblemsAreRed() {
	const dir = fakeHebra('release-problems');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => releaseAssets({}, ['hebra-styles.css']) }),
		'release-asset-missing', 'a release without hebra-styles.css stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => JSON.stringify({ assets: [{ name: 'hebra.json' }, { name: 'hebra-main.mjs' }, { name: 'hebra-styles.css' }] }) }),
		'release-digest-missing', 'a release without digests stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => 'not json' }),
		'release-unavailable', 'an unreadable release stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => { throw new HebraInstallError('release-unavailable'); } }),
		'release-unavailable', 'a failing gh stayed green');
}

function testRegistryProblemsAreRed() {
	const cases = [
		['no-registry', { registry: null }, 'registry-missing'],
		['bad-json', { registry: '{nope' }, 'registry-invalid'],
		['other-schema', { registry: { schema: 2, plugins: [] } }, 'registry-invalid'],
		['not-installed', { registry: { schema: 1, plugins: [{ id: 'other', version: '1.0.0', files: {} }] } }, 'plugin-not-installed'],
		['bad-version', { record: { version: 'latest' } }, 'registry-invalid'],
		['registry-hash', { record: { files: { ...registryFiles(), 'hebra-main.mjs': `sha256:${'0'.repeat(64)}` } } }, 'registry-hash-mismatch'],
		['registry-no-hash', { record: { files: { 'hebra-main.mjs': registryFiles()['hebra-main.mjs'] } } }, 'registry-files-unexpected'],
		// Hebra's record.files is manifest.files, which never lists hebra.json: asking for it again would make every real install red.
		['registry-with-hebra-json', { record: { files: { ...registryFiles(), 'hebra.json': `sha256:${sha(BYTES['hebra.json'])}` } } }, 'registry-files-unexpected'],
		['no-version-dir', { skipFiles: true }, 'version-directory-missing'],
	];
	for (const [name, options, code] of cases) {
		assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra(`registry-${name}`, options), readReleaseAssets: () => releaseAssets() }),
			code, `registry case ${name} did not fail with ${code}`);
	}
}

function testFilesOnDiskProblemsAreRed() {
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-missing', { omit: ['hebra-styles.css'] }), readReleaseAssets: () => releaseAssets() }),
		'installed-file-missing', 'an installed version without hebra-styles.css stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-tampered', { disk: { 'hebra-main.mjs': 'tampered' } }), readReleaseAssets: () => releaseAssets() }),
		'registry-hash-mismatch', 'a file that no longer matches the registry stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-manifest-version', { disk: { 'hebra.json': manifestText('0.6.34') } }), readReleaseAssets: () => releaseAssets() }),
		'hebra-manifest-version', 'a hebra.json of another version stayed green');
	const otherFiles = manifestText('0.6.35', { 'hebra-main.mjs': `sha256:${'1'.repeat(64)}`, 'hebra-styles.css': `sha256:${'2'.repeat(64)}` });
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-manifest-files', { disk: { 'hebra.json': otherFiles } }), readReleaseAssets: () => releaseAssets() }),
		'registry-manifest-files-mismatch', 'a hebra.json whose files differ from the registry stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: join(testRoot, 'does-not-exist'), readReleaseAssets: () => releaseAssets() }),
		'plugins-dir-missing', 'a missing plugins directory stayed green');
}

function testOptOutOfTheReleaseCheckSkipsGh() {
	const result = verifyHebraInstall({
		pluginsDir: fakeHebra('no-release'), releaseCheck: false,
		readReleaseAssets: () => { throw new Error('gh must not be called'); },
	});
	assert(result.releaseChecked === false, 'the opt-out of the release check was not reported');
}

/** The default reader must name the repository: `gh` runs outside any clone. */
function testGhIsNamedTheRepository() {
	const logPath = join(testRoot, 'gh-args.json');
	const ghPath = join(testRoot, 'fake-gh.mjs');
	writeFileSync(ghPath, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(releaseAssets())});\n`);
	chmodSync(ghPath, 0o755);
	verifyHebraInstall({ pluginsDir: fakeHebra('gh-repo'), ghCommand: ghPath });
	const asked = JSON.parse(readFileSync(logPath, 'utf8')).join(' ');
	assert(asked === 'release view 0.6.35 --repo fodaveg/tyrian-companion --json assets', `gh was called as: ${asked}`);
}

function testArgumentsAndPlatformDefaults() {
	assert(defaultHebraPluginsDirectory('win32', '/h') === null, 'Windows got a guessed plugins directory');
	assert(defaultHebraPluginsDirectory('linux', '/h', undefined) === resolve('/h', '.local', 'share', 'net.fodaveg.hebra', 'plugins'), 'Linux default is not the documented one');
	assert(defaultHebraPluginsDirectory('linux', '/h', '/xdg') === resolve('/xdg', 'net.fodaveg.hebra', 'plugins'), 'Linux default ignored XDG_DATA_HOME');
	assert(defaultHebraPluginsDirectory('linux', '/h', 'relative') === resolve('/h', '.local', 'share', 'net.fodaveg.hebra', 'plugins'), 'a relative XDG_DATA_HOME was honoured');
	assert(defaultHebraPluginsDirectory('darwin', '/h') === resolve('/h', 'Library', 'Containers', 'net.fodaveg.hebra', 'Data', 'Library', 'Application Support', 'net.fodaveg.hebra', 'fresh-v1', 'plugins'), 'macOS default is not the sandbox container with fresh-v1');
	const fallback = parseHebraInstallArguments([], { platform: 'linux', home: join(testRoot, 'no-home'), xdgDataHome: undefined });
	assert(fallback.pluginsDirIsDefault === true, 'a default plugins directory was not flagged as such');
	assertCode(() => verifyHebraInstall(fallback), 'plugins-dir-default-missing', 'a missing default directory did not say it was an assumed one');
	assert(parseHebraInstallArguments(['--plugins-dir', '/x'], { platform: 'linux', home: '/h' }).pluginsDirIsDefault === false, 'an explicit directory was flagged as default');
	assertCode(() => parseHebraInstallArguments([], { platform: 'win32', home: '/h' }), 'plugins-dir-required', 'Windows without --plugins-dir did not ask for it');
	const explicit = parseHebraInstallArguments(['--plugins-dir', '/x/plugins', '--release-tag', '0.6.35', '--gh-cli', '/bin/gh'], { platform: 'win32', home: '/h' });
	assert(explicit.pluginsDir === resolve('/x/plugins') && explicit.releaseTag === '0.6.35' && explicit.ghCommand === '/bin/gh' && explicit.releaseCheck === true,
		'explicit arguments were not honoured');
	assertCode(() => parseHebraInstallArguments(['--bogus'], { platform: 'linux', home: '/h' }), 'usage', 'an unknown flag was accepted');
	assertCode(() => parseHebraInstallArguments(['--plugins-dir'], { platform: 'linux', home: '/h' }), 'usage', 'a flag without value was accepted');
	assertCode(() => parseHebraInstallArguments(['--no-release-check', '--release-tag', '0.6.35'], { platform: 'linux', home: '/h' }), 'usage', 'a release tag with the check disabled was accepted');
}

function activated(session, version = '0.6.35', extra = {}) {
	return { t: 1, seq: 1, session, event: 'plugins.activated', id: 'tyrian-companion', version, ...extra };
}
function failedEvent(session, extra = {}) {
	return { t: 2, seq: 2, session, event: 'plugins.load-failed', id: 'tyrian-companion', version: '0.6.35', stage: 'activacion', code: 'activate-lanza', incompatibility: 'ninguna', errorName: 'TypeError', ...extra };
}
function jsonl(...lines) {
	return `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
}

/** RT-09 level 2: the verdict of the load events, apart from the bytes. */
function testLoadVerdicts() {
	const loaded = judgeHebraLoad(jsonl(activated('s1')), '0.6.35');
	assert(loaded.status === 'loaded' && loaded.version === '0.6.35', `an activated event of the installed version was ${loaded.status}`);
	assert(!loadVerdictFailsInstall(loaded), 'loaded failed the install');

	const failed = judgeHebraLoad(jsonl(activated('s1'), failedEvent('s1')), '0.6.35');
	assert(failed.status === 'failed' && failed.stage === 'activacion' && failed.code === 'activate-lanza' && failed.incompatibility === 'ninguna' && failed.errorName === 'TypeError',
		`a load-failed event was ${failed.status}`);
	assert(loadVerdictFailsInstall(failed), 'failed did not fail the install');
	assert(describeHebraLoad(failed).includes('code=activate-lanza'), 'the failed report hides its code');

	// The last event of the session decides: it activated after failing once.
	assert(judgeHebraLoad(jsonl(failedEvent('s1'), activated('s1')), '0.6.35').status === 'loaded', 'an older failure beat a later activation');

	// Only non-plugin events: no data. A newer session without ANY `plugins.*` event (another window) does not
	// take the verdict from the last session that did load plugins.
	const stale = judgeHebraLoad(jsonl({ t: 3, seq: 1, session: 'new', event: 'app.visibility' }), '0.6.35');
	assert(stale.status === 'no-data' && stale.reason === 'no-plugin-events', `a log with no plugins event was ${stale.status}`);
	assert(!loadVerdictFailsInstall(stale), 'no-data failed the install');
	assert(describeHebraLoad(stale).includes('apagado'), 'no-data does not say the log may be off');
	assert(judgeHebraLoad(jsonl(activated('old'), { t: 3, seq: 1, session: 'new', event: 'app.visibility' }), '0.6.35').status === 'loaded', 'a later non-plugin session erased the main-window verdict');
	// The latest main start recorded plugins, but not tyrian-companion (another plugin only): the old result is NOT reused.
	const reused = judgeHebraLoad(jsonl(activated('old'), { t: 3, seq: 1, session: 'new', event: 'plugins.activated', id: 'otro', version: '1.0.0' }), '0.6.35');
	assert(reused.status === 'no-data' && reused.reason === 'no-tyrian-event-in-latest-plugin-session', `an old start was reused for a newer one without tyrian: ${reused.status}`);

	// D-1: lines of other webviews (session B) interleaved between the failure and the end of A must not erase it.
	const visibility = (session, t) => ({ t, seq: t, session, event: 'app.visibility', state: 'hidden' });
	const interleaved = judgeHebraLoad(jsonl(failedEvent('A'), visibility('B', 5), visibility('A', 6)), '0.6.35');
	assert(interleaved.status === 'failed', `A:failed, B:other, A:other was ${interleaved.status}`);
	assert(judgeHebraLoad(jsonl(activated('A'), visibility('B', 5), visibility('A', 6)), '0.6.35').status === 'loaded', 'A:activated, B:other, A:other lost the activation');
	// An editor window that writes last (its own session, no plugins) leaves the verdict alone.
	assert(judgeHebraLoad(jsonl(failedEvent('A'), visibility('E', 9)), '0.6.35').status === 'failed', 'an editor line at the end erased the failure');
	// Other plugins' events (`id: otro`) choose the session but are never attributed to tyrian-companion.
	const withOther = judgeHebraLoad(jsonl(failedEvent('A'), { t: 4, seq: 4, session: 'A', event: 'plugins.activated', id: 'otro', version: '1.0.0' }), '0.6.35');
	assert(withOther.status === 'failed', `a later event of another plugin in the same session was ${withOther.status}`);

	// A failure of an old session does not poison a new session that activated.
	assert(judgeHebraLoad(jsonl(failedEvent('old'), activated('new')), '0.6.35').status === 'loaded', 'an old failure beat the new session');
	// Another plugin's events are not Tyrian's.
	assert(judgeHebraLoad(jsonl(failedEvent('s1', { id: 'other' })), '0.6.35').status === 'no-data', 'another plugin failure was attributed to tyrian-companion');
	// An older main start that failed does not poison the newest one that activated, even with a window between.
	assert(judgeHebraLoad(jsonl(failedEvent('old'), { t: 3, seq: 3, session: 'E', event: 'app.visibility' }, activated('new')), '0.6.35').status === 'loaded', 'an old failure beat the new start');

	const mismatch = judgeHebraLoad(jsonl(activated('s1', '0.6.34')), '0.6.35');
	assert(mismatch.status === 'version-mismatch' && mismatch.version === '0.6.34' && mismatch.installed === '0.6.35', `an activation of another version was ${mismatch.status}`);
	assert(loadVerdictFailsInstall(mismatch), 'version-mismatch did not fail the install');

	const broken = judgeHebraLoad(`{nope\n${jsonl(activated('s1'))}[1,2]\n`, '0.6.35');
	assert(broken.status === 'loaded' && broken.malformed === 2, `broken lines were not skipped and counted (${broken.status}, ${String(broken.malformed)})`);
	assert(describeHebraLoad(broken).includes('lineas-ilegibles=2'), 'the broken-line count is not reported');

	// Nothing but the sanitised fields reaches the report.
	const hostile = judgeHebraLoad(jsonl(failedEvent('s1', { errorName: 'Bad\u001b[31m name', secret: 'TOKEN-123' })), '0.6.35');
	assert(hostile.errorName === '?' && !JSON.stringify(hostile).includes('TOKEN-123'), 'a free-form or foreign field leaked into the verdict');
}

/** Hebra rpm 0.2.0-23: `plugins.*` events carry `window`; the principal window's session is the one judged. */
function testLoadVerdictsByWindow() {
	const w = (window, session, event) => ({ ...event, session, window });
	const other = (session, window, t) => ({ t, seq: t, session, event: 'plugins.activated', id: 'otro', version: '1.0.0', ...(window === undefined ? {} : { window }) });
	// Principal failed; an editor window logged a later plugins.* line (its own session, with tyrian activated).
	const editorLast = judgeHebraLoad(jsonl(w('principal', 'P', failedEvent('P')), w('editor', 'E', activated('E'))), '0.6.35');
	assert(editorLast.status === 'failed', `an editor plugins.* line at the end beat the principal failure: ${editorLast.status}`);
	// Same with `otra`, and with an unknown value: neither chooses the session.
	assert(judgeHebraLoad(jsonl(w('principal', 'P', failedEvent('P')), w('otra', 'O', activated('O'))), '0.6.35').status === 'failed', 'an `otra` line chose the session');
	assert(judgeHebraLoad(jsonl(w('principal', 'P', failedEvent('P')), w('rara', 'R', activated('R'))), '0.6.35').status === 'failed', 'an unknown window value chose the session');
	// Only non-principal windows with plugins.* lines: nothing to judge.
	assert(judgeHebraLoad(jsonl(w('editor', 'E', activated('E'))), '0.6.35').reason === 'no-principal-window-plugin-event', 'an editor-only log was judged');
	// The latest principal session wins over an older one.
	assert(judgeHebraLoad(jsonl(w('principal', 'P1', failedEvent('P1')), w('principal', 'P2', activated('P2'))), '0.6.35').status === 'loaded', 'an older principal session beat the newer one');
	// Without `window` (rpm 22 and earlier): the old heuristic, last plugins.* line of any plugin.
	assert(judgeHebraLoad(jsonl(failedEvent('P'), activated('E')), '0.6.35').status === 'loaded', 'a log without window stopped using the last-session heuristic');
	assert(judgeHebraLoad(jsonl(failedEvent('P'), other('P', undefined, 7)), '0.6.35').status === 'failed', 'a log without window lost the failure');
	// Mixed: old lines without window (rotated) and new ones with window (live). Window lines decide.
	const mixed = judgeHebraLoad(jsonl(activated('OLD'), other('OLD', undefined, 5), w('principal', 'P', failedEvent('P')), w('editor', 'E', activated('E'))), '0.6.35');
	assert(mixed.status === 'failed', `a mixed log was ${mixed.status}`);
	// Mixed, the old session was the only one with tyrian: the principal session has none -> no-data, not the old verdict.
	const mixedNone = judgeHebraLoad(jsonl(activated('OLD'), w('principal', 'P', other('P', 'principal', 8))), '0.6.35');
	assert(mixedNone.reason === 'no-tyrian-event-in-latest-plugin-session', `a mixed log reused the old session: ${mixedNone.status}`);
}

function testLoadFileReading() {
	const dir = join(testRoot, 'diagnostics');
	mkdirSync(dir, { recursive: true });
	const read = (name, content, maxBytes) => {
		const path = join(dir, name);
		if (content !== null) writeFileSync(path, content);
		return readHebraLoad({ diagnosticsFile: path, installedVersion: '0.6.35', ...(maxBytes === undefined ? {} : { maxBytes }) });
	};
	assert(read('absent.jsonl', null).reason === 'file-missing', 'an absent log was not no-data/file-missing');
	assert(read('empty.jsonl', '').reason === 'empty', 'an empty log was not no-data/empty');
	assert(readHebraLoad({ diagnosticsFile: null, installedVersion: '0.6.35' }).reason === 'path-unknown', 'an unknown path was not no-data/path-unknown');
	assert(readHebraLoad({ diagnosticsFile: dir, installedVersion: '0.6.35' }).status === 'no-data', 'a directory as log did not degrade to no-data');
	assert(read('ok.jsonl', jsonl(activated('s1'))).status === 'loaded', 'a log with an activation was not loaded');
	// Big log: only the tail is read, and the cut first line is not counted as malformed.
	const padding = jsonl(...Array.from({ length: 200 }, (_, index) => ({ t: index, session: 'old', event: 'noise', filler: 'x'.repeat(50) })));
	const big = read('big.jsonl', padding + jsonl(activated('new')), 600);
	assert(big.status === 'loaded' && big.malformed === 0, `a log over the cap was ${big.status} with ${String(big.malformed)} malformed`);
	// D-1, rotation: Hebra moves the full log to `diagnostico.1.jsonl`; the failure can sit there while the live one
	// is empty, absent, or holds only a window's lines.
	const rotationDir = join(testRoot, 'rotation');
	mkdirSync(rotationDir, { recursive: true });
	const rotatedRead = ({ rotated, live }, maxBytes) => {
		const livePath = join(rotationDir, 'diagnostico.jsonl');
		const rotatedPath = join(rotationDir, 'diagnostico.1.jsonl');
		rmSync(livePath, { force: true });
		rmSync(rotatedPath, { force: true });
		if (rotated !== null) writeFileSync(rotatedPath, rotated);
		if (live !== null) writeFileSync(livePath, live);
		return readHebraLoad({ diagnosticsFile: livePath, installedVersion: '0.6.35', ...(maxBytes === undefined ? {} : { maxBytes }) });
	};
	const windowLine = { t: 9, seq: 9, session: 'E', event: 'app.visibility', state: 'visible' };
	assert(rotatedRead({ rotated: jsonl(failedEvent('A')), live: null }).status === 'failed', 'a failure in the rotated log with no live log was lost');
	assert(rotatedRead({ rotated: jsonl(failedEvent('A')), live: '' }).status === 'failed', 'a failure in the rotated log with an empty live log was lost');
	assert(rotatedRead({ rotated: jsonl(failedEvent('A')), live: jsonl(windowLine) }).status === 'failed', 'a window line in the live log erased the rotated failure');
	assert(rotatedRead({ rotated: jsonl(failedEvent('A')), live: jsonl(activated('B')) }).status === 'loaded', 'the live log did not outrank the rotated one');
	assert(rotatedRead({ rotated: jsonl(activated('A')), live: jsonl(failedEvent('A', { t: 5 })) }).status === 'failed', 'the live log of the same session did not outrank the rotated one');
	assert(rotatedRead({ rotated: jsonl(activated('OLD')), live: jsonl({ ...failedEvent('P'), window: 'principal' }, { ...activated('E'), window: 'editor' }) }).status === 'failed', 'rotated lines without window and live lines with window were not mixed by window');
	assert(rotatedRead({ rotated: null, live: null }).reason === 'file-missing', 'neither log present was not file-missing');
	assert(rotatedRead({ rotated: '', live: '' }).reason === 'empty', 'two empty logs were not empty');
	// The per-file cap keeps the tail of EACH file: a big live log does not push the rotated failure out.
	const noise = jsonl(...Array.from({ length: 200 }, (_, index) => ({ t: index, session: 'E', event: 'noise', filler: 'x'.repeat(50) })));
	assert(rotatedRead({ rotated: jsonl(failedEvent('A')), live: noise }, 600).status === 'failed', 'the cap of the live log excluded the rotated failure');
	assert(defaultHebraDiagnosticsFile('linux', '/h', undefined) === resolve('/h', '.local', 'share', 'net.fodaveg.hebra', 'diagnostico.jsonl'), 'Linux diagnostics default is not next to plugins/');
	assert(defaultHebraDiagnosticsFile('darwin', '/h') === null && defaultHebraDiagnosticsFile('win32', '/h') === null, 'a diagnostics path was guessed outside Linux');
	assert(parseHebraInstallArguments(['--plugins-dir', '/x/plugins'], { platform: 'linux', home: '/h' }).diagnosticsFile === null, 'a custom plugins directory inherited the default log');
	assert(parseHebraInstallArguments(['--plugins-dir', '/x/plugins', '--diagnostics-file', '/x/d.jsonl'], { platform: 'darwin', home: '/h' }).diagnosticsFile === resolve('/x/d.jsonl'), '--diagnostics-file was not honoured');
}

/** The real command line, with a fake Hebra and no release check: what decides the exit code. */
function testCommandLineExitCodes() {
	const script = fileURLToPath(new URL('../verify-hebra-install.mjs', import.meta.url));
	const plugins = fakeHebra('cli');
	const run = (content) => {
		const log = join(testRoot, 'cli', 'diagnostico.jsonl');
		if (content !== null) writeFileSync(log, content);
		return spawnSync(process.execPath, [script, '--plugins-dir', plugins, '--no-release-check', '--diagnostics-file', log], { encoding: 'utf8' });
	};
	const cases = [
		['activated', jsonl(activated('s1')), 0, 'carga=loaded'],
		['failed', jsonl(failedEvent('s1')), 1, 'carga=failed'],
		['mismatch', jsonl(activated('s1', '0.6.1')), 1, 'carga=version-mismatch'],
		['no-data', jsonl({ session: 's1', event: 'x' }), 0, 'carga=no-data'],
		// D-1: A:failed, B:other, A:other must still exit 1.
		['failed-interleaved', jsonl(failedEvent('A'), { t: 5, seq: 5, session: 'B', event: 'app.visibility', state: 'hidden' }, { t: 6, seq: 6, session: 'A', event: 'app.visibility', state: 'visible' }), 1, 'carga=failed'],
	];
	for (const [name, content, status, text] of cases) {
		const result = run(content);
		assert(result.status === status && result.stdout.includes(text) && result.stdout.includes('hebra install v2:'), `CLI ${name}: exit ${String(result.status)}, ${result.stdout}${result.stderr}`);
	}
}

function manifestText(version, files = { 'hebra-main.mjs': `sha256:${sha('export const main = 1;\n')}`, 'hebra-styles.css': `sha256:${sha('.tc-x{}\n')}` }) {
	return JSON.stringify({ schema: 1, id: 'tyrian-companion', version, apiVersion: '1.4.0', files });
}

function sha(text) {
	return createHash('sha256').update(text).digest('hex');
}

/** The `files` of the registry record: `manifest.files`, so only the two code files. */
function registryFiles(changed = {}) {
	return Object.fromEntries(['hebra-main.mjs', 'hebra-styles.css'].map((name) => [name, `sha256:${sha(changed[name] ?? BYTES[name])}`]));
}

/** What `gh release view 0.6.35 --json assets` prints; `changed` replaces the bytes a digest was taken from. */
function releaseAssets(changed = {}, omit = []) {
	return JSON.stringify({
		assets: Object.entries({ ...BYTES, ...changed })
			.filter(([name]) => !omit.includes(name))
			.map(([name, text]) => ({ name, digest: `sha256:${sha(text)}` })),
	});
}

/** A plugins directory shaped like Hebra's (`installed.json` plus `tyrian-companion/<version>/`), all fake. */
function fakeHebra(name, { registry, record = {}, omit = [], disk = {}, skipFiles = false } = {}) {
	const dir = join(testRoot, name, 'plugins');
	mkdirSync(dir, { recursive: true });
	if (registry !== null) {
		const body = registry ?? {
			schema: 1,
			plugins: [{
				id: 'tyrian-companion',
				source: { repo: 'fodaveg/tyrian-companion', listed: true },
				version: '0.6.35',
				previous: '0.6.34',
				files: registryFiles(),
				installedAt: '2026-10-10T00:00:00.000Z',
				apiVersion: '1.4.0',
				manifest: JSON.parse(BYTES['hebra.json']),
				...record,
			}],
		};
		writeFileSync(join(dir, 'installed.json'), typeof body === 'string' ? body : JSON.stringify(body));
	}
	if (!skipFiles) {
		const versionDir = join(dir, 'tyrian-companion', '0.6.35');
		mkdirSync(versionDir, { recursive: true });
		for (const [file, text] of Object.entries({ ...BYTES, ...disk })) {
			if (!omit.includes(file)) writeFileSync(join(versionDir, file), text);
		}
	}
	return dir;
}

function assertCode(run, expectedCode, message) {
	try {
		run();
	} catch (error) {
		if (error instanceof HebraInstallError && error.code === expectedCode) return;
		failures.push(`${message} (got: ${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	failures.push(message);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
