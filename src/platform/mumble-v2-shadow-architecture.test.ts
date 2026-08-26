import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const H8_8_FILES = [
	'src/platform/mumble-v2-presence-policy.ts',
	'src/sessions/mumble-v2-shadow-proposal.ts',
] as const;
const ALLOWED_IMPORTS: Readonly<Record<(typeof H8_8_FILES)[number], readonly string[]>> = {
	'src/platform/mumble-v2-presence-policy.ts': [
		'./mumble-v2-contract',
		'./mumble-v2-contract',
	],
	'src/sessions/mumble-v2-shadow-proposal.ts': [
		'../platform/mumble-v2-contract',
		'../platform/mumble-v2-presence-policy',
	],
};
const EXPECTED_IMPORTERS: Readonly<Record<(typeof H8_8_FILES)[number], readonly string[]>> = {
	'src/platform/mumble-v2-presence-policy.ts': ['src/sessions/mumble-v2-shadow-proposal.ts'],
	'src/sessions/mumble-v2-shadow-proposal.ts': [],
};
const EXPECTED_INTERFACE_FIELDS = new Map<string, readonly string[]>([
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
const RAW_TRANSPORT_NAMES = new Set([
	'MumbleV2BootstrapRecordV1', 'MumbleV2HeartbeatRecordV1', 'MumbleV2HelloRecordV1',
	'MumbleV2IpcFrameV1', 'MumbleV2ReadyRecordV1', 'MumbleV2WelcomeRecordV1',
	'frame', 'heartbeatIntervalMs', 'host', 'nonce', 'port', 'raw', 'record', 'sequence', 'tick', 'token',
]);
const TIMER_NAMES = new Set(['queueMicrotask', 'requestAnimationFrame', 'setInterval', 'setTimeout']);
const IO_NAMES = new Set([
	'WebSocket', 'XMLHttpRequest', 'console', 'fetch', 'logger', 'readFile', 'readFileSync',
	'requestUrl', 'telemetry', 'writeFile', 'writeFileSync',
]);
const PERSISTENCE_NAMES = new Set([
	'IDBDatabase', 'IDBFactory', 'SessionNoteVault', 'indexedDB', 'localStorage', 'saveData',
	'sessionStorage',
]);
const LIFECYCLE_NAMES = new Set([
	'ManualSessionStartService', 'SessionService', 'TyrianCompanionPlugin', 'start',
	'startManualSession', 'stop', 'stopManualSession', 'transitionSession',
]);
const QUEUE_NAMES = new Set([
	'PendingProposalService', 'accept', 'claim', 'dismiss', 'enqueue', 'reconcile',
]);

// Every case re-runs the whole-tree boundary scan several times. Isolated each stays
// around 2s, but under the full parallel suite they crossed the default 5s budget and
// failed the gate at random. The budget is raised; no assertion changes.
describe('H8.8 isolated shadow presence boundary', { timeout: 30_000 }, () => {
	it('censuses exactly the pure presence reducer and human-review DTO adapter', () => {
		expect(shadowBoundaryViolations(productionSources())).toEqual([]);
	});

	it('turns red for a third presence/shadow module', () => {
		const sources = productionSources();
		sources.set('src/platform/mumble-v2-shadow-runtime.ts', 'export const runtime = true;');
		expect(shadowBoundaryViolations(sources)).toContain('census');
	});

	it('keeps both modules on their exact reviewed imports and outside product runtime', () => {
		const sources = productionSources();
		sources.set('src/main.ts', `${sources.get('src/main.ts') ?? ''}\n` +
			"import { createMumbleV2ShadowProposal } from './sessions/mumble-v2-shadow-proposal';");
		expect(shadowBoundaryViolations(sources)).toContain('consumer');

		const dynamicConsumer = productionSources();
		dynamicConsumer.set('src/main.ts', `${dynamicConsumer.get('src/main.ts') ?? ''}\n` +
			"void import('./platform/mumble-v2-presence-policy');");
		expect(shadowBoundaryViolations(dynamicConsumer)).toContain('consumer');

		const changed = productionSources();
		const path = 'src/sessions/mumble-v2-shadow-proposal.ts';
		changed.set(path, `${changed.get(path) ?? ''}\nimport { transitionSession } from './session-state-machine';`);
		expect(shadowBoundaryViolations(changed)).toEqual(expect.arrayContaining(['import', 'lifecycle']));
	});

	it('turns red causally for timers, I/O and persistence including computed access', () => {
		for (const [expected, probe] of [
			['timer', 'globalThis["setTimeout"](() => undefined, 1);'],
			['io', 'fetch("https://example.invalid");'],
			['io', "import { readFile } from 'node:fs';"],
			['persistence', 'indexedDB.open("mumble-shadow");'],
			['persistence', 'saveData({ projection: true });'],
		] as const) {
			const sources = productionSources();
			const path = 'src/platform/mumble-v2-presence-policy.ts';
			sources.set(path, `${sources.get(path) ?? ''}\n${probe}`);
			expect(shadowBoundaryViolations(sources), probe).toContain(expected);
		}
	});

	it('turns red for raw transport types or fields in either reviewed surface', () => {
		for (const probe of [
			'interface LeakedFrame { nonce: string }',
			'interface LeakedFrame { tick: number }',
			'interface LeakedFrame { frame: MumbleV2IpcFrameV1 }',
		]) {
			const sources = productionSources();
			const path = 'src/sessions/mumble-v2-shadow-proposal.ts';
			sources.set(path, `${sources.get(path) ?? ''}\n${probe}`);
			expect(shadowBoundaryViolations(sources), probe).toContain('raw-transport');
		}
	});

	it('turns red for direct lifecycle or pending-queue calls', () => {
		for (const [expected, probe] of [
			['lifecycle', 'transitionSession(state, event);'],
			['lifecycle', 'runtime.start();'],
			['lifecycle', 'runtime["stop"]();'],
			['queue', 'pending.enqueue(candidate);'],
			['queue', 'const queue: PendingProposalService = pending;'],
		] as const) {
			const sources = productionSources();
			const path = 'src/sessions/mumble-v2-shadow-proposal.ts';
			sources.set(path, `${sources.get(path) ?? ''}\n${probe}`);
			expect(shadowBoundaryViolations(sources), probe).toContain(expected);
		}
	});

	it('locks memory context, reducer state, signal and proposal DTO to reviewed data-only shapes', () => {
		for (const [path, needle, replacement] of [
			[
				'src/platform/mumble-v2-presence-policy.ts',
				'\treadonly authority: MumbleV2PresenceAuthority;',
				'\treadonly authority: MumbleV2PresenceAuthority;\n\treadonly persisted: boolean;',
			],
			[
				'src/platform/mumble-v2-presence-policy.ts',
				'\treadonly stopLatchedBinding: string | null;',
				'\treadonly stopLatchedBinding: string | null;\n\treadonly queueDepth: number;',
			],
			[
				'src/sessions/mumble-v2-shadow-proposal.ts',
				"\treadonly effect: 'proposal_only';",
				"\treadonly effect: 'proposal_only';\n\treadonly automatic: boolean;",
			],
		] as const) {
			const sources = productionSources();
			sources.set(path, (sources.get(path) ?? '').replace(needle, replacement));
			expect(shadowBoundaryViolations(sources), replacement).toContain('shape');
		}
	});

	it('detects an always-green replacement of the validator', () => {
		const sources = productionSources();
		const path = 'src/sessions/mumble-v2-shadow-proposal.ts';
		sources.set(path, `${sources.get(path) ?? ''}\npending.enqueue(candidate);`);
		expect(alwaysGreenViolations(shadowBoundaryViolations, sources)).toEqual([]);
		expect(alwaysGreenViolations(() => [], sources)).toEqual(['always-green']);
	});
});

type ShadowViolation =
	| 'census' | 'consumer' | 'import' | 'io' | 'persistence' | 'timer'
	| 'raw-transport' | 'lifecycle' | 'queue' | 'shape';

function shadowBoundaryViolations(sources: ReadonlyMap<string, string>): ShadowViolation[] {
	const found = new Set<ShadowViolation>();
	const discovered = [...sources]
		.filter(([path, source]) => isH8_8Artifact(path, source))
		.map(([path]) => path)
		.sort();
	if (!sameList(discovered, H8_8_FILES)) found.add('census');

	const importers = new Map(H8_8_FILES.map((path) => [path, [] as string[]]));
	for (const [consumerPath, source] of sources) {
		const dependencies = moduleDependencies(consumerPath, source);
		for (const specifier of [...dependencies.staticSpecifiers, ...dependencies.dynamicSpecifiers]) {
			if (specifier.endsWith('/mumble-v2-presence-policy')) {
				importers.get('src/platform/mumble-v2-presence-policy.ts')?.push(consumerPath);
			}
			if (specifier.endsWith('/mumble-v2-shadow-proposal')) {
				importers.get('src/sessions/mumble-v2-shadow-proposal.ts')?.push(consumerPath);
			}
		}
	}
	for (const path of H8_8_FILES) {
		const actual = [...(importers.get(path) ?? [])].sort();
		if (!sameList(actual, EXPECTED_IMPORTERS[path])) found.add('consumer');
	}

	for (const path of H8_8_FILES) {
		const source = sources.get(path) ?? '';
		const dependencies = moduleDependencies(path, source);
		const imports = [...dependencies.staticSpecifiers].sort();
		if (dependencies.invalid || dependencies.dynamicSpecifiers.length > 0 ||
			!sameList(imports, [...ALLOWED_IMPORTS[path]].sort())) found.add('import');
		for (const specifier of [...imports, ...dependencies.dynamicSpecifiers]) {
			if (/(?:^|:)(?:fs|net|http|https)(?:$|\/)|obsidian/u.test(specifier)) found.add('io');
			if (/(?:store|writer|cache|indexed|vault)/iu.test(specifier)) found.add('persistence');
			if (/(?:manual-session|session-state-machine|\/main$)/u.test(specifier)) found.add('lifecycle');
			if (/pending-proposal/u.test(specifier)) found.add('queue');
		}

		const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const seenInterfaces = new Map<string, string[]>();
		const visit = (node: ts.Node): void => {
			const name = syntaxName(node);
			if (name !== null) {
				if (RAW_TRANSPORT_NAMES.has(name)) found.add('raw-transport');
				if (TIMER_NAMES.has(name)) found.add('timer');
				if (IO_NAMES.has(name)) found.add('io');
				if (PERSISTENCE_NAMES.has(name)) found.add('persistence');
				if (LIFECYCLE_NAMES.has(name) && isCallOrTypeReference(node)) found.add('lifecycle');
				if (QUEUE_NAMES.has(name) && isCallOrTypeReference(node)) found.add('queue');
			}
			if (ts.isInterfaceDeclaration(node) && EXPECTED_INTERFACE_FIELDS.has(node.name.text)) {
				seenInterfaces.set(node.name.text, node.members.flatMap((member) => {
					const field = member.name === undefined ? null : propertyName(member.name);
					return field === null ? [] : [field];
				}));
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		for (const [interfaceName, fields] of EXPECTED_INTERFACE_FIELDS) {
			const belongsHere = interfaceName.startsWith('MumbleV2Presence')
				? path.endsWith('mumble-v2-presence-policy.ts')
				: path.endsWith('mumble-v2-shadow-proposal.ts');
			if (belongsHere && !sameList(seenInterfaces.get(interfaceName) ?? [], fields)) found.add('shape');
		}
	}
	return [...found].sort();
}

function isH8_8Artifact(path: string, source: string): boolean {
	return /mumble-v2-(?:presence|shadow)-/u.test(path) ||
		/\bMumbleV2(?:Presence(?:Authority|Context|Policy|Signal)|ShadowProposal)\b/u.test(source);
}

function moduleDependencies(path: string, source: string): {
	readonly staticSpecifiers: string[];
	readonly dynamicSpecifiers: string[];
	readonly invalid: boolean;
} {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const staticSpecifiers: string[] = [];
	const dynamicSpecifiers: string[] = [];
	let invalid = false;
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
			if (ts.isStringLiteralLike(node.moduleSpecifier)) staticSpecifiers.push(node.moduleSpecifier.text);
			else invalid = true;
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (ts.isExternalModuleReference(reference) && reference.expression !== undefined &&
				ts.isStringLiteralLike(reference.expression)) staticSpecifiers.push(reference.expression.text);
			else invalid = true;
		} else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
			(ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			const argument = node.arguments[0];
			dynamicSpecifiers.push(argument !== undefined && ts.isStringLiteralLike(argument)
				? argument.text : '<dynamic>');
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return { staticSpecifiers, dynamicSpecifiers, invalid };
}

function syntaxName(node: ts.Node): string | null {
	if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined &&
		ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
	if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) ||
		ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
		return propertyName(node.name);
	}
	return null;
}

function isCallOrTypeReference(node: ts.Node): boolean {
	if (ts.isTypeReferenceNode(node.parent) || ts.isExpressionWithTypeArguments(node.parent)) return true;
	if (ts.isCallExpression(node.parent)) return node.parent.expression === node;
	if (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) {
		return ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent;
	}
	return false;
}

function propertyName(name: ts.PropertyName | ts.BindingName): string | null {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
		? name.text : null;
}

// Reading every production file off disk once per case pushed this suite past the default
// 5s budget under load. The scan is deterministic within a run, so it is read once; each
// caller still gets its own copy because the cases mutate the map they receive.
let productionSourcesCache: Map<string, string> | null = null;

function productionSources(): Map<string, string> {
	productionSourcesCache ??= new Map(walk('src')
		.map((path) => relative('.', path).replaceAll('\\', '/'))
		.filter((path) => path.endsWith('.ts') && !/\.(?:spec|test)\.ts$/u.test(path))
		.filter((path) => !/(?:^|\/)(?:__fixtures__|test)(?:\/|$)/u.test(path))
		.map((path) => [path, readFileSync(path, 'utf8')]));
	return new Map(productionSourcesCache);
}

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function alwaysGreenViolations(
	validator: (sources: ReadonlyMap<string, string>) => readonly ShadowViolation[],
	sources: ReadonlyMap<string, string>,
): string[] {
	return validator(sources).length === 0 ? ['always-green'] : [];
}
