import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
	testMumbleShadowAllowlist();
	testRepositoryCorpusAndEncodings();
	testFalsePositiveControls();
	testCanonicalLocalDebugBoundary();
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

	const core = isolatedRoot('mumble-core-allowed');
	write(core, 'src/platform/mumble-v2-contract.ts', 'export interface MumbleV2IpcFrameV1 {}');
	write(core, 'src/platform/mumble-v2-codec.ts', [
		"import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';",
		'export function decode(): MumbleV2IpcFrameV1 { return {}; }',
	].join('\n'));
	write(core, 'src/platform/mumble-v2-client.ts', [
		"import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';",
		"import { decode } from './mumble-v2-codec';",
		'export class MumbleV2Client { read(): MumbleV2IpcFrameV1 { return decode(); } }',
	].join('\n'));
	write(core, 'src/platform/mumble-v2-health.ts', [
		"import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';",
		'export type MumbleHealth = MumbleV2IpcFrameV1;',
	].join('\n'));
	write(core, 'src/platform/mumble-v2-observation.ts', [
		"import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';",
		'export type MumbleObservation = MumbleV2IpcFrameV1;',
	].join('\n'));
	assert(scanSecurityBoundaries(core).length === 0, 'exact pure Mumble core was not allowlisted');

	const launch = isolatedRoot('mumble-launch-allowed');
	write(launch, 'src/platform/mumble-v2-launch-contract.ts', [
		'export interface MumbleV2WindowsLaunchConfigV1 { version: 1; platform: "windows_native"; helperPackageDirectory: string }',
		'export interface MumbleV2LaunchDiagnosticV1 { version: 1; stage: "spawn"; code: "spawn_failed"; retryable: boolean; artifactIntegrity: "integrity_checked"; artifactTrust: "unsigned_qa_only" }',
	].join('\n'));
	write(launch, 'src/platform/mumble-v2-launch-plan.ts', [
		"import type { MumbleV2WindowsLaunchConfigV1 } from './mumble-v2-launch-contract';",
		'export const plan = (config: MumbleV2WindowsLaunchConfigV1) => ({ config, shell: false });',
	].join('\n'));
	write(launch, 'src/platform/mumble-v2-process-adapter.ts',
		readFileSync('src/platform/mumble-v2-process-adapter.ts', 'utf8'));
	assert(scanSecurityBoundaries(launch).length === 0, 'exact safe Mumble launch boundary was not allowlisted');

	for (const [capability, path, source] of [
		['shell-true', 'src/platform/mumble-v2-launch-plan.ts', 'const unsafe = { shell: true };'],
		['shell-indirect', 'src/platform/mumble-v2-launch-plan.ts', 'const value = true; const unsafe = { shell: value };'],
		['shell-shorthand', 'src/platform/mumble-v2-launch-plan.ts', 'const shell = true; const unsafe = { shell };'],
		['mapping-config', 'src/platform/mumble-v2-launch-contract.ts', 'export interface MumbleV2LaunchConfig { mapping: string }'],
		['free-args', 'src/platform/mumble-v2-launch-contract.ts', 'export interface MumbleV2LaunchConfig { args: string[] }'],
		['free-env', 'src/platform/mumble-v2-launch-contract.ts', 'export interface MumbleV2LaunchConfig { env: object }'],
		['path-diagnostic', 'src/platform/mumble-v2-launch-contract.ts', 'export interface MumbleV2LaunchDiagnostic { path: string }'],
		['pid-diagnostic', 'src/platform/mumble-v2-launch-contract.ts', 'export interface MumbleV2LaunchDiagnostic { pid: number }'],
		['sync-callback', 'src/platform/mumble-v2-process-adapter.ts', 'callbacks.stdout(chunk);'],
		['builtin-process', 'src/platform/mumble-v2-process-adapter.ts', "process.getBuiltinModule('node:child_process');"],
		['computed-process', 'src/platform/mumble-v2-process-adapter.ts', "process['getBuiltinModule']('node:child_process');"],
		['global-process', 'src/platform/mumble-v2-process-adapter.ts', "globalThis.process.getBuiltinModule('node:child_process');"],
		['computed-global-process', 'src/platform/mumble-v2-process-adapter.ts', "globalThis['process']['getBuiltinModule']('node:child_process');"],
		['aliased-process', 'src/platform/mumble-v2-process-adapter.ts', "const hostProcess = process; hostProcess.getBuiltinModule('node:child_process');"],
		['global-alias-process', 'src/platform/mumble-v2-process-adapter.ts', "const hostProcess = global.process; hostProcess.getBuiltinModule('node:child_process').spawn('x');"],
		['global-this-global-process', 'src/platform/mumble-v2-process-adapter.ts', "const hostProcess = globalThis.global.process; hostProcess['getBuiltinModule']('node:child_process');"],
		['eval-process', 'src/platform/mumble-v2-process-adapter.ts', "const hostProcess = (0, eval)('process'); hostProcess.getBuiltinModule('node:child_process');"],
		['function-process', 'src/platform/mumble-v2-process-adapter.ts', "const hostProcess = Function('return process')(); hostProcess.getBuiltinModule('node:child_process');"],
		['any-get-builtin-module', 'src/platform/mumble-v2-process-adapter.ts', "hostAuthority['getBuiltinModule']('node:child_process');"],
		['indirect-require-child-process', 'src/platform/mumble-v2-process-adapter.ts', "(0, require)('node:child_process').spawn('x');"],
		['module-constructor-load', 'src/platform/mumble-v2-process-adapter.ts', "module.constructor._load('node:child_process').spawn('x');"],
		['inline-deliver', 'src/platform/mumble-v2-process-adapter.ts', 'const deliver = (callback) => callback();'],
		['second-spawn-route', 'src/platform/mumble-v2-process-adapter.ts', 'export function unsafeSpawn(port, plan, capability, callbacks) { return port.spawnIntegrityChecked(plan, capability, callbacks); }'],
		['reflective-spawn-route', 'src/platform/mumble-v2-process-adapter.ts', 'export function unsafeReflect(port, plan, capability, callbacks) { const run = Reflect.get(port, "spawnIntegrityChecked"); return run(plan, capability, callbacks); }'],
		['host-pid', 'src/platform/mumble-v2-process-adapter.ts', 'interface MumbleV2HostUnsafe { pid: number }'],
		['host-path', 'src/platform/mumble-v2-process-adapter.ts', 'interface MumbleV2HostUnsafe { path: string }'],
		['host-token', 'src/platform/mumble-v2-process-adapter.ts', 'interface MumbleV2HostUnsafe { token: string }'],
	]) {
		const root = isolatedRoot(`mumble-launch-capability-${capability}`);
		for (const allowedPath of [
			'src/platform/mumble-v2-launch-contract.ts',
			'src/platform/mumble-v2-launch-plan.ts',
			'src/platform/mumble-v2-process-adapter.ts',
		]) {
			write(root, allowedPath, readFileSync(join(launch, allowedPath), 'utf8'));
		}
		write(root, path, `${readFileSync(join(root, path), 'utf8')}\n${source}`);
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
			`${capability} bypassed the safe Mumble launch allowlist`,
		);
	}

	const deliveryRoot = isolatedRoot('mumble-launch-delivery-shape');
	for (const allowedPath of [
		'src/platform/mumble-v2-launch-contract.ts',
		'src/platform/mumble-v2-launch-plan.ts',
		'src/platform/mumble-v2-process-adapter.ts',
	]) {
		write(deliveryRoot, allowedPath, readFileSync(join(launch, allowedPath), 'utf8'));
	}
	const adapterPath = join(deliveryRoot, 'src/platform/mumble-v2-process-adapter.ts');
	const adapterSource = readFileSync(adapterPath, 'utf8');
	const reviewedDelivery = "\t\t\t\tif (prematureFailure) {\n\t\t\t\t\tcloseAfterReturn();";
	assert(adapterSource.includes(reviewedDelivery), 'reviewed deferred delivery shape was not found');
	writeFileSync(adapterPath, adapterSource.replace(
		reviewedDelivery,
		"\t\t\t\tif (false) {\n\t\t\t\t\tcloseAfterReturn();",
	));
	assert(
		scanSecurityBoundaries(deliveryRoot).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
		'deferred delivery mutation bypassed the safe Mumble launch allowlist',
	);

	for (const [capability, source] of [
		['fs-import', "import { readFile } from 'node:fs';"],
		['fs-side-effect-import', "import 'node:fs';"],
		['fs-commented-side-effect-import', "import /*x*/ 'node:fs';"],
		['fs-commented-from-import', "import { readFile } from/*x*/ 'node:fs';"],
		['fs-commented-export-from', "export { readFile } from/*x*/ 'node:fs';"],
		['fs-commented-import-equals', "import fs = require/*x*/('node:fs');"],
		['net-import', "import { connect } from 'node:net';"],
		['dynamic-import', "void import/*x*/('node:fs');"],
		['require-call', "require/*x*/('node:fs');"],
		['session-import', "import { SessionService } from '../sessions/session-service';"],
		['capture', 'export const capture = () => undefined;'],
		['store-import', "import { SessionStore } from '../sessions/session-store';"],
		['logger', "logger.info('mumble');"],
		['global-timer', 'setTimeout(run, 500);'],
	]) {
		const root = isolatedRoot(`mumble-core-capability-${capability}`);
		write(root, 'src/platform/mumble-v2-client.ts', [
			"import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';",
			"import { decode } from './mumble-v2-codec';",
			source,
		].join('\n'));
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
			`${capability} bypassed the pure Mumble core allowlist`,
		);
	}

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

	const afterTests = isolatedRoot('native-mumble-after-tests');
	write(afterTests, 'native/mumble-helper/src/main.rs', [
		'#[cfg(test)]',
		'mod tests { const PID: u32 = 7; }',
		'fn connect_external() { TcpStream::connect("8.8.8.8:80"); }',
	].join('\n'));
	assert(
		scanSecurityBoundaries(afterTests).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
		'native production code after a cfg(test) module bypassed the scanner',
	);
}

function testMumbleShadowAllowlist() {
	const productFiles = [
		'src/platform/mumble-v2-presence-policy.ts',
		'src/sessions/mumble-v2-shadow-proposal.ts',
	];
	const allowed = isolatedRoot('mumble-shadow-allowed');
	for (const path of productFiles) write(allowed, path, readFileSync(path, 'utf8'));
	assert(scanSecurityBoundaries(allowed).length === 0, 'exact H8.8 shadow boundary was not allowlisted');

	for (const [capability, path, source] of [
		['fs-import', productFiles[0], "import { readFile } from 'node:fs';"],
		['network', productFiles[0], 'fetch("https://example.invalid");'],
		['computed-timer', productFiles[0], 'globalThis["setTimeout"](() => undefined, 1);'],
		['persistence', productFiles[1], 'indexedDB.open("mumble-shadow");'],
		['save-data', productFiles[1], 'saveData({ projection: true });'],
		['raw-nonce', productFiles[1], 'interface LeakedFrame { nonce: string }'],
		['raw-frame-type', productFiles[1], 'interface LeakedFrame { frame: MumbleV2IpcFrameV1 }'],
		['lifecycle-transition', productFiles[1], 'transitionSession(state, event);'],
		['computed-lifecycle', productFiles[1], 'runtime["start"]();'],
		['pending-service', productFiles[1], 'const queue: PendingProposalService = pending;'],
		['pending-enqueue', productFiles[1], 'pending.enqueue(candidate);'],
	]) {
		const root = isolatedRoot(`mumble-shadow-capability-${capability}`);
		for (const reviewedPath of productFiles) {
			write(root, reviewedPath, readFileSync(reviewedPath, 'utf8'));
		}
		write(root, path, `${readFileSync(join(root, path), 'utf8')}\n${source}`);
		const findings = scanSecurityBoundaries(root);
		assert(
			findings.some((finding) => finding.rule === 'unauthorized-mumble-helper'),
			`${capability} bypassed the H8.8 shadow boundary: ${JSON.stringify(findings)}`,
		);
	}

	const shape = isolatedRoot('mumble-shadow-proposal-shape');
	for (const path of productFiles) write(shape, path, readFileSync(path, 'utf8'));
	const proposalPath = join(shape, productFiles[1]);
	writeFileSync(proposalPath, readFileSync(proposalPath, 'utf8').replace(
		"\treadonly effect: 'proposal_only';",
		"\treadonly effect: 'proposal_only';\n\treadonly automatic: boolean;",
	));
	assert(
		scanSecurityBoundaries(shape).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
		'expanded shadow proposal shape bypassed the H8.8 boundary',
	);

	for (const [name, needle, replacement] of [
		[
			'presence-context',
			'\treadonly authority: MumbleV2PresenceAuthority;',
			'\treadonly authority: MumbleV2PresenceAuthority;\n\treadonly persisted: boolean;',
		],
		[
			'presence-state',
			'\treadonly stopLatchedBinding: string | null;',
			'\treadonly stopLatchedBinding: string | null;\n\treadonly queueDepth: number;',
		],
	]) {
		const presenceShape = isolatedRoot(`mumble-shadow-${name}-shape`);
		for (const path of productFiles) write(presenceShape, path, readFileSync(path, 'utf8'));
		const presencePath = join(presenceShape, productFiles[0]);
		writeFileSync(presencePath, readFileSync(presencePath, 'utf8').replace(needle, replacement));
		assert(
			scanSecurityBoundaries(presenceShape).some((finding) =>
				finding.rule === 'unauthorized-mumble-helper'),
			`expanded ${name} shape bypassed the H8.8 boundary`,
		);
	}

	const third = isolatedRoot('mumble-shadow-third-module');
	for (const path of productFiles) write(third, path, readFileSync(path, 'utf8'));
	write(third, 'src/platform/mumble-v2-shadow-runtime.ts', 'export const runtime = true;');
	assert(
		scanSecurityBoundaries(third).some((finding) =>
			finding.path === 'src/platform/mumble-v2-shadow-runtime.ts' &&
			finding.rule === 'unauthorized-mumble-helper'),
		'third H8.8 shadow module bypassed the exact scanner census',
	);
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

function testCanonicalLocalDebugBoundary() {
	const allowed = isolatedRoot('canonical-local-debug-boundary');
	write(allowed, 'src/action.ts', [
		"import type { LocalDebugLogger } from './core/local-debug-logger';",
		'export function act(diagnostics: LocalDebugLogger) {',
		"  diagnostics.record({ level: 'info', component: 'plugin', action: 'plugin_load', phase: 'success', code: 'ok', actionId: 'a', correlationId: 'a' });",
		'}',
	].join('\n'));
	assert(scanSecurityBoundaries(allowed).length === 0, 'canonical local debug boundary was not allowlisted');

	for (const [name, source] of [
		['renamed-info', "const audit = { info() {} }; audit.info('status');"],
		['renamed-computed-warn', "const sink = { warn() {} }; sink['warn']('status');"],
		['renamed-optional-error', "diagnostics?.error('status');"],
	]) {
		const root = isolatedRoot(`arbitrary-local-debug-${name}`);
		write(root, 'src/arbitrary-diagnostics.ts', source);
		assert(
			scanSecurityBoundaries(root).some((finding) => finding.rule === 'production-logger-log'),
			`${name} bypassed the canonical local debug boundary`,
		);
	}

	const mumble = isolatedRoot('mumble-local-debug-import');
	write(mumble, 'src/platform/mumble-v2-client.ts', [
		"import type { MumbleV2IpcFrameV1 } from './mumble-v2-contract';",
		"import { decode } from './mumble-v2-codec';",
		"import type { LocalDebugLogger } from '../core/local-debug-logger';",
	].join('\n'));
	assert(
		scanSecurityBoundaries(mumble).some((finding) => finding.rule === 'unauthorized-mumble-helper'),
		'H8 Mumble core imported the canonical local debug boundary',
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
