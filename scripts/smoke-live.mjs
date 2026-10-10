import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SMOKE_LIVE_CONTRACT_VERSION = 1;
const PLUGIN_ID = 'tyrian-companion';
const EVIDENCE_PREFIX = 'TYRIAN_SMOKE_V1\t';
/**
 * Written by `dev-install.mjs` right after a real reload; the "arranque" the log is scanned since.
 * BRAT never renews it (RT-07), so on its own it is a cutoff weeks old: `readErrorsSinceReload` also
 * keeps only the lines written by the version that is loaded now.
 */
const RELOAD_MARKER = '.tyrian-dev-reload-at';
/**
 * `runtimeReady`, `getConnectionState()` and `alertIngameServerPort` are read
 * off the loaded plugin's `core` (R1c moved them out of the wrapper). They are TypeScript
 * `private` (not `#private`): the compiler forgets, the runtime object does
 * not, and `verify-beta-runtime.mjs` already leans on the same fact for
 * `registeredVersion`/`runtimeVersion`. There is no public accessor for the
 * in-game port yet (`TyrianCompanionCore.alertIngameServerPort`); if that
 * field gets renamed, this expression needs the same rename.
 */
const SMOKE_EVIDENCE_EXPRESSION = `(()=>{const plugin=app.plugins.plugins["${PLUGIN_ID}"];const core=plugin?.core;` +
	`return ${JSON.stringify(EVIDENCE_PREFIX)} + JSON.stringify({` +
	'schema:1,' +
	'vaultPath:app.vault.adapter.getBasePath(),' +
	`enabled:app.plugins.enabledPlugins.has("${PLUGIN_ID}"),` +
	`registeredVersion:app.plugins.manifests["${PLUGIN_ID}"]?.version??null,` +
	'loadedVersion:plugin?.manifest.version??null,' +
	'runtimeReady:core?.runtimeReady??null,' +
	'connection:core?.getConnectionState?.()??null,' +
	'ingamePort:core?.alertIngameServerPort??null' +
	'});})()';

const PLUGIN_DIR_HINT = 'Indica una boveda desechable: --plugin-dir <boveda>/<configDir>/plugins/tyrian-companion o TC_PLUGIN_DIR. No hay boveda por defecto.\n';

export class SmokeLiveError extends Error {
	constructor(code) {
		super(`smoke live: ${code}`);
		this.name = 'SmokeLiveError';
		this.code = code;
	}
}

export function parseSmokeLiveArguments(argv) {
	if (!Array.isArray(argv)) fail('usage');
	let pluginDir = null;
	let pluginDirSet = false;
	let cliCommand = 'obsidian';
	let cliSet = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if ((argument === '--plugin-dir' || argument === '--obsidian-cli') && index + 1 < argv.length) {
			const value = argv[index + 1];
			if (value.startsWith('--')) fail('usage');
			if (argument === '--plugin-dir') {
				if (pluginDirSet) fail('usage');
				pluginDir = value;
				pluginDirSet = true;
			} else {
				if (cliSet) fail('usage');
				cliCommand = value;
				cliSet = true;
			}
			index += 1;
			continue;
		}
		fail('usage');
	}
	// RT-08: no default vault. A default pointed at the daily-use vault and a bare run rewrote its main.js.
	if (!pluginDirSet) pluginDir = process.env.TC_PLUGIN_DIR ?? null;
	if (typeof pluginDir !== 'string' || pluginDir.length === 0) fail('plugin-dir-required');
	return Object.freeze({ pluginDir: resolve(pluginDir), cliCommand });
}

/**
 * Reads the live plugin state through `obsidian eval` and counts `level:
 * "error"` lines the plugin itself wrote to `logs/debug.jsonl` after its own
 * last `plugin_load`. ISO-8601 timestamps sort lexically, so the cutoff is a
 * plain string compare, no `Date` parsing needed. RT-07: when `loadedVersion` is known only the lines
 * whose `pluginVersion` is that version count, because the marker is only renewed by `dev:install`
 * and a BRAT install leaves it at the last dev reload, with every older version's errors after it.
 *
 * H15.27: also reads the `manifest.json` `dev-install.mjs` just copied to `pluginDir` and compares
 * it against `loadedVersion` (the version Obsidian actually has loaded). Before `dev-install.mjs`
 * called `loadManifests()` on reload, these two could diverge silently — the installed files were
 * newer, but the running plugin kept the old version — and this script only ever printed
 * `loadedVersion`, never checked it against anything, so that divergence stayed green.
 */
export function runSmokeLive({
	pluginDir,
	cliCommand = 'obsidian',
	runCli = runObsidianCli,
	readNewErrors = readErrorsSinceReload,
	readManifestVersion = readInstalledManifestVersion,
} = {}) {
	if (typeof pluginDir !== 'string' || pluginDir.length === 0) fail('invalid-arguments');
	const vaultRoot = dirname(dirname(dirname(pluginDir)));
	const result = runCli({ args: ['eval', `code=${SMOKE_EVIDENCE_EXPRESSION}`], cliCommand, cwd: vaultRoot });
	if (!isRecord(result) || result.status !== 0 || typeof result.stdout !== 'string') fail('cli-unavailable');
	const evidence = parseEvidence(result.stdout);
	let actualVault;
	try { actualVault = realpathSync(evidence.vaultPath); } catch { fail('runtime-vault-mismatch'); }
	const expectedVault = realpathSync(vaultRoot);
	if ((process.platform === 'win32' ? actualVault.toLowerCase() !== expectedVault.toLowerCase() : actualVault !== expectedVault)) fail('runtime-vault-mismatch');
	if (evidence.enabled !== true) fail('plugin-not-enabled');
	if (evidence.loadedVersion === null) fail('plugin-not-loaded');
	if (evidence.registeredVersion === null) fail('plugin-not-registered');
	if (evidence.runtimeReady !== true) fail('runtime-not-ready');
	if (!isRecord(evidence.connection) || typeof evidence.connection.status !== 'string') fail('runtime-state-unavailable');
	const newErrors = readNewErrors(pluginDir, evidence.loadedVersion);
	const manifestVersion = readManifestVersion(pluginDir);
	if (typeof manifestVersion !== 'string' || manifestVersion.length === 0) fail('manifest-invalid');
	const versionMismatch = manifestVersion !== evidence.loadedVersion || manifestVersion !== evidence.registeredVersion;
	return Object.freeze({
		...evidence,
		manifestVersion,
		versionMismatch,
		newErrorCount: newErrors.length,
		newErrors: Object.freeze(newErrors),
	});
}

/** Exported on its own: the exit-1 case only needs a fake log, never a live Obsidian. */
export function readErrorsSinceReload(pluginDir, loadedVersion = null) {
	const logPath = resolve(pluginDir, 'logs', 'debug.jsonl');
	if (!existsSync(logPath)) return [];
	const markerPath = resolve(pluginDir, RELOAD_MARKER);
	const sinceIso = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;
	const records = [];
	for (const line of readFileSync(logPath, 'utf8').split('\n')) {
		if (line.length === 0) continue;
		try {
			const record = JSON.parse(line);
			if (isRecord(record)) records.push(record);
		} catch {
			continue;
		}
	}
	// RT-07: the cutoff is the start of the LAST load of this version, so errors of an earlier start of
	// the same version (a crash fixed by a restart) are not this load's. The marker only raises it.
	let cutoff = sinceIso;
	if (typeof loadedVersion === 'string') {
		const loads = records.filter((record) => record.action === 'plugin_load' && record.pluginVersion === loadedVersion && typeof record.timestampUtc === 'string');
		const starts = loads.filter((record) => record.phase === 'start');
		const last = (starts.length > 0 ? starts : loads).reduce((latest, record) => (latest === null || record.timestampUtc >= latest ? record.timestampUtc : latest), null);
		if (last !== null && (cutoff === null || last > cutoff)) cutoff = last;
	}
	const errors = [];
	for (const record of records) {
		if (record.level !== 'error') continue;
		if (typeof loadedVersion === 'string' && record.pluginVersion !== loadedVersion) continue;
		if (cutoff !== null && typeof record.timestampUtc === 'string' && record.timestampUtc < cutoff) continue;
		errors.push(record);
	}
	return errors;
}

/** Reads the installed version; a missing or invalid manifest leaves smoke without required evidence. */
export function readInstalledManifestVersion(pluginDir) {
	const manifestPath = resolve(pluginDir, 'manifest.json');
	if (!existsSync(manifestPath)) return null;
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch {
		return null;
	}
	return isRecord(manifest) && manifest.id === PLUGIN_ID && typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : null;
}

function runObsidianCli({ args, cliCommand, cwd }) {
	return spawnSync(cliCommand, args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true });
}

function parseEvidence(stdout) {
	let source = stdout.trim();
	try { const decoded = JSON.parse(source); if (typeof decoded === 'string') source = decoded; } catch { /* CLI also prints strings directly. */ }
	const start = source.lastIndexOf(EVIDENCE_PREFIX);
	if (start < 0) fail('evidence-invalid');
	let evidence;
	try {
		evidence = JSON.parse(source.slice(start + EVIDENCE_PREFIX.length));
	} catch {
		fail('evidence-invalid');
	}
	if (!isRecord(evidence) || evidence.schema !== 1 || typeof evidence.vaultPath !== 'string' ||
		typeof evidence.enabled !== 'boolean') fail('evidence-invalid');
	return {
		vaultPath: evidence.vaultPath,
		enabled: evidence.enabled,
		registeredVersion: typeof evidence.registeredVersion === 'string' && evidence.registeredVersion.length > 0 ? evidence.registeredVersion : null,
		loadedVersion: typeof evidence.loadedVersion === 'string' && evidence.loadedVersion.length > 0 ? evidence.loadedVersion : null,
		runtimeReady: typeof evidence.runtimeReady === 'boolean' ? evidence.runtimeReady : null,
		connection: evidence.connection ?? null,
		ingamePort: typeof evidence.ingamePort === 'number' ? evidence.ingamePort : null,
	};
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code) {
	throw new SmokeLiveError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const args = parseSmokeLiveArguments(process.argv.slice(2));
		const result = runSmokeLive(args);
		process.stdout.write(`version cargada: ${result.loadedVersion ?? 'desconocida'}\n`);
		process.stdout.write(`version instalada (manifest.json): ${result.manifestVersion ?? 'desconocida'}\n`);
		process.stdout.write(`runtimeReady: ${String(result.runtimeReady)}\n`);
		process.stdout.write(`conexion: ${JSON.stringify(result.connection)}\n`);
		process.stdout.write(`puerto in-game: ${result.ingamePort ?? 'cerrado'}\n`);
		process.stdout.write(`errores nuevos en el log: ${String(result.newErrorCount)}\n`);
		if (result.versionMismatch) {
			process.stderr.write(
				`smoke live: version-mismatch (cargada=${String(result.loadedVersion)}, manifest=${String(result.manifestVersion)})\n`,
			);
			process.exitCode = 1;
		}
		if (result.newErrorCount > 0) process.exitCode = 1;
	} catch (error) {
		const code = error instanceof SmokeLiveError ? error.code : 'unexpected-failure';
		process.stderr.write(`smoke live: ${code}\n${code === 'plugin-dir-required' ? PLUGIN_DIR_HINT : ''}`);
		process.exitCode = 1;
	}
}
