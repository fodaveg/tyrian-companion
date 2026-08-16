import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { validateReleaseIdentityContract } from '../release-identity-contract.mjs';

const root = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-release-identity-'));
const failures = [];
const paths = ['package.json', 'manifest.json', 'LICENSE', 'docs/IDENTITY.md', 'README.md'];
const files = new Map(paths.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));

try {
	assert(validateReleaseIdentityContract(root).findings.length === 0, 'current repository failed the identity contract');
	testManifestIdentity();
	testManifestShape();
	testPackageIdentity();
	testPackagePrivate();
	testRepositoryIdentity();
	testPackageScriptBypass();
	testTestRunnerBypass();
	testLicenseIdentity();
	testDecisionEvidence();
	testReadmeIdentity();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.exit(1);
}
process.stdout.write('release identity contract suite: PASS\n');

function testManifestIdentity() {
	for (const [name, key, value, finding] of [
		['manifest-id', 'id', 'other-companion', 'manifest-id'],
		['manifest-name', 'name', 'Other Companion', 'manifest-name'],
		['manifest-author', 'author', 'Unknown', 'manifest-author'],
		['manifest-desktop', 'isDesktopOnly', false, 'manifest-desktop-only'],
	]) {
		const manifest = parse('manifest.json');
		manifest[key] = value;
		expectFinding(name, new Map([['manifest.json', json(manifest)]]), finding);
	}
}

function testManifestShape() {
	const manifest = parse('manifest.json');
	manifest.authorUrl = 'https://example.invalid';
	expectFinding('manifest-extra-key', new Map([['manifest.json', json(manifest)]]), 'manifest-shape');
}

function testPackageIdentity() {
	for (const [name, key, value, finding] of [
		['package-name', 'name', 'other-companion', 'package-name'],
		['package-author', 'author', 'Unknown', 'package-author'],
		['package-license', 'license', 'UNLICENSED', 'package-license'],
	]) {
		const packageJson = parse('package.json');
		packageJson[key] = value;
		expectFinding(name, new Map([['package.json', json(packageJson)]]), finding);
	}
}

function testPackagePrivate() {
	for (const [name, mutate] of [
		['package-private-missing', (packageJson) => { delete packageJson.private; }],
		['package-private-false', (packageJson) => { packageJson.private = false; }],
	]) {
		const packageJson = parse('package.json');
		mutate(packageJson);
		expectFinding(name, new Map([['package.json', json(packageJson)]]), 'package-private');
	}
}

function testRepositoryIdentity() {
	for (const [name, mutate, finding] of [
		['repository-url', (repository) => { repository.url = 'https://example.invalid/repo.git'; }, 'package-repository-url'],
		['repository-type', (repository) => { repository.type = 'archive'; }, 'package-repository-type'],
		['repository-shape', (repository) => { repository.directory = 'plugin'; }, 'package-repository-shape'],
	]) {
		const packageJson = parse('package.json');
		mutate(packageJson.repository);
		expectFinding(name, new Map([['package.json', json(packageJson)]]), finding);
	}
}

function testPackageScriptBypass() {
	const releasePackage = parse('package.json');
	releasePackage.scripts['release:package'] = 'node scripts/release-package.mjs';
	expectFinding('release-package-bypass', new Map([['package.json', json(releasePackage)]]), 'package-release-script');

	const identityTest = parse('package.json');
	identityTest.scripts['test:release-identity-contract'] = 'node -e "process.exit(0)"';
	expectFinding(
		'identity-test-bypass',
		new Map([['package.json', json(identityTest)]]),
		'package-identity-test-script',
	);
}

function testTestRunnerBypass() {
	for (const [name, mutate] of [
		['test-runner-echo', (source) => `echo ${source}`],
		['test-runner-ignore-failure', (source) => source.replace('npm run test:release-identity-contract', '(npm run test:release-identity-contract || true)')],
		['test-runner-semicolon', (source) => source.replace('npm run test:release-identity-contract', 'npm run test:release-identity-contract; true')],
		['test-runner-substitution', (source) => source.replace('npm run test:release-identity-contract', 'npm run test:support-contract')],
	]) {
		const packageJson = parse('package.json');
		packageJson.scripts.test = mutate(packageJson.scripts.test);
		expectFinding(name, new Map([['package.json', json(packageJson)]]), 'package-test-script');
	}
}

function testLicenseIdentity() {
	const source = files.get('LICENSE').replace('MIT License', 'Private License');
	expectFinding('license-change', new Map([['LICENSE', source]]), 'license-hash');
}

function testDecisionEvidence() {
	const source = files.get('docs/IDENTITY.md').replace('0 coincidencias', '1 coincidencia');
	expectFinding('collision-evidence', new Map([['docs/IDENTITY.md', source]]), 'identity-document-hash');
}

function testReadmeIdentity() {
	expectFinding('readme-name', new Map([['README.md', files.get('README.md').replace('# Tyrian Companion', '# Other Companion')]]), 'readme-name');
	expectFinding('readme-identity-link', new Map([['README.md', files.get('README.md').replace('[Release identity](docs/IDENTITY.md)', 'Release identity')]]), 'readme-identity-link');
	expectFinding('readme-license-link', new Map([['README.md', files.get('README.md').replace('[MIT](LICENSE)', 'MIT')]]), 'readme-license-link');
}

function expectFinding(name, replacements, finding) {
	const directory = join(testRoot, name);
	for (const [path, source] of files) write(directory, path, replacements.get(path) ?? source);
	const result = validateReleaseIdentityContract(directory);
	assert(result.findings.includes(finding), `${name} did not turn red with ${finding}`);
}

function parse(path) {
	return JSON.parse(files.get(path));
}

function json(value) {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

function write(directory, path, source) {
	const destination = join(directory, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, source);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
