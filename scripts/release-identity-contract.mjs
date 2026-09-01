import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_IDENTITY_CONTRACT_VERSION = 1;

const MANIFEST_KEYS = [
	'author',
	'description',
	'id',
	'isDesktopOnly',
	'minAppVersion',
	'name',
	'version',
];
const IDENTITY = Object.freeze({
	id: 'tyrian-companion',
	name: 'Tyrian Companion',
	author: 'fodaveg',
	license: 'MIT',
	repositoryType: 'git',
	repositoryUrl: 'https://github.com/fodaveg/tyrian-companion.git',
});
const LICENSE_SHA256 = '4561c26198648e92896e252319c02fa6116b3d38ce85e8deb138bd3d2e041144';
const IDENTITY_DOCUMENT_SHA256 = '6a1c684986c744abf2ca2952b1a7939c55e8517bcacc8ddae11c8f772a16dda1';
const TEST_SCRIPT = 'node scripts/run-gate.mjs test';
const CHECK_SCRIPT = 'node scripts/run-gate.mjs check';
/**
 * The gate used to be one `&&` chain, and freezing that literal was what stopped
 * a step from being dropped. The chain is gone, so the same guarantee now has to
 * be expressed as a census of the scripts that must exist with their exact
 * command. `scripts/tests/probar-run-gate.mjs` closes the other half: it proves
 * the runner's manifest still covers every entry of this list.
 */
const REQUIRED_SCRIPTS = Object.freeze({
	'test:h8-crossover-spike': 'bash scripts/tests/probar-h8-crossover-spike.sh',
	'test:release-preflight': 'bash scripts/tests/probar-release-preflight.sh',
	'test:brat-release-contract': 'node scripts/tests/probar-brat-release-contract.mjs',
	'test:security-scan': 'node scripts/tests/probar-security-scan.mjs',
	'test:action-observability': 'node scripts/tests/probar-action-observability-census.mjs && node scripts/action-observability-census.mjs',
	'test:release-package': 'node scripts/tests/probar-release-package.mjs',
	'test:release-identity-contract': 'node scripts/tests/probar-release-identity-contract.mjs',
	'test:beta-channel': 'node scripts/tests/probar-beta-channel.mjs',
	'test:beta-runtime': 'bash scripts/tests/probar-beta-runtime.sh',
	'test:support-contract': 'node scripts/tests/probar-support-contract.mjs',
	'test:h8-helper-decision-contract': 'node scripts/tests/probar-h8-helper-decision-contract.mjs',
	'test:source-text-assertion-contract': 'node scripts/tests/probar-source-text-assertion-contract.mjs',
	'test:run-gate': 'node scripts/tests/probar-run-gate.mjs',
	'test:brat-release-plan': 'node scripts/tests/probar-brat-release-plan.mjs',
	'test:release-workflow': 'node scripts/tests/probar-release-workflow.mjs',
	'release:brat-plan': 'node scripts/brat-release-plan.mjs --from-staging',
	'release:workflow-contract': 'node scripts/release-workflow-contract.mjs',
	'source-text:assertion-contract': 'node scripts/source-text-assertion-contract.mjs',
});

/** Validates the deliberately fixed H7.1 release identity without making a network request. */
export function validateReleaseIdentityContract(root = process.cwd()) {
	const findings = [];
	const packageJson = readJson(root, 'package.json', 'package-json', findings);
	const manifest = readJson(root, 'manifest.json', 'manifest-json', findings);
	const license = readSource(root, 'LICENSE', 'license-file', findings);
	const identityDocument = readSource(root, 'docs/IDENTITY.md', 'identity-document', findings);
	const readme = readSource(root, 'README.md', 'readme-file', findings);

	if (packageJson) validatePackage(packageJson, findings);
	if (manifest) validateManifest(manifest, findings);
	if (license.length > 0 && sha256(license) !== LICENSE_SHA256) findings.push('license-hash');
	if (identityDocument.length > 0 && sha256(identityDocument) !== IDENTITY_DOCUMENT_SHA256) {
		findings.push('identity-document-hash');
	}
	if (!readme.startsWith(`# ${IDENTITY.name}\n`)) findings.push('readme-name');
	if (!readme.includes('[Release identity](docs/IDENTITY.md)')) findings.push('readme-identity-link');
	if (!readme.includes('[MIT](LICENSE)')) findings.push('readme-license-link');

	return {
		version: RELEASE_IDENTITY_CONTRACT_VERSION,
		findings: [...new Set(findings)].sort(),
	};
}

function validatePackage(packageJson, findings) {
	if (packageJson.private !== true) findings.push('package-private');
	for (const [key, expected] of [
		['name', IDENTITY.id],
		['author', IDENTITY.author],
		['license', IDENTITY.license],
	]) {
		if (packageJson[key] !== expected) findings.push(`package-${key}`);
	}
	const repository = packageJson.repository;
	if (!isRecord(repository) || !sameStrings(Object.keys(repository).sort(), ['type', 'url'])) {
		findings.push('package-repository-shape');
		return;
	}
	if (repository.type !== IDENTITY.repositoryType) findings.push('package-repository-type');
	if (repository.url !== IDENTITY.repositoryUrl) findings.push('package-repository-url');
	const scripts = packageJson.scripts;
	if (!isRecord(scripts)) {
		findings.push('package-scripts');
		return;
	}
	if (scripts['release:identity-contract'] !== 'node scripts/release-identity-contract.mjs') {
		findings.push('package-identity-script');
	}
	if (scripts['test:release-identity-contract'] !== 'node scripts/tests/probar-release-identity-contract.mjs') {
		findings.push('package-identity-test-script');
	}
	if (scripts['release:brat-verify'] !== 'node scripts/brat-release-contract.mjs') {
		findings.push('package-brat-release-script');
	}
	if (scripts['test:brat-release-contract'] !== 'node scripts/tests/probar-brat-release-contract.mjs') {
		findings.push('package-brat-release-test-script');
	}
	if (scripts['release:package'] !== 'npm run release:identity-contract && node scripts/release-package.mjs') {
		findings.push('package-release-script');
	}
	if (scripts.test !== TEST_SCRIPT) {
		findings.push('package-test-script');
	}
	if (scripts.check !== CHECK_SCRIPT) {
		findings.push('package-check-script');
	}
	for (const [name, command] of Object.entries(REQUIRED_SCRIPTS)) {
		if (scripts[name] !== command) findings.push('package-gate-step-script');
	}
}

function validateManifest(manifest, findings) {
	if (!sameStrings(Object.keys(manifest).sort(), MANIFEST_KEYS)) findings.push('manifest-shape');
	for (const [key, expected] of [
		['id', IDENTITY.id],
		['name', IDENTITY.name],
		['author', IDENTITY.author],
	]) {
		if (manifest[key] !== expected) findings.push(`manifest-${key}`);
	}
	if (manifest.isDesktopOnly !== true) findings.push('manifest-desktop-only');
}

function readJson(root, relativePath, code, findings) {
	const source = readSource(root, relativePath, code, findings);
	if (source.length === 0) return null;
	try {
		const value = JSON.parse(source);
		if (!isRecord(value)) {
			findings.push(code);
			return null;
		}
		return value;
	} catch {
		findings.push(code);
		return null;
	}
}

function readSource(root, relativePath, code, findings) {
	try {
		return readFileSync(resolve(root, relativePath), 'utf8');
	} catch {
		findings.push(code);
		return '';
	}
}

function sha256(source) {
	return createHash('sha256').update(source, 'utf8').digest('hex');
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStrings(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	const result = validateReleaseIdentityContract(process.argv[2] ?? process.cwd());
	if (result.findings.length > 0) {
		for (const finding of result.findings) process.stderr.write(`release identity: ${finding}\n`);
		process.exit(1);
	}
	process.stdout.write(`release identity contract v${String(result.version)}: PASS\n`);
}
