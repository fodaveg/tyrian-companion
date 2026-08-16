import { describe, expect, it } from 'vitest';

import {
	buildMumbleV2LaunchPlan,
	MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT,
} from './mumble-v2-launch-plan';

describe('H8.7 closed launch plans', () => {
	it('builds the exact direct Windows capability route', () => {
		expect(buildMumbleV2LaunchPlan({
			version: 1,
			platform: 'windows_native',
			helperPackageDirectory: 'C:\\Tyrian\\MumbleHelper',
		})).toEqual({
			ok: true,
			preparation: {
				packageLocation: 'C:\\Tyrian\\MumbleHelper',
				plan: {
					version: 1,
					route: { version: 1, platform: 'windows_native', runtime: 'direct_windows_pe' },
					executable: MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT,
					argv: [],
					environment: {},
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe'],
				},
			},
		});
	});

	it('builds the exact fixed CrossOver wine route', () => {
		expect(buildMumbleV2LaunchPlan({
			version: 1,
			platform: 'macos_crossover',
			helperPackageDirectory: '/Applications/Tyrian/MumbleHelper',
			bottleName: 'Guild Wars 2',
		})).toEqual({
			ok: true,
			preparation: {
				packageLocation: '/Applications/Tyrian/MumbleHelper',
				plan: {
					version: 1,
					route: { version: 1, platform: 'macos_crossover', runtime: 'crossover_bottle' },
					executable: {
						kind: 'fixed_launcher',
						id: 'crossover_wine',
						absolute: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
					},
					argv: [
						'--bottle', 'Guild Wars 2', '--no-update', '--no-gui', '--wait', '--cx-app',
						MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT,
					],
					environment: {},
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe'],
				},
			},
		});
	});

	it('builds the exact protontricks route with explicit compat-data authority', () => {
		expect(buildMumbleV2LaunchPlan({
			version: 1,
			platform: 'linux_steam_proton',
			helperPackageDirectory: '/opt/tyrian/mumble-helper',
			steamCompatDataDirectory: '/home/test/.steam/steam/steamapps/compatdata/1284210',
		})).toEqual({
			ok: true,
			preparation: {
				packageLocation: '/opt/tyrian/mumble-helper',
				plan: {
					version: 1,
					route: { version: 1, platform: 'linux_steam_proton', runtime: 'steam_proton_prefix' },
					executable: {
						kind: 'fixed_launcher',
						id: 'protontricks_launch',
						absolute: '/usr/bin/protontricks-launch',
					},
					argv: ['--appid', '1284210', MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT],
					environment: {
						STEAM_COMPAT_DATA_PATH: '/home/test/.steam/steam/steamapps/compatdata/1284210',
					},
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe'],
				},
			},
		});
	});

	it('rejects relative, temporary, traversing, decomposed and control-bearing directories', () => {
		for (const helperPackageDirectory of [
			'relative/helper', '/tmp/helper', '/private/tmp/helper', '/opt//helper', '/opt/../helper',
			'/opt/helper/', '/opt/hel\\per', '/opt/helper\u0000', '/opt/tyria\u0301n/helper',
		]) {
			expect(buildMumbleV2LaunchPlan({
				version: 1,
				platform: 'linux_steam_proton',
				helperPackageDirectory,
				steamCompatDataDirectory: '/home/test/.steam/steam/steamapps/compatdata/1284210',
			}), helperPackageDirectory).toMatchObject({ ok: false, diagnostic: { code: 'invalid_path' } });
		}
		for (const helperPackageDirectory of [
			'c:\\Tyrian\\Helper', 'C:/Tyrian/Helper', '\\\\server\\share\\Helper',
			'C:\\Temp\\Helper', 'C:\\Tyrian\\..\\Helper', 'C:\\Tyrian\\Helper ',
		]) {
			expect(buildMumbleV2LaunchPlan({
				version: 1, platform: 'windows_native', helperPackageDirectory,
			}), helperPackageDirectory).toMatchObject({ ok: false, diagnostic: { code: 'invalid_path' } });
		}
	});

	it('rejects hostile bottle and compat-data values without accepting launcher overrides', () => {
		for (const bottleName of ['../Guild Wars 2', 'Guild/War', ' Guild Wars 2']) {
			expect(buildMumbleV2LaunchPlan({
				version: 1,
				platform: 'macos_crossover',
				helperPackageDirectory: '/Applications/Tyrian/MumbleHelper',
				bottleName,
			}), bottleName).toMatchObject({ ok: false, diagnostic: { code: 'invalid_path' } });
		}
		expect(buildMumbleV2LaunchPlan({
			version: 1,
			platform: 'linux_steam_proton',
			helperPackageDirectory: '/opt/tyrian/mumble-helper',
			steamCompatDataDirectory: '/tmp/compatdata',
			protontricksExecutable: '/tmp/protontricks-launch',
		})).toMatchObject({ ok: false, diagnostic: { code: 'invalid_config' } });
	});
});
