import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { RECORDED_ENDPOINTS, RecordApiFixturesError, recordApiFixtures } from '../record-api-fixtures.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-record-api-fixtures-'));
const failures = [];

try {
	await testWritesRawBodyPerEndpointWithManifest();
	await testRejectsAnEmptyItemIdList();
	await testFailsClosedOnANonOkResponse();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`record api fixtures suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('record api fixtures suite: PASS\n');
}

async function testWritesRawBodyPerEndpointWithManifest() {
	const outputDir = join(testRoot, 'basic');
	const calls = [];
	const result = await recordApiFixtures({
		outputDir,
		itemIds: [36038, 83008],
		fetchJson: async (url) => {
			calls.push(url);
			return [{ id: 36038, whitelisted: true }, { id: 83008, whitelisted: false }];
		},
		now: () => new Date('2026-09-09T00:00:00.000Z'),
	});
	assert(calls.length === RECORDED_ENDPOINTS.length, `expected ${String(RECORDED_ENDPOINTS.length)} fetches, got ${String(calls.length)}`);
	assert(calls.every((url) => url.includes('ids=36038,83008')), 'a fetch URL did not carry the exact requested ids');
	assert(calls.every((url) => url.startsWith('https://api.guildwars2.com/v2/')), 'a fetch URL did not target the public API');
	for (const { file } of RECORDED_ENDPOINTS) {
		const path = resolve(outputDir, file);
		assert(existsSync(path), `${file} was not written`);
		const body = JSON.parse(readFileSync(path, 'utf8'));
		assert(Array.isArray(body) && body.length === 2, `${file} did not contain the raw recorded body`);
	}
	const manifest = JSON.parse(readFileSync(resolve(outputDir, 'recorded-at.json'), 'utf8'));
	assert(manifest.recordedAt === '2026-09-09T00:00:00.000Z', 'the manifest did not record the injected clock');
	assert(sameNumbers(manifest.itemIds, [36038, 83008]), 'the manifest did not record the exact requested ids');
	assert(sameStrings(result.files, [...RECORDED_ENDPOINTS.map((entry) => entry.file), 'recorded-at.json']), 'the reported file list did not match what was written');
}

async function testRejectsAnEmptyItemIdList() {
	await assertRejectsCode(
		recordApiFixtures({ outputDir: join(testRoot, 'empty'), itemIds: [], fetchJson: async () => [] }),
		'invalid-item-ids',
		'an empty item id list was accepted',
	);
}

async function testFailsClosedOnANonOkResponse() {
	await assertRejectsCode(
		recordApiFixtures({
			outputDir: join(testRoot, 'http-error'),
			itemIds: [1],
			fetchJson: async () => {
				throw new RecordApiFixturesError('http-503');
			},
		}),
		'http-503',
		'a non-OK response did not fail closed',
	);
}

function sameNumbers(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStrings(left, right) {
	return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

async function assertRejectsCode(promise, expectedCode, message) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RecordApiFixturesError && error.code === expectedCode) return;
		failures.push(`${message} (got: ${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	failures.push(message);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
