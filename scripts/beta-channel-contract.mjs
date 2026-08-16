import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDocument } from 'yaml';

const UPLOAD_ACTION = 'actions/upload-artifact@v4';
const UPLOAD_WITH = Object.freeze({
	'name': 'tyrian-companion-${{ github.ref_type }}-${{ github.sha }}',
	'path': '.beta-artifact/*',
	'if-no-files-found': 'error',
	'include-hidden-files': true,
	'retention-days': 14,
});

/** Validates the exact CI and package-script surface used by the guarded H7.5 beta channel. */
export function validateBetaChannelContract({ packageSource, workflowSource }) {
	let packageJson;
	try {
		packageJson = JSON.parse(packageSource);
	} catch {
		return findings('package-json');
	}
	if (!isRecord(packageJson?.scripts)) return findings('package-scripts');
	for (const [name, command] of [
		['beta:artifact', 'node scripts/prepare-beta-artifact.mjs'],
		['beta:install', 'node scripts/install-beta.mjs install'],
		['test:beta-channel', 'node scripts/tests/probar-beta-channel.mjs'],
	]) {
		if (packageJson.scripts[name] !== command) return findings(`package-script-${name}`);
	}
	let workflow;
	try {
		const document = parseDocument(workflowSource, { uniqueKeys: true });
		if (document.errors.length > 0) return findings('workflow-yaml');
		workflow = document.toJS({ mapAsMap: false });
	} catch {
		return findings('workflow-yaml');
	}
	const steps = workflow?.jobs?.['release-package']?.steps;
	if (!Array.isArray(steps)) return findings('release-job');
	const packageIndexes = indexesWhere(steps, (step) => isExactRun(step, 'npm run release:package'));
	const stageIndexes = indexesWhere(steps, (step) => isExactRun(step, 'npm run beta:artifact'));
	if (packageIndexes.length !== 1 || stageIndexes.length !== 1) return findings('artifact-producer-count');
	if (stageIndexes[0] !== packageIndexes[0] + 1) return findings('artifact-producer-order');
	const uploads = steps.filter((step) => (
		isRecord(step) && typeof step.uses === 'string' && /^actions\/upload-artifact@/iu.test(step.uses)
	));
	if (uploads.length !== 1) return findings('artifact-upload-count');
	const upload = uploads[0];
	if (upload.uses !== UPLOAD_ACTION) return findings('artifact-upload-action');
	if (steps.indexOf(upload) !== stageIndexes[0] + 1) return findings('artifact-upload-order');
	if (!sameKeys(upload, ['uses', 'with']) || !isRecord(upload.with)) return findings('artifact-upload-shape');
	if (!sameKeys(upload.with, Object.keys(UPLOAD_WITH))) return findings('artifact-upload-shape');
	for (const [key, value] of Object.entries(UPLOAD_WITH)) {
		if (upload.with[key] !== value) return findings(`artifact-upload-${key}`);
	}
	return Object.freeze({ findings: [], version: 1 });
}

function indexesWhere(values, predicate) {
	const indexes = [];
	for (const [index, value] of values.entries()) if (predicate(value)) indexes.push(index);
	return indexes;
}

function isExactRun(value, command) {
	return sameKeys(value, ['run']) && value.run === command;
}

function findings(code) {
	return Object.freeze({ findings: [Object.freeze({ code })], version: 1 });
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value, expected) {
	return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	const result = validateBetaChannelContract({
		packageSource: readFileSync(resolve('package.json'), 'utf8'),
		workflowSource: readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'),
	});
	if (result.findings.length > 0) {
		for (const finding of result.findings) process.stderr.write(`beta channel contract: ${finding.code}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write('beta channel contract v1: PASS\n');
	}
}
