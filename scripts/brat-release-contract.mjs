import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/u;

/** Returns the only asset names accepted for a published BRAT release. */
export function expectedBratReleaseAssets(manifest) {
	return [
		'main.js',
		'manifest.json',
		'styles.css',
		`${manifest.id}-${manifest.version}.zip`,
		`${manifest.id}-${manifest.version}.zip.sha256`,
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

	const actualAssets = inspectReleaseAssets(release.assets);
	if (actualAssets.finding !== null) {
		findings.push(actualAssets.finding);
	} else if (!sameStrings(actualAssets.names.sort(), expectedBratReleaseAssets(manifest))) {
		findings.push('release-asset-set');
	}

	return findings;
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
	if (argv.length !== 2 || argv[0] !== '--release-json' || argv[1].trim() === '') {
		throw new Error('usage');
	}
	return argv[1];
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
		const releaseSource = parseArguments(argv);
		const manifest = parseJson(readManifestSource(root), 'manifest-json');
		const release = parseJson(readReleaseSource(releaseSource), 'release-json');
		const findings = validateBratRelease({ manifest, release });
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
