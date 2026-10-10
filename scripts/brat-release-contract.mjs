import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/u;
/** The Hebra files `hebra.json` hashes in its `files` map (the manifest does not hash itself). */
const HEBRA_HASHED_FILES = Object.freeze(['hebra-main.mjs', 'hebra-styles.css']);

/**
 * Returns the only asset names accepted for a published release: the three Obsidian files BRAT
 * downloads, the manual-install ZIP and its checksum, and the three files Hebra downloads to install
 * Tyrian as an external plugin (`hebra.json`, `hebra-main.mjs`, `hebra-styles.css`; Hebra's
 * SPEC-PLUGINS-EXTERNOS.md section 3.1). Eight in all.
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
export function validateBratRelease({ manifest, release }) {
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
	} else if (!sameStrings(actualAssets.names.sort(), expectedBratReleaseAssets(manifest))) {
		findings.push('release-asset-set');
	}

	return findings;
}

/**
 * Judges the bytes of a release that has been DOWNLOADED into `directory` (`gh release download`),
 * which the metadata alone cannot see (HP-11):
 * - `hebra.json` is readable and declares the version of `manifest.json`;
 * - the sha256 it declares for `hebra-main.mjs` and `hebra-styles.css` is the sha256 of the files
 *   actually published, which is what Hebra checks before installing;
 * - when GitHub reports a `digest` for an asset, the downloaded bytes match it.
 * Reads local files only, makes no network request.
 */
export function validateDownloadedHebraAssets({ manifest, release, directory }) {
	const findings = [];
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
	const validShape = (argv.length === 2 || argv.length === 4) && argv[0] === '--release-json' && argv[1].trim() !== '';
	const withAssets = argv.length === 4;
	if (!validShape || (withAssets && (argv[2] !== '--assets-dir' || argv[3].trim() === ''))) {
		throw new Error('usage');
	}
	return { releaseSource: argv[1], assetsDirectory: withAssets ? argv[3] : null };
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
		const { releaseSource, assetsDirectory } = parseArguments(argv);
		const manifest = parseJson(readManifestSource(root), 'manifest-json');
		const release = parseJson(readReleaseSource(releaseSource), 'release-json');
		const findings = validateBratRelease({ manifest, release });
		if (assetsDirectory !== null) {
			findings.push(...validateDownloadedHebraAssets({ manifest, release, directory: resolve(assetsDirectory) }));
		}
		if (findings.length > 0) {
			for (const finding of findings) process.stderr.write(`BRAT release contract: ${finding}\n`);
			return 1;
		}
		process.stdout.write(
			`BRAT release contract: PASS (version=${manifest.version}; assets=${expectedBratReleaseAssets(manifest).length})\n`,
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
