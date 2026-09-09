import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SMOKE_LIVE_CONTRACT_VERSION = 1;
const PLUGIN_ID = 'tyrian-companion';
const DEFAULT_CONFIG_DIRECTORY = ['.', 'obsidian'].join('');
const EVIDENCE_PREFIX = 'TYRIAN_SMOKE_V1\t';
/** Written by `dev-install.mjs` right after a real reload; the "arranque" the log is scanned since. */
const RELOAD_MARKER = '.tyrian-dev-reload-at';
/**
 * `runtimeReady`, `getConnectionState()` and `alertIngameServerPort` are read
 * straight off the loaded plugin instance. The first two are TypeScript
 * `private` (not `#private`): the compiler forgets, the runtime object does
 * not, and `verify-beta-runtime.mjs` already leans on the same fact for
 * `registeredVersion`/`runtimeVersion`. There is no public accessor for the
 * in-game port yet (`src/main.ts`'s `alertIngameServerPort` field); if that
 * field gets renamed, this expression needs the same rename.
 */
const SMOKE_EVIDENCE_EXPRESSION = `"${EVIDENCE_PREFIX}" + JSON.stringify({` +
	'schema:1,' +
	`loadedVersion:app.plugins.plugins["${PLUGIN_ID}"]?.manifest.version??null,` +
	`runtimeReady:app.plugins.plugins["${PLUGIN_ID}"]?.runtimeReady??null,` +
	`connection:app.plugins.plugins["${PLUGIN_ID}"]?.getConnectionState?.()??null,` +
	`ingamePort:app.plugins.plugins["${PLUGIN_ID}"]?.alertIngameServerPort??null` +
	'})';

export class SmokeLiveError extends Error {
	constructor(code) {
		super(`smoke live: ${code}`);
		this.name = 'SmokeLiveError';
		this.code = code;
	}
}

export function defaultPluginDir() {
	const documentsDirectoryName = process.platform === 'darwin' ? 'Documents' : 'Documentos';
	return resolve(homedir(), documentsDirectoryName, 'fodaveg', DEFAULT_CONFIG_DIRECTORY, 'plugins', PLUGIN_ID);
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
	if (!pluginDirSet) pluginDir = process.env.TC_PLUGIN_DIR ?? defaultPluginDir();
	return Object.freeze({ pluginDir: resolve(pluginDir), cliCommand });
}

/**
 * Reads the live plugin state through `obsidian eval` and counts `level:
 * "error"` lines the plugin itself wrote to `logs/debug.jsonl` after its own
 * last `plugin_load`. ISO-8601 timestamps sort lexically, so the cutoff is a
 * plain string compare, no `Date` parsing needed.
 */
export function runSmokeLive({
	pluginDir,
	cliCommand = 'obsidian',
	runCli = runObsidianCli,
	readNewErrors = readErrorsSinceReload,
} = {}) {
	if (typeof pluginDir !== 'string' || pluginDir.length === 0) fail('invalid-arguments');
	const vaultRoot = dirname(dirname(dirname(pluginDir)));
	const result = runCli({ args: ['eval', `code=${SMOKE_EVIDENCE_EXPRESSION}`], cliCommand, cwd: vaultRoot });
	if (!isRecord(result) || result.status !== 0 || typeof result.stdout !== 'string') fail('cli-unavailable');
	const evidence = parseEvidence(result.stdout);
	const newErrors = readNewErrors(pluginDir);
	return Object.freeze({ ...evidence, newErrorCount: newErrors.length, newErrors: Object.freeze(newErrors) });
}

/** Exported on its own: the exit-1 case only needs a fake log, never a live Obsidian. */
export function readErrorsSinceReload(pluginDir) {
	const logPath = resolve(pluginDir, 'logs', 'debug.jsonl');
	if (!existsSync(logPath)) return [];
	const markerPath = resolve(pluginDir, RELOAD_MARKER);
	const sinceIso = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;
	const errors = [];
	for (const line of readFileSync(logPath, 'utf8').split('\n')) {
		if (line.length === 0) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record) || record.level !== 'error') continue;
		if (sinceIso !== null && typeof record.timestampUtc === 'string' && record.timestampUtc <= sinceIso) continue;
		errors.push(record);
	}
	return errors;
}

function runObsidianCli({ args, cliCommand, cwd }) {
	return spawnSync(cliCommand, args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true });
}

function parseEvidence(stdout) {
	const source = stdout.trim();
	const start = source.lastIndexOf(EVIDENCE_PREFIX);
	if (start < 0) fail('evidence-invalid');
	let evidence;
	try {
		evidence = JSON.parse(source.slice(start + EVIDENCE_PREFIX.length));
	} catch {
		fail('evidence-invalid');
	}
	if (!isRecord(evidence) || evidence.schema !== 1) fail('evidence-invalid');
	return {
		loadedVersion: typeof evidence.loadedVersion === 'string' ? evidence.loadedVersion : null,
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
		process.stdout.write(`runtimeReady: ${String(result.runtimeReady)}\n`);
		process.stdout.write(`conexion: ${JSON.stringify(result.connection)}\n`);
		process.stdout.write(`puerto in-game: ${result.ingamePort ?? 'cerrado'}\n`);
		process.stdout.write(`errores nuevos en el log: ${String(result.newErrorCount)}\n`);
		if (result.newErrorCount > 0) process.exitCode = 1;
	} catch (error) {
		const code = error instanceof SmokeLiveError ? error.code : 'unexpected-failure';
		process.stderr.write(`smoke live: ${code}\n`);
		process.exitCode = 1;
	}
}
