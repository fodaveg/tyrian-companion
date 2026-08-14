import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Textual, dependency-free baseline for credential and telemetry boundary regressions. */
export const SECURITY_SCANNER_VERSION = 4;

const RELEASE_ARTIFACT_FILES = new Set([
	'main.js',
	'manifest.json',
	'styles.css',
]);

const FALLBACK_IGNORED_DIRECTORIES = new Set([
	'.git', 'coverage', 'dist', 'node_modules',
]);
const FALLBACK_IGNORED_FILES = new Set(['main.js']);
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/iu;
const KNOWN_PROVIDER_PATTERNS = [
	/\bAKIA[0-9A-Z]{16}\b/u,
	/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{82}\b/u,
	/\bnpm_[A-Za-z0-9]{36,255}\b/u,
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/u,
	/\b[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{20}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\b/u,
];
const CREDENTIAL_FIELD = String.raw`(?:gw2[_-]?api[_-]?key|api[_-]?key|api[_-]?token|access[_-]?token|bearer[_-]?token|refresh[_-]?token|client[_-]?secret|_?auth[_-]?token|credential|password|token|secret)`;
const QUOTED_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(String.raw`["'\x60]?\b${CREDENTIAL_FIELD}\b["'\x60]?\s*[:=]\s*(['"\x60])([^'"\x60\r\n]{20,})\1`, 'giu');
const UNQUOTED_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(String.raw`["'\x60]?\b${CREDENTIAL_FIELD}\b["'\x60]?\s*[:=]\s*([A-Za-z0-9._~+/-]{20,}=*)(?=\s*(?:$|[#;,}\]]))`, 'gimu');
const BEARER_CREDENTIAL_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/giu;
const ALLOWED_SYNTHETIC_CREDENTIALS = new Set([
	'example-placeholder-not-a-credential',
	'must-not-be-persisted',
	'opaque-preview-token',
]);
const CONSOLE_REFERENCE_PATTERN = /\bconsole\b/u;
const LOGGER_CALL_PATTERN = /\b(?:logger|telemetry)\s*(?:\?\.)?\s*(?:\.|\[)/iu;
const MUMBLE_HELPER_PATTERN = /mumble/iu;

/** Scans tracked and untracked non-ignored repository text without returning matched values. */
export function scanSecurityBoundaries(root = process.cwd()) {
	const absoluteRoot = resolve(root);
	const findings = [];

	for (const file of repositoryFiles(absoluteRoot)) {
		const source = readRepositoryText(file.absolute);
		if (source === null) continue;
		const secretRules = detectSecretRules(source);
		for (const rule of secretRules) findings.push({ rule, path: file.relative });
		if (isFixture(file.relative) && secretRules.length > 0) {
			findings.push({ rule: 'fixture-credential', path: file.relative });
		}
		if (isProductionSource(file.relative)) {
			if (CONSOLE_REFERENCE_PATTERN.test(source)) {
				findings.push({ rule: 'production-console-log', path: file.relative });
			}
			if (LOGGER_CALL_PATTERN.test(source)) {
				findings.push({ rule: 'production-logger-log', path: file.relative });
			}
			if (MUMBLE_HELPER_PATTERN.test(source)) {
				findings.push({ rule: 'unauthorized-mumble-helper', path: file.relative });
			}
		}
	}

	return uniqueFindings(findings);
}

/** Scans the exact distributable files, including the otherwise ignored bundle. */
export function scanReleaseArtifacts(root, relativePaths) {
	const absoluteRoot = resolve(root);
	const normalizedPaths = [...relativePaths]
		.map(normalizeRepositoryPath)
		.sort((left, right) => left.localeCompare(right));
	const findings = [];

	if (
		normalizedPaths.length !== RELEASE_ARTIFACT_FILES.size ||
		new Set(normalizedPaths).size !== RELEASE_ARTIFACT_FILES.size ||
		normalizedPaths.some((path) => !RELEASE_ARTIFACT_FILES.has(path))
	) {
		return [{ rule: 'release-artifact-set', path: '.' }];
	}

	for (const path of normalizedPaths) {
		const absolute = resolve(absoluteRoot, path);
		if (!isWithinRoot(absoluteRoot, absolute) || !existsFile(absolute)) {
			findings.push({ rule: 'release-artifact-file', path });
			continue;
		}
		const source = readRepositoryText(absolute);
		if (source === null) {
			findings.push({ rule: 'release-artifact-text', path });
			continue;
		}
		for (const rule of detectSecretRules(source)) {
			findings.push({ rule, path });
		}
	}

	return uniqueFindings(findings);
}

function detectSecretRules(source) {
	const rules = [];
	if (PRIVATE_KEY_PATTERN.test(source)) rules.push('private-key');
	if (KNOWN_PROVIDER_PATTERNS.some((pattern) => pattern.test(source))) {
		rules.push('known-provider-credential');
	}
	if (hasUnsafeCapture(source, QUOTED_CREDENTIAL_ASSIGNMENT_PATTERN) ||
		hasUnsafeUnquotedCapture(source)) {
		rules.push('long-credential-assignment');
	}
	if (hasUnsafeCapture(source, BEARER_CREDENTIAL_PATTERN, 1)) {
		rules.push('long-bearer-credential');
	}
	return rules;
}

function hasUnsafeUnquotedCapture(source) {
	UNQUOTED_CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;
	for (const match of source.matchAll(UNQUOTED_CREDENTIAL_ASSIGNMENT_PATTERN)) {
		const value = match[1];
		if (value !== undefined && /[0-9]/u.test(value) && likelyCredential(value)) return true;
	}
	return false;
}

function hasUnsafeCapture(source, pattern, captureIndex = 2) {
	pattern.lastIndex = 0;
	for (const match of source.matchAll(pattern)) {
		const value = match[captureIndex];
		if (value !== undefined && likelyCredential(value)) return true;
	}
	return false;
}

function likelyCredential(value) {
	if (ALLOWED_SYNTHETIC_CREDENTIALS.has(value.toLocaleLowerCase('en-US'))) return false;
	if (/^(.)\1+$/u.test(value)) return false;
	return new Set(value).size >= 8;
}

function repositoryFiles(root) {
	const git = spawnSync(
		'git',
		['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 },
	);
	if (git.status === 0 && typeof git.stdout === 'string') {
		return [...new Set(git.stdout.split('\0').filter(Boolean).map(normalizeRepositoryPath))]
			.map((path) => ({ absolute: resolve(root, path), relative: path }))
			.filter((file) => existsFile(file.absolute))
			.sort((left, right) => left.relative.localeCompare(right.relative));
	}
	return walk(root, root).sort((left, right) => left.relative.localeCompare(right.relative));
}

function walk(directory, root) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory() && FALLBACK_IGNORED_DIRECTORIES.has(entry.name)) return [];
		if (entry.isFile() && FALLBACK_IGNORED_FILES.has(entry.name)) return [];
		const absolute = resolve(directory, entry.name);
		if (entry.isDirectory()) return walk(absolute, root);
		if (!entry.isFile()) return [];
		return [{ absolute, relative: normalizeRepositoryPath(relative(root, absolute)) }];
	});
}

function readRepositoryText(path) {
	const bytes = readFileSync(path);
	if (bytes.length === 0) return '';
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return bytes.subarray(3).toString('utf8');
	}
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16Be(bytes.subarray(2));
	const guessedUtf16 = decodeBomlessUtf16(bytes);
	if (guessedUtf16 !== null) return guessedUtf16;
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return isProbablySingleByteText(bytes) ? bytes.toString('latin1') : null;
	}
}

function decodeBomlessUtf16(bytes) {
	if (bytes.length < 8 || bytes.length % 2 !== 0) return null;
	let evenZeros = 0;
	let oddZeros = 0;
	const pairs = bytes.length / 2;
	for (let index = 0; index < bytes.length; index += 2) {
		if (bytes[index] === 0) evenZeros += 1;
		if (bytes[index + 1] === 0) oddZeros += 1;
	}
	if (oddZeros / pairs >= 0.6 && evenZeros / pairs <= 0.1) return bytes.toString('utf16le');
	if (evenZeros / pairs >= 0.6 && oddZeros / pairs <= 0.1) return decodeUtf16Be(bytes);
	return null;
}

function decodeUtf16Be(bytes) {
	const swapped = Buffer.from(bytes);
	for (let index = 0; index + 1 < swapped.length; index += 2) {
		const first = swapped[index];
		swapped[index] = swapped[index + 1];
		swapped[index + 1] = first;
	}
	return swapped.toString('utf16le');
}

function isProbablySingleByteText(bytes) {
	let controls = 0;
	for (const byte of bytes) {
		if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1;
	}
	return controls / bytes.length <= 0.02;
}

function normalizeRepositoryPath(path) {
	return path.split(sep).join('/').replace(/^\.\//u, '');
}

function isWithinRoot(root, path) {
	const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
	return path.startsWith(normalizedRoot);
}

function isFixture(path) {
	return normalizeRepositoryPath(path).split('/').includes('__fixtures__');
}

function isTestSource(path) {
	const normalized = normalizeRepositoryPath(path);
	return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(normalized) ||
		/\.(?:spec|test)\.[^.]+$/u.test(normalized);
}

function isProductionSource(path) {
	const normalized = normalizeRepositoryPath(path);
	return (normalized.startsWith('src/') && !isTestSource(normalized) && !isFixture(normalized)) ||
		normalized === 'package.json' || normalized === 'manifest.json';
}

function uniqueFindings(findings) {
	const keyed = new Map(findings.map((finding) => [`${finding.path}\0${finding.rule}`, finding]));
	return [...keyed.values()].sort((left, right) =>
		left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule));
}

function existsFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	const findings = scanSecurityBoundaries(process.argv[2]);
	if (findings.length > 0) {
		console.error(`Security scanner v${SECURITY_SCANNER_VERSION} found ${findings.length} prohibited boundary pattern(s):`);
		for (const finding of findings) console.error(`- ${JSON.stringify(finding.path)}: ${finding.rule}`);
		process.exitCode = 1;
	}
}
