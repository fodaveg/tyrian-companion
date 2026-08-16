import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BETA_ARTIFACT_CONTRACT_VERSION = 1;

const PLUGIN_ID = 'tyrian-companion';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export class BetaArtifactError extends Error {
	constructor(code) {
		super(`beta artifact: ${code}`);
		this.name = 'BetaArtifactError';
		this.code = code;
	}
}

/** Rebuilds the exact, disposable artifact surface consumed by the H7.5 upload step. */
export function prepareBetaArtifact({ root = process.cwd(), beforeSeal = () => undefined } = {}) {
	const repositoryRoot = resolve(root);
	const packageJson = readJson(resolve(repositoryRoot, 'package.json'));
	if (!isRecord(packageJson) || packageJson.name !== PLUGIN_ID || !SEMVER.test(packageJson.version)) {
		fail('package-invalid');
	}
	const archiveName = `${PLUGIN_ID}-${packageJson.version}.zip`;
	const files = Object.freeze([archiveName, `${archiveName}.sha256`, 'install-beta.mjs']);
	const sourcePaths = Object.freeze([
		resolve(repositoryRoot, '.release', archiveName),
		resolve(repositoryRoot, '.release', `${archiveName}.sha256`),
		resolve(repositoryRoot, 'scripts/install-beta.mjs'),
	]);
	const sources = Object.freeze(sourcePaths.map((path, index) => Object.freeze({
		bytes: readRegularFile(path),
		name: files[index],
		path,
	})));
	verifyChecksum(sources[1].bytes, archiveName, sources[0].bytes);
	const stageRoot = resolve(repositoryRoot, '.beta-artifact');
	if (dirname(stageRoot) !== repositoryRoot || basename(stageRoot) !== '.beta-artifact') fail('stage-invalid');
	if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
	mkdirSync(stageRoot, { mode: 0o755 });
	const stageAuthority = directoryIdentity(stageRoot);
	try {
		for (const source of sources) {
			writeFileSync(resolve(stageRoot, source.name), source.bytes, { flag: 'wx', mode: 0o644 });
		}
		beforeSeal(stageRoot);
		assertDirectoryIdentity(stageRoot, stageAuthority);
		if (!sameStrings(readdirSync(stageRoot).sort(), [...files].sort())) fail('stage-file-set');
		for (const source of sources) {
			const persisted = readRegularFile(resolve(stageRoot, source.name));
			if (!persisted.equals(source.bytes)) fail('stage-bytes-changed');
		}
		verifyChecksum(
			readRegularFile(resolve(stageRoot, sources[1].name)),
			archiveName,
			readRegularFile(resolve(stageRoot, sources[0].name)),
		);
		assertDirectoryIdentity(stageRoot, stageAuthority);
		return Object.freeze({ files: [...files], stageRoot, version: packageJson.version });
	} catch (error) {
		cleanupOwnedStage(stageRoot, stageAuthority);
		if (error instanceof BetaArtifactError) throw error;
		fail('stage-invalid');
	}
}

function directoryIdentity(path) {
	const status = lstatSync(path);
	if (!status.isDirectory() || status.isSymbolicLink()) fail('stage-invalid');
	return Object.freeze({ dev: String(status.dev), ino: String(status.ino) });
}

function assertDirectoryIdentity(path, expected) {
	try {
		const status = lstatSync(path);
		if (
			!status.isDirectory() || status.isSymbolicLink() || String(status.dev) !== expected.dev ||
			String(status.ino) !== expected.ino
		) fail('stage-authority-changed');
	} catch (error) {
		if (error instanceof BetaArtifactError) throw error;
		fail('stage-authority-changed');
	}
}

function cleanupOwnedStage(path, expected) {
	try {
		assertDirectoryIdentity(path, expected);
		rmSync(path, { recursive: true, force: true });
	} catch {
		// A replaced stage is not followed or recursively removed.
		try {
			const status = lstatSync(path);
			if (status.isSymbolicLink() || status.isFile()) rmSync(path, { force: true });
		} catch {
			// The owned stage may have been moved; never guess its replacement path.
		}
	}
}

function verifyChecksum(source, archiveName, archive) {
	const match = /^([0-9a-f]{64}) {2}([a-z0-9-]+-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.zip)\n$/u
		.exec(source.toString('utf8'));
	if (match === null || match[2] !== archiveName) fail('checksum-invalid');
	if (createHash('sha256').update(archive).digest('hex') !== match[1]) fail('checksum-mismatch');
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		fail('package-invalid');
	}
}

function readRegularFile(path) {
	if (!existsSync(path)) fail('source-invalid');
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink() || status.size === 0) fail('source-invalid');
	return readFileSync(path);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStrings(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code) {
	throw new BetaArtifactError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const result = prepareBetaArtifact();
		process.stdout.write(
			`beta artifact v${String(BETA_ARTIFACT_CONTRACT_VERSION)}: PASS (version=${result.version}; files=${result.files.join(',')})\n`,
		);
	} catch (error) {
		const code = error instanceof BetaArtifactError ? error.code : 'unexpected-failure';
		process.stderr.write(`beta artifact: ${code}\n`);
		process.exitCode = 1;
	}
}
