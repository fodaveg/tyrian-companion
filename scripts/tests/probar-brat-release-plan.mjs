import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateBratRelease } from '../brat-release-contract.mjs';
import { BratReleasePlanError, planBratRelease, releaseFromGitHubPayload } from '../brat-release-plan.mjs';

const failures = [];
const testRoot = mkdtempSync(join(tmpdir(), 'brat-release-plan-'));
const MANIFEST = { id: 'tyrian-companion', version: '9.9.9', name: 'Tyrian Companion', author: 'fodaveg', minAppVersion: '1.0.0', description: 'x', isDesktopOnly: true };

try {
	testCompleteStagingPassesTheContract();
	testMissingAssetIsCaughtBeforePublishing();
	testEmptyAssetIsCaughtBeforePublishing();
	testDirectoryInsteadOfAssetIsCaught();
	testTagMismatchIsCaughtByTheContract();
	testGitHubPayloadTranslation();
	testTheContractActuallyJudgesThePlan();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`brat release plan suite: ${failure}\n`);
	process.stderr.write(`brat release plan suite: FAIL (${failures.length})\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('brat release plan suite: PASS\n');
}

/** The happy path: complete staging produces a plan the published-release contract accepts. */
function testCompleteStagingPassesTheContract() {
	const root = stage('complete', {});
	const plan = planBratRelease(root);
	const findings = validateBratRelease({ manifest: MANIFEST, release: plan });
	assert(findings.length === 0, `complete staging was rejected with [${findings.join(', ')}]`);
	assert(plan.assets.length === 5, `the plan declared ${plan.assets.length} assets instead of 5`);
	assert(plan.isDraft === false, 'the plan declared a draft release');
	assert(plan.tagName === MANIFEST.version, 'the plan tag does not match the manifest version');
}

/**
 * The 0.1.19 failure, reproduced. A release published without its assets has to
 * be impossible to reach: the plan must refuse to exist, not describe a release
 * that is missing files.
 */
function testMissingAssetIsCaughtBeforePublishing() {
	for (const omitted of ['main.js', 'manifest.json', 'styles.css', 'tyrian-companion-9.9.9.zip', 'tyrian-companion-9.9.9.zip.sha256']) {
		const root = stage(`missing-${omitted}`, { omit: [omitted] });
		assertPlanRefuses(`missing ${omitted}`, root, 'asset-missing');
	}
}

function testEmptyAssetIsCaughtBeforePublishing() {
	const root = stage('empty-bundle', { empty: ['main.js'] });
	assertPlanRefuses('an empty main.js', root, 'asset-empty');
}

function testDirectoryInsteadOfAssetIsCaught() {
	const root = stage('directory-asset', { omit: ['styles.css'] });
	mkdirSync(join(root, '.release', MANIFEST.id, 'styles.css'), { recursive: true });
	assertPlanRefuses('a directory where styles.css should be', root, 'asset-not-regular');
}

/** A staged tree whose manifest version drifted from the tag must not publish either. */
function testTagMismatchIsCaughtByTheContract() {
	const root = stage('complete-for-tag', {});
	const plan = planBratRelease(root);
	const findings = validateBratRelease({ manifest: { ...MANIFEST, version: '9.9.8' }, release: plan });
	assert(findings.includes('release-asset-set') || findings.includes('tag-manifest-mismatch'), `a drifted version was accepted: [${findings.join(', ')}]`);
}

function testGitHubPayloadTranslation() {
	const published = releaseFromGitHubPayload({
		tag_name: '9.9.9',
		name: '9.9.9',
		draft: false,
		assets: [
			{ name: 'main.js', state: 'uploaded', size: 10 },
			{ name: 'manifest.json', state: 'uploaded', size: 10 },
			{ name: 'styles.css', state: 'uploaded', size: 10 },
			{ name: 'tyrian-companion-9.9.9.zip', state: 'uploaded', size: 10 },
			{ name: 'tyrian-companion-9.9.9.zip.sha256', state: 'uploaded', size: 10 },
		],
	});
	assert(validateBratRelease({ manifest: MANIFEST, release: published }).length === 0, 'a correct GitHub payload was rejected');

	const draft = releaseFromGitHubPayload({ tag_name: '9.9.9', name: '9.9.9', draft: true, assets: [] });
	assert(validateBratRelease({ manifest: MANIFEST, release: draft }).includes('release-not-published'), 'a draft release was accepted');

	const assetless = releaseFromGitHubPayload({ tag_name: '9.9.9', name: '9.9.9', draft: false, assets: [] });
	assert(validateBratRelease({ manifest: MANIFEST, release: assetless }).includes('release-asset-set'), 'an assetless release was accepted');

	try {
		releaseFromGitHubPayload(null);
		assert(false, 'a null GitHub payload was accepted');
	} catch (error) {
		assert(error instanceof BratReleasePlanError, 'a null GitHub payload threw the wrong error type');
	}
}

/**
 * Negative control on the wiring itself. If the contract ignored the plan, every
 * assertion above would still pass, so this deliberately hands it a plan that is
 * wrong in one field and demands a red.
 */
function testTheContractActuallyJudgesThePlan() {
	const root = stage('control', {});
	const plan = planBratRelease(root);
	for (const [label, mutate, finding] of [
		['a draft plan', (value) => ({ ...value, isDraft: true }), 'release-not-published'],
		['a mislabelled release name', (value) => ({ ...value, name: 'v9.9.9' }), 'release-name-mismatch'],
		['a mismatched tag', (value) => ({ ...value, tagName: '1.0.0' }), 'tag-manifest-mismatch'],
		['an extra asset', (value) => ({ ...value, assets: [...value.assets, { name: 'extra.txt', state: 'uploaded', size: 1 }] }), 'release-asset-set'],
		['an asset still uploading', (value) => ({ ...value, assets: value.assets.map((asset, index) => (index === 0 ? { ...asset, state: 'starter' } : asset)) }), 'release-asset-incomplete'],
		['a zero byte asset', (value) => ({ ...value, assets: value.assets.map((asset, index) => (index === 0 ? { ...asset, size: 0 } : asset)) }), 'release-asset-empty'],
	]) {
		const findings = validateBratRelease({ manifest: MANIFEST, release: mutate(plan) });
		assert(findings.includes(finding), `${label} did not turn red with ${finding}; got [${findings.join(', ')}]`);
	}
}

function stage(name, { omit = [], empty = [] }) {
	const root = join(testRoot, name);
	const archive = `${MANIFEST.id}-${MANIFEST.version}.zip`;
	const entries = [
		[join('.release', MANIFEST.id, 'manifest.json'), 'manifest.json', JSON.stringify(MANIFEST)],
		[join('.release', MANIFEST.id, 'main.js'), 'main.js', 'console.log(1);\n'],
		[join('.release', MANIFEST.id, 'styles.css'), 'styles.css', '.a{color:red}\n'],
		[join('.release', archive), archive, 'PKfake-archive\n'],
		[join('.release', `${archive}.sha256`), `${archive}.sha256`, `${'0'.repeat(64)}  ${archive}\n`],
	];
	write(root, 'manifest.json', JSON.stringify(MANIFEST));
	for (const [path, assetName, content] of entries) {
		if (omit.includes(assetName)) continue;
		write(root, path, empty.includes(assetName) ? '' : content);
	}
	return root;
}

function write(root, path, content) {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}

function assertPlanRefuses(label, root, code) {
	try {
		planBratRelease(root);
		assert(false, `${label} produced a plan instead of refusing`);
	} catch (error) {
		assert(error instanceof BratReleasePlanError, `${label} threw an unexpected error type`);
		assert(error.code === code, `${label} refused with '${error?.code}' instead of '${code}'`);
	}
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
