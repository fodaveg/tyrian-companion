import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEV_INSTALL_CONTRACT_VERSION = 1;
const PLUGIN_ID = 'tyrian-companion';
const MANAGED_FILES = Object.freeze(['manifest.json', 'main.js', 'styles.css']);
const DEFAULT_CONFIG_DIRECTORY = ['.', 'obsidian'].join('');
const RELOAD_EVIDENCE_PREFIX = 'TYRIAN_DEV_RELOAD_V1\t';
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
	let reloadEvidence = null;
	if (reload) {
		const vaultRoot = vaultRootOf(pluginDir);
		const reloadStartedAt = new Date().toISOString();
		const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'manifest.json'), 'utf8'));
		if (!isRecord(manifest) || manifest.id !== PLUGIN_ID || typeof manifest.version !== 'string' || manifest.version.length === 0) fail('manifest-invalid');
		reloadEvidence = reloadPlugin(runCli, cliCommand, vaultRoot, manifest.version);
		// Include errors emitted during startup, not only errors after the reload finished.
		writeFileSync(resolve(pluginDir, DEV_RELOAD_MARKER), reloadStartedAt);
		reloaded = true;
	}
	return Object.freeze({ files: Object.freeze(files), pluginDir, reloaded, reloadEvidence });
}

/**
 * `loadManifests()` goes first (H15.27): without it, `disablePlugin`/`enablePlugin` cycle the
 * already-registered manifest, so Obsidian keeps reporting the version it loaded at startup even
 * though the files on disk (and the copy this same call just verified by SHA-256) are newer.
 * Measured 10 sep: `app.plugins.plugins['tyrian-companion'].manifest.version` still said the old
 * version after a reload; adding this call first is what picked up the new one.
 */
function reloadPlugin(runCli, cliCommand, vaultRoot, version) {
	// Obsidian eval is not a module: top-level await can print Error yet exit zero.
	const expectedVault = realpathSync(vaultRoot);
	const pathExpression = process.platform === 'win32' ? 'vaultPath.toLowerCase()' : 'vaultPath';
	const code = '(async()=>{const vaultPath=app.vault.adapter.getBasePath();' +
		`const evidence=(reloadCompleted=false)=>${JSON.stringify(RELOAD_EVIDENCE_PREFIX)}+JSON.stringify({schema:1,reloadCompleted,` +
		'vaultPath:app.vault.adapter.getBasePath(),communityPluginsEnabled:app.plugins.isEnabled(),' +
		`enabled:app.plugins.enabledPlugins.has("${PLUGIN_ID}"),` +
		`registeredVersion:app.plugins.manifests["${PLUGIN_ID}"]?.version??null,` +
		`loadedVersion:app.plugins.plugins["${PLUGIN_ID}"]?.manifest.version??null});` +
		`if(${pathExpression}!==${JSON.stringify(process.platform === 'win32' ? expectedVault.toLowerCase() : expectedVault)}||!app.plugins.isEnabled())return evidence();` +
		'await app.plugins.loadManifests();' +
		`await app.plugins.disablePlugin("${PLUGIN_ID}");` +
		`await app.plugins.enablePlugin("${PLUGIN_ID}");` +
		'return evidence(true);})()';
	const result = runCli({ args: ['eval', `code=${code}`], cliCommand, cwd: vaultRoot });
	if (!isRecord(result) || result.status !== 0 || typeof result.stdout !== 'string') fail('reload-failed');
	let source = result.stdout.trim();
	try { const decoded = JSON.parse(source); if (typeof decoded === 'string') source = decoded; } catch { /* CLI also prints strings directly. */ }
	const start = source.lastIndexOf(RELOAD_EVIDENCE_PREFIX);
	if (start < 0) fail('reload-failed');
	let evidence;
	try { evidence = JSON.parse(source.slice(start + RELOAD_EVIDENCE_PREFIX.length)); } catch { fail('reload-failed'); }
	if (!isRecord(evidence) || evidence.schema !== 1) fail('reload-failed');
	if (evidence.communityPluginsEnabled === false) fail('plugins-disabled');
	if (evidence.reloadCompleted !== true || evidence.communityPluginsEnabled !== true || evidence.enabled !== true ||
		evidence.registeredVersion !== version || evidence.loadedVersion !== version ||
		typeof evidence.vaultPath !== 'string') fail('reload-failed');
	let actualVault;
	try { actualVault = realpathSync(evidence.vaultPath); } catch { fail('reload-failed'); }
	if ((process.platform === 'win32' ? actualVault.toLowerCase() !== expectedVault.toLowerCase() : actualVault !== expectedVault)) fail('reload-failed');
	return Object.freeze(evidence);
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
				`reloaded=${String(result.reloaded)}; loaded-version=${result.reloadEvidence?.loadedVersion ?? 'not-reloaded'}; ` +
				`plugin-dir=${result.pluginDir}; ${String(elapsedMs)} ms)\n`,
		);
	} catch (error) {
		const code = error instanceof DevInstallError ? error.code : 'unexpected-failure';
		process.stderr.write(`dev install: ${code}\n`);
		process.exitCode = 1;
	}
}
