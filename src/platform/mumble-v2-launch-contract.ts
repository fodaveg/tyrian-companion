/** Closed H8.7 launch boundary. It contains no host I/O or configurable command surface. */
export const MUMBLE_V2_LAUNCH_CONTRACT_VERSION = 1 as const;
export const MUMBLE_V2_STEAM_APP_ID = 1_284_210 as const;
export const MUMBLE_V2_MAPPING_NAME = 'MumbleLink' as const;
export const MUMBLE_V2_HELPER_EXECUTABLE = 'tyrian-mumble-helper.exe' as const;
export const MUMBLE_V2_HELPER_MANIFEST = 'helper-manifest.json' as const;
export const MUMBLE_V2_HELPER_CHECKSUMS = 'SHA256SUMS' as const;
export const MUMBLE_V2_HELPER_LICENSE = 'LICENSE' as const;
export const MUMBLE_V2_HELPER_THIRD_PARTY_LICENSES = 'THIRD-PARTY-LICENSES.txt' as const;
export const MUMBLE_V2_HELPER_PACKAGE_FILES = [
	MUMBLE_V2_HELPER_EXECUTABLE,
	MUMBLE_V2_HELPER_MANIFEST,
	MUMBLE_V2_HELPER_CHECKSUMS,
	MUMBLE_V2_HELPER_LICENSE,
	MUMBLE_V2_HELPER_THIRD_PARTY_LICENSES,
] as const;
export const MUMBLE_V2_HELPER_NAME = 'tyrian-mumble-helper' as const;
export const MUMBLE_V2_HELPER_TARGET = 'x86_64-pc-windows-msvc' as const;
export const MUMBLE_V2_HELPER_VERSION = '0.1.0' as const;
export const MUMBLE_V2_HELPER_STATUS = 'UNSIGNED-NOT-FOR-RELEASE' as const;
export const MUMBLE_V2_HELPER_RELEASE_ALLOWED = false as const;
export const MUMBLE_V2_CROSSOVER_WINE = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine' as const;
export const MUMBLE_V2_PROTONTRICKS_LAUNCH = '/usr/bin/protontricks-launch' as const;
export const MUMBLE_V2_ARTIFACT_INTEGRITY = 'integrity_checked' as const;
export const MUMBLE_V2_ARTIFACT_TRUST = 'unsigned_qa_only' as const;
export const MUMBLE_V2_ARTIFACT_INTEGRITY_STATES = [
	'not_checked', 'integrity_check_failed', MUMBLE_V2_ARTIFACT_INTEGRITY,
] as const;
export type MumbleV2ArtifactIntegrityState = typeof MUMBLE_V2_ARTIFACT_INTEGRITY_STATES[number];

export const MUMBLE_V2_LAUNCH_PLATFORMS = [
	'windows_native',
	'macos_crossover',
	'linux_steam_proton',
] as const;

export type MumbleV2LaunchPlatform = typeof MUMBLE_V2_LAUNCH_PLATFORMS[number];

export interface MumbleV2WindowsLaunchConfigV1 {
	version: 1;
	platform: 'windows_native';
	helperPackageDirectory: string;
}

export interface MumbleV2MacosCrossOverLaunchConfigV1 {
	version: 1;
	platform: 'macos_crossover';
	helperPackageDirectory: string;
	bottleName: string;
}

export interface MumbleV2LinuxSteamProtonLaunchConfigV1 {
	version: 1;
	platform: 'linux_steam_proton';
	helperPackageDirectory: string;
	steamCompatDataDirectory: string;
}

export type MumbleV2LaunchConfigV1 =
	| MumbleV2WindowsLaunchConfigV1
	| MumbleV2MacosCrossOverLaunchConfigV1
	| MumbleV2LinuxSteamProtonLaunchConfigV1;

export interface MumbleV2WindowsLaunchRouteV1 {
	version: 1;
	platform: 'windows_native';
	runtime: 'direct_windows_pe';
}

export interface MumbleV2MacosCrossOverLaunchRouteV1 {
	version: 1;
	platform: 'macos_crossover';
	runtime: 'crossover_bottle';
}

export interface MumbleV2LinuxSteamProtonLaunchRouteV1 {
	version: 1;
	platform: 'linux_steam_proton';
	runtime: 'steam_proton_prefix';
}

export type MumbleV2LaunchRouteV1 =
	| MumbleV2WindowsLaunchRouteV1
	| MumbleV2MacosCrossOverLaunchRouteV1
	| MumbleV2LinuxSteamProtonLaunchRouteV1;

export const MUMBLE_V2_LAUNCH_ROUTES: Readonly<Record<MumbleV2LaunchPlatform, MumbleV2LaunchRouteV1>> = {
	windows_native: { version: 1, platform: 'windows_native', runtime: 'direct_windows_pe' },
	macos_crossover: { version: 1, platform: 'macos_crossover', runtime: 'crossover_bottle' },
	linux_steam_proton: { version: 1, platform: 'linux_steam_proton', runtime: 'steam_proton_prefix' },
};

export const MUMBLE_V2_LAUNCH_DIAGNOSTIC_CODES = [
	'invalid_config',
	'invalid_path',
	'artifact_unavailable',
	'manifest_invalid',
	'checksum_invalid',
	'artifact_hash_mismatch',
	'spawn_failed',
] as const;

export type MumbleV2LaunchDiagnosticCode = typeof MUMBLE_V2_LAUNCH_DIAGNOSTIC_CODES[number];
export type MumbleV2LaunchDiagnosticStage = 'config' | 'artifact' | 'spawn';

export interface MumbleV2LaunchDiagnosticV1 {
	version: 1;
	stage: MumbleV2LaunchDiagnosticStage;
	code: MumbleV2LaunchDiagnosticCode;
	retryable: boolean;
	artifactIntegrity: MumbleV2ArtifactIntegrityState;
	artifactTrust: typeof MUMBLE_V2_ARTIFACT_TRUST;
}

export interface MumbleV2ArtifactAssessmentV1 {
	integrity: typeof MUMBLE_V2_ARTIFACT_INTEGRITY;
	trust: typeof MUMBLE_V2_ARTIFACT_TRUST;
}

const DIAGNOSTIC_CONTRACT: Readonly<Record<MumbleV2LaunchDiagnosticCode, {
	readonly stage: MumbleV2LaunchDiagnosticStage;
	readonly retryable: boolean;
	readonly artifactIntegrity: MumbleV2ArtifactIntegrityState;
}>> = {
	invalid_config: { stage: 'config', retryable: false, artifactIntegrity: 'not_checked' },
	invalid_path: { stage: 'config', retryable: false, artifactIntegrity: 'not_checked' },
	artifact_unavailable: { stage: 'artifact', retryable: true, artifactIntegrity: 'integrity_check_failed' },
	manifest_invalid: { stage: 'artifact', retryable: false, artifactIntegrity: 'integrity_check_failed' },
	checksum_invalid: { stage: 'artifact', retryable: false, artifactIntegrity: 'integrity_check_failed' },
	artifact_hash_mismatch: { stage: 'artifact', retryable: false, artifactIntegrity: 'integrity_check_failed' },
	spawn_failed: { stage: 'spawn', retryable: true, artifactIntegrity: MUMBLE_V2_ARTIFACT_INTEGRITY },
};

export type MumbleV2LaunchConfigResult =
	| { readonly ok: true; readonly config: MumbleV2LaunchConfigV1 }
	| { readonly ok: false; readonly diagnostic: MumbleV2LaunchDiagnosticV1 };

export function parseMumbleV2LaunchConfig(value: unknown): MumbleV2LaunchConfigResult {
	if (!isRecord(value) || value.version !== 1 || typeof value.platform !== 'string') {
		return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('invalid_config') };
	}
	if (value.platform === 'windows_native'
		&& hasExactKeys(value, ['version', 'platform', 'helperPackageDirectory'])
		&& typeof value.helperPackageDirectory === 'string') {
		return { ok: true, config: { version: 1, platform: value.platform, helperPackageDirectory: value.helperPackageDirectory } };
	}
	if (value.platform === 'macos_crossover'
		&& hasExactKeys(value, [
			'version', 'platform', 'helperPackageDirectory', 'bottleName',
		])
		&& typeof value.helperPackageDirectory === 'string'
		&& typeof value.bottleName === 'string') {
		return {
			ok: true,
			config: {
				version: 1,
				platform: value.platform,
				helperPackageDirectory: value.helperPackageDirectory,
				bottleName: value.bottleName,
			},
		};
	}
	if (value.platform === 'linux_steam_proton'
		&& hasExactKeys(value, [
			'version', 'platform', 'helperPackageDirectory', 'steamCompatDataDirectory',
		])
		&& typeof value.helperPackageDirectory === 'string'
		&& typeof value.steamCompatDataDirectory === 'string') {
		return {
			ok: true,
			config: {
				version: 1,
				platform: value.platform,
				helperPackageDirectory: value.helperPackageDirectory,
				steamCompatDataDirectory: value.steamCompatDataDirectory,
			},
		};
	}
	return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('invalid_config') };
}

export function createMumbleV2LaunchDiagnostic(
	code: MumbleV2LaunchDiagnosticCode,
): MumbleV2LaunchDiagnosticV1 {
	const contract = DIAGNOSTIC_CONTRACT[code];
	return {
		version: 1,
		stage: contract.stage,
		code,
		retryable: contract.retryable,
		artifactIntegrity: contract.artifactIntegrity,
		artifactTrust: MUMBLE_V2_ARTIFACT_TRUST,
	};
}

export function isMumbleV2LaunchDiagnostic(value: unknown): value is MumbleV2LaunchDiagnosticV1 {
	if (!isRecord(value) || !hasExactKeys(value, [
		'version', 'stage', 'code', 'retryable', 'artifactIntegrity', 'artifactTrust',
	])
		|| value.version !== 1 || typeof value.code !== 'string'
		|| value.artifactTrust !== MUMBLE_V2_ARTIFACT_TRUST
		|| !MUMBLE_V2_LAUNCH_DIAGNOSTIC_CODES.includes(value.code as MumbleV2LaunchDiagnosticCode)) {
		return false;
	}
	const expected = DIAGNOSTIC_CONTRACT[value.code as MumbleV2LaunchDiagnosticCode];
	return value.stage === expected.stage && value.retryable === expected.retryable
		&& value.artifactIntegrity === expected.artifactIntegrity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const reviewed = [...expected].sort();
	return actual.length === reviewed.length
		&& actual.every((key, index) => key === reviewed[index]);
}
