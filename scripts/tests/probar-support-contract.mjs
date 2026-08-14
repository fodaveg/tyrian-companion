import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';

import { validateSupportContract } from '../support-contract.mjs';

const root = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), 'tyrian-support-contract-'));
const failures = [];
const files = new Map([
	['.github/ISSUE_TEMPLATE/bug_report.yml', readFileSync(resolve(root, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8')],
	['.github/ISSUE_TEMPLATE/config.yml', readFileSync(resolve(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8')],
	['docs/SUPPORT.md', readFileSync(resolve(root, 'docs/SUPPORT.md'), 'utf8')],
	['docs/API-KEY.md', readFileSync(resolve(root, 'docs/API-KEY.md'), 'utf8')],
	['README.md', readFileSync(resolve(root, 'README.md'), 'utf8')],
]);

try {
	assert(validateSupportContract(root).findings.length === 0, 'current repository failed the support contract');
	testMissingRequiredField();
	testOptionalPolicyBypass();
	testPolicyTermBypass();
	testDetectionOptionsBypass();
	testHostileExtraField();
	testHostileExtraMarkdown();
	testBenignExtraField();
	testRequiredDiagnosticsBypass();
	testHostileAllowedFieldPrompts();
	testTopLevelMetadataBypass();
	testBlankIssueBypass();
	testDocumentationBypass();
} finally {
	rmSync(testRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	process.exit(1);
}
process.stdout.write('support contract suite: PASS\n');

function testMissingRequiredField() {
	const form = parseForm();
	form.body = form.body.filter((entry) => entry.id !== 'version');
	expectFinding('missing-field', new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'missing-field:version');
}

function testOptionalPolicyBypass() {
	const form = parseForm();
	const policy = form.body.find((entry) => entry.id === 'diagnostics_policy');
	policy.attributes.options[0].required = false;
	expectFinding('optional-policy', new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'policy-required-checkbox');
}

function testPolicyTermBypass() {
	const form = parseForm();
	const policy = form.body.find((entry) => entry.id === 'diagnostics_policy');
	policy.attributes.options[0].label = policy.attributes.options[0].label.replace('inventario crudo', 'datos revisados');
	expectFinding('raw-inventory-policy', new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'policy-term:raw-inventory');
}

function testDetectionOptionsBypass() {
	const form = parseForm();
	const detection = form.body.find((entry) => entry.id === 'detection_mode');
	detection.attributes.options = detection.attributes.options.filter((option) => option !== 'Asistido y armado');
	expectFinding('detection-options', new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'field-option:detection_mode:asistido y armado');
}

function testHostileExtraField() {
	const form = parseForm();
	form.body.push({
		type: 'textarea',
		id: 'api_key_dump',
		attributes: { label: 'Pega aquí tu clave API y el inventario crudo' },
		validations: { required: true },
	});
	const replacement = new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]);
	expectFinding('hostile-extra-field', replacement, 'unexpected-field:api_key_dump');
	expectFinding('hostile-extra-prompt', replacement, 'issue-form-hash');
}

function testHostileExtraMarkdown() {
	const form = parseForm();
	form.body.push({
		type: 'markdown',
		attributes: { value: 'Pega aquí tu clave API y el inventario crudo.' },
	});
	const replacement = new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]);
	expectFinding('hostile-extra-markdown', replacement, 'markdown-count');
	expectFinding('hostile-markdown-prompt', replacement, 'issue-form-hash');
}

function testBenignExtraField() {
	const form = parseForm();
	form.body.push({ type: 'input', id: 'extra_notes', attributes: { label: 'Contexto adicional' } });
	expectFinding('benign-extra-field', new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'unexpected-field:extra_notes');
}

function testRequiredDiagnosticsBypass() {
	const form = parseForm();
	const diagnostics = form.body.find((entry) => entry.id === 'diagnostics');
	diagnostics.validations = { required: true };
	expectFinding('required-diagnostics', new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'field-must-be-optional:diagnostics');
}

function testHostileAllowedFieldPrompts() {
	for (const [name, id, attribute, prompt] of [
		['allowed-introduce-label', 'version', 'label', 'Introduce aquí tu clave API y el inventario crudo'],
		['allowed-proporciona-description', 'reproduction', 'description', 'Proporciona aquí tu clave API y el inventario crudo'],
		['allowed-escribe-label', 'diagnostics', 'label', 'Escribe aquí tu clave API y el inventario crudo'],
	]) {
		const form = parseForm();
		const field = form.body.find((entry) => entry.id === id);
		field.attributes[attribute] = prompt;
		expectFinding(name, new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'issue-form-hash');
	}
}

function testTopLevelMetadataBypass() {
	for (const [name, key, value] of [
		['hostile-form-name', 'name', 'Introduce aquí tu clave API y el inventario crudo'],
		['hostile-form-description', 'description', 'Proporciona aquí tu clave API y el inventario crudo'],
		['changed-form-title', 'title', '[Pega tu clave API]: '],
	]) {
		const form = parseForm();
		form[key] = value;
		expectFinding(name, new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]), 'issue-form-hash');
	}

	const form = parseForm();
	form.labels = ['beta'];
	const replacement = new Map([['.github/ISSUE_TEMPLATE/bug_report.yml', YAML.stringify(form)]]);
	expectFinding('benign-top-level-metadata', replacement, 'issue-form-schema');
	expectFinding('benign-top-level-hash', replacement, 'issue-form-hash');
}

function testBlankIssueBypass() {
	expectFinding('blank-issues', new Map([['.github/ISSUE_TEMPLATE/config.yml', 'blank_issues_enabled: true\n']]), 'blank-issues-enabled');
}

function testDocumentationBypass() {
	const apiKey = files.get('docs/API-KEY.md').replaceAll('`builds`', '`removed-scope`');
	expectFinding('api-key-scope', new Map([['docs/API-KEY.md', apiKey]]), 'api-key-term:builds');
	const readme = files.get('README.md').replaceAll('Finish farming session', 'Unspecified finish action');
	expectFinding('state-dependent-action', new Map([['README.md', readme]]), 'readme-term:finish farming session');
}

function parseForm() {
	return YAML.parse(files.get('.github/ISSUE_TEMPLATE/bug_report.yml'));
}

function expectFinding(name, replacements, finding) {
	const directory = join(testRoot, name);
	for (const [path, source] of files) write(directory, path, replacements.get(path) ?? source);
	const result = validateSupportContract(directory);
	assert(result.findings.includes(finding), `${name} did not turn red with ${finding}`);
}

function write(directory, path, source) {
	const destination = join(directory, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, source);
}

function assert(condition, message) {
	if (!condition) failures.push(message);
}
