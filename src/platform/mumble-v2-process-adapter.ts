import type {
	MumbleV2ProcessCallbacks,
	MumbleV2ProcessHandle,
	MumbleV2ProcessPort,
} from './mumble-v2-client';
import {
	createMumbleV2LaunchDiagnostic,
	MUMBLE_V2_ARTIFACT_INTEGRITY,
	MUMBLE_V2_ARTIFACT_TRUST,
	MUMBLE_V2_HELPER_EXECUTABLE,
	MUMBLE_V2_HELPER_LICENSE,
	MUMBLE_V2_HELPER_MANIFEST,
	MUMBLE_V2_HELPER_NAME,
	MUMBLE_V2_HELPER_PACKAGE_FILES,
	MUMBLE_V2_HELPER_RELEASE_ALLOWED,
	MUMBLE_V2_HELPER_STATUS,
	MUMBLE_V2_HELPER_TARGET,
	MUMBLE_V2_HELPER_THIRD_PARTY_LICENSES,
	MUMBLE_V2_HELPER_VERSION,
	type MumbleV2ArtifactAssessmentV1,
	type MumbleV2LaunchDiagnosticV1,
} from './mumble-v2-launch-contract';
import {
	buildMumbleV2LaunchPlan,
	type MumbleV2LaunchPlan,
} from './mumble-v2-launch-plan';

const MAXIMUM_PREMATURE_STDOUT_BYTES = 516;

export interface MumbleV2ArtifactEntry {
	readonly name: string;
	readonly bytes: Uint8Array;
}

export interface MumbleV2OpenedArtifactPackage {
	readonly entries: readonly MumbleV2ArtifactEntry[];
	/** Host-owned open handle or private immutable copy bound to exactly these entry bytes. */
	readonly opaqueAuthority: unknown;
}

export interface MumbleV2ArtifactPort {
	openPackage(location: string): MumbleV2OpenedArtifactPackage;
	sha256(bytes: Uint8Array): string;
}

export interface MumbleV2HostProcessCallbacks {
	stdout(chunk: Uint8Array): void;
	stderr(chunk: Uint8Array): void;
	exited(): void;
}

export interface MumbleV2HostProcessHandle {
	writeStdin(chunk: Uint8Array): void;
	stop(): void;
}

export interface MumbleV2IntegrityCheckedArtifactCapability {
	readonly kind: 'integrity_checked_mumble_helper';
	readonly integrity: typeof MUMBLE_V2_ARTIFACT_INTEGRITY;
	readonly trust: typeof MUMBLE_V2_ARTIFACT_TRUST;
	readonly executableSha256: string;
	readonly manifestSha256: string;
	readonly opaqueAuthority: unknown;
}

export interface MumbleV2HostProcessPort {
	spawnIntegrityChecked(
		plan: Readonly<MumbleV2LaunchPlan>,
		capability: Readonly<MumbleV2IntegrityCheckedArtifactCapability>,
		callbacks: MumbleV2HostProcessCallbacks,
	): MumbleV2HostProcessHandle;
}

export interface MumbleV2ProcessAdapterPorts {
	artifacts: MumbleV2ArtifactPort;
	process: MumbleV2HostProcessPort;
	/** Must enqueue work for a later host turn; it must never invoke inline. */
	defer(callback: () => void): void;
	onDiagnostic?: (diagnostic: Readonly<MumbleV2LaunchDiagnosticV1>) => void;
}

export class MumbleV2ProcessAdapterError extends Error {
	constructor(readonly diagnostic: MumbleV2LaunchDiagnosticV1) {
		super(`Mumble v2 launch failed: ${diagnostic.code}`);
		this.name = 'MumbleV2ProcessAdapterError';
	}
}

/**
 * H8.7 validates the opened five-file snapshot, then delegates only an opaque
 * byte-bound capability. The process boundary never receives the package location.
 */
export class MumbleV2ProcessAdapter implements MumbleV2ProcessPort {
	constructor(
		private readonly config: unknown,
		private readonly ports: MumbleV2ProcessAdapterPorts,
	) {}

	spawn(callbacks: MumbleV2ProcessCallbacks): MumbleV2ProcessHandle {
		const planned = buildMumbleV2LaunchPlan(this.config);
		if (!planned.ok) return this.fail(planned.diagnostic);
		let opened: MumbleV2OpenedArtifactPackage;
		try {
			opened = this.ports.artifacts.openPackage(planned.preparation.packageLocation);
		} catch {
			return this.fail(createMumbleV2LaunchDiagnostic('artifact_unavailable'));
		}
		const artifactResult = validateArtifacts(opened.entries, this.ports.artifacts);
		if (!artifactResult.ok) return this.fail(artifactResult.diagnostic);
		const capability: MumbleV2IntegrityCheckedArtifactCapability = {
			kind: 'integrity_checked_mumble_helper',
			integrity: artifactResult.assessment.integrity,
			trust: artifactResult.assessment.trust,
			executableSha256: artifactResult.executableSha256,
			manifestSha256: artifactResult.manifestSha256,
			opaqueAuthority: opened.opaqueAuthority,
		};
		return this.spawnCapability(planned.preparation.plan, capability, callbacks);
	}

	private spawnCapability(
		plan: Readonly<MumbleV2LaunchPlan>,
		capability: Readonly<MumbleV2IntegrityCheckedArtifactCapability>,
		callbacks: MumbleV2ProcessCallbacks,
	): MumbleV2ProcessHandle {
		let spawnedHandle: MumbleV2HostProcessHandle | undefined;
		let stopped = false;
		let deliveryOpen = false;
		let prematureStdout: Uint8Array | undefined;
		let prematureEventCount = 0;
		let prematureFailure = false;
		let deferReturned = false;
		let deferInvokedInline = false;
		let hostStopCalled = false;
		const stopHostOnce = (): void => {
			if (hostStopCalled) return;
			hostStopCalled = true;
			try {
				spawnedHandle?.stop();
			} catch {
				// A broken host cleanup cannot widen the closed diagnostic surface.
			}
		};
		const closeAfterReturn = (): void => {
			if (stopped) return;
			stopped = true;
			stopHostOnce();
			this.notifyDiagnostic(createMumbleV2LaunchDiagnostic('spawn_failed'));
			try {
				callbacks.exited();
			} catch {
				// H8.6 owns lifecycle delivery; a callback throw cannot reopen the capability.
			}
		};
		try {
			const handle = this.ports.process.spawnIntegrityChecked(plan, capability, {
				stdout: (chunk) => {
					if (stopped) return;
					if (deliveryOpen) {
						callbacks.stdout(chunk);
						return;
					}
					prematureEventCount += 1;
					if (prematureEventCount !== 1 || chunk.byteLength > MAXIMUM_PREMATURE_STDOUT_BYTES) {
						prematureFailure = true;
						return;
					}
					prematureStdout = new Uint8Array(chunk);
				},
				stderr: () => {
					// The pipe is deliberately drained without exposing helper output.
				},
				exited: () => {
					if (stopped) return;
					if (!deliveryOpen) {
						prematureEventCount += 1;
						prematureFailure = true;
						return;
					}
					stopped = true;
					callbacks.exited();
				},
			});
			spawnedHandle = handle;
			if (prematureFailure) {
				stopped = true;
				stopHostOnce();
				return this.fail(createMumbleV2LaunchDiagnostic('spawn_failed'));
			}
			this.ports.defer(() => {
				if (!deferReturned) {
					deferInvokedInline = true;
					return;
				}
				if (stopped) return;
				if (prematureFailure) {
					closeAfterReturn();
					return;
				}
				deliveryOpen = true;
				if (prematureStdout !== undefined) callbacks.stdout(prematureStdout);
			});
			deferReturned = true;
			if (deferInvokedInline) {
				stopped = true;
				stopHostOnce();
				return this.fail(createMumbleV2LaunchDiagnostic('spawn_failed'));
			}
			return {
				writeStdin: (chunk) => {
					if (!stopped) handle.writeStdin(chunk);
				},
				stop: () => {
					if (stopped) return;
					stopped = true;
					stopHostOnce();
				},
			};
		} catch (error) {
			stopHostOnce();
			if (error instanceof MumbleV2ProcessAdapterError) throw error;
			return this.fail(createMumbleV2LaunchDiagnostic('spawn_failed'));
		}
	}

	private fail(diagnostic: MumbleV2LaunchDiagnosticV1): never {
		this.notifyDiagnostic(diagnostic);
		throw new MumbleV2ProcessAdapterError(diagnostic);
	}

	private notifyDiagnostic(diagnostic: MumbleV2LaunchDiagnosticV1): void {
		try {
			this.ports.onDiagnostic?.(diagnostic);
		} catch {
			// Diagnostic observers have no authority over the closed launch route.
		}
	}
}

interface MumbleV2HelperManifestV1 {
	schemaVersion: 1;
	name: typeof MUMBLE_V2_HELPER_NAME;
	version: typeof MUMBLE_V2_HELPER_VERSION;
	target: typeof MUMBLE_V2_HELPER_TARGET;
	status: typeof MUMBLE_V2_HELPER_STATUS;
	releaseAllowed: typeof MUMBLE_V2_HELPER_RELEASE_ALLOWED;
	files: { readonly [MUMBLE_V2_HELPER_EXECUTABLE]: string };
}

type MumbleV2ArtifactResult =
	| {
		readonly ok: true;
		readonly assessment: MumbleV2ArtifactAssessmentV1;
		readonly executableSha256: string;
		readonly manifestSha256: string;
	}
	| { readonly ok: false; readonly diagnostic: MumbleV2LaunchDiagnosticV1 };

function validateArtifacts(
	entries: readonly MumbleV2ArtifactEntry[],
	port: Pick<MumbleV2ArtifactPort, 'sha256'>,
): MumbleV2ArtifactResult {
	if (!sameList(entries.map((entry) => entry.name), MUMBLE_V2_HELPER_PACKAGE_FILES)) {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('manifest_invalid') };
	}
	const [executable, manifestEntry, checksumsEntry, license, thirdParty] = entries;
	if (executable === undefined || manifestEntry === undefined || checksumsEntry === undefined
		|| license === undefined || thirdParty === undefined
		|| license.bytes.byteLength === 0 || thirdParty.bytes.byteLength === 0) {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('manifest_invalid') };
	}
	const manifest = parseManifest(manifestEntry.bytes);
	if (manifest === null) {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('manifest_invalid') };
	}
	let executableHash: string;
	let manifestHash: string;
	let licenseHash: string;
	let thirdPartyHash: string;
	try {
		executableHash = port.sha256(executable.bytes);
		manifestHash = port.sha256(manifestEntry.bytes);
		licenseHash = port.sha256(license.bytes);
		thirdPartyHash = port.sha256(thirdParty.bytes);
	} catch {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('checksum_invalid') };
	}
	if (![executableHash, manifestHash, licenseHash, thirdPartyHash].every(validSha256)) {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('checksum_invalid') };
	}
	if (manifest.files[MUMBLE_V2_HELPER_EXECUTABLE] !== executableHash) {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('artifact_hash_mismatch') };
	}
	const expectedChecksums = `${executableHash}  ${MUMBLE_V2_HELPER_EXECUTABLE}\n`
		+ `${manifestHash}  ${MUMBLE_V2_HELPER_MANIFEST}\n`
		+ `${licenseHash}  ${MUMBLE_V2_HELPER_LICENSE}\n`
		+ `${thirdPartyHash}  ${MUMBLE_V2_HELPER_THIRD_PARTY_LICENSES}\n`;
	if (decodeText(checksumsEntry.bytes) !== expectedChecksums) {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('checksum_invalid') };
	}
	return {
		ok: true,
		assessment: { integrity: MUMBLE_V2_ARTIFACT_INTEGRITY, trust: MUMBLE_V2_ARTIFACT_TRUST },
		executableSha256: executableHash,
		manifestSha256: manifestHash,
	};
}

function parseManifest(bytes: Uint8Array): MumbleV2HelperManifestV1 | null {
	const source = decodeText(bytes);
	if (source === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(value) || !sameList(Object.keys(value), [
		'schemaVersion', 'name', 'version', 'target', 'status', 'releaseAllowed', 'files',
	]) || value.schemaVersion !== 1 || value.name !== MUMBLE_V2_HELPER_NAME
		|| value.version !== MUMBLE_V2_HELPER_VERSION || value.target !== MUMBLE_V2_HELPER_TARGET
		|| value.status !== MUMBLE_V2_HELPER_STATUS
		|| value.releaseAllowed !== MUMBLE_V2_HELPER_RELEASE_ALLOWED || !isRecord(value.files)
		|| !sameList(Object.keys(value.files), [MUMBLE_V2_HELPER_EXECUTABLE])
		|| typeof value.files[MUMBLE_V2_HELPER_EXECUTABLE] !== 'string'
		|| !validSha256(value.files[MUMBLE_V2_HELPER_EXECUTABLE])) return null;
	const manifest: MumbleV2HelperManifestV1 = {
		schemaVersion: 1,
		name: MUMBLE_V2_HELPER_NAME,
		version: MUMBLE_V2_HELPER_VERSION,
		target: MUMBLE_V2_HELPER_TARGET,
		status: MUMBLE_V2_HELPER_STATUS,
		releaseAllowed: MUMBLE_V2_HELPER_RELEASE_ALLOWED,
		files: { [MUMBLE_V2_HELPER_EXECUTABLE]: value.files[MUMBLE_V2_HELPER_EXECUTABLE] },
	};
	return source === `${JSON.stringify(manifest, null, 2)}\n` ? manifest : null;
}

function decodeText(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function validSha256(value: string): boolean {
	return /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
