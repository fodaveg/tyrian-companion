/**
 * Re-points the reviewed decisions of ONE file at their new line numbers.
 *
 * Inserting a line into a censused file moves every boundary below it, and the
 * census locates each one by exact `kind:line:column:endLine:endColumn`. The
 * result is a wall of "added" and "removed" findings with nothing actually
 * changed. `--write-baseline` would clear them by regenerating the file, and
 * that is precisely what must not happen: it throws away every reviewed
 * `classification`, `reason` and `evidence` and replaces them with unreviewed
 * defaults, which is a silent loss of the whole point of the census.
 *
 * So this pairs the reviewed decisions with the current boundaries POSITIONALLY
 * and copies only the coordinates across. It refuses, loudly and without
 * writing, whenever the pairing is not obviously safe:
 *
 * - a different NUMBER of boundaries in the file, or
 * - a different SEQUENCE of kinds.
 *
 * Either of those means a boundary genuinely appeared or vanished, and that
 * needs a human decision rather than a renumbering. A refusal is the useful
 * answer here, not an obstacle.
 *
 *   node scripts/reindex-action-observability-baseline.mjs <path> [<path>...]
 *   node scripts/reindex-action-observability-baseline.mjs --check <path>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectActionBoundaryCensus } from './action-observability-census.mjs';

const BASELINE = 'scripts/action-observability-baseline.json';
const COORDINATES = ['line', 'column', 'endLine', 'endColumn'];

function main(argv) {
	const check = argv.includes('--check');
	const paths = argv.filter((argument) => !argument.startsWith('--'));
	if (paths.length === 0) {
		process.stderr.write('usage: reindex-action-observability-baseline.mjs [--check] <path> [<path>...]\n');
		return 1;
	}

	const root = resolve('.');
	const baselinePath = resolve(root, BASELINE);
	const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
	const actual = collectActionBoundaryCensus(root);

	let changed = 0;
	for (const path of paths) {
		const reviewed = baseline.files[path];
		const current = actual.files[path];
		if (reviewed === undefined) { process.stderr.write(`REFUSED ${path}: not in the baseline\n`); return 1; }
		if (current === undefined) { process.stderr.write(`REFUSED ${path}: no longer a production file\n`); return 1; }

		const before = reviewed.boundaries;
		const after = current.boundaries;
		if (before.length !== after.length) {
			process.stderr.write(
				`REFUSED ${path}: ${String(before.length)} reviewed boundaries, ${String(after.length)} now. `
				+ 'A boundary appeared or vanished; decide it by hand.\n',
			);
			return 1;
		}
		const beforeKinds = before.map(({ kind }) => kind).join(',');
		const afterKinds = after.map(({ kind }) => kind).join(',');
		if (beforeKinds !== afterKinds) {
			process.stderr.write(`REFUSED ${path}: the sequence of boundary kinds changed; decide it by hand.\n`);
			return 1;
		}

		let moved = 0;
		for (let index = 0; index < before.length; index += 1) {
			for (const key of COORDINATES) {
				if (before[index][key] !== after[index][key]) moved += 1;
				before[index][key] = after[index][key];
			}
			// `registration` is part of the identity and is derived from the code,
			// not decided by a reviewer, so it travels with the coordinates.
			if (after[index].registration !== undefined) before[index].registration = after[index].registration;
		}
		process.stdout.write(`${moved === 0 ? 'unchanged' : 'reindexed'} ${path}: ${String(before.length)} boundaries, ${String(moved)} coordinate(s) moved\n`);
		changed += moved;
	}

	if (check) {
		process.stdout.write(`--check: ${String(changed)} coordinate(s) would move; nothing written\n`);
		return 0;
	}
	// Tab-indented, with a trailing newline, exactly as the census writes it.
	writeFileSync(baselinePath, `${JSON.stringify(baseline, null, '\t')}\n`, { flag: 'w' });
	process.stdout.write(`wrote ${BASELINE}\n`);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
