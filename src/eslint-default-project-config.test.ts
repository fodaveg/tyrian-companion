import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const configUrl = pathToFileURL(`${process.cwd()}/eslint.config.mts`).href;
// Each case spawns node to import eslint.config.mts, which pulls typescript-eslint and the
// obsidian plugin: seconds, not milliseconds, and more under a loaded machine. The default
// 5s budget made this suite fail the gate at random without any assertion changing.
const SPAWN_TIMEOUT_MS = 30_000;

describe('ESLint default-project capacity', () => {
	it('keeps the allowlist within the explicit capacity and reserved headroom', () => {
		expect(runConfigCheck()).toMatchObject({ status: 0, stderr: '' });
	}, SPAWN_TIMEOUT_MS);

	it('accepts the exact reviewed boundary', () => {
		expect(runConfigCheck(18, 22, 4)).toMatchObject({ status: 0, stderr: '' });
	}, SPAWN_TIMEOUT_MS);

	it('turns red before the reserved headroom is consumed', () => {
		const result = runConfigCheck(19, 22, 4);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			'allowDefaultProject lists 19 files and reserves 4 slots, but its explicit capacity is 22',
		);
	}, SPAWN_TIMEOUT_MS);
});

function runConfigCheck(fileCount?: number, capacity?: number, reservedHeadroom?: number) {
	const assertion =
		fileCount === undefined
			? ''
			: `assertDefaultProjectCapacity(new Array(${fileCount}).fill('script.mjs'), ${capacity}, ${reservedHeadroom});`;
	return spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'--eval',
			`const { assertDefaultProjectCapacity } = await import(process.argv[1]); ${assertion}`,
			configUrl,
		],
		{ cwd: process.cwd(), encoding: 'utf8' },
	);
}
