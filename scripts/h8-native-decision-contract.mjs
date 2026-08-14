import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const H8_HELPER_DECISION_CONTRACT_VERSION = 7;

const ADR_PATH = 'docs/adr/0001-h8-3-native-mumble-helper.md';
const BLOCK_START = '<!-- h8.3-decision:start -->\n```json\n';
const BLOCK_END = '\n```\n<!-- h8.3-decision:end -->';
const ADR_AUTHORITY_START = '<!-- h8.3-adr-authority:start -->\n';
const ADR_AUTHORITY_END = '<!-- h8.3-adr-authority:end -->';
const PLATFORM_AUTHORITY_START = '<!-- h8.3-platform-authority:start -->\n';
const PLATFORM_AUTHORITY_END = '\n<!-- h8.3-platform-authority:end -->';
const ADR_AUTHORITY_PREFIX = `# ADR 0001 — Lenguaje y distribución del helper Mumble H8.3\n\n${ADR_AUTHORITY_START}`;
const PLATFORM_AUTHORITY_PREFIX = `### Decisión de implementación H8.3\n\n${PLATFORM_AUTHORITY_START}`;
const PLATFORM_AUTHORITY_SUFFIX = `${PLATFORM_AUTHORITY_END}\n\n## Política de terceros y operaciones`;
const EXPECTED_DECISION_SHA256 = 'cca16e7829bc82825bcc9e182f6a08be00b3f4353b26d1225002b3fef0127bb8';
const ADR_AUTHORITY_SHA256 = '7148a229b490f30d94085a9ae3b77921d1d4e654428a787e9740ba0b2743e246';
const PLATFORM_AUTHORITY_SHA256 = 'd869c5a3a7265666a901779b052f675a91fe3c20166cf03be5bdfb012b55392a';
const PLATFORM_DOCUMENT_SHA256 = 'c839f64ef3d8830f60f40b03553c81be75af743fa6616857508097f3ee51f925';
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'node_modules']);
const NON_PRODUCT_SOURCE_SCOPE = /(?:^|\/)(?:docs|examples|fixtures|test|tests|__fixtures__|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/u;
const REVIEWED_PRODUCT_PATHS = new Set(['src/platform/mumble-v2-contract.ts']);
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
		rustFlags: ['-C target-feature=+crt-static'],
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
	['README.md', ['H8.3', 'Rust', 'x86_64-pc-windows-msvc', 'no helper or IPC runtime is implemented']],
	['docs/ARCHITECTURE.md', ['H8.3', 'native/mumble-helper', 'tyrian-mumble-helper.exe', 'ZIP separado']],
	['docs/PLATFORM_POLICY.md', ['H8.3', 'Linux con Steam/Proton', 'macOS con CrossOver', 'Windows x64', 'qa=pending']],
	['docs/THREAT-MODEL.md', ['H8.3', 'Authenticode', 'único PE', 'firma sigue pendiente']],
	['docs/ESTADO.md', ['H8.3', 'accepted_for_implementation', 'QA=pending', 'no se ha implementado ningún helper']],
	['docs/CHANGELOG.md', ['H8.3', 'Rust', 'ZIP separado', 'firma siguen pendientes']],
]);

/** Validates the accepted H8.3 decision without implementing or packaging the helper. */
export function validateH8HelperDecisionContract(root = process.cwd()) {
	const absoluteRoot = resolve(root);
	const findings = [];
	const adr = readText(absoluteRoot, ADR_PATH, 'adr-document', findings);
	validateDecisionBlock(adr, findings);
	validateGovernedAuthority(absoluteRoot, adr, findings);
	validateDocumentation(absoluteRoot, findings);
	validateDocsOnlyScope(absoluteRoot, findings);
	return {
		version: H8_HELPER_DECISION_CONTRACT_VERSION,
		findings: [...new Set(findings)].sort(),
	};
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
}

function isForbiddenNativeEntry(root, entry) {
	const { path } = entry;
	if (NATIVE_OUTPUT_FILE.test(path)) return true;
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
