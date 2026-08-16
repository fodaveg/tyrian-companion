import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const configUrl = pathToFileURL(`${process.cwd()}/eslint.config.mts`).href;

describe('ESLint default-project capacity', () => {
	it('keeps the allowlist within the explicit capacity and reserved headroom', () => {
		expect(runConfigCheck()).toMatchObject({ status: 0, stderr: '' });
	});

	it('accepts the exact reviewed boundary', () => {
		expect(runConfigCheck(14, 18, 4)).toMatchObject({ status: 0, stderr: '' });
	});

	it('turns red before the reserved headroom is consumed', () => {
		const result = runConfigCheck(15, 18, 4);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			'allowDefaultProject lists 15 files and reserves 4 slots, but its explicit capacity is 18',
		);
	});
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
