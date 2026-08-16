import { describe, expect, it } from 'vitest';

import {
	MumbleV2ProcessAdapter,
	MumbleV2ProcessAdapterError,
	type MumbleV2ArtifactEntry,
	type MumbleV2HostProcessCallbacks,
	type MumbleV2IntegrityCheckedArtifactCapability,
} from './mumble-v2-process-adapter';
import type { MumbleV2LaunchPlan } from './mumble-v2-launch-plan';
import {
	canonicalMumbleHelperEntries,
	createCanonicalMumbleHelperPackage,
	sha256,
} from './test/mumble-v2-helper-package-fixture';

const CONFIG = {
	version: 1,
	platform: 'windows_native',
	helperPackageDirectory: 'C:\\Tyrian\\MumbleHelper',
} as const;
const encoder = new TextEncoder();

describe('H8.7 canonical package gate and atomic process adapter', () => {
	it('accepts the exact shared H8.5 five-file fixture before every capability spawn', () => {
		const harness = createHarness();
		const adapter = harness.adapter();
		adapter.spawn({ stdout: () => undefined, exited: () => undefined });
		adapter.spawn({ stdout: () => undefined, exited: () => undefined });

		expect(harness.events).toEqual([
			'open', 'hash:exe', 'hash:manifest', 'hash:license', 'hash:third-party', 'spawnIntegrityChecked', 'defer',
			'open', 'hash:exe', 'hash:manifest', 'hash:license', 'hash:third-party', 'spawnIntegrityChecked', 'defer',
		]);
		expect(harness.plans[0]).toMatchObject({
			executable: { kind: 'integrity_checked_helper' }, argv: [], environment: {}, shell: false,
		});
		expect(harness.capabilities[0]).toMatchObject({
			kind: 'integrity_checked_mumble_helper',
			integrity: 'integrity_checked',
			trust: 'unsigned_qa_only',
		});
		expect(harness.capabilities[0]?.executableSha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(harness.capabilities[0]?.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
	});

	it('never gives the process boundary a re-resolvable helper package location', () => {
		const harness = createHarness();
		harness.adapter().spawn({ stdout: () => undefined, exited: () => undefined });
		const delegated = JSON.stringify({ plan: harness.plans[0], capability: harness.capabilities[0] });
		expect(delegated).not.toContain(CONFIG.helperPackageDirectory);
		expect(delegated).not.toContain('tyrian-mumble-helper.exe');
		expect(harness.capabilities[0]?.opaqueAuthority).toEqual({ snapshot: [77, 90, 1] });
	});

	it('rejects missing, extra, duplicate, casing and tampered canonical package inputs', () => {
		for (const [name, mutate, code] of [
			['missing', (entries: MumbleV2ArtifactEntry[]) => entries.splice(3, 1), 'manifest_invalid'],
			['extra', (entries: MumbleV2ArtifactEntry[]) => entries.push({ name: 'extra.txt', bytes: encoder.encode('x') }), 'manifest_invalid'],
			['duplicate', (entries: MumbleV2ArtifactEntry[]) => entries.splice(4, 0, entries[3]!), 'manifest_invalid'],
			['casing', (entries: MumbleV2ArtifactEntry[]) => { entries[3] = { ...entries[3]!, name: 'license' }; }, 'manifest_invalid'],
			['tampered-exe', (entries: MumbleV2ArtifactEntry[]) => { entries[0] = { ...entries[0]!, bytes: new Uint8Array([77, 90, 9]) }; }, 'artifact_hash_mismatch'],
			['tampered-manifest', (entries: MumbleV2ArtifactEntry[]) => { entries[1] = { ...entries[1]!, bytes: encoder.encode('{}\n') }; }, 'manifest_invalid'],
			['tampered-checksums', (entries: MumbleV2ArtifactEntry[]) => { entries[2] = { ...entries[2]!, bytes: encoder.encode('0'.repeat(64)) }; }, 'checksum_invalid'],
		] as const) {
			const harness = createHarness();
			mutate(harness.entries);
			const error = captureAdapterError(() => harness.adapter().spawn({
				stdout: () => undefined, exited: () => undefined,
			}));
			expect(error.diagnostic.code, name).toBe(code);
			expect(harness.events, name).not.toContain('spawnIntegrityChecked');
		}
	});

	it('defers one bounded premature discovery chunk and transfers its bytes', () => {
		const source = new Uint8Array(516).fill(7);
		const harness = createHarness({ premature: [['stdout', source]] });
		const delivered: Uint8Array[] = [];
		harness.adapter().spawn({ stdout: (chunk) => delivered.push(chunk), exited: () => undefined });
		source.fill(9);
		expect(delivered).toEqual([]);
		harness.runDeferred();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.byteLength).toBe(516);
		expect(delivered[0]?.[0]).toBe(7);
	});

	it('fails closed for sync or microtask overflow, a second event, or exit before delivery opens', async () => {
		for (const [name, premature] of [
			['overflow', [['stdout', new Uint8Array(517)]]],
			['second', [['stdout', new Uint8Array([1])], ['stdout', new Uint8Array([2])]]],
			['exit', [['exit']]],
		] as const) {
			const harness = createHarness({ premature });
			const error = captureAdapterError(() => harness.adapter().spawn({
				stdout: () => undefined, exited: () => undefined,
			}));
			expect(error.diagnostic.code, name).toBe('spawn_failed');
			expect(harness.stopCount, name).toBe(1);
			expect(harness.deferred, name).toHaveLength(0);
		}

		for (const [name, premature] of [
			['microtask-overflow', [['stdout', new Uint8Array(517)]]],
			['microtask-second', [['stdout', new Uint8Array([1])], ['stdout', new Uint8Array([2])]]],
			['microtask-exit', [['exit']]],
		] as const) {
			const harness = createHarness({ premature, microtaskPremature: true, microtaskDefer: true });
			let exited = 0;
			const delivered: Uint8Array[] = [];
			harness.adapter().spawn({
				stdout: (chunk) => delivered.push(chunk),
				exited: () => { exited += 1; },
			});
			await Promise.resolve();
			expect(harness.stopCount, name).toBe(1);
			expect(harness.diagnostics, name).toEqual(['spawn_failed']);
			expect(delivered, name).toEqual([]);
			expect(exited, name).toBe(1);
			expect(JSON.stringify(harness.diagnostics), name).not.toMatch(/(?:path|pid|token|nonce|frame)/iu);
			harness.hostCallbacks?.exited();
			expect(exited, name).toBe(1);
		}
	});

	it('drains stderr, forwards post-return output and makes stop idempotent', () => {
		const harness = createHarness();
		const delivered: number[] = [];
		const handle = harness.adapter().spawn({
			stdout: (chunk) => delivered.push(chunk[0] ?? -1),
			exited: () => delivered.push(99),
		});
		harness.runDeferred();
		harness.hostCallbacks?.stderr(encoder.encode('path PID token'));
		harness.hostCallbacks?.stdout(new Uint8Array([8]));
		handle.writeStdin(new Uint8Array([3]));
		handle.stop();
		handle.stop();
		handle.writeStdin(new Uint8Array([4]));
		harness.hostCallbacks?.exited();
		expect(delivered).toEqual([8]);
		expect(harness.stdin).toEqual([[3]]);
		expect(harness.stopCount).toBe(1);
	});

	it('closes the capability if spawning or deferred delivery setup throws', () => {
		for (const options of [
			{ spawnError: new Error('raw helper path') },
			{ deferError: new Error('raw scheduler PID') },
			{ inlineDefer: true },
		]) {
			const harness = createHarness(options);
			const error = captureAdapterError(() => harness.adapter().spawn({
				stdout: () => undefined, exited: () => undefined,
			}));
			expect(error.diagnostic).toMatchObject({
				code: 'spawn_failed', artifactIntegrity: 'integrity_checked', artifactTrust: 'unsigned_qa_only',
			});
			expect(`${error.message} ${JSON.stringify(error.diagnostic)}`).not.toMatch(/(?:path|PID)/u);
			if (options.deferError !== undefined || options.inlineDefer === true) {
				expect(harness.stopCount).toBe(1);
			}
		}
	});
});

type PrematureEvent = readonly ['stdout', Uint8Array] | readonly ['exit'];

interface HarnessOptions {
	readonly premature?: readonly PrematureEvent[];
	readonly spawnError?: Error;
	readonly deferError?: Error;
	readonly inlineDefer?: boolean;
	readonly microtaskPremature?: boolean;
	readonly microtaskDefer?: boolean;
}

interface Harness {
	readonly entries: MumbleV2ArtifactEntry[];
	readonly events: string[];
	readonly plans: MumbleV2LaunchPlan[];
	readonly capabilities: MumbleV2IntegrityCheckedArtifactCapability[];
	readonly diagnostics: string[];
	readonly deferred: Array<() => void>;
	readonly stdin: number[][];
	readonly stopCount: number;
	readonly hostCallbacks?: MumbleV2HostProcessCallbacks;
	adapter(): MumbleV2ProcessAdapter;
	runDeferred(): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const executable = new Uint8Array([77, 90, 1]);
	const fixture = createCanonicalMumbleHelperPackage(
		executable,
		encoder.encode('license fixture\n'),
		encoder.encode('third party fixture\n'),
	);
	const entries = canonicalMumbleHelperEntries(fixture);
	const events: string[] = [];
	const plans: MumbleV2LaunchPlan[] = [];
	const capabilities: MumbleV2IntegrityCheckedArtifactCapability[] = [];
	const diagnostics: string[] = [];
	const deferred: Array<() => void> = [];
	const stdin: number[][] = [];
	let stopCount = 0;
	let hostCallbacks: MumbleV2HostProcessCallbacks | undefined;
	return {
		entries,
		events,
		plans,
		capabilities,
		diagnostics,
		deferred,
		stdin,
		get stopCount() { return stopCount; },
		get hostCallbacks() { return hostCallbacks; },
		adapter: () => new MumbleV2ProcessAdapter(CONFIG, {
			artifacts: {
				openPackage: () => {
					events.push('open');
					return { entries, opaqueAuthority: { snapshot: [...executable] } };
				},
				sha256: (bytes) => {
					const name = bytes === entries[0]?.bytes ? 'exe'
						: bytes === entries[1]?.bytes ? 'manifest'
							: bytes === entries[3]?.bytes ? 'license' : 'third-party';
					events.push(`hash:${name}`);
					return sha256(bytes);
				},
			},
			process: {
				spawnIntegrityChecked: (plan, capability, callbacks) => {
					events.push('spawnIntegrityChecked');
					plans.push(plan);
					capabilities.push(capability);
					hostCallbacks = callbacks;
					if (options.spawnError !== undefined) throw options.spawnError;
					const emitPremature = (): void => {
						for (const event of options.premature ?? []) {
							if (event[0] === 'stdout') callbacks.stdout(event[1]);
							else callbacks.exited();
						}
					};
					if (options.microtaskPremature === true) queueMicrotask(emitPremature);
					else emitPremature();
					return {
						writeStdin: (chunk) => stdin.push([...chunk]),
						stop: () => { stopCount += 1; },
					};
				},
			},
			defer: (callback) => {
				events.push('defer');
				if (options.deferError !== undefined) throw options.deferError;
				if (options.inlineDefer === true) {
					callback();
					return;
				}
				if (options.microtaskDefer === true) {
					queueMicrotask(callback);
					return;
				}
				deferred.push(callback);
			},
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
		}),
		runDeferred: () => {
			for (const callback of deferred.splice(0)) callback();
		},
	};
}

function captureAdapterError(callback: () => unknown): MumbleV2ProcessAdapterError {
	try {
		callback();
	} catch (error) {
		if (error instanceof MumbleV2ProcessAdapterError) return error;
		throw error;
	}
	throw new Error('Expected MumbleV2ProcessAdapterError');
}
