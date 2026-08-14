import { spawnSync } from "node:child_process";

import { H6_PERFORMANCE_BUDGET } from "../src/performance/h6-performance-contract";

const MEBIBYTE = 1024 * 1024;
const productBudgetBytes =
	H6_PERFORMANCE_BUDGET.maxCumulativeRetainedHeapBytes;
const productBudgetMebibytes = productBudgetBytes / MEBIBYTE;
const requestedSabotageMebibytes = Math.max(
	32,
	Math.ceil(productBudgetMebibytes * 2),
);

const result = spawnSync(
	process.execPath,
	[
		"--expose-gc",
		"node_modules/jiti/lib/jiti-cli.mjs",
		"scripts/benchmark-h6-performance.ts",
		"--max-median-ms=60000",
		"--max-p95-ms=60000",
		`--max-cumulative-retained-heap-mib=${productBudgetMebibytes}`,
		`--sabotage-retained-heap-mib=${requestedSabotageMebibytes}`,
	],
	{
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, JITI_FS_CACHE: "false" },
	},
);

if (result.error) throw result.error;
if (result.status === 0) {
	throw new Error(
		"H6 heap sabotage unexpectedly passed its production cumulative budget.",
	);
}

const output = `${result.stdout}\n${result.stderr}`;
const retainedHeapMatch =
	/cumulative retained heap (\d+)B > (\d+)B/u.exec(output);
const observedRetainedHeapBytes = Number(retainedHeapMatch?.[1]);
const reportedBudgetBytes = Number(retainedHeapMatch?.[2]);
if (
	retainedHeapMatch === null ||
	!Number.isSafeInteger(observedRetainedHeapBytes) ||
	!Number.isSafeInteger(reportedBudgetBytes) ||
	reportedBudgetBytes !== productBudgetBytes ||
	observedRetainedHeapBytes <= reportedBudgetBytes
) {
	throw new Error(
		`H6 heap sabotage did not exceed the exact production budget.\n${output}`,
	);
}

process.stdout.write(
	`H6 deterministic heap sabotage: PASS (${process.version}, ${observedRetainedHeapBytes}B).\n`,
);
