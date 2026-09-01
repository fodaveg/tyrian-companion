import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedBratReleaseAssets } from './brat-release-contract.mjs';

export const BRAT_RELEASE_PLAN_VERSION = 1;

const RELEASE_DIRECTORY = '.release';

/**
 * The BRAT contract already knows how to judge a release, but it was only ever
 * pointed at a release that HAD been published: 0.1.19 went out without its
 * assets and the contract confirmed the damage afterwards. Verification after
 * publication is not a gate, it is a post mortem.
 *
 * So this builds the release metadata the publication is ABOUT to create, out of
 * the bytes actually staged on disk, in exactly the shape the contract judges.
 * Feeding that to the contract turns it into a gate: if the plan is wrong,
 * nothing is published.
 */
export function planBratRelease(root = process.cwd()) {
	const manifest = readJson(resolve(root, 'manifest.json'), 'manifest-unavailable');
	const releaseRoot = resolve(root, RELEASE_DIRECTORY);
	const expected = expectedBratReleaseAssets(manifest);

	const assets = expected.map((name) => {
		const path = locateAsset(releaseRoot, manifest, name);
		const size = regularFileSize(path, name);
		return { name, state: 'uploaded', size, path };
	});

	return {
		planVersion: BRAT_RELEASE_PLAN_VERSION,
		tagName: manifest.version,
		name: manifest.version,
		isDraft: false,
		assets,
	};
}

/**
 * `release-package.mjs` stages the three plugin files under `.release/<id>/` and
 * leaves the archive and its checksum at the root of `.release/`. Resolving the
 * path here, rather than in shell glue, is what stops the workflow from
 * uploading four assets and calling it five.
 */
function locateAsset(releaseRoot, manifest, name) {
	const archive = `${manifest.id}-${manifest.version}.zip`;
	if (name === archive || name === `${archive}.sha256`) return resolve(releaseRoot, name);
	return resolve(releaseRoot, manifest.id, name);
}

function regularFileSize(path, name) {
	let status;
	try {
		status = lstatSync(path);
	} catch {
		throw new BratReleasePlanError('asset-missing', `brat release plan: ${name} is not staged at ${path}`);
	}
	if (!status.isFile()) {
		throw new BratReleasePlanError('asset-not-regular', `brat release plan: ${name} is not a regular file`);
	}
	if (status.size <= 0) {
		throw new BratReleasePlanError('asset-empty', `brat release plan: ${name} is empty`);
	}
	return status.size;
}

/**
 * Translates GitHub's own release payload into the shape the contract judges, so
 * the same contract can be run a second time against what was really published.
 * The gate is the pre-publication run; this is the confirmation that the upload
 * did what the plan said.
 */
export function releaseFromGitHubPayload(payload) {
	if (!isRecord(payload)) throw new BratReleasePlanError('github-payload', 'brat release plan: unusable GitHub payload');
	const assets = Array.isArray(payload.assets) ? payload.assets : null;
	if (assets === null) throw new BratReleasePlanError('github-payload', 'brat release plan: GitHub payload has no assets array');
	return {
		tagName: payload.tag_name,
		name: payload.name,
		isDraft: payload.draft === true,
		assets: assets.map((asset) => ({
			name: isRecord(asset) ? asset.name : undefined,
			state: isRecord(asset) ? asset.state : undefined,
			size: isRecord(asset) ? asset.size : undefined,
		})),
	};
}

export class BratReleasePlanError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function readJson(path, code) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new BratReleasePlanError(code, `brat release plan: ${code}`);
	}
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runCli({ argv = process.argv.slice(2), root = process.cwd() } = {}) {
	try {
		if (argv[0] === '--from-staging' && argv.length === 1) {
			const plan = planBratRelease(root);
			// `path` is local scaffolding for the workflow; it is not part of the release shape.
			const { assets, ...rest } = plan;
			process.stdout.write(`${JSON.stringify({ ...rest, assets: assets.map(({ path, ...asset }) => asset) }, null, '\t')}\n`);
			return 0;
		}
		if (argv[0] === '--asset-paths' && argv.length === 1) {
			for (const asset of planBratRelease(root).assets) process.stdout.write(`${asset.path}\n`);
			return 0;
		}
		if (argv[0] === '--from-github' && argv.length === 2) {
			const source = argv[1] === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(argv[1]), 'utf8');
			process.stdout.write(`${JSON.stringify(releaseFromGitHubPayload(JSON.parse(source)), null, '\t')}\n`);
			return 0;
		}
		process.stderr.write('brat release plan: usage --from-staging | --asset-paths | --from-github <file|->\n');
		return 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : 'brat release plan: unexpected-failure'}\n`);
		return 1;
	}
}

const isDirectExecution = process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = runCli();
