import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/u;
const PLUGIN = 'tyrian-companion';
const REPOSITORY = 'fodaveg/tyrian-companion';
const PASS_THROUGH_FLAGS = Object.freeze(['--sin-subir', '--reemplazar']);

/**
 * Thin wrapper over Hebra's release signer. Hebra only installs this plugin when the release carries
 * `hebra.json.minisig` (minisign signature of the bytes of `hebra.json`). The private key lives only
 * on the author's machine, so the signature is added locally AFTER the workflow publishes the release:
 * `npm run release:sign -- <tag> [--sin-subir] [--reemplazar]`.
 *
 * This file never reads or prints the key; the signer owns it.
 */

/** Returns the path of Hebra's signer inside the Hebra checkout. */
export function signerPath(hebraRepository) {
	return join(hebraRepository, 'scripts', 'firmar-release-plugin.mjs');
}

/**
 * Pure: builds the argv (without executing anything) or throws `Error(category)` on bad usage.
 * The tag only has to be `x.y.z`; it is NOT compared with `manifest.json` so an older release can be signed.
 */
export function buildSignCommand({ argv, hebraRepository, nodePath = process.execPath }) {
	const [tag, ...flags] = argv;
	if (typeof tag !== 'string' || !SEMVER.test(tag)) throw new Error('usage: tag must be x.y.z');
	for (const flag of flags) {
		if (!PASS_THROUGH_FLAGS.includes(flag)) throw new Error(`usage: unknown flag ${flag}`);
	}
	return [
		nodePath,
		signerPath(hebraRepository),
		'--plugin',
		PLUGIN,
		'--repo',
		REPOSITORY,
		'--tag',
		tag,
		...new Set(flags),
	];
}

export function runCli({ argv = process.argv.slice(2), env = process.env } = {}) {
	const hebraRepository = resolve(env.HEBRA_REPO ?? join(homedir(), 'code', 'hebra'));
	let command;
	try {
		command = buildSignCommand({ argv, hebraRepository });
	} catch (error) {
		process.stderr.write(`release:sign: ${error instanceof Error ? error.message : 'usage'}\n`);
		process.stderr.write('usage: npm run release:sign -- <x.y.z> [--sin-subir] [--reemplazar]\n');
		return 1;
	}
	if (!existsSync(command[1])) {
		process.stderr.write(`release:sign: signer not found at ${command[1]} (set HEBRA_REPO to your Hebra checkout)\n`);
		return 1;
	}
	const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
	if (result.error) {
		process.stderr.write(`release:sign: could not run the signer: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

const isDirectExecution = process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) process.exitCode = runCli();
