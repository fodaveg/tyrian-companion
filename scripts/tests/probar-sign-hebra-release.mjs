import { buildSignCommand, runCli, signerPath } from '../sign-hebra-release.mjs';

let failures = 0;
const hebraRepository = '/hebra';

const command = buildSignCommand({ argv: ['0.7.2'], hebraRepository, nodePath: 'node' });
expect(
	JSON.stringify(command) === JSON.stringify([
		'node', signerPath(hebraRepository), '--plugin', 'tyrian-companion', '--repo', 'fodaveg/tyrian-companion', '--tag', '0.7.2',
	]),
	'plain tag builds the signer command',
);
expect(
	buildSignCommand({ argv: ['0.7.1', '--sin-subir', '--reemplazar'], hebraRepository, nodePath: 'node' }).slice(-2).join(' ') ===
		'--sin-subir --reemplazar',
	'flags are passed through',
);
for (const bad of [[], ['v0.7.2'], ['0.7'], ['0.7.2', '--force'], ['0.7.2; rm -rf /']]) {
	let thrown = false;
	try {
		buildSignCommand({ argv: bad, hebraRepository });
	} catch {
		thrown = true;
	}
	expect(thrown, `rejects ${JSON.stringify(bad)}`);
}

// A missing signer is a clear exit 1 and nothing is executed.
const status = runCli({ argv: ['0.7.2'], env: { HEBRA_REPO: '/nonexistent-hebra-checkout' } });
expect(status === 1, 'missing signer exits 1');

if (failures > 0) {
	process.stderr.write(`sign hebra release suite: ${failures} failure(s)\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('sign hebra release suite: PASS\n');
}

function expect(condition, label) {
	if (condition) {
		process.stdout.write(`PASS: ${label}\n`);
	} else {
		failures += 1;
		process.stderr.write(`FAIL: ${label}\n`);
	}
}
