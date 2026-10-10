import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const verifierPath = resolve(process.env.TYRIAN_RUNTIME_VERIFIER ?? 'scripts/verify-beta-runtime.mjs');
// eslint-disable-next-line no-unsanitized/method -- the suite injects a local replacement for its required negative control.
const { parseBetaRuntimeArguments, verifyBetaRuntime } = await import(pathToFileURL(verifierPath).href);
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
	assertInstalledFileMissing();
	assertGhIsNamedTheRepository();
	assertArguments();
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

function assertInstalledFileMissing() {
	const bare = resolve(testRoot, 'bare-vault', ['.', 'obsidian'].join(''), 'plugins', 'tyrian-companion');
	mkdirSync(bare, { recursive: true });
	writeFileSync(resolve(bare, 'manifest.json'), '{"id":"tyrian-companion","version":"0.1.4"}\n');
	writeFileSync(resolve(bare, 'main.js'), 'installed main');
	try {
		verifyBetaRuntime({ readReleaseAssets: () => releaseAssets(), runCli: () => ({ status: 0, stdout: evidence({ vaultPath: resolve(testRoot, 'bare-vault') }) }), vaultRoot: resolve(testRoot, 'bare-vault') });
		failures.push('an install without styles.css stayed green');
	} catch (error) {
		if (error?.code !== 'installed-asset-missing') failures.push(`install without styles.css: expected=installed-asset-missing; actual=${String(error?.code)}`);
	}
}

/** The default reader must name the repository: `gh` runs outside any clone (the vault, an unpacked CI artifact). */
function assertGhIsNamedTheRepository() {
	const logPath = resolve(testRoot, 'gh-args.json');
	const ghPath = resolve(testRoot, 'fake-gh.mjs');
	writeFileSync(ghPath, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(releaseAssets())});\n`);
	chmodSync(ghPath, 0o755);
	try {
		verifyBetaRuntime({ ghCommand: ghPath, runCli: () => ({ status: 0, stdout: evidence() }), vaultRoot: vault });
	} catch (error) {
		failures.push(`the default gh reader failed against a fake gh: ${String(error?.code ?? error)}`);
		return;
	}
	let asked;
	try {
		asked = JSON.parse(readFileSync(logPath, 'utf8'));
	} catch {
		failures.push('the default gh reader never called gh');
		return;
	}
	if (asked.join(' ') !== 'release view 0.1.4 --repo fodaveg/tyrian-companion --json assets') failures.push(`gh was called as: ${asked.join(' ')}`);
}

function assertArguments() {
	if (typeof parseBetaRuntimeArguments !== 'function') return;
	const base = ['--vault', 'v'];
	const parsed = parseBetaRuntimeArguments([...base, '--gh-cli', '/bin/gh', '--release-tag', '0.1.4']);
	if (parsed.ghCommand !== '/bin/gh' || parsed.releaseTag !== '0.1.4' || parsed.releaseCheck !== true) failures.push('--gh-cli and --release-tag were not honoured');
	if (parseBetaRuntimeArguments([...base, '--no-release-check']).releaseCheck !== false) failures.push('--no-release-check was not honoured');
	for (const [name, extra] of [
		['no-check with a tag', ['--no-release-check', '--release-tag', '0.1.4']],
		['no-check with gh', ['--no-release-check', '--gh-cli', 'gh']],
		['repeated no-check', ['--no-release-check', '--no-release-check']],
		['repeated tag', ['--release-tag', '0.1.4', '--release-tag', '0.1.5']],
		['repeated gh', ['--gh-cli', 'a', '--gh-cli', 'b']],
		['tag without value', ['--release-tag']],
	]) {
		try {
			parseBetaRuntimeArguments([...base, ...extra]);
			failures.push(`arguments case ${name} was accepted`);
		} catch (error) {
			if (error?.code !== 'usage') failures.push(`arguments case ${name}: actual=${String(error?.code)}`);
		}
	}
}

function assertPass(runtimeEvidence, message, release, options) {
	try {
		const result = verify({ status: 0, stdout: runtimeEvidence }, release, options);
		const expectChecked = options?.releaseCheck !== false;
		if (result.releaseChecked !== expectChecked) failures.push(`${message}: releaseChecked=${String(result.releaseChecked)}`);
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
