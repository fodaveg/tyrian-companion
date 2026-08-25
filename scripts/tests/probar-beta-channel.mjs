import { createHash } from 'node:crypto';
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	lstatSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { validateBetaChannelContract } from '../beta-channel-contract.mjs';
import {
	BETA_RELEASE_FILES,
	BetaInstallError,
	DEFAULT_CONFIG_DIRECTORY,
	installBetaCandidate,
	parseBetaInstallArguments,
} from '../install-beta.mjs';
import { packageRelease } from '../release-package.mjs';
import { BetaArtifactError, prepareBetaArtifact } from '../prepare-beta-artifact.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-beta-channel-'));
const failures = [];
const CONFIG_DIRECTORY = DEFAULT_CONFIG_DIRECTORY;

try {
	testFreshInstall();
	testCustomConfigDirectory();
	testUpdatePreservesLocalData();
	testRollbackIsTransactional();
	testRollbackRejectsMutableBackups();
	testRecoveryNamespaceCannotBlockRollback();
	testLockLifecycleFailuresRollback();
	testConcurrentInstallIsRejected();
	testDirectoryAuthorityCannotChange();
	testChecksumAndArchiveFailures();
	testInstallerAcceptsRepositoryManifest();
	testInstallerZipMatrix();
	testInstalledStateFailures();
	testPathFailures();
	testCliConfirmation();
	testCliEntrypoint();
	testPreparedArtifact();
	testCiArtifactContract();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.exit(1);
}
process.stdout.write('beta channel suite: PASS\n');

function testFreshInstall() {
	const release = candidate('fresh', '0.1.0');
	const root = vault('fresh');
	const result = install(release, root);
	assert(result.status === 'installed' && result.previousVersion === null, 'fresh install returned the wrong state');
	assertManagedFiles(root, release);
	assert(
		readdirSync(resolve(root, CONFIG_DIRECTORY, 'plugins/tyrian-companion')).length === 3,
		'fresh install wrote extra plugin files',
	);
}

function testCustomConfigDirectory() {
	const release = candidate('custom-config', '0.1.0');
	const root = resolve(testRoot, 'vault-custom-config');
	mkdirSync(resolve(root, '.config'), { recursive: true });
	const result = installBetaCandidate({ archivePath: release.archivePath, configDir: '.config', vaultRoot: root });
	assert(result.status === 'installed', 'custom config directory did not install');
	for (const name of BETA_RELEASE_FILES) {
		assert(exists(resolve(root, '.config/plugins/tyrian-companion', name)), `custom config directory missed ${name}`);
	}
}

function testUpdatePreservesLocalData() {
	const release = candidate('update', '0.1.0');
	const root = vault('update');
	const plugin = seedInstalled(root, '0.0.9');
	const workspace = resolve(root, CONFIG_DIRECTORY, 'workspace.json');
	writeFileSync(resolve(plugin, 'data.json'), '{"secretName":"gw2"}\n');
	writeFileSync(workspace, '{"layout":"keep"}\n');
	const result = install(release, root);
	assert(result.status === 'updated' && result.previousVersion === '0.0.9', 'update returned the wrong state');
	assertManagedFiles(root, release);
	assert(readFileSync(resolve(plugin, 'data.json'), 'utf8') === '{"secretName":"gw2"}\n', 'update changed plugin data.json');
	assert(readFileSync(workspace, 'utf8') === '{"layout":"keep"}\n', 'update changed another vault-internal file');
}

function testRollbackIsTransactional() {
	const release = candidate('rollback', '0.1.0');
	const freshRoot = vault('rollback-write');
	assertThrows(
		() => installBetaCandidate({
			archivePath: release.archivePath,
			vaultRoot: freshRoot,
			beforeWrite: (_name, index) => { if (index === 1) throw new Error('controlled write failure'); },
		}),
		'install-failed',
		'controlled staging failure did not fail closed',
	);
	assert(
		!exists(resolve(freshRoot, CONFIG_DIRECTORY, 'plugins/tyrian-companion')),
		'staging failure left a partial plugin directory',
	);

	const backupRoot = vault('rollback-backup');
	const backupPlugin = seedInstalled(backupRoot, '0.0.9');
	const backupBefore = new Map(BETA_RELEASE_FILES.map((name) => [name, readFileSync(resolve(backupPlugin, name))]));
	assertThrows(
		() => installBetaCandidate({
			archivePath: release.archivePath,
			vaultRoot: backupRoot,
			afterBackup: (_name, index) => { if (index === 0) throw new Error('controlled post-backup failure'); },
		}),
		'install-failed',
		'controlled post-backup failure did not fail closed',
	);
	for (const [name, bytes] of backupBefore) {
		assert(readFileSync(resolve(backupPlugin, name)).equals(bytes), `post-backup rollback did not restore ${name}`);
	}
	assert(
		readdirSync(backupPlugin).every((name) => !name.startsWith('.tyrian-next-') && !name.startsWith('.tyrian-backup-')),
		'post-backup rollback left transactional files behind',
	);

	const root = vault('rollback');
	const plugin = seedInstalled(root, '0.0.9');
	const before = new Map(BETA_RELEASE_FILES.map((name) => [name, readFileSync(resolve(plugin, name))]));
	assertThrows(
		() => installBetaCandidate({
			archivePath: release.archivePath,
			vaultRoot: root,
			afterSwap: (_name, index) => { if (index === 0) throw new Error('controlled failure'); },
		}),
		'install-failed',
		'controlled mid-swap failure did not fail closed',
	);
	for (const [name, bytes] of before) {
		assert(readFileSync(resolve(plugin, name)).equals(bytes), `rollback did not restore ${name}`);
	}
	assert(
		readdirSync(plugin).every((name) => !name.startsWith('.tyrian-next-') && !name.startsWith('.tyrian-backup-')),
		'rollback left transactional files behind',
	);
}

function testRollbackRejectsMutableBackups() {
	for (const mode of ['mutated', 'truncated', 'symlink']) {
		const release = candidate(`rollback-backup-${mode}`, '0.1.0');
		const root = vault(`rollback-backup-${mode}`);
		const plugin = seedInstalled(root, '0.0.9');
		const before = new Map(BETA_RELEASE_FILES.map((name) => [name, readFileSync(resolve(plugin, name))]));
		const external = resolve(testRoot, `rollback-backup-external-${mode}`);
		writeFileSync(external, 'external sentinel\n');
		assertThrows(
			() => installBetaCandidate({
				archivePath: release.archivePath,
				vaultRoot: root,
				afterBackup: (name, index) => {
					if (index !== 0) return;
					const backup = transactionFile(plugin, '.tyrian-backup-', name);
					if (mode === 'mutated') writeFileSync(backup, 'CORRUPTED');
					else if (mode === 'truncated') writeFileSync(backup, '');
					else {
						unlinkSync(backup);
						symlinkSync(external, backup);
					}
				},
			}),
			'install-failed',
			`${mode} backup did not fail closed`,
		);
		for (const [name, bytes] of before) {
			assert(readFileSync(resolve(plugin, name)).equals(bytes), `${mode} backup contaminated restored ${name}`);
		}
		assert(readFileSync(external, 'utf8') === 'external sentinel\n', `${mode} backup changed an external file`);
		assertNoTransactionFiles(plugin, `${mode} backup rollback`);
	}
}

function testRecoveryNamespaceCannotBlockRollback() {
	for (const mode of ['file', 'directory', 'symlink', 'dangling-symlink']) {
		const release = candidate(`rollback-recovery-${mode}`, '0.1.0');
		const root = vault(`rollback-recovery-${mode}`);
		const plugin = seedInstalled(root, '0.0.9');
		const before = new Map(BETA_RELEASE_FILES.map((name) => [name, readFileSync(resolve(plugin, name))]));
		const external = resolve(testRoot, `rollback-recovery-external-${mode}`);
		writeFileSync(external, 'external sentinel\n');
		assertThrows(
			() => installBetaCandidate({
				archivePath: release.archivePath,
				vaultRoot: root,
				afterBackup: (name, index) => {
					if (index !== 0) return;
					const backup = basename(transactionFile(plugin, '.tyrian-backup-', name));
					const recovery = resolve(plugin, backup.replace('.tyrian-backup-', '.tyrian-recovery-'));
					if (mode === 'file') writeFileSync(recovery, 'attacker-controlled');
					else if (mode === 'directory') mkdirSync(recovery);
					else symlinkSync(mode === 'symlink' ? external : `${external}-missing`, recovery);
					throw new Error('controlled rollback after recovery collision');
				},
			}),
			'install-failed',
			`${mode} recovery collision did not fail closed`,
		);
		for (const [name, bytes] of before) {
			assert(readFileSync(resolve(plugin, name)).equals(bytes), `${mode} recovery collision left ${name} unrestored`);
		}
		assert(readFileSync(external, 'utf8') === 'external sentinel\n', `${mode} recovery collision changed an external file`);
		assertNoTransactionFiles(plugin, `${mode} recovery collision`);
	}
}

function testLockLifecycleFailuresRollback() {
	const release = candidate('lock-lifecycle', '0.1.0');

	const initializationRoot = vault('lock-initialization');
	const initializationPlugin = seedInstalled(initializationRoot, '0.0.9');
	assertThrows(
		() => installBetaCandidate({
			archivePath: release.archivePath,
			vaultRoot: initializationRoot,
			afterLockCreated: () => { throw new Error('controlled lock initialization failure'); },
		}),
		'install-failed',
		'lock initialization failure stayed green',
	);
	assert(installedVersion(initializationRoot) === '0.0.9', 'lock initialization failure changed the installed version');
	assertNoTransactionFiles(initializationPlugin, 'lock initialization failure');

	for (const lifecycle of ['close', 'unlink']) {
		const root = vault(`lock-${lifecycle}`);
		const plugin = seedInstalled(root, '0.0.9');
		const before = new Map(BETA_RELEASE_FILES.map((name) => [name, readFileSync(resolve(plugin, name))]));
		let calls = 0;
		const options = lifecycle === 'close'
			? {
				lockClose: (descriptor) => {
					calls += 1;
					if (calls === 1) throw new Error('controlled close failure');
					closeSync(descriptor);
				},
			}
			: {
				lockUnlink: (path) => {
					calls += 1;
					if (calls === 1) throw new Error('controlled unlink failure');
					unlinkSync(path);
				},
			};
		assertThrows(
			() => installBetaCandidate({ archivePath: release.archivePath, vaultRoot: root, ...options }),
			'install-failed',
			`lock ${lifecycle} failure reported success`,
		);
		for (const [name, bytes] of before) {
			assert(readFileSync(resolve(plugin, name)).equals(bytes), `lock ${lifecycle} failure left the new install applied`);
		}
		assertNoTransactionFiles(plugin, `lock ${lifecycle} failure`);
	}
}

function testConcurrentInstallIsRejected() {
	const older = candidate('concurrent-older', '0.1.0');
	const newer = candidate('concurrent-newer', '0.2.0');
	const root = vault('concurrent');
	seedInstalled(root, '0.0.9');
	const result = installBetaCandidate({
		archivePath: older.archivePath,
		vaultRoot: root,
		beforeWrite: (_name, index) => {
			if (index !== 0) return;
			assertThrows(
				() => installBetaCandidate({ archivePath: newer.archivePath, vaultRoot: root }),
				'install-in-progress',
				'concurrent newer installer was not rejected by the exclusive lock',
			);
		},
	});
	assert(result.version === '0.1.0', 'exclusive install returned the wrong version');
	assert(installedVersion(root) === '0.1.0', 'concurrent installer changed the committed version');

	const mutationRoot = vault('concurrent-direct-mutation');
	const plugin = seedInstalled(mutationRoot, '0.0.9');
	assertThrows(
		() => installBetaCandidate({
			archivePath: older.archivePath,
			vaultRoot: mutationRoot,
			beforeWrite: (_name, index) => {
				if (index === 0) writeFileSync(resolve(plugin, 'manifest.json'), manifestSource('0.2.0'));
			},
		}),
		'install-failed',
		'installed-state mutation between inspection and swap did not turn red',
	);
	assert(installedVersion(mutationRoot) === '0.2.0', 'state revalidation overwrote the newer direct mutation');
}

function testDirectoryAuthorityCannotChange() {
	for (const hook of ['beforeWrite', 'afterBackup', 'afterSwap']) {
		const release = candidate(`authority-${hook}`, '0.1.0');
		const root = vault(`authority-${hook}`);
		const plugin = seedInstalled(root, '0.0.9');
		const external = resolve(testRoot, `external-${hook}`);
		mkdirSync(external);
		writeFileSync(resolve(external, 'sentinel.txt'), `sentinel-${hook}\n`);
		let swapped = false;
		const sabotage = (_name, index) => {
			if (index !== 0 || swapped) return;
			swapped = true;
			renameSync(plugin, `${plugin}-displaced`);
			symlinkSync(external, plugin);
		};
		assertThrows(
			() => installBetaCandidate({ archivePath: release.archivePath, vaultRoot: root, [hook]: sabotage }),
			'install-failed',
			`${hook} directory replacement did not fail closed`,
		);
		assert(
			JSON.stringify(readdirSync(external).sort()) === JSON.stringify(['sentinel.txt']),
			`${hook} directory replacement wrote or deleted outside the vault authority`,
		);
		assert(readFileSync(resolve(external, 'sentinel.txt'), 'utf8') === `sentinel-${hook}\n`, `${hook} changed external bytes`);
	}
}

function testChecksumAndArchiveFailures() {
	const release = candidate('integrity', '0.1.0');
	const badChecksum = resolve(testRoot, 'bad-checksum.sha256');
	writeFileSync(badChecksum, `${'0'.repeat(64)}  ${release.archiveName}\n`);
	assertThrows(
		() => installBetaCandidate({ archivePath: release.archivePath, checksumPath: badChecksum, vaultRoot: vault('bad-checksum') }),
		'checksum-mismatch',
		'wrong checksum did not turn red',
	);

	const tamperedArchive = resolve(testRoot, 'tampered', release.archiveName);
	const bytes = Buffer.from(readFileSync(release.archivePath));
	const central = bytes.readUInt32LE(bytes.length - 22 + 16);
	bytes.write('../ifest.json', central + 46, 'utf8');
	mkdirSync(dirname(tamperedArchive), { recursive: true });
	writeFileSync(tamperedArchive, bytes);
	writeChecksum(tamperedArchive, bytes);
	assertThrows(
		() => installBetaCandidate({ archivePath: tamperedArchive, vaultRoot: vault('bad-archive') }),
		'archive-invalid',
		'rehashed traversal archive did not turn red',
	);

	const wrongName = resolve(testRoot, 'other-0.1.0.zip');
	writeFileSync(wrongName, readFileSync(release.archivePath));
	writeChecksum(wrongName, readFileSync(wrongName));
	assertThrows(
		() => installBetaCandidate({ archivePath: wrongName, vaultRoot: vault('wrong-name') }),
		'archive-name-mismatch',
		'foreign archive name did not turn red',
	);

	const foreign = candidate('foreign-manifest', '0.1.0', 'Mallory');
	assertThrows(
		() => installBetaCandidate({ archivePath: foreign.archivePath, vaultRoot: vault('foreign-manifest') }),
		'manifest-invalid',
		'rehashed foreign manifest did not turn red',
	);

	const incompatible = candidate('incompatible-manifest', '0.1.0', 'fodaveg', '99.0.0');
	assertThrows(
		() => installBetaCandidate({ archivePath: incompatible.archivePath, vaultRoot: vault('incompatible-manifest') }),
		'manifest-invalid',
		'rehashed incompatible minimum Obsidian version did not turn red',
	);
}

// The installer travels inside the release artifact and cannot import repository
// modules, so its identity literals must stay literals. This is the only place that
// ties them to the artifact that actually ships: it feeds installBetaCandidate the
// repository's real manifest.json. If manifest.json changes and install-beta.mjs does
// not (or the other way round), this turns red.
function testInstallerAcceptsRepositoryManifest() {
	const source = readFileSync(resolve('manifest.json'), 'utf8');
	const manifest = JSON.parse(source);
	const release = candidateFromManifest('repository-manifest', source);
	try {
		const result = install(release, vault('repository-manifest'));
		assert(result.status === 'installed', 'the repository manifest.json did not install cleanly');
	} catch (error) {
		const code = error instanceof BetaInstallError ? error.code : String(error);
		fail(`install-beta.mjs rejected the repository manifest.json with ${code}: its identity literals drifted from manifest.json`);
		return;
	}
	for (const [key, value, code] of [
		['author', `${manifest.author}-drift`, 'manifest-invalid'],
		['name', `${manifest.name} Drift`, 'manifest-invalid'],
		['minAppVersion', '99.0.0', 'manifest-invalid'],
		['id', `${manifest.id}-drift`, 'manifest-invalid'],
	]) {
		const drifted = candidateFromManifest(
			`repository-manifest-${key}`,
			`${JSON.stringify({ ...manifest, [key]: value }, null, '\t')}\n`,
		);
		assertInstallError(drifted, vault(`repository-manifest-${key}`), code, `drifted manifest ${key} did not turn red`);
	}
}

function testInstallerZipMatrix() {
	const release = candidate('zip-matrix', '0.1.0');
	const archive = readFileSync(release.archivePath);
	const end = archive.length - 22;
	const central = archive.readUInt32LE(end + 16);
	const payload = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
	const cases = [
		['local signature', (bytes) => bytes.writeUInt32LE(0, 0)],
		['central signature', (bytes) => bytes.writeUInt32LE(0, central)],
		['local and central name', (bytes) => {
			bytes.write('evilfest.json', 30, 'utf8');
			bytes.write('evilfest.json', central + 46, 'utf8');
		}],
		['payload crc', (bytes) => { bytes[payload] ^= 0x01; }],
		['local crc', (bytes) => bytes.writeUInt32LE(0, 14)],
		['central crc', (bytes) => bytes.writeUInt32LE(0, central + 16)],
		['local flags', (bytes) => bytes.writeUInt16LE(0, 6)],
		['central flags', (bytes) => bytes.writeUInt16LE(0, central + 8)],
		['local method', (bytes) => bytes.writeUInt16LE(8, 8)],
		['central method', (bytes) => bytes.writeUInt16LE(8, central + 10)],
		['local compressed size', (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(18) + 1, 18)],
		['local size', (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(22) + 1, 22)],
		['central compressed size', (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(central + 20) + 1, central + 20)],
		['central size', (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(central + 24) + 1, central + 24)],
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
	for (const [index, [label, mutate]] of cases.entries()) {
		const sabotaged = Buffer.from(archive);
		mutate(sabotaged);
		assert(!sabotaged.equals(archive), `${label} installer ZIP sabotage changed no bytes`);
		const folder = resolve(testRoot, `installer-zip-${String(index)}`);
		const path = resolve(folder, release.archiveName);
		mkdirSync(folder, { recursive: true });
		writeFileSync(path, sabotaged);
		writeChecksum(path, sabotaged);
		assertThrows(
			() => installBetaCandidate({ archivePath: path, vaultRoot: vault(`installer-zip-${String(index)}`) }),
			'archive-invalid',
			`${label} installer ZIP sabotage did not activate its internal guard`,
		);
	}
}

function testInstalledStateFailures() {
	const release = candidate('installed-state', '0.1.0');
	const partialRoot = vault('partial');
	const partial = resolve(partialRoot, CONFIG_DIRECTORY, 'plugins/tyrian-companion');
	mkdirSync(partial, { recursive: true });
	writeFileSync(resolve(partial, 'manifest.json'), manifestSource('0.0.9'));
	assertInstallError(release, partialRoot, 'installed-partial', 'partial installed state did not turn red');

	const sameRoot = vault('same');
	seedInstalled(sameRoot, '0.1.0');
	assertInstallError(release, sameRoot, 'version-not-newer', 'same-version reinstall did not turn red');

	const downgradeRoot = vault('downgrade');
	seedInstalled(downgradeRoot, '0.2.0');
	assertInstallError(release, downgradeRoot, 'version-not-newer', 'downgrade did not turn red');

	const preciseRelease = candidate('precise-semver', '9007199254740993.0.0');
	const preciseRoot = vault('precise-semver');
	seedInstalled(preciseRoot, '9007199254740992.0.0');
	const preciseResult = install(preciseRelease, preciseRoot);
	assert(preciseResult.status === 'updated', 'large semver components lost comparison precision');

	const symlinkFileRoot = vault('managed-symlink');
	const plugin = seedInstalled(symlinkFileRoot, '0.0.9');
	rmSync(resolve(plugin, 'main.js'));
	symlinkSync(resolve(plugin, 'styles.css'), resolve(plugin, 'main.js'));
	assertInstallError(release, symlinkFileRoot, 'installed-file-invalid', 'managed-file symlink did not turn red');
}

function testPathFailures() {
	const release = candidate('paths', '0.1.0');
	const archiveLink = resolve(testRoot, release.archiveName);
	symlinkSync(release.archivePath, archiveLink);
	symlinkSync(`${release.archivePath}.sha256`, `${archiveLink}.sha256`);
	assertInstallError(releaseWithPath(release, archiveLink), vault('archive-link'), 'archive-invalid', 'archive symlink did not turn red');

	const checksumLink = resolve(testRoot, 'linked-checksum.sha256');
	symlinkSync(`${release.archivePath}.sha256`, checksumLink);
	assertThrows(
		() => installBetaCandidate({ archivePath: release.archivePath, checksumPath: checksumLink, vaultRoot: vault('checksum-link') }),
		'checksum-invalid',
		'checksum symlink did not turn red',
	);

	const realVault = vault('real-vault');
	const linkedVault = resolve(testRoot, 'linked-vault');
	symlinkSync(realVault, linkedVault);
	assertInstallError(release, linkedVault, 'vault-invalid', 'vault symlink did not turn red');

	const configLinkRoot = resolve(testRoot, 'vault-config-link');
	const externalConfig = resolve(testRoot, 'external-config');
	mkdirSync(configLinkRoot);
	mkdirSync(externalConfig);
	symlinkSync(externalConfig, resolve(configLinkRoot, CONFIG_DIRECTORY));
	assertInstallError(release, configLinkRoot, 'obsidian-directory-missing', 'config-directory symlink did not turn red');

	const pluginLinkRoot = vault('plugin-link');
	const external = resolve(testRoot, 'external-plugin');
	mkdirSync(external);
	mkdirSync(resolve(pluginLinkRoot, CONFIG_DIRECTORY, 'plugins'), { recursive: true });
	symlinkSync(external, resolve(pluginLinkRoot, CONFIG_DIRECTORY, 'plugins/tyrian-companion'));
	assertInstallError(release, pluginLinkRoot, 'plugin-directory-invalid', 'plugin-directory symlink did not turn red');
}

function testCliConfirmation() {
	const parsed = parseBetaInstallArguments([
		'install', '--vault', '/safe/vault', '--archive', '/safe/candidate.zip', '--config-dir', '.config', '--confirm-obsidian-closed',
	]);
	assert(
		parsed.vaultRoot === '/safe/vault' && parsed.archivePath === '/safe/candidate.zip' && parsed.configDir === '.config',
		'valid CLI arguments did not parse',
	);
	for (const [name, argv, code] of [
		['missing-confirmation', ['install', '--vault', '/safe/vault', '--archive', '/safe/candidate.zip'], 'usage'],
		['duplicate-vault', ['install', '--vault', '/a', '--vault', '/b', '--archive', '/c', '--confirm-obsidian-closed'], 'usage'],
		['unknown-flag', ['install', '--vault', '/a', '--archive', '/c', '--confirm-obsidian-closed', '--force'], 'usage'],
		['unsafe-config-dir', ['install', '--vault', '/a', '--archive', '/c', '--config-dir', '../escape', '--confirm-obsidian-closed'], 'config-directory-invalid'],
	]) {
		assertThrows(() => parseBetaInstallArguments(argv), code, `${name} CLI sabotage did not turn red`);
	}
}

function testCliEntrypoint() {
	const release = candidate('cli-entrypoint', '0.1.0');
	const root = vault('cli-entrypoint-private-path');
	const result = spawnSync(process.execPath, [
		resolve('scripts/install-beta.mjs'),
		'install',
		'--vault', root,
		'--archive', release.archivePath,
		'--confirm-obsidian-closed',
	], { encoding: 'utf8' });
	assert(result.status === 0 && result.stderr === '', 'real CLI install did not succeed cleanly');
	assert(
		result.stdout === 'beta channel v1: PASS (installed none -> 0.1.0; files=manifest.json,main.js,styles.css)\n',
		'real CLI install returned unexpected output',
	);
	assert(!result.stdout.includes(root) && !result.stdout.includes(release.archivePath), 'real CLI output exposed local paths');
	assertManagedFiles(root, release);
}

function testPreparedArtifact() {
	const release = candidate('artifact-stage', '0.1.0');
	writeInstallerFixture(release.root);
	const prepared = prepareBetaArtifact({ root: release.root });
	const expected = [release.archiveName, `${release.archiveName}.sha256`, 'install-beta.mjs'].sort();
	assert(JSON.stringify(readdirSync(prepared.stageRoot).sort()) === JSON.stringify(expected), 'beta artifact stage was not exact');
	assert(
		readFileSync(resolve(prepared.stageRoot, 'install-beta.mjs')).equals(readFileSync(resolve('scripts/install-beta.mjs'))),
		'beta artifact installer bytes changed',
	);
	for (const [name, extra] of [
		['extra-zip', 'tyrian-companion-decoy.zip'],
		['extra-checksum', 'tyrian-companion-decoy.zip.sha256'],
	]) {
		assertArtifactThrows(
			() => prepareBetaArtifact({
				root: release.root,
				beforeSeal: (stageRoot) => writeFileSync(resolve(stageRoot, extra), 'decoy'),
			}),
			'stage-file-set',
			`${name} artifact stage sabotage stayed green`,
		);
	}
	for (const [name, replacement] of [
		[release.archiveName, Buffer.from('malicious archive')],
		[`${release.archiveName}.sha256`, Buffer.from(`${'0'.repeat(64)}  ${release.archiveName}\n`)],
		['install-beta.mjs', Buffer.from('process.exit(0);\n')],
	]) {
		assertArtifactThrows(
			() => prepareBetaArtifact({
				root: release.root,
				beforeSeal: (stageRoot) => writeFileSync(resolve(stageRoot, name), replacement),
			}),
			'stage-bytes-changed',
			`${name} same-name replacement stayed green`,
		);
	}

	const stageSwap = candidate('artifact-stage-swap', '0.1.0');
	writeInstallerFixture(stageSwap.root);
	const external = resolve(testRoot, 'artifact-stage-external');
	mkdirSync(external);
	writeFileSync(resolve(external, 'sentinel.txt'), 'external sentinel\n');
	assertArtifactThrows(
		() => prepareBetaArtifact({
			root: stageSwap.root,
			beforeSeal: (stageRoot) => {
				renameSync(stageRoot, `${stageRoot}-displaced`);
				symlinkSync(external, stageRoot);
			},
		}),
		'stage-authority-changed',
		'artifact stage symlink replacement stayed green',
	);
	assert(readFileSync(resolve(external, 'sentinel.txt'), 'utf8') === 'external sentinel\n', 'stage cleanup followed external symlink');

	const linked = candidate('artifact-linked-installer', '0.1.0');
	mkdirSync(resolve(linked.root, 'scripts'));
	symlinkSync(resolve('scripts/install-beta.mjs'), resolve(linked.root, 'scripts/install-beta.mjs'));
	assertArtifactThrows(
		() => prepareBetaArtifact({ root: linked.root }),
		'source-invalid',
		'symlink installer entered the beta artifact stage',
	);
}

function testCiArtifactContract() {
	const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
	const packageSource = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
	const validate = (workflowSource = workflow, candidatePackage = packageSource) => validateBetaChannelContract({
		packageSource: candidatePackage,
		workflowSource,
	});
	assert(validate().findings.length === 0, 'CI artifact does not expose the exact guarded beta-channel files');
	for (const [name, source] of [
		['broad-release-directory', workflow.replace('          path: .beta-artifact/*', '          path: .release/')],
		['missing-stage', workflow.replace('      - run: npm run beta:artifact\n', '')],
		['reordered-stage', workflow.replace('      - run: npm run release:package\n      - run: npm run beta:artifact', '      - run: npm run beta:artifact\n      - run: npm run release:package')],
		['mutator-between-stage-and-upload', workflow.replace('      - run: npm run beta:artifact\n      - uses:', '      - run: npm run beta:artifact\n      - run: cp README.md .beta-artifact/tyrian-companion-decoy.zip\n      - uses:')],
		['duplicate-upload', workflow.replace('      - uses: actions/upload-artifact@v4\n        with:\n          name: tyrian-companion-', '      - uses: actions/upload-artifact@v4\n        with:\n          name: decoy\n          path: scripts/install-beta.mjs\n      - uses: actions/upload-artifact@v4\n        with:\n          name: tyrian-companion-')],
		['versioned-extra-upload', workflow.replace('      - run: npm run beta:artifact\n      - uses: actions/upload-artifact@v4\n', '      - run: npm run beta:artifact\n      - uses: actions/upload-artifact@v4.4.3\n        with:\n          name: decoy\n          path: .\n      - uses: actions/upload-artifact@v4\n')],
		['main-extra-upload', workflow.replace('      - run: npm run beta:artifact\n      - uses: actions/upload-artifact@v4\n', '      - run: npm run beta:artifact\n      - uses: actions/upload-artifact@main\n        with:\n          name: decoy\n          path: .\n      - uses: actions/upload-artifact@v4\n')],
		['case-alternative-upload', workflow.replace('      - run: npm run beta:artifact\n      - uses: actions/upload-artifact@v4\n', '      - run: npm run beta:artifact\n      - uses: Actions/Upload-Artifact@v4\n        with:\n          name: decoy\n          path: .\n      - uses: actions/upload-artifact@v4\n')],
		['extra-upload-key', workflow.replace('          retention-days: 14', '          retention-days: 14\n          overwrite: true')],
	]) {
		assert(validate(source).findings.length > 0, `${name} workflow sabotage stayed green`);
	}
	const packageJson = JSON.parse(packageSource);
	packageJson.scripts['beta:artifact'] = 'echo skipped';
	assert(validate(workflow, `${JSON.stringify(packageJson)}\n`).findings.length > 0, 'beta artifact package-script sabotage stayed green');
}

function install(release, root) {
	return installBetaCandidate({ archivePath: release.archivePath, vaultRoot: root });
}

function assertInstallError(release, root, code, message) {
	assertThrows(() => install(release, root), code, message);
}

function candidate(name, version, author = 'fodaveg', minAppVersion = '1.11.4') {
	return candidateFromManifest(name, manifestSource(version, author, minAppVersion));
}

// Packages a candidate from an arbitrary manifest source so the suite can feed the
// installer the repository's REAL manifest.json instead of a fabricated one.
function candidateFromManifest(name, source) {
	const manifest = JSON.parse(source);
	const root = resolve(testRoot, `candidate-${name}`);
	mkdirSync(root, { recursive: true });
	writeJson(resolve(root, 'package.json'), { name: manifest.id, version: manifest.version });
	writeFileSync(resolve(root, 'manifest.json'), source);
	writeJson(resolve(root, 'versions.json'), { [manifest.version]: manifest.minAppVersion });
	writeFileSync(resolve(root, 'styles.css'), `.candidate-${name} { color: red; }\n`);
	const result = packageRelease({ root, build: controlledBuild });
	return { ...result, archiveName: basename(result.archivePath), root };
}

function releaseWithPath(release, archivePath) {
	return { ...release, archivePath };
}

function controlledBuild(root) {
	writeFileSync(resolve(root, 'main.js'), '/* controlled beta candidate */\nmodule.exports = {};\n');
}

function vault(name) {
	const root = resolve(testRoot, `vault-${name}`);
	mkdirSync(resolve(root, CONFIG_DIRECTORY), { recursive: true });
	return root;
}

function seedInstalled(root, version) {
	const plugin = resolve(root, CONFIG_DIRECTORY, 'plugins/tyrian-companion');
	mkdirSync(plugin, { recursive: true });
	writeFileSync(resolve(plugin, 'manifest.json'), manifestSource(version));
	writeFileSync(resolve(plugin, 'main.js'), `/* installed ${version} */\n`);
	writeFileSync(resolve(plugin, 'styles.css'), `/* installed ${version} */\n`);
	return plugin;
}

function installedVersion(root) {
	const source = readFileSync(resolve(root, CONFIG_DIRECTORY, 'plugins/tyrian-companion/manifest.json'), 'utf8');
	return JSON.parse(source).version;
}

function transactionFile(plugin, prefix, managedName) {
	const matches = readdirSync(plugin).filter((name) => name.startsWith(prefix) && name.endsWith(`-${managedName}`));
	assert(matches.length === 1, `expected one ${prefix} file for ${managedName}`);
	return resolve(plugin, matches[0] ?? 'missing-transaction-file');
}

function assertNoTransactionFiles(plugin, label) {
	const names = readdirSync(plugin);
	assert(
		names.every((name) => !name.startsWith('.tyrian-next-') && !name.startsWith('.tyrian-backup-') &&
			!name.startsWith('.tyrian-recovery-') && name !== '.tyrian-beta-install.lock'),
		`${label} left transaction files behind`,
	);
}

function writeInstallerFixture(root) {
	mkdirSync(resolve(root, 'scripts'), { recursive: true });
	writeFileSync(resolve(root, 'scripts/install-beta.mjs'), readFileSync(resolve('scripts/install-beta.mjs')));
}

function manifestSource(version, author = 'fodaveg', minAppVersion = '1.11.4') {
	return `${JSON.stringify({
		id: 'tyrian-companion',
		name: 'Tyrian Companion',
		version,
		minAppVersion,
		description: 'Controlled beta candidate.',
		author,
		isDesktopOnly: true,
	}, null, '\t')}\n`;
}

function assertManagedFiles(root, release) {
	const plugin = resolve(root, CONFIG_DIRECTORY, 'plugins/tyrian-companion');
	for (const name of BETA_RELEASE_FILES) {
		assert(
			readFileSync(resolve(plugin, name)).equals(readFileSync(resolve(release.stageRoot, name))),
			`installed ${name} differs from the verified candidate`,
		);
	}
}

function writeChecksum(path, bytes) {
	const digest = createHash('sha256').update(bytes).digest('hex');
	writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
}

function exists(path) {
	try {
		lstatSync(path);
	} catch {
		return false;
	}
	return true;
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
		assert(error instanceof BetaInstallError && error.code === code, `${message} (wrong error)`);
	}
}

function assertArtifactThrows(callback, code, message) {
	try {
		callback();
		fail(message);
	} catch (error) {
		assert(error instanceof BetaArtifactError && error.code === code, `${message} (wrong error)`);
	}
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}

function fail(message) {
	failures.push(message);
}
