import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PRODUCT_FILES = [
	'src/platform/mumble-v2-launch-contract.ts',
	'src/platform/mumble-v2-launch-plan.ts',
	'src/platform/mumble-v2-process-adapter.ts',
] as const;
const SPAWN_CAPABILITY_SHA256 = 'a12bff26711472e5637bd2a8e9205ccc16a6b76e7f08b7cc7668d83dc070f77d';
const PROCESS_ADAPTER_SOURCE_SHA256 = '72f4dfc5052f386a75aa321305936f1223e6e94fd6c9454ba047b0b2097775f6';
const ALLOWED_IMPORTS: Readonly<Record<(typeof PRODUCT_FILES)[number], readonly string[]>> = {
	'src/platform/mumble-v2-launch-contract.ts': [],
	'src/platform/mumble-v2-launch-plan.ts': ['./mumble-v2-launch-contract'],
	'src/platform/mumble-v2-process-adapter.ts': [
		'./mumble-v2-client', './mumble-v2-launch-contract', './mumble-v2-launch-plan',
	],
};
const CONFIG_FIELDS = new Set([
	'version', 'platform', 'helperPackageDirectory', 'bottleName', 'steamCompatDataDirectory',
]);
const FORBIDDEN_CONFIG_FIELDS = new Set(['args', 'env', 'shell', 'command', 'mapping']);
const FORBIDDEN_DIAGNOSTIC_FIELDS = new Set([
	'token', 'nonce', 'frame', 'identity', 'pid', 'processId', 'exitCode', 'path', 'bottle', 'os',
]);
const HOST_INTERFACE_FIELDS: Readonly<Record<string, readonly string[]>> = {
	MumbleV2ArtifactEntry: ['name', 'bytes'],
	MumbleV2OpenedArtifactPackage: ['entries', 'opaqueAuthority'],
	MumbleV2ArtifactPort: ['openPackage', 'sha256'],
	MumbleV2HostProcessCallbacks: ['stdout', 'stderr', 'exited'],
	MumbleV2HostProcessHandle: ['writeStdin', 'stop'],
	MumbleV2IntegrityCheckedArtifactCapability: [
		'kind', 'integrity', 'trust', 'executableSha256', 'manifestSha256', 'opaqueAuthority',
	],
	MumbleV2HostProcessPort: ['spawnIntegrityChecked'],
	MumbleV2ProcessAdapterPorts: ['artifacts', 'process', 'defer', 'onDiagnostic'],
};

describe('H8.7 safe launch architecture boundary', () => {
	it('censuses exactly the three isolated product modules and their reviewed imports', () => {
		expect(launchBoundaryViolations(productionSources())).toEqual([]);
	});

	it('does not wire launch into settings, UI, main or onload', () => {
		const sources = productionSources();
		for (const [path, source] of sources) {
			if (PRODUCT_FILES.includes(path as (typeof PRODUCT_FILES)[number])) continue;
			if (/(?:main|settings?|views?|components?|ui)\.ts$/iu.test(path)) {
				expect(source, path).not.toMatch(/mumble-v2-(?:launch|process-adapter)/u);
			}
		}
		expect(launchBoundaryViolations(sources)).not.toContain('onload-spawn');
	});

	it('turns red causally for direct or indirect shell, configurable mapping, free args and free env', () => {
		const probes = [
			['shell-true', 'src/platform/mumble-v2-launch-plan.ts', 'const unsafe = { shell: true };'],
			['shell-true', 'src/platform/mumble-v2-launch-plan.ts', 'const indirect = true; const unsafe = { shell: indirect };'],
			['shell-true', 'src/platform/mumble-v2-launch-plan.ts', 'const shell = true; const unsafe = { shell };'],
			['config-field', 'src/platform/mumble-v2-launch-contract.ts', 'interface MumbleV2UnsafeLaunchConfig { mapping: string }'],
			['config-field', 'src/platform/mumble-v2-launch-contract.ts', 'interface MumbleV2UnsafeLaunchConfig { args: string[] }'],
			['config-field', 'src/platform/mumble-v2-launch-contract.ts', 'interface MumbleV2UnsafeLaunchConfig { env: Record<string, string> }'],
		] as const;
		for (const [expected, path, probe] of probes) {
			const sources = productionSources();
			sources.set(path, `${sources.get(path) ?? ''}\n${probe}`);
			expect(launchBoundaryViolations(sources), probe).toContain(expected);
		}
	});

	it('turns red causally for path or PID diagnostics', () => {
		for (const field of ['path', 'pid'] as const) {
			const sources = productionSources();
			const path = 'src/platform/mumble-v2-launch-contract.ts';
			sources.set(path, `${sources.get(path) ?? ''}\ninterface MumbleV2UnsafeLaunchDiagnostic { ${field}: string }`);
			expect(launchBoundaryViolations(sources), field).toContain('diagnostic-field');
		}
	});

	it('turns red causally for a second process module and onload spawn', () => {
		const secondProcess = productionSources();
		secondProcess.set('src/platform/mumble-v2-process-node.ts', 'export const secondProcess = true;');
		expect(launchBoundaryViolations(secondProcess)).toContain('census');

		const onload = productionSources();
		onload.set('src/main.ts', `${onload.get('src/main.ts') ?? ''}\nclass Unsafe { onload() { launcher.spawn(callbacks); } }`);
		expect(launchBoundaryViolations(onload)).toContain('onload-spawn');
	});

	it('turns red for Node/process capabilities, sync callback delivery and trust overclaims', () => {
		for (const [expected, probe] of [
			['import', "import { spawn } from/*x*/ 'node:child_process';"],
			['node-capability', "process.getBuiltinModule('node:child_process');"],
			['node-capability', "process['getBuiltinModule']('node:child_process');"],
			['node-capability', "globalThis.process.getBuiltinModule('node:child_process');"],
			['node-capability', "globalThis['process']['getBuiltinModule']('node:child_process');"],
			['node-capability', "const hostProcess = process; hostProcess.getBuiltinModule('node:child_process');"],
			['node-capability', "const hostProcess = global.process; hostProcess.getBuiltinModule('node:child_process').spawn('x');"],
			['node-capability', "const hostProcess = globalThis.global.process; hostProcess['getBuiltinModule']('node:child_process');"],
			['node-capability', "const hostProcess = (0, eval)('process'); hostProcess.getBuiltinModule('node:child_process');"],
			['node-capability', "const hostProcess = Function('return process')(); hostProcess.getBuiltinModule('node:child_process');"],
			['node-capability', "hostAuthority['getBuiltinModule']('node:child_process');"],
			['node-capability', "(0, require)('node:child_process').spawn('x');"],
			['node-capability', "module.constructor._load('node:child_process').spawn('x');"],
			['callback-order', 'callbacks.stdout(chunk);'],
			['delivery-shape', 'const deliver = (callback: () => void) => callback();'],
			['spawn-call-site', 'export function unsafeSpawn(port: MumbleV2HostProcessPort, plan: MumbleV2LaunchPlan, capability: MumbleV2IntegrityCheckedArtifactCapability, callbacks: MumbleV2HostProcessCallbacks) { return port.spawnIntegrityChecked(plan, capability, callbacks); }'],
			['adapter-source', 'export function unsafeReflect(port: MumbleV2HostProcessPort, plan: MumbleV2LaunchPlan, capability: MumbleV2IntegrityCheckedArtifactCapability, callbacks: MumbleV2HostProcessCallbacks) { const run = Reflect.get(port, "spawnIntegrityChecked") as MumbleV2HostProcessPort["spawnIntegrityChecked"]; return run(plan, capability, callbacks); }'],
			['trust-overclaim', "const trust = 'verified_for_execution';"],
		] as const) {
			const sources = productionSources();
			const path = 'src/platform/mumble-v2-process-adapter.ts';
			sources.set(path, `${sources.get(path) ?? ''}\n${probe}`);
			expect(launchBoundaryViolations(sources), probe).toContain(expected);
		}
	});

	it('turns red when deferred delivery is changed inside the reviewed method', () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-process-adapter.ts';
		const original = sources.get(path) ?? '';
		const reviewed = "\t\t\t\tif (prematureFailure) {\n\t\t\t\t\tcloseAfterReturn();";
		expect(original).toContain(reviewed);
		sources.set(path, original.replace(reviewed, "\t\t\t\tif (false) {\n\t\t\t\t\tcloseAfterReturn();"));
		expect(launchBoundaryViolations(sources)).toContain('delivery-shape');
	});

	it('turns red for PID, path or token fields on every host-facing interface', () => {
		for (const field of ['pid', 'path', 'token'] as const) {
			const sources = productionSources();
			const path = 'src/platform/mumble-v2-process-adapter.ts';
			sources.set(path, `${sources.get(path) ?? ''}\ninterface MumbleV2HostUnsafe { ${field}: string }`);
			expect(launchBoundaryViolations(sources), field).toContain('host-shape');
		}
	});

	it('detects an always-green replacement of the validator', () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-launch-plan.ts';
		sources.set(path, `${sources.get(path) ?? ''}\nconst unsafe = { shell: true };`);
		expect(alwaysGreenViolations(launchBoundaryViolations, sources)).toEqual([]);
		expect(alwaysGreenViolations(() => [], sources)).toEqual(['always-green']);
	});
});

type LaunchViolation =
	| 'census' | 'import' | 'shell-true' | 'config-field' | 'diagnostic-field'
	| 'onload-spawn' | 'callback-order' | 'trust-overclaim' | 'node-capability'
	| 'host-shape' | 'delivery-shape' | 'spawn-call-site' | 'adapter-source';

function launchBoundaryViolations(sources: ReadonlyMap<string, string>): LaunchViolation[] {
	const found = new Set<LaunchViolation>();
	const discovered = [...sources.keys()]
		.filter((path) => /mumble-v2-(?:launch-|process)/u.test(path))
		.sort();
	if (!sameList(discovered, [...PRODUCT_FILES].sort())) found.add('census');

	for (const path of PRODUCT_FILES) {
		const source = sources.get(path) ?? '';
		const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const imports = staticImports(file);
		const spawnCapabilityHashes: string[] = [];
		let spawnIntegrityCheckedReferences = 0;
		if (!sameList(imports.sort(), [...ALLOWED_IMPORTS[path]].sort())) found.add('import');
		if (/\b(?:trusted|verified)(?:_|\b)/iu.test(source)) found.add('trust-overclaim');
		const visit = (node: ts.Node): void => {
			if (ts.isObjectLiteralExpression(node)) {
				for (const member of node.properties) {
					if (!('name' in member) || member.name === undefined
						|| propertyName(member.name) !== 'shell') continue;
					if (!ts.isPropertyAssignment(member)
						|| member.initializer.kind !== ts.SyntaxKind.FalseKeyword) found.add('shell-true');
				}
			}
			if (isAmbientProcessReference(node)) found.add('node-capability');
			if (path.endsWith('mumble-v2-process-adapter.ts') && ts.isMethodDeclaration(node)
				&& node.name !== undefined && propertyName(node.name) === 'spawnCapability') {
				spawnCapabilityHashes.push(hashCanonicalNode(node, file));
			}
			if (path.endsWith('mumble-v2-process-adapter.ts') && isSpawnIntegrityCheckedAccess(node)) {
				spawnIntegrityCheckedReferences += 1;
				if (!ts.isCallExpression(node.parent) || node.parent.expression !== node
					|| !isInsideMethod(node, 'spawnCapability')) found.add('spawn-call-site');
			}
			if (path.endsWith('mumble-v2-process-adapter.ts') && ts.isBindingElement(node)
				&& propertyName(node.propertyName ?? node.name) === 'spawnIntegrityChecked') {
				found.add('spawn-call-site');
			}
			if (ts.isInterfaceDeclaration(node) && /LaunchConfig/u.test(node.name.text)) {
				for (const member of node.members) {
					if (!ts.isPropertySignature(member)) continue;
					const name = propertyName(member.name);
					if (name !== null && (!CONFIG_FIELDS.has(name) || FORBIDDEN_CONFIG_FIELDS.has(name))) {
						found.add('config-field');
					}
				}
			}
			if (ts.isInterfaceDeclaration(node) && /LaunchDiagnostic/u.test(node.name.text)) {
				for (const member of node.members) {
					if (!ts.isPropertySignature(member)) continue;
					const name = propertyName(member.name);
					if (name !== null && FORBIDDEN_DIAGNOSTIC_FIELDS.has(name)) found.add('diagnostic-field');
				}
			}
			if (path.endsWith('mumble-v2-process-adapter.ts') && ts.isInterfaceDeclaration(node)
				&& /(?:Host|Artifact|ProcessAdapterPorts)/u.test(node.name.text)) {
				const expected = HOST_INTERFACE_FIELDS[node.name.text];
				const actual = node.members.flatMap((member) => member.name === undefined
					? [] : [propertyName(member.name)]).filter((name) => name !== null);
				if (expected === undefined || !sameList(actual.sort(), [...expected].sort())) found.add('host-shape');
			}
			if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
				&& node.name !== undefined && propertyName(node.name) === 'deliver') found.add('delivery-shape');
			ts.forEachChild(node, visit);
		};
		visit(file);
		if (path.endsWith('mumble-v2-process-adapter.ts')
			&& hashCanonicalSource(source) !== PROCESS_ADAPTER_SOURCE_SHA256) found.add('adapter-source');
		if (path.endsWith('mumble-v2-process-adapter.ts')
			&& !sameList(spawnCapabilityHashes, [SPAWN_CAPABILITY_SHA256])) found.add('delivery-shape');
		if (path.endsWith('mumble-v2-process-adapter.ts')
			&& spawnIntegrityCheckedReferences !== 1) found.add('spawn-call-site');
	}

	const adapter = sources.get('src/platform/mumble-v2-process-adapter.ts') ?? '';
	if (/^callbacks\.(?:stdout|exited)\s*\(/mu.test(adapter)) found.add('callback-order');
	if ((adapter.match(/this\.ports\.defer\s*\(/gu)?.length ?? 0) !== 1) found.add('delivery-shape');
	for (const [path, source] of sources) {
		if (!/(?:^|\/)main\.ts$/u.test(path)) continue;
		const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const visit = (node: ts.Node, insideOnload = false): void => {
			const nowInside = insideOnload || ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
				&& node.name !== undefined && propertyName(node.name) === 'onload');
			if (nowInside && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
				&& node.expression.name.text === 'spawn') found.add('onload-spawn');
			ts.forEachChild(node, (child) => visit(child, nowInside));
		};
		visit(file);
	}
	return [...found].sort();
}

function isSpawnIntegrityCheckedAccess(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
	if (ts.isPropertyAccessExpression(node)) return node.name.text === 'spawnIntegrityChecked';
	return ts.isElementAccessExpression(node) && node.argumentExpression !== undefined
		&& ts.isStringLiteralLike(node.argumentExpression)
		&& node.argumentExpression.text === 'spawnIntegrityChecked';
}

function isInsideMethod(node: ts.Node, methodName: string): boolean {
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

function isAmbientProcessReference(node: ts.Node): boolean {
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

function hashCanonicalNode(node: ts.Node, file: ts.SourceFile): string {
	const canonical = node.getText(file).normalize('NFC').replace(/\r\n?/gu, '\n');
	return createHash('sha256').update(canonical).digest('hex');
}

function hashCanonicalSource(source: string): string {
	const canonical = source.normalize('NFC').replace(/\r\n?/gu, '\n');
	return createHash('sha256').update(canonical).digest('hex');
}

function staticImports(file: ts.SourceFile): string[] {
	const imports: string[] = [];
	let invalid = false;
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			&& node.moduleSpecifier !== undefined) {
			if (ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
			else invalid = true;
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (ts.isExternalModuleReference(reference) && reference.expression !== undefined
				&& ts.isStringLiteralLike(reference.expression)) imports.push(reference.expression.text);
			else invalid = true;
		} else if (ts.isCallExpression(node)
			&& (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) invalid = true;
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (invalid) imports.push('<invalid>');
	return imports;
}

function propertyName(name: ts.PropertyName | ts.BindingName): string | null {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
		? name.text : null;
}

function productionSources(): Map<string, string> {
	return new Map(walk('src')
		.map((path) => relative('.', path).replaceAll('\\', '/'))
		.filter((path) => path.endsWith('.ts') && !/\.(?:spec|test)\.ts$/u.test(path))
		.filter((path) => !/(?:^|\/)(?:__fixtures__|test)(?:\/|$)/u.test(path))
		.map((path) => [path, readFileSync(path, 'utf8')]));
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
	validator: (sources: ReadonlyMap<string, string>) => readonly LaunchViolation[],
	sources: ReadonlyMap<string, string>,
): string[] {
	return validator(sources).length === 0 ? ['always-green'] : [];
}
