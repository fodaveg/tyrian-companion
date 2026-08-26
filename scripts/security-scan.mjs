import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

/** Textual baseline with AST-closed TypeScript import boundaries. */
export const SECURITY_SCANNER_VERSION = 14;

const MUMBLE_V2_SPAWN_CAPABILITY_SHA256 = 'a12bff26711472e5637bd2a8e9205ccc16a6b76e7f08b7cc7668d83dc070f77d';
const MUMBLE_V2_PROCESS_ADAPTER_SOURCE_SHA256 = '72f4dfc5052f386a75aa321305936f1223e6e94fd6c9454ba047b0b2097775f6';

const RELEASE_ARTIFACT_FILES = new Set([
	'main.js',
	'manifest.json',
	'styles.css',
]);

const FALLBACK_IGNORED_DIRECTORIES = new Set([
	// `.claude` holds agent worktrees: a full second copy of the repo that is not this candidate.
	'.claude', '.git', 'coverage', 'dist', 'node_modules',
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
const REVIEWED_MUMBLE_CONTRACT_FILES = new Set([
	'src/platform/mumble-v2-client.ts',
	'src/platform/mumble-v2-codec.ts',
	'src/platform/mumble-v2-contract.ts',
	'src/platform/mumble-v2-health.ts',
	'src/platform/mumble-v2-launch-contract.ts',
	'src/platform/mumble-v2-launch-plan.ts',
	'src/platform/mumble-v2-observation.ts',
	'src/platform/mumble-v2-presence-policy.ts',
	'src/platform/mumble-v2-process-adapter.ts',
	'src/sessions/mumble-v2-shadow-proposal.ts',
	'native/mumble-helper/src/framing.rs',
	'native/mumble-helper/src/lib.rs',
	'native/mumble-helper/src/main.rs',
	'native/mumble-helper/src/protocol.rs',
	'native/mumble-helper/src/source.rs',
	'native/mumble-helper/src/win32.rs',
]);
const REVIEWED_MUMBLE_CORE_IMPORTS = new Map([
	['src/platform/mumble-v2-client.ts', ['./mumble-v2-contract', './mumble-v2-codec']],
	['src/platform/mumble-v2-codec.ts', ['./mumble-v2-contract']],
	['src/platform/mumble-v2-health.ts', ['./mumble-v2-contract']],
	['src/platform/mumble-v2-launch-contract.ts', []],
	['src/platform/mumble-v2-launch-plan.ts', ['./mumble-v2-launch-contract']],
	['src/platform/mumble-v2-observation.ts', ['./mumble-v2-contract']],
	['src/platform/mumble-v2-process-adapter.ts', [
		'./mumble-v2-client', './mumble-v2-launch-contract', './mumble-v2-launch-plan',
	]],
]);
const REVIEWED_MUMBLE_SHADOW_IMPORTS = new Map([
	['src/platform/mumble-v2-presence-policy.ts', [
		'./mumble-v2-contract', './mumble-v2-contract',
	]],
	['src/sessions/mumble-v2-shadow-proposal.ts', [
		'../platform/mumble-v2-contract', '../platform/mumble-v2-presence-policy',
	]],
]);
const REVIEWED_MUMBLE_LAUNCH_FILES = new Set([
	'src/platform/mumble-v2-launch-contract.ts',
	'src/platform/mumble-v2-launch-plan.ts',
	'src/platform/mumble-v2-process-adapter.ts',
]);
const MUMBLE_CONTRACT_PROHIBITED_PATTERNS = [
	/\b(?:inject|injection|dllInject|hookProcess)\b/iu,
	/\b(?:child_process|spawn|execFile|processId|enumerateProcesses|openProcess)\b/u,
	/\b(?:ReadProcessMemory|ptrace|processMemory|memoryReader)\b/u,
	/\b(?:console|logger|readGameLog|logReader)\b/u,
	/\b(?:pcap|packetSniffer|interceptTraffic|proxyTraffic)\b/u,
	/\b(?:SendInput|simulateInput|keybd_event|mouse_event)\b/u,
	/\b(?:bot|macro|automate|automation|executeGameAction)\b/iu,
	/\b(?:identity|characterName|fAvatarPosition|fCameraPosition|playerX|playerY|processId|pid)\b/iu,
	/\b(?:fetch|WebSocket|XMLHttpRequest|requestUrl|node:net|node:http)\b/u,
	/\b(?:indexedDB|localStorage|sessionStorage|writeFile|writeFileSync)\b/u,
	/\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/u,
];
const NATIVE_MUMBLE_PROHIBITED_PATTERNS = [
	/\b(?:inject|injection|dllInject|hookProcess)\b/iu,
	/\b(?:processId|enumerateProcesses|openProcess|OpenProcess|ReadProcessMemory|ptrace)\b/u,
	/\b(?:console|logger|telemetry|readGameLog|logReader|eprintln|println)\b/u,
	/\b(?:SendInput|simulateInput|keybd_event|mouse_event)\b/u,
	/\b(?:identity|characterName|fAvatarPosition|fCameraPosition|playerX|playerY|processId|pid)\b/iu,
	/\b(?:indexedDB|localStorage|sessionStorage|writeFile|writeFileSync)\b/u,
];
const MUMBLE_CORE_PROHIBITED_PATTERNS = [
	/\b(?:inject|injection|dllInject|hookProcess|ReadProcessMemory|ptrace|processMemory)\b/iu,
	/\b(?:fetch|WebSocket|XMLHttpRequest|requestUrl|indexedDB|localStorage|sessionStorage)\b/u,
	/\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*\(/u,
	/\b(?:console|logger|telemetry)\b/iu,
	/\b(?:onStart|onStop|proposal|capture|persist|SessionService|SessionStore)\b/iu,
	/\b(?:import\s*\(|require\s*\()/u,
];
const MUMBLE_SHADOW_PROHIBITED_PATTERNS = [
	/\b(?:inject|injection|dllInject|hookProcess|ReadProcessMemory|ptrace|processMemory)\b/iu,
	/\b(?:fetch|WebSocket|XMLHttpRequest|requestUrl|indexedDB|localStorage|sessionStorage)\b/u,
	/\b(?:readFile|readFileSync|writeFile|writeFileSync|saveData)\b/u,
	/\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/u,
	/\b(?:console|logger|telemetry)\b/iu,
	/\b(?:ManualSessionStartService|PendingProposalService|SessionService|TyrianCompanionPlugin|transitionSession)\b/u,
	/\b(?:MumbleV2BootstrapRecordV1|MumbleV2HeartbeatRecordV1|MumbleV2HelloRecordV1|MumbleV2IpcFrameV1|MumbleV2ReadyRecordV1|MumbleV2WelcomeRecordV1)\b/u,
	/\b(?:import\s*\(|require\s*\()/u,
];

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
			if ((MUMBLE_HELPER_PATTERN.test(file.relative) || MUMBLE_HELPER_PATTERN.test(source))
				&& !isReviewedMumbleContract(file.relative, source)) {
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

function isReviewedMumbleContract(path, source) {
	const normalized = normalizeRepositoryPath(path);
	if (!REVIEWED_MUMBLE_CONTRACT_FILES.has(normalized)) return false;
	const native = normalized.startsWith('native/mumble-helper/src/');
	const core = REVIEWED_MUMBLE_CORE_IMPORTS.has(normalized);
	const shadow = REVIEWED_MUMBLE_SHADOW_IMPORTS.has(normalized);
	const inspected = native
		? stripRustCfgTestModules(source)
		: source;
	const patterns = native
		? NATIVE_MUMBLE_PROHIBITED_PATTERNS
		: shadow ? MUMBLE_SHADOW_PROHIBITED_PATTERNS
			: core ? MUMBLE_CORE_PROHIBITED_PATTERNS : MUMBLE_CONTRACT_PROHIBITED_PATTERNS;
	if (patterns.some((pattern) => pattern.test(inspected))) return false;
	if (core && !hasExactMumbleCoreImports(normalized, inspected)) return false;
	if (shadow && (!hasExactMumbleShadowImports(normalized, inspected)
		|| !hasSafeMumbleShadowSurface(normalized, inspected))) return false;
	if (REVIEWED_MUMBLE_LAUNCH_FILES.has(normalized)
		&& !hasSafeMumbleLaunchSurface(normalized, inspected)) return false;
	return ![...inspected.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)]
		.some((match) => match[0] !== '127.0.0.1');
}

function hasSafeMumbleLaunchSurface(path, source) {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const configFields = new Set([
		'version', 'platform', 'helperPackageDirectory', 'bottleName', 'steamCompatDataDirectory',
	]);
	const routeFields = new Set(['version', 'platform', 'runtime']);
	const diagnosticFields = new Set([
		'version', 'stage', 'code', 'retryable', 'artifactIntegrity', 'artifactTrust',
	]);
	const rawDiagnosticFields = new Set([
		'token', 'nonce', 'frame', 'identity', 'pid', 'processId', 'exitCode', 'path', 'bottle', 'os',
	]);
	const hostInterfaceFields = new Map([
		['MumbleV2ArtifactEntry', ['name', 'bytes']],
		['MumbleV2OpenedArtifactPackage', ['entries', 'opaqueAuthority']],
		['MumbleV2ArtifactPort', ['openPackage', 'sha256']],
		['MumbleV2HostProcessCallbacks', ['stdout', 'stderr', 'exited']],
		['MumbleV2HostProcessHandle', ['writeStdin', 'stop']],
		['MumbleV2IntegrityCheckedArtifactCapability', [
			'kind', 'integrity', 'trust', 'executableSha256', 'manifestSha256', 'opaqueAuthority',
		]],
		['MumbleV2HostProcessPort', ['spawnIntegrityChecked']],
		['MumbleV2ProcessAdapterPorts', ['artifacts', 'process', 'defer', 'onDiagnostic']],
	]);
	const seenHostInterfaces = [];
	const spawnCapabilityHashes = [];
	let spawnIntegrityCheckedReferences = 0;
	let safe = !/\b(?:trusted|verified)(?:_|\b)/iu.test(source);
	const visit = (node) => {
		if (ts.isObjectLiteralExpression(node)) {
			for (const member of node.properties) {
				if (!('name' in member) || propertyName(member.name) !== 'shell') continue;
				if (!ts.isPropertyAssignment(member)
					|| member.initializer.kind !== ts.SyntaxKind.FalseKeyword) safe = false;
			}
		}
		if (isAmbientProcessReference(node)) safe = false;
		if (path.endsWith('mumble-v2-process-adapter.ts') && ts.isMethodDeclaration(node)
			&& node.name !== undefined && propertyName(node.name) === 'spawnCapability') {
			spawnCapabilityHashes.push(hashCanonicalNode(node, file));
		}
		if (path.endsWith('mumble-v2-process-adapter.ts') && isSpawnIntegrityCheckedAccess(node)) {
			spawnIntegrityCheckedReferences += 1;
			if (!ts.isCallExpression(node.parent) || node.parent.expression !== node
				|| !isInsideMethod(node, 'spawnCapability')) safe = false;
		}
		if (path.endsWith('mumble-v2-process-adapter.ts') && ts.isBindingElement(node)
			&& propertyName(node.propertyName ?? node.name) === 'spawnIntegrityChecked') safe = false;
		if (ts.isInterfaceDeclaration(node)) {
			let allowed;
			if (/LaunchConfig/u.test(node.name.text)) allowed = configFields;
			else if (/LaunchRoute/u.test(node.name.text)) allowed = routeFields;
			else if (/LaunchDiagnostic/u.test(node.name.text)) allowed = diagnosticFields;
			if (allowed !== undefined) {
				for (const member of node.members) {
					if (!ts.isPropertySignature(member)) { safe = false; continue; }
					const name = propertyName(member.name);
					if (name === null || !allowed.has(name)
						|| (/LaunchDiagnostic/u.test(node.name.text) && rawDiagnosticFields.has(name))) safe = false;
				}
			}
			if (path.endsWith('mumble-v2-process-adapter.ts')
				&& /(?:Host|Artifact|ProcessAdapterPorts)/u.test(node.name.text)) {
				const expected = hostInterfaceFields.get(node.name.text);
				const actual = node.members.flatMap((member) => member.name === undefined
					? [] : [propertyName(member.name)]).filter((name) => name !== null).sort();
				if (expected === undefined || !sameStringList(actual, [...expected].sort())) safe = false;
				seenHostInterfaces.push(node.name.text);
			}
		}
		if (path.endsWith('mumble-v2-process-adapter.ts') && isCoreCallbackCall(node)
			&& !isReviewedCallbackLocation(node)) safe = false;
		if (path.endsWith('mumble-v2-process-adapter.ts')
			&& (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
			&& node.name !== undefined && propertyName(node.name) === 'deliver') safe = false;
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (path.endsWith('mumble-v2-process-adapter.ts')) {
		if (hashCanonicalSource(source) !== MUMBLE_V2_PROCESS_ADAPTER_SOURCE_SHA256) safe = false;
		if ((source.match(/this\.ports\.defer\s*\(/gu)?.length ?? 0) !== 1) safe = false;
		if (!sameStringList(seenHostInterfaces.sort(), [...hostInterfaceFields.keys()].sort())) safe = false;
		if (!sameStringList(spawnCapabilityHashes, [MUMBLE_V2_SPAWN_CAPABILITY_SHA256])) safe = false;
		if (spawnIntegrityCheckedReferences !== 1) safe = false;
	}
	return safe;
}

function isSpawnIntegrityCheckedAccess(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text === 'spawnIntegrityChecked';
	return ts.isElementAccessExpression(node) && node.argumentExpression !== undefined
		&& ts.isStringLiteralLike(node.argumentExpression)
		&& node.argumentExpression.text === 'spawnIntegrityChecked';
}

function isInsideMethod(node, methodName) {
	let current = node.parent;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (ts.isMethodDeclaration(current)) {
			return current.name !== undefined && propertyName(current.name) === methodName;
		}
		if (ts.isFunctionDeclaration(current)) return false;
		current = current.parent;
	}
	return false;
}

function isAmbientProcessReference(node) {
	if (ts.isStringLiteralLike(node)
		&& (node.text === 'node:child_process' || node.text === 'child_process')) return true;
	if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node))
		&& node.text === 'getBuiltinModule') return true;
	if (!ts.isIdentifier(node)) return false;
	if (node.text === 'globalThis' || node.text === 'global'
		|| node.text === 'eval' || node.text === 'Function'
		|| node.text === 'require' || node.text === 'module') return true;
	if (node.text !== 'process') return false;
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if ((ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
		|| ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent))
		&& parent.name === node) return false;
	return true;
}

function hashCanonicalNode(node, file) {
	const canonical = node.getText(file).normalize('NFC').replace(/\r\n?/gu, '\n');
	return createHash('sha256').update(canonical).digest('hex');
}

function hashCanonicalSource(source) {
	const canonical = source.normalize('NFC').replace(/\r\n?/gu, '\n');
	return createHash('sha256').update(canonical).digest('hex');
}

function isCoreCallbackCall(node) {
	return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
		&& ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'callbacks'
		&& (node.expression.name.text === 'stdout' || node.expression.name.text === 'exited');
}

function isReviewedCallbackLocation(node) {
	let current = node.parent;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
			if (ts.isCallExpression(current.parent) && current.parent.arguments.includes(current)
				&& ts.isPropertyAccessExpression(current.parent.expression)
				&& current.parent.expression.name.text === 'defer') return true;
			if (ts.isPropertyAssignment(current.parent)) {
				const name = propertyName(current.parent.name);
				return name === 'stdout' || name === 'exited';
			}
		}
		if (ts.isMethodDeclaration(current)) {
			return current.name !== undefined && propertyName(current.name) === 'spawnCapability';
		}
		if (ts.isFunctionDeclaration(current)) return false;
		current = current.parent;
	}
	return false;
}

function sameStringList(actual, expected) {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function propertyName(name) {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
		? name.text : null;
}

function hasExactMumbleCoreImports(path, source) {
	return hasExactMumbleImports(path, source, REVIEWED_MUMBLE_CORE_IMPORTS);
}

function hasExactMumbleShadowImports(path, source) {
	return hasExactMumbleImports(path, source, REVIEWED_MUMBLE_SHADOW_IMPORTS);
}

function hasExactMumbleImports(path, source, reviewedImports) {
	const expected = reviewedImports.get(path) ?? [];
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const actual = [];
	let unsupportedDependency = false;
	const visit = (node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			&& node.moduleSpecifier !== undefined) {
			if (ts.isStringLiteralLike(node.moduleSpecifier)) actual.push(node.moduleSpecifier.text);
			else unsupportedDependency = true;
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (ts.isExternalModuleReference(reference) && reference.expression !== undefined
				&& ts.isStringLiteralLike(reference.expression)) actual.push(reference.expression.text);
			else unsupportedDependency = true;
		} else if (ts.isCallExpression(node)
			&& (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			unsupportedDependency = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	actual.sort();
	const reviewed = [...expected].sort();
	return !unsupportedDependency && actual.length === reviewed.length
		&& actual.every((specifier, index) => specifier === reviewed[index]);
}

function hasSafeMumbleShadowSurface(path, source) {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const expectedInterfaces = new Map([
		['MumbleV2PresenceContext', ['enabled', 'armed', 'recoveryPending', 'authority']],
		['MumbleV2PresenceSignal', [
			'version', 'phase', 'targetMapId', 'thresholdMs', 'window', 'continuity', 'binding',
		]],
		['MumbleV2PresencePolicyState', [
			'version', 'context', 'channelState', 'phase', 'startedAtMs', 'lastRecordAtMs',
			'stalledSinceMs', 'creditedMs', 'continuity', 'startLatched', 'stopLatchedBinding',
		]],
		['MumbleV2ShadowProposalV1', [
			'version', 'source', 'phase', 'proposalId', 'accountId', 'targetMapId', 'binding',
			'window', 'thresholdMs', 'detectedAt', 'continuity', 'evidenceQuality', 'rollout', 'retention',
			'review', 'effect',
		]],
		['MumbleV2ShadowProposalFactory', ['createProposalId']],
	]);
	const rawNames = new Set([
		'MumbleV2BootstrapRecordV1', 'MumbleV2HeartbeatRecordV1', 'MumbleV2HelloRecordV1',
		'MumbleV2IpcFrameV1', 'MumbleV2ReadyRecordV1', 'MumbleV2WelcomeRecordV1',
		'frame', 'heartbeatIntervalMs', 'host', 'nonce', 'port', 'raw', 'record', 'sequence', 'tick', 'token',
	]);
	const timerNames = new Set(['queueMicrotask', 'requestAnimationFrame', 'setInterval', 'setTimeout']);
	const ioNames = new Set([
		'WebSocket', 'XMLHttpRequest', 'console', 'fetch', 'logger', 'readFile', 'readFileSync',
		'requestUrl', 'telemetry', 'writeFile', 'writeFileSync',
	]);
	const persistenceNames = new Set([
		'IDBDatabase', 'IDBFactory', 'SessionNoteVault', 'indexedDB', 'localStorage', 'saveData',
		'sessionStorage',
	]);
	const lifecycleNames = new Set([
		'ManualSessionStartService', 'SessionService', 'TyrianCompanionPlugin', 'start',
		'startManualSession', 'stop', 'stopManualSession', 'transitionSession',
	]);
	const queueNames = new Set(['PendingProposalService', 'accept', 'claim', 'dismiss', 'enqueue', 'reconcile']);
	const seen = new Map();
	let safe = true;
	const visit = (node) => {
		const name = syntaxName(node);
		if (name !== null) {
			if (rawNames.has(name) || timerNames.has(name) || ioNames.has(name) || persistenceNames.has(name)) {
				safe = false;
			}
			if ((lifecycleNames.has(name) || queueNames.has(name)) && isCallOrTypeReference(node)) safe = false;
		}
		if (ts.isInterfaceDeclaration(node) && expectedInterfaces.has(node.name.text)) {
			seen.set(node.name.text, node.members.flatMap((member) => {
				const field = member.name === undefined ? null : propertyName(member.name);
				return field === null ? [] : [field];
			}));
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	for (const [name, fields] of expectedInterfaces) {
		const belongsHere = name.startsWith('MumbleV2Presence')
			? path.endsWith('mumble-v2-presence-policy.ts')
			: path.endsWith('mumble-v2-shadow-proposal.ts');
		if (belongsHere && !sameStringList(seen.get(name) ?? [], fields)) safe = false;
	}
	return safe;
}

function syntaxName(node) {
	if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined
		&& ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
	if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)
		|| ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
		return propertyName(node.name);
	}
	return null;
}

function isCallOrTypeReference(node) {
	if (ts.isTypeReferenceNode(node.parent) || ts.isExpressionWithTypeArguments(node.parent)) return true;
	if (ts.isCallExpression(node.parent)) return node.parent.expression === node;
	if (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) {
		return ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent;
	}
	return false;
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
			while (index < source.length && source[index] !== '"') index += source[index] === '\\' ? 2 : 1;
			index += 1;
			continue;
		}
		if (source[index] === '{') depth += 1;
		if (source[index] === '}' && --depth === 0) return index;
		index += 1;
	}
	return -1;
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
	if (bytes.includes(0) && !isTypeScriptSourcePath(path)) return null;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return isProbablySingleByteText(bytes) ? bytes.toString('latin1') : null;
	}
}

function isTypeScriptSourcePath(path) {
	return /\.(?:c|m)?tsx?$/iu.test(path);
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
		(normalized.startsWith('native/mumble-helper/src/') && normalized.endsWith('.rs')) ||
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
