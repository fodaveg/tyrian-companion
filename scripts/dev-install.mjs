import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEV_INSTALL_CONTRACT_VERSION = 1;
const PLUGIN_ID = 'tyrian-companion';
const MANAGED_FILES = Object.freeze(['manifest.json', 'main.js', 'styles.css']);
const DEFAULT_CONFIG_DIRECTORY = ['.', 'obsidian'].join('');
/** Written next to the installed plugin right after a real reload; `smoke-live.mjs` reads it back as "arranque". */
export const DEV_RELOAD_MARKER = '.tyrian-dev-reload-at';

export class DevInstallError extends Error {
	constructor(code) {
		super(`dev install: ${code}`);
		this.name = 'DevInstallError';
		this.code = code;
	}
}

/**
 * The vault this machine actually uses. `~/Documentos` on this Linux box,
 * `~/Documents` on macOS (Obsidian's own vault-relative name for the folder,
 * not a translated one); overridden by `TC_PLUGIN_DIR` or `--plugin-dir` for
 * every other vault, including every one of THIS script's own tests.
 */
export function defaultPluginDir() {
	const documentsDirectoryName = process.platform === 'darwin' ? 'Documents' : 'Documentos';
	return resolve(homedir(), documentsDirectoryName, 'fodaveg', DEFAULT_CONFIG_DIRECTORY, 'plugins', PLUGIN_ID);
}

export function parseDevInstallArguments(argv) {
	if (!Array.isArray(argv)) fail('usage');
	let pluginDir = null;
	let pluginDirSet = false;
	let reload = true;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--no-reload') {
			reload = false;
			continue;
		}
		if (argument === '--plugin-dir' && index + 1 < argv.length) {
			const value = argv[index + 1];
			if (value.startsWith('--')) fail('usage');
			if (pluginDirSet) fail('usage');
			pluginDir = value;
			pluginDirSet = true;
			index += 1;
			continue;
		}
		fail('usage');
	}
	if (!pluginDirSet) pluginDir = process.env.TC_PLUGIN_DIR ?? defaultPluginDir();
	return Object.freeze({ pluginDir: resolve(pluginDir), reload });
}

/**
 * Builds production once, copies the three managed files over `/bin/cp -f`
 * (never bare `cp`: it is aliased to `cp -i` on this machine and silently
 * refuses to overwrite), verifies the copy by SHA-256, and — unless
 * `reload` is false — cycles the plugin through Obsidian's own CLI so the
 * running instance picks the new build up without a manual toggle.
 */
export function installDevBuild({
	pluginDir,
	reload = true,
	sourceDir = process.cwd(),
	buildProduction = runProductionBuild,
	copyFile = copyManagedFile,
	runCli = runObsidianCli,
	cliCommand = 'obsidian',
} = {}) {
	if (typeof pluginDir !== 'string' || pluginDir.length === 0) fail('invalid-arguments');
	ensurePluginDirectory(pluginDir);
	buildProduction(sourceDir);
	const files = [];
	for (const name of MANAGED_FILES) {
		const source = resolve(sourceDir, name);
		requireRegularFile(source, 'source-file-missing');
		const destination = resolve(pluginDir, name);
		copyFile(source, destination);
		requireRegularFile(destination, 'copy-missing');
		const sourceDigest = sha256(readFileSync(source));
		const destinationDigest = sha256(readFileSync(destination));
		if (sourceDigest !== destinationDigest) fail('copy-verification-failed');
		files.push(name);
	}
	let reloaded = false;
	if (reload) {
		const vaultRoot = vaultRootOf(pluginDir);
		reloadPlugin(runCli, cliCommand, vaultRoot);
		writeFileSync(resolve(pluginDir, DEV_RELOAD_MARKER), new Date().toISOString());
		reloaded = true;
	}
	return Object.freeze({ files: Object.freeze(files), pluginDir, reloaded });
}

function reloadPlugin(runCli, cliCommand, vaultRoot) {
	for (const code of [`app.plugins.disablePlugin("${PLUGIN_ID}")`, `app.plugins.enablePlugin("${PLUGIN_ID}")`]) {
		const result = runCli({ args: ['eval', `code=${code}`], cliCommand, cwd: vaultRoot });
		if (!isRecord(result) || result.status !== 0) fail('reload-failed');
	}
}

/** `pluginDir` is always `<vault>/<configDir>/plugins/tyrian-companion`; walk back up three levels. */
function vaultRootOf(pluginDir) {
	return dirname(dirname(dirname(pluginDir)));
}

function runObsidianCli({ args, cliCommand, cwd }) {
	return spawnSync(cliCommand, args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true });
}

function runProductionBuild(sourceDir) {
	const result = spawnSync(process.execPath, ['esbuild.config.mjs', 'production'], {
		cwd: sourceDir,
		stdio: 'inherit',
	});
	if (result.status !== 0) fail('build-failed');
}

function copyManagedFile(source, destination) {
	const result = spawnSync('/bin/cp', ['-f', source, destination], { encoding: 'utf8' });
	if (result.status !== 0) fail('copy-failed');
}

function ensurePluginDirectory(pluginDir) {
	if (existsSync(pluginDir)) {
		const status = lstatSync(pluginDir);
		if (!status.isDirectory() || status.isSymbolicLink()) fail('plugin-directory-invalid');
		return;
	}
	mkdirSync(pluginDir, { recursive: true });
}

function requireRegularFile(path, code) {
	if (!existsSync(path)) fail(code);
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink() || status.size === 0) fail(code);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code) {
	throw new DevInstallError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	const started = Date.now();
	try {
		const args = parseDevInstallArguments(process.argv.slice(2));
		const result = installDevBuild(args);
		const elapsedMs = Date.now() - started;
		process.stdout.write(
			`dev install v${String(DEV_INSTALL_CONTRACT_VERSION)}: PASS (files=${result.files.join(',')}; ` +
				`reloaded=${String(result.reloaded)}; plugin-dir=${result.pluginDir}; ${String(elapsedMs)} ms)\n`,
		);
	} catch (error) {
		const code = error instanceof DevInstallError ? error.code : 'unexpected-failure';
		process.stderr.write(`dev install: ${code}\n`);
		process.exitCode = 1;
	}
}
