import {
	createMumbleV2LaunchDiagnostic,
	MUMBLE_V2_CROSSOVER_WINE,
	MUMBLE_V2_LAUNCH_ROUTES,
	MUMBLE_V2_PROTONTRICKS_LAUNCH,
	MUMBLE_V2_STEAM_APP_ID,
	parseMumbleV2LaunchConfig,
	type MumbleV2LaunchDiagnosticV1,
	type MumbleV2LaunchRouteV1,
} from './mumble-v2-launch-contract';

export const MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT = Object.freeze({
	kind: 'integrity_checked_helper',
}) as { readonly kind: 'integrity_checked_helper' };

export type MumbleV2LaunchExecutable =
	| { readonly kind: 'integrity_checked_helper' }
	| {
		readonly kind: 'fixed_launcher';
		readonly id: 'crossover_wine' | 'protontricks_launch';
		readonly absolute: typeof MUMBLE_V2_CROSSOVER_WINE | typeof MUMBLE_V2_PROTONTRICKS_LAUNCH;
	};

export type MumbleV2LaunchArgument = string | typeof MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT;

export interface MumbleV2LaunchPlan {
	version: 1;
	route: MumbleV2LaunchRouteV1;
	executable: MumbleV2LaunchExecutable;
	argv: readonly MumbleV2LaunchArgument[];
	environment: Readonly<Record<string, string>>;
	shell: false;
	stdio: readonly ['pipe', 'pipe', 'pipe'];
}

export interface MumbleV2LaunchPreparation {
	readonly packageLocation: string;
	readonly plan: MumbleV2LaunchPlan;
}

export type MumbleV2LaunchPlanResult =
	| { readonly ok: true; readonly preparation: MumbleV2LaunchPreparation }
	| { readonly ok: false; readonly diagnostic: MumbleV2LaunchDiagnosticV1 };

export function buildMumbleV2LaunchPlan(value: unknown): MumbleV2LaunchPlanResult {
	const parsed = parseMumbleV2LaunchConfig(value);
	if (!parsed.ok) return parsed;
	const config = parsed.config;
	const windows = config.platform === 'windows_native';
	if (!(windows
		? isWindowsPackageDirectory(config.helperPackageDirectory)
		: isPosixPackageDirectory(config.helperPackageDirectory))) return invalidPath();

	if (config.platform === 'windows_native') {
		return planned(config.helperPackageDirectory, fixedPlan(
			MUMBLE_V2_LAUNCH_ROUTES.windows_native,
			MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT,
			[],
			{},
		));
	}
	if (config.platform === 'macos_crossover') {
		if (!isBottleName(config.bottleName)) return invalidPath();
		return planned(config.helperPackageDirectory, fixedPlan(
			MUMBLE_V2_LAUNCH_ROUTES.macos_crossover,
			{
				kind: 'fixed_launcher',
				id: 'crossover_wine',
				absolute: MUMBLE_V2_CROSSOVER_WINE,
			},
			[
				'--bottle', config.bottleName, '--no-update', '--no-gui', '--wait', '--cx-app',
				MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT,
			],
			{},
		));
	}
	if (!isPosixAbsoluteDirectory(config.steamCompatDataDirectory)) return invalidPath();
	return planned(config.helperPackageDirectory, fixedPlan(
		MUMBLE_V2_LAUNCH_ROUTES.linux_steam_proton,
		{
			kind: 'fixed_launcher',
			id: 'protontricks_launch',
			absolute: MUMBLE_V2_PROTONTRICKS_LAUNCH,
		},
		['--appid', String(MUMBLE_V2_STEAM_APP_ID), MUMBLE_V2_INTEGRITY_CHECKED_HELPER_ARGUMENT],
		{ STEAM_COMPAT_DATA_PATH: config.steamCompatDataDirectory },
	));
}

function planned(packageLocation: string, plan: MumbleV2LaunchPlan): MumbleV2LaunchPlanResult {
	return { ok: true, preparation: { packageLocation, plan } };
}

function fixedPlan(
	route: MumbleV2LaunchRouteV1,
	executable: MumbleV2LaunchExecutable,
	argv: readonly MumbleV2LaunchArgument[],
	environment: Readonly<Record<string, string>>,
): MumbleV2LaunchPlan {
	return {
		version: 1,
		route,
		executable,
		argv,
		environment,
		shell: false,
		stdio: ['pipe', 'pipe', 'pipe'],
	};
}

function invalidPath(): MumbleV2LaunchPlanResult {
	return { ok: false, diagnostic: createMumbleV2LaunchDiagnostic('invalid_path') };
}

function isWindowsPackageDirectory(value: string): boolean {
	return isWindowsAbsoluteDirectory(value) && !hasTemporarySegment(value.split('\\'));
}

function isPosixPackageDirectory(value: string): boolean {
	return isPosixAbsoluteDirectory(value) && !hasTemporarySegment(value.split('/'));
}

function isWindowsAbsoluteDirectory(value: string): boolean {
	if (!canonicalText(value) || !/^[A-Z]:\\/u.test(value) || value.includes('/') || value.endsWith('\\')) {
		return false;
	}
	const segments = value.slice(3).split('\\');
	return segments.length > 0 && segments.every((segment) => validSegment(segment, /[<>:"|?*]/u));
}

function isPosixAbsoluteDirectory(value: string): boolean {
	if (!canonicalText(value) || !value.startsWith('/') || value === '/' || value.includes('\\')
		|| value.includes('//') || value.endsWith('/')) return false;
	return value.slice(1).split('/').every((segment) => validSegment(segment, /$^/u));
}

function canonicalText(value: string): boolean {
	return value.length > 0 && value.length <= 1_024 && value === value.normalize('NFC')
		&& [...value].every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 31 && codePoint !== 127;
		});
}

function validSegment(segment: string, forbidden: RegExp): boolean {
	return segment.length > 0 && segment.length <= 255 && segment !== '.' && segment !== '..'
		&& !forbidden.test(segment) && !/[. ]$/u.test(segment);
}

function hasTemporarySegment(segments: readonly string[]): boolean {
	return segments.some((segment) => /^(?:tmp|temp)$/iu.test(segment));
}

function isBottleName(value: string): boolean {
	return value.length > 0 && value.length <= 64 && value === value.normalize('NFC')
		&& value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u.test(value)
		&& value !== '.' && value !== '..';
}
