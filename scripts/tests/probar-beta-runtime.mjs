import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const verifierPath = resolve(process.env.TYRIAN_RUNTIME_VERIFIER ?? 'scripts/verify-beta-runtime.mjs');
// eslint-disable-next-line no-unsanitized/method -- the suite injects a local replacement for its required negative control.
const { verifyBetaRuntime } = await import(pathToFileURL(verifierPath).href);
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-beta-runtime-'));
const vault = resolve(testRoot, 'vault');
const otherVault = resolve(testRoot, 'other-vault');
const plugin = resolve(vault, ['.', 'obsidian'].join(''), 'plugins', 'tyrian-companion');
const failures = [];

try {
	mkdirSync(plugin, { recursive: true });
	mkdirSync(otherVault);
	writeFileSync(resolve(plugin, 'manifest.json'), '{"id":"tyrian-companion","version":"0.1.4"}\n');
	writeFileSync(resolve(plugin, 'main.js'), 'installed main');
	writeFileSync(resolve(plugin, 'styles.css'), 'installed styles');

	assertPass(evidence({ runtimeVersion: '0.1.4' }), 'matching disk and runtime versions did not pass');
	assertRed(evidence({ runtimeVersion: '0.1.3' }), 'runtime-version-mismatch', 'stale loaded runtime stayed green');
	assertRed(evidence({ enabled: false, runtimeVersion: null }), 'plugin-not-enabled', 'disabled plugin stayed green');
	assertRed(evidence({ runtimeVersion: null }), 'plugin-not-loaded', 'missing loaded plugin stayed green');
	assertRed(evidence({ vaultPath: otherVault }), 'runtime-vault-mismatch', 'evidence from another vault stayed green');
	assertRed(evidence({ registeredVersion: '0.1.3' }), 'registered-version-mismatch', 'stale registered manifest stayed green');
	assertRed('not-runtime-evidence', 'runtime-evidence-invalid', 'malformed runtime evidence stayed green');
	assertRed(evidence({ runtimeReady: false }), 'runtime-not-ready', 'plugin that did not finish onload stayed green');
	assertRed(evidence({ runtimeReady: null }), 'runtime-not-ready', 'plugin with no runtimeReady stayed green');
	assertRed(evidence({ runtimeReady: 'yes' }), 'runtime-evidence-invalid', 'non-boolean runtimeReady stayed green');
	assertReleaseRed(releaseAssets({ 'main.js': 'other main' }), 'installed-asset-mismatch', 'main.js with other bytes than the release stayed green');
	assertReleaseRed(releaseAssets({ 'styles.css': 'other styles' }), 'installed-asset-mismatch', 'styles.css with other bytes than the release stayed green');
	assertReleaseRed(releaseAssets({}, ['styles.css']), 'release-asset-missing', 'release without styles.css stayed green');
	assertReleaseRed(JSON.stringify({ assets: [{ name: 'main.js' }, { name: 'styles.css' }] }), 'release-digest-missing', 'release without digests stayed green');
	assertReleaseRed('not json', 'release-unavailable', 'unreadable release stayed green');
	assertReleaseRed(() => { throw new Error('no network'); }, 'unexpected', 'throwing release reader stayed green');
	assertPass(evidence(), 'matching release bytes did not pass', releaseAssets());
	assertPass(evidence(), 'opt-out of the release check did not pass', () => { throw new Error('must not be called'); }, { releaseCheck: false });
	assertCliUnavailable({ status: 1, stdout: '' }, 'failed Obsidian CLI did not fail closed');
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.exit(1);
}
process.stdout.write('beta runtime cases: PASS\n');

function evidence(overrides = {}) {
	return `TYRIAN_RUNTIME_V1\t${JSON.stringify({
		schema: 1,
		vaultPath: vault,
		enabled: true,
		registeredVersion: '0.1.4',
		runtimeVersion: '0.1.4',
		runtimeReady: true,
		...overrides,
	})}`;
}

function sha(text) {
	return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** What `gh release view 0.1.4 --json assets` prints; `changed` replaces the bytes a digest was taken from. */
function releaseAssets(changed = {}, omit = []) {
	const bytes = { 'main.js': 'installed main', 'styles.css': 'installed styles', ...changed };
	return JSON.stringify({ assets: Object.entries(bytes).filter(([name]) => !omit.includes(name)).map(([name, text]) => ({ name, digest: sha(text) })) });
}

function verify(result, readReleaseAssets = () => releaseAssets(), options = {}) {
	return verifyBetaRuntime({
		readReleaseAssets: typeof readReleaseAssets === 'function' ? readReleaseAssets : () => readReleaseAssets,
		runCli: () => result,
		vaultRoot: vault,
		...options,
	});
}

function assertReleaseRed(release, code, message) {
	try {
		verify({ status: 0, stdout: evidence() }, release);
		failures.push(message);
	} catch (error) {
		if (code !== 'unexpected' && error?.code !== code) failures.push(`${message}: expected=${code}; actual=${String(error?.code)}`);
		if (code === 'unexpected' && error?.code !== undefined) failures.push(`${message}: expected a raw error; actual=${String(error?.code)}`);
	}
}

function assertPass(runtimeEvidence, message, release, options) {
	try {
		const result = verify({ status: 0, stdout: runtimeEvidence }, release, options);
		if (
			result.diskVersion !== '0.1.4' || result.registeredVersion !== '0.1.4' ||
			result.runtimeVersion !== '0.1.4'
		) failures.push(message);
	} catch (error) {
		failures.push(`${message}: ${String(error)}`);
	}
}

function assertRed(runtimeEvidence, code, message) {
	try {
		verify({ status: 0, stdout: runtimeEvidence });
		failures.push(message);
	} catch (error) {
		if (error?.code !== code) failures.push(`${message}: expected=${code}; actual=${String(error?.code)}`);
	}
}

function assertCliUnavailable(result, message) {
	try {
		verify(result);
		failures.push(message);
	} catch (error) {
		if (error?.code !== 'cli-unavailable') failures.push(`${message}: actual=${String(error?.code)}`);
	}
}
