import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RECORD_API_FIXTURES_CONTRACT_VERSION = 1;
const API_URL = 'https://api.guildwars2.com/v2';

/**
 * H14.8's fixed list: the two items the lote names (36038, the Trick-or-Treat
 * Bag whose `whitelisted:false` triggered the 0.1.30 Halloween bug; 83008)
 * plus three ordinary crafting materials, so the gate has real API shapes for
 * both the "container with a price" and the "raw material with a deep order
 * book" cases instead of hand-typed JSON.
 */
export const RECORDED_ITEM_IDS = Object.freeze([36038, 83008, 19697, 19700, 19703]);

export class RecordApiFixturesError extends Error {
	constructor(code) {
		super(`record api fixtures: ${code}`);
		this.name = 'RecordApiFixturesError';
		this.code = code;
	}
}

/**
 * Only the three public, unauthenticated endpoints the catalog and economy
 * layers actually call: no API key is ever sent or accepted here.
 */
export const RECORDED_ENDPOINTS = Object.freeze([
	{ route: 'items', file: 'items.json' },
	{ route: 'commerce/prices', file: 'commerce-prices.json' },
	{ route: 'commerce/listings', file: 'commerce-listings.json' },
]);

/**
 * Fetches each endpoint once for `RECORDED_ITEM_IDS` and writes the raw,
 * unmodified response body plus a `recorded-at.json` manifest recording the
 * date and the exact ids. `fetchJson` is injectable so this stays testable
 * without the network; the CLI entry point is the only caller that touches it
 * for real, and only when explicitly invoked, never as part of the gate.
 */
export async function recordApiFixtures({
	outputDir,
	itemIds = RECORDED_ITEM_IDS,
	endpoints = RECORDED_ENDPOINTS,
	fetchJson = fetchJsonOverHttps,
	now = () => new Date(),
} = {}) {
	if (typeof outputDir !== 'string' || outputDir.length === 0) fail('invalid-arguments');
	if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.some((id) => !Number.isInteger(id) || id <= 0)) {
		fail('invalid-item-ids');
	}
	mkdirSync(outputDir, { recursive: true });
	const recordedAt = now().toISOString();
	const written = [];
	for (const { route, file } of endpoints) {
		const url = `${API_URL}/${route}?ids=${itemIds.join(',')}`;
		const body = await fetchJson(url);
		const path = resolve(outputDir, file);
		writeFileSync(path, `${JSON.stringify(body, null, '\t')}\n`);
		written.push({ file, route, url });
	}
	const manifestPath = resolve(outputDir, 'recorded-at.json');
	const manifest = { version: RECORD_API_FIXTURES_CONTRACT_VERSION, recordedAt, itemIds: [...itemIds], sources: written };
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
	return Object.freeze({ manifest, files: written.map((entry) => entry.file).concat('recorded-at.json') });
}

// `no-restricted-globals` steers product code at `requestUrl`; this is a one-off Node CLI
// tool, never bundled into the plugin, so it deliberately keeps the warning instead of
// disabling a rule this repo does not allow disabling (`eslint-comments/no-restricted-disable`).
async function fetchJsonOverHttps(url) {
	const response = await fetch(url);
	if (response.status !== 200) fail(`http-${String(response.status)}`);
	return await response.json();
}

function fail(code) {
	throw new RecordApiFixturesError(code);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	try {
		const outputDir = resolve('src/catalog/__fixtures__/recorded');
		const result = await recordApiFixtures({ outputDir });
		process.stdout.write(
			`record api fixtures v${String(RECORD_API_FIXTURES_CONTRACT_VERSION)}: PASS ` +
				`(ids=${RECORDED_ITEM_IDS.join(',')}; recordedAt=${result.manifest.recordedAt}; ` +
				`files=${result.files.join(',')})\n`,
		);
	} catch (error) {
		const code = error instanceof RecordApiFixturesError ? error.code : 'unexpected-failure';
		process.stderr.write(`record api fixtures: ${code}\n`);
		process.exitCode = 1;
	}
}
