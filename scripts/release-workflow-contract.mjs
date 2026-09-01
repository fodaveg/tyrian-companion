import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const RELEASE_WORKFLOW_CONTRACT_VERSION = 1;

const WORKFLOW_DIRECTORY = '.github/workflows';
const RELEASE_WORKFLOW = 'release.yml';
const CONTRACT_COMMAND = 'scripts/brat-release-contract.mjs';
const CONTRACT_FLAG = '--release-json';
const PUBLISH_COMMAND = 'gh release create';
/**
 * The asset set has to be DERIVED from the staged bytes, not typed into the
 * workflow. A hand-written list is exactly how 0.1.19 shipped incomplete: it
 * cannot notice that a file it never mentions is missing.
 */
const REQUIRED_ASSET_SOURCES = Object.freeze([
	'scripts/brat-release-plan.mjs --from-staging',
	'scripts/brat-release-plan.mjs --asset-paths',
]);

/**
 * Everything here is checked over the PARSED workflow, and over the executable
 * lines of each `run`, never over the raw characters of the file. A grep for
 * 'gh release create' matches the comment that explains it, which is how a
 * guardrail ends up certifying its own documentation.
 */
export function validateReleaseWorkflow(root = process.cwd()) {
	const findings = [];
	const workflow = readWorkflow(resolve(root, WORKFLOW_DIRECTORY, RELEASE_WORKFLOW), findings);
	if (workflow === null) return finish(findings);

	if (!triggersOnTags(workflow)) findings.push('release-not-triggered-by-tag');
	if (readPermission(workflow.permissions) !== 'read') findings.push('release-top-level-permission');

	const jobs = isRecord(workflow.jobs) ? Object.entries(workflow.jobs) : [];
	if (jobs.length === 0) {
		findings.push('release-has-no-jobs');
		return finish(findings);
	}

	const publishingJobs = jobs.filter(([, job]) => stepsOf(job).some((step) => runsCommand(step, PUBLISH_COMMAND)));
	if (publishingJobs.length !== 1) {
		findings.push('release-publishing-job-count');
		return finish(findings);
	}

	const [, job] = publishingJobs[0];
	if (readPermission(job.permissions) !== 'write') findings.push('release-job-missing-write');

	const steps = stepsOf(job);
	const gateIndex = steps.findIndex((step) => runsCommand(step, CONTRACT_COMMAND) && runsCommand(step, CONTRACT_FLAG));
	const publishIndex = steps.findIndex((step) => runsCommand(step, PUBLISH_COMMAND));

	if (gateIndex === -1) findings.push('release-missing-brat-gate');
	else if (publishIndex !== -1 && gateIndex > publishIndex) findings.push('release-gate-after-publication');

	for (const source of REQUIRED_ASSET_SOURCES) {
		if (!steps.some((step) => runsCommand(step, source))) findings.push('release-assets-not-planned');
	}

	// Every other workflow keeps read-only access. ci.yml runs on every branch
	// and every pull request; a write token there would be handed to all of them.
	for (const [name, other] of otherWorkflows(root, findings)) {
		if (readPermission(other.permissions) === 'write') findings.push(`workflow-write-permission:${name}`);
		for (const [, otherJob] of isRecord(other.jobs) ? Object.entries(other.jobs) : []) {
			if (readPermission(otherJob.permissions) === 'write') findings.push(`workflow-write-permission:${name}`);
		}
	}

	return finish(findings);
}

function finish(findings) {
	return { version: RELEASE_WORKFLOW_CONTRACT_VERSION, findings: [...new Set(findings)].sort() };
}

function readWorkflow(path, findings) {
	let parsed;
	try {
		parsed = parse(readFileSync(path, 'utf8'));
	} catch {
		findings.push('release-workflow-unreadable');
		return null;
	}
	if (!isRecord(parsed)) {
		findings.push('release-workflow-shape');
		return null;
	}
	return parsed;
}

function otherWorkflows(root, findings) {
	const directory = resolve(root, WORKFLOW_DIRECTORY);
	let names;
	try {
		names = readdirSync(directory).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
	} catch {
		findings.push('workflow-directory-unreadable');
		return [];
	}
	const found = [];
	for (const name of names.sort()) {
		if (name === RELEASE_WORKFLOW) continue;
		try {
			const parsed = parse(readFileSync(join(directory, name), 'utf8'));
			if (isRecord(parsed)) found.push([name, parsed]);
		} catch {
			findings.push(`workflow-unreadable:${name}`);
		}
	}
	return found;
}

/**
 * YAML 1.1 turns a bare `on` key into the boolean true, so both spellings have
 * to be accepted or this contract reads a perfectly good workflow as untriggered.
 */
function triggersOnTags(workflow) {
	const triggers = workflow.on ?? workflow[true];
	if (!isRecord(triggers) || !isRecord(triggers.push)) return false;
	const tags = triggers.push.tags;
	return Array.isArray(tags) && tags.length > 0;
}

function readPermission(permissions) {
	if (typeof permissions === 'string') return permissions === 'write-all' ? 'write' : null;
	if (!isRecord(permissions)) return null;
	return typeof permissions.contents === 'string' ? permissions.contents : null;
}

function stepsOf(job) {
	return isRecord(job) && Array.isArray(job.steps) ? job.steps : [];
}

/** Matches only the executable lines of a `run`, so a shell comment cannot satisfy the contract. */
function runsCommand(step, needle) {
	if (!isRecord(step) || typeof step.run !== 'string') return false;
	return step.run
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.some((line) => line.includes(needle));
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runCli(root = process.cwd()) {
	const result = validateReleaseWorkflow(root);
	if (result.findings.length > 0) {
		for (const finding of result.findings) process.stderr.write(`release workflow contract: ${finding}\n`);
		return 1;
	}
	process.stdout.write('release workflow contract: PASS\n');
	return 0;
}

const isDirectExecution = process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = runCli();
