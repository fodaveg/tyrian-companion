import { createHash, randomUUID } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BETA_CHANNEL_CONTRACT_VERSION = 1;
export const BETA_RELEASE_FILES = Object.freeze(['manifest.json', 'main.js', 'styles.css']);
export const DEFAULT_CONFIG_DIRECTORY = ['.', 'obsidian'].join('');

const ARCHIVE_LIMIT_BYTES = 64 * 1024 * 1024;
const CHECKSUM_LIMIT_BYTES = 256;
const DOS_DATE_1980_01_01 = 0x0021;
const MANIFEST_KEYS = Object.freeze([
	'author',
	'description',
	'id',
	'isDesktopOnly',
	'minAppVersion',
	'name',
	'version',
]);
const MIN_APP_VERSION = '1.11.4';
const PLUGIN_ID = 'tyrian-companion';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const UTF8_FLAG = 0x0800;
const ZIP_STORED = 0;
const ZIP_UNIX_VERSION = 0x0314;
const ZIP_VERSION = 20;
const REGULAR_FILE_MODE = 0o100644;

export class BetaInstallError extends Error {
	constructor(code) {
		super(`beta channel: ${code}`);
		this.name = 'BetaInstallError';
		this.code = code;
	}
}

/** Installs or upgrades only the three managed plugin files from one verified CI candidate. */
export function installBetaCandidate({
	archivePath,
	checksumPath = `${archivePath}.sha256`,
	configDir = DEFAULT_CONFIG_DIRECTORY,
	vaultRoot,
	beforeWrite = () => undefined,
	afterBackup = () => undefined,
	afterSwap = () => undefined,
	afterLockCreated = () => undefined,
	lockClose = closeSync,
	lockUnlink = unlinkSync,
} = {}) {
	if (typeof archivePath !== 'string' || typeof vaultRoot !== 'string') fail('invalid-arguments');
	if (
		![beforeWrite, afterBackup, afterSwap, afterLockCreated, lockClose, lockUnlink]
			.every((value) => typeof value === 'function')
	) fail('invalid-arguments');
	if (!isSafeConfigDirectory(configDir)) fail('config-directory-invalid');
	const archiveFile = resolve(archivePath);
	const checksumFile = resolve(checksumPath);
	const vault = requireDirectory(resolve(vaultRoot), 'vault-invalid');
	const obsidian = requireDirectory(resolve(vault, configDir), 'obsidian-directory-missing');
	if (dirname(obsidian) !== vault) fail('vault-invalid');

	const archive = readRegularFile(archiveFile, ARCHIVE_LIMIT_BYTES, 'archive-invalid');
	const checksum = readRegularFile(checksumFile, CHECKSUM_LIMIT_BYTES, 'checksum-invalid').toString('utf8');
	verifyChecksum(checksum, basename(archiveFile), archive);
	const entries = readBetaArchive(archive);
	const manifest = parseManifest(entries[0].bytes);
	if (basename(archiveFile) !== `${PLUGIN_ID}-${manifest.version}.zip`) fail('archive-name-mismatch');

	const plugins = resolve(obsidian, 'plugins');
	let createdPlugins = false;
	if (!existsSync(plugins)) {
		mkdirSync(plugins, { mode: 0o755 });
		createdPlugins = true;
	} else {
		requireDirectory(plugins, 'plugins-directory-invalid');
	}
	if (dirname(plugins) !== obsidian) fail('plugins-directory-invalid');

	const pluginRoot = resolve(plugins, PLUGIN_ID);
	let createdPluginRoot = false;
	if (!existsSync(pluginRoot)) {
		mkdirSync(pluginRoot, { mode: 0o755 });
		createdPluginRoot = true;
	} else {
		requireDirectory(pluginRoot, 'plugin-directory-invalid');
	}
	if (dirname(pluginRoot) !== plugins || basename(pluginRoot) !== PLUGIN_ID) fail('plugin-directory-invalid');
	const authority = captureDirectoryAuthority([vault, obsidian, plugins, pluginRoot]);

	try {
		return withInstallLock(authority, pluginRoot, { afterLockCreated, lockClose, lockUnlink }, () => {
			const installed = inspectInstalledCandidate(authority, pluginRoot);
			if (installed.version !== null && compareSemver(manifest.version, installed.version) <= 0) {
				fail('version-not-newer');
			}
			const transaction = commitManagedFiles({ afterBackup, afterSwap, authority, beforeWrite, entries, installed, pluginRoot });
			return Object.freeze({
				result: Object.freeze({
					files: [...BETA_RELEASE_FILES],
					previousVersion: installed.version,
					status: installed.version === null ? 'installed' : 'updated',
					version: manifest.version,
				}),
				transaction,
			});
		});
	} catch (error) {
		removeEmptyDirectory(pluginRoot, createdPluginRoot);
		removeEmptyDirectory(plugins, createdPlugins);
		if (error instanceof BetaInstallError) throw error;
		fail('install-failed');
	}
}

export function parseBetaInstallArguments(argv) {
	if (!Array.isArray(argv) || argv[0] !== 'install') fail('usage');
	let archivePath = null;
	let configDir = DEFAULT_CONFIG_DIRECTORY;
	let configDirSet = false;
	let vaultRoot = null;
	let confirmed = false;
	for (let index = 1; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--confirm-obsidian-closed' && !confirmed) {
			confirmed = true;
			continue;
		}
		if ((argument === '--archive' || argument === '--vault' || argument === '--config-dir') && index + 1 < argv.length) {
			const value = argv[index + 1];
			if (value.startsWith('--')) fail('usage');
			if (argument === '--archive' && archivePath === null) archivePath = value;
			else if (argument === '--vault' && vaultRoot === null) vaultRoot = value;
			else if (argument === '--config-dir' && !configDirSet) {
				configDir = value;
				configDirSet = true;
			}
			else fail('usage');
			index += 1;
			continue;
		}
		fail('usage');
	}
	if (!confirmed || archivePath === null || vaultRoot === null) fail('usage');
	if (!isSafeConfigDirectory(configDir)) fail('config-directory-invalid');
	return Object.freeze({ archivePath, configDir, vaultRoot });
}

function commitManagedFiles({ afterBackup, afterSwap, authority, beforeWrite, entries, installed, pluginRoot }) {
	const nonce = randomUUID();
	const pending = entries.map((entry) => ({
		...entry,
		backup: resolve(pluginRoot, `.tyrian-backup-${nonce}-${entry.name}`),
		recoveryHint: resolve(pluginRoot, `.tyrian-recovery-${nonce}-${entry.name}`),
		target: resolve(pluginRoot, entry.name),
		temporary: resolve(pluginRoot, `.tyrian-next-${nonce}-${entry.name}`),
	}));
	const swapped = [];
	try {
		for (const [index, file] of pending.entries()) {
			beforeWrite(file.name, index);
			assertDirectoryAuthority(authority);
			writeDurableExclusive(file.temporary, file.bytes);
			assertDirectoryAuthority(authority);
		}
		if (!sameInstalledState(inspectInstalledCandidate(authority, pluginRoot), installed)) {
			fail('installed-state-changed');
		}
		for (const [index, file] of pending.entries()) {
			assertDirectoryAuthority(authority);
			const expected = installed.files.find((item) => item.name === file.name) ?? null;
			assertManagedTarget(file.target, expected);
			const hadOriginal = expected !== null;
			if (hadOriginal) {
				renameSync(file.target, file.backup);
				assertDirectoryAuthority(authority);
			}
			const transaction = { ...file, hadOriginal, installed: false };
			swapped.push(transaction);
			afterBackup(file.name, index);
			assertDirectoryAuthority(authority);
			if (expected !== null) assertFileDigest(file.backup, expected.sha256, 'installed-state-changed');
			assertFileDigest(file.temporary, sha256(file.bytes), 'installed-state-changed');
			renameSync(file.temporary, file.target);
			transaction.installed = true;
			assertDirectoryAuthority(authority);
			chmodSync(file.target, 0o644);
			assertFileDigest(file.target, sha256(file.bytes), 'installed-state-changed');
			assertDirectoryAuthority(authority);
			afterSwap(file.name, index);
			assertDirectoryAuthority(authority);
			assertFileDigest(file.target, sha256(file.bytes), 'installed-state-changed');
		}
	} catch {
		if (directoryAuthorityMatches(authority)) {
			if (swapped.length > 0) restoreTrustedInstalledState(authority, installed, pending, pluginRoot);
			cleanupTransactionFiles(authority, pending, false);
		}
		fail('install-failed');
	}
	let state = 'open';
	return Object.freeze({
		finalize() {
			if (state !== 'open') fail('install-failed');
			cleanupTransactionFiles(authority, pending, true);
			state = 'finalized';
		},
		rollback() {
			if (state === 'rolled-back') fail('install-failed');
			restoreTrustedInstalledState(authority, installed, pending, pluginRoot);
			cleanupTransactionFiles(authority, pending, false);
			state = 'rolled-back';
		},
	});
}

function inspectInstalledCandidate(authority, pluginRoot) {
	assertDirectoryAuthority(authority);
	const states = BETA_RELEASE_FILES.map((name) => ({ name, path: resolve(pluginRoot, name) }))
		.map((file) => ({ ...file, exists: existsSync(file.path) }));
	const count = states.filter((file) => file.exists).length;
	if (count === 0) {
		assertDirectoryAuthority(authority);
		return Object.freeze({ files: [], version: null });
	}
	if (count !== BETA_RELEASE_FILES.length) fail('installed-partial');
	const files = states.map((file) => {
		requireRegularFile(file.path, 'installed-file-invalid');
		const bytes = readFileSync(file.path);
		assertDirectoryAuthority(authority);
		return Object.freeze({ bytes: Buffer.from(bytes), name: file.name, sha256: sha256(bytes) });
	});
	const manifest = parseManifest(readFileSync(states[0].path));
	assertDirectoryAuthority(authority);
	return Object.freeze({ files, version: manifest.version });
}

function withInstallLock(authority, pluginRoot, { afterLockCreated, lockClose, lockUnlink }, callback) {
	assertDirectoryAuthority(authority);
	const lockPath = resolve(pluginRoot, '.tyrian-beta-install.lock');
	let descriptor;
	try {
		descriptor = openSync(lockPath, 'wx', 0o600);
	} catch {
		fail('install-in-progress');
	}
	const lockIdentity = fileIdentity(fstatSync(descriptor));
	try {
		writeFileSync(descriptor, `${randomUUID()}\n`);
		fsyncSync(descriptor);
		assertDirectoryAuthority(authority);
		afterLockCreated();
		assertOwnedLock(authority, lockPath, lockIdentity);
	} catch {
		tryCloseLock(descriptor, lockClose);
		tryRemoveOwnedLock(authority, lockPath, lockIdentity, lockUnlink);
		fail('install-failed');
	}
	let outcome = null;
	let operationError = null;
	try {
		outcome = callback();
		assertOwnedLock(authority, lockPath, lockIdentity);
		outcome.transaction.finalize();
		assertOwnedLock(authority, lockPath, lockIdentity);
	} catch (error) {
		operationError = error;
	}
	if (operationError !== null && outcome !== null) {
		try {
			outcome.transaction.rollback();
		} catch {
			operationError = new BetaInstallError('install-failed');
		}
	}
	let closeError = null;
	try {
		lockClose(descriptor);
	} catch (error) {
		closeError = error;
	}
	let unlinkError = null;
	if (closeError === null) {
		try {
			assertOwnedLock(authority, lockPath, lockIdentity);
			lockUnlink(lockPath);
		} catch (error) {
			unlinkError = error;
		}
	}
	if ((closeError !== null || unlinkError !== null) && operationError === null) {
		try {
			outcome.transaction.rollback();
		} catch {
			// The operation still fails closed; recovery cleanup below is best effort.
		}
		operationError = new BetaInstallError('install-failed');
	}
	if (closeError !== null) tryCloseLock(descriptor, lockClose);
	if (pathEntryExists(lockPath)) tryRemoveOwnedLock(authority, lockPath, lockIdentity, lockUnlink);
	if (operationError !== null) throw operationError;
	return outcome.result;
}

function assertOwnedLock(authority, lockPath, lockIdentity) {
	assertDirectoryAuthority(authority);
	const current = lstatSync(lockPath);
	if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(fileIdentity(current), lockIdentity)) {
		fail('install-failed');
	}
}

function tryCloseLock(descriptor, close) {
	try {
		close(descriptor);
	} catch {
		return false;
	}
	return true;
}

function tryRemoveOwnedLock(authority, lockPath, lockIdentity, remove) {
	try {
		assertOwnedLock(authority, lockPath, lockIdentity);
		remove(lockPath);
	} catch {
		return false;
	}
	return true;
}

function restoreTrustedInstalledState(authority, installed, pending, pluginRoot) {
	assertDirectoryAuthority(authority);
	for (const file of pending) {
		const original = installed.files.find((item) => item.name === file.name) ?? null;
		if (original === null) {
			removeTransactionPath(file.target, false);
			continue;
		}
		const recovery = writeFreshRecovery(pluginRoot, file.name, original.bytes);
		try {
			chmodSync(recovery, 0o644);
			assertDirectoryAuthority(authority);
			renameSync(recovery, file.target);
			assertFileDigest(file.target, original.sha256, 'install-failed');
		} finally {
			removeTransactionPath(recovery, false);
		}
	}
}

function writeFreshRecovery(pluginRoot, name, bytes) {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const path = resolve(pluginRoot, `.tyrian-recovery-${randomUUID()}-${name}`);
		try {
			writeDurableExclusive(path, bytes);
			return path;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'EEXIST') throw error;
		}
	}
	fail('install-failed');
}

function cleanupTransactionFiles(authority, pending, strict) {
	assertDirectoryAuthority(authority);
	for (const file of pending) {
		removeTransactionPath(file.temporary, strict);
		removeTransactionPath(file.backup, strict);
		removeTransactionPath(file.recoveryHint, strict);
	}
}

function removeTransactionPath(path, strict) {
	try {
		const status = lstatSync(path);
		if (status.isDirectory() && !status.isSymbolicLink()) {
			if (readdirSync(path).length !== 0) throw new Error('transaction path is a nonempty directory');
			rmdirSync(path);
		} else {
			unlinkSync(path);
		}
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') return;
		if (strict) fail('install-failed');
	}
}

function pathEntryExists(path) {
	try {
		lstatSync(path);
	} catch {
		return false;
	}
	return true;
}

function captureDirectoryAuthority(paths) {
	return Object.freeze(paths.map((path) => {
		const status = lstatSync(path);
		if (!status.isDirectory() || status.isSymbolicLink()) fail('directory-authority-invalid');
		return Object.freeze({ ...fileIdentity(status), path });
	}));
}

function assertDirectoryAuthority(authority) {
	if (!directoryAuthorityMatches(authority)) fail('directory-authority-changed');
}

function directoryAuthorityMatches(authority) {
	try {
		return authority.every((expected) => {
			const current = lstatSync(expected.path);
			return current.isDirectory() && !current.isSymbolicLink() && sameFileIdentity(fileIdentity(current), expected);
		});
	} catch {
		return false;
	}
}

function fileIdentity(status) {
	return Object.freeze({ dev: String(status.dev), ino: String(status.ino) });
}

function sameFileIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameInstalledState(left, right) {
	return left.version === right.version && left.files.length === right.files.length && left.files.every((file, index) => (
		file.name === right.files[index]?.name && file.sha256 === right.files[index]?.sha256
	));
}

function assertManagedTarget(path, expected) {
	if (expected === null) {
		if (existsSync(path)) fail('installed-state-changed');
		return;
	}
	assertFileDigest(path, expected.sha256, 'installed-state-changed');
}

function assertFileDigest(path, expected, code) {
	requireRegularFile(path, code);
	if (sha256(readFileSync(path)) !== expected) fail(code);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function parseManifest(bytes) {
	let manifest;
	try {
		manifest = JSON.parse(bytes.toString('utf8'));
	} catch {
		fail('manifest-invalid');
	}
	if (!isRecord(manifest) || !sameStrings(Object.keys(manifest).sort(), MANIFEST_KEYS)) {
		fail('manifest-invalid');
	}
	if (
		manifest.id !== PLUGIN_ID || manifest.name !== 'Tyrian Companion' || manifest.author !== 'fodaveg' ||
		manifest.isDesktopOnly !== true || !SEMVER.test(manifest.version) || manifest.minAppVersion !== MIN_APP_VERSION ||
		typeof manifest.description !== 'string' || manifest.description.trim() === ''
	) fail('manifest-invalid');
	return manifest;
}

function verifyChecksum(source, archiveName, archive) {
	const match = /^([0-9a-f]{64}) {2}([a-z0-9-]+-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.zip)\n$/u.exec(source);
	if (match === null || match[2] !== archiveName) fail('checksum-invalid');
	const actual = createHash('sha256').update(archive).digest('hex');
	if (actual !== match[1]) fail('checksum-mismatch');
}

function readBetaArchive(archive) {
	if (!Buffer.isBuffer(archive) || archive.length < 22) fail('archive-invalid');
	const endOffset = archive.length - 22;
	if (archive.readUInt32LE(endOffset) !== 0x06054b50) fail('archive-invalid');
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralSize = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (
		archive.readUInt16LE(endOffset + 4) !== 0 || archive.readUInt16LE(endOffset + 6) !== 0 ||
		archive.readUInt16LE(endOffset + 8) !== entryCount || archive.readUInt16LE(endOffset + 20) !== 0 ||
		entryCount !== BETA_RELEASE_FILES.length || centralOffset + centralSize !== endOffset
	) fail('archive-invalid');

	const files = [];
	let cursor = centralOffset;
	let expectedLocalOffset = 0;
	for (let index = 0; index < entryCount; index += 1) {
		if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== 0x02014b50) fail('archive-invalid');
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
		if (next > endOffset) fail('archive-invalid');
		const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
		if (
			name !== BETA_RELEASE_FILES[index] || localOffset !== expectedLocalOffset ||
			archive.readUInt16LE(cursor + 4) !== ZIP_UNIX_VERSION || archive.readUInt16LE(cursor + 6) !== ZIP_VERSION ||
			flags !== UTF8_FLAG || method !== ZIP_STORED || time !== 0 || date !== DOS_DATE_1980_01_01 ||
			extraLength !== 0 || commentLength !== 0 || compressedSize !== size ||
			archive.readUInt16LE(cursor + 34) !== 0 || archive.readUInt16LE(cursor + 36) !== 0 ||
			externalAttributes !== ((REGULAR_FILE_MODE << 16) >>> 0)
		) fail('archive-invalid');
		if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) fail('archive-invalid');
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + size;
		const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
		const bytes = archive.subarray(dataStart, dataEnd);
		if (
			localName !== name || localNameLength !== nameLength || localExtraLength !== 0 || dataEnd > centralOffset ||
			archive.readUInt16LE(localOffset + 4) !== ZIP_VERSION || archive.readUInt16LE(localOffset + 6) !== flags ||
			archive.readUInt16LE(localOffset + 8) !== method || archive.readUInt16LE(localOffset + 10) !== 0 ||
			archive.readUInt16LE(localOffset + 12) !== DOS_DATE_1980_01_01 ||
			archive.readUInt32LE(localOffset + 14) !== checksum || archive.readUInt32LE(localOffset + 18) !== size ||
			archive.readUInt32LE(localOffset + 22) !== size || crc32(bytes) !== checksum
		) fail('archive-invalid');
		files.push(Object.freeze({ name, bytes: Buffer.from(bytes) }));
		expectedLocalOffset = dataEnd;
		cursor = next;
	}
	if (cursor !== endOffset || expectedLocalOffset !== centralOffset) fail('archive-invalid');
	return files;
}

function readRegularFile(path, limit, code) {
	requireRegularFile(path, code);
	const status = lstatSync(path);
	if (status.size === 0 || status.size > limit) fail(code);
	return readFileSync(path);
}

function requireRegularFile(path, code) {
	if (!existsSync(path)) fail(code);
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink()) fail(code);
}

function requireDirectory(path, code) {
	if (!existsSync(path)) fail(code);
	const status = lstatSync(path);
	if (!status.isDirectory() || status.isSymbolicLink()) fail(code);
	return path;
}

function writeDurableExclusive(path, bytes) {
	const descriptor = openSync(path, 'wx', 0o600);
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function removeEmptyDirectory(path, created) {
	if (!created || !existsSync(path)) return;
	const status = lstatSync(path);
	if (!status.isDirectory() || status.isSymbolicLink()) return;
	if (readdirSync(path).length === 0) rmdirSync(path);
}

function compareSemver(left, right) {
	const a = left.split('.').map(BigInt);
	const b = right.split('.').map(BigInt);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] < b[index]) return -1;
		if (a[index] > b[index]) return 1;
	}
	return 0;
}

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeConfigDirectory(value) {
	return typeof value === 'string' && value !== '.' && value !== '..' && /^[.A-Za-z0-9_-]+$/u.test(value);
}

function sameStrings(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code) {
	throw new BetaInstallError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const result = installBetaCandidate(parseBetaInstallArguments(process.argv.slice(2)));
		const previous = result.previousVersion === null ? 'none' : result.previousVersion;
		process.stdout.write(
			`beta channel v${String(BETA_CHANNEL_CONTRACT_VERSION)}: PASS (${result.status} ${previous} -> ${result.version}; files=${result.files.join(',')})\n`,
		);
	} catch (error) {
		const code = error instanceof BetaInstallError ? error.code : 'unexpected-failure';
		process.stderr.write(`beta channel: ${code}\n`);
		process.exitCode = 1;
	}
}
