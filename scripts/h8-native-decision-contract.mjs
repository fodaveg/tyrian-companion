import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const H8_HELPER_DECISION_CONTRACT_VERSION = 18;

const ADR_PATH = 'docs/adr/0001-h8-3-native-mumble-helper.md';
const RUNTIME_ADR_PATH = 'docs/adr/0003-h8-5-native-helper-runtime.md';
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const RUNTIME_BLOCK_START = '<!-- h8.5-runtime:start -->\n```json\n';
const RUNTIME_BLOCK_END = '\n```\n<!-- h8.5-runtime:end -->';
const BLOCK_START = '<!-- h8.3-decision:start -->\n```json\n';
const BLOCK_END = '\n```\n<!-- h8.3-decision:end -->';
const ADR_AUTHORITY_START = '<!-- h8.3-adr-authority:start -->\n';
const ADR_AUTHORITY_END = '<!-- h8.3-adr-authority:end -->';
const PLATFORM_AUTHORITY_START = '<!-- h8.3-platform-authority:start -->\n';
const PLATFORM_AUTHORITY_END = '\n<!-- h8.3-platform-authority:end -->';
const ADR_AUTHORITY_PREFIX = `# ADR 0001 — Lenguaje y distribución del helper Mumble H8.3\n\n${ADR_AUTHORITY_START}`;
const PLATFORM_AUTHORITY_PREFIX = `### Decisión de implementación H8.3\n\n${PLATFORM_AUTHORITY_START}`;
const PLATFORM_AUTHORITY_SUFFIX = `${PLATFORM_AUTHORITY_END}\n\n## Política de terceros y operaciones`;
const EXPECTED_DECISION_SHA256 = 'e1646dd526ddb0bc038e7f2aa261151a4aeb3248109befa644c85e3ee32314e7';
const ADR_AUTHORITY_SHA256 = 'c2fcb0960da3077e342b9e6c07408fc80eca7069005f7da8e10e8aef8fbb2220';
const PLATFORM_AUTHORITY_SHA256 = '761564594340cf5984f4ccecaa2bc3a10a0b59b11c52e4fc50c2dcb456858e1b';
const PLATFORM_DOCUMENT_SHA256 = 'a119536f7cb68b6ae1eb482ff1a4c24ec82b5a44ebf8b039c3419e96036bc3b0';
const NATIVE_MANIFEST_SHA256 = 'cd7aa03197262d1e3e71868f24b2204a0a00855c70cbb38e0ad7727368b8aa7b';
const NATIVE_LOCK_SHA256 = '59bfcbfa38ae0ffe6b8454da70238d9ac490de07479ac6c0a0161b69725e83bf';
const NATIVE_WIN32_SHA256 = '6c67d644ce844ba6f98eda512493399ea724ed644cfa46b103577152612cb977';
const RUNTIME_ADR_DOCUMENT_SHA256 = 'aa8a04e6540c1e114fe91279391b7acced353ba6f59a6b33afc9814140ef720c';
const RUNTIME_BLOCK_SHA256 = 'eb8cced7b9035ecb7b06ee7e37a70e26b5035da673da9880580239603799f340';
const NATIVE_SOURCE_SHA256 = new Map([
	['native/mumble-helper/src/framing.rs', '8996af14503a161af83305a9426ad2a1149a51ab1eae321bb0462ae1401e88cd'],
	['native/mumble-helper/src/lib.rs', '0dc14b618c62dda5082f72810d62fae0beb812f73a8d7bf369b488cf049f26c1'],
	['native/mumble-helper/src/main.rs', '8199d36848c37848f6ab6d482ccaff1dc56c50a77e6199ab8aa017d1c7dcef5e'],
	['native/mumble-helper/src/protocol.rs', '98a73fddc63fd023ad4f7cad2a52b06a7ed1d906c9da4c5388a0a5a0df789ac9'],
	['native/mumble-helper/src/source.rs', '008997c8d34672bb351b021b57d609f4db76e2092189b561ded69a927c415c09'],
	['native/mumble-helper/src/win32.rs', '6c67d644ce844ba6f98eda512493399ea724ed644cfa46b103577152612cb977'],
]);
// `.claude` holds agent worktrees: a full second copy of the repo that is not this candidate.
const IGNORED_DIRECTORIES = new Set(['.claude', '.git', 'coverage', 'node_modules', 'target']);
const NON_PRODUCT_SOURCE_SCOPE = /(?:^|\/)(?:docs|examples|fixtures|test|tests|__fixtures__|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/u;
const REVIEWED_H8_8_PRODUCT_SHA256 = new Map([
	['src/platform/mumble-v2-presence-policy.ts', 'b07d268f466fbcea583b4096cbbf39620edd5cbf4dbeb73a5dbe1d241c71df81'],
	['src/sessions/mumble-v2-shadow-proposal.ts', 'd6534551200a85829a5e235f4b6dea297aabb20d25e20c7b4270693e5df10c71'],
]);
const REVIEWED_PRODUCT_PATHS = new Set([
	'src/platform/mumble-v2-client.ts',
	'src/platform/mumble-v2-codec.ts',
	'src/platform/mumble-v2-contract.ts',
	'src/platform/mumble-v2-health.ts',
	'src/platform/mumble-v2-launch-contract.ts',
	'src/platform/mumble-v2-launch-plan.ts',
	'src/platform/mumble-v2-observation.ts',
	'src/platform/mumble-v2-process-adapter.ts',
	...REVIEWED_H8_8_PRODUCT_SHA256.keys(),
]);
const NATIVE_ROOT = 'native/mumble-helper/';
const REVIEWED_NATIVE_PATHS = new Set([
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
]);
const REVIEWED_H8_2_SPIKE_ROOT = 'spikes/h8-mumble-crossover/';
const REVIEWED_NON_PRODUCT_PATHS = new Set([
	'spikes/h8-mumble-crossover/README.md',
	'spikes/h8-mumble-crossover/mumble_probe_core.c',
	'spikes/h8-mumble-crossover/mumble_probe_core.h',
	'spikes/h8-mumble-crossover/mumble_probe_core_test.c',
	'spikes/h8-mumble-crossover/mumble_probe_windows.c',
	'spikes/h8-mumble-crossover/test-host.sh',
	'spikes/h8-mumble-crossover/test-support/windows.h',
	'spikes/h8-mumble-crossover/validate-preprocessed.mjs',
]);
const NATIVE_TOOLCHAIN_FILE = /(?:^|\/)(?:Cargo\.(?:toml|lock)|\.cargo\/config(?:\.toml)?|rust-toolchain(?:\.toml)?)$/u;
const NATIVE_SOURCE_FILE = /\.(?:rs|cs|csproj)$/iu;
const NATIVE_OUTPUT_FILE = /\.(?:exe|dll|pdb|lib|obj|rlib|rmeta)$/iu;
const MUMBLE_OR_HELPER_PATH = /(?:^|\/)[^/]*(?:mumble|helper)[^/]*(?:\/|$)/iu;
const MUMBLE_CONTENT_MARKER = /\bmumble(?:_|-)?link/iu;
const CONTENT_SCAN_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|toml|rs|cs|csproj|yml|yaml|sh)$/iu;
const NATIVE_SYMLINK_TARGET = /(?:^|\/)[^/]*(?:mumble|helper)[^/]*(?:\/|$)|(?:^|\/)(?:Cargo\.(?:toml|lock)|\.cargo\/config(?:\.toml)?|rust-toolchain(?:\.toml)?)$|\.(?:rs|cs|csproj|exe|dll|pdb|lib|obj|rlib|rmeta)$/iu;

const EXPECTED_DECISION = {
	schemaVersion: 1,
	decisionId: 'H8.3',
	status: 'accepted_for_implementation',
	provisional: true,
	language: 'rust',
	alternative: 'csharp',
	sourceRoot: 'native/mumble-helper',
	build: {
		target: 'x86_64-pc-windows-msvc',
		rustFlags: ['-C target-feature=+crt-static', '-C link-arg=/Brepro'],
		peOutputs: ['tyrian-mumble-helper.exe'],
	},
	package: {
		kind: 'separate_zip',
		nameTemplate: 'tyrian-mumble-helper-{version}-windows-x64.zip',
		pluginArchiveIncluded: false,
		entries: [
			'tyrian-mumble-helper.exe',
			'helper-manifest.json',
			'SHA256SUMS',
			'LICENSE',
			'THIRD-PARTY-LICENSES.txt',
		],
	},
	support: [
		{ environment: 'linux_steam_proton', tier: 'primary', qa: 'pending' },
		{ environment: 'macos_crossover', tier: 'secondary', qa: 'pending' },
		{ environment: 'windows_x64', tier: 'beta', qa: 'pending' },
	],
	unsupported: [
		'linux_native',
		'macos_native',
		'windows_x86',
		'windows_arm64',
		'mobile',
		'wine_outside_steam_proton_or_crossover',
	],
	signing: {
		scheme: 'authenticode',
		status: 'pending',
		releaseAllowed: false,
	},
	risks: [
		'proton_or_crossover_mapping_incompatibility',
		'ffi_layout_or_tick_rollover_error',
		'static_crt_or_single_pe_regression',
		'dependency_license_or_binary_size_growth',
		'unsigned_binary_trust_and_smartscreen',
	],
	reopenTriggers: [
		'supported_matrix_requires_more_than_one_helper_binary',
		'single_pe_with_static_crt_cannot_be_reproduced',
		'rust_ffi_cannot_meet_the_h8_1_boundary_safely',
		'csharp_proves_materially_safer_or_more_compatible',
		'windows_arm64_becomes_a_release_requirement',
		'signing_or_licensing_cannot_meet_release_policy',
	],
};

const REQUIRED_DOCUMENT_TERMS = new Map([
	['README.md', ['H8.5', 'Rust', 'x86_64-pc-windows-msvc', 'firma y QA real siguen pendientes']],
	['docs/ARCHITECTURE.md', ['H8.5', 'native/mumble-helper', 'tyrian-mumble-helper.exe', 'warming_up']],
	['docs/PLATFORM_POLICY.md', ['H8.5', 'Linux con Steam/Proton', 'macOS con CrossOver', 'Windows x64', 'qa=pending']],
	['docs/THREAT-MODEL.md', ['H8.5', 'Authenticode', 'FILE_MAP_READ', 'firma sigue pendiente']],
	['docs/ESTADO.md', ['H8.5', 'implementado', 'QA=pending', 'CI Windows']],
	['docs/CHANGELOG.md', ['H8.5', 'Rust', 'UNSIGNED-NOT-FOR-RELEASE', 'firma y QA real siguen pendientes']],
]);

/** Validates the accepted H8.3 decision without implementing or packaging the helper. */
export function validateH8HelperDecisionContract(root = process.cwd()) {
	const absoluteRoot = resolve(root);
	const findings = [];
	const adr = readText(absoluteRoot, ADR_PATH, 'adr-document', findings);
	validateDecisionBlock(adr, findings);
	validateGovernedAuthority(absoluteRoot, adr, findings);
	validateRuntimeAdr(absoluteRoot, findings);
	validateCiArtifact(absoluteRoot, findings);
	validateDocumentation(absoluteRoot, findings);
	validateDocsOnlyScope(absoluteRoot, findings);
	validateNativeImplementation(absoluteRoot, findings);
	return {
		version: H8_HELPER_DECISION_CONTRACT_VERSION,
		findings: [...new Set(findings)].sort(),
	};
}

function validateCiArtifact(root, findings) {
	const source = readText(root, CI_WORKFLOW_PATH, 'ci-workflow', findings);
	for (const term of [
		"$artifactStage = 'artifact-upload'",
		"$forbiddenExtensions = @('.exe', '.dll', '.pdb', '.lib', '.obj', '.rlib', '.rmeta')",
		'if ($artifactFiles.Count -ne 1',
		'path: native/mumble-helper/artifact-upload/UNSIGNED-NOT-FOR-RELEASE.txt',
	]) {
		if (!source.includes(term)) findings.push(`ci-artifact-term:${term}`);
	}
	if ((source.match(/^\s*retention-days: 1\s*$/gmu)?.length ?? 0) !== 1) {
		findings.push('ci-artifact-retention');
	}
	if (source.includes('unexpected DLL/PDB output')) findings.push('ci-target-pdb-rejection');
}

function validateRuntimeAdr(root, findings) {
	const source = readText(root, RUNTIME_ADR_PATH, 'runtime-adr-document', findings);
	if (sha256(canonicalMarkdown(source)) !== RUNTIME_ADR_DOCUMENT_SHA256) {
		findings.push('runtime-adr-document-hash');
	}
	if (source.split(RUNTIME_BLOCK_START).length !== 2 || source.split(RUNTIME_BLOCK_END).length !== 2) {
		findings.push('runtime-adr-block-count');
		return;
	}
	const block = source.split(RUNTIME_BLOCK_START)[1]?.split(RUNTIME_BLOCK_END)[0] ?? '';
	try {
		const parsed = JSON.parse(block);
		if (parsed.decisionId !== 'H8.5' || parsed.role !== 'helper_server_only'
			|| parsed.status !== 'implemented_pending_ci_and_real_qa') {
			findings.push('runtime-adr-value');
		}
	} catch {
		findings.push('runtime-adr-json');
	}
	if (sha256(block) !== RUNTIME_BLOCK_SHA256) findings.push('runtime-adr-block-hash');
}

function validateDecisionBlock(source, findings) {
	const starts = source.split(BLOCK_START).length - 1;
	const ends = source.split(BLOCK_END).length - 1;
	if (starts !== 1 || ends !== 1) {
		findings.push('decision-block-count');
		return;
	}
	const block = source.split(BLOCK_START)[1]?.split(BLOCK_END)[0] ?? '';
	let parsed;
	try {
		parsed = JSON.parse(block);
	} catch {
		findings.push('decision-json');
		return;
	}
	if (block !== JSON.stringify(EXPECTED_DECISION, null, 2)) findings.push('decision-schema');
	if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_DECISION)) findings.push('decision-value');
	if (sha256(block) !== EXPECTED_DECISION_SHA256) findings.push('decision-hash');
}

function validateGovernedAuthority(root, adr, findings) {
	const adrAuthority = extractGovernedFragment(
		adr,
		ADR_AUTHORITY_START,
		`\n${ADR_AUTHORITY_END}`,
		'adr-authority',
		findings,
	);
	if (!adr.startsWith(ADR_AUTHORITY_PREFIX) || !adr.endsWith(`${ADR_AUTHORITY_END}\n`)) {
		findings.push('adr-authority-envelope');
	}
	if (adrAuthority !== null && sha256(adrAuthority) !== ADR_AUTHORITY_SHA256) {
		findings.push('adr-authority-hash');
	}

	const platform = readText(root, 'docs/PLATFORM_POLICY.md', 'document:docs/PLATFORM_POLICY.md', findings);
	if (sha256(canonicalMarkdown(platform)) !== PLATFORM_DOCUMENT_SHA256) {
		findings.push('platform-document-hash');
	}
	const platformAuthority = extractGovernedFragment(
		platform,
		PLATFORM_AUTHORITY_START,
		PLATFORM_AUTHORITY_END,
		'platform-authority',
		findings,
	);
	if (!platform.includes(PLATFORM_AUTHORITY_PREFIX)
		|| !platform.includes(PLATFORM_AUTHORITY_SUFFIX)) findings.push('platform-authority-envelope');
	if (platformAuthority !== null && sha256(platformAuthority) !== PLATFORM_AUTHORITY_SHA256) {
		findings.push('platform-authority-hash');
	}
}

function extractGovernedFragment(source, start, end, code, findings) {
	if (source.split(start).length !== 2 || source.split(end).length !== 2) {
		findings.push(`${code}-count`);
		return null;
	}
	return source.split(start)[1]?.split(end)[0] ?? null;
}

function validateDocumentation(root, findings) {
	for (const [path, terms] of REQUIRED_DOCUMENT_TERMS) {
		const source = readText(root, path, `document:${path}`, findings);
		const normalized = source.replace(/\s+/gu, ' ');
		for (const term of terms) {
			if (!normalized.includes(term)) findings.push(`document-term:${path}:${term}`);
		}
	}
}

function validateDocsOnlyScope(root, findings) {
	for (const entry of walk(root, root)) {
		if (isForbiddenNativeEntry(root, entry)) {
			findings.push(`forbidden-product-artifact:${entry.path}`);
		}
	}
	validateReviewedH8_8Product(root, findings);
	validateRepositoryNativeArtifacts(root, findings);
}

function validateReviewedH8_8Product(root, findings) {
	for (const [path, expectedHash] of REVIEWED_H8_8_PRODUCT_SHA256) {
		const source = readText(root, path, `h8.8-product:${path}`, findings);
		if (sha256(source) !== expectedHash) findings.push(`h8.8-product-hash:${path}`);
	}
}

function validateRepositoryNativeArtifacts(root, findings) {
	const git = spawnSync(
		'git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
	);
	const paths = git.status === 0 && typeof git.stdout === 'string'
		? git.stdout.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'))
		: walkIncludingTarget(root, root).map((entry) => entry.path);
	for (const path of paths) {
		if (path.startsWith(`${NATIVE_ROOT}target/`) || NATIVE_OUTPUT_FILE.test(path)) {
			findings.push(`forbidden-product-artifact:${path}`);
		}
	}
}

function validateNativeImplementation(root, findings) {
	const nativeRoot = resolve(root, 'native/mumble-helper');
	const hasNativeDirectory = existsSync(nativeRoot) && statSync(nativeRoot).isDirectory();
	const present = new Set((hasNativeDirectory ? walk(nativeRoot, root) : []).map((entry) => entry.path));
	for (const path of REVIEWED_NATIVE_PATHS) {
		if (!present.has(path)) findings.push(`native-missing:${path}`);
	}
	for (const path of present) {
		if (!REVIEWED_NATIVE_PATHS.has(path)) findings.push(`native-unreviewed:${path}`);
	}

	const manifest = readText(root, `${NATIVE_ROOT}Cargo.toml`, 'native-manifest', findings);
	if (sha256(manifest) !== NATIVE_MANIFEST_SHA256) findings.push('native-manifest-hash');
	for (const term of [
		'name = "tyrian-mumble-helper"', 'rust-version = "1.85"', 'getrandom = "=0.3.4"',
		'subtle = "=2.6.1"', 'zeroize = "=1.9.0"', 'windows-sys = { version = "=0.59.0"',
		'"Win32_Foundation"', '"Win32_System_Memory"', 'panic = "abort"', 'strip = "symbols"',
	]) if (!manifest.includes(term)) findings.push(`native-manifest-term:${term}`);
	if (/\bgit\s*=/u.test(manifest) || /\b(?:tokio|serde|base64)\b/u.test(manifest)) {
		findings.push('native-manifest-surface');
	}

	const lock = readText(root, `${NATIVE_ROOT}Cargo.lock`, 'native-lock', findings);
	if (sha256(lock) !== NATIVE_LOCK_SHA256) findings.push('native-lock-hash');
	if (/source = "(?:git|path)\+/u.test(lock)) findings.push('native-lock-source');
	for (const name of ['getrandom', 'subtle', 'zeroize', 'windows-sys']) {
		if (!lock.includes(`name = "${name}"`)) findings.push(`native-lock-package:${name}`);
	}
	const registryPackages = lock.split('[[package]]').slice(1)
		.filter((block) => block.includes('source = "registry+'));
	if (registryPackages.some((block) => !/checksum = "[0-9a-f]{64}"/u.test(block))) {
		findings.push('native-lock-checksum');
	}

	const toolchain = readText(root, `${NATIVE_ROOT}rust-toolchain.toml`, 'native-toolchain', findings);
	if (toolchain !== '[toolchain]\nchannel = "1.85.1"\nprofile = "minimal"\ntargets = ["x86_64-pc-windows-msvc"]\n') {
		findings.push('native-toolchain-value');
	}
	const config = readText(root, `${NATIVE_ROOT}.cargo/config.toml`, 'native-cargo-config', findings);
	if (config !== '[target.x86_64-pc-windows-msvc]\nrustflags = ["-C", "target-feature=+crt-static", "-C", "link-arg=/Brepro"]\n') {
		findings.push('native-cargo-config-value');
	}

	const production = [...REVIEWED_NATIVE_PATHS].filter((path) => path.includes('/src/'))
		.map((path) => [path, readText(root, path, `native-source:${path}`, findings)]);
	for (const [path, source] of production) {
		if (sha256(source) !== NATIVE_SOURCE_SHA256.get(path)) findings.push(`native-source-hash:${path}`);
		const runtimeSource = stripRustCfgTestModules(source);
		if (path !== `${NATIVE_ROOT}src/win32.rs` && /\bunsafe\s*\{/u.test(runtimeSource)) {
			findings.push(`native-unsafe-scope:${path}`);
		}
		if (/\b(?:identity|characterName|pid|position|movement|combat|loot|indexeddb|vault|telemetry|logger|eprintln|println)\b/iu.test(runtimeSource)) {
			findings.push(`native-prohibited-surface:${path}`);
		}
		for (const match of runtimeSource.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)) {
			if (match[0] !== '127.0.0.1') findings.push(`native-external-address:${path}`);
		}
	}
	const win32 = production.find(([path]) => path.endsWith('/win32.rs'))?.[1] ?? '';
	if (sha256(win32) !== NATIVE_WIN32_SHA256) findings.push('native-win32-hash');
	for (const term of ['OpenFileMappingW', 'MapViewOfFile', 'FILE_MAP_READ', 'MAPPING_NAME', 'VIEW_BYTES']) {
		if (!win32.includes(term)) findings.push(`native-win32-term:${term}`);
	}
	if (/\b(?:OpenProcess|ReadProcessMemory|WriteProcessMemory|CreateToolhelp32Snapshot|VirtualProtect|SendInput)\b/u.test(win32)) {
		findings.push('native-win32-prohibited-api');
	}
	const protocol = production.find(([path]) => path.endsWith('/protocol.rs'))?.[1] ?? '';
	for (const term of [
		'ConstantTimeEq', 'zeroize()', 'MAX_SEQUENCE', 'HEARTBEAT_TIMEOUT_MS',
		'heartbeatIntervalMs', 'sourceStatus', 'impl Drop for SecretString',
		'output.zeroize()', 'accumulator.zeroize()',
	]) {
		if (!protocol.includes(term)) findings.push(`native-protocol-term:${term}`);
	}
	const source = production.find(([path]) => path.endsWith('/source.rs'))?.[1] ?? '';
	for (const term of [
		'CadenceSchedule', 'CadenceDecision::HeartbeatTimeout', 'record_emitted',
		'tick_started_at', 'SOURCE_STALLED_AFTER_MS',
	]) {
		if (!source.includes(term)) findings.push(`native-cadence-term:${term}`);
	}
	const main = production.find(([path]) => path.endsWith('/main.rs'))?.[1] ?? '';
	for (const term of [
		'Ipv4Addr::LOCALHOST', 'stdin_task', 'reject_additional_connections', 'ProjectionClock',
		'cadence.poll(now)', 'cadence.record_emitted', 'maintain_pending_connection',
		'bootstrap_frame.zeroize()', 'hello_frame.zeroize()',
		'read_until(listener, stream, &mut payload, deadline, shutdown).is_err()',
		'error.into_bytes()',
	]) {
		if (!main.includes(term)) findings.push(`native-server-term:${term}`);
	}
	if (!main.includes('shutdown.store(true, Ordering::Release);\n        drop(sender);')) {
		findings.push('native-server-order:shutdown-before-disconnect');
	}
	const framing = production.find(([path]) => path.endsWith('/framing.rs'))?.[1] ?? '';
	for (const term of [
		'payload.zeroize()', 'error.into_bytes()',
		'if let Err(error) = read_exact_classified(reader, &mut payload)',
	]) {
		if (!framing.includes(term)) findings.push(`native-framing-term:${term}`);
	}
	const lifecycle = readText(
		root, `${NATIVE_ROOT}tests/server_lifecycle.rs`, 'native-lifecycle-tests', findings,
	);
	if (!lifecycle.includes('one_authenticated_and_one_pending_are_kept_while_a_third_is_rejected')) {
		findings.push('native-lifecycle-term:active-pending-third');
	}
	if (!lifecycle.includes('truncated_bom_and_invalid_utf8_hello_payloads_fail_closed')) {
		findings.push('native-lifecycle-term:rejected-payloads');
	}
}

function stripRustCfgTestModules(source) {
	const marker = '#[cfg(test)]';
	let cursor = 0;
	let output = '';
	while (true) {
		const start = source.indexOf(marker, cursor);
		if (start < 0) return output + source.slice(cursor);
		const opening = source.indexOf('{', start + marker.length);
		if (opening < 0 || !/^\s*mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/u.test(source.slice(start + marker.length, opening + 1))) {
			output += source.slice(cursor, start + marker.length);
			cursor = start + marker.length;
			continue;
		}
		const closing = matchingRustBrace(source, opening);
		if (closing < 0) return output + source.slice(cursor);
		output += source.slice(cursor, start);
		cursor = closing + 1;
	}
}

function matchingRustBrace(source, opening) {
	let depth = 0;
	let index = opening;
	while (index < source.length) {
		if (source.startsWith('//', index)) {
			index = source.indexOf('\n', index + 2);
			if (index < 0) return -1;
			continue;
		}
		if (source.startsWith('/*', index)) {
			let comments = 1;
			index += 2;
			while (comments > 0 && index < source.length) {
				if (source.startsWith('/*', index)) { comments += 1; index += 2; }
				else if (source.startsWith('*/', index)) { comments -= 1; index += 2; }
				else index += 1;
			}
			continue;
		}
		const raw = source.slice(index).match(/^r(#+)?"/u);
		if (raw !== null) {
			const hashes = raw[1] ?? '';
			const end = source.indexOf(`"${hashes}`, index + raw[0].length);
			if (end < 0) return -1;
			index = end + hashes.length + 1;
			continue;
		}
		if (source[index] === '"') {
			index += 1;
			while (index < source.length && source[index] !== '"') {
				index += source[index] === '\\' ? 2 : 1;
			}
			index += 1;
			continue;
		}
		if (source[index] === '{') depth += 1;
		if (source[index] === '}' && --depth === 0) return index;
		index += 1;
	}
	return -1;
}

function isForbiddenNativeEntry(root, entry) {
	const { path } = entry;
	if (NATIVE_OUTPUT_FILE.test(path)) return true;
	if (path.startsWith(NATIVE_ROOT)) return entry.kind !== 'file' || !REVIEWED_NATIVE_PATHS.has(path);
	if (path.startsWith(REVIEWED_H8_2_SPIKE_ROOT)) {
		return entry.kind !== 'file' || !REVIEWED_NON_PRODUCT_PATHS.has(path);
	}
	if (entry.kind === 'symlink') {
		return NATIVE_TOOLCHAIN_FILE.test(path) || NATIVE_SOURCE_FILE.test(path)
			|| MUMBLE_OR_HELPER_PATH.test(path)
			|| NATIVE_SYMLINK_TARGET.test(entry.target);
	}
	if (NON_PRODUCT_SOURCE_SCOPE.test(path)) return false;
	if (REVIEWED_PRODUCT_PATHS.has(path)) return false;
	if (NATIVE_TOOLCHAIN_FILE.test(path) || NATIVE_SOURCE_FILE.test(path)
		|| MUMBLE_OR_HELPER_PATH.test(path)) return true;
	if (!CONTENT_SCAN_FILE.test(path)) return false;
	return readTextForMarker(resolve(root, path));
}

function readTextForMarker(path) {
	try {
		const bytes = readFileSync(path);
		if (bytes.includes(0)) return false;
		return MUMBLE_CONTENT_MARKER.test(bytes.toString('utf8'));
	} catch {
		return false;
	}
}

function sha256(source) {
	return createHash('sha256').update(source, 'utf8').digest('hex');
}

function canonicalMarkdown(source) {
	return `${source.normalize('NFC').replaceAll('\r\n', '\n').split('\n')
		.map((line) => line.trimEnd()).join('\n').trimEnd()}\n`;
}

function readText(root, path, code, findings) {
	try {
		return readFileSync(resolve(root, path), 'utf8');
	} catch {
		findings.push(code);
		return '';
	}
}

function walk(directory, root) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return [];
		const absolute = resolve(directory, entry.name);
		if (entry.isDirectory()) return walk(absolute, root);
		const path = relative(root, absolute).replaceAll('\\', '/');
		if (entry.isFile()) return [{ path, kind: 'file', target: '' }];
		if (!entry.isSymbolicLink()) return [];
		let target = '';
		try {
			target = readlinkSync(absolute).replaceAll('\\', '/');
		} catch {
			target = '<unreadable>';
		}
		return [{ path, kind: 'symlink', target }];
	});
}

function walkIncludingTarget(directory, root) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory() && ['.claude', '.git', 'coverage', 'node_modules'].includes(entry.name)) return [];
		const absolute = resolve(directory, entry.name);
		if (entry.isDirectory()) return walkIncludingTarget(absolute, root);
		const path = relative(root, absolute).replaceAll('\\', '/');
		return entry.isFile() ? [{ path }] : [];
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	const root = process.argv[2] ?? process.cwd();
	if (!existsSync(resolve(root))) {
		process.stderr.write('H8.3 helper decision contract: root does not exist\n');
		process.exit(1);
	}
	const result = validateH8HelperDecisionContract(root);
	if (result.findings.length > 0) {
		for (const finding of result.findings) {
			process.stderr.write(`H8.3 helper decision contract: ${finding}\n`);
		}
		process.exit(1);
	}
	process.stdout.write(`H8.3 helper decision contract v${String(result.version)}: PASS\n`);
}
