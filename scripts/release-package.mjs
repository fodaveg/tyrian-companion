import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scanReleaseArtifacts } from './security-scan.mjs';

/** The Obsidian plugin files: BRAT assets and the whole content of the manual-install ZIP. */
export const RELEASE_FILES = Object.freeze([
	'manifest.json',
	'main.js',
	'styles.css',
]);

/**
 * The Hebra plugin files (Hebra's SPEC-PLUGINS-EXTERNOS.md section 3.1), published as assets of
 * the same release but NOT in the ZIP, which stays the Obsidian install. `hebra-main.mjs` and
 * `hebra-styles.css` come from `npm run build:host-esm`; `hebra.json` is generated here from
 * `manifest.json`, never by hand.
 */
export const HEBRA_RELEASE_FILES = Object.freeze([
	'hebra.json',
	'hebra-main.mjs',
	'hebra-styles.css',
]);

/** Everything staged under `.release/<id>/`: the BRAT assets that are not the ZIP and its checksum. */
export const STAGED_RELEASE_FILES = Object.freeze([...RELEASE_FILES, ...HEBRA_RELEASE_FILES]);

const HEBRA_MANIFEST_FILE = 'hebra.json';
const HEBRA_MAIN_FILE = 'hebra-main.mjs';
const HEBRA_STYLES_FILE = 'hebra-styles.css';
const HEBRA_GENERATED_FILES = Object.freeze([HEBRA_MANIFEST_FILE, HEBRA_MAIN_FILE, HEBRA_STYLES_FILE]);

/**
 * What `hebra.json` declares beyond what `manifest.json` gives (decided 2026-10-03 with Hebra's
 * session, "Tyrian llega a Hebra como plugin externo"): the API range, where it runs (Android is
 * not measured), the Lucide icon of its row in Hebra (`sword`, which Hebra's own `espada` glyph is
 * drawn from), what it uses of the API, the two fixed hosts plus the user's webhook, and nothing
 * borrowed. The description is Hebra's own for the plugin: `manifest.json`'s speaks of Obsidian.
 */
export const HEBRA_PLUGIN_DECLARATION = Object.freeze({
	apiVersion: '^1.0.0',
	description: 'El compañero de Guild Wars 2: sesiones, inventario y precios, dentro de Hebra.',
	platforms: Object.freeze(['macos', 'ios', 'linux', 'windows', 'web']),
	icon: 'sword',
	capabilities: Object.freeze({
		required: Object.freeze(['vault.read', 'vault.write', 'editor', 'http', 'secrets']),
		optional: Object.freeze(['tcp', 'notify.system', 'background']),
	}),
	network: Object.freeze({ hosts: Object.freeze(['api.guildwars2.com', 'api.datawars2.ie']), userHosts: true }),
	shared: Object.freeze({}),
	ageRating: '4+',
});

const RELEASE_DIRECTORY = '.release';
const DOS_DATE_1980_01_01 = 0x0021;
const UTF8_FLAG = 0x0800;
const ZIP_STORED = 0;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = 0x0314;
const REGULAR_FILE_MODE = 0o100644;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export class ReleasePackageError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ReleasePackageError';
		this.code = code;
	}
}

/** Builds, stages, scans and verifies one deterministic manual-install package. */
export function packageRelease({
	root = process.cwd(),
	build = runProductionBuild,
	buildHebra = runHebraBuild,
	environment = process.env,
	scanArtifacts = scanReleaseArtifacts,
	writeArchive = writeReleaseArchive,
} = {}) {
	const absoluteRoot = resolve(root);
	const releaseRoot = resolve(absoluteRoot, RELEASE_DIRECTORY);
	for (const marker of ['package.json', 'manifest.json', 'versions.json']) {
		assertReleaseFile(resolve(absoluteRoot, marker), marker);
	}
	if (
		absoluteRoot === dirname(absoluteRoot) ||
		dirname(releaseRoot) !== absoluteRoot ||
		basename(releaseRoot) !== RELEASE_DIRECTORY
	) {
		throw new ReleasePackageError('unsafe-output-root', 'release package: unsafe output root');
	}
	rmSync(releaseRoot, { recursive: true, force: true });
	try {
		return packageReleaseInCleanOutput({
			absoluteRoot,
			build,
			buildHebra,
			environment,
			releaseRoot,
			scanArtifacts,
			writeArchive,
		});
	} catch (error) {
		rmSync(releaseRoot, { recursive: true, force: true });
		for (const path of ['main.js', ...HEBRA_GENERATED_FILES]) removeFailedBundle(resolve(absoluteRoot, path));
		throw error;
	}
}

function packageReleaseInCleanOutput({
	absoluteRoot,
	build,
	buildHebra,
	environment,
	releaseRoot,
	scanArtifacts,
	writeArchive,
}) {
	const metadata = readReleaseMetadata(absoluteRoot);
	validateReleaseMetadata(metadata);
	validateCiRef(metadata.manifest.version, environment);
	const stylesPath = resolve(absoluteRoot, 'styles.css');
	assertReleaseFile(stylesPath, 'styles.css');
	const stylesBeforeBuild = readFileSync(stylesPath);

	const bundlePath = resolve(absoluteRoot, 'main.js');
	removePreviousBundle(bundlePath);
	// The Hebra files are generated too: a stale one from an earlier build must never be staged.
	for (const path of HEBRA_GENERATED_FILES) removePreviousBundle(resolve(absoluteRoot, path));
	build(absoluteRoot);
	assertReleaseFile(bundlePath, 'main.js');
	buildHebra(absoluteRoot);
	assertReleaseFile(resolve(absoluteRoot, HEBRA_MAIN_FILE), HEBRA_MAIN_FILE);
	assertReleaseFile(resolve(absoluteRoot, HEBRA_STYLES_FILE), HEBRA_STYLES_FILE);
	const metadataAfterBuild = readReleaseMetadata(absoluteRoot);
	validateReleaseMetadata(metadataAfterBuild);
	validateCiRef(metadataAfterBuild.manifest.version, environment);
	if (
		JSON.stringify(metadataAfterBuild) !== JSON.stringify(metadata) ||
		!readFileSync(stylesPath).equals(stylesBeforeBuild)
	) {
		throw new ReleasePackageError(
			'build-mutated-input',
			'release package: production build mutated a release input',
		);
	}

	const hebraManifest = createHebraManifest({
		manifest: metadataAfterBuild.manifest,
		packageJson: metadataAfterBuild.packageJson,
		version: hebraVersionFromTag(metadataAfterBuild.manifest.version, environment),
		files: {
			[HEBRA_MAIN_FILE]: readFileSync(resolve(absoluteRoot, HEBRA_MAIN_FILE)),
			[HEBRA_STYLES_FILE]: readFileSync(resolve(absoluteRoot, HEBRA_STYLES_FILE)),
		},
	});
	const hebraManifestErrors = validateHebraManifest(hebraManifest);
	if (hebraManifestErrors.length > 0) {
		throw new ReleasePackageError('invalid-hebra-manifest', `release package: hebra.json is invalid (${hebraManifestErrors.join('; ')})`);
	}
	writeFileSync(resolve(absoluteRoot, HEBRA_MANIFEST_FILE), `${JSON.stringify(hebraManifest, null, '\t')}\n`, { mode: 0o644 });

	const stageRoot = resolve(releaseRoot, metadataAfterBuild.manifest.id);
	mkdirSync(stageRoot, { recursive: true });
	for (const path of STAGED_RELEASE_FILES) {
		const source = resolve(absoluteRoot, path);
		assertReleaseFile(source, path);
		const destination = resolve(stageRoot, path);
		copyFileSync(source, destination);
		chmodSync(destination, 0o644);
	}
	assertExactDirectory(stageRoot, STAGED_RELEASE_FILES);
	verifyHebraManifestFiles(stageRoot);

	const securityFindings = scanArtifacts(stageRoot, STAGED_RELEASE_FILES);
	if (securityFindings.length > 0) {
		const finding = securityFindings[0];
		throw new ReleasePackageError(
			'artifact-security',
			`release package: artifact scan failed (${finding.path}: ${finding.rule})`,
		);
	}

	const stagedFiles = RELEASE_FILES.map((path) => ({
		name: path,
		bytes: readFileSync(resolve(stageRoot, path)),
	}));
	const archive = createStoredZip(stagedFiles);
	const archiveName = `${metadataAfterBuild.manifest.id}-${metadataAfterBuild.manifest.version}.zip`;
	const archivePath = resolve(releaseRoot, archiveName);
	writeArchive(archivePath, archive);
	assertReleaseFile(archivePath, archiveName);
	const persistedArchive = readFileSync(archivePath);
	validateReleaseArchive(persistedArchive, stagedFiles);

	const sha256 = sha256Hex(persistedArchive);
	const checksumPath = `${archivePath}.sha256`;
	writeFileSync(checksumPath, `${sha256}  ${archiveName}\n`, { mode: 0o644 });
	validateChecksumFile(checksumPath, archiveName, sha256);

	return {
		archivePath,
		checksumPath,
		files: [...RELEASE_FILES],
		hebraFiles: [...HEBRA_RELEASE_FILES],
		hebraManifest,
		sha256,
		stageRoot,
		version: metadataAfterBuild.manifest.version,
	};
}

function runProductionBuild(root) {
	runNpmScript(root, 'build', 'build-failed', 'release package: production build failed');
}

/** `npm run build:host-esm`: `hebra-main.mjs` and `hebra-styles.css`, with the bundle guard. */
function runHebraBuild(root) {
	runNpmScript(root, 'build:host-esm', 'hebra-build-failed', 'release package: Hebra plugin build failed');
}

function runNpmScript(root, script, code, message) {
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const result = spawnSync(npm, ['run', script], {
		cwd: root,
		encoding: 'utf8',
		stdio: 'inherit',
	});
	if (result.status !== 0) throw new ReleasePackageError(code, message);
}

/**
 * The version `hebra.json` declares: the release tag without a leading `v`. Outside a tag build it
 * is the manifest version, which `validateCiRef` already holds equal to the tag inside one.
 */
export function hebraVersionFromTag(manifestVersion, environment = {}) {
	if (environment.GITHUB_REF_TYPE !== 'tag' || typeof environment.GITHUB_REF_NAME !== 'string') return manifestVersion;
	return environment.GITHUB_REF_NAME.replace(/^v/u, '');
}

/** `owner/repo` of the GitHub repository `package.json` declares. */
function githubRepoOf(packageJson) {
	const url = isRecord(packageJson.repository) ? packageJson.repository.url : packageJson.repository;
	const match = typeof url === 'string'
		? /^(?:git\+)?(?:https:\/\/github\.com\/|git@github\.com:|github:)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/u.exec(url.trim())
		: null;
	if (!match) throw new ReleasePackageError('invalid-metadata', 'release package: package.json repository is not a GitHub repository');
	return match[1];
}

/**
 * `hebra.json` (Hebra's SPEC-PLUGINS-EXTERNOS.md section 3.2) from `manifest.json` and
 * `package.json`: id, name and author from the manifest, the version of the tag, the repository,
 * `HEBRA_PLUGIN_DECLARATION`, and the sha256 of each Hebra file in `files`.
 */
export function createHebraManifest({ manifest, packageJson, version, files }) {
	return {
		schema: 1,
		id: manifest.id,
		name: manifest.name,
		version,
		apiVersion: HEBRA_PLUGIN_DECLARATION.apiVersion,
		description: HEBRA_PLUGIN_DECLARATION.description,
		author: manifest.author,
		repo: githubRepoOf(packageJson),
		platforms: [...HEBRA_PLUGIN_DECLARATION.platforms],
		main: HEBRA_MAIN_FILE,
		styles: HEBRA_STYLES_FILE,
		icon: HEBRA_PLUGIN_DECLARATION.icon,
		capabilities: {
			required: [...HEBRA_PLUGIN_DECLARATION.capabilities.required],
			optional: [...HEBRA_PLUGIN_DECLARATION.capabilities.optional],
		},
		network: {
			hosts: [...HEBRA_PLUGIN_DECLARATION.network.hosts],
			userHosts: HEBRA_PLUGIN_DECLARATION.network.userHosts,
		},
		shared: { ...HEBRA_PLUGIN_DECLARATION.shared },
		files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, `sha256:${sha256Hex(bytes)}`])),
		ageRating: HEBRA_PLUGIN_DECLARATION.ageRating,
	};
}

const HEBRA_PLATFORMS = ['macos', 'ios', 'linux', 'windows', 'android', 'web'];
const HEBRA_RESERVED_IDS = new Set(['bases', 'dataview', 'daily-notes', 'templates', 'homepage', 'lumbre-notes', 'dashboard', 'youtube', 'hebra']);
const HEBRA_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const HEBRA_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HEBRA_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEBRA_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const HEBRA_CAPABILITY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const HEBRA_HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u;
const HEBRA_AGE_RATING = /^\d{1,2}\+$/u;
const HEBRA_ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEBRA_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const HEBRA_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/u;
const HEBRA_COMPARATOR = /^(?:\^|~|>=|<=|>|<|=)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

/** A semver range as Hebra parses it, for the comparators a plugin writes (`^1.0.0`, `>=1.2.0 <2.0.0`, `a || b`). */
function isHebraRange(value) {
	if (typeof value !== 'string' || value.trim() === '') return false;
	return value.split('||').every((group) => {
		const tokens = group.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/gu, '$1').split(/\s+/u).filter((token) => token !== '');
		return tokens.length > 0 && tokens.every((token) => HEBRA_COMPARATOR.test(token));
	});
}

/**
 * The checks Hebra runs on `hebra.json` before installing anything (`parsePluginManifest` in
 * Hebra's `src/lib/plugins/manifest.ts`, read on 2026-10-03, not imported: Hebra is private and the
 * API package does not export it). Returns every reason, empty when Hebra would accept it.
 * Compatibility with a given Hebra (`apiVersion`, platform, capabilities) is Hebra's loader's call.
 */
export function validateHebraManifest(input) {
	const errors = [];
	if (!isRecord(input)) return ['hebra.json is not an object'];
	if (input.schema !== 1) errors.push('schema: must be 1');
	if (typeof input.id !== 'string' || !HEBRA_ID.test(input.id)) errors.push('id: lower case, digits and dashes, 2 to 64 characters');
	else if (HEBRA_RESERVED_IDS.has(input.id)) errors.push(`id: «${input.id}» is a Hebra built-in module`);
	if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 80) errors.push('name: 1 to 80 characters');
	if (typeof input.version !== 'string' || !HEBRA_VERSION.test(input.version)) errors.push('version: strict semver');
	if (!isHebraRange(input.apiVersion)) errors.push('apiVersion: semver range');
	if (typeof (input.description ?? '') !== 'string' || (input.description ?? '').length > 300) errors.push('description: up to 300 characters');
	if (typeof (input.author ?? '') !== 'string' || (input.author ?? '').length > 80) errors.push('author: up to 80 characters');
	if (typeof input.repo !== 'string' || !HEBRA_REPO.test(input.repo)) errors.push('repo: GitHub owner/repo');
	if (!Array.isArray(input.platforms) || input.platforms.length === 0 || !input.platforms.every((platform) => HEBRA_PLATFORMS.includes(platform))) {
		errors.push(`platforms: non-empty list of ${HEBRA_PLATFORMS.join(', ')}`);
	}
	const files = isRecord(input.files) ? input.files : {};
	if (!isRecord(input.files) || Object.keys(input.files).length === 0) errors.push('files: object file -> sha256:<64 hex>');
	for (const [name, hash] of Object.entries(files)) {
		if (!HEBRA_FILE_NAME.test(name) || name.includes('..') || name === HEBRA_MANIFEST_FILE) errors.push(`files: invalid file name «${name}»`);
		else if (typeof hash !== 'string' || !HEBRA_SHA256.test(hash)) errors.push(`files: «${name}» needs sha256:<64 lower-case hex>`);
	}
	for (const key of ['main', 'styles']) {
		const value = input[key] ?? null;
		if (key === 'styles' && value === null) continue;
		if (typeof value !== 'string' || !HEBRA_FILE_NAME.test(value) || value.includes('..')) errors.push(`${key}: file name without / or ..`);
		else if (!Object.hasOwn(files, value)) errors.push(`${key}: «${value}» is not in files`);
	}
	if ((input.icon ?? null) !== null && (typeof input.icon !== 'string' || !HEBRA_ICON.test(input.icon) || input.icon.length > 64)) {
		errors.push('icon: Lucide icon name');
	}
	if (input.capabilities !== undefined) {
		const capabilities = isRecord(input.capabilities) ? input.capabilities : null;
		for (const list of ['required', 'optional']) {
			const value = capabilities?.[list] ?? [];
			if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && HEBRA_CAPABILITY.test(item))) {
				errors.push(`capabilities.${list}: list of capabilities`);
			}
		}
	}
	if (input.network !== undefined) {
		const hosts = isRecord(input.network) ? input.network.hosts ?? [] : null;
		if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string' && HEBRA_HOST.test(host))) {
			errors.push('network.hosts: list of hosts (wildcard only as *.domain)');
		}
		if (isRecord(input.network) && input.network.userHosts !== undefined && typeof input.network.userHosts !== 'boolean') {
			errors.push('network.userHosts: true or false');
		}
	}
	if (input.shared !== undefined) {
		if (!isRecord(input.shared)) errors.push('shared: object package -> semver range');
		else {
			for (const [name, range] of Object.entries(input.shared)) {
				if (!HEBRA_PACKAGE.test(name) || !isHebraRange(range)) errors.push(`shared: «${name}» needs a semver range`);
			}
		}
	}
	if ((input.ageRating ?? null) !== null && (typeof input.ageRating !== 'string' || !HEBRA_AGE_RATING.test(input.ageRating))) {
		errors.push('ageRating: age with + (4+, 9+, 13+…)');
	}
	return errors;
}

/** The staged `hebra.json` lists exactly the staged Hebra files, each with its real sha256. */
function verifyHebraManifestFiles(stageRoot) {
	const staged = readJson(resolve(stageRoot, HEBRA_MANIFEST_FILE), HEBRA_MANIFEST_FILE);
	const expected = HEBRA_RELEASE_FILES.filter((name) => name !== HEBRA_MANIFEST_FILE);
	const listed = isRecord(staged.files) ? Object.keys(staged.files).sort() : [];
	const mismatch = JSON.stringify(listed) !== JSON.stringify([...expected].sort())
		|| expected.some((name) => staged.files[name] !== `sha256:${sha256Hex(readFileSync(resolve(stageRoot, name)))}`);
	if (mismatch) throw new ReleasePackageError('hebra-manifest-files', 'release package: hebra.json does not hash the staged Hebra files');
}

function writeReleaseArchive(path, bytes) {
	writeFileSync(path, bytes, { mode: 0o644 });
}

function readReleaseMetadata(root) {
	return {
		manifest: readJson(resolve(root, 'manifest.json'), 'manifest.json'),
		packageJson: readJson(resolve(root, 'package.json'), 'package.json'),
		versions: readJson(resolve(root, 'versions.json'), 'versions.json'),
	};
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new ReleasePackageError('invalid-json', `release package: ${label} is not valid JSON`);
	}
}

function validateReleaseMetadata({ manifest, packageJson, versions }) {
	if (!isRecord(manifest) || !isRecord(packageJson) || !isRecord(versions)) {
		throw new ReleasePackageError('invalid-metadata', 'release package: release metadata must be JSON objects');
	}
	for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
		if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
			throw new ReleasePackageError('invalid-manifest', `release package: manifest ${key} is missing`);
		}
	}
	if (manifest.isDesktopOnly !== true) {
		throw new ReleasePackageError('invalid-manifest', 'release package: manifest must remain desktop-only');
	}
	if (!/^[a-z0-9][a-z0-9-]*$/u.test(manifest.id)) {
		throw new ReleasePackageError('invalid-manifest', 'release package: manifest id is not a safe plugin directory');
	}
	if (!SEMVER.test(manifest.version) || !SEMVER.test(manifest.minAppVersion)) {
		throw new ReleasePackageError('invalid-version', 'release package: manifest versions must use x.y.z');
	}
	if (packageJson.name !== manifest.id || packageJson.version !== manifest.version) {
		throw new ReleasePackageError('version-mismatch', 'release package: package and manifest identity/version differ');
	}
	if (versions[manifest.version] !== manifest.minAppVersion) {
		throw new ReleasePackageError('versions-mismatch', 'release package: versions.json does not map the packaged version');
	}
}

function validateCiRef(version, environment) {
	const refType = environment.GITHUB_REF_TYPE;
	if (refType === undefined || refType === '' || refType === 'branch') return;
	if (refType !== 'tag') {
		throw new ReleasePackageError('unsupported-ref', 'release package: unsupported CI ref type');
	}
	if (environment.GITHUB_REF_NAME !== version) {
		throw new ReleasePackageError('tag-mismatch', 'release package: tag must exactly equal manifest version');
	}
}

function removePreviousBundle(path) {
	if (!existsSync(path)) return;
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink()) {
		throw new ReleasePackageError('unsafe-build-output', 'release package: main.js is not a regular file');
	}
	unlinkSync(path);
}

function removeFailedBundle(path) {
	if (!existsSync(path)) return;
	const status = lstatSync(path);
	if (status.isFile() && !status.isSymbolicLink()) unlinkSync(path);
}

function assertReleaseFile(path, label) {
	if (!existsSync(path)) {
		throw new ReleasePackageError('build-output-missing', `release package: ${label} is missing`);
	}
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink() || status.size === 0) {
		throw new ReleasePackageError('invalid-release-file', `release package: ${label} must be a non-empty regular file`);
	}
}

function assertExactDirectory(root, expected) {
	const actual = readdirSync(root).sort((left, right) => left.localeCompare(right));
	const canonical = [...expected].sort((left, right) => left.localeCompare(right));
	if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
		throw new ReleasePackageError('stage-content', 'release package: stage contains an unexpected file set');
	}
}

function createStoredZip(files) {
	if (files.length > 0xffff) {
		throw new ReleasePackageError('archive-size', 'release package: too many ZIP32 entries');
	}
	const localParts = [];
	const centralParts = [];
	let localOffset = 0;

	for (const file of files) {
		const name = Buffer.from(file.name, 'utf8');
		if (name.length > 0xffff || file.bytes.length > 0xffffffff) {
			throw new ReleasePackageError('archive-size', 'release package: a release file exceeds ZIP32 limits');
		}
		const checksum = crc32(file.bytes);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(ZIP_VERSION, 4);
		local.writeUInt16LE(UTF8_FLAG, 6);
		local.writeUInt16LE(ZIP_STORED, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(file.bytes.length, 18);
		local.writeUInt32LE(file.bytes.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		localParts.push(local, name, file.bytes);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(ZIP_UNIX_VERSION, 4);
		central.writeUInt16LE(ZIP_VERSION, 6);
		central.writeUInt16LE(UTF8_FLAG, 8);
		central.writeUInt16LE(ZIP_STORED, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(file.bytes.length, 20);
		central.writeUInt32LE(file.bytes.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE((REGULAR_FILE_MODE << 16) >>> 0, 38);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(central, name);
		localOffset += local.length + name.length + file.bytes.length;
		if (localOffset > 0xffffffff) {
			throw new ReleasePackageError('archive-size', 'release package: archive exceeds ZIP32 limits');
		}
	}

	const centralDirectory = Buffer.concat(centralParts);
	if (centralDirectory.length > 0xffffffff) {
		throw new ReleasePackageError('archive-size', 'release package: central directory exceeds ZIP32 limits');
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

/** Verifies metadata, CRC and bytes without trusting an external unzip tool. */
export function validateReleaseArchive(archive, expectedFiles) {
	if (archive.length < 22) archiveFailure();
	const endOffset = archive.length - 22;
	if (archive.readUInt32LE(endOffset) !== 0x06054b50) archiveFailure();
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralSize = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (
		archive.readUInt16LE(endOffset + 4) !== 0 ||
		archive.readUInt16LE(endOffset + 6) !== 0 ||
		archive.readUInt16LE(endOffset + 8) !== entryCount ||
		archive.readUInt16LE(endOffset + 20) !== 0 ||
		entryCount !== expectedFiles.length ||
		centralOffset + centralSize !== endOffset
	) archiveFailure();

	const expected = new Map(expectedFiles.map((file) => [file.name, file.bytes]));
	const seen = new Set();
	let cursor = centralOffset;
	let expectedLocalOffset = 0;
	for (let index = 0; index < entryCount; index += 1) {
		if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== 0x02014b50) archiveFailure();
		const flags = archive.readUInt16LE(cursor + 8);
		const method = archive.readUInt16LE(cursor + 10);
		const time = archive.readUInt16LE(cursor + 12);
		const date = archive.readUInt16LE(cursor + 14);
		const checksum = archive.readUInt32LE(cursor + 16);
		const compressedSize = archive.readUInt32LE(cursor + 20);
		const size = archive.readUInt32LE(cursor + 24);
		const nameLength = archive.readUInt16LE(cursor + 28);
		const extraLength = archive.readUInt16LE(cursor + 30);
		const commentLength = archive.readUInt16LE(cursor + 32);
		const externalAttributes = archive.readUInt32LE(cursor + 38);
		const localOffset = archive.readUInt32LE(cursor + 42);
		const nameStart = cursor + 46;
		const next = nameStart + nameLength + extraLength + commentLength;
		if (next > endOffset) archiveFailure();
		const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
		const expectedFile = expectedFiles[index];
		const expectedBytes = expected.get(name);
		if (
			!isSafeArchiveEntryName(name) || expectedFile === undefined || expectedFile.name !== name ||
			expectedBytes === undefined || seen.has(name) || localOffset !== expectedLocalOffset ||
			archive.readUInt16LE(cursor + 4) !== ZIP_UNIX_VERSION ||
			archive.readUInt16LE(cursor + 6) !== ZIP_VERSION ||
			flags !== UTF8_FLAG || method !== ZIP_STORED || time !== 0 || date !== DOS_DATE_1980_01_01 ||
			extraLength !== 0 || commentLength !== 0 || compressedSize !== size ||
			archive.readUInt16LE(cursor + 34) !== 0 || archive.readUInt16LE(cursor + 36) !== 0 ||
			externalAttributes !== ((REGULAR_FILE_MODE << 16) >>> 0)
		) archiveFailure();
		if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) archiveFailure();
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + size;
		const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
		const bytes = archive.subarray(dataStart, dataEnd);
		if (
			!isSafeArchiveEntryName(localName) || localName !== name || localNameLength !== nameLength || localExtraLength !== 0 || dataEnd > centralOffset ||
			archive.readUInt16LE(localOffset + 4) !== ZIP_VERSION ||
			archive.readUInt16LE(localOffset + 6) !== flags ||
			archive.readUInt16LE(localOffset + 8) !== method ||
			archive.readUInt16LE(localOffset + 10) !== 0 ||
			archive.readUInt16LE(localOffset + 12) !== DOS_DATE_1980_01_01 ||
			archive.readUInt32LE(localOffset + 14) !== checksum ||
			archive.readUInt32LE(localOffset + 18) !== size ||
			archive.readUInt32LE(localOffset + 22) !== size ||
			crc32(bytes) !== checksum || !bytes.equals(expectedBytes)
		) archiveFailure();
		seen.add(name);
		expectedLocalOffset = dataEnd;
		cursor = next;
	}
	if (cursor !== endOffset || seen.size !== expected.size || expectedLocalOffset !== centralOffset) archiveFailure();
}

function archiveFailure() {
	throw new ReleasePackageError('archive-validation', 'release package: archive validation failed');
}

function isSafeArchiveEntryName(name) {
	return name.length > 0 && name !== '.' && name !== '..'
		&& !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function validateChecksumFile(path, archiveName, expected) {
	const content = readFileSync(path, 'utf8');
	if (content !== `${expected}  ${archiveName}\n`) {
		throw new ReleasePackageError('checksum-validation', 'release package: checksum validation failed');
	}
}

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function sha256Hex(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const result = packageRelease({ root: resolve(fileURLToPath(new URL('..', import.meta.url))) });
		process.stdout.write(
			`release package: PASS (${basename(result.archivePath)} sha256=${result.sha256}; files=${result.files.join(',')})\n`,
		);
	} catch (error) {
		const message = error instanceof ReleasePackageError
			? error.message
			: 'release package: unexpected failure';
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
