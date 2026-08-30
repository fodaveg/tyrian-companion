import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { moduleSpecifiers } from '../test/module-boundary';

const PRICE_HISTORY_FILES = readdirSync('src/economy')
	.filter((file) => file.startsWith('price-history-') && file.endsWith('.ts') && !file.endsWith('.test.ts'))
	.sort()
	.map((file) => ({ path: `src/economy/${file}`, source: readFileSync(`src/economy/${file}`, 'utf8') }));

const IMPORTS = new Map<string, string[]>([
	['src/economy/price-history-capture.ts', [
		'../catalog/public-catalog-client', '../core/http', '../core/local-debug-action-runner', '../core/rate-limit-coordinator',
		'./price-history-model', './price-history-store', './session-price-snapshot',
	]],
	['src/economy/price-history-model.ts', []],
	['src/economy/price-history-runtime.ts', [
		'../catalog/public-catalog-client', '../core/local-debug-action-runner', '../core/local-debug-persistence',
		'../core/rate-limit-coordinator', '../sessions/api-poll-scheduler',
		'./price-history-capture', './price-history-model', './price-history-store',
	]],
	['src/economy/price-history-statistics.ts', ['./price-history-model']],
	['src/economy/price-history-store.ts', [
		'../core/local-debug-persistence', './price-history-model', './price-history-statistics',
	]],
]);

const FORBIDDEN_CAPABILITY = /\b(?:SecretStorage|GuildWars2Client|Vault|TFile|requestUrl|fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage)\b/u;
const FORBIDDEN_DATA = /\b(?:accountId|characterName|apiKey|listingQuantity|vaultPath)\b/u;

describe('H9.1 price-history architecture boundary', () => {
	it('censuses the complete production surface and fixes each import allowlist', () => {
		expect(PRICE_HISTORY_FILES.map(({ path }) => path)).toEqual([...IMPORTS.keys()].sort());
		for (const { path, source } of PRICE_HISTORY_FILES) {
			expect([...new Set(moduleSpecifiers(source))].sort(), path).toEqual(IMPORTS.get(path));
			expect(source, `${path} reaches a forbidden capability`).not.toMatch(FORBIDDEN_CAPABILITY);
			expect(source, `${path} models forbidden personal data`).not.toMatch(FORBIDDEN_DATA);
		}
	});

	it('keeps the only HTTP request in capture on the official public-price relative path', () => {
		const capture = source('src/economy/price-history-capture.ts');
		expect(capture.match(/\.requestDetailed\(/gu)).toHaveLength(1);
		expect(capture).toContain('`commerce/prices?ids=${batch.join(\',\')}`');
		for (const { path, source: moduleSource } of PRICE_HISTORY_FILES) {
			if (path !== 'src/economy/price-history-capture.ts') expect(moduleSource).not.toMatch(/\.requestDetailed\(/u);
		}
	});

	it('keeps IndexedDB inside the fail-closed store and never adds a memory fallback', () => {
		for (const { path, source: moduleSource } of PRICE_HISTORY_FILES) {
			if (path === 'src/economy/price-history-runtime.ts') expect(moduleSource).not.toMatch(/\bIDB(?:Database|Transaction|KeyRange)\b/u);
			else if (path !== 'src/economy/price-history-store.ts') expect(moduleSource).not.toMatch(/\bIDB(?:Factory|Database|Transaction|KeyRange)\b/u);
		}
		expect(source('src/economy/price-history-store.ts')).not.toMatch(/MemoryPriceHistory|fallback/iu);
	});

	it('keeps compaction linear and peak memory bounded to one UTC day', () => {
		const store = source('src/economy/price-history-store.ts');
		const compaction = store.slice(store.indexOf('\tasync compactAndPrune('), store.indexOf('\n\tprivate ensureIncrementalCompactionMarkers'));
		const compactDay = store.slice(store.indexOf('\tprivate compactDirtyDay('), store.indexOf('\n\tprivate pruneSnapshotsBefore'));
		const readDaily = store.slice(store.indexOf('\treadDaily('), store.indexOf('\n\n\t/** Compacts'));
		expect(compaction).toContain('this.nextDirtyDay(vaultId)');
		expect(compaction).toContain('this.pruneSnapshotsBefore(');
		expect(compactDay).toContain("index('by-vault-captured').getAll(capturedRange(");
		expect(compactDay).toContain("index('by-vault-day').getAll(IDBKeyRange.only(");
		expect(compactDay).toContain('buildPriceHistoryDailyAggregates(vaultId, raw)');
		expect(compactDay).toContain('sameDaily(');
		expect(readDaily).toContain("'by-vault-item-day'");
		expect(compaction + compactDay).not.toMatch(/keyRangeForVault|\.find\s*\(|snapshots\s*:\s*\[\]/u);
		expect(store.slice(store.indexOf('\tprivate pruneSnapshotsBefore'), store.indexOf('\n\tclose(): void'))).toContain('.openCursor(range)');
	});

	it.each([
		'import { SecretStorage } from \'obsidian\';',
		'const accountId = "personal";',
		'fetch("https://example.test");',
	])('turns red when a forbidden capability or datum is added: %s', (poison) => {
		const poisoned = `${source('src/economy/price-history-model.ts')}\n${poison}`;
		expect(FORBIDDEN_CAPABILITY.test(poisoned) || FORBIDDEN_DATA.test(poisoned)).toBe(true);
	});
});

function source(path: string): string {
	return PRICE_HISTORY_FILES.find((entry) => entry.path === path)?.source ?? '';
}
