import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const suitePath = resolve(process.argv[1]);
const scannerPath = resolve(process.env.SECURITY_SCANNER_UNDER_TEST ?? 'scripts/security-scan.mjs');
// eslint-disable-next-line no-unsanitized/method -- The path is an explicit local negative-control injection.
const { scanReleaseArtifacts, scanSecurityBoundaries } = await import(`${pathToFileURL(scannerPath).href}?suite=${String(Date.now())}`);
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-security-scan-'));
const failures = [];

const EXPECTED_RULES = [
	'private-key',
	'known-provider-credential',
	'long-credential-assignment',
	'long-bearer-credential',
	'fixture-credential',
	'production-console-log',
	'production-logger-log',
	'unauthorized-mumble-helper',
];

try {
	testEveryRule();
	testCurrentGithubTokenFormats();
	testMumbleVariants();
	testMumbleContractAllowlist();
	testRepositoryCorpusAndEncodings();
	testFalsePositiveControls();
	testCliRedaction();
	testReleaseArtifactCorpus();
	if (process.env.SECURITY_SCANNER_NEGATIVE_CONTROL !== '1') {
		testCurrentRepository();
		testSabotageControls();
	}
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

function testMumbleVariants() {
	for (const [name, path, source] of [
		['Mumble', 'src/mumble.ts', 'export const Mumble = true;'],
		['MumbleLink', 'src/mumble-link.ts', 'export class MumbleLink {}'],
		['mumbleLink', 'src/native.ts', 'export const mumbleLink = {};'],
		['mumble_link', 'src/native.ts', 'export const mumble_link = {};'],
		['dependency', 'package.json', '{"dependencies":{"obsidian-mumble-helper":"1.0.0"}}'],
	]) {
		const root = isolatedRoot(`mumble-${name}`);
		write(root, path, source);
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
			`${name} variant did not turn red`,
		);
	}
}

function testMumbleContractAllowlist() {
	const allowed = isolatedRoot('mumble-contract-allowed');
	write(allowed, 'src/platform/mumble-v2-contract.ts', [
		'export interface MumbleV2IpcFrameV1 {',
		'  version: 1; nonce: string; sequence: number; tick: number;',
		'  mapId: number; activity: "link_advancing" | "link_stalled";',
		'}',
	].join('\n'));
	write(allowed, 'src/platform/mumble-v2-contract.test.ts', 'Mumble contract test only');
	write(allowed, 'docs/THREAT-MODEL.md', 'Mumble Link contract documentation only.');
	assert(scanSecurityBoundaries(allowed).length === 0, 'exact declarative Mumble contract was not allowlisted');

	for (const path of [
		'src/platform/mumble-v2-contract-helper.ts',
		'src/platform/mumble-v2-runtime.ts',
		'src/platform/helper.ts',
	]) {
		const root = isolatedRoot(`mumble-contract-bypass-${path.replaceAll('/', '-')}`);
		const source = path.endsWith('helper.ts') && !path.includes('mumble')
			? "import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';"
			: 'export interface MumbleHelper {}';
		write(root, path, source);
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
			`${path} bypassed the exact Mumble contract census`,
		);
	}

	for (const [capability, source] of [
		['injection', 'inject(game);'],
		['process', 'spawn(game);'],
		['memory', 'ReadProcessMemory(handle);'],
		['log', 'readGameLog(path);'],
		['traffic', 'interceptTraffic(socket);'],
		['input', 'simulateInput(key);'],
		['automation', 'executeGameAction(action);'],
		['private-data', 'identity: string;'],
		['network', "fetch('https://example.invalid');"],
		['persistence', "localStorage.setItem('key', 'value');"],
		['timer', 'setTimeout(run, 1);'],
	]) {
		const root = isolatedRoot(`mumble-contract-capability-${capability}`);
		write(root, 'src/platform/mumble-v2-contract.ts', source);
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
			`${capability} capability bypassed the Mumble contract allowlist`,
		);
	}
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.stderr.write(`security scanner suite: ${String(failures.length)} failure(s)\n`);
	process.exit(1);
}

process.stdout.write('security scanner suite: PASS\n');

function testEveryRule() {
	const credential = syntheticCredential();
	const providerCredential = ['AK', 'IA', '7F3D9K2M8Q4R6T1Z'].join('');
	const cases = [
		['private-key', 'secrets/key.pem', `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\npayload\n-----END PRIVATE KEY-----`],
		['known-provider-credential', 'config/provider.txt', providerCredential],
		['long-credential-assignment', 'config/local.env', `GW2_API_KEY='${credential}'`],
		['long-bearer-credential', 'config/request.txt', `Authorization: Bearer ${credential}`],
		['fixture-credential', 'src/__fixtures__/credential.ts', `export const apiKey = '${credential}';`],
		['production-console-log', 'src/logging.ts', `console?.['log']('status');`],
		['production-logger-log', 'src/logging.ts', `logger.error('status');`],
		['unauthorized-mumble-helper', 'src/native-helper.ts', 'export class MumbleLink {}'],
	];
	for (const [rule, path, source] of cases) {
		const root = isolatedRoot(`rule-${rule}`);
		write(root, path, source);
		const findings = scanSecurityBoundaries(root);
		assert(findings.some((finding) => finding.rule === rule), `${rule} did not turn red`);
	}
}

function testCurrentGithubTokenFormats() {
	const variants = [
		...['p', 'o', 'u', 's', 'r'].map((kind) => ['gh', `${kind}_`, githubLegacyBody()].join('')),
		['github', '_pat_', githubFineGrainedBody()].join(''),
	];
	for (const [index, credential] of variants.entries()) {
		const root = isolatedRoot(`github-format-${String(index)}`);
		write(root, 'config/provider.txt', credential);
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'known-provider-credential'),
			`current GitHub token format ${String(index)} did not turn red`,
		);
	}
}

function testRepositoryCorpusAndEncodings() {
	const root = isolatedRoot('corpus');
	initializeRepository(root);
	const credential = syntheticCredential();
	write(root, '.gitignore', 'ignored-secret.txt\n');
	write(root, '.npmrc', `//registry.example.invalid/:_authToken='${credential}'\n`);
	write(root, '.env', `GW2_API_KEY=${credential}\n`);
	write(root, 'nested/config.SECRET.JSON', `{"gw2ApiKey":"${credential}"}\n`);
	write(root, 'src/credential.TSX', `export const accessToken = '${credential}';\n`);
	write(root, 'secret.pem', `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\npayload`);
	write(root, 'utf8-bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`apiKey='${credential}'`)]));
	write(root, 'utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`apiKey='${credential}'`, 'utf16le')]));
	write(root, 'utf16be.txt', utf16BeWithBom(`apiKey='${credential}'`));
	write(root, 'utf16-bomless.txt', Buffer.from(`apiKey='${credential}'`, 'utf16le'));
	write(root, 'ignored-secret.txt', `apiKey='${credential}'`);
	git(root, ['add', '.gitignore', '.npmrc', 'nested/config.SECRET.JSON', 'secret.pem', 'src/credential.TSX', 'utf8-bom.txt', 'utf16le.txt', 'utf16be.txt', 'utf16-bomless.txt']);

	const findings = scanSecurityBoundaries(root);
	for (const path of ['.env', '.npmrc', 'nested/config.SECRET.JSON', 'secret.pem', 'src/credential.TSX', 'utf8-bom.txt', 'utf16le.txt', 'utf16be.txt', 'utf16-bomless.txt']) {
		assert(findings.some((finding) => finding.path === path), `${path} was omitted from the repository corpus`);
	}
	assert(!findings.some((finding) => finding.path === 'ignored-secret.txt'), 'gitignored input was scanned');
}

function testFalsePositiveControls() {
	const root = isolatedRoot('false-positives');
	write(root, 'src/__fixtures__/shape.ts', 'export interface RequestShape { Authorization?: string; }');
	write(root, 'src/config.ts', "export const apiKey = 'example-placeholder-not-a-credential';");
	write(root, 'src/config-exact.ts', "export const bearerToken = 'must-not-be-persisted';");
	write(root, 'src/preview.ts', "export const token = 'opaque-preview-token';");
	write(root, 'src/config-identifier.ts', 'export const token = someLongVariableIdentifier;');
	write(root, 'src/telemetry-model.ts', 'export interface TelemetryState { enabled: false }');
	write(root, 'docs/THREAT-MODEL.md', 'Mumble Link and Bearer credentials are discussed here without values.');
	assert(scanSecurityBoundaries(root).length === 0, 'safe schemas, placeholders, or documentation caused a false positive');

	const bypassRoot = isolatedRoot('substring-bypass');
	write(bypassRoot, 'src/config.ts', ["export const apiT", "oken = 'live-example-fragment-A7z9Q2m4X6c8V1b3';"].join(''));
	assert(
		scanSecurityBoundaries(bypassRoot).some((finding) => finding.rule === 'long-credential-assignment'),
		'arbitrary values containing example bypassed the exact synthetic allowlist',
	);
}

function testCliRedaction() {
	const root = isolatedRoot('cli');
	const credential = syntheticCredential();
	write(root, 'src/__fixtures__/credential.ts', `export const apiKey = '${credential}';`);
	const result = spawnSync(process.execPath, [scannerPath, root], { encoding: 'utf8' });
	assert(result.status !== 0, 'CLI accepted a controlled credential');
	assert(result.stderr.includes('fixture-credential'), 'CLI did not identify the fixture rule');
	assert(result.stderr.includes('"src/__fixtures__/credential.ts"'), 'CLI did not safely quote the finding path');
	assert(!result.stderr.includes(credential), 'CLI exposed the matched credential value');
}

function testReleaseArtifactCorpus() {
	const root = isolatedRoot('release-artifact');
	const credential = syntheticCredential();
	write(root, 'manifest.json', '{"id":"tyrian-companion"}');
	write(root, 'main.js', `const apiKey = '${credential}';`);
	write(root, 'styles.css', '.safe { color: red; }');
	const findings = scanReleaseArtifacts(root, ['manifest.json', 'main.js', 'styles.css']);
	assert(
		findings.some((finding) => finding.path === 'main.js' && finding.rule === 'long-credential-assignment'),
		'built main.js was omitted from the release artifact scanner',
	);
	assert(
		scanReleaseArtifacts(root, ['manifest.json', 'main.js']).some((finding) => finding.rule === 'release-artifact-set'),
		'incomplete release artifact set did not turn red',
	);
}

function testCurrentRepository() {
	const findings = scanSecurityBoundaries(process.cwd());
	assert(findings.length === 0, `current repository produced ${String(findings.length)} security finding(s)`);
}

function testSabotageControls() {
	for (const rule of EXPECTED_RULES) {
		const stub = createFilteringStub(rule);
		const result = runSuiteAgainst(stub);
		assertCausalFailure(result, `${rule} did not turn red`, `disabling ${rule}`);
	}
	const alwaysGreen = join(testRoot, 'always-green.mjs');
	writeFileSync(alwaysGreen, [
		'export function scanSecurityBoundaries() { return []; }',
		'export function scanReleaseArtifacts() { return []; }',
	].join('\n'));
	assertCausalFailure(runSuiteAgainst(alwaysGreen), 'private-key did not turn red', 'always-green scanner');
}

function assertCausalFailure(result, expectedMessage, sabotage) {
	assert(result.error === undefined, `${sabotage} crashed before the suite ran: ${String(result.error)}`);
	assert(result.signal === null, `${sabotage} terminated the suite with signal ${String(result.signal)}`);
	assert(result.status === 1, `${sabotage} exited ${String(result.status)} instead of a controlled test failure`);
	assert(result.stderr.includes(`FAIL: ${expectedMessage}`), `${sabotage} lacked causal failure ${JSON.stringify(expectedMessage)}`);
	assert(!/\b(?:SyntaxError|TypeError|ReferenceError)\b|node:internal|\n\s*at\s+/u.test(result.stderr), `${sabotage} produced a runtime crash instead of an assertion`);
}

function createFilteringStub(rule) {
	const directory = join(testRoot, `sabotage-${rule}`);
	mkdirSync(directory, { recursive: true });
	const stub = join(directory, 'scanner.mjs');
	const actualUrl = pathToFileURL(resolve('scripts/security-scan.mjs')).href;
	writeFileSync(stub, [
		`import { resolve } from 'node:path';`,
		`import { pathToFileURL } from 'node:url';`,
		`import { scanSecurityBoundaries as actual } from ${JSON.stringify(actualUrl)};`,
		`export function scanSecurityBoundaries(root) { return actual(root).filter((finding) => finding.rule !== ${JSON.stringify(rule)}); }`,
		`export function scanReleaseArtifacts() { return []; }`,
		`if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {`,
		`  const findings = scanSecurityBoundaries(process.argv[2]);`,
		`  if (findings.length > 0) { for (const finding of findings) console.error('- ' + JSON.stringify(finding.path) + ': ' + finding.rule); process.exitCode = 1; }`,
		`}`,
	].join('\n'));
	return stub;
}

function runSuiteAgainst(scanner) {
	return spawnSync(process.execPath, [suitePath], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: {
			...process.env,
			SECURITY_SCANNER_NEGATIVE_CONTROL: '1',
			SECURITY_SCANNER_UNDER_TEST: scanner,
		},
	});
}

function initializeRepository(root) {
	git(root, ['init', '-q', '-b', 'main']);
}

function git(root, args) {
	const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
	assert(result.status === 0, `git ${args[0] ?? 'command'} failed in isolated corpus`);
}

function isolatedRoot(name) {
	const root = join(testRoot, name);
	mkdirSync(root, { recursive: true });
	return root;
}

function write(root, path, content) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function syntheticCredential() {
	return ['Tyr1an', 'Boundary', '7f9Q', 'SafeProbe'].join('-');
}

function githubLegacyBody() {
	return 'A7z9Q2m4X6c8V1b3N5d7F9h2J4k6L8p0R3s5';
}

function githubFineGrainedBody() {
	return 'A7z9_Q2m4_X6c8_V1b3_N5d7_F9h2_J4k6_L8p0_R3s5_T7u9_W2x4_Y6z8_B1c3_D5f7_G9h2_J4k6L8p';
}

function utf16BeWithBom(value) {
	const littleEndian = Buffer.from(value, 'utf16le');
	for (let index = 0; index < littleEndian.length; index += 2) {
		const first = littleEndian[index];
		littleEndian[index] = littleEndian[index + 1];
		littleEndian[index + 1] = first;
	}
	return Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian]);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
