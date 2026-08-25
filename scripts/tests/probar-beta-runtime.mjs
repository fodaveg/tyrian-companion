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

	assertPass(evidence({ runtimeVersion: '0.1.4' }), 'matching disk and runtime versions did not pass');
	assertRed(evidence({ runtimeVersion: '0.1.3' }), 'runtime-version-mismatch', 'stale loaded runtime stayed green');
	assertRed(evidence({ enabled: false, runtimeVersion: null }), 'plugin-not-enabled', 'disabled plugin stayed green');
	assertRed(evidence({ runtimeVersion: null }), 'plugin-not-loaded', 'missing loaded plugin stayed green');
	assertRed(evidence({ vaultPath: otherVault }), 'runtime-vault-mismatch', 'evidence from another vault stayed green');
	assertRed(evidence({ registeredVersion: '0.1.3' }), 'registered-version-mismatch', 'stale registered manifest stayed green');
	assertRed('not-runtime-evidence', 'runtime-evidence-invalid', 'malformed runtime evidence stayed green');
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
		...overrides,
	})}`;
}

function verify(result) {
	return verifyBetaRuntime({
		runCli: () => result,
		vaultRoot: vault,
	});
}

function assertPass(runtimeEvidence, message) {
	try {
		const result = verify({ status: 0, stdout: runtimeEvidence });
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
