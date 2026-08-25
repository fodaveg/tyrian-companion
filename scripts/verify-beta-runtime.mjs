import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BETA_RUNTIME_CONTRACT_VERSION = 1;

const DEFAULT_CONFIG_DIRECTORY = ['.', 'obsidian'].join('');
const EVIDENCE_PREFIX = 'TYRIAN_RUNTIME_V1\t';
const PLUGIN_ID = 'tyrian-companion';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RUNTIME_EVIDENCE_EXPRESSION = `"${EVIDENCE_PREFIX}" + JSON.stringify({schema:1,vaultPath:app.vault.adapter.getBasePath(),enabled:app.plugins.enabledPlugins.has("${PLUGIN_ID}"),registeredVersion:app.plugins.manifests["${PLUGIN_ID}"]?.version??null,runtimeVersion:app.plugins.plugins["${PLUGIN_ID}"]?.manifest.version??null})`;

export class BetaRuntimeError extends Error {
	constructor(code) {
		super(`beta runtime: ${code}`);
		this.name = 'BetaRuntimeError';
		this.code = code;
	}
}

/** Fails unless the target vault's installed manifest is the plugin version loaded by Obsidian. */
export function verifyBetaRuntime({
	cliCommand = 'obsidian',
	configDir = DEFAULT_CONFIG_DIRECTORY,
	runCli = runObsidianCli,
	vaultRoot,
} = {}) {
	if (
		typeof vaultRoot !== 'string' || typeof cliCommand !== 'string' || cliCommand.length === 0 ||
		typeof runCli !== 'function' || !isSafeConfigDirectory(configDir)
	) fail('invalid-arguments');
	const vault = requireDirectory(resolve(vaultRoot), 'vault-invalid');
	const pluginRoot = requireDirectory(resolve(vault, configDir, 'plugins', PLUGIN_ID), 'plugin-directory-missing');
	const manifestPath = resolve(pluginRoot, 'manifest.json');
	requireRegularFile(manifestPath, 'manifest-invalid');
	const diskVersion = parseDiskVersion(readFileSync(manifestPath, 'utf8'));
	const result = runCli({
		args: ['eval', `code=${RUNTIME_EVIDENCE_EXPRESSION}`],
		cliCommand,
		cwd: vault,
	});
	if (!isRecord(result) || result.status !== 0 || typeof result.stdout !== 'string') fail('cli-unavailable');
	const evidence = parseRuntimeEvidence(result.stdout);
	if (!samePath(evidence.vaultPath, realpathSync(vault))) fail('runtime-vault-mismatch');
	if (evidence.enabled !== true) fail('plugin-not-enabled');
	if (evidence.runtimeVersion === null) fail('plugin-not-loaded');
	if (evidence.runtimeVersion !== diskVersion) fail('runtime-version-mismatch');
	if (evidence.registeredVersion !== diskVersion) fail('registered-version-mismatch');
	return Object.freeze({
		diskVersion,
		registeredVersion: evidence.registeredVersion,
		runtimeVersion: evidence.runtimeVersion,
	});
}

export function parseBetaRuntimeArguments(argv) {
	if (!Array.isArray(argv)) fail('usage');
	let cliCommand = 'obsidian';
	let cliSet = false;
	let configDir = DEFAULT_CONFIG_DIRECTORY;
	let configSet = false;
	let vaultRoot = null;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if ((argument === '--vault' || argument === '--config-dir' || argument === '--obsidian-cli') && index + 1 < argv.length) {
			const value = argv[index + 1];
			if (value.startsWith('--')) fail('usage');
			if (argument === '--vault' && vaultRoot === null) vaultRoot = value;
			else if (argument === '--config-dir' && !configSet) {
				configDir = value;
				configSet = true;
			} else if (argument === '--obsidian-cli' && !cliSet) {
				cliCommand = value;
				cliSet = true;
			} else fail('usage');
			index += 1;
			continue;
		}
		fail('usage');
	}
	if (vaultRoot === null || !isSafeConfigDirectory(configDir)) fail('usage');
	return Object.freeze({ cliCommand, configDir, vaultRoot });
}

function runObsidianCli({ args, cliCommand, cwd }) {
	return spawnSync(cliCommand, args, {
		cwd,
		encoding: 'utf8',
		timeout: 30_000,
		windowsHide: true,
	});
}

function parseDiskVersion(source) {
	let manifest;
	try {
		manifest = JSON.parse(source);
	} catch {
		fail('manifest-invalid');
	}
	if (!isRecord(manifest) || manifest.id !== PLUGIN_ID || !SEMVER.test(manifest.version)) fail('manifest-invalid');
	return manifest.version;
}

function parseRuntimeEvidence(stdout) {
	let source = stdout.trim();
	try {
		const decoded = JSON.parse(source);
		if (typeof decoded === 'string') source = decoded;
	} catch {
		// Obsidian CLI normally prints string results directly.
	}
	const start = source.lastIndexOf(EVIDENCE_PREFIX);
	if (start < 0) fail('runtime-evidence-invalid');
	let evidence;
	try {
		evidence = JSON.parse(source.slice(start + EVIDENCE_PREFIX.length));
	} catch {
		fail('runtime-evidence-invalid');
	}
	if (
		!isRecord(evidence) || evidence.schema !== 1 || typeof evidence.vaultPath !== 'string' ||
		typeof evidence.enabled !== 'boolean' || !isNullableSemver(evidence.registeredVersion) ||
		!isNullableSemver(evidence.runtimeVersion)
	) fail('runtime-evidence-invalid');
	return evidence;
}

function samePath(actual, expected) {
	let canonical;
	try {
		canonical = realpathSync(actual);
	} catch {
		fail('runtime-vault-mismatch');
	}
	return process.platform === 'win32'
		? canonical.toLowerCase() === expected.toLowerCase()
		: canonical === expected;
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

function isNullableSemver(value) {
	return value === null || (typeof value === 'string' && SEMVER.test(value));
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeConfigDirectory(value) {
	return typeof value === 'string' && value !== '.' && value !== '..' && /^[.A-Za-z0-9_-]+$/u.test(value);
}

function fail(code) {
	throw new BetaRuntimeError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const result = verifyBetaRuntime(parseBetaRuntimeArguments(process.argv.slice(2)));
		process.stdout.write(
			`beta runtime v${String(BETA_RUNTIME_CONTRACT_VERSION)}: PASS (disk=${result.diskVersion}; registered=${result.registeredVersion}; runtime=${result.runtimeVersion})\n`,
		);
	} catch (error) {
		const code = error instanceof BetaRuntimeError ? error.code : 'unexpected-failure';
		process.stderr.write(`beta runtime: ${code}\n`);
		process.exitCode = 1;
	}
}
