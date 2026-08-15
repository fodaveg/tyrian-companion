import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { validateH8HelperDecisionContract } from '../h8-native-decision-contract.mjs';

const root = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-h8-helper-decision-'));
const failures = [];
const trackedFiles = [
	'.github/workflows/ci.yml',
	'README.md',
	'docs/ARCHITECTURE.md',
	'docs/CHANGELOG.md',
	'docs/ESTADO.md',
	'docs/PLATFORM_POLICY.md',
	'docs/THREAT-MODEL.md',
	'docs/adr/0001-h8-3-native-mumble-helper.md',
	'docs/adr/0003-h8-5-native-helper-runtime.md',
	'native/mumble-helper/.cargo/config.toml',
	'native/mumble-helper/Cargo.lock',
	'native/mumble-helper/Cargo.toml',
	'native/mumble-helper/rust-toolchain.toml',
	'native/mumble-helper/src/framing.rs',
	'native/mumble-helper/src/lib.rs',
	'native/mumble-helper/src/main.rs',
	'native/mumble-helper/src/protocol.rs',
	'native/mumble-helper/src/source.rs',
	'native/mumble-helper/src/win32.rs',
	'native/mumble-helper/tests/server_lifecycle.rs',
];
const files = new Map(trackedFiles.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));

try {
	assert(validateH8HelperDecisionContract(root).findings.length === 0, 'current repository failed the H8.3 decision contract');
	testDecisionSabotages();
	testBlockSabotages();
	testDocumentationSabotage();
	testRuntimeAdrSabotages();
	testImplementationSabotages();
	testImplementedHelperSabotages();
	testCiArtifactSabotages();
	testSymlinkSabotages();
	testLegitimateFilesOutsideScope();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

function testCiArtifactSabotages() {
	const path = '.github/workflows/ci.yml';
	const source = files.get(path);
	for (const [name, before, after, finding] of [
		['pdb-in-artifact', "'.pdb', ", '', "ci-artifact-term:$forbiddenExtensions = @('.exe', '.dll', '.pdb', '.lib', '.obj', '.rlib', '.rmeta')"],
		['artifact-file-set', 'if ($artifactFiles.Count -ne 1', 'if ($artifactFiles.Count -lt 1', 'ci-artifact-term:if ($artifactFiles.Count -ne 1'],
		['artifact-upload-path', 'path: native/mumble-helper/artifact-upload/UNSIGNED-NOT-FOR-RELEASE.txt', 'path: native/mumble-helper/target/repro-b/', 'ci-artifact-term:path: native/mumble-helper/artifact-upload/UNSIGNED-NOT-FOR-RELEASE.txt'],
		['artifact-retention', 'retention-days: 1', 'retention-days: 2', 'ci-artifact-retention'],
	]) {
		assert(source.includes(before), `${name} fixture marker is missing`);
		expectFinding(name, new Map([[path, source.replace(before, after)]]), finding);
	}
	expectFinding(
		'target-pdb-rejected',
		new Map([[path, source.replace(
			"$artifactStage = 'artifact-upload'",
			"$unexpected = Get-ChildItem target -Filter *.pdb`n          if ($unexpected) { throw 'unexpected DLL/PDB output' }`n          $artifactStage = 'artifact-upload'",
		)]]),
		'ci-target-pdb-rejection',
	);
}

function testRuntimeAdrSabotages() {
	const path = 'docs/adr/0003-h8-5-native-helper-runtime.md';
	const source = files.get(path);
	expectFinding(
		'runtime-adr-role',
		new Map([[path, source.replace('"role": "helper_server_only"', '"role": "plugin_client"')]]),
		'runtime-adr-value',
	);
	expectFinding(
		'runtime-adr-free-claim',
		new Map([[path, `${source}QA real completada.\n`]]),
		'runtime-adr-document-hash',
	);
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`H8.3 helper decision contract suite: ${String(failures.length)} failure(s)\n`);
	process.exit(1);
}
process.stdout.write('H8.3 helper decision contract suite: PASS\n');

function testDecisionSabotages() {
	for (const [name, before, after] of [
		['language', '"language": "rust"', '"language": "csharp"'],
		['status', '"status": "accepted_for_implementation"', '"status": "final"'],
		['target', '"target": "x86_64-pc-windows-msvc"', '"target": "aarch64-pc-windows-msvc"'],
		['crt', '"-C target-feature=+crt-static"', '"-C target-feature=-crt-static"'],
		['single-pe', '"tyrian-mumble-helper.exe"', '"tyrian-mumble-helper.dll"'],
		['separate-package', '"pluginArchiveIncluded": false', '"pluginArchiveIncluded": true'],
		['qa', '"qa": "pending"', '"qa": "passed"'],
		['unsupported', '"windows_arm64",', '"windows_arm64_emulated",'],
		['signature', '"status": "pending",\n    "releaseAllowed": false', '"status": "signed",\n    "releaseAllowed": true'],
		['risk', '"ffi_layout_or_tick_rollover_error",', '"risk_removed",'],
		['reopen-trigger', '"csharp_proves_materially_safer_or_more_compatible",', '"never_reopen",'],
	]) {
		const adr = files.get('docs/adr/0001-h8-3-native-mumble-helper.md');
		assert(adr.includes(before), `${name} sabotage fixture marker is missing`);
		expectFinding(name, new Map([['docs/adr/0001-h8-3-native-mumble-helper.md', adr.replace(before, after)]]), 'decision-schema');
	}

	const adr = files.get('docs/adr/0001-h8-3-native-mumble-helper.md');
	const extra = adr.replace('  "schemaVersion": 1,', '  "schemaVersion": 1,\n  "unexpected": true,');
	expectFinding('extra-schema-key', new Map([['docs/adr/0001-h8-3-native-mumble-helper.md', extra]]), 'decision-schema');
}

function testBlockSabotages() {
	const path = 'docs/adr/0001-h8-3-native-mumble-helper.md';
	const adr = files.get(path);
	expectFinding('duplicate-block', new Map([[path, `${adr}\n${adr}`]]), 'decision-block-count');
	expectFinding('invalid-json', new Map([[path, adr.replace('"schemaVersion": 1', '"schemaVersion":')]]), 'decision-json');
	expectFinding(
		'decision-byte-hash',
		new Map([[path, adr.replace('"schemaVersion": 1,', '"schemaVersion": 1, ')]]),
		'decision-hash',
	);
	expectFinding(
		'adr-free-qa-claim',
		new Map([[path, adr.replace(
			'\n<!-- h8.3-adr-authority:end -->',
			'\nQA completada en las tres plataformas.\n<!-- h8.3-adr-authority:end -->',
		)]]),
		'adr-authority-hash',
	);
	expectFinding(
		'adr-preamble-qa-claim',
		new Map([[path, adr.replace(
			'<!-- h8.3-adr-authority:start -->',
			'QA completada fuera del bloque.\n<!-- h8.3-adr-authority:start -->',
		)]]),
		'adr-authority-envelope',
	);
}

function testDocumentationSabotage() {
	const path = 'docs/PLATFORM_POLICY.md';
	const source = files.get(path);
	expectFinding(
		'platform-qa',
		new Map([[path, source.replaceAll('qa=pending', 'qa=unknown')]]),
		'document-term:docs/PLATFORM_POLICY.md:qa=pending',
	);
	expectFinding(
		'incompatible-platform-qa',
		new Map([[path, source.replace(
			'\n<!-- h8.3-platform-authority:end -->',
			'\nQA completada para H8.3.\n<!-- h8.3-platform-authority:end -->',
		)]]),
		'platform-authority-hash',
	);
	expectFinding(
		'platform-qa-outside-fragment',
		new Map([[path, source.replace(
			'<!-- h8.3-platform-authority:end -->\n\n## Política de terceros y operaciones',
			'<!-- h8.3-platform-authority:end -->\nQA completada fuera del fragmento.\n\n## Política de terceros y operaciones',
		)]]),
		'platform-authority-envelope',
	);
	expectFinding(
		'platform-qa-at-document-end',
		new Map([[path, `${source}QA completada para H8.3.\n`]]),
		'platform-document-hash',
	);
}

function testImplementationSabotages() {
	for (const [name, path] of [
		['cargo', 'Cargo.toml'],
		['cargo-lock', 'vendor/Cargo.lock'],
		['cargo-config', '.cargo/config'],
		['cargo-config-toml', 'native/.cargo/config.toml'],
		['rust-toolchain', 'rust-toolchain'],
		['rust-toolchain-toml', 'native/rust-toolchain.toml'],
		['alternative-native-tree', 'native/mumble_helper/main.ts'],
		['native-csharp-source', 'native/MumbleHelper.cs'],
		['alternative-helper-path', 'tools/mumble_helper/main.ts'],
		['alternative-helper-name', 'src/platform/MumbleHelper.ts'],
		['root-extensionless-helper', 'mumble-helper'],
		['mumble-link-helper-tree', 'tools/mumble-link-helper/main.ts'],
		['script-mumble-helper', 'scripts/mumble-helper.mjs'],
		['script-rust-source', 'scripts/reader.rs'],
		['helper-mumble-reader', 'helpers/mumble-link-reader/main.rs'],
		['tool-mumble-reader', 'tools/mumble-link-reader/main.ts'],
		['mumble-ipc-tree', 'tools/mumble-ipc/reader.ts'],
		['mumble-ipc-file', 'tools/mumble-ipc.ts'],
		['rust-source', 'platform/helper.rs'],
		['csharp-source', 'platform/helper.cs'],
		['csharp-project', 'platform/helper.csproj'],
		['executable', 'artifacts/tyrian-mumble-helper.exe'],
		['library', 'artifacts/tyrian-mumble-helper.dll'],
		['debug-symbols', 'artifacts/tyrian-mumble-helper.pdb'],
		['static-library', 'artifacts/tyrian-mumble-helper.lib'],
		['object-file', 'artifacts/tyrian-mumble-helper.obj'],
		['rust-library', 'artifacts/libhelper.rlib'],
		['rust-metadata', 'artifacts/helper.rmeta'],
		['output-inside-examples', 'docs/examples/helper.rlib'],
		['unreviewed-spike-file', 'spikes/h8-mumble-crossover/rogue.c'],
		['unreviewed-spike-test-file', 'spikes/h8-mumble-crossover/tests/rogue.c'],
		['unreviewed-spike-spec-file', 'spikes/h8-mumble-crossover/rogue.spec.c'],
	]) {
		expectFinding(name, new Map([[path, 'controlled H8.3 sabotage\n']]), `forbidden-product-artifact:${path}`);
	}

	for (const [name, path, marker] of [
		['content-marker-base', 'tools/renamed-reader.ts', 'MumbleLink'],
		['content-marker-helper', 'src/platform/local-helper.ts', 'MumbleLinkHelper'],
		['content-marker-reader', 'src/platform/local-reader.ts', 'MumbleLinkReader'],
		['content-marker-lowercase', 'scripts/local-reader.mjs', 'mumblelink'],
		['content-marker-snake-case', 'tools/local-reader.ts', 'mumble_link'],
		['content-marker-snake-suffix', 'src/platform/frame-reader.ts', 'MUMBLE_LINK_READER'],
		['content-marker-client-suffix', 'tools/local-client.ts', 'MumbleLinkClient'],
		['content-marker-frame-suffix', 'src/platform/frame-client.ts', 'MUMBLE_LINK_FRAME'],
		['content-marker-hyphen-string', 'scripts/local-frame.mjs', 'mumble-link-frame'],
	]) {
		expectFinding(name, new Map([[path, `export const marker = '${marker}';\n`]]), `forbidden-product-artifact:${path}`);
	}
}

function testImplementedHelperSabotages() {
	for (const [name, path, before, after, finding] of [
		['dependency-pin', 'native/mumble-helper/Cargo.toml', 'getrandom = "=0.3.4"', 'getrandom = "=0.4.3"', 'native-manifest-term:getrandom = "=0.3.4"'],
		['toolchain-target', 'native/mumble-helper/rust-toolchain.toml', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'native-toolchain-value'],
		['crt-static', 'native/mumble-helper/.cargo/config.toml', '+crt-static', '-crt-static', 'native-cargo-config-value'],
		['reproducible-link', 'native/mumble-helper/.cargo/config.toml', 'link-arg=/Brepro', 'link-arg=/INCREMENTAL', 'native-cargo-config-value'],
		['constant-time', 'native/mumble-helper/src/protocol.rs', 'ConstantTimeEq', 'ordinaryEquality', 'native-protocol-term:ConstantTimeEq'],
		['parsed-string-zeroize', 'native/mumble-helper/src/protocol.rs', 'impl Drop for SecretString', 'impl SecretString', 'native-protocol-term:impl Drop for SecretString'],
		['decoded-zeroize', 'native/mumble-helper/src/protocol.rs', 'accumulator.zeroize()', 'let _ = accumulator', 'native-protocol-term:accumulator.zeroize()'],
		['invalid-frame-zeroize', 'native/mumble-helper/src/framing.rs', 'payload.zeroize()', 'payload.clear()', 'native-framing-term:payload.zeroize()'],
		['partial-frame-zeroize', 'native/mumble-helper/src/framing.rs', 'if let Err(error) = read_exact_classified(reader, &mut payload)', 'read_exact_classified(reader, &mut payload)?;', 'native-framing-term:if let Err(error) = read_exact_classified(reader, &mut payload)'],
		['raw-bootstrap-zeroize', 'native/mumble-helper/src/main.rs', 'bootstrap_frame.zeroize()', 'bootstrap_frame.clear()', 'native-server-term:bootstrap_frame.zeroize()'],
		['partial-tcp-zeroize', 'native/mumble-helper/src/main.rs', 'read_until(listener, stream, &mut payload, deadline, shutdown).is_err()', 'read_until(listener, stream, &mut payload, deadline, shutdown).is_ok()', 'native-server-term:read_until(listener, stream, &mut payload, deadline, shutdown).is_err()'],
		['heartbeat-timeout', 'native/mumble-helper/src/protocol.rs', 'HEARTBEAT_TIMEOUT_MS', 'HEARTBEAT_DISABLED_MS', 'native-protocol-term:HEARTBEAT_TIMEOUT_MS'],
		['cadence-scheduler', 'native/mumble-helper/src/source.rs', 'CadenceSchedule', 'CatchUpSchedule', 'native-cadence-term:CadenceSchedule'],
		['cadence-timeout-route', 'native/mumble-helper/src/source.rs', 'CadenceDecision::HeartbeatTimeout', 'CadenceDecision::Due', 'native-cadence-term:CadenceDecision::HeartbeatTimeout'],
		['cadence-record-refresh', 'native/mumble-helper/src/main.rs', 'cadence.record_emitted', 'cadence.next_slot_at', 'native-server-term:cadence.record_emitted'],
		['active-pending', 'native/mumble-helper/src/main.rs', 'maintain_pending_connection', 'reject_additional_connections', 'native-server-term:maintain_pending_connection'],
		['read-only', 'native/mumble-helper/src/win32.rs', 'FILE_MAP_READ', 'FILE_MAP_WRITE', 'native-win32-term:FILE_MAP_READ'],
		['loopback', 'native/mumble-helper/src/main.rs', 'Ipv4Addr::LOCALHOST', '"8.8.8.8"', 'native-server-term:Ipv4Addr::LOCALHOST'],
		['unsafe-scope', 'native/mumble-helper/src/main.rs', 'fn main() {', 'fn main() { unsafe {}', 'native-unsafe-scope:native/mumble-helper/src/main.rs'],
		['pid-surface', 'native/mumble-helper/src/main.rs', 'fn main() {', 'fn main() { let pid = 7;', 'native-prohibited-surface:native/mumble-helper/src/main.rs'],
	]) {
		const source = files.get(path);
		assert(source.includes(before), `${name} fixture marker is missing`);
		expectFinding(name, new Map([[path, source.replaceAll(before, after)]]), finding);
	}
	const manifest = files.get('native/mumble-helper/Cargo.toml');
	expectFinding(
		'extra-dependency',
		new Map([['native/mumble-helper/Cargo.toml', manifest.replace('[dependencies]', '[dependencies]\nserde = "1"')]]),
		'native-manifest-hash',
	);
	expectFinding(
		'unreviewed-native-module',
		new Map([['native/mumble-helper/src/identity.rs', 'pub const IDENTITY: bool = true;\n']]),
		'forbidden-product-artifact:native/mumble-helper/src/identity.rs',
	);
	expectFinding(
		'tracked-target-artifact',
		new Map([['native/mumble-helper/target/release/rogue.exe', 'MZ']]),
		'forbidden-product-artifact:native/mumble-helper/target/release/rogue.exe',
	);
	const main = files.get('native/mumble-helper/src/main.rs');
	expectFinding(
		'production-after-cfg-test',
		new Map([['native/mumble-helper/src/main.rs', `${main}\nfn rogue() { TcpStream::connect("8.8.8.8:80"); }\n`]]),
		'native-external-address:native/mumble-helper/src/main.rs',
	);
	const lifecycle = files.get('native/mumble-helper/tests/server_lifecycle.rs');
	expectFinding(
		'active-pending-third-test',
		new Map([['native/mumble-helper/tests/server_lifecycle.rs', lifecycle.replace(
			'one_authenticated_and_one_pending_are_kept_while_a_third_is_rejected',
			'active_only',
		)]]),
		'native-lifecycle-term:active-pending-third',
	);
	expectFinding(
		'rejected-payloads-test',
		new Map([['native/mumble-helper/tests/server_lifecycle.rs', lifecycle.replace(
			'truncated_bom_and_invalid_utf8_hello_payloads_fail_closed',
			'rejected_payloads_removed',
		)]]),
		'native-lifecycle-term:rejected-payloads',
	);
}

function testSymlinkSabotages() {
	for (const [name, path, target] of [
		['native-helper-symlink', 'native/other-mumble-helper', '../controlled-target.txt'],
		['native-output-symlink', 'artifacts/tyrian-mumble-helper.exe', '../controlled-target.txt'],
		['hidden-rust-target', 'links/helper-source', '../controlled-target.rs'],
		['example-source-symlink', 'docs/examples/helper.rs', '../../controlled-target.txt'],
	]) {
		const directory = fixture(name);
		write(directory, 'controlled-target.txt', 'controlled target\n');
		write(directory, 'controlled-target.rs', 'controlled target\n');
		const destination = join(directory, path);
		mkdirSync(dirname(destination), { recursive: true });
		symlinkSync(target, destination);
		const finding = `forbidden-product-artifact:${path}`;
		assert(validateH8HelperDecisionContract(directory).findings.includes(finding), `${name} did not turn red with ${finding}`);
	}
}

function testLegitimateFilesOutsideScope() {
	const directory = fixture('legitimate-outside-scope');
	for (const [path, source] of [
		['docs/mumble-helper-review.md', 'Decision notes for MumbleLinkHelper only.\n'],
		['docs/mumble-link-client.md', 'MumbleLinkClient and MUMBLE_LINK_FRAME documentation only.\n'],
		['docs/examples/helper.rs', '// MumbleLinkHelper documentation example.\n'],
		['examples/helper.rs', '// Example source only.\n'],
		['fixtures/helper.cs', '// Fixture source only.\n'],
		['test/helper.rs', '// MumbleLink singular test directory.\n'],
		['src/platform/helper.spec.rs', '// MUMBLE_LINK_HELPER spec source.\n'],
		['src/platform/helper.test.cs', '// mumble_link_reader test source.\n'],
		['src/__fixtures__/helper.rs', '// Product test fixture only.\n'],
		['src/core/native-label.ts', "export const nativeLabel = 'local';\n"],
		['tools/bridge/reader.ts', 'export const readLocalFrame = true;\n'],
		['tools/bridge.ts', 'export const localBridge = true;\n'],
		['assets/companion-icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n'],
		['scripts/native-doc-check.mjs', 'export const docsOnly = true;\n'],
		['scripts/Cargo-license-report.mjs', 'export const generatesLicenseReport = true;\n'],
		['spikes/h8-mumble-crossover/README.md', 'H8.2 reviewed MumbleLink spike documentation.\n'],
	]) write(directory, path, source);
	const link = join(directory, 'docs/latest-platform-policy.md');
	symbolicLink('PLATFORM_POLICY.md', link);
	const forbidden = validateH8HelperDecisionContract(directory).findings
		.filter((finding) => finding.startsWith('forbidden-product-artifact:'));
	assert(forbidden.length === 0, `legitimate outside-scope files produced ${forbidden.join(',')}`);
}

function expectFinding(name, replacements, finding) {
	const directory = fixture(name, replacements);
	for (const [path, source] of replacements) {
		if (!files.has(path)) write(directory, path, source);
	}
	const result = validateH8HelperDecisionContract(directory);
	assert(result.findings.includes(finding), `${name} did not turn red with ${finding}`);
}

function fixture(name, replacements = new Map()) {
	const directory = join(testRoot, name);
	for (const [path, source] of files) write(directory, path, replacements.get(path) ?? source);
	return directory;
}

function symbolicLink(target, path) {
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path);
}

function write(directory, path, source) {
	const destination = join(directory, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, source);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
