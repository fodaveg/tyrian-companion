import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/u;
/** The Hebra files `hebra.json` hashes in its `files` map (the manifest does not hash itself). */
const HEBRA_HASHED_FILES = Object.freeze(['hebra-main.mjs', 'hebra-styles.css']);
/**
 * Minisign signature of the bytes of `hebra.json`. Hebra only installs a plugin whose release carries it.
 * The author's private key lives only on the author's machine, so it is uploaded locally AFTER the
 * workflow publishes the release (`npm run release:sign`); the contract accepts it and, with
 * `--require-signature`, demands it.
 */
const HEBRA_SIGNATURE_ASSET = 'hebra.json.minisig';

/**
 * Returns the only asset names accepted for a published release: the three Obsidian files BRAT
 * downloads, the manual-install ZIP and its checksum, and the three files Hebra downloads to install
 * Tyrian as an external plugin (`hebra.json`, `hebra-main.mjs`, `hebra-styles.css`; Hebra's
 * SPEC-PLUGINS-EXTERNOS.md section 3.1). Eight in all; `hebra.json.minisig` is the one optional ninth.
 */
export function expectedBratReleaseAssets(manifest) {
	return [
		'main.js',
		'manifest.json',
		'styles.css',
		`${manifest.id}-${manifest.version}.zip`,
		`${manifest.id}-${manifest.version}.zip.sha256`,
		'hebra.json',
		'hebra-main.mjs',
		'hebra-styles.css',
	].sort();
}

/** Validates GitHub's release metadata without making a network request. */
export function validateBratRelease({ manifest, release, requireSignature = false }) {
	const findings = [];
	if (!isRecord(manifest) || !isSafePluginId(manifest.id) || !SEMVER.test(manifest.version ?? '')) {
		return ['manifest-invalid'];
	}
	if (!isRecord(release)) return ['release-invalid'];

	if (release.tagName !== manifest.version) findings.push('tag-manifest-mismatch');
	if (release.name !== manifest.version) findings.push('release-name-mismatch');
	if (release.isDraft !== false) findings.push('release-not-published');
	// A prerelease is not what BRAT's stable channel installs and Hebra's updater treats it differently.
	// `!== false`, like the draft check: a payload that does not say (an old `gh release view --json`
	// field list) is red, not assumed stable.
	if (release.isPrerelease !== false) findings.push('release-prerelease');

	const actualAssets = inspectReleaseAssets(release.assets);
	if (actualAssets.finding !== null) {
		findings.push(actualAssets.finding);
	} else {
		const withoutSignature = actualAssets.names.filter((name) => name !== HEBRA_SIGNATURE_ASSET).sort();
		if (!sameStrings(withoutSignature, expectedBratReleaseAssets(manifest))) findings.push('release-asset-set');
		if (requireSignature && !actualAssets.names.includes(HEBRA_SIGNATURE_ASSET)) findings.push('release-signature-missing');
	}

	return findings;
}

/**
 * Judges the bytes of a release that has been DOWNLOADED into `directory` (`gh release download`),
 * which the metadata alone cannot see (HP-11):
 * - the downloaded `manifest.json` (what BRAT reads) is readable, has the expected `id` and its `version` is
 *   the release tag; the `.zip.sha256` declares the sha256 of the downloaded ZIP and its name;
 * - `hebra.json` is readable and declares the version of `manifest.json`;
 * - the sha256 it declares for `hebra-main.mjs` and `hebra-styles.css` is the sha256 of the files
 *   actually published, which is what Hebra checks before installing;
 * - when GitHub reports a `digest` for an asset, the downloaded bytes match it.
 * Reads local files only, makes no network request.
 */
export function validateDownloadedHebraAssets({ manifest, release, directory }) {
	const findings = [];
	// BRAT reads the version from the PUBLISHED `manifest.json`, not from the local one this run compares against.
	const published = readDownloadedJson(resolve(directory, 'manifest.json'));
	if (!isRecord(published)) {
		findings.push('published-manifest-unreadable');
	} else if (published.id !== manifest.id || published.version !== (isRecord(release) ? release.tagName : undefined)) {
		findings.push('published-manifest-mismatch');
	}
	// `<zip>.sha256` is `<sha256 of the zip>  <zip name>` (`release-package.mjs`).
	const zipName = `${manifest.id}-${manifest.version}.zip`;
	const zipHash = sha256OfFile(resolve(directory, zipName));
	const declaredChecksum = readDownloadedText(resolve(directory, `${zipName}.sha256`))?.match(/^([0-9a-f]{64}) {2}(.+?)\n?$/u);
	if (zipHash === null || declaredChecksum === null || declaredChecksum === undefined || declaredChecksum[1] !== zipHash || declaredChecksum[2] !== zipName) {
		findings.push('zip-checksum-mismatch');
	}
	const hebra = readDownloadedJson(resolve(directory, 'hebra.json'));
	if (!isRecord(hebra)) {
		findings.push('hebra-manifest-unreadable');
	} else {
		if (hebra.version !== manifest.version) findings.push('hebra-manifest-version');
		const declared = isRecord(hebra.files) ? hebra.files : {};
		for (const name of HEBRA_HASHED_FILES) {
			const actual = sha256OfFile(resolve(directory, name));
			if (actual === null || declared[name] !== `sha256:${actual}`) {
				findings.push('hebra-manifest-hash');
				break;
			}
		}
	}
	const assets = isRecord(release) && Array.isArray(release.assets) ? release.assets : [];
	for (const asset of assets) {
		if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.digest !== 'string') continue;
		const actual = sha256OfFile(resolve(directory, asset.name));
		if (actual === null || asset.digest !== `sha256:${actual}`) {
			findings.push('release-asset-digest');
			break;
		}
	}
	return findings;
}

function readDownloadedText(path) {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

function readDownloadedJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

function sha256OfFile(path) {
	try {
		return createHash('sha256').update(readFileSync(path)).digest('hex');
	} catch {
		return null;
	}
}

function inspectReleaseAssets(assets) {
	if (!Array.isArray(assets)) return { finding: 'release-assets-invalid', names: [] };
	const names = [];
	for (const asset of assets) {
		if (!isRecord(asset) || typeof asset.name !== 'string' || asset.name.trim() === '') {
			return { finding: 'release-assets-invalid', names: [] };
		}
		names.push(asset.name);
		if (asset.state !== 'uploaded') return { finding: 'release-asset-incomplete', names: [] };
		if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
			return { finding: 'release-asset-empty', names: [] };
		}
	}
	if (new Set(names).size !== names.length) return { finding: 'release-assets-invalid', names: [] };
	return { finding: null, names };
}

function sameStrings(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePluginId(value) {
	return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function parseJson(source, category) {
	try {
		return JSON.parse(source);
	} catch {
		throw new Error(category);
	}
}

function parseArguments(argv) {
	const args = [...argv];
	const requireSignature = args[0] === '--require-signature';
	if (requireSignature) args.shift();
	const validShape = (args.length === 2 || args.length === 4) && args[0] === '--release-json' && args[1].trim() !== '';
	const withAssets = args.length === 4;
	if (!validShape || (withAssets && (args[2] !== '--assets-dir' || args[3].trim() === ''))) {
		throw new Error('usage');
	}
	return { releaseSource: args[1], assetsDirectory: withAssets ? args[3] : null, requireSignature };
}

function readReleaseSource(source) {
	try {
		return source === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(source), 'utf8');
	} catch {
		throw new Error('release-json-unavailable');
	}
}

function readManifestSource(root) {
	try {
		return readFileSync(resolve(root, 'manifest.json'), 'utf8');
	} catch {
		throw new Error('manifest-unavailable');
	}
}

export function runCli({ argv = process.argv.slice(2), root = process.cwd() } = {}) {
	try {
		const { releaseSource, assetsDirectory, requireSignature } = parseArguments(argv);
		const manifest = parseJson(readManifestSource(root), 'manifest-json');
		const release = parseJson(readReleaseSource(releaseSource), 'release-json');
		const findings = validateBratRelease({ manifest, release, requireSignature });
		if (assetsDirectory !== null) {
			findings.push(...validateDownloadedHebraAssets({ manifest, release, directory: resolve(assetsDirectory) }));
		}
		if (findings.length > 0) {
			for (const finding of findings) process.stderr.write(`BRAT release contract: ${finding}\n`);
			return 1;
		}
		const signed = release.assets.some((asset) => asset.name === HEBRA_SIGNATURE_ASSET);
		process.stdout.write(
			`BRAT release contract: PASS (version=${manifest.version}; assets=${release.assets.length}; signature=${signed ? 'present' : 'absent'}; downloaded-bytes=${assetsDirectory === null ? 'not-checked' : 'checked'})\n`,
		);
		return 0;
	} catch (error) {
		const category = error instanceof Error ? error.message : 'unexpected-failure';
		process.stderr.write(`BRAT release contract: ${category}\n`);
		return 1;
	}
}

const isDirectExecution = process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = runCli();
