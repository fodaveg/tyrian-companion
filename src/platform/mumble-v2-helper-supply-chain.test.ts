import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const PACKAGE_REVIEWS = new Map<string, PackageReview>([
	['cfg-if@1.0.4', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'test'] }],
	['getrandom@0.3.4', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'test', 'bench', 'custom-build'] }],
	['libc@0.2.189', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'test', 'custom-build'] }],
	['r-efi@5.3.0', { license: 'MIT OR Apache-2.0 OR LGPL-2.1-or-later', targetKinds: ['lib', 'example'] }],
	['subtle@2.6.1', { license: 'BSD-3-Clause', targetKinds: ['lib', 'test'] }],
	['wasip2@1.0.4+wasi-0.2.12', { license: 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT', targetKinds: ['lib', 'example'] }],
	['windows-sys@0.59.0', { license: 'MIT OR Apache-2.0', targetKinds: ['lib'] }],
	['windows-targets@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib'] }],
	['windows_aarch64_gnullvm@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_aarch64_msvc@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_i686_gnu@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_i686_gnullvm@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_i686_msvc@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_x86_64_gnu@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_x86_64_gnullvm@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['windows_x86_64_msvc@0.52.6', { license: 'MIT OR Apache-2.0', targetKinds: ['lib', 'custom-build'] }],
	['wit-bindgen@0.57.1', { license: 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT', targetKinds: ['lib', 'custom-build'] }],
	['zeroize@1.9.0', { license: 'Apache-2.0 OR MIT', targetKinds: ['lib', 'test'] }],
]);

interface PackageReview { license: string | null; targetKinds: string[] }
interface LockedPackage { name: string; version: string; source: string | null; checksum: string | null }

describe('H8.5 helper supply chain and test-only staging', () => {
	it('closes direct dependencies, licenses, sources and executable build surfaces', () => {
		const manifest = readFileSync('native/mumble-helper/Cargo.toml', 'utf8');
		const lock = readFileSync('native/mumble-helper/Cargo.lock', 'utf8');
		expect(supplyChainFindings(manifest, lock, PACKAGE_REVIEWS)).toEqual([]);

		const first = PACKAGE_REVIEWS.keys().next().value;
		if (first === undefined) throw new Error('dependency review fixture missing');
		const unknownLicense = new Map(PACKAGE_REVIEWS);
		unknownLicense.set(first, { ...PACKAGE_REVIEWS.get(first)!, license: null });
		expect(supplyChainFindings(manifest, lock, unknownLicense)).toContain(`license:${first}`);

		const procMacro = new Map(PACKAGE_REVIEWS);
		procMacro.set(first, { ...PACKAGE_REVIEWS.get(first)!, targetKinds: ['lib', 'proc-macro'] });
		expect(supplyChainFindings(manifest, lock, procMacro)).toContain(`proc-macro:${first}`);
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

function supplyChainFindings(
	manifest: string,
	lock: string,
	reviews: ReadonlyMap<string, PackageReview>,
): string[] {
	const findings: string[] = [];
	const direct = new Map([...manifest.matchAll(/^([a-z][a-z0-9-]*)\s*=\s*(?:"(=[^"]+)"|\{\s*version\s*=\s*"(=[^"]+)"[^}]*\})/gmu)]
		.map((match) => [match[1]!, match[2] ?? match[3]!]));
	if (direct.size !== DIRECT.size) findings.push('direct-set');
	for (const [name, requirement] of DIRECT) if (direct.get(name) !== requirement) findings.push(`direct:${name}`);
	if (/^[a-z][a-z0-9-]*\s*=\s*\{[^}\n]*\b(?:git|path)\s*=/gmu.test(manifest)
		|| /^(?:build|proc-macro)\s*=/gmu.test(manifest)) findings.push('manifest-build-surface');
	if (!manifest.includes('windows-sys = { version = "=0.59.0", features = [\n\t"Win32_Foundation",\n\t"Win32_System_Memory",\n] }')) {
		findings.push('windows-features');
	}

	const packages = parseCargoLock(lock);
	const root = packages.find((entry) => entry.name === 'tyrian-mumble-helper');
	if (root?.version !== '0.1.0' || root.source !== null || root.checksum !== null) findings.push('lock-root');
	const registry = packages.filter((entry) => entry.name !== 'tyrian-mumble-helper');
	const actual = new Set(registry.map((entry) => `${entry.name}@${entry.version}`));
	if (actual.size !== reviews.size || [...actual].some((key) => !reviews.has(key))) findings.push('package-set');
	for (const dependency of registry) {
		const key = `${dependency.name}@${dependency.version}`;
		const review = reviews.get(key);
		if (review === undefined) {
			findings.push(`review:${key}`);
			continue;
		}
		if (!review.license) findings.push(`license:${key}`);
		if (review.targetKinds.includes('proc-macro')) findings.push(`proc-macro:${key}`);
		if (dependency.source !== 'registry+https://github.com/rust-lang/crates.io-index') findings.push(`source:${key}`);
		if (!/^[0-9a-f]{64}$/u.test(dependency.checksum ?? '')) findings.push(`checksum:${key}`);
	}
	return [...new Set(findings)].sort();
}

function parseCargoLock(source: string): LockedPackage[] {
	return source.split('[[package]]').slice(1).map((block) => ({
		name: /^name = "([^"]+)"$/mu.exec(block)?.[1] ?? '',
		version: /^version = "([^"]+)"$/mu.exec(block)?.[1] ?? '',
		source: /^source = "([^"]+)"$/mu.exec(block)?.[1] ?? null,
		checksum: /^checksum = "([^"]+)"$/mu.exec(block)?.[1] ?? null,
	}));
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
