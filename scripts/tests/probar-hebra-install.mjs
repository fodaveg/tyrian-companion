import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	HebraInstallError,
	defaultHebraPluginsDirectory,
	parseHebraInstallArguments,
	verifyHebraInstall,
} from '../verify-hebra-install.mjs';

// Everything here runs against a directory this suite builds in the temp folder: it never reads the
// plugins directory of a real Hebra and never calls `gh` (the release reader is injected).
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-hebra-install-'));
const failures = [];
const BYTES = { 'hebra.json': '', 'hebra-main.mjs': 'export const main = 1;\n', 'hebra-styles.css': '.tc-x{}\n' };
// As in the real thing: the manifest lists the hashes of the two code files and never its own.
BYTES['hebra.json'] = manifestText('0.6.35');

try {
	testMatchingInstallPasses();
	testReleaseDigestMismatchIsRed();
	testReleaseAssetProblemsAreRed();
	testRegistryProblemsAreRed();
	testFilesOnDiskProblemsAreRed();
	testOptOutOfTheReleaseCheckSkipsGh();
	testGhIsNamedTheRepository();
	testArgumentsAndPlatformDefaults();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`hebra install suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('hebra install suite: PASS\n');
}

function testMatchingInstallPasses() {
	const dir = fakeHebra('pass');
	const result = verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => releaseAssets() });
	assert(result.version === '0.6.35' && result.previous === '0.6.34' && result.releaseChecked === true,
		'a registry, files and release that agree did not pass');
	let asked = null;
	verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: ({ tag }) => { asked = tag; return releaseAssets(); } });
	assert(asked === '0.6.35', `the release was asked for ${String(asked)} instead of the installed version`);
	verifyHebraInstall({ pluginsDir: dir, releaseTag: '0.6.34', readReleaseAssets: ({ tag }) => { asked = tag; return JSON.parse(releaseAssets()); } });
	assert(asked === '0.6.34', `an explicit --release-tag 0.6.34 asked the release ${String(asked)}`);
}

function testReleaseDigestMismatchIsRed() {
	for (const name of Object.keys(BYTES)) {
		assertCode(
			() => verifyHebraInstall({ pluginsDir: fakeHebra(`digest-${name}`), readReleaseAssets: () => releaseAssets({ [name]: 'other bytes' }) }),
			'installed-asset-mismatch', `${name} with other bytes than the release stayed green`,
		);
	}
}

function testReleaseAssetProblemsAreRed() {
	const dir = fakeHebra('release-problems');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => releaseAssets({}, ['hebra-styles.css']) }),
		'release-asset-missing', 'a release without hebra-styles.css stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => JSON.stringify({ assets: [{ name: 'hebra.json' }, { name: 'hebra-main.mjs' }, { name: 'hebra-styles.css' }] }) }),
		'release-digest-missing', 'a release without digests stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => 'not json' }),
		'release-unavailable', 'an unreadable release stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: dir, readReleaseAssets: () => { throw new HebraInstallError('release-unavailable'); } }),
		'release-unavailable', 'a failing gh stayed green');
}

function testRegistryProblemsAreRed() {
	const cases = [
		['no-registry', { registry: null }, 'registry-missing'],
		['bad-json', { registry: '{nope' }, 'registry-invalid'],
		['other-schema', { registry: { schema: 2, plugins: [] } }, 'registry-invalid'],
		['not-installed', { registry: { schema: 1, plugins: [{ id: 'other', version: '1.0.0', files: {} }] } }, 'plugin-not-installed'],
		['bad-version', { record: { version: 'latest' } }, 'registry-invalid'],
		['registry-hash', { record: { files: { ...registryFiles(), 'hebra-main.mjs': `sha256:${'0'.repeat(64)}` } } }, 'registry-hash-mismatch'],
		['registry-no-hash', { record: { files: { 'hebra-main.mjs': registryFiles()['hebra-main.mjs'] } } }, 'registry-files-unexpected'],
		// Hebra's record.files is manifest.files, which never lists hebra.json: asking for it again would make every real install red.
		['registry-with-hebra-json', { record: { files: { ...registryFiles(), 'hebra.json': `sha256:${sha(BYTES['hebra.json'])}` } } }, 'registry-files-unexpected'],
		['no-version-dir', { skipFiles: true }, 'version-directory-missing'],
	];
	for (const [name, options, code] of cases) {
		assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra(`registry-${name}`, options), readReleaseAssets: () => releaseAssets() }),
			code, `registry case ${name} did not fail with ${code}`);
	}
}

function testFilesOnDiskProblemsAreRed() {
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-missing', { omit: ['hebra-styles.css'] }), readReleaseAssets: () => releaseAssets() }),
		'installed-file-missing', 'an installed version without hebra-styles.css stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-tampered', { disk: { 'hebra-main.mjs': 'tampered' } }), readReleaseAssets: () => releaseAssets() }),
		'registry-hash-mismatch', 'a file that no longer matches the registry stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-manifest-version', { disk: { 'hebra.json': manifestText('0.6.34') } }), readReleaseAssets: () => releaseAssets() }),
		'hebra-manifest-version', 'a hebra.json of another version stayed green');
	const otherFiles = manifestText('0.6.35', { 'hebra-main.mjs': `sha256:${'1'.repeat(64)}`, 'hebra-styles.css': `sha256:${'2'.repeat(64)}` });
	assertCode(() => verifyHebraInstall({ pluginsDir: fakeHebra('disk-manifest-files', { disk: { 'hebra.json': otherFiles } }), readReleaseAssets: () => releaseAssets() }),
		'registry-manifest-files-mismatch', 'a hebra.json whose files differ from the registry stayed green');
	assertCode(() => verifyHebraInstall({ pluginsDir: join(testRoot, 'does-not-exist'), readReleaseAssets: () => releaseAssets() }),
		'plugins-dir-missing', 'a missing plugins directory stayed green');
}

function testOptOutOfTheReleaseCheckSkipsGh() {
	const result = verifyHebraInstall({
		pluginsDir: fakeHebra('no-release'), releaseCheck: false,
		readReleaseAssets: () => { throw new Error('gh must not be called'); },
	});
	assert(result.releaseChecked === false, 'the opt-out of the release check was not reported');
}

/** The default reader must name the repository: `gh` runs outside any clone. */
function testGhIsNamedTheRepository() {
	const logPath = join(testRoot, 'gh-args.json');
	const ghPath = join(testRoot, 'fake-gh.mjs');
	writeFileSync(ghPath, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(releaseAssets())});\n`);
	chmodSync(ghPath, 0o755);
	verifyHebraInstall({ pluginsDir: fakeHebra('gh-repo'), ghCommand: ghPath });
	const asked = JSON.parse(readFileSync(logPath, 'utf8')).join(' ');
	assert(asked === 'release view 0.6.35 --repo fodaveg/tyrian-companion --json assets', `gh was called as: ${asked}`);
}

function testArgumentsAndPlatformDefaults() {
	assert(defaultHebraPluginsDirectory('win32', '/h') === null, 'Windows got a guessed plugins directory');
	assert(defaultHebraPluginsDirectory('linux', '/h', undefined) === resolve('/h', '.local', 'share', 'net.fodaveg.hebra', 'plugins'), 'Linux default is not the documented one');
	assert(defaultHebraPluginsDirectory('linux', '/h', '/xdg') === resolve('/xdg', 'net.fodaveg.hebra', 'plugins'), 'Linux default ignored XDG_DATA_HOME');
	assert(defaultHebraPluginsDirectory('linux', '/h', 'relative') === resolve('/h', '.local', 'share', 'net.fodaveg.hebra', 'plugins'), 'a relative XDG_DATA_HOME was honoured');
	assert(defaultHebraPluginsDirectory('darwin', '/h') === resolve('/h', 'Library', 'Containers', 'net.fodaveg.hebra', 'Data', 'Library', 'Application Support', 'net.fodaveg.hebra', 'fresh-v1', 'plugins'), 'macOS default is not the sandbox container with fresh-v1');
	const fallback = parseHebraInstallArguments([], { platform: 'linux', home: join(testRoot, 'no-home'), xdgDataHome: undefined });
	assert(fallback.pluginsDirIsDefault === true, 'a default plugins directory was not flagged as such');
	assertCode(() => verifyHebraInstall(fallback), 'plugins-dir-default-missing', 'a missing default directory did not say it was an assumed one');
	assert(parseHebraInstallArguments(['--plugins-dir', '/x'], { platform: 'linux', home: '/h' }).pluginsDirIsDefault === false, 'an explicit directory was flagged as default');
	assertCode(() => parseHebraInstallArguments([], { platform: 'win32', home: '/h' }), 'plugins-dir-required', 'Windows without --plugins-dir did not ask for it');
	const explicit = parseHebraInstallArguments(['--plugins-dir', '/x/plugins', '--release-tag', '0.6.35', '--gh-cli', '/bin/gh'], { platform: 'win32', home: '/h' });
	assert(explicit.pluginsDir === resolve('/x/plugins') && explicit.releaseTag === '0.6.35' && explicit.ghCommand === '/bin/gh' && explicit.releaseCheck === true,
		'explicit arguments were not honoured');
	assertCode(() => parseHebraInstallArguments(['--bogus'], { platform: 'linux', home: '/h' }), 'usage', 'an unknown flag was accepted');
	assertCode(() => parseHebraInstallArguments(['--plugins-dir'], { platform: 'linux', home: '/h' }), 'usage', 'a flag without value was accepted');
	assertCode(() => parseHebraInstallArguments(['--no-release-check', '--release-tag', '0.6.35'], { platform: 'linux', home: '/h' }), 'usage', 'a release tag with the check disabled was accepted');
}

function manifestText(version, files = { 'hebra-main.mjs': `sha256:${sha('export const main = 1;\n')}`, 'hebra-styles.css': `sha256:${sha('.tc-x{}\n')}` }) {
	return JSON.stringify({ schema: 1, id: 'tyrian-companion', version, apiVersion: '1.4.0', files });
}

function sha(text) {
	return createHash('sha256').update(text).digest('hex');
}

/** The `files` of the registry record: `manifest.files`, so only the two code files. */
function registryFiles(changed = {}) {
	return Object.fromEntries(['hebra-main.mjs', 'hebra-styles.css'].map((name) => [name, `sha256:${sha(changed[name] ?? BYTES[name])}`]));
}

/** What `gh release view 0.6.35 --json assets` prints; `changed` replaces the bytes a digest was taken from. */
function releaseAssets(changed = {}, omit = []) {
	return JSON.stringify({
		assets: Object.entries({ ...BYTES, ...changed })
			.filter(([name]) => !omit.includes(name))
			.map(([name, text]) => ({ name, digest: `sha256:${sha(text)}` })),
	});
}

/** A plugins directory shaped like Hebra's (`installed.json` plus `tyrian-companion/<version>/`), all fake. */
function fakeHebra(name, { registry, record = {}, omit = [], disk = {}, skipFiles = false } = {}) {
	const dir = join(testRoot, name, 'plugins');
	mkdirSync(dir, { recursive: true });
	if (registry !== null) {
		const body = registry ?? {
			schema: 1,
			plugins: [{
				id: 'tyrian-companion',
				source: { repo: 'fodaveg/tyrian-companion', listed: true },
				version: '0.6.35',
				previous: '0.6.34',
				files: registryFiles(),
				installedAt: '2026-10-10T00:00:00.000Z',
				apiVersion: '1.4.0',
				manifest: JSON.parse(BYTES['hebra.json']),
				...record,
			}],
		};
		writeFileSync(join(dir, 'installed.json'), typeof body === 'string' ? body : JSON.stringify(body));
	}
	if (!skipFiles) {
		const versionDir = join(dir, 'tyrian-companion', '0.6.35');
		mkdirSync(versionDir, { recursive: true });
		for (const [file, text] of Object.entries({ ...BYTES, ...disk })) {
			if (!omit.includes(file)) writeFileSync(join(versionDir, file), text);
		}
	}
	return dir;
}

function assertCode(run, expectedCode, message) {
	try {
		run();
	} catch (error) {
		if (error instanceof HebraInstallError && error.code === expectedCode) return;
		failures.push(`${message} (got: ${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	failures.push(message);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
