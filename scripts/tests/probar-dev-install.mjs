import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { DevInstallError, defaultPluginDir, installDevBuild, parseDevInstallArguments } from '../dev-install.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-dev-install-'));
const failures = [];

try {
	testCopyAndSha256Verification();
	testMissingSourceFile();
	testCorruptedCopyIsCaught();
	testCreatesMissingPluginDirectory();
	await testReloadCyclesLoadManifestsThenDisableThenEnable();
	testExitZeroWithoutEffectiveReloadFailsClosed();
	testReloadFailureStopsBeforeMarker();
	testLoadManifestsFailureStopsBeforeDisable();
	testNoReloadWritesNoMarker();
	testArgumentParsing();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`dev install suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('dev install suite: PASS\n');
}

function testCopyAndSha256Verification() {
	const { sourceDir, pluginDir } = freshFixture('copy-basic');
	const result = installDevBuild({ pluginDir, sourceDir, reload: false, buildProduction: () => undefined });
	assert(!result.reloaded, 'a run with reload:false reported reloaded');
	assert(
		sameStrings(result.files, ['manifest.json', 'main.js', 'styles.css']),
		`unexpected file list: ${result.files.join(',')}`,
	);
	for (const name of result.files) {
		const source = readFileSync(resolve(sourceDir, name));
		const destination = readFileSync(resolve(pluginDir, name));
		assert(sha256(source) === sha256(destination), `${name} was not copied byte-for-byte`);
	}
}

function testMissingSourceFile() {
	const { sourceDir, pluginDir } = freshFixture('missing-source');
	unlinkSync(resolve(sourceDir, 'styles.css'));
	assertThrowsCode(
		() => installDevBuild({ pluginDir, sourceDir, reload: false, buildProduction: () => undefined }),
		'source-file-missing',
		'a missing source file did not fail closed',
	);
}

/** A `copyFile` that writes the wrong bytes must be caught by the SHA-256 check, not trusted. */
function testCorruptedCopyIsCaught() {
	const { sourceDir, pluginDir } = freshFixture('corrupted-copy');
	assertThrowsCode(
		() => installDevBuild({
			pluginDir,
			sourceDir,
			reload: false,
			buildProduction: () => undefined,
			copyFile: (_source, destination) => writeFileSync(destination, 'not the built file'),
		}),
		'copy-verification-failed',
		'a corrupted copy passed SHA-256 verification',
	);
}

function testCreatesMissingPluginDirectory() {
	const { sourceDir } = freshFixture('create-plugin-dir-source');
	const pluginDir = resolve(testRoot, 'create-plugin-dir', 'does', 'not', 'exist', 'yet');
	assert(!existsSync(pluginDir), 'the plugin directory already existed before the test ran');
	const result = installDevBuild({ pluginDir, sourceDir, reload: false, buildProduction: () => undefined });
	assert(existsSync(resolve(pluginDir, 'manifest.json')), 'installDevBuild did not create the plugin directory');
	assert(result.pluginDir === pluginDir, 'the reported pluginDir did not match the requested one');
}

/**
 * H15.27: `disablePlugin`/`enablePlugin` alone cycle the already-registered manifest, so Obsidian
 * keeps reporting the version it loaded at startup. `loadManifests()` must run first, in the same
 * sequence, so the reload actually picks up the version just copied to disk.
 */
async function testReloadCyclesLoadManifestsThenDisableThenEnable() {
	const { sourceDir, pluginDir } = freshFixture('reload-cycle');
	const calls = [];
	const startedAt = Date.now();
	const result = installDevBuild({
		pluginDir,
		sourceDir,
		reload: true,
		buildProduction: () => undefined,
		runCli: (invocation) => {
			calls.push(invocation);
			return reloadReceipt(invocation, sourceDir);
		},
	});
	assert(result.reloaded, 'a reload:true run did not report reloaded');
	assert(calls.length === 1, `expected one awaited reload CLI invocation, got ${String(calls.length)}`);
	const completed = [];
	const app = { vault: { adapter: { getBasePath: () => calls[0].cwd } }, plugins: {
		manifests: {}, plugins: {}, enabledPlugins: new Set(), isEnabled: () => true,
		async loadManifests() { await Promise.resolve(); completed.push('manifests'); this.manifests['tyrian-companion'] = { version: `0.0.0-reload-cycle` }; },
		async disablePlugin(id) { await Promise.resolve(); completed.push('disable'); this.enabledPlugins.delete(id); },
		async enablePlugin(id) { await Promise.resolve(); completed.push('enable'); this.enabledPlugins.add(id); this.plugins[id] = { manifest: this.manifests[id] }; },
	} };
	try {
		const receipt = await runInNewContext(calls[0].args[1].slice('code='.length), { app });
		assert(completed.join(',') === 'manifests,disable,enable', 'reload did not await manifest/disable/enable completion in order');
		assert(typeof receipt === 'string' && receipt.includes('0.0.0-reload-cycle'), 'reload expression did not return effective loaded-version evidence');
		completed.length = 0;
		app.plugins.loadManifests = async () => { throw new Error('controlled rejection'); };
		let rejected = false;
		try { await runInNewContext(calls[0].args[1].slice('code='.length), { app }); } catch { rejected = true; }
		assert(rejected && completed.length === 0, 'rejected manifest load still reached disable/enable or produced success');
		app.plugins.isEnabled = () => false;
		await runInNewContext(calls[0].args[1].slice('code='.length), { app });
		assert(completed.length === 0, 'restricted mode still tried the plugin cycle');
		app.plugins.isEnabled = () => true;
		app.vault.adapter.getBasePath = () => sourceDir;
		await runInNewContext(calls[0].args[1].slice('code='.length), { app });
		assert(completed.length === 0, 'a different live vault still tried the plugin cycle');
	} catch (error) { failures.push(`reload expression failed in eval: ${error.message}`); }
	const expectedVaultRoot = resolve(pluginDir, '..', '..', '..');
	assert(calls.every((call) => call.cwd === expectedVaultRoot), 'the CLI was not invoked from the vault root');
	const markerPath = resolve(pluginDir, '.tyrian-dev-reload-at');
	assert(existsSync(markerPath), 'a successful reload did not write the reload marker');
	assert(!Number.isNaN(Date.parse(readFileSync(markerPath, 'utf8').trim())), 'the reload marker is not a parseable timestamp');
	assert(Date.parse(readFileSync(markerPath, 'utf8').trim()) >= startedAt, 'reload marker predates this installation');
}

function reloadReceipt(invocation, sourceDir, overrides = {}) {
	const version = JSON.parse(readFileSync(resolve(sourceDir, 'manifest.json'), 'utf8')).version;
	return { status: 0, stdout: `TYRIAN_DEV_RELOAD_V1\t${JSON.stringify({ schema: 1, vaultPath: invocation.cwd,
		communityPluginsEnabled: true, enabled: true, registeredVersion: version, loadedVersion: version, ...overrides })}` };
}

function testExitZeroWithoutEffectiveReloadFailsClosed() {
	const cases = [
		['eval-error', () => ({ status: 0, stdout: 'Error: await is only valid in async functions and the top level bodies of modules' })],
		['empty', () => ({ status: 0, stdout: '' })],
		['missing-plugin', (invocation, sourceDir) => reloadReceipt(invocation, sourceDir, { loadedVersion: null })],
		['disabled-plugin', (invocation, sourceDir) => reloadReceipt(invocation, sourceDir, { enabled: false })],
		['stale-manifest', (invocation, sourceDir) => reloadReceipt(invocation, sourceDir, { registeredVersion: 'old' })],
		['stale-plugin', (invocation, sourceDir) => reloadReceipt(invocation, sourceDir, { loadedVersion: 'old' })],
		['wrong-vault', (invocation, sourceDir) => reloadReceipt(invocation, sourceDir, { vaultPath: sourceDir })],
	];
	for (const [name, response] of cases) {
		const { sourceDir, pluginDir } = freshFixture(`reload-zero-${name}`);
		assertThrowsCode(() => installDevBuild({ pluginDir, sourceDir, buildProduction: () => undefined,
			runCli: (invocation) => response(invocation, sourceDir) }), 'reload-failed', `exit-zero ${name} reported a reload`);
		assert(!existsSync(resolve(pluginDir, '.tyrian-dev-reload-at')), `exit-zero ${name} wrote a success marker`);
	}
	const { sourceDir, pluginDir } = freshFixture('reload-restricted-mode');
	assertThrowsCode(() => installDevBuild({ pluginDir, sourceDir, buildProduction: () => undefined,
		runCli: (invocation) => reloadReceipt(invocation, sourceDir, { communityPluginsEnabled: false, loadedVersion: null }) }),
		'plugins-disabled', 'restricted mode reported an effective reload');
	assert(!existsSync(resolve(pluginDir, '.tyrian-dev-reload-at')), 'restricted mode wrote a success marker');
}

function testReloadFailureStopsBeforeMarker() {
	const { sourceDir, pluginDir } = freshFixture('reload-failure');
	assertThrowsCode(
		() => installDevBuild({
			pluginDir,
			sourceDir,
			reload: true,
			buildProduction: () => undefined,
			runCli: () => ({ status: 1, stdout: '' }),
		}),
		'reload-failed',
		'a failed CLI call did not fail the install',
	);
	assert(!existsSync(resolve(pluginDir, '.tyrian-dev-reload-at')), 'a failed reload still wrote the reload marker');
}

/** If `loadManifests()` itself fails, the disable/enable cycle must never run and no marker is written. */
function testLoadManifestsFailureStopsBeforeDisable() {
	const { sourceDir, pluginDir } = freshFixture('load-manifests-failure');
	const calls = [];
	assertThrowsCode(
		() => installDevBuild({
			pluginDir,
			sourceDir,
			reload: true,
			buildProduction: () => undefined,
			runCli: (invocation) => {
				calls.push(invocation);
				return { status: 1, stdout: '' };
			},
		}),
		'reload-failed',
		'a failed loadManifests CLI call did not fail the install',
	);
	assert(calls.length === 1, `expected the reload to stop after the failed loadManifests call, got ${String(calls.length)} calls`);
	assert(calls[0].args.join(' ').includes('loadManifests'), 'the single failed call was not loadManifests');
	assert(!existsSync(resolve(pluginDir, '.tyrian-dev-reload-at')), 'a failed reload still wrote the reload marker');
}

function testNoReloadWritesNoMarker() {
	const { sourceDir, pluginDir } = freshFixture('no-reload-marker');
	installDevBuild({ pluginDir, sourceDir, reload: false, buildProduction: () => undefined });
	assert(!existsSync(resolve(pluginDir, '.tyrian-dev-reload-at')), '--no-reload still wrote the reload marker');
}

function testArgumentParsing() {
	const withEnv = withEnvironment({ TC_PLUGIN_DIR: undefined }, () => parseDevInstallArguments(['--plugin-dir', '/tmp/x', '--no-reload']));
	assert(withEnv.pluginDir === resolve('/tmp/x'), 'a --plugin-dir flag was not honoured');
	assert(withEnv.reload === false, '--no-reload did not turn reload off');

	const defaulted = withEnvironment({ TC_PLUGIN_DIR: '/tmp/from-env' }, () => parseDevInstallArguments([]));
	assert(defaulted.pluginDir === resolve('/tmp/from-env'), 'TC_PLUGIN_DIR was not honoured when no flag is given');
	assert(defaulted.reload === true, 'reload did not default to true');

	const noEnv = withEnvironment({ TC_PLUGIN_DIR: undefined }, () => parseDevInstallArguments([]));
	assert(noEnv.pluginDir === defaultPluginDir(), 'the default plugin dir did not match defaultPluginDir()');

	assertThrowsCode(() => parseDevInstallArguments(['--unknown']), 'usage', 'an unknown flag was silently accepted');
	assertThrowsCode(() => parseDevInstallArguments(['--plugin-dir']), 'usage', 'a --plugin-dir without a value was accepted');
	assertThrowsCode(
		() => parseDevInstallArguments(['--plugin-dir', '/a', '--plugin-dir', '/b']),
		'usage',
		'a repeated --plugin-dir was accepted instead of rejected',
	);
}

function freshFixture(name) {
	const root = join(testRoot, name);
	const sourceDir = join(root, 'source');
	const pluginDir = join(root, 'plugin');
	mkdirSync(sourceDir, { recursive: true });
	mkdirSync(pluginDir, { recursive: true });
	writeFileSync(join(sourceDir, 'manifest.json'), `{"id":"tyrian-companion","version":"0.0.0-${name}"}\n`);
	writeFileSync(join(sourceDir, 'main.js'), `/* built main.js for ${name} */\n`);
	writeFileSync(join(sourceDir, 'styles.css'), `.tyrian-${name} { color: red; }\n`);
	return { sourceDir, pluginDir };
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

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function sameStrings(left, right) {
	return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function assertThrowsCode(run, expectedCode, message) {
	try {
		run();
	} catch (error) {
		if (error instanceof DevInstallError && error.code === expectedCode) return;
		failures.push(`${message} (got: ${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	failures.push(message);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
