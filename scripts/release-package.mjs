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

export const RELEASE_FILES = Object.freeze([
	'manifest.json',
	'main.js',
	'styles.css',
]);

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
			environment,
			releaseRoot,
			scanArtifacts,
			writeArchive,
		});
	} catch (error) {
		rmSync(releaseRoot, { recursive: true, force: true });
		removeFailedBundle(resolve(absoluteRoot, 'main.js'));
		throw error;
	}
}

function packageReleaseInCleanOutput({
	absoluteRoot,
	build,
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
	build(absoluteRoot);
	assertReleaseFile(bundlePath, 'main.js');
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

	const stageRoot = resolve(releaseRoot, metadataAfterBuild.manifest.id);
	mkdirSync(stageRoot, { recursive: true });
	for (const path of RELEASE_FILES) {
		const source = resolve(absoluteRoot, path);
		assertReleaseFile(source, path);
		const destination = resolve(stageRoot, path);
		copyFileSync(source, destination);
		chmodSync(destination, 0o644);
	}
	assertExactDirectory(stageRoot, RELEASE_FILES);

	const securityFindings = scanArtifacts(stageRoot, RELEASE_FILES);
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
		sha256,
		stageRoot,
		version: metadataAfterBuild.manifest.version,
	};
}

function runProductionBuild(root) {
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const result = spawnSync(npm, ['run', 'build'], {
		cwd: root,
		encoding: 'utf8',
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		throw new ReleasePackageError('build-failed', 'release package: production build failed');
	}
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
