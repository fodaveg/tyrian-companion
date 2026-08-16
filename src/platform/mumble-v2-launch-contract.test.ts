import { describe, expect, it } from 'vitest';

import {
	createMumbleV2LaunchDiagnostic,
	isMumbleV2LaunchDiagnostic,
	MUMBLE_V2_ARTIFACT_INTEGRITY,
	MUMBLE_V2_ARTIFACT_TRUST,
	MUMBLE_V2_LAUNCH_PLATFORMS,
	MUMBLE_V2_LAUNCH_ROUTES,
	MUMBLE_V2_MAPPING_NAME,
	MUMBLE_V2_CROSSOVER_WINE,
	MUMBLE_V2_PROTONTRICKS_LAUNCH,
	MUMBLE_V2_STEAM_APP_ID,
	parseMumbleV2LaunchConfig,
} from './mumble-v2-launch-contract';

const WINDOWS_CONFIG = {
	version: 1,
	platform: 'windows_native',
	helperPackageDirectory: 'C:\\Tyrian\\MumbleHelper',
} as const;

describe('H8.7 closed launch contract', () => {
	it('pins the three routes, Steam AppID, mapping and unsigned integrity vocabulary', () => {
		expect(MUMBLE_V2_STEAM_APP_ID).toBe(1_284_210);
		expect(MUMBLE_V2_MAPPING_NAME).toBe('MumbleLink');
		expect(MUMBLE_V2_CROSSOVER_WINE).toBe('/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine');
		expect(MUMBLE_V2_PROTONTRICKS_LAUNCH).toBe('/usr/bin/protontricks-launch');
		expect(MUMBLE_V2_LAUNCH_PLATFORMS).toEqual([
			'windows_native', 'macos_crossover', 'linux_steam_proton',
		]);
		expect(MUMBLE_V2_LAUNCH_ROUTES).toEqual({
			windows_native: { version: 1, platform: 'windows_native', runtime: 'direct_windows_pe' },
			macos_crossover: { version: 1, platform: 'macos_crossover', runtime: 'crossover_bottle' },
			linux_steam_proton: { version: 1, platform: 'linux_steam_proton', runtime: 'steam_proton_prefix' },
		});
		expect([MUMBLE_V2_ARTIFACT_INTEGRITY, MUMBLE_V2_ARTIFACT_TRUST]).toEqual([
			'integrity_checked', 'unsigned_qa_only',
		]);
	});

	it('accepts only the exact platform-specific configuration schemas', () => {
		for (const config of [
			WINDOWS_CONFIG,
			{
				version: 1,
				platform: 'macos_crossover',
				helperPackageDirectory: '/Applications/Tyrian/MumbleHelper',
				bottleName: 'Guild Wars 2',
			},
			{
				version: 1,
				platform: 'linux_steam_proton',
				helperPackageDirectory: '/opt/tyrian/mumble-helper',
				steamCompatDataDirectory: '/home/test/.steam/steam/steamapps/compatdata/1284210',
			},
		] as const) {
			expect(parseMumbleV2LaunchConfig(config)).toEqual({ ok: true, config });
		}
	});

	it('rejects every configurable command, mapping, argument or environment surface', () => {
		for (const field of ['args', 'env', 'shell', 'command', 'mapping'] as const) {
			expect(parseMumbleV2LaunchConfig({ ...WINDOWS_CONFIG, [field]: field === 'shell' ? false : [] }), field)
				.toEqual({ ok: false, diagnostic: createMumbleV2LaunchDiagnostic('invalid_config') });
		}
	});

	it('keeps diagnostics exact, unsigned and free of raw execution details', () => {
		const diagnostic = createMumbleV2LaunchDiagnostic('artifact_hash_mismatch');
		expect(diagnostic).toEqual({
			version: 1,
			stage: 'artifact',
			code: 'artifact_hash_mismatch',
			retryable: false,
			artifactIntegrity: 'integrity_check_failed',
			artifactTrust: 'unsigned_qa_only',
		});
		expect(isMumbleV2LaunchDiagnostic(diagnostic)).toBe(true);
		for (const field of [
			'token', 'nonce', 'frame', 'identity', 'pid', 'processId', 'exitCode', 'path',
			'bottle', 'os', 'platformRaw',
		]) {
			expect(isMumbleV2LaunchDiagnostic({ ...diagnostic, [field]: 'secret' }), field).toBe(false);
		}
		expect(JSON.stringify(diagnostic)).not.toMatch(/(?:trusted|verified|token|nonce|pid|path|bottle|exit)/iu);
	});
});
