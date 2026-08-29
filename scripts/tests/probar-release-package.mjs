import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	existsSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
	packageRelease,
	ReleasePackageError,
	RELEASE_FILES,
	validateReleaseArchive,
} from '../release-package.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-release-package-'));
const failures = [];

try {
	testDeterministicPackage();
	testBuildIsCausal();
	testBuildCannotMutateInputs();
	testMetadataAndTagFailClosed();
	testArtifactSecretSabotage();
	testPersistedArchiveIsAuthority();
	testArchiveTamperSabotage();
	testArchiveStructureSabotage();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`release package suite: ${String(failures.length)} failure(s)\n`);
	process.exit(1);
}

process.stdout.write('release package suite: PASS\n');

function testDeterministicPackage() {
	const root = fixture('deterministic');
	const first = packageFixture({ root, build: controlledBuild });
	const firstArchive = readFileSync(first.archivePath);
	const firstChecksum = readFileSync(first.checksumPath, 'utf8');
	for (const path of RELEASE_FILES) {
		utimesSync(resolve(root, path), new Date('2026-08-14T20:00:00Z'), new Date('2026-08-14T20:00:00Z'));
	}
	chmodSync(resolve(root, 'styles.css'), 0o600);
	const second = packageFixture({ root, build: controlledBuild });
	assert(readFileSync(second.archivePath).equals(firstArchive), 'same inputs did not produce the same archive bytes');
	assert(readFileSync(second.checksumPath, 'utf8') === firstChecksum, 'same inputs did not produce the same checksum file');
	assert(
		JSON.stringify(readdirSync(second.stageRoot).sort()) === JSON.stringify([...RELEASE_FILES].sort()),
		'stage did not contain exactly the three distributable files',
	);
	assert(!readdirSync(second.stageRoot).includes('versions.json'), 'versions.json was packaged despite not being a BRAT release asset');
	process.stdout.write(`PASS: reproducible package restored green with ${second.files.length} explicit files\n`);
}

function testBuildIsCausal() {
	const root = fixture('build-causal');
	writeFileSync(resolve(root, 'main.js'), 'stale bundle');
	assertThrows(
		() => packageFixture({ root, build: () => undefined }),
		'build-output-missing',
		'no-op build did not turn red after stale main.js removal',
	);
	assert(!existsSync(resolve(root, '.release')), 'failed build left a stale release directory');
	process.stdout.write('PASS: no-op build sabotage turned red before staging\n');
}

function testBuildCannotMutateInputs() {
	const root = fixture('build-input-mutation');
	assertThrows(
		() => packageFixture({
			root,
			build: (target) => {
				controlledBuild(target);
				writeFileSync(resolve(target, 'styles.css'), '.mutated { color: blue; }\n');
			},
		}),
		'build-mutated-input',
		'build mutation of a staged input did not turn red',
	);
	process.stdout.write('PASS: build-input mutation sabotage turned red before staging\n');
}

function testMetadataAndTagFailClosed() {
	const root = fixture('metadata');
	writeJson(resolve(root, 'versions.json'), { '0.1.0': '1.10.0' });
	assertThrows(
		() => packageFixture({ root, build: controlledBuild }),
		'versions-mismatch',
		'versions.json mismatch did not turn red',
	);
	writeJson(resolve(root, 'versions.json'), { '0.1.0': '1.11.4' });
	assertThrows(
		() => packageFixture({
			root,
			build: controlledBuild,
			environment: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.0' },
		}),
		'tag-mismatch',
		'non-exact release tag did not turn red',
	);
	const exactTag = packageFixture({
		root,
		build: controlledBuild,
		environment: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: '0.1.0' },
	});
	assert(exactTag.version === '0.1.0', 'exact release tag did not restore the package path to green');
}

function testArtifactSecretSabotage() {
	const root = fixture('artifact-secret');
	const credential = ['Tyr1an', 'Release', '7f9Q', 'SafeProbe'].join('-');
	let message = '';
	try {
		packageFixture({
			root,
			build: (target) => writeFileSync(resolve(target, 'main.js'), `const apiKey='${credential}';`),
		});
		fail('artifact credential sabotage stayed green');
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
		assert(error instanceof ReleasePackageError && error.code === 'artifact-security', 'artifact credential failed for the wrong reason');
		assert(!message.includes(credential), 'artifact scanner exposed the credential value');
		assert(message.includes('main.js') && message.includes('long-credential-assignment'), 'artifact scanner omitted safe causal diagnostics');
	}
	assert(!existsSync(resolve(root, '.release')), 'artifact scan failure left staged release bytes');
	assert(!existsSync(resolve(root, 'main.js')), 'artifact scan failure left the rejected generated bundle');
	process.stdout.write('PASS: built-artifact credential sabotage turned red with redacted output\n');
}

function testArchiveTamperSabotage() {
	const root = fixture('archive-tamper');
	const result = packageFixture({ root, build: controlledBuild });
	const archive = Buffer.from(readFileSync(result.archivePath));
	const marker = archive.indexOf('controlled production bundle');
	if (marker < 0) {
		fail('archive fixture marker was missing');
		return;
	}
	archive[marker] ^= 0x01;
	const expected = RELEASE_FILES.map((name) => ({
		name,
		bytes: readFileSync(resolve(result.stageRoot, name)),
	}));
	assertThrows(
		() => validateReleaseArchive(archive, expected),
		'archive-validation',
		'archive byte tamper did not turn red',
	);
	process.stdout.write('PASS: archive-byte sabotage turned red through CRC/content validation\n');
}

function testPersistedArchiveIsAuthority() {
	const root = fixture('persisted-archive-authority');
	assertThrows(
		() => packageFixture({
			root,
			build: controlledBuild,
			writeArchive: (path, bytes) => {
				const persisted = Buffer.from(bytes);
				const marker = persisted.indexOf('controlled production bundle');
				assert(marker >= 0, 'persisted archive fixture marker was missing');
				persisted[marker] ^= 0x01;
				writeFileSync(path, persisted, { mode: 0o644 });
			},
		}),
		'archive-validation',
		'post-write archive tamper stayed green because validation trusted pre-write bytes',
	);
	assert(!existsSync(resolve(root, '.release')), 'post-write archive failure left release output behind');
	assert(!existsSync(resolve(root, 'main.js')), 'post-write archive failure left generated main.js behind');
	process.stdout.write('PASS: persisted archive bytes are reread before validation and hashing\n');
}

function testArchiveStructureSabotage() {
	const root = fixture('archive-structure');
	const result = packageFixture({ root, build: controlledBuild });
	const archive = readFileSync(result.archivePath);
	const expected = RELEASE_FILES.map((name) => ({
		name,
		bytes: readFileSync(resolve(result.stageRoot, name)),
	}));
	const end = archive.length - 22;
	const central = archive.readUInt32LE(end + 16);
	const cases = [
		['local traversal name', (bytes) => bytes.write('../ifest.json', 30, 'utf8')],
		['central traversal name', (bytes) => bytes.write('../ifest.json', central + 46, 'utf8')],
		['local flags', (bytes) => bytes.writeUInt16LE(0, 6)],
		['central flags', (bytes) => bytes.writeUInt16LE(0, central + 8)],
		['local method', (bytes) => bytes.writeUInt16LE(8, 8)],
		['central method', (bytes) => bytes.writeUInt16LE(8, central + 10)],
		['local time', (bytes) => bytes.writeUInt16LE(1, 10)],
		['local date', (bytes) => bytes.writeUInt16LE(0, 12)],
		['central time', (bytes) => bytes.writeUInt16LE(1, central + 12)],
		['central date', (bytes) => bytes.writeUInt16LE(0, central + 14)],
		['central mode', (bytes) => bytes.writeUInt32LE(0, central + 38)],
		['local extra length', (bytes) => bytes.writeUInt16LE(1, 28)],
		['central extra length', (bytes) => bytes.writeUInt16LE(1, central + 30)],
		['central comment length', (bytes) => bytes.writeUInt16LE(1, central + 32)],
		['EOCD comment length', (bytes) => bytes.writeUInt16LE(1, end + 20)],
		['central local-header offset', (bytes) => bytes.writeUInt32LE(1, central + 42)],
		['EOCD central offset', (bytes) => bytes.writeUInt32LE(central + 1, end + 16)],
		['EOCD central size', (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(end + 12) - 1, end + 12)],
		['EOCD disk entry count', (bytes) => bytes.writeUInt16LE(bytes.readUInt16LE(end + 8) - 1, end + 8)],
		['EOCD total entry count', (bytes) => bytes.writeUInt16LE(bytes.readUInt16LE(end + 10) - 1, end + 10)],
	];
	for (const [label, mutate] of cases) {
		const sabotaged = Buffer.from(archive);
		mutate(sabotaged);
		assert(!sabotaged.equals(archive), `${label} sabotage did not alter the archive`);
		assertThrows(
			() => validateReleaseArchive(sabotaged, expected),
			'archive-validation',
			`${label} sabotage did not activate its ZIP guard`,
		);
	}
	process.stdout.write(`PASS: ${String(cases.length)} ZIP structure sabotages each turned red\n`);
}

function fixture(name) {
	const root = resolve(testRoot, name);
	mkdirSync(root, { recursive: true });
	writeJson(resolve(root, 'package.json'), { name: 'tyrian-companion', version: '0.1.0' });
	writeJson(resolve(root, 'manifest.json'), {
		id: 'tyrian-companion',
		name: 'Tyrian Companion',
		version: '0.1.0',
		minAppVersion: '1.11.4',
		description: 'Controlled release fixture.',
		author: 'Test',
		isDesktopOnly: true,
	});
	writeJson(resolve(root, 'versions.json'), { '0.1.0': '1.11.4' });
	writeFileSync(resolve(root, 'styles.css'), '.tyrian-test { color: red; }\n');
	return root;
}

function controlledBuild(root) {
	writeFileSync(resolve(root, 'main.js'), '/* controlled production bundle */\nmodule.exports = {};\n');
}

function packageFixture(options) {
	return packageRelease({ environment: {}, ...options });
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`);
}

function assertThrows(callback, code, message) {
	try {
		callback();
		fail(message);
	} catch (error) {
		assert(error instanceof ReleasePackageError && error.code === code, `${message} (wrong failure)`);
	}
}

function assert(condition, message) {
	if (!condition) fail(message);
}

function fail(message) {
	failures.push(message);
}
