import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * RT-09. Level 1: is what Hebra has INSTALLED for Tyrian Companion the bytes of the GitHub release?
 *
 * It reads `<plugins>/installed.json` (Hebra's per-device registry) and the three files under
 * `<plugins>/tyrian-companion/<version>/`, and compares their sha256 with the registry and with the
 * `digest` of `gh release view <version> --json assets`. It never opens Hebra and never writes.
 *
 * Level 2 (separate verdict, `load`): did Hebra LOAD the plugin? It reads the load events Hebra writes to its
 * `diagnostico.jsonl` (`plugins.activated` / `plugins.load-failed`, id `tyrian-companion`) in the most recent
 * session. Hebra's diagnostic log is OFF by default, so no events means `no-data`, never "did not load".
 * Only the `session` of any line and the fields of the tyrian-companion plugin events are read or printed.
 */
export const HEBRA_INSTALL_CONTRACT_VERSION = 2;

const PLUGIN_ID = 'tyrian-companion';
const HEBRA_FILES = ['hebra.json', 'hebra-main.mjs', 'hebra-styles.css'];
/**
 * What `installed.json` records per file: Hebra's `record.files` IS `manifest.files`, and a manifest cannot
 * contain its own hash, so `hebra.json` is not in it. `hebra.json` is checked against the release only.
 */
const REGISTRY_HASHED_FILES = ['hebra-main.mjs', 'hebra-styles.css'];
/** `gh` runs from any directory (an unpacked CI artifact has no git repo), so the repository is always named. */
const RELEASE_REPOSITORY = 'fodaveg/tyrian-companion';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
/** Hebra itself refuses a registry larger than this (`plugin_store.rs`, `MAX_REGISTRY_BYTES`). */
const MAX_REGISTRY_BYTES = 1024 * 1024;
const HEBRA_APP_ID = 'net.fodaveg.hebra';
const DIAGNOSTICS_FILE_NAME = 'diagnostico.jsonl';
/**
 * The diagnostics log is append-only and can grow: only the last 4 MiB of EACH file (rotated and live) are read.
 * Hebra rotates at 4 MiB, so a file is at most that size plus one batch and the cap rarely cuts; when it does,
 * the partial first line is dropped, not counted as malformed.
 */
export const MAX_DIAGNOSTICS_BYTES = 4 * 1024 * 1024;
const LOAD_EVENTS = Object.freeze(['plugins.activated', 'plugins.load-failed']);
/** Values taken from the log are echoed to a terminal: only this shape is kept, anything else prints as `?`. */
const SAFE_TOKEN = /^[A-Za-z0-9._+-]{1,64}$/u;

export class HebraInstallError extends Error {
	constructor(code) {
		super(`hebra install: ${code}`);
		this.name = 'HebraInstallError';
		this.code = code;
	}
}

/**
 * Where Hebra keeps its plugins on macOS and Linux, per `docs/SPEC-PLUGINS-EXTERNOS.md` of Hebra
 * (a stated assumption there, and macOS may add a profile such as `fresh-v1`: pass `--plugins-dir`
 * when the registry lives elsewhere). Windows has no default on purpose: it is not guessed.
 */
export function defaultHebraPluginsDirectory(platform = process.platform, home = homedir(), xdgDataHome = process.env.XDG_DATA_HOME) {
	// Assumed, not measured here: the sandbox container of the App Store build with the `fresh-v1` profile
	// (`docs/audit/2026-10-10-evidencia-runtime.md`, RT-01; Hebra's `product_storage.rs` adds `fresh-v1`).
	if (platform === 'darwin') {
		return resolve(home, 'Library', 'Containers', HEBRA_APP_ID, 'Data', 'Library', 'Application Support', HEBRA_APP_ID, 'fresh-v1', 'plugins');
	}
	if (platform === 'linux') {
		const dataHome = typeof xdgDataHome === 'string' && isAbsolute(xdgDataHome) ? xdgDataHome : resolve(home, '.local', 'share');
		return resolve(dataHome, HEBRA_APP_ID, 'plugins');
	}
	return null;
}

/**
 * Where Hebra writes `diagnostico.jsonl`. Only Linux is known (`<data>/net.fodaveg.hebra/diagnostico.jsonl`, next to
 * `plugins/`); macOS and Windows return null on purpose: pass `--diagnostics-file`.
 */
export function defaultHebraDiagnosticsFile(platform = process.platform, home = homedir(), xdgDataHome = process.env.XDG_DATA_HOME) {
	const plugins = platform === 'linux' ? defaultHebraPluginsDirectory(platform, home, xdgDataHome) : null;
	return plugins === null ? null : resolve(dirname(plugins), DIAGNOSTICS_FILE_NAME);
}

/**
 * Level 2 verdict from the text of the log. `installedVersion` is the version in Hebra's registry.
 *  - `loaded`: the last tyrian-companion load event of the judged session is `plugins.activated` of that version.
 *  - `version-mismatch`: it is `plugins.activated`, but of another version than the installed one.
 *  - `failed`: it is `plugins.load-failed` (stage, code, incompatibility and errorName are reported).
 *  - `no-data`: no file, empty, no `plugins.*` event at all, or the judged session has no tyrian-companion
 *    event. NOT a failure.
 * Every Hebra webview opens its own log session, but only the main window loads plugins (the editor windows do
 * not), and it records a `plugins.*` event for EVERY plugin it loads (third-party ones as `id: 'otro'`). So the
 * judged session is the one of the LAST `plugins.*` event of any plugin = the latest main-window start. Lines of
 * other sessions (an editor window writing at the end, say) neither choose the session nor erase its events.
 */
export function judgeHebraLoad(text, installedVersion) {
	let malformed = 0;
	let anyEvent = false;
	let pluginsSession = null;
	/** session -> last tyrian-companion load event of that session. */
	const lastBySession = new Map();
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue;
		const entry = parseLine(line);
		if (entry === null) {
			malformed += 1;
			continue;
		}
		anyEvent = true;
		if (typeof entry.event !== 'string' || !entry.event.startsWith('plugins.') || typeof entry.session !== 'string') continue;
		pluginsSession = entry.session;
		if (LOAD_EVENTS.includes(entry.event) && entry.id === PLUGIN_ID) lastBySession.set(entry.session, entry);
	}
	if (pluginsSession === null) return Object.freeze({ status: 'no-data', reason: anyEvent ? 'no-plugin-events' : 'no-events', malformed });
	const last = lastBySession.get(pluginsSession) ?? null;
	if (last === null) return Object.freeze({ status: 'no-data', reason: 'no-tyrian-event-in-latest-plugin-session', malformed });
	if (last.event === 'plugins.load-failed') {
		return Object.freeze({
			status: 'failed', malformed,
			version: token(last.version), stage: token(last.stage), code: token(last.code),
			incompatibility: token(last.incompatibility), errorName: token(last.errorName),
		});
	}
	const version = token(last.version);
	return Object.freeze({ status: version === installedVersion ? 'loaded' : 'version-mismatch', version, installed: installedVersion, malformed });
}

/** Hebra rotates the full log to `<name>.1<ext>` (`diagnostics.rs`: `diagnostico.1.jsonl`); its `read()` is rotated + live. */
export function rotatedDiagnosticsFile(diagnosticsFile) {
	const extension = extname(diagnosticsFile);
	return resolve(dirname(diagnosticsFile), `${basename(diagnosticsFile, extension)}.1${extension}`);
}

/**
 * The last `maxBytes` of one file as text (the partial first line of a cut is dropped, not counted as malformed).
 * `null` when it does not exist; throws when it is not a readable regular file.
 */
function readTail(path, maxBytes) {
	if (!existsSync(path)) return null;
	if (!lstatSync(path).isFile()) throw new Error('not-a-file');
	const fd = openSync(path, 'r');
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const chunk = readSync(fd, buffer, read, length - read, size - length + read);
			if (chunk === 0) break;
			read += chunk;
		}
		const text = buffer.subarray(0, read).toString('utf8');
		if (size <= length) return text;
		const newline = text.indexOf('\n');
		return newline === -1 ? '' : text.slice(newline + 1);
	} finally {
		closeSync(fd);
	}
}

/**
 * Reads the rotated log (if any) and then the live one, in that order, and judges them as one stream. Each file
 * gets its own `maxBytes` tail, so a big live file never pushes out the rotated one. The live file may be absent
 * right after a rotation. It never throws: an unusable file is `no-data`.
 */
export function readHebraLoad({ diagnosticsFile, installedVersion, maxBytes = MAX_DIAGNOSTICS_BYTES }) {
	if (typeof diagnosticsFile !== 'string' || diagnosticsFile.length === 0) return Object.freeze({ status: 'no-data', reason: 'path-unknown', malformed: 0 });
	let rotated;
	let live;
	try {
		live = readTail(diagnosticsFile, maxBytes);
		try {
			rotated = readTail(rotatedDiagnosticsFile(diagnosticsFile), maxBytes);
		} catch {
			// An unusable rotated file only loses older evidence; the live one still decides.
			rotated = null;
		}
	} catch {
		return Object.freeze({ status: 'no-data', reason: 'unreadable', malformed: 0 });
	}
	if (live === null && rotated === null) return Object.freeze({ status: 'no-data', reason: 'file-missing', malformed: 0 });
	const rotatedText = rotated === null || rotated.length === 0 || rotated.endsWith('\n') ? (rotated ?? '') : `${rotated}\n`;
	const text = `${rotatedText}${live ?? ''}`;
	if (text.trim().length === 0) return Object.freeze({ status: 'no-data', reason: 'empty', malformed: 0 });
	return judgeHebraLoad(text, installedVersion);
}

/** `failed` and `version-mismatch` fail the script; `loaded` passes; `no-data` is a warning (Hebra's log is off by default). */
export function loadVerdictFailsInstall(load) {
	return load.status === 'failed' || load.status === 'version-mismatch';
}

/** One line for the PASS/FAIL report, built only from sanitised fields. */
export function describeHebraLoad(load) {
	const skipped = load.malformed > 0 ? `; lineas-ilegibles=${String(load.malformed)}` : '';
	if (load.status === 'loaded') return `carga=loaded (activada ${load.version})${skipped}`;
	if (load.status === 'version-mismatch') return `carga=version-mismatch (activada ${load.version}, instalada ${load.installed})${skipped}`;
	if (load.status === 'failed') return `carga=failed (version=${load.version}; stage=${load.stage}; code=${load.code}; incompatibility=${load.incompatibility}; errorName=${load.errorName})${skipped}`;
	return `carga=no-data (${load.reason}; el registro de diagnostico de Hebra puede estar apagado: actívalo en Ajustes de Hebra o pasa --diagnostics-file <ruta>; no prueba que no cargara)${skipped}`;
}

function parseLine(line) {
	try {
		const value = JSON.parse(line);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function token(value) {
	return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : '?';
}

/** Fails unless the installed registry entry, its files and the release agree byte for byte. */
export function verifyHebraInstall({
	diagnosticsFile = null,
	ghCommand = 'gh',
	loadCheck = true,
	pluginsDir,
	pluginsDirIsDefault = false,
	readReleaseAssets = readGhReleaseAssets,
	releaseCheck = true,
	releaseTag = null,
} = {}) {
	if (
		typeof pluginsDir !== 'string' || pluginsDir.length === 0 || typeof readReleaseAssets !== 'function' ||
		typeof ghCommand !== 'string' || ghCommand.length === 0 || typeof releaseCheck !== 'boolean' ||
		typeof loadCheck !== 'boolean' || (diagnosticsFile !== null && typeof diagnosticsFile !== 'string') ||
		(releaseTag !== null && (typeof releaseTag !== 'string' || !SEMVER.test(releaseTag)))
	) fail('invalid-arguments');
	const root = requireDirectory(resolve(pluginsDir), pluginsDirIsDefault ? 'plugins-dir-default-missing' : 'plugins-dir-missing');
	const registryPath = resolve(root, 'installed.json');
	requireRegularFile(registryPath, 'registry-missing');
	if (lstatSync(registryPath).size > MAX_REGISTRY_BYTES) fail('registry-invalid');
	const record = findRecord(parseJson(readFileSync(registryPath, 'utf8'), 'registry-invalid'));
	const versionDir = requireDirectory(resolve(root, PLUGIN_ID, record.version), 'version-directory-missing');

	const actual = {};
	for (const name of HEBRA_FILES) {
		const path = resolve(versionDir, name);
		requireRegularFile(path, 'installed-file-missing');
		actual[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
	}
	const manifest = parseJson(readFileSync(resolve(versionDir, 'hebra.json'), 'utf8'), 'hebra-manifest-invalid');
	if (!isRecord(manifest) || manifest.version !== record.version) fail('hebra-manifest-version');
	const recorded = Object.keys(record.files).sort();
	if (recorded.length !== REGISTRY_HASHED_FILES.length || !REGISTRY_HASHED_FILES.every((name) => recorded.includes(name))) fail('registry-files-unexpected');
	for (const name of REGISTRY_HASHED_FILES) {
		// Hebra writes `sha256:<hex>`; a bare hex digest is read the same way.
		const declared = record.files[name];
		if (typeof declared !== 'string' || declared.replace(/^sha256:/u, '') !== actual[name]) fail('registry-hash-mismatch');
	}
	// Hebra refuses a record whose `files` differ from its manifest's: so does this.
	const declaredByManifest = isRecord(manifest.files) ? manifest.files : {};
	if (Object.keys(declaredByManifest).length !== recorded.length || !recorded.every((name) => declaredByManifest[name] === record.files[name])) fail('registry-manifest-files-mismatch');
	if (releaseCheck) verifyAgainstRelease(actual, readReleaseAssets({ ghCommand, tag: releaseTag ?? record.version }));
	return Object.freeze({
		version: record.version,
		previous: record.previous,
		releaseChecked: releaseCheck,
		load: loadCheck ? readHebraLoad({ diagnosticsFile, installedVersion: record.version }) : null,
		files: Object.freeze({ ...actual }),
	});
}

export function parseHebraInstallArguments(argv, { platform = process.platform, home = homedir(), xdgDataHome = process.env.XDG_DATA_HOME } = {}) {
	if (!Array.isArray(argv)) fail('usage');
	let pluginsDir = null;
	let ghCommand = 'gh';
	let ghSet = false;
	let releaseTag = null;
	let releaseCheck = true;
	let diagnosticsFile = null;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--no-release-check' && releaseCheck) {
			releaseCheck = false;
			continue;
		}
		if ((argument === '--plugins-dir' || argument === '--gh-cli' || argument === '--release-tag' || argument === '--diagnostics-file') && index + 1 < argv.length) {
			const value = argv[index + 1];
			if (value.startsWith('--')) fail('usage');
			if (argument === '--plugins-dir' && pluginsDir === null) pluginsDir = value;
			else if (argument === '--gh-cli' && !ghSet) {
				ghCommand = value;
				ghSet = true;
			} else if (argument === '--release-tag' && releaseTag === null) releaseTag = value;
			else if (argument === '--diagnostics-file' && diagnosticsFile === null) diagnosticsFile = value;
			else fail('usage');
			index += 1;
			continue;
		}
		fail('usage');
	}
	if (!releaseCheck && (releaseTag !== null || ghSet)) fail('usage');
	const pluginsDirIsDefault = pluginsDir === null;
	if (pluginsDirIsDefault) pluginsDir = defaultHebraPluginsDirectory(platform, home, xdgDataHome);
	if (pluginsDir === null) fail('plugins-dir-required');
	// The default log sits next to the DEFAULT plugins directory only: another --plugins-dir may be another profile.
	if (diagnosticsFile === null && pluginsDirIsDefault) diagnosticsFile = defaultHebraDiagnosticsFile(platform, home, xdgDataHome);
	return Object.freeze({ diagnosticsFile: diagnosticsFile === null ? null : resolve(diagnosticsFile), ghCommand, pluginsDir: resolve(pluginsDir), pluginsDirIsDefault, releaseCheck, releaseTag });
}

function findRecord(registry) {
	if (!isRecord(registry) || registry.schema !== 1 || !Array.isArray(registry.plugins)) fail('registry-invalid');
	const record = registry.plugins.find((candidate) => isRecord(candidate) && candidate.id === PLUGIN_ID);
	if (record === undefined) fail('plugin-not-installed');
	if (typeof record.version !== 'string' || !SEMVER.test(record.version) || !isRecord(record.files)) fail('registry-invalid');
	return {
		version: record.version,
		previous: typeof record.previous === 'string' ? record.previous : null,
		files: record.files,
	};
}

/** `assets` is the raw `gh release view --json assets` text, or the decoded object. */
function verifyAgainstRelease(actual, assets) {
	const decoded = typeof assets === 'string' ? parseJson(assets, 'release-unavailable') : assets;
	if (!isRecord(decoded) || !Array.isArray(decoded.assets)) fail('release-unavailable');
	for (const name of HEBRA_FILES) {
		const asset = decoded.assets.find((candidate) => isRecord(candidate) && candidate.name === name);
		if (asset === undefined) fail('release-asset-missing');
		if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) fail('release-digest-missing');
		if (asset.digest !== `sha256:${actual[name]}`) fail('installed-asset-mismatch');
	}
}

/** `gh release view <tag> --json assets`: the only network call of this script, and read-only. */
function readGhReleaseAssets({ ghCommand, tag }) {
	const result = spawnSync(ghCommand, ['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'assets'], {
		encoding: 'utf8',
		timeout: 30_000,
		windowsHide: true,
	});
	if (!isRecord(result) || result.status !== 0 || typeof result.stdout !== 'string') fail('release-unavailable');
	return result.stdout;
}

function parseJson(source, code) {
	try {
		return JSON.parse(source);
	} catch {
		return fail(code);
	}
}

function requireDirectory(path, code) {
	if (!existsSync(path)) fail(code);
	const status = lstatSync(path);
	if (!status.isDirectory() || status.isSymbolicLink()) fail(code);
	return path;
}

function requireRegularFile(path, code) {
	if (!existsSync(path)) fail(code);
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink() || status.size === 0) fail(code);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code) {
	throw new HebraInstallError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const result = verifyHebraInstall(parseHebraInstallArguments(process.argv.slice(2)));
		const loadFails = loadVerdictFailsInstall(result.load);
		process.stdout.write(
			`hebra install v${String(HEBRA_INSTALL_CONTRACT_VERSION)}: ${loadFails ? 'FAIL' : 'PASS'} (version=${result.version}; previous=${result.previous ?? 'none'}; release-bytes=${result.releaseChecked ? 'match' : 'not-checked'}; ${describeHebraLoad(result.load)})\n`,
		);
		if (loadFails) process.exitCode = 1;
	} catch (error) {
		const code = error instanceof HebraInstallError ? error.code : 'unexpected-failure';
		process.stderr.write(`hebra install: ${code}\n${code === 'plugins-dir-default-missing' ? 'La ruta por defecto es una suposicion (no existe aqui); usa --plugins-dir <datos de Hebra>/plugins.\n' : ''}${code === 'plugins-dir-required' ? 'Indica el directorio con --plugins-dir <datos de Hebra>/plugins. No hay ruta por defecto en esta plataforma.\n' : ''}`);
		process.exitCode = 1;
	}
}
