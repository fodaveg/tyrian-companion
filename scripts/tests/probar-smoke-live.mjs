import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
	SmokeLiveError,
	parseSmokeLiveArguments,
	readErrorsSinceReload,
	readInstalledManifestVersion,
	runSmokeLive,
} from '../smoke-live.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-smoke-live-'));
const failures = [];

try {
	testNoLogFileIsZeroErrors();
	testErrorAfterReloadCounts();
	testErrorBeforeReloadDoesNotCount();
	testNonErrorLevelsDoNotCount();
	testMalformedLinesAreSkippedNotCrashed();
	testWithoutMarkerCountsEveryError();
	testErrorsOfOtherVersionsDoNotCount();
	testRunSmokeLiveIgnoresErrorsOfOlderVersionsAfterAStaleMarker();
	testErrorsBeforeTheLastLoadOfTheSameVersionDoNotCount();
	testLoadSuccessAfterTheErrorIsNotACutoff();
	testRunSmokeLiveExitsRedOnInjectedError();
	testRunSmokeLiveStaysGreenWithoutNewErrors();
	testCliUnavailableFailsClosed();
	testMalformedEvidenceFailsClosed();
	testArgumentParsing();
	testVersionMismatchIsDetected();
	testMatchingVersionsAreNotAMismatch();
	testMissingManifestFailsClosed();
	testMissingRuntimeFailsClosed();
	testReadsLoadedCoreState();
	testCliExitFailsWithoutRuntime();
	testReadInstalledManifestVersionReadsTheFile();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`smoke live suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('smoke live suite: PASS\n');
}

function testNoLogFileIsZeroErrors() {
	const pluginDir = freshPluginDir('no-log');
	assert(readErrorsSinceReload(pluginDir).length === 0, 'a plugin directory with no log reported errors');
}

/** The exact case the lote asks for: inject one error line after reload and see it counted. */
function testErrorAfterReloadCounts() {
	const pluginDir = freshPluginDir('error-after-reload');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	writeLog(pluginDir, [
		record({ level: 'info', timestampUtc: '2026-01-01T00:00:01.000Z' }),
		record({ level: 'error', timestampUtc: '2026-01-01T00:00:00.000Z' }),
		record({ level: 'error', timestampUtc: '2026-01-01T00:00:02.000Z' }),
	]);
	const errors = readErrorsSinceReload(pluginDir);
	assert(errors.length === 2, `expected exactly 2 errors from reload start inclusive, got ${String(errors.length)}`);
}

function testErrorBeforeReloadDoesNotCount() {
	const pluginDir = freshPluginDir('error-before-reload');
	writeMarker(pluginDir, '2026-01-01T00:00:05.000Z');
	writeLog(pluginDir, [record({ level: 'error', timestampUtc: '2026-01-01T00:00:01.000Z' })]);
	assert(readErrorsSinceReload(pluginDir).length === 0, 'an error logged before the reload marker was counted as new');
}

function testNonErrorLevelsDoNotCount() {
	const pluginDir = freshPluginDir('non-error-levels');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	writeLog(pluginDir, [
		record({ level: 'warn', timestampUtc: '2026-01-01T00:00:01.000Z' }),
		record({ level: 'info', timestampUtc: '2026-01-01T00:00:02.000Z' }),
		record({ level: 'debug', timestampUtc: '2026-01-01T00:00:03.000Z' }),
	]);
	assert(readErrorsSinceReload(pluginDir).length === 0, 'a warn/info/debug line was counted as an error');
}

function testMalformedLinesAreSkippedNotCrashed() {
	const pluginDir = freshPluginDir('malformed-lines');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	mkdirSync(resolve(pluginDir, 'logs'), { recursive: true });
	writeFileSync(
		resolve(pluginDir, 'logs', 'debug.jsonl'),
		`not json\n${JSON.stringify(record({ level: 'error', timestampUtc: '2026-01-01T00:00:01.000Z' }))}\n`,
	);
	const errors = readErrorsSinceReload(pluginDir);
	assert(errors.length === 1, `a malformed line crashed the read instead of being skipped (got ${String(errors.length)})`);
}

function testWithoutMarkerCountsEveryError() {
	const pluginDir = freshPluginDir('no-marker');
	writeLog(pluginDir, [record({ level: 'error', timestampUtc: '2020-01-01T00:00:00.000Z' })]);
	assert(readErrorsSinceReload(pluginDir).length === 1, 'a log with no reload marker did not count its error');
}

/** RT-07: BRAT leaves the marker at the last dev reload; errors of older versions written after it are not this load's. */
function testErrorsOfOtherVersionsDoNotCount() {
	const pluginDir = freshPluginDir('other-versions');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	writeLog(pluginDir, [
		{ ...record({ level: 'error', timestampUtc: '2026-02-01T00:00:00.000Z' }), pluginVersion: '0.2.20' },
		{ ...record({ level: 'error', timestampUtc: '2026-02-02T00:00:00.000Z' }), pluginVersion: '0.6.35' },
		{ ...record({ level: 'error', timestampUtc: '2026-02-03T00:00:00.000Z' }), pluginVersion: undefined },
	]);
	assert(readErrorsSinceReload(pluginDir, '0.6.35').length === 1, 'errors of other plugin versions were counted for the loaded one');
	assert(readErrorsSinceReload(pluginDir).length === 3, 'without a loaded version every error since the marker must still count');
}

function testRunSmokeLiveIgnoresErrorsOfOlderVersionsAfterAStaleMarker() {
	const pluginDir = freshPluginDir('stale-marker');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	writeLog(pluginDir, [{ ...record({ level: 'error', timestampUtc: '2026-02-01T00:00:00.000Z' }), pluginVersion: '0.2.20' }]);
	const stale = runSmokeLive({ pluginDir, runCli: fakeCli({ loadedVersion: '0.1.30' }) });
	assert(stale.newErrorCount === 0, 'an error of an older version turned smoke:live red after a stale marker');
	writeLog(pluginDir, [{ ...record({ level: 'error', timestampUtc: '2026-02-01T00:00:00.000Z' }), pluginVersion: '0.1.30' }]);
	const own = runSmokeLive({ pluginDir, runCli: fakeCli({ loadedVersion: '0.1.30' }) });
	assert(own.newErrorCount === 1, 'an error of the loaded version was not counted');
}

/** RT-07 (D3): the same version started twice; what the first start logged is not the second's. */
function testErrorsBeforeTheLastLoadOfTheSameVersionDoNotCount() {
	const pluginDir = freshPluginDir('same-version-restart');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	const load = (timestampUtc) => ({ ...record({ level: 'info', timestampUtc }), action: 'plugin_load', phase: 'start' });
	const error = (timestampUtc) => ({ ...record({ level: 'error', timestampUtc }), action: 'view_render' });
	writeLog(pluginDir, [
		load('2026-02-01T00:00:00.000Z'), error('2026-02-01T00:00:05.000Z'),
		load('2026-02-02T00:00:00.000Z'), error('2026-02-02T00:00:05.000Z'),
	]);
	assert(readErrorsSinceReload(pluginDir, '0.1.30').length === 1, 'an error of an earlier start of the same version was counted');
	const result = runSmokeLive({ pluginDir, runCli: fakeCli({ loadedVersion: '0.1.30' }) });
	assert(result.newErrorCount === 1, `runSmokeLive counted ${String(result.newErrorCount)} errors, expected the 1 of the last start`);
	writeLog(pluginDir, [load('2026-02-01T00:00:00.000Z'), error('2026-02-01T00:00:05.000Z')]);
	assert(readErrorsSinceReload(pluginDir, '0.1.30').length === 1, 'an error after the only load of the version was not counted');
}

/** Below `debug` there is no `start` line; the `success` that closes a load comes AFTER the errors of that start. */
function testLoadSuccessAfterTheErrorIsNotACutoff() {
	const pluginDir = freshPluginDir('success-is-not-a-cutoff');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	writeLog(pluginDir, [
		{ ...record({ level: 'error', timestampUtc: '2026-02-01T10:00:01.000Z' }), action: 'view_render' },
		{ ...record({ level: 'info', timestampUtc: '2026-02-01T10:00:02.000Z' }), action: 'plugin_load', phase: 'success' },
	]);
	assert(readErrorsSinceReload(pluginDir, '0.1.30').length === 1, 'a plugin_load success written after an error hid that error');
}

/** The end-to-end case the lote names: `smoke:live` must exit 1 when the injected line is there. */
function testRunSmokeLiveExitsRedOnInjectedError() {
	const pluginDir = freshPluginDir('exit-red');
	writeMarker(pluginDir, '2026-01-01T00:00:00.000Z');
	writeLog(pluginDir, [record({ level: 'error', timestampUtc: '2026-01-01T00:00:01.000Z' })]);
	const result = runSmokeLive({ pluginDir, runCli: fakeCli({ loadedVersion: '0.1.30', runtimeReady: true }) });
	assert(result.newErrorCount === 1, `expected newErrorCount 1, got ${String(result.newErrorCount)}`);
	assert(result.loadedVersion === '0.1.30', 'the loaded version from the CLI evidence was not surfaced');
	assert(result.runtimeReady === true, 'runtimeReady from the CLI evidence was not surfaced');
}

function testRunSmokeLiveStaysGreenWithoutNewErrors() {
	const pluginDir = freshPluginDir('exit-green');
	writeMarker(pluginDir, '2026-01-01T00:00:05.000Z');
	writeLog(pluginDir, [record({ level: 'error', timestampUtc: '2026-01-01T00:00:01.000Z' })]);
	const result = runSmokeLive({ pluginDir, runCli: fakeCli({}) });
	assert(result.newErrorCount === 0, 'an error logged before the reload marker turned smoke:live red');
}

function testCliUnavailableFailsClosed() {
	const pluginDir = freshPluginDir('cli-unavailable');
	assertThrowsCode(
		() => runSmokeLive({ pluginDir, runCli: () => ({ status: 1, stdout: '' }) }),
		'cli-unavailable',
		'a failed obsidian CLI invocation did not fail closed',
	);
}

function testMalformedEvidenceFailsClosed() {
	const pluginDir = freshPluginDir('malformed-evidence');
	assertThrowsCode(
		() => runSmokeLive({ pluginDir, runCli: () => ({ status: 0, stdout: 'garbage, no prefix here' }) }),
		'evidence-invalid',
		'malformed CLI stdout was accepted as evidence',
	);
}

function testArgumentParsing() {
	const withFlags = withEnvironment(
		{ TC_PLUGIN_DIR: undefined },
		() => parseSmokeLiveArguments(['--plugin-dir', '/tmp/x', '--obsidian-cli', '/tmp/fake-obsidian']),
	);
	assert(withFlags.pluginDir === resolve('/tmp/x'), 'a --plugin-dir flag was not honoured');
	assert(withFlags.cliCommand === '/tmp/fake-obsidian', 'a --obsidian-cli flag was not honoured');

	const defaulted = withEnvironment({ TC_PLUGIN_DIR: '/tmp/from-env' }, () => parseSmokeLiveArguments([]));
	assert(defaulted.pluginDir === resolve('/tmp/from-env'), 'TC_PLUGIN_DIR was not honoured when no flag is given');
	assert(defaulted.cliCommand === 'obsidian', 'the obsidian CLI command did not default to "obsidian"');

	// RT-08: with neither flag nor env var there is no vault to fall back on.
	assertThrowsCode(() => withEnvironment({ TC_PLUGIN_DIR: undefined }, () => parseSmokeLiveArguments([])), 'plugin-dir-required', 'a run without a vault fell back to a default one');
	assertThrowsCode(() => withEnvironment({ TC_PLUGIN_DIR: '' }, () => parseSmokeLiveArguments([])), 'plugin-dir-required', 'an empty TC_PLUGIN_DIR was accepted as a vault');

	assertThrowsCode(() => parseSmokeLiveArguments(['--unknown']), 'usage', 'an unknown flag was silently accepted');
	assertThrowsCode(() => parseSmokeLiveArguments(['--plugin-dir']), 'usage', 'a --plugin-dir without a value was accepted');
}

/**
 * H15.27: the case `dev-install.mjs`'s missing `loadManifests()` caused — the just-copied
 * `manifest.json` says one version, but the running plugin (`loadedVersion`, from the CLI
 * evidence) still reports the old one. Before this lote, `smoke:live` only printed both numbers
 * side by side and stayed green regardless.
 */
function testVersionMismatchIsDetected() {
	const pluginDir = freshPluginDir('version-mismatch');
	writeManifest(pluginDir, '0.1.35');
	const result = runSmokeLive({ pluginDir, runCli: fakeCli({ loadedVersion: '0.1.34' }) });
	assert(result.versionMismatch === true, 'a manifest/loaded version divergence was not flagged');
	assert(result.manifestVersion === '0.1.35', 'the installed manifest version was not surfaced');
}

function testMatchingVersionsAreNotAMismatch() {
	const pluginDir = freshPluginDir('version-match');
	writeManifest(pluginDir, '0.1.35');
	const result = runSmokeLive({ pluginDir, runCli: fakeCli({ loadedVersion: '0.1.35' }) });
	assert(result.versionMismatch === false, 'matching manifest and loaded versions were flagged as a mismatch');
}

/** Without the installed manifest, smoke cannot verify the loaded plugin and must reject. */
function testMissingManifestFailsClosed() {
	const pluginDir = freshPluginDir('version-no-manifest');
	rmSync(resolve(pluginDir, 'manifest.json'));
	assertThrowsCode(() => runSmokeLive({ pluginDir, runCli: fakeCli({}) }), 'manifest-invalid', 'missing disk manifest passed smoke');
}

function testMissingRuntimeFailsClosed() {
	const cases = [
		[{ loadedVersion: null }, 'plugin-not-loaded'],
		[{ enabled: false }, 'plugin-not-enabled'],
		[{ registeredVersion: null }, 'plugin-not-registered'],
		[{ runtimeReady: null }, 'runtime-not-ready'],
		[{ runtimeReady: false }, 'runtime-not-ready'],
		[{ connection: null }, 'runtime-state-unavailable'],
		[{ vaultPath: testRoot }, 'runtime-vault-mismatch'],
	];
	for (const [evidence, code] of cases) {
		const pluginDir = freshPluginDir(`missing-${code}-${String(evidence.runtimeReady)}`);
		assertThrowsCode(() => runSmokeLive({ pluginDir, runCli: fakeCli(evidence) }), code, `missing effective ${code} passed smoke`);
	}
}

function testReadsLoadedCoreState() {
	const pluginDir = freshPluginDir('core-state');
	const core = { runtimeReady: true, getConnectionState: () => ({ status: 'idle' }), alertIngameServerPort: 12345 };
	const app = { vault: { adapter: { getBasePath: () => resolve(pluginDir, '..', '..', '..') } }, plugins: {
		enabledPlugins: new Set(['tyrian-companion']), manifests: { 'tyrian-companion': { version: '0.1.30' } },
		plugins: { 'tyrian-companion': { manifest: { version: '0.1.30' }, core } },
	} };
	const result = runSmokeLive({ pluginDir, runCli: ({ args }) => ({ status: 0,
		stdout: runInNewContext(args[1].slice('code='.length), { app }) }) });
	assert(result.runtimeReady === true && result.connection?.status === 'idle' && result.ingamePort === 12345,
		'smoke did not read readiness, connection and port from the loaded wrapper core');
}

function testCliExitFailsWithoutRuntime() {
	const pluginDir = freshPluginDir('cli-runtime-missing');
	const cliPath = resolve(testRoot, 'fake-obsidian.mjs');
	writeFileSync(cliPath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(fakeCli({ runtimeReady: null })({ cwd: resolve(pluginDir, '..', '..', '..') }).stdout)});\n`);
	chmodSync(cliPath, 0o755);
	const result = spawnSync(process.execPath, [resolve('scripts/smoke-live.mjs'), '--plugin-dir', pluginDir,
		'--obsidian-cli', cliPath], { encoding: 'utf8' });
	assert(result.status === 1 && result.stderr.includes('runtime-not-ready'),
		`smoke CLI did not report the missing runtime (exit=${String(result.status)}; stdout=${String(result.stdout)}; stderr=${String(result.stderr)}; error=${String(result.error?.code)})`);
}

function testReadInstalledManifestVersionReadsTheFile() {
	const pluginDir = freshPluginDir('read-manifest-version');
	writeManifest(pluginDir, '0.1.36');
	assert(readInstalledManifestVersion(pluginDir) === '0.1.36', 'readInstalledManifestVersion did not read the version field');
	assert(readInstalledManifestVersion(join(testRoot, 'does-not-exist')) === null, 'a missing plugin directory did not return null');
}

function writeManifest(pluginDir, version) {
	writeFileSync(resolve(pluginDir, 'manifest.json'), JSON.stringify({ id: 'tyrian-companion', version }));
}

function fakeCli(evidenceOverrides) {
	return ({ cwd }) => ({
		status: 0,
		stdout: `TYRIAN_SMOKE_V1\t${JSON.stringify({
			schema: 1,
			vaultPath: cwd,
			enabled: true,
			registeredVersion: evidenceOverrides.loadedVersion ?? '0.1.30',
			loadedVersion: '0.1.30',
			runtimeReady: true,
			connection: { status: 'idle' },
			ingamePort: null,
			...evidenceOverrides,
		})}`,
	});
}

function freshPluginDir(name) {
	const pluginDir = join(testRoot, name);
	mkdirSync(pluginDir, { recursive: true });
	writeManifest(pluginDir, '0.1.30');
	return pluginDir;
}

function writeMarker(pluginDir, iso) {
	writeFileSync(resolve(pluginDir, '.tyrian-dev-reload-at'), `${iso}\n`);
}

function writeLog(pluginDir, records) {
	mkdirSync(resolve(pluginDir, 'logs'), { recursive: true });
	writeFileSync(resolve(pluginDir, 'logs', 'debug.jsonl'), `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function record({ level, timestampUtc }) {
	return {
		schemaVersion: 1,
		timestampUtc,
		sequence: 1,
		pluginVersion: '0.1.30',
		level,
		component: 'plugin',
		action: 'plugin_load',
		phase: 'success',
		code: 'ok',
		actionId: 'a',
		correlationId: 'c',
	};
}

function withEnvironment(overrides, run) {
	const previous = new Map();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function assertThrowsCode(run, expectedCode, message) {
	try {
		run();
	} catch (error) {
		if (error instanceof SmokeLiveError && error.code === expectedCode) return;
		failures.push(`${message} (got: ${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	failures.push(message);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
