import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * RT-09 level 1: is what Hebra has INSTALLED for Tyrian Companion the bytes of the GitHub release?
 *
 * It reads `<plugins>/installed.json` (Hebra's per-device registry) and the three files under
 * `<plugins>/tyrian-companion/<version>/`, and compares their sha256 with the registry and with the
 * `digest` of `gh release view <version> --json assets`. It never opens Hebra, never writes, and says
 * nothing about whether the plugin LOADED: that needs Hebra to expose its state (RT-09 level 2).
 */
export const HEBRA_INSTALL_CONTRACT_VERSION = 1;

const PLUGIN_ID = 'tyrian-companion';
const HEBRA_FILES = ['hebra.json', 'hebra-main.mjs', 'hebra-styles.css'];
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
/** Hebra itself refuses a registry larger than this (`plugin_store.rs`, `MAX_REGISTRY_BYTES`). */
const MAX_REGISTRY_BYTES = 1024 * 1024;
const HEBRA_APP_ID = 'net.fodaveg.hebra';

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
export function defaultHebraPluginsDirectory(platform = process.platform, home = homedir()) {
	if (platform === 'darwin') return resolve(home, 'Library', 'Application Support', HEBRA_APP_ID, 'plugins');
	if (platform === 'linux') return resolve(home, '.local', 'share', HEBRA_APP_ID, 'plugins');
	return null;
}

/** Fails unless the installed registry entry, its files and the release agree byte for byte. */
export function verifyHebraInstall({
	ghCommand = 'gh',
	pluginsDir,
	readReleaseAssets = readGhReleaseAssets,
	releaseCheck = true,
	releaseTag = null,
} = {}) {
	if (
		typeof pluginsDir !== 'string' || pluginsDir.length === 0 || typeof readReleaseAssets !== 'function' ||
		typeof ghCommand !== 'string' || ghCommand.length === 0 || typeof releaseCheck !== 'boolean' ||
		(releaseTag !== null && (typeof releaseTag !== 'string' || !SEMVER.test(releaseTag)))
	) fail('invalid-arguments');
	const root = requireDirectory(resolve(pluginsDir), 'plugins-dir-missing');
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
	for (const name of HEBRA_FILES) {
		// Hebra writes `sha256:<hex>`; a bare hex digest is read the same way.
		const declared = record.files[name];
		if (typeof declared !== 'string' || declared.replace(/^sha256:/u, '') !== actual[name]) fail('registry-hash-mismatch');
	}
	if (releaseCheck) verifyAgainstRelease(actual, readReleaseAssets({ ghCommand, tag: releaseTag ?? record.version }));
	return Object.freeze({
		version: record.version,
		previous: record.previous,
		releaseChecked: releaseCheck,
		files: Object.freeze({ ...actual }),
	});
}

export function parseHebraInstallArguments(argv, { platform = process.platform, home = homedir() } = {}) {
	if (!Array.isArray(argv)) fail('usage');
	let pluginsDir = null;
	let ghCommand = 'gh';
	let ghSet = false;
	let releaseTag = null;
	let releaseCheck = true;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--no-release-check' && releaseCheck) {
			releaseCheck = false;
			continue;
		}
		if ((argument === '--plugins-dir' || argument === '--gh-cli' || argument === '--release-tag') && index + 1 < argv.length) {
			const value = argv[index + 1];
			if (value.startsWith('--')) fail('usage');
			if (argument === '--plugins-dir' && pluginsDir === null) pluginsDir = value;
			else if (argument === '--gh-cli' && !ghSet) {
				ghCommand = value;
				ghSet = true;
			} else if (argument === '--release-tag' && releaseTag === null) releaseTag = value;
			else fail('usage');
			index += 1;
			continue;
		}
		fail('usage');
	}
	if (!releaseCheck && (releaseTag !== null || ghSet)) fail('usage');
	if (pluginsDir === null) pluginsDir = defaultHebraPluginsDirectory(platform, home);
	if (pluginsDir === null) fail('plugins-dir-required');
	return Object.freeze({ ghCommand, pluginsDir: resolve(pluginsDir), releaseCheck, releaseTag });
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
	const result = spawnSync(ghCommand, ['release', 'view', tag, '--json', 'assets'], {
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
		process.stdout.write(
			`hebra install v${String(HEBRA_INSTALL_CONTRACT_VERSION)}: PASS (version=${result.version}; previous=${result.previous ?? 'none'}; release-bytes=${result.releaseChecked ? 'match' : 'not-checked'}; carga: no comprobada)\n`,
		);
	} catch (error) {
		const code = error instanceof HebraInstallError ? error.code : 'unexpected-failure';
		process.stderr.write(`hebra install: ${code}\n${code === 'plugins-dir-required' ? 'Indica el directorio con --plugins-dir <datos de Hebra>/plugins. No hay ruta por defecto en esta plataforma.\n' : ''}`);
		process.exitCode = 1;
	}
}
