import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { H6_LIVE_SESSION_BUDGET } from "../src/performance/h6-live-session-contract";

/** Shorter than the production run: enough for every window to hold samples, half the wall time. */
const SHORT_SESSION_SAMPLES = 3_700;
const IMPOSSIBLE_MS = 1;

testJournalCloneRegressionFails();
testImpossibleBudgetFails();

/**
 * A regression that makes every looted sample copy the whole journal (the shape of the audit's
 * `getAwaitingPriceEntries` finding) is injected into the benchmark itself, with the PRODUCTION
 * budget. The end/start ratio is the check that must catch it; no budget is lowered here.
 */
function testJournalCloneRegressionFails(): void {
	const result = runBenchmark(["--sabotage-journal-clone"]);
	if (result.error) throw result.error;
	if (result.status === 0) {
		throw new Error(
			"H6 live-session journal-clone sabotage unexpectedly passed the production budget.",
		);
	}
	const output = `${result.stdout}\n${result.stderr}`;
	const ratioMatch = /end\/start median ratio (\d+(?:\.\d+)?) > (\d+(?:\.\d+)?)/u.exec(
		output,
	);
	if (
		ratioMatch === null ||
		Number(ratioMatch[2]) !== H6_LIVE_SESSION_BUDGET.maxEndToStartMedianRatio ||
		Number(ratioMatch[1]) <= H6_LIVE_SESSION_BUDGET.maxEndToStartMedianRatio
	) {
		throw new Error(
			`H6 live-session sabotage did not trip the production end/start ratio.\n${output}`,
		);
	}
	process.stdout.write(
		`H6 live-session journal-clone sabotage: PASS (${process.version}, ratio ${ratioMatch[1]} > ${ratioMatch[2]}).\n`,
	);
}

/** The time branches of the assertion, which the sabotage above does not isolate. */
function testImpossibleBudgetFails(): void {
	const result = runBenchmark([
		`--samples=${String(SHORT_SESSION_SAMPLES)}`,
		`--max-end-median-ms=${String(IMPOSSIBLE_MS)}`,
		`--max-end-p95-ms=${String(IMPOSSIBLE_MS)}`,
		`--max-close-ms=${String(IMPOSSIBLE_MS)}`,
		"--max-note-mib=0",
	]);
	if (result.error) throw result.error;
	if (result.status === 0) {
		throw new Error(
			"H6 live-session impossible budget unexpectedly passed.",
		);
	}
	const output = `${result.stdout}\n${result.stderr}`;
	for (const expected of [
		/end-of-session median \d+(?:\.\d+)?ms > 1ms/u,
		/end-of-session p95 \d+(?:\.\d+)?ms > 1ms/u,
		/close and note \d+ms > 1ms/u,
		/note \d+B > 0B/u,
	]) {
		if (!expected.test(output)) {
			throw new Error(
				`H6 live-session impossible budget did not report ${String(expected)}.\n${output}`,
			);
		}
	}
	process.stdout.write(
		`H6 live-session impossible-budget sabotage: PASS (${process.version}).\n`,
	);
}

function runBenchmark(extraArgs: readonly string[]): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[
			"node_modules/jiti/lib/jiti-cli.mjs",
			"scripts/benchmark-h6-live-session.ts",
			...extraArgs,
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, JITI_FS_CACHE: "false" },
		},
	);
}
