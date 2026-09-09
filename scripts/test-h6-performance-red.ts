import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { H6_PERFORMANCE_BUDGET } from "../src/performance/h6-performance-contract";

const MEBIBYTE = 1024 * 1024;
const productBudgetBytes =
	H6_PERFORMANCE_BUDGET.maxCumulativeRetainedHeapBytes;
const productBudgetMebibytes = productBudgetBytes / MEBIBYTE;
const requestedSabotageMebibytes = Math.max(
	32,
	Math.ceil(productBudgetMebibytes * 2),
);
/**
 * Measured 8 sep 2026: this red used `--max-median-ms=60000 --max-p95-ms=60000` to isolate
 * the heap branch, so the duration branch of `assertH6PerformanceBudget` had never been seen
 * to fail. 1ms is impossible for either percentile on real work, and unlike the heap branch
 * needs no sabotage of its own: the budget itself is the sabotage.
 */
const IMPOSSIBLE_DURATION_BUDGET_MS = 1;

testHeapBranchFails();
testDurationBranchFails();

function testHeapBranchFails(): void {
	const result = runBenchmark([
		"--max-median-ms=60000",
		"--max-p95-ms=60000",
		`--max-cumulative-retained-heap-mib=${String(productBudgetMebibytes)}`,
		`--sabotage-retained-heap-mib=${String(requestedSabotageMebibytes)}`,
	]);
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
		`H6 deterministic heap sabotage: PASS (${process.version}, ${String(observedRetainedHeapBytes)}B).\n`,
	);
}

/** The branch `--max-median-ms=60000 --max-p95-ms=60000` had disabled in every prior run of this red. */
function testDurationBranchFails(): void {
	const result = runBenchmark([
		`--max-median-ms=${String(IMPOSSIBLE_DURATION_BUDGET_MS)}`,
		`--max-p95-ms=${String(IMPOSSIBLE_DURATION_BUDGET_MS)}`,
	]);
	if (result.error) throw result.error;
	if (result.status === 0) {
		throw new Error(
			"H6 duration sabotage unexpectedly passed an impossible 1ms budget.",
		);
	}

	const output = `${result.stdout}\n${result.stderr}`;
	const medianMatch = /median (\d+(?:\.\d+)?)ms > (\d+(?:\.\d+)?)ms/u.exec(
		output,
	);
	const reportedBudgetMs = Number(medianMatch?.[2]);
	if (
		medianMatch === null ||
		!Number.isFinite(Number(medianMatch[1])) ||
		reportedBudgetMs !== IMPOSSIBLE_DURATION_BUDGET_MS
	) {
		throw new Error(
			`H6 duration sabotage did not report the exact 1ms median budget.\n${output}`,
		);
	}
	if (output.includes("cumulative retained heap")) {
		throw new Error(
			`H6 duration sabotage also tripped the heap branch; the two are no longer isolated.\n${output}`,
		);
	}

	process.stdout.write(
		`H6 deterministic duration sabotage: PASS (${process.version}, median > ${String(IMPOSSIBLE_DURATION_BUDGET_MS)}ms).\n`,
	);
}

function runBenchmark(extraArgs: readonly string[]): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"node_modules/jiti/lib/jiti-cli.mjs",
			"scripts/benchmark-h6-performance.ts",
			...extraArgs,
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, JITI_FS_CACHE: "false" },
		},
	);
}
