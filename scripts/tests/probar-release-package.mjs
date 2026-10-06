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

import { createHash } from 'node:crypto';

import {
	createHebraManifest,
	hebraVersionFromTag,
	packageRelease,
	ReleasePackageError,
	RELEASE_FILES,
	STAGED_RELEASE_FILES,
	validateHebraManifest,
	validateReleaseArchive,
} from '../release-package.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-release-package-'));
const failures = [];

try {
	testDeterministicPackage();
	testHebraManifestIsGenerated();
	testHebraBuildIsCausal();
	testHebraManifestValidation();
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
		JSON.stringify(readdirSync(second.stageRoot).sort()) === JSON.stringify([...STAGED_RELEASE_FILES].sort()),
		'stage did not contain exactly the three Obsidian files and the three Hebra files',
	);
	assert(!readdirSync(second.stageRoot).includes('versions.json'), 'versions.json was packaged despite not being a BRAT release asset');
	assert(JSON.stringify(second.files) === JSON.stringify([...RELEASE_FILES]), 'the ZIP file list grew past the three Obsidian files');
	process.stdout.write(`PASS: reproducible package restored green with ${second.files.length} explicit files\n`);
}

/** `hebra.json` comes out of the package run: the manifest identity, the tag version, the agreed
 *  declaration and the sha256 of the two Hebra files actually staged, and Hebra's rules accept it. */
function testHebraManifestIsGenerated() {
	const root = fixture('hebra-manifest');
	const result = packageFixture({ root, build: controlledBuild, environment: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: '0.1.0' } });
	const staged = JSON.parse(readFileSync(resolve(result.stageRoot, 'hebra.json'), 'utf8'));
	const sha = (name) => `sha256:${createHash('sha256').update(readFileSync(resolve(result.stageRoot, name))).digest('hex')}`;
	const expected = {
		schema: 1,
		id: 'tyrian-companion',
		name: 'Tyrian Companion',
		version: '0.1.0',
		apiVersion: '^1.0.0',
		description: 'El compañero de Guild Wars 2: sesiones, inventario y precios, dentro de Hebra.',
		author: 'Test',
		repo: 'fodaveg/tyrian-companion',
		platforms: ['macos', 'ios', 'linux', 'windows', 'web'],
		main: 'hebra-main.mjs',
		styles: 'hebra-styles.css',
		icon: 'sword',
		capabilities: { required: ['vault.read', 'vault.write', 'editor'], optional: ['http', 'secrets', 'tcp', 'notify.system', 'background'] },
		network: { hosts: ['api.guildwars2.com', 'api.datawars2.ie'], userHosts: true },
		shared: {},
		files: { 'hebra-main.mjs': sha('hebra-main.mjs'), 'hebra-styles.css': sha('hebra-styles.css') },
		ageRating: '4+',
	};
	assert(JSON.stringify(staged) === JSON.stringify(expected), `generated hebra.json differs: ${JSON.stringify(staged)}`);
	assert(validateHebraManifest(staged).length === 0, `Hebra's rules reject the generated hebra.json: ${validateHebraManifest(staged).join('; ')}`);
	assert(JSON.stringify(result.hebraManifest) === JSON.stringify(expected), 'the package result does not report the hebra.json it wrote');
	assert(readFileSync(resolve(root, 'hebra.json'), 'utf8').includes('\t"schema": 1'), 'hebra.json is not written with tabs like the repository JSON');
	const archive = readFileSync(result.archivePath);
	assert(archive.indexOf('hebra-main.mjs') < 0 && archive.indexOf('hebra.json') < 0, 'the manual-install ZIP carries Hebra files');
	process.stdout.write('PASS: hebra.json is generated from manifest.json with the sha256 of the staged Hebra files\n');
}

/** A Hebra build that writes nothing, or a stale Hebra bundle from an earlier build, never reaches the stage. */
function testHebraBuildIsCausal() {
	const root = fixture('hebra-build-causal');
	writeFileSync(resolve(root, 'hebra-main.mjs'), 'stale hebra bundle');
	writeFileSync(resolve(root, 'hebra-styles.css'), '.stale {}');
	writeFileSync(resolve(root, 'hebra.json'), '{}');
	assertThrows(
		() => packageFixture({ root, build: controlledBuild, buildHebra: () => undefined }),
		'build-output-missing',
		'no-op Hebra build did not turn red after the stale Hebra files were removed',
	);
	for (const name of ['hebra-main.mjs', 'hebra-styles.css', 'hebra.json']) {
		assert(!existsSync(resolve(root, name)), `a failed Hebra build left ${name} behind`);
	}
	assert(!existsSync(resolve(root, '.release')), 'failed Hebra build left a release directory');
	process.stdout.write('PASS: no-op Hebra build sabotage turned red before staging\n');
}

/** The ported rules of Hebra's `parsePluginManifest` turn red on what Hebra rejects. */
function testHebraManifestValidation() {
	const valid = createHebraManifest({
		manifest: { id: 'tyrian-companion', name: 'Tyrian Companion', author: 'Test' },
		packageJson: { repository: { type: 'git', url: 'https://github.com/fodaveg/tyrian-companion.git' } },
		version: '1.2.3',
		files: { 'hebra-main.mjs': Buffer.from('a'), 'hebra-styles.css': Buffer.from('b') },
	});
	assert(validateHebraManifest(valid).length === 0, `a valid manifest was rejected: ${validateHebraManifest(valid).join('; ')}`);
	const cases = [
		['schema 2', { schema: 2 }, 'schema'],
		['reserved id', { id: 'bases' }, 'id'],
		['loose version', { version: 'v1.2.3' }, 'version'],
		['no api range', { apiVersion: 'latest' }, 'apiVersion'],
		['unknown platform', { platforms: ['macos', 'amiga'] }, 'platforms'],
		['main outside files', { main: 'other.mjs' }, 'main'],
		['path in a file name', { files: { '../hebra-main.mjs': valid.files['hebra-main.mjs'] } }, 'files'],
		['upper-case hash', { files: { ...valid.files, 'hebra-main.mjs': valid.files['hebra-main.mjs'].toUpperCase() } }, 'files'],
		['wildcard host', { network: { hosts: ['*'], userHosts: true } }, 'network.hosts'],
		['userHosts not boolean', { network: { hosts: [], userHosts: 'yes' } }, 'network.userHosts'],
		['icon with spaces', { icon: 'a sword' }, 'icon'],
		['age without +', { ageRating: '4' }, 'ageRating'],
	];
	for (const [label, patch, field] of cases) {
		const errors = validateHebraManifest({ ...valid, ...patch });
		assert(errors.some((error) => error.startsWith(field)), `${label} was not rejected on ${field}: [${errors.join('; ')}]`);
	}
	assert(hebraVersionFromTag('1.2.3', { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' }) === '1.2.3', 'a v-prefixed tag kept its v');
	assert(hebraVersionFromTag('1.2.3', { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }) === '1.2.3', 'a branch build did not use the manifest version');
	process.stdout.write(`PASS: ${String(cases.length)} invalid hebra.json cases each turned red\n`);
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
	writeJson(resolve(root, 'package.json'), {
		name: 'tyrian-companion',
		version: '0.1.0',
		repository: { type: 'git', url: 'https://github.com/fodaveg/tyrian-companion.git' },
	});
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

/** What `npm run build:host-esm` leaves at the root, without running it. */
function controlledHebraBuild(root) {
	writeFileSync(resolve(root, 'hebra-main.mjs'), '/* controlled hebra bundle */\nexport function activate() {}\n');
	writeFileSync(resolve(root, 'hebra-styles.css'), '.hebra-host {}\n\n.tyrian-test { color: red; }\n\n');
}

function packageFixture(options) {
	return packageRelease({ environment: {}, buildHebra: controlledHebraBuild, ...options });
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
