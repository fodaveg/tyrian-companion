import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const suitePath = resolve(process.argv[1]);
const repositoryRoot = resolve(import.meta.dirname, '../..');
const guardrail = process.env.BRAT_RELEASE_CONTRACT_UNDER_TEST ??
	resolve(repositoryRoot, 'scripts/brat-release-contract.mjs');
const testRoot = mkdtempSync(resolve(tmpdir(), 'tyrian-brat-release-contract-'));
let failures = 0;

try {
	const fixtureRoot = resolve(testRoot, 'repository');
	initializeRepository(fixtureRoot);
	const releasePath = resolve(fixtureRoot, 'release.json');
	const originalRelease = releaseMetadata();
	writeFileSync(releasePath, `${JSON.stringify(originalRelease)}\n`);
	commitFixture(fixtureRoot);

	const original = snapshotFile(fixtureRoot, releasePath);
	assertGreen(fixtureRoot, releasePath, 'matching published release');
	assertStdinGreen(fixtureRoot, originalRelease);

	writeFileSync(releasePath, `${JSON.stringify(releaseMetadata({ name: 'Tyrian Companion 0.1.19' }))}\n`);
	const red = runGuardrail(fixtureRoot, releasePath);
	if (red.status === 0 || !red.stderr.includes('release-name-mismatch')) {
		fail('release title different from tag and manifest did not turn red');
	} else {
		process.stdout.write('PASS: release title sabotage turned red: release-name-mismatch\n');
	}

	writeFileSync(releasePath, original.bytes);
	chmodSync(releasePath, original.mode);
	assertRestored(fixtureRoot, releasePath, original);
	assertGreen(fixtureRoot, releasePath, 'restored release metadata');

	assertRed(
		fixtureRoot,
		releaseMetadata({ tagName: 'v0.1.19' }),
		'tag-manifest-mismatch',
		'tag with v prefix',
	);
	assertRed(
		fixtureRoot,
		releaseMetadata({ isDraft: true }),
		'release-not-published',
		'draft release',
	);
	assertRed(
		fixtureRoot,
		releaseMetadata({ isPrerelease: true }),
		'release-prerelease',
		'prerelease',
	);
	const { isPrerelease: _omitted, ...withoutPrereleaseField } = releaseMetadata();
	assertRed(
		fixtureRoot,
		withoutPrereleaseField,
		'release-prerelease',
		'release metadata that does not say whether it is a prerelease',
	);
	assertDownloadedAssets(fixtureRoot);
	assertRed(
		fixtureRoot,
		releaseMetadata({ assets: releaseAssets().slice(0, -1) }),
		'release-asset-set',
		'missing BRAT asset',
	);
	assertRed(
		fixtureRoot,
		releaseMetadata({ assets: releaseAssets().filter((asset) => !asset.name.startsWith('hebra')) }),
		'release-asset-set',
		'release with only the five Obsidian assets (no Hebra plugin files)',
	);
	assertRed(
		fixtureRoot,
		releaseMetadata({ assets: [...releaseAssets(), { name: 'versions.json', state: 'uploaded', size: 1 }] }),
		'release-asset-set',
		'extra release asset',
	);
	assertRed(
		fixtureRoot,
		releaseMetadata({ assets: releaseAssets({ index: 0, state: 'starter' }) }),
		'release-asset-incomplete',
		'incomplete release asset',
	);
	assertRed(
		fixtureRoot,
		releaseMetadata({ assets: releaseAssets({ index: 1, size: 0 }) }),
		'release-asset-empty',
		'empty release asset',
	);

	if (process.env.BRAT_RELEASE_CONTRACT_NEGATIVE_CONTROL !== '1') {
		const noOp = resolve(testRoot, 'always-green.mjs');
		writeFileSync(noOp, 'process.exit(0);\n');
		const control = spawnSync(process.execPath, [suitePath], {
			cwd: repositoryRoot,
			encoding: 'utf8',
			env: {
				...process.env,
				BRAT_RELEASE_CONTRACT_NEGATIVE_CONTROL: '1',
				BRAT_RELEASE_CONTRACT_UNDER_TEST: noOp,
			},
		});
		if (control.error) {
			fail('negative control could not execute');
		} else if (control.status === 0) {
			fail('suite stayed green after replacing the guardrail with a no-op');
		} else {
			process.stdout.write('PASS: negative control turned red with an always-green guardrail\n');
		}
	}
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures > 0) {
	process.stderr.write(`BRAT release contract suite: ${failures} failure(s)\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('BRAT release contract suite: PASS\n');
}

function initializeRepository(root) {
	const result = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error('could not initialize fixture repository');
	writeFileSync(resolve(root, 'manifest.json'), `${JSON.stringify({ id: 'tyrian-companion', version: '0.1.19' })}\n`);
	spawnGit(root, ['config', 'user.name', 'BRAT Contract Test']);
	spawnGit(root, ['config', 'user.email', 'brat-contract@example.invalid']);
}

function commitFixture(root) {
	spawnGit(root, ['add', 'manifest.json', 'release.json']);
	spawnGit(root, ['commit', '-q', '-m', 'fixture']);
}

function spawnGit(root, args) {
	const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`fixture git command failed: ${args[0]}`);
	return result.stdout;
}

function snapshotFile(root, path) {
	const fileStat = statSync(path);
	return {
		bytes: readFileSync(path),
		mode: fileStat.mode & 0o777,
		status: spawnGit(root, ['status', '--porcelain=v1', '--', 'release.json']),
	};
}

function assertRestored(root, path, expected) {
	const actual = snapshotFile(root, path);
	if (!actual.bytes.equals(expected.bytes) || actual.mode !== expected.mode || actual.status !== expected.status) {
		fail('sabotaged fixture did not recover exact bytes, mode and Git state');
	} else {
		process.stdout.write('PASS: sabotage restored exact bytes, mode and Git state\n');
	}
}

function runGuardrail(root, releasePath) {
	return spawnSync(process.execPath, [guardrail, '--release-json', releasePath], {
		cwd: root,
		encoding: 'utf8',
	});
}

function assertGreen(root, releasePath, label) {
	const result = runGuardrail(root, releasePath);
	if (result.error) {
		fail(`${label} could not execute the guardrail`);
	} else if (result.status !== 0 || result.stdout !== 'BRAT release contract: PASS (version=0.1.19; assets=8)\n') {
		fail(`${label} was rejected`);
	}
}

function assertStdinGreen(root, release) {
	const result = spawnSync(process.execPath, [guardrail, '--release-json', '-'], {
		cwd: root,
		encoding: 'utf8',
		input: `${JSON.stringify(release)}\n`,
	});
	if (result.error || result.status !== 0 ||
		result.stdout !== 'BRAT release contract: PASS (version=0.1.19; assets=8)\n') {
		fail('published-release stdin flow was rejected');
	}
}

/**
 * HP-11, the half the metadata cannot see: with the release downloaded, `hebra.json` has to declare the
 * manifest version and the sha256 of the Hebra files that were really published, and any asset whose
 * `digest` GitHub reported has to match the bytes. One green case and one red per finding.
 */
function assertDownloadedAssets(root) {
	const build = (name, { version = '0.1.19', mainBytes = 'export const activate = 1;\n', declaredMain } = {}) => {
		const directory = resolve(testRoot, `assets-${name}`);
		mkdirSync(directory, { recursive: true });
		const stylesBytes = '.tyrian{}\n';
		writeFileSync(resolve(directory, 'hebra-main.mjs'), mainBytes);
		writeFileSync(resolve(directory, 'hebra-styles.css'), stylesBytes);
		const manifest = {
			version,
			files: {
				'hebra-main.mjs': declaredMain ?? `sha256:${sha256(mainBytes)}`,
				'hebra-styles.css': `sha256:${sha256(stylesBytes)}`,
			},
		};
		writeFileSync(resolve(directory, 'hebra.json'), JSON.stringify(manifest));
		return directory;
	};
	const withDigests = (directory) => releaseMetadata({
		assets: releaseAssets().map((asset) => {
			try {
				return { ...asset, digest: `sha256:${sha256(readFileSync(resolve(directory, asset.name)))}` };
			} catch {
				return asset;
			}
		}),
	});
	const cases = [
		['green: consistent hebra.json and digests', build('green'), null, null],
		['hebra.json with another version', build('version', { version: '0.1.18' }), 'hebra-manifest-version', null],
		['hebra.json declaring another sha256 for hebra-main.mjs', build('hash', { declaredMain: `sha256:${'0'.repeat(64)}` }), 'hebra-manifest-hash', null],
		['a published hebra-main.mjs that GitHub digests differently', build('digest'), 'release-asset-digest', 'tamper'],
		['a download without hebra.json', build('missing'), 'hebra-manifest-unreadable', 'remove'],
	];
	for (const [label, directory, category, mutation] of cases) {
		const release = withDigests(directory);
		if (mutation === 'tamper') writeFileSync(resolve(directory, 'hebra-main.mjs'), 'tampered\n');
		if (mutation === 'remove') rmSync(resolve(directory, 'hebra.json'));
		const path = resolve(testRoot, `downloaded-${category ?? 'green'}.json`);
		writeFileSync(path, `${JSON.stringify(release)}\n`);
		const result = spawnSync(process.execPath, [guardrail, '--release-json', path, '--assets-dir', directory], { cwd: root, encoding: 'utf8' });
		if (result.error) fail(`${label}: could not execute the guardrail`);
		else if (category === null && (result.status !== 0 || !result.stdout.includes('PASS'))) fail(`${label} was rejected: ${result.stderr}`);
		else if (category !== null && (result.status === 0 || !result.stderr.includes(`BRAT release contract: ${category}\n`))) fail(`${label} did not turn red as ${category}`);
		else process.stdout.write(`PASS: ${label}${category === null ? '' : ` turned red: ${category}`}\n`);
	}
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function assertRed(root, release, category, label) {
	const path = resolve(testRoot, `${category}.json`);
	writeFileSync(path, `${JSON.stringify(release)}\n`);
	const result = runGuardrail(root, path);
	if (result.error) {
		fail(`${label} could not execute the guardrail`);
	} else if (result.status === 0 || !result.stderr.includes(`BRAT release contract: ${category}\n`)) {
		fail(`${label} did not turn red as ${category}`);
	} else {
		process.stdout.write(`PASS: ${label} turned red: ${category}\n`);
	}
}

function releaseMetadata(overrides = {}) {
	return {
		tagName: '0.1.19',
		name: '0.1.19',
		isDraft: false,
		isPrerelease: false,
		assets: releaseAssets(),
		...overrides,
	};
}

function releaseAssets(sabotage = null) {
	return [
		'main.js',
		'manifest.json',
		'styles.css',
		'tyrian-companion-0.1.19.zip',
		'tyrian-companion-0.1.19.zip.sha256',
		'hebra.json',
		'hebra-main.mjs',
		'hebra-styles.css',
	].map((name, index) => ({
		name,
		state: sabotage?.index === index && sabotage.state !== undefined ? sabotage.state : 'uploaded',
		size: sabotage?.index === index && sabotage.size !== undefined ? sabotage.size : index + 1,
	}));
}

function fail(message) {
	failures += 1;
	process.stderr.write(`FAIL: ${message}\n`);
}
