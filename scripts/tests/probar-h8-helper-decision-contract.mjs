import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { validateH8HelperDecisionContract } from '../h8-native-decision-contract.mjs';

const root = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-h8-helper-decision-'));
const failures = [];
const trackedFiles = [
	'README.md',
	'docs/ARCHITECTURE.md',
	'docs/CHANGELOG.md',
	'docs/ESTADO.md',
	'docs/PLATFORM_POLICY.md',
	'docs/THREAT-MODEL.md',
	'docs/adr/0001-h8-3-native-mumble-helper.md',
];
const files = new Map(trackedFiles.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));

try {
	assert(validateH8HelperDecisionContract(root).findings.length === 0, 'current repository failed the H8.3 decision contract');
	testDecisionSabotages();
	testBlockSabotages();
	testDocumentationSabotage();
	testImplementationSabotages();
	testSymlinkSabotages();
	testLegitimateFilesOutsideScope();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
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
		['extensionless-native-helper', 'native/mumble-helper'],
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

function testSymlinkSabotages() {
	for (const [name, path, target] of [
		['native-helper-symlink', 'native/mumble-helper', '../controlled-target.txt'],
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
