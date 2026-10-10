// @vitest-environment node
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = join(process.cwd(), 'scripts/generate-known-achievement-sets.mjs');

/** One meta (id 1, bar 1) whose category lists a second achievement, in the cache the script reads. */
function seedCache(): string {
	const cache = mkdtempSync(join(tmpdir(), 'known-sets-'));
	mkdirSync(join(cache, 'wiki'));
	writeFileSync(join(cache, 'ach-en.json'), JSON.stringify([
		{ id: 1, name: 'Meta', flags: ['CategoryDisplay'], tiers: [{ count: 1, points: 1 }] },
		{ id: 2, name: 'Member', flags: [], tiers: [{ count: 1, points: 1 }] },
	]));
	writeFileSync(join(cache, 'cats-en.json'), JSON.stringify([{ id: 10, name: 'Cat', order: 1, achievements: [{ id: 1 }, { id: 2 }] }]));
	return cache;
}

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function wiki(answer: (url: string) => { status: number; body: string }): Promise<{ base: string; asked: string[] }> {
	const asked: string[] = [];
	server = createServer((request, response) => {
		asked.push(request.url ?? '');
		const { status, body } = answer(request.url ?? '');
		response.writeHead(status).end(body);
	});
	await new Promise<void>((done) => { server!.listen(0, '127.0.0.1', done); });
	return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/wiki/`, asked };
}

const generate = (cache: string, base: string, extra: string[]) =>
	run('node', [SCRIPT, '--cache', cache, '--out', join(cache, 'out.ts'), ...extra], { env: { ...process.env, KNOWN_SETS_WIKI_BASE: base } });

describe('the known sets generator keeps only what the wiki really served', () => {
	it('refuses to run without --date: the date goes into the module, and an undated run would change with the day', async () => {
		const cache = seedCache();
		await expect(generate(cache, 'http://127.0.0.1:1/wiki/', [])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--date YYYY-MM-DD is required') as unknown });
		expect(existsSync(join(cache, 'out.ts'))).toBe(false);
	});

	it('does not keep an error answer of the wiki in the cache: a 404 is asked again next time', async () => {
		const cache = seedCache();
		const { base, asked } = await wiki(() => ({ status: 404, body: 'no such page' }));
		await generate(cache, base, ['--date', '2026-10-10', '--report', join(cache, 'report.txt')]);
		expect(asked.length).toBeGreaterThan(0);
		expect(readdirSync(join(cache, 'wiki'))).toEqual([]);
	});

	it('keeps a 200 page with a body, and does not ask for it again', async () => {
		const cache = seedCache();
		const page = '{{Achievement table row\n| id = 1\n| name = Meta\n| objectives = [[Cat#achievement2|Member]]\n}}\n';
		const { base, asked } = await wiki((url) => (url.includes('Cat_%28achievements%29') || url.includes('Cat_(achievements)') ? { status: 200, body: page } : { status: 404, body: '' }));
		await generate(cache, base, ['--date', '2026-10-10', '--report', join(cache, 'report.txt')]);
		expect(readdirSync(join(cache, 'wiki'))).toHaveLength(1);
		const before = asked.length;
		await generate(cache, base, ['--date', '2026-10-10', '--report', join(cache, 'report.txt')]);
		// Only the pages that were not kept are asked for again.
		expect(asked.length - before).toBeLessThan(before);
	});
});
