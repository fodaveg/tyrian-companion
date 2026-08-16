import { createHash } from 'node:crypto';

export const CANONICAL_MUMBLE_HELPER_FILES = [
	'tyrian-mumble-helper.exe',
	'helper-manifest.json',
	'SHA256SUMS',
	'LICENSE',
	'THIRD-PARTY-LICENSES.txt',
] as const;

export interface CanonicalMumbleHelperPackage {
	readonly executable: Uint8Array;
	readonly manifest: Uint8Array;
	readonly checksums: Uint8Array;
	readonly license: Uint8Array;
	readonly thirdPartyLicenses: Uint8Array;
}

export function createCanonicalMumbleHelperPackage(
	executable: Uint8Array,
	license: Uint8Array,
	thirdPartyLicenses: Uint8Array,
): CanonicalMumbleHelperPackage {
	const manifest = canonicalMumbleHelperManifest(executable);
	const checksums = encode([
		checksumLine('tyrian-mumble-helper.exe', executable),
		checksumLine('helper-manifest.json', manifest),
		checksumLine('LICENSE', license),
		checksumLine('THIRD-PARTY-LICENSES.txt', thirdPartyLicenses),
	].join(''));
	return { executable, manifest, checksums, license, thirdPartyLicenses };
}

export function canonicalMumbleHelperManifest(executable: Uint8Array): Uint8Array {
	return encode(`${JSON.stringify({
		schemaVersion: 1,
		name: 'tyrian-mumble-helper',
		version: '0.1.0',
		target: 'x86_64-pc-windows-msvc',
		status: 'UNSIGNED-NOT-FOR-RELEASE',
		releaseAllowed: false,
		files: { 'tyrian-mumble-helper.exe': sha256(executable) },
	}, null, 2)}\n`);
}

export function canonicalMumbleHelperEntries(
	fixture: CanonicalMumbleHelperPackage,
): Array<{ readonly name: string; readonly bytes: Uint8Array }> {
	return [
		{ name: 'tyrian-mumble-helper.exe', bytes: fixture.executable },
		{ name: 'helper-manifest.json', bytes: fixture.manifest },
		{ name: 'SHA256SUMS', bytes: fixture.checksums },
		{ name: 'LICENSE', bytes: fixture.license },
		{ name: 'THIRD-PARTY-LICENSES.txt', bytes: fixture.thirdPartyLicenses },
	];
}

export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function checksumLine(name: string, bytes: Uint8Array): string {
	return `${sha256(bytes)}  ${name}\n`;
}

function encode(source: string): Uint8Array {
	return new TextEncoder().encode(source);
}
