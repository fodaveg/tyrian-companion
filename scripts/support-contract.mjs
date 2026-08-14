import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

export const SUPPORT_CONTRACT_VERSION = 3;

const ISSUE_FORM_PATH = '.github/ISSUE_TEMPLATE/bug_report.yml';
const ISSUE_CONFIG_PATH = '.github/ISSUE_TEMPLATE/config.yml';
const ISSUE_FORM_SCHEMA = ['name', 'description', 'title', 'body'];
const FIELD_SCHEMA = new Map([
	['version', { type: 'input', required: true }],
	['obsidian_version', { type: 'input', required: true }],
	['platform', { type: 'dropdown', required: true }],
	['install_source', { type: 'dropdown', required: true }],
	['detection_mode', { type: 'dropdown', required: true }],
	['session_phase', { type: 'dropdown', required: true }],
	['reproduction', { type: 'textarea', required: true }],
	['expected', { type: 'textarea', required: true }],
	['observed', { type: 'textarea', required: true }],
	['diagnostics_policy', { type: 'checkboxes', required: false }],
	['diagnostics', { type: 'textarea', required: false }],
]);
const BODY_SCHEMA = [
	'markdown',
	...[...FIELD_SCHEMA].map(([id, schema]) => `${schema.type}:${id}`),
];
const ISSUE_FORM_SHA256 = '7aef5c391984b8532496460170e008288f8d1f77a301d95c3282ce1170f3bf1d';
const SAFE_MARKDOWN_TEXT = normalize(`
Tyrian Companion es una beta. Revoca primero cualquier clave que pueda haberse expuesto.
No adjuntes claves API, identidad de cuenta/personaje, rutas absolutas, inventario crudo,
snapshots, IndexedDB, notas completas ni capturas o logs sin redactar.
`).trim();
const SAFE_POLICY_LABEL = normalize('He quitado la clave API y otros secretos, identidad de cuenta y personaje, rutas absolutas, inventario crudo, snapshots, IndexedDB, notas completas y capturas o logs sin redactar.');
const DROPDOWN_TERMS = new Map([
	['platform', ['linux', 'macos', 'windows']],
	['install_source', ['artifact manual', 'build local']],
	['detection_mode', ['off', 'asistido y armado', 'asistido y desarmado']],
	['session_phase', ['idle', 'active', 'provisional', 'complete', 'error']],
]);
const POLICY_TERMS = new Map([
	['api-key', ['clave api', 'secretos']],
	['identity', ['cuenta', 'personaje']],
	['vault-path', ['rutas absolutas']],
	['raw-inventory', ['inventario crudo', 'snapshots']],
	['local-storage', ['indexeddb', 'notas completas']],
	['unredacted-output', ['capturas', 'logs sin redactar']],
]);

/** Validates the human support surface without reading or returning report content. */
export function validateSupportContract(root = process.cwd()) {
	const findings = [];
	const form = readYaml(root, ISSUE_FORM_PATH, 'issue-form-yaml', findings);
	const config = readYaml(root, ISSUE_CONFIG_PATH, 'issue-config-yaml', findings);

	if (form) validateIssueForm(form, findings);
	if (config) {
		if (!hasOnlyKeys(config, ['blank_issues_enabled'])) findings.push('issue-config-shape');
		if (config.blank_issues_enabled !== false) findings.push('blank-issues-enabled');
	}
	validateDocumentation(root, findings);

	return {
		version: SUPPORT_CONTRACT_VERSION,
		findings: [...new Set(findings)].sort(),
	};
}

function validateIssueForm(form, findings) {
	if (!sameStrings(Object.keys(form).sort(), [...ISSUE_FORM_SCHEMA].sort())) {
		findings.push('issue-form-schema');
	}
	const formHash = createHash('sha256')
		.update(JSON.stringify(canonicalValue(form)), 'utf8')
		.digest('hex');
	if (formHash !== ISSUE_FORM_SHA256) findings.push('issue-form-hash');
	if (typeof form.name !== 'string' || form.name.trim().length === 0) findings.push('issue-form-name');
	if (typeof form.description !== 'string' || form.description.trim().length === 0) {
		findings.push('issue-form-description');
	}
	if (typeof form.title !== 'string') findings.push('issue-form-title');
	const body = Array.isArray(form.body) ? form.body : [];
	if (body.length === 0) findings.push('issue-form-body');
	const actualBodySchema = body.map((entry, index) => {
		if (!isRecord(entry)) return `invalid:${String(index)}`;
		if (entry.type === 'markdown' && entry.id === undefined) return 'markdown';
		return `${String(entry.type)}:${String(entry.id)}`;
	});
	if (!sameStrings(actualBodySchema, BODY_SCHEMA)) findings.push('issue-form-body-schema');
	const fields = new Map();
	const markdown = [];
	for (const [index, entry] of body.entries()) {
		if (!isRecord(entry)) {
			findings.push(`invalid-body-entry:${String(index)}`);
			continue;
		}
		if (entry.type === 'markdown' && entry.id === undefined) {
			markdown.push(entry);
			if (!hasOnlyKeys(entry, ['type', 'attributes'])) findings.push('markdown-shape');
			continue;
		}
		if (typeof entry.id !== 'string') {
			findings.push(`unauthorized-body-entry:${String(index)}`);
			continue;
		}
		if (!FIELD_SCHEMA.has(entry.id)) findings.push(`unexpected-field:${entry.id}`);
		if (!hasOnlyKeys(entry, ['type', 'id', 'attributes', 'validations'])) {
			findings.push(`field-shape:${entry.id}`);
		}
		if (fields.has(entry.id)) findings.push(`duplicate-field:${entry.id}`);
		fields.set(entry.id, entry);
	}
	if (markdown.length !== 1) findings.push('markdown-count');
	const markdownText = markdown.length === 1 && isRecord(markdown[0].attributes) &&
		typeof markdown[0].attributes.value === 'string'
		? normalize(markdown[0].attributes.value).trim() : '';
	if (markdownText !== SAFE_MARKDOWN_TEXT) findings.push('markdown-content');

	for (const [id, schema] of FIELD_SCHEMA) {
		const field = fields.get(id);
		if (!field) {
			findings.push(`missing-field:${id}`);
			continue;
		}
		if (field.type !== schema.type) findings.push(`field-type:${id}`);
		if (!isRecord(field.attributes) || typeof field.attributes.label !== 'string' ||
			field.attributes.label.trim().length === 0) {
			findings.push(`field-label:${id}`);
		}
		if (schema.required && (!isRecord(field.validations) || field.validations.required !== true)) {
			findings.push(`field-required:${id}`);
		}
		if (!schema.required && isRecord(field.validations) && field.validations.required === true) {
			findings.push(`field-must-be-optional:${id}`);
		}
	}
	for (const [id, terms] of DROPDOWN_TERMS) {
		const field = fields.get(id);
		const options = isRecord(field?.attributes) && Array.isArray(field.attributes.options)
			? normalize(field.attributes.options.filter((option) => typeof option === 'string').join(' ')) : '';
		for (const term of terms) {
			if (!options.includes(term)) findings.push(`field-option:${id}:${term}`);
		}
	}

	const policy = fields.get('diagnostics_policy');
	const options = isRecord(policy?.attributes) && Array.isArray(policy.attributes.options)
		? policy.attributes.options : [];
	const requiredLabels = options
		.filter((option) => isRecord(option) && option.required === true && typeof option.label === 'string')
		.map((option) => normalize(option.label));
	if (requiredLabels.length !== 1) findings.push('policy-required-checkbox');
	const policyText = requiredLabels.join(' ');
	if (policyText !== SAFE_POLICY_LABEL) findings.push('policy-label');
	for (const [name, terms] of POLICY_TERMS) {
		if (terms.some((term) => !policyText.includes(term))) findings.push(`policy-term:${name}`);
	}

	const diagnostics = fields.get('diagnostics');
	const diagnosticsDescription = isRecord(diagnostics?.attributes) &&
		typeof diagnostics.attributes.description === 'string'
		? normalize(diagnostics.attributes.description) : '';
	if (!diagnosticsDescription.includes('redactado') || !diagnosticsDescription.includes('nunca')) {
		findings.push('diagnostics-redaction-prompt');
	}
}

function validateDocumentation(root, findings) {
	const support = readText(root, 'docs/SUPPORT.md', 'support-document', findings);
	const apiKey = readText(root, 'docs/API-KEY.md', 'api-key-document', findings);
	const readme = readText(root, 'README.md', 'readme-document', findings);

	for (const [name, text, terms] of [
		['support', support, ['revoca primero la clave', 'inventario crudo', 'indexeddb', 'logs sin redactar']],
		['api-key', apiKey, ['account', 'characters', 'inventories', 'builds', 'wallet', 'tradingpost', 'progression', 'unlocks']],
		['readme', readme, ['open companion', 'start farming session', 'finish farming session', 'review session', 'support.md']],
	]) {
		for (const term of terms) {
			if (!text.includes(term)) findings.push(`${name}-term:${term}`);
		}
	}
	if (!apiKey.includes('https://account.arena.net/applications')) findings.push('api-key-portal');
}

function readYaml(root, relativePath, code, findings) {
	const source = readSource(root, relativePath, code, findings);
	if (source.length === 0) return null;
	try {
		const value = YAML.parse(source);
		if (!isRecord(value)) {
			findings.push(code);
			return null;
		}
		return value;
	} catch {
		findings.push(code);
		return null;
	}
}

function readText(root, relativePath, code, findings) {
	return normalize(readSource(root, relativePath, code, findings));
}

function readSource(root, relativePath, code, findings) {
	try {
		return readFileSync(resolve(root, relativePath), 'utf8');
	} catch {
		findings.push(code);
		return '';
	}
}

function normalize(value) {
	return value.normalize('NFC').toLocaleLowerCase('es-ES');
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
	);
}

function hasOnlyKeys(value, allowed) {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function sameStrings(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
	const result = validateSupportContract(process.argv[2] ?? process.cwd());
	if (result.findings.length > 0) {
		for (const finding of result.findings) process.stderr.write(`support contract: ${finding}\n`);
		process.exit(1);
	}
	process.stdout.write(`support contract v${String(result.version)}: PASS\n`);
}
