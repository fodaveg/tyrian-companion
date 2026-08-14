import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SPIKE_ROOT = 'spikes/h8-mumble-crossover';
const SPIKE_TEST_ENTRY = 'scripts/tests/probar-h8-crossover-spike.sh';
const EXPECTED_SPIKE_FILES = [
	'README.md',
	'mumble_probe_core.c',
	'mumble_probe_core.h',
	'mumble_probe_core_test.c',
	'mumble_probe_windows.c',
	'test-host.sh',
	'test-support/windows.h',
	'validate-preprocessed.mjs',
] as const;
const RUNTIME_FILES = [
	'mumble_probe_core.c',
	'mumble_probe_core.h',
	'mumble_probe_windows.c',
	'test-support/windows.h',
] as const;

const EXPECTED_CORE_INVOCATIONS = {
	candidates_equal: 2,
	is_hex_nonce: 2,
	is_little_endian: 2,
	read_aligned_word: 1,
	read_candidate: 3,
	reader: 4,
	snprintf: 1,
	strcmp: 2,
	strlen: 1,
	tc_mumble_activity: 1,
	tc_mumble_decode_view: 1,
	tc_mumble_decode_view_with_reader: 2,
	tc_mumble_render_frame: 1,
	tc_mumble_status_name: 1,
	validate_candidate: 2,
	word_at: 5,
	words_are_aligned: 2,
} as const;
const EXPECTED_WRAPPER_INVOCATIONS = {
	CloseHandle: 2,
	MapViewOfFile: 1,
	OpenFileMappingW: 1,
	Sleep: 1,
	UnmapViewOfFile: 1,
	fail: 6,
	fputc: 1,
	fwrite: 1,
	main: 1,
	strcmp: 1,
	tc_mumble_activity: 1,
	tc_mumble_decode_view: 2,
	tc_mumble_render_frame: 1,
} as const;
const EXPECTED_STUB_DECLARATIONS = {
	CloseHandle: 1,
	MapViewOfFile: 1,
	OpenFileMappingW: 1,
	Sleep: 1,
	UnmapViewOfFile: 1,
} as const;
const EXPECTED_GATE_ENTRY = `#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$repo_root/spikes/h8-mumble-crossover/test-host.sh"
`;
const EXPECTED_HOST_SCRIPT_SHA256 = '856b5c27d3d9ba0bcdbf4bd018162607a76369b030760a817a8ef19f91e3cfb2';
const EXPECTED_RUNTIME_HASHES = {
	'mumble_probe_core.h': '25ffa18b9267d9ddaf07ed15a15f19bf63dc08363de00cc6a313d414e129ea36',
	'mumble_probe_windows.c': 'e08d7e994d356639e12261373ead5e72f6395bc813b34e2e2ca8001c983137f2',
	'test-support/windows.h': 'c96eae41e0c4f2ea2bc37d4d720a4106dd452384c99f78f15c663157a8121900',
	'validate-preprocessed.mjs': '5e8355cd3ea323b6a57ac06919ac72140bcccc438e2314db2a84fed57e0d7602',
} as const;
const EXPECTED_WRAPPER_DIRECTIVES = [
	'#define WIN32_LEAN_AND_MEAN',
	'#include <windows.h>',
	'#include <stdint.h>',
	'#include <stdio.h>',
	'#include <string.h>',
	'#include "mumble_probe_core.h"',
] as const;

const PROHIBITED_RUNTIME = {
	writeMappingAccess: /\b(?:FILE_MAP_WRITE|FILE_MAP_ALL_ACCESS)\b|\b0x0*002u?\b/iu,
	processMemory: /\b(?:OpenProcess|ReadProcessMemory|WriteProcessMemory|VirtualAllocEx|CreateRemoteThread|CreateToolhelp32Snapshot|Process32(?:First|Next)[AW]?|Module32(?:First|Next)[AW]?|EnumProcesses|QueryFullProcessImageName[AW]?|NtQuerySystemInformation)\b/u,
	privateData: /\b(?:identity\w*|characterName\w*|avatar\w*|camera\w*|coordinate\w*|position\w*|processId\w*|pid\w*)\b/iu,
	network: /\b(?:socket|connect|listen|bind|WinHttp|WinInet|curl|fetch|WebSocket)\b/iu,
	persistence: /\b(?:CreateFile[AW]?|WriteFile|fopen|freopen|RegSetValue|sqlite|indexedDB|localStorage)\b/iu,
	logging: /\b(?:fprintf|printf|puts|stderr|OutputDebugString[AW]?|syslog|logger|console)\b/iu,
} as const;

describe('H8.2 isolated CrossOver spike boundary', () => {
	it('censuses every spike artifact and the exact gate entry', () => {
		expect(spikeFiles()).toEqual(EXPECTED_SPIKE_FILES);
		expect(readFileSync(SPIKE_TEST_ENTRY, 'utf8')).toBe(EXPECTED_GATE_ENTRY);
		expect(spikeViolations(spikeSources())).toEqual([]);
	});

	it('censuses all core/wrapper invocations and exact read-only mapping calls', () => {
		const sources = spikeSources();
		expect(invocationCensus(sources.get('mumble_probe_core.c') ?? '')).toEqual(
			EXPECTED_CORE_INVOCATIONS,
		);
		expect(invocationCensus(sources.get('mumble_probe_windows.c') ?? '')).toEqual(
			EXPECTED_WRAPPER_INVOCATIONS,
		);
		expect(invocationCensus(sources.get('test-support/windows.h') ?? '')).toEqual(
			EXPECTED_STUB_DECLARATIONS,
		);
	});

	it('pins the wrapper preprocessor to the exact define and includes', () => {
		const wrapper = spikeSources().get('mumble_probe_windows.c') ?? '';
		expect(preprocessorDirectives(wrapper)).toEqual(EXPECTED_WRAPPER_DIRECTIVES);
	});

	it('validates the compiler-expanded mapping contract', () => {
		expect(preprocessAndValidate(spikeSources())).toMatchObject({
			preprocessStatus: 0,
			validatorStatus: 0,
		});
	});

	it('keeps the product scanner allowlist closed to the declarative contract', () => {
		const scanner = readFileSync('scripts/security-scan.mjs', 'utf8');
		expect(scanner).toContain("'src/platform/mumble-v2-contract.ts'");
		expect(scanner).not.toMatch(/spikes\/h8|mumble_probe/iu);
	});

	it('turns red for duplicate mappings, write flags and alternate sinks', () => {
		const duplicate = spikeSources();
		duplicate.set('mumble_probe_windows.c', `${duplicate.get('mumble_probe_windows.c') ?? ''}
			OpenFileMappingW(FILE_MAP_READ, FALSE, MUMBLE_MAPPING_NAME);`);
		expect(spikeViolations(duplicate)).toEqual(expect.arrayContaining(['call-census', 'mapping-count']));

		for (const [pattern, replacement, decoy, expected] of [
			[
				'OpenFileMappingW(FILE_MAP_READ',
				'OpenFileMappingW(2u',
				'/* OpenFileMappingW(FILE_MAP_READ, FALSE, MUMBLE_MAPPING_NAME) */\n'
					+ 'const char *open_decoy = "OpenFileMappingW(FILE_MAP_READ, FALSE, MUMBLE_MAPPING_NAME)";',
				'open-readonly',
			],
			[
				'MapViewOfFile(\n\t\tmapping,\n\t\tFILE_MAP_READ',
				'MapViewOfFile(\n\t\tmapping,\n\t\t2u',
				'/* MapViewOfFile(mapping, FILE_MAP_READ, 0u, 0u, TC_MUMBLE_LINK_VIEW_BYTES) */\n'
					+ 'const char *map_decoy = "MapViewOfFile(mapping, FILE_MAP_READ, 0u, 0u, TC_MUMBLE_LINK_VIEW_BYTES)";',
				'map-readonly',
			],
		] as const) {
			const changed = spikeSources();
			changed.set('mumble_probe_windows.c', `${changed.get('mumble_probe_windows.c')?.replace(
				pattern, replacement,
			) ?? ''}\n${decoy}`);
			expect(spikeViolations(changed)).toEqual(expect.arrayContaining([
				expected, 'writeMappingAccess',
			]));
		}

		const redirected = spikeSources();
		redirected.set('mumble_probe_windows.c', `${redirected.get('mumble_probe_windows.c')?.replace(
			'fwrite(frame, 1u, frame_length, stdout)', 'fwrite(frame, 1u, frame_length, stderr)',
		) ?? ''}\n/* fwrite(frame, 1u, frame_length, stdout) */\n`
			+ 'const char *output_decoy = "fwrite(frame, 1u, frame_length, stdout)";');
		expect(spikeViolations(redirected)).toEqual(expect.arrayContaining(['logging', 'output-exact']));

		const newlineRedirected = spikeSources();
		newlineRedirected.set(
			'mumble_probe_windows.c',
			`${newlineRedirected.get('mumble_probe_windows.c')?.replace(
				"fputc('\\n', stdout)", "fputc('\\n', stderr)",
			) ?? ''}\n/* fputc('\\n', stdout) */`,
		);
		expect(spikeViolations(newlineRedirected)).toEqual(
			expect.arrayContaining(['logging', 'output-exact']),
		);
	});

	it('turns red if preprocessing aliases read access, mapping name or view size', () => {
		for (const sabotage of [
			'#undef FILE_MAP_READ\n#define FILE_MAP_READ 2u',
			'#undef FILE_MAP_READ\n#define FILE_MAP_READ (1u << 1)',
			'#undef MUMBLE_MAPPING_NAME\n#define MUMBLE_MAPPING_NAME L"OtherLink"',
			'#undef TC_MUMBLE_LINK_VIEW_BYTES\n#define TC_MUMBLE_LINK_VIEW_BYTES 4u',
			'#define TC_MAPPING_ACCESS_ALIAS (1u << 1)',
		] as const) {
			const changed = spikeSources();
			changed.set(
				'mumble_probe_windows.c',
				`${changed.get('mumble_probe_windows.c') ?? ''}\n${sabotage}\n`,
			);
			expect(spikeViolations(changed)).toContain('preprocessor');
		}
	});

	it('turns red on effective header, digraph and line-spliced redefinitions', () => {
		const sabotages = [
			{
				path: 'test-support/windows.h',
				mutate: (source: string) => `${source}\n#undef FILE_MAP_READ\n#define FILE_MAP_READ 2u\n`,
			},
			{
				path: 'mumble_probe_core.h',
				mutate: (source: string) => `${source}\n#undef TC_MUMBLE_LINK_VIEW_BYTES\n`
					+ '#define TC_MUMBLE_LINK_VIEW_BYTES 4u\n',
			},
			{
				path: 'mumble_probe_windows.c',
				mutate: (source: string) => source.replace(
					'#include "mumble_probe_core.h"',
					'#include "mumble_probe_core.h"\n%:undef FILE_MAP_READ\n'
						+ '%:define FILE_MAP_READ (1u << 1)',
				),
			},
			{
				path: 'mumble_probe_windows.c',
				mutate: (source: string) => source.replace(
					'#include "mumble_probe_core.h"',
					'#include "mumble_probe_core.h"\n#undef FILE_MAP_READ\n'
						+ '#define FILE_MAP_READ (1u \\\n<< 1)',
				),
			},
		] as const;
		for (const sabotage of sabotages) {
			const changed = spikeSources();
			changed.set(sabotage.path, sabotage.mutate(changed.get(sabotage.path) ?? ''));
			const result = preprocessAndValidate(changed);
			expect(result.preprocessStatus, result.stderr).toBe(0);
			expect(result.validatorStatus, result.stderr).toBe(1);
			expect(result.stderr).toMatch(/expanded (?:MapViewOfFile|OpenFileMappingW) arguments differ/u);
		}
	});

	it('turns red for process/toolhelp, private data, network, persistence, logs and extra calls', () => {
		for (const [expected, source] of [
			['processMemory', 'OpenProcess(0, 0, 0); ReadProcessMemory(0, 0, 0, 0, 0);'],
			['processMemory', 'WriteProcessMemory(0, 0, 0, 0, 0);'],
			['processMemory', 'CreateToolhelp32Snapshot(0, 0); Process32FirstW(0, 0);'],
			['privateData', 'const char *characterName = "forbidden";'],
			['privateData', 'float avatarPosition[3];'],
			['network', 'socket(0, 0, 0); connect(0, 0, 0);'],
			['persistence', 'CreateFileW(0, 0, 0, 0, 0, 0, 0);'],
			['logging', 'fprintf(stderr, "sample");'],
			['call-census', 'system("forbidden");'],
		] as const) {
			const changed = spikeSources();
			changed.set('mumble_probe_core.c', `${changed.get('mumble_probe_core.c') ?? ''}\n${source}`);
			expect(spikeViolations(changed)).toContain(expected);
		}
	});

	it('keeps every host command and write destination under an exact positive contract', () => {
		for (const source of [
			'\nopen -a CrossOver',
			'\n/bin/cp "$spike_dir/mumble_probe_core.c" "$test_dir/outside-census"',
			'\ncommand cp "$spike_dir/mumble_probe_core.c" "$test_dir/outside-census"',
			'\neval "printf forbidden"',
			'\nrsync -a "$spike_dir/" "$test_dir/rsync"',
			'\ninstall "$spike_dir/mumble_probe_core.c" "$test_dir/installed"',
			'\ncp "$spike_dir/mumble_probe_core.c" /tmp/outside-the-owned-test-dir',
		] as const) {
			const changed = spikeSources();
			changed.set('test-host.sh', `${changed.get('test-host.sh') ?? ''}${source}`);
			expect(spikeViolations(changed)).toContain('script-safety');
		}

		const stub = spikeSources();
		stub.set('test-support/windows.h', `${stub.get('test-support/windows.h') ?? ''}
			#define FILE_MAP_WRITE 0x0002u`);
		expect(spikeViolations(stub)).toEqual(expect.arrayContaining([
			'stub-safety', 'writeMappingAccess',
		]));
	});
});

type SpikeViolation = keyof typeof PROHIBITED_RUNTIME
	| 'call-census'
	| 'census'
	| 'map-readonly'
	| 'mapping-count'
	| 'open-readonly'
	| 'output-exact'
	| 'preprocessor'
	| 'runtime-contract'
	| 'script-safety'
	| 'stub-safety';

function spikeViolations(sources: Map<string, string>): SpikeViolation[] {
	const found = new Set<SpikeViolation>();
	if ([...sources.keys()].sort().join('\0') !== [...EXPECTED_SPIKE_FILES].sort().join('\0')) {
		found.add('census');
	}
	const core = sources.get('mumble_probe_core.c') ?? '';
	const wrapper = sources.get('mumble_probe_windows.c') ?? '';
	const stub = sources.get('test-support/windows.h') ?? '';
	if (!sameCensus(invocationCensus(core), EXPECTED_CORE_INVOCATIONS)
		|| !sameCensus(invocationCensus(wrapper), EXPECTED_WRAPPER_INVOCATIONS)
		|| !sameCensus(invocationCensus(stub), EXPECTED_STUB_DECLARATIONS)) {
		found.add('call-census');
	}
	if (JSON.stringify(preprocessorDirectives(wrapper))
		!== JSON.stringify(EXPECTED_WRAPPER_DIRECTIVES)) found.add('preprocessor');
	for (const [path, expectedHash] of Object.entries(EXPECTED_RUNTIME_HASHES)) {
		if (sha256(sources.get(path) ?? '') !== expectedHash) found.add('runtime-contract');
	}
	const openCalls = invocationArguments(wrapper, 'OpenFileMappingW');
	const mapCalls = invocationArguments(wrapper, 'MapViewOfFile');
	if (openCalls.length !== 1 || mapCalls.length !== 1) found.add('mapping-count');
	if (!hasExactArguments(openCalls, ['FILE_MAP_READ', 'FALSE', 'MUMBLE_MAPPING_NAME'])) {
		found.add('open-readonly');
	}
	if (!hasExactArguments(mapCalls, [
		'mapping', 'FILE_MAP_READ', '0u', '0u', 'TC_MUMBLE_LINK_VIEW_BYTES',
	])) found.add('map-readonly');
	if (!hasExactArguments(invocationArguments(wrapper, 'fwrite'), [
		'frame', '1u', 'frame_length', 'stdout',
	]) || !hasExactArguments(invocationArguments(wrapper, 'fputc'), ["'\\n'", 'stdout'])) {
		found.add('output-exact');
	}
	if (usesWriteMappingFlag(openCalls, 0) || usesWriteMappingFlag(mapCalls, 1)) {
		found.add('writeMappingAccess');
	}

	const runtime = RUNTIME_FILES.map((path) => stripCNonCode(sources.get(path) ?? '')).join('\n');
	for (const [name, pattern] of Object.entries(PROHIBITED_RUNTIME)) {
		if (pattern.test(runtime)) found.add(name as keyof typeof PROHIBITED_RUNTIME);
	}
	if (!gateScriptSafe(sources.get('test-host.sh') ?? '')) found.add('script-safety');
	if (!stubSafe(stub)) found.add('stub-safety');
	return [...found].sort();
}

function gateScriptSafe(source: string): boolean {
	if (createHash('sha256').update(source).digest('hex') !== EXPECTED_HOST_SCRIPT_SHA256) return false;
	const copies = source.match(/^\s*cp\s+.*$/gmu) ?? [];
	return copies.length === 2
		&& copies[0]?.trim() === 'cp "$spike_dir/mumble_probe_core.c" "$directory/"'
		&& copies[1]?.trim() === 'cp "$spike_dir/mumble_probe_core_test.c" "$directory/"'
		&& source.includes('directory="$test_dir/sabotage-$name"')
		&& source.includes('> "$directory/mumble_probe_core.h"')
		&& source.includes('>"$directory/stdout" 2>"$directory/stderr"');
}

function stubSafe(source: string): boolean {
	return /#define FILE_MAP_READ 0x0004u/u.test(source)
		&& !/FILE_MAP_(?:WRITE|ALL_ACCESS)|0x0*002u?/iu.test(source);
}

function invocationCensus(source: string): Record<string, number> {
	const ignored = new Set(['_Alignof', 'for', 'if', 'return', 'sizeof', 'switch']);
	const counts = new Map<string, number>();
	for (const match of stripCNonCode(source).matchAll(/\b([A-Za-z_]\w*)\s*\(/gu)) {
		const name = match[1];
		if (name === undefined || ignored.has(name)) continue;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function invocationArguments(source: string, name: string): string[][] {
	const tokens = cTokens(source);
	const calls: string[][] = [];
	for (let index = 0; index < tokens.length - 1; index += 1) {
		if (tokens[index] !== name || tokens[index + 1] !== '(') continue;
		const argumentsFound: string[] = [];
		let current = '';
		let depth = 1;
		for (index += 2; index < tokens.length && depth > 0; index += 1) {
			const token = tokens[index];
			if (token === '(') depth += 1;
			if (token === ')') depth -= 1;
			if (depth === 0) {
				argumentsFound.push(current);
				break;
			}
			if (token === ',' && depth === 1) {
				argumentsFound.push(current);
				current = '';
			} else {
				current += token;
			}
		}
		calls.push(argumentsFound);
	}
	return calls;
}

function hasExactArguments(calls: string[][], expected: string[]): boolean {
	return calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify(expected);
}

function usesWriteMappingFlag(calls: string[][], argumentIndex: number): boolean {
	return calls.some((call) => /^(?:FILE_MAP_WRITE|FILE_MAP_ALL_ACCESS|2u?|0x0*2u?)$/iu
		.test(call[argumentIndex] ?? ''));
}

function sameCensus(actual: Record<string, number>, expected: Record<string, number>): boolean {
	return JSON.stringify(actual) === JSON.stringify(
		Object.fromEntries(Object.entries(expected).sort(([left], [right]) => left.localeCompare(right))),
	);
}

function stripCNonCode(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//gu, ' ')
		.replace(/\/\/.*$/gmu, ' ')
		.replace(/L?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, ' ');
}

function cTokens(source: string): string[] {
	const tokens: string[] = [];
	const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|L?"(?:\\.|[^"\\])*"|L?'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|0[xX][0-9A-Fa-f]+(?:[uUlL]+)?|\d+(?:[uUlL]+)?|[^\s]/gu;
	for (const match of source.matchAll(pattern)) {
		const token = match[0];
		if (token.startsWith('/*') || token.startsWith('//')) continue;
		tokens.push(token);
	}
	return tokens;
}

function preprocessorDirectives(source: string): string[] {
	return stripCCommentsPreservingLayout(source)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('#'))
		.map((line) => line.replace(/^#\s*/u, '#').replace(/\s+/gu, ' '));
}

function stripCCommentsPreservingLayout(source: string): string {
	let result = '';
	let state: 'block-comment' | 'char' | 'code' | 'line-comment' | 'string' = 'code';
	for (let index = 0; index < source.length; index += 1) {
		const current = source[index] ?? '';
		const next = source[index + 1] ?? '';
		if (state === 'code' && current === '/' && next === '*') {
			result += '  ';
			state = 'block-comment';
			index += 1;
		} else if (state === 'code' && current === '/' && next === '/') {
			result += '  ';
			state = 'line-comment';
			index += 1;
		} else if (state === 'block-comment' && current === '*' && next === '/') {
			result += '  ';
			state = 'code';
			index += 1;
		} else if (state === 'line-comment' && current === '\n') {
			result += '\n';
			state = 'code';
		} else if (state === 'block-comment' || state === 'line-comment') {
			result += current === '\n' ? '\n' : ' ';
		} else if ((state === 'string' || state === 'char') && current === '\\') {
			result += current + next;
			index += 1;
		} else if (state === 'code' && (current === '"' || current === "'")) {
			result += current;
			state = current === '"' ? 'string' : 'char';
		} else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
			result += current;
			state = 'code';
		} else {
			result += current;
		}
	}
	return result;
}

function preprocessAndValidate(sources: Map<string, string>): {
	preprocessStatus: number | null;
	stderr: string;
	validatorStatus: number | null;
} {
	const directory = mkdtempSync(join(tmpdir(), 'tyrian-h8-preprocessed-'));
	try {
		const supportDirectory = join(directory, 'test-support');
		mkdirSync(supportDirectory);
		writeFileSync(join(directory, 'mumble_probe_windows.c'),
			sources.get('mumble_probe_windows.c') ?? '');
		writeFileSync(join(directory, 'mumble_probe_core.h'), sources.get('mumble_probe_core.h') ?? '');
		writeFileSync(join(supportDirectory, 'windows.h'),
			sources.get('test-support/windows.h') ?? '');
		const compiler = process.env.CC ?? 'cc';
		const preprocessed = spawnSync(compiler, [
			'-E', '-P', `-I${supportDirectory}`, `-I${directory}`,
			join(directory, 'mumble_probe_windows.c'),
		], { encoding: 'utf8' });
		if (preprocessed.status !== 0) {
			return {
				preprocessStatus: preprocessed.status,
				stderr: preprocessed.stderr,
				validatorStatus: null,
			};
		}
		const outputPath = join(directory, 'mumble_probe_windows.i');
		writeFileSync(outputPath, preprocessed.stdout);
		const validation = spawnSync(process.execPath, [
			join(SPIKE_ROOT, 'validate-preprocessed.mjs'), outputPath,
		], { encoding: 'utf8' });
		return {
			preprocessStatus: preprocessed.status,
			stderr: `${preprocessed.stderr}${validation.stderr}`,
			validatorStatus: validation.status,
		};
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function sha256(source: string): string {
	return createHash('sha256').update(source).digest('hex');
}

function spikeSources(): Map<string, string> {
	return new Map(EXPECTED_SPIKE_FILES.map((path) => [path, readFileSync(join(SPIKE_ROOT, path), 'utf8')]));
}

function spikeFiles(): string[] {
	return walk(SPIKE_ROOT)
		.map((path) => relative(SPIKE_ROOT, path).replaceAll('\\', '/'))
		.sort();
}

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [`${path}/<non-file>`];
	});
}
