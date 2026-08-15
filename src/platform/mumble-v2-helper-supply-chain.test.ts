import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const HELPER_FILES = [
	'tyrian-mumble-helper.exe',
	'helper-manifest.json',
	'SHA256SUMS',
	'LICENSE',
	'THIRD-PARTY-LICENSES.txt',
] as const;
const DIRECT = new Map([
	['getrandom', '=0.3.4'],
	['subtle', '=2.6.1'],
	['windows-sys', '=0.59.0'],
	['zeroize', '=1.9.0'],
]);
const REVIEWED_CUSTOM_BUILDS = new Set([
	'getrandom@0.3.4', 'libc@0.2.189', 'windows_aarch64_gnullvm@0.52.6',
	'windows_aarch64_msvc@0.52.6', 'windows_i686_gnu@0.52.6',
	'windows_i686_gnullvm@0.52.6', 'windows_i686_msvc@0.52.6',
	'windows_x86_64_gnu@0.52.6', 'windows_x86_64_gnullvm@0.52.6',
	'windows_x86_64_msvc@0.52.6', 'wit-bindgen@0.57.1',
]);

interface CargoTarget { kind?: string[] }
interface CargoDependency { name?: string; req?: string }
interface CargoPackage {
	name?: string;
	version?: string;
	license?: string | null;
	source?: string | null;
	dependencies?: CargoDependency[];
	targets?: CargoTarget[];
}
interface CargoMetadata { packages?: CargoPackage[] }

describe('H8.5 helper supply chain and test-only staging', () => {
	it('closes direct dependencies, licenses, sources and executable build surfaces', () => {
		const cargo = process.env.CARGO ?? 'cargo';
		const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--format-version', '1', '--locked'], {
			cwd: resolve('native/mumble-helper'), encoding: 'utf8',
		})) as CargoMetadata;
		expect(metadataFindings(metadata)).toEqual([]);

		const unknownLicense = structuredClone(metadata);
		const dependency = unknownLicense.packages?.find((entry) => entry.name !== 'tyrian-mumble-helper');
		if (dependency === undefined) throw new Error('dependency fixture missing');
		dependency.license = null;
		expect(metadataFindings(unknownLicense)).toContain(`license:${String(dependency.name)}`);

		const procMacro = structuredClone(metadata);
		const target = procMacro.packages?.find((entry) => entry.name !== 'tyrian-mumble-helper');
		if (target === undefined) throw new Error('target fixture missing');
		target.targets = [...(target.targets ?? []), { kind: ['proc-macro'] }];
		expect(metadataFindings(procMacro)).toContain(`proc-macro:${String(target.name)}`);
	});

	it('validates only the synthetic five-file unsigned stage and preserves the plugin ZIP census', () => {
		const directory = mkdtempSync(join(tmpdir(), 'tyrian-h8-helper-stage-'));
		try {
			const executable = Buffer.from('synthetic PE fixture only\n');
			const license = readFileSync('LICENSE');
			const thirdParty = Buffer.from('reviewed synthetic fixture\n');
			const helperManifest = Buffer.from(manifest(executable));
			writeFileSync(join(directory, 'tyrian-mumble-helper.exe'), executable);
			writeFileSync(join(directory, 'helper-manifest.json'), helperManifest);
			writeFileSync(join(directory, 'LICENSE'), license);
			writeFileSync(join(directory, 'THIRD-PARTY-LICENSES.txt'), thirdParty);
			writeFileSync(join(directory, 'SHA256SUMS'), checksumFile([
				['tyrian-mumble-helper.exe', executable],
				['helper-manifest.json', helperManifest],
				['LICENSE', license],
				['THIRD-PARTY-LICENSES.txt', thirdParty],
			]));
			expect(stageFindings(directory)).toEqual([]);

			writeFileSync(join(directory, 'helper.dll'), 'sabotage\n');
			expect(stageFindings(directory)).toContain('stage-file-set');
			rmSync(join(directory, 'helper.dll'));
			writeFileSync(join(directory, 'helper-manifest.json'), manifest(executable).replace('UNSIGNED-NOT-FOR-RELEASE', 'release'));
			expect(stageFindings(directory)).toContain('manifest-authority');

			for (const [name, sabotage] of [
				['missing', (source: string) => source.split('\n').filter((line) => !line.endsWith('  LICENSE')).join('\n')],
				['extra', (source: string) => `${source}${'1'.repeat(64)}  extra.txt\n`],
				['stale', (source: string) => source.replace(/^[0-9a-f]{64}/u, '0'.repeat(64))],
				['duplicate', (source: string) => `${source}${source.split('\n')[0]}\n`],
				['casing', (source: string) => source.replace('  LICENSE\n', '  license\n')],
				['path', (source: string) => source.replace('  LICENSE\n', '  ./LICENSE\n')],
			] as const) {
				writeFileSync(join(directory, 'helper-manifest.json'), helperManifest);
				const valid = checksumFile([
					['tyrian-mumble-helper.exe', executable],
					['helper-manifest.json', helperManifest],
					['LICENSE', license],
					['THIRD-PARTY-LICENSES.txt', thirdParty],
				]);
				writeFileSync(join(directory, 'SHA256SUMS'), sabotage(valid));
				expect(stageFindings(directory), name).toContain('checksums-value');
			}

			for (const [name, sabotage] of [
				['missing', (source: string) => source.replace(/^ {2}"version": "0\.1\.0",\n/mu, '')],
				['extra', (source: string) => source.replace('  "schemaVersion": 1,', '  "schemaVersion": 1,\n  "extra": true,')],
				['duplicate', (source: string) => source.replace('  "name": "tyrian-mumble-helper",', '  "name": "tyrian-mumble-helper",\n  "name": "tyrian-mumble-helper",')],
				['casing', (source: string) => source.replace('  "target":', '  "Target":')],
				['path', (source: string) => source.replace('"tyrian-mumble-helper.exe":', '"./tyrian-mumble-helper.exe":')],
			] as const) {
				writeFileSync(join(directory, 'helper-manifest.json'), sabotage(manifest(executable)));
				expect(stageFindings(directory), name).toContain('manifest-schema');
			}
			expect(readFileSync('scripts/release-package.mjs', 'utf8')).toContain(
				"'manifest.json',\n\t'main.js',\n\t'styles.css',",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function metadataFindings(metadata: CargoMetadata): string[] {
	const findings: string[] = [];
	const packages = metadata.packages ?? [];
	const root = packages.find((entry) => entry.name === 'tyrian-mumble-helper');
	if (root === undefined) return ['metadata-root'];
	const direct = new Map((root.dependencies ?? []).map((entry) => [entry.name, entry.req]));
	if (direct.size !== DIRECT.size) findings.push('direct-set');
	for (const [name, requirement] of DIRECT) if (direct.get(name) !== requirement) findings.push(`direct:${name}`);
	for (const dependency of packages.filter((entry) => entry !== root)) {
		const name = String(dependency.name);
		if (!dependency.license) findings.push(`license:${name}`);
		if (!dependency.source?.startsWith('registry+')) findings.push(`source:${name}`);
		for (const target of dependency.targets ?? []) {
			if (target.kind?.includes('proc-macro')) findings.push(`proc-macro:${name}`);
			if (target.kind?.includes('custom-build')
				&& !REVIEWED_CUSTOM_BUILDS.has(`${name}@${String(dependency.version)}`)) findings.push(`custom-build:${name}`);
		}
	}
	return [...new Set(findings)].sort();
}

function manifest(executable: Buffer): string {
	return `${JSON.stringify({ schemaVersion: 1, name: 'tyrian-mumble-helper', version: '0.1.0', target: 'x86_64-pc-windows-msvc', status: 'UNSIGNED-NOT-FOR-RELEASE', releaseAllowed: false, files: { 'tyrian-mumble-helper.exe': sha256(executable) } }, null, 2)}\n`;
}

function checksumFile(entries: ReadonlyArray<readonly [string, Uint8Array]>): string {
	return entries.map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join('');
}

function stageFindings(directory: string): string[] {
	const actual = readdirSync(directory).sort((left, right) => left.localeCompare(right));
	const findings: string[] = [];
	const expected = [...HELPER_FILES].sort((left, right) => left.localeCompare(right));
	if (JSON.stringify(actual) !== JSON.stringify(expected)) findings.push('stage-file-set');
	const executable = readFileSync(join(directory, 'tyrian-mumble-helper.exe'));
	const manifestSource = readFileSync(join(directory, 'helper-manifest.json'), 'utf8');
	let parsed: { status?: string; releaseAllowed?: boolean; files?: Record<string, string> } = {};
	try {
		parsed = JSON.parse(manifestSource) as typeof parsed;
	} catch {
		findings.push('manifest-json');
	}
	if (manifestSource !== manifest(executable)) findings.push('manifest-schema');
	if (parsed.status !== 'UNSIGNED-NOT-FOR-RELEASE' || parsed.releaseAllowed !== false) findings.push('manifest-authority');
	if (parsed.files?.['tyrian-mumble-helper.exe'] !== sha256(executable)) findings.push('manifest-hash');
	const expectedChecksums = checksumFile([
		['tyrian-mumble-helper.exe', executable],
		['helper-manifest.json', Buffer.from(manifestSource)],
		['LICENSE', readFileSync(join(directory, 'LICENSE'))],
		['THIRD-PARTY-LICENSES.txt', readFileSync(join(directory, 'THIRD-PARTY-LICENSES.txt'))],
	]);
	if (readFileSync(join(directory, 'SHA256SUMS'), 'utf8') !== expectedChecksums) {
		findings.push('checksums-value');
	}
	return findings.sort();
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}
