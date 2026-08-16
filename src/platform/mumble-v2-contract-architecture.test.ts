import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CONTRACT_PATH = 'src/platform/mumble-v2-contract.ts';
const CONTRACT_SOURCE = readFileSync(CONTRACT_PATH, 'utf8');
const PRODUCTION_FILES = sourceFiles('src');
const REVIEWED_MUMBLE_PRODUCTION_FILES = [
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
] as const;
const EXPECTED_FRAME_FIELDS = ['version', 'nonce', 'sequence', 'tick', 'mapId', 'activity'] as const;
const EXPECTED_MESSAGE_FIELDS = {
	MumbleV2BootstrapRecordV1: ['kind', 'version', 'token'],
	MumbleV2ReadyRecordV1: ['kind', 'version', 'host', 'port'],
	MumbleV2HelloRecordV1: ['kind', 'version', 'token'],
	MumbleV2WelcomeRecordV1: ['kind', 'version', 'nonce', 'heartbeatIntervalMs'],
	MumbleV2HeartbeatRecordV1: ['kind', 'version', 'nonce', 'sequence', 'sourceStatus'],
	MumbleV2IpcFrameV1: EXPECTED_FRAME_FIELDS,
} as const;

const EXPECTED_EXPORTS = [
	'MUMBLE_V2_CHANNEL_ERRORS',
	'MUMBLE_V2_CONTRACT_VERSION',
	'MUMBLE_V2_FIXED_SOURCES',
	'MUMBLE_V2_IPC_FRAME_KEYS',
	'MUMBLE_V2_LABYRINTH_MAP',
	'MUMBLE_V2_LIFECYCLE_CONTRACT',
	'MUMBLE_V2_LIFECYCLE_EVENTS',
	'MUMBLE_V2_LIFECYCLE_STATES',
	'MUMBLE_V2_MAX_FRAME_BYTES',
	'MUMBLE_V2_MESSAGE_KEYS',
	'MUMBLE_V2_RECOMMENDED_DEFAULTS',
	'MUMBLE_V2_SOURCE_FIELDS',
	'MUMBLE_V2_SOURCE_LIMITS',
	'MUMBLE_V2_SOURCE_STATUSES',
	'MUMBLE_V2_TRANSPORT_CONTRACT',
	'MumbleV2BootstrapRecordV1',
	'MumbleV2ChannelError',
	'MumbleV2DerivedActivity',
	'MumbleV2FixedSourceV1',
	'MumbleV2HeartbeatRecordV1',
	'MumbleV2HelloRecordV1',
	'MumbleV2IpcFrameV1',
	'MumbleV2LabyrinthMapV1',
	'MumbleV2LifecycleContractV1',
	'MumbleV2LifecycleEvent',
	'MumbleV2LifecycleFailureRouteV1',
	'MumbleV2LifecycleState',
	'MumbleV2LifecycleTimeoutV1',
	'MumbleV2LifecycleTransitionV1',
	'MumbleV2ProtocolRecordV1',
	'MumbleV2ReadyRecordV1',
	'MumbleV2RecommendedDefaultsV1',
	'MumbleV2SourceField',
	'MumbleV2SourceLimitsV1',
	'MumbleV2SourceStatus',
	'MumbleV2TransportContractV1',
	'MumbleV2WelcomeRecordV1',
] as const;

const FORBIDDEN_CAPABILITIES = {
	injection: /\b(?:inject|injection|dllInject|hookProcess)\b/iu,
	process: /\b(?:child_process|spawn|execFile|processId|enumerateProcesses|openProcess)\b/u,
	memory: /\b(?:ReadProcessMemory|ptrace|processMemory|memoryReader)\b/u,
	log: /\b(?:console|logger|readGameLog|logReader)\b/u,
	traffic: /\b(?:pcap|packetSniffer|interceptTraffic|proxyTraffic)\b/u,
	input: /\b(?:SendInput|simulateInput|keybd_event|mouse_event)\b/u,
	automation: /\b(?:bot|macro|automate|automation|executeGameAction)\b/iu,
	privateData: /\b(?:identity|characterName|character|personaje|fAvatarPosition|fCameraPosition|playerX|playerY|position|movement|combat|loot|processId|pid)\b/iu,
	network: /\b(?:fetch|WebSocket|XMLHttpRequest|requestUrl|node:net|node:http|socket)\b/u,
	persistence: /\b(?:indexedDB|localStorage|sessionStorage|writeFile|writeFileSync)\b/u,
	timer: /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/u,
} as const;

const EXPLICIT_RUNTIME_KINDS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.AwaitExpression,
	ts.SyntaxKind.BinaryExpression,
	ts.SyntaxKind.CallExpression,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.ClassExpression,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.ArrowFunction,
	ts.SyntaxKind.GetAccessor,
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.NewExpression,
	ts.SyntaxKind.PostfixUnaryExpression,
	ts.SyntaxKind.PrefixUnaryExpression,
	ts.SyntaxKind.SetAccessor,
	ts.SyntaxKind.TaggedTemplateExpression,
]);

/** Closed recursive grammar for the reviewed constants, interfaces and type aliases. */
const REVIEWED_DECLARATIVE_KINDS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.ArrayLiteralExpression,
	ts.SyntaxKind.ArrayType,
	ts.SyntaxKind.AsExpression,
	ts.SyntaxKind.EndOfFileToken,
	ts.SyntaxKind.DefaultKeyword,
	ts.SyntaxKind.ExportKeyword,
	ts.SyntaxKind.FalseKeyword,
	ts.SyntaxKind.Identifier,
	ts.SyntaxKind.IndexedAccessType,
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.LiteralType,
	ts.SyntaxKind.NumberKeyword,
	ts.SyntaxKind.NumericLiteral,
	ts.SyntaxKind.ObjectLiteralExpression,
	ts.SyntaxKind.PropertyAssignment,
	ts.SyntaxKind.PropertySignature,
	ts.SyntaxKind.SourceFile,
	ts.SyntaxKind.StringKeyword,
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.TrueKeyword,
	ts.SyntaxKind.TupleType,
	ts.SyntaxKind.TypeAliasDeclaration,
	ts.SyntaxKind.TypeLiteral,
	ts.SyntaxKind.TypeOperator,
	ts.SyntaxKind.TypeQuery,
	ts.SyntaxKind.TypeReference,
	ts.SyntaxKind.UnionType,
	ts.SyntaxKind.VariableDeclaration,
	ts.SyntaxKind.VariableDeclarationList,
	ts.SyntaxKind.VariableStatement,
]);

describe('H8.1/H8.4 Mumble v2 contract architecture boundary', () => {
	it('censuses exactly the contract and reviewed H8.6/H8.7/H8.8 modules', () => {
		const discovered = PRODUCTION_FILES.filter(({ path, source }) => isMumbleArtifact(path, source))
			.map(({ path }) => path);
		expect(discovered).toEqual(REVIEWED_MUMBLE_PRODUCTION_FILES);
	});

	it('keeps the reviewed artifact declarative and export-exact', () => {
		expect(contractViolations(CONTRACT_SOURCE)).toEqual([]);
		expect(exportedNames(CONTRACT_SOURCE)).toEqual(EXPECTED_EXPORTS);
		for (const [name, fields] of Object.entries(EXPECTED_MESSAGE_FIELDS)) {
			expect(interfacePropertyNames(CONTRACT_SOURCE, name)).toEqual(fields);
		}
	});

	it('rejects a helper outside the exact census even when its name looks contractual', () => {
		for (const [path, source] of [
			['src/platform/mumble-v2-contract-helper.ts', 'export const helper = true;'],
			['src/platform/native-bridge.ts', "import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';"],
			['src/mumble.ts', 'export const adapter = true;'],
		] as const) {
			expect(isMumbleArtifact(path, source)).toBe(true);
			expect(REVIEWED_MUMBLE_PRODUCTION_FILES).not.toContain(path);
		}
	});

	it('turns red causally for injection, process, memory, logs, traffic, input and automation', () => {
		const probes = {
			injection: 'inject(game);',
			process: 'spawn(game);',
			memory: 'ReadProcessMemory(handle);',
			log: 'readGameLog(path);',
			traffic: 'interceptTraffic(socket);',
			input: 'simulateInput(key);',
			automation: 'executeGameAction(action);',
		} as const;
		for (const [expected, source] of Object.entries(probes)) {
			expect(contractViolations(source)).toContain(expected);
		}
	});

	it('turns red for personal, spatial or process identity fields in the frame contract', () => {
		for (const field of [
			'identity', 'characterName', 'personaje', 'fAvatarPosition', 'playerX', 'processId', 'pid',
			'position', 'movement', 'combat', 'loot',
		]) {
			expect(contractViolations(`${field}: string;`)).toContain('privateData');
		}
		const expanded = 'export interface MumbleV2IpcFrameV1 { version: 1; identity?: string }';
		expect(interfacePropertyNames(expanded, 'MumbleV2IpcFrameV1')).not.toEqual(EXPECTED_FRAME_FIELDS);
	});

	it('turns red for I/O, persistence, timers, imports and executable declarations', () => {
		for (const [source, expected] of [
			["import { readFileSync } from 'node:fs';", 'dependency'],
			["fetch('https://example.invalid');", 'network'],
			["localStorage.setItem('key', 'value');", 'persistence'],
			['setTimeout(run, 1);', 'timer'],
			['export function run() { return 1; }', 'runtime-node'],
			['export class Adapter {}', 'runtime-node'],
		] as const) {
			expect(contractViolations(source)).toContain(expected);
		}
	});

	it('fails closed on assignments, updates, tagged templates and class expressions', () => {
		for (const source of [
			'value = 1;',
			'value++;',
			'tag`payload`;',
			'export const Adapter = class {};',
		]) {
			expect(contractViolations(source)).toEqual(['runtime-node']);
		}
	});

	it('rejects every alternate export surface and re-export exactly', () => {
		for (const source of [
			'export { value };',
			'export default value;',
			'export = value;',
			'export default interface Alternate {}',
		]) {
			expect(contractViolations(source)).toEqual(['export-surface']);
		}
		expect(contractViolations("export { value } from './runtime';")).toEqual([
			'dependency',
			'export-surface',
		]);
	});

	it('fails closed when an uncensused syntax node enters the recursive grammar', () => {
		expect(contractViolations('export enum Mode { Shadow }')).toEqual(['runtime-node']);
	});
});

type ContractViolation = keyof typeof FORBIDDEN_CAPABILITIES | 'dependency' | 'export-surface' | 'runtime-node';

function contractViolations(source: string): ContractViolation[] {
	const found = new Set<ContractViolation>();
	for (const [name, pattern] of Object.entries(FORBIDDEN_CAPABILITIES)) {
		if (pattern.test(source)) found.add(name as keyof typeof FORBIDDEN_CAPABILITIES);
	}
	const file = parse(source);
	const visit = (node: ts.Node): void => {
		const hasDefaultModifier = ts.canHaveModifiers(node)
			&& ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
		if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)
			|| ts.isNamespaceExportDeclaration(node) || hasDefaultModifier) found.add('export-surface');
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
			|| (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)) found.add('dependency');
		if (EXPLICIT_RUNTIME_KINDS.has(node.kind)) found.add('runtime-node');
		else if (!isReviewedDeclarativeOrRejectedNode(node)) found.add('runtime-node');
		ts.forEachChild(node, visit);
	};
	visit(file);
	return [...found].sort();
}

function isReviewedDeclarativeOrRejectedNode(node: ts.Node): boolean {
	return REVIEWED_DECLARATIVE_KINDS.has(node.kind)
		|| ts.isExportDeclaration(node)
		|| ts.isExportAssignment(node)
		|| ts.isNamespaceExportDeclaration(node)
		|| ts.isNamedExports(node)
		|| ts.isExportSpecifier(node);
}

function exportedNames(source: string): string[] {
	return parse(source).statements.flatMap((statement) => {
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
		if (ts.isVariableStatement(statement)) {
			return statement.declarationList.declarations.flatMap((declaration) =>
				ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
		}
		if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
			&& ts.isIdentifier(statement.name)) return [statement.name.text];
		return [];
	}).sort();
}

function interfacePropertyNames(source: string, interfaceName: string): string[] {
	const declaration = parse(source).statements.find((statement): statement is ts.InterfaceDeclaration =>
		ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName);
	if (declaration === undefined) return [];
	return declaration.members.flatMap((member) => {
		if (!ts.isPropertySignature(member) || member.name === undefined) return [];
		return ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) ? [member.name.text] : [];
	});
}

function parse(source: string): ts.SourceFile {
	return ts.createSourceFile('mumble-v2-contract-probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isMumbleArtifact(path: string, source: string): boolean {
	return /mumble/iu.test(path) || /mumble/iu.test(source);
}

function sourceFiles(root: string): Array<{ path: string; source: string }> {
	return walk(root)
		.map((path) => relative('.', path).replaceAll('\\', '/'))
		.filter((path) => path.endsWith('.ts'))
		.filter((path) => !/(?:^|\/)(?:__fixtures__|test)(?:\/|$)/u.test(path))
		.filter((path) => !/\.(?:spec|test)\.ts$/u.test(path))
		.sort()
		.map((path) => ({ path, source: readFileSync(path, 'utf8') }));
}

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
}
