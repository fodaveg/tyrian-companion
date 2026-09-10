import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { MumbleV2ProcessAdapter } from './mumble-v2-process-adapter';
import {
	canonicalMumbleHelperEntries,
	createCanonicalMumbleHelperPackage,
	sha256,
} from './test/mumble-v2-helper-package-fixture';

/**
 * Most of the properties this file used to check by reading mumble-v2-launch-contract.ts,
 * mumble-v2-launch-plan.ts and mumble-v2-process-adapter.ts as text (or hashing their exact
 * characters) are already covered, causally, by executable tests that call the real production
 * code:
 *
 * - `shell` is always `false`: `mumble-v2-launch-plan.test.ts` builds a real plan for all three
 *   platforms and asserts the exact literal object, `shell: false` included.
 * - The launch config accepts no `args`/`env`/`shell`/`command`/`mapping` field, and every
 *   diagnostic excludes `token`/`nonce`/`frame`/`identity`/`pid`/`processId`/`exitCode`/`path`/
 *   `bottle`/`os`: `mumble-v2-launch-contract.test.ts` calls the real `parseMumbleV2LaunchConfig`
 *   and `isMumbleV2LaunchDiagnostic` with exactly those probes.
 * - `spawnIntegrityChecked` is invoked exactly once per `spawn()`, `this.ports.defer` is invoked
 *   exactly once, a premature/second/exited-before-open host event fails closed with
 *   `spawn_failed`, and a throw from spawning or from `defer` still stops the host handle exactly
 *   once: `mumble-v2-process-adapter.test.ts`'s harness records every port call as an event and
 *   asserts on the exact sequence for each of those scenarios (including the two the former
 *   `SPAWN_CAPABILITY_SHA256`/`PROCESS_ADAPTER_SOURCE_SHA256` whole-method/whole-file hashes and
 *   the literal, tab-indentation-dependent "reviewed deferred delivery shape" string match were
 *   standing in for).
 * - The trust label is always `unsigned_qa_only`: `mumble-v2-launch-contract.test.ts` pins
 *   `MUMBLE_V2_ARTIFACT_TRUST` to that exact string, and the process-adapter harness asserts the
 *   real spawned capability carries it.
 * - `scripts/tests/probar-security-scan.mjs` (`npm run test:security-scan`, gate step
 *   `security-scan-suite`) already runs the production `scanSecurityBoundaries()` scanner against
 *   isolated, injected fixture roots for: the census of exactly these three product files and
 *   their reviewed imports; every Node process/child_process escape hatch (`getBuiltinModule`,
 *   `eval`, `Function`, `require`, `module.constructor._load`, `Reflect.get` on the port, a second
 *   `spawnIntegrityChecked` call site); a `pid`/`path`/`token` field on any host-facing interface;
 *   and a sync callback delivery shape. Removed here.
 *
 * What is NOT covered elsewhere, and stays:
 *
 * - That nothing in `main.ts` (or a settings/UI/view/component file) calls `.spawn(...)` from
 *   inside `onload`. `main.ts` currently has no Mumble import at all (H8.7 is quarantined, zero
 *   production consumers), so there is no real call path to exercise; this is a structural,
 *   call-shape check over source text, kept as documented static analysis rather than converted
 *   into an empty test.
 * - That the objects the real adapter code actually hands across the host-process boundary at
 *   runtime (the launch plan, the integrity capability, the callbacks object) carry exactly their
 *   reviewed fields and nothing extra. The former version of this check read the *interface
 *   declarations* as text (a compile-time-only shape); the version below calls the real
 *   `MumbleV2ProcessAdapter.spawn()` and inspects the actual runtime objects it produces.
 */
describe('H8.7 safe launch architecture boundary', () => {
	it('hands the host boundary exactly the reviewed plan, capability and callback shapes', () => {
		const harness = createHarness();
		harness.adapter().spawn({ stdout: () => undefined, exited: () => undefined });
		harness.runDeferred();

		expect(Object.keys(harness.plans[0] ?? {}).sort()).toEqual(
			['argv', 'environment', 'executable', 'route', 'shell', 'stdio', 'version'],
		);
		expect(Object.keys(harness.capabilities[0] ?? {}).sort()).toEqual([
			'executableSha256', 'integrity', 'kind', 'manifestSha256', 'opaqueAuthority', 'trust',
		]);
		expect(Object.keys(harness.hostCallbacks ?? {}).sort()).toEqual(['exited', 'stderr', 'stdout']);
	});

	it('does not wire launch into main.ts onload', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		expect(main).not.toMatch(/mumble-v2-(?:launch|process-adapter)/u);
		expect(onloadSpawnViolations(main)).toBe(false);
	});

	it('turns red causally for an onload spawn call, directly or through a computed access', () => {
		for (const probe of [
			'class Unsafe { onload() { launcher.spawn(callbacks); } }',
			'class Unsafe { onload() { launcher["spawn"](callbacks); } }',
			'function onload() { launcher.spawn(callbacks); }',
		]) {
			expect(onloadSpawnViolations(probe), probe).toBe(true);
		}
	});

	it('does not turn red for a spawn call outside onload or an onload without one', () => {
		for (const probe of [
			'class Safe { onload() { launcher.prepare(); } }',
			'class Safe { start() { launcher.spawn(callbacks); } }',
		]) {
			expect(onloadSpawnViolations(probe), probe).toBe(false);
		}
	});
});

interface Harness {
	readonly plans: Array<{ readonly shell: boolean }>;
	readonly capabilities: Array<Record<string, unknown>>;
	readonly hostCallbacks?: object;
	adapter(): MumbleV2ProcessAdapter;
	runDeferred(): void;
}

function createHarness(): Harness {
	const executable = new Uint8Array([77, 90, 1]);
	const fixture = createCanonicalMumbleHelperPackage(
		executable,
		new TextEncoder().encode('license fixture\n'),
		new TextEncoder().encode('third party fixture\n'),
	);
	const entries = canonicalMumbleHelperEntries(fixture);
	const plans: Array<{ readonly shell: boolean }> = [];
	const capabilities: Array<Record<string, unknown>> = [];
	const deferred: Array<() => void> = [];
	let hostCallbacks: object | undefined;
	return {
		plans,
		capabilities,
		get hostCallbacks() { return hostCallbacks; },
		adapter: () => new MumbleV2ProcessAdapter({
			version: 1,
			platform: 'windows_native',
			helperPackageDirectory: 'C:\\Tyrian\\MumbleHelper',
		}, {
			artifacts: {
				openPackage: () => ({ entries, opaqueAuthority: { snapshot: [...executable] } }),
				sha256: (bytes) => sha256(bytes),
			},
			process: {
				spawnIntegrityChecked: (plan, capability, callbacks) => {
					plans.push(plan);
					capabilities.push(capability);
					hostCallbacks = callbacks;
					return { writeStdin: () => undefined, stop: () => undefined };
				},
			},
			defer: (callback) => deferred.push(callback),
		}),
		runDeferred: () => {
			for (const callback of deferred.splice(0)) callback();
		},
	};
}

function onloadSpawnViolations(source: string): boolean {
	const file = ts.createSourceFile('main-probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let found = false;
	const visit = (node: ts.Node, insideOnload = false): void => {
		const nowInside = insideOnload || ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
			&& node.name !== undefined && propertyName(node.name) === 'onload');
		if (nowInside && isSpawnAccess(node) && ts.isCallExpression(node.parent) && node.parent.expression === node) {
			found = true;
		}
		ts.forEachChild(node, (child) => visit(child, nowInside));
	};
	visit(file);
	return found;
}

function isSpawnAccess(node: ts.Node): boolean {
	if (ts.isPropertyAccessExpression(node)) return node.name.text === 'spawn';
	return ts.isElementAccessExpression(node) && node.argumentExpression !== undefined
		&& ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'spawn';
}

function propertyName(name: ts.PropertyName): string | null {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;
}
