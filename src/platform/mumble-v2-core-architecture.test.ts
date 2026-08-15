import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PRODUCT_FILES = [
	'src/platform/mumble-v2-client.ts',
	'src/platform/mumble-v2-codec.ts',
	'src/platform/mumble-v2-health.ts',
	'src/platform/mumble-v2-observation.ts',
] as const;
const REVIEWED_MUMBLE_FILES = [
	...PRODUCT_FILES.slice(0, 2),
	'src/platform/mumble-v2-contract.ts',
	...PRODUCT_FILES.slice(2),
] as const;
const ALLOWED_IMPORTS: Record<(typeof PRODUCT_FILES)[number], readonly string[]> = {
	'src/platform/mumble-v2-client.ts': ['./mumble-v2-contract', './mumble-v2-codec'],
	'src/platform/mumble-v2-codec.ts': ['./mumble-v2-contract'],
	'src/platform/mumble-v2-health.ts': ['./mumble-v2-contract'],
	'src/platform/mumble-v2-observation.ts': ['./mumble-v2-contract'],
};
const FORBIDDEN_CAPABILITIES = {
	ambientIo: /\b(?:fetch|WebSocket|XMLHttpRequest|requestUrl|indexedDB|localStorage|sessionStorage)\b/u,
	authority: /\b(?:onStart|onStop|SessionService|SessionStore)\b/iu,
	capture: /\b(?:proposal|capture|persist)\b/iu,
	globalTimer: /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*\(/u,
	logger: /\b(?:console|logger|telemetry)\b/iu,
} as const;

describe('H8.6 isolated core boundary', () => {
	it('discovers exactly the contract plus four reviewed product modules', () => {
		expect(coreBoundaryViolations(productionSources())).toEqual([]);
	});

	it('keeps the shadow observation free of callbacks and authority side effects', () => {
		const source = readFileSync('src/platform/mumble-v2-observation.ts', 'utf8');
		expect(source).not.toMatch(/(?:callback|onStart|onStop|proposal|capture|persist|session)/iu);
		expect(source).not.toMatch(/(?:write|save|fetch|request)\s*\(/iu);
	});

	it('turns red for every unreviewed Mumble module or helper path', () => {
		for (const path of [
			'src/platform/mumble-v2-runtime.ts',
			'src/platform/mumble-v2-helper.ts',
			'src/platform/helper.ts',
		]) {
			const sources = productionSources();
			sources.set(path, path.endsWith('/helper.ts')
				? "import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';"
				: 'export const mumbleRuntime = true;');
			expect(coreBoundaryViolations(sources), path).toContain('census');
		}
	});

	it('turns red causally for fs, net, session, capture, store, logger and global timers', () => {
		const probes = [
			['fs', "import { readFile } from 'node:fs';"],
			['net', "import { connect } from 'node:net';"],
			['session', "import { SessionService } from '../sessions/session-service';"],
			['capture', 'export const capture = () => undefined;'],
			['store', "import { SessionStore } from '../sessions/session-store';"],
			['logger', "logger.info('mumble');"],
			['globalTimer', 'setTimeout(run, 500);'],
			['import', "void import/*x*/('node:fs');"],
			['import', "require/*x*/('node:fs');"],
		] as const;
		for (const [expected, probe] of probes) {
			const sources = productionSources();
			const path = 'src/platform/mumble-v2-client.ts';
			sources.set(path, `${sources.get(path) ?? ''}\n${probe}`);
			expect(coreBoundaryViolations(sources), expected).toContain(expected);
		}
	});

	it("rejects a commented side-effect import such as import /*x*/ 'node:fs'", () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-client.ts';
		sources.set(path, `${sources.get(path) ?? ''}\nimport /*x*/ 'node:fs';`);
		expect(coreBoundaryViolations(sources)).toEqual(expect.arrayContaining(['fs', 'import']));
	});

	it("rejects a commented from clause such as from/*x*/ 'node:fs'", () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-client.ts';
		sources.set(path, `${sources.get(path) ?? ''}\nimport { readFile } from/*x*/ 'node:fs';`);
		expect(coreBoundaryViolations(sources)).toEqual(expect.arrayContaining(['fs', 'import']));
	});

	it("rejects a commented re-export such as export ... from/*x*/ 'node:fs'", () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-client.ts';
		sources.set(path, `${sources.get(path) ?? ''}\nexport { readFile } from/*x*/ 'node:fs';`);
		expect(coreBoundaryViolations(sources)).toEqual(expect.arrayContaining(['fs', 'import']));
	});

	it("rejects a commented import-equals such as import x = require/*x*/('node:fs')", () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-client.ts';
		sources.set(path, `${sources.get(path) ?? ''}\nimport fs = require/*x*/('node:fs');`);
		expect(coreBoundaryViolations(sources)).toEqual(expect.arrayContaining(['fs', 'import']));
	});

	it('detects an always-green replacement of the boundary validator', () => {
		const sources = productionSources();
		const path = 'src/platform/mumble-v2-client.ts';
		sources.set(path, `${sources.get(path) ?? ''}\nimport { readFile } from 'node:fs';`);
		expect(alwaysGreenViolations(coreBoundaryViolations, sources)).toEqual([]);
		expect(alwaysGreenViolations(() => [], sources)).toEqual(['always-green']);
	});
});

type CoreViolation = 'census' | 'import' | 'fs' | 'net' | 'session' | 'authority' | 'capture' | 'store' | 'logger' | 'globalTimer' | 'ambientIo';

function coreBoundaryViolations(sources: ReadonlyMap<string, string>): CoreViolation[] {
	const found = new Set<CoreViolation>();
	const discovered = [...sources]
		.filter(([path, source]) => /mumble/iu.test(path) || /mumble/iu.test(source))
		.map(([path]) => path)
		.sort();
	if (!sameList(discovered, REVIEWED_MUMBLE_FILES)) found.add('census');

	for (const path of PRODUCT_FILES) {
		const source = sources.get(path) ?? '';
		const dependencies = moduleDependencies(path, source);
		const imports = [...dependencies.staticSpecifiers];
		const allSpecifiers = [...imports, ...dependencies.dynamicSpecifiers];
		if (dependencies.invalid || dependencies.dynamicSpecifiers.length > 0
			|| !sameList(imports.sort(), [...ALLOWED_IMPORTS[path]].sort())) {
			found.add('import');
			if (allSpecifiers.some((specifier) => /(?:^|:)fs(?:$|\/)/u.test(specifier))) found.add('fs');
			if (allSpecifiers.some((specifier) => /(?:^|:)(?:net|http|https)(?:$|\/)/u.test(specifier))) found.add('net');
			if (allSpecifiers.some((specifier) => /sessions/iu.test(specifier))) found.add('session');
			if (allSpecifiers.some((specifier) => /(?:store|storage)/iu.test(specifier))) found.add('store');
		}
		for (const [name, pattern] of Object.entries(FORBIDDEN_CAPABILITIES)) {
			if (pattern.test(source)) found.add(name as CoreViolation);
		}
	}
	return [...found].sort();
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
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			&& node.moduleSpecifier !== undefined) {
			if (ts.isStringLiteralLike(node.moduleSpecifier)) staticSpecifiers.push(node.moduleSpecifier.text);
			else invalid = true;
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (ts.isExternalModuleReference(reference) && reference.expression !== undefined
				&& ts.isStringLiteralLike(reference.expression)) staticSpecifiers.push(reference.expression.text);
			else invalid = true;
		} else if (ts.isCallExpression(node)
			&& (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			const argument = node.arguments[0];
			dynamicSpecifiers.push(argument !== undefined && ts.isStringLiteralLike(argument)
				? argument.text : '<dynamic>');
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return { staticSpecifiers, dynamicSpecifiers, invalid };
}

function alwaysGreenViolations(
	validator: (sources: ReadonlyMap<string, string>) => readonly CoreViolation[],
	sources: ReadonlyMap<string, string>,
): string[] {
	return validator(sources).length === 0 ? ['always-green'] : [];
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
