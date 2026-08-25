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
	author: 'David',
	license: 'MIT',
	repositoryType: 'git',
	repositoryUrl: 'https://github.com/fodaveg/tyrian-companion.git',
});
const LICENSE_SHA256 = 'e5f4bfdbaa06633c08616a2e4a361c620ac11b8b815af39a15c9269d404c9b31';
const IDENTITY_DOCUMENT_SHA256 = '9931d916f05f88df5ad2ec83a140f7b1ce69a346ad0cc2732169f209bb8df01e';
const TEST_SCRIPT = 'vitest run --configLoader runner && npm run test:h8-crossover-spike && npm run test:release-preflight && npm run test:security-scan && npm run test:release-package && npm run test:release-identity-contract && npm run test:beta-channel && npm run test:beta-runtime && npm run test:support-contract && npm run test:h8-helper-decision-contract';

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
	if (scripts['release:package'] !== 'npm run release:identity-contract && node scripts/release-package.mjs') {
		findings.push('package-release-script');
	}
	if (scripts.test !== TEST_SCRIPT) {
		findings.push('package-test-script');
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
