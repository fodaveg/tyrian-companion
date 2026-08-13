import { spawnSync } from 'node:child_process';

const runGit = (args) =>
	spawnSync('git', args, {
		cwd: process.cwd(),
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

const statusResult = runGit([
	'status',
	'--porcelain=v1',
	'--untracked-files=all',
]);
const branchResult = runGit(['symbolic-ref', '--quiet', 'HEAD']);
const commitResult = runGit(['rev-parse', '--verify', '--quiet', 'HEAD']);

if (statusResult.status !== 0 || typeof statusResult.stdout !== 'string') {
	console.error('release preflight: fail (repository state unavailable)');
	process.exitCode = 1;
} else {
	const counts = {
		untracked: 0,
		unstaged: 0,
		staged: 0,
	};

	for (const entry of statusResult.stdout.split('\n')) {
		if (entry.length < 2) continue;

		const indexStatus = entry[0];
		const worktreeStatus = entry[1];

		if (indexStatus === '?' && worktreeStatus === '?') {
			counts.untracked += 1;
			continue;
		}

		if (indexStatus !== ' ') counts.staged += 1;
		if (worktreeStatus !== ' ') counts.unstaged += 1;
	}

	const isClean = statusResult.stdout === '';
	const isAttached = branchResult.status === 0;
	const hasCommit = commitResult.status === 0;
	const result = isClean && isAttached && hasCommit ? 'pass' : 'fail';
	const headState = !hasCommit
		? 'missing'
		: isAttached
			? 'attached'
			: 'detached';
	const summary =
		`release preflight: ${result} (` +
		`untracked=${counts.untracked} ` +
		`unstaged=${counts.unstaged} ` +
		`staged=${counts.staged}; HEAD ${headState})`;

	if (result === 'pass') {
		process.stdout.write(`${summary}\n`);
	} else {
		console.error(summary);
		process.exitCode = 1;
	}
}
