import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

export const ACTION_OBSERVABILITY_CENSUS_VERSION = 3;
export const ACTION_BOUNDARY_KINDS = ['catch_clause', 'promise_catch', 'void_expression', 'callback_registration'];
export const ACTION_BOUNDARY_CLASSIFICATIONS = ['unreviewed', 'observed', 'allowlisted'];

const FILE_CLASSIFICATION = 'production_source';
const POLICY = 'Every production TypeScript file and every catch, Promise catch, detached void, and registered inline callback has an exact locator and an explicit observability decision. New boundaries are unreviewed. Observed decisions require a direct diagnostic call verified against the AST; allowlisted decisions require kind-specific semantic evidence verified against the AST.';
const CALLBACK_REGISTRATIONS = new Set([
	'addEventListener', 'addCommand', 'finally', 'on', 'queueMicrotask', 'registerDomEvent',
	'registerEvent', 'requestAnimationFrame', 'setInterval', 'setTimeout', 'then',
]);
const OBSERVABILITY_MEMBERS = new Set([
	'cancel', 'emitNotice', 'event', 'failure', 'finishDiagnostic', 'fireAndForget', 'onDiagnostic',
	'record', 'recordObserverFailure', 'retry', 'run', 'runSync', 'skip', 'success', 'writeFailure',
]);

/** Returns a candidate manifest. Every boundary deliberately starts unreviewed. */
export function collectActionBoundaryCensus(root = process.cwd()) {
	return analyzeActionBoundaryCensus(root).census;
}

/** Applies explicit decisions to a fresh candidate using evidence derived from the AST. */
export function reviewActionBoundaryCensus(root = process.cwd(), decide = () => undefined) {
	const analysis = analyzeActionBoundaryCensus(root);
	for (const [path, file] of Object.entries(analysis.census.files)) {
		for (const boundary of file.boundaries) {
			const metadata = analysis.metadata.get(`${path}:${boundaryIdentity(boundary)}`);
			const decision = decide({
				path,
				kind: boundary.kind,
				locator: safeLocator(boundary),
				...(boundary.registration === undefined ? {} : { registration: boundary.registration }),
				directObservabilityCalls: [...metadata.directObservabilityCalls],
				allowlistEvidence: structuredClone(metadata.allowlistEvidence),
			});
			if (decision?.classification === 'observed') {
				boundary.classification = 'observed';
				boundary.evidence = { type: 'direct_observability_call', callee: decision.callee };
				boundary.reason = decisionReason(boundary);
			} else if (decision?.classification === 'allowlisted') {
				boundary.classification = 'allowlisted';
				boundary.evidence = {
					...structuredClone(metadata.allowlistEvidence),
					justification: decision.justification,
				};
				boundary.reason = decisionReason(boundary);
			}
		}
	}
	return analysis.census;
}

/** Compares the repository with its reviewed exact manifest without exposing source text. */
export function verifyActionBoundaryCensus(root = process.cwd(), baselinePath = 'scripts/action-observability-baseline.json') {
	const analysis = analyzeActionBoundaryCensus(root);
	const actual = analysis.census;
	const absoluteBaseline = resolve(root, baselinePath);
	if (!existsSync(absoluteBaseline)) return [{ path: baselinePath, kind: 'missing_baseline' }];
	let expected;
	try {
		expected = JSON.parse(readFileSync(absoluteBaseline, 'utf8'));
	} catch {
		return [{ path: baselinePath, kind: 'invalid_baseline', issue: 'invalid_json' }];
	}
	const invalidIssue = validateBaseline(expected);
	if (invalidIssue !== undefined) return [{ path: baselinePath, kind: 'invalid_baseline', issue: invalidIssue }];

	const findings = [];
	const paths = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
	for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
		const expectedFile = expected.files[path];
		const actualFile = actual.files[path];
		if (expectedFile === undefined) {
			findings.push({ path, kind: 'new_production_file' });
			continue;
		}
		if (actualFile === undefined) {
			findings.push({ path, kind: 'missing_production_file' });
			continue;
		}
		const expectedBoundaries = new Map(expectedFile.boundaries.map((boundary) => [boundaryIdentity(boundary), boundary]));
		const actualBoundaries = new Map(actualFile.boundaries.map((boundary) => [boundaryIdentity(boundary), boundary]));
		const identities = new Set([...expectedBoundaries.keys(), ...actualBoundaries.keys()]);
		for (const identity of [...identities].sort((left, right) => left.localeCompare(right))) {
			const expectedBoundary = expectedBoundaries.get(identity);
			const actualBoundary = actualBoundaries.get(identity);
			if (expectedBoundary === undefined) {
				findings.push({ path, kind: actualBoundary.kind, change: 'added', locator: safeLocator(actualBoundary) });
			} else if (actualBoundary === undefined) {
				findings.push({ path, kind: expectedBoundary.kind, change: 'removed', locator: safeLocator(expectedBoundary) });
			} else {
				const metadata = analysis.metadata.get(`${path}:${identity}`);
				const decisionIssue = validateDecision(expectedBoundary, metadata);
				if (decisionIssue !== undefined) {
					findings.push({ path, kind: expectedBoundary.kind, change: 'invalid_decision', locator: safeLocator(expectedBoundary), issue: decisionIssue });
				}
			}
		}
	}
	return findings;
}

/** Runs the CLI contract without requiring a child process, returning its intended exit code. */
export function runActionBoundaryCensusCli(args = [], output = process) {
	const root = resolve(args.find((argument) => argument.startsWith('--root='))?.slice('--root='.length) ?? '.');
	const baseline = resolve(root, 'scripts/action-observability-baseline.json');
	if (args.includes('--write-baseline')) {
		writeFileSync(baseline, `${JSON.stringify(collectActionBoundaryCensus(root), null, '\t')}\n`, { flag: 'w' });
		output.stdout.write('action observability census: unreviewed candidate written; decide every boundary before accepting it\n');
		return 0;
	}
	const findings = verifyActionBoundaryCensus(root);
	if (findings.length === 0) {
		output.stdout.write('action observability census: PASS\n');
		return 0;
	}
	output.stderr.write(`action observability census: ${String(findings.length)} unreviewed or invalid boundary change(s)\n`);
	for (const finding of findings) {
		output.stderr.write(`- ${finding.path}: ${finding.kind}${finding.change === undefined ? '' : ` (${finding.change})`}\n`);
	}
	return 1;
}

function analyzeActionBoundaryCensus(root) {
	const absoluteRoot = resolve(root);
	const totals = Object.fromEntries(ACTION_BOUNDARY_KINDS.map((kind) => [kind, 0]));
	const files = {};
	const metadata = new Map();
	for (const absolute of productionTypeScriptFiles(absoluteRoot)) {
		const source = readFileSync(absolute, 'utf8');
		const path = relative(absoluteRoot, absolute).split(sep).join('/');
		const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const boundaries = [];
		const addBoundary = (kind, node, registration) => {
			const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
			const end = ast.getLineAndCharacterOfPosition(node.end);
			const boundary = {
				kind, line: location.line + 1, column: location.character + 1,
				endLine: end.line + 1, endColumn: end.character + 1,
				...(registration === undefined ? {} : { registration }),
				classification: 'unreviewed', evidence: { type: 'pending_review' },
				reason: 'Pending an explicit observability review; candidate generation never approves a boundary.',
			};
			boundaries.push(boundary);
			metadata.set(`${path}:${boundaryIdentity(boundary)}`, boundaryMetadata(node, kind, registration));
			totals[kind] += 1;
		};
		const visit = (node) => {
			if (ts.isCatchClause(node)) addBoundary('catch_clause', node);
			if (ts.isVoidExpression(node)) addBoundary('void_expression', node);
			if (ts.isCallExpression(node)) {
				const callName = calledMemberName(node.expression);
				if (callName === 'catch') addBoundary('promise_catch', node, 'catch');
				if (callName !== undefined && CALLBACK_REGISTRATIONS.has(callName)
					&& node.arguments.some(isInlineCallback)) addBoundary('callback_registration', node, callName);
			}
			ts.forEachChild(node, visit);
		};
		visit(ast);
		boundaries.sort(compareBoundaries);
		files[path] = {
			classification: FILE_CLASSIFICATION,
			reason: 'Reviewed production TypeScript file; zero-boundary files remain in scope so additions cannot bypass the census.',
			boundaries,
		};
	}
	return {
		census: {
			version: ACTION_OBSERVABILITY_CENSUS_VERSION, policy: POLICY, totals,
			files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
		},
		metadata,
	};
}

function boundaryMetadata(node, kind, registration) {
	const scope = enclosingScope(node);
	const directObservabilityCalls = collectDirectObservabilityCalls(node);
	let allowlistEvidence;
	if (kind === 'catch_clause' || kind === 'promise_catch') {
		allowlistEvidence = { type: 'reviewed_recovery', behavior: recoveryBehavior(node), scope };
	} else if (kind === 'void_expression') {
		allowlistEvidence = { type: 'reviewed_detached_execution', target: detachedTarget(node), scope };
	} else {
		allowlistEvidence = { type: 'reviewed_registered_callback', registration, scope };
	}
	return { directObservabilityCalls, allowlistEvidence };
}

function collectDirectObservabilityCalls(boundaryNode) {
	const calls = new Set();
	const visit = (node) => {
		if (ts.isCallExpression(node)) {
			const callee = semanticCallee(node.expression);
			if (callee !== undefined && isObservabilityCallee(callee)) calls.add(callee);
		}
		if (ts.isNewExpression(node) && semanticCallee(node.expression) === 'Notice') calls.add('new Notice');
		ts.forEachChild(node, visit);
	};
	visit(boundaryNode);
	return [...calls].sort((left, right) => left.localeCompare(right));
}

function isObservabilityCallee(callee) {
	if (callee === 'startLocalDebugAction' || callee === 'new Notice') return true;
	const pieces = callee.split('.');
	const member = pieces.at(-1);
	if (!OBSERVABILITY_MEMBERS.has(member)) return false;
	const owner = pieces.slice(0, -1).join('.').toLowerCase();
	if (member === 'emitNotice' || member === 'onDiagnostic') return true;
	if (member === 'finishDiagnostic' || member === 'recordObserverFailure' || member === 'writeFailure') {
		return owner === 'this';
	}
	if (['cancel', 'failure', 'retry', 'skip', 'success'].includes(member)) return owner.endsWith('span');
	if (member === 'record') return owner.includes('diagnostic') || owner.includes('debug') || owner.includes('logger');
	return owner.includes('localdebug') || owner.includes('diagnostic');
}

function validateDecision(boundary, metadata) {
	if (boundary.classification === 'unreviewed') return 'boundary_unreviewed';
	if (boundary.classification === 'observed') {
		return metadata.directObservabilityCalls.includes(boundary.evidence.callee)
			? undefined : 'observability_evidence_missing';
	}
	const { justification: _justification, ...semanticEvidence } = boundary.evidence;
	return sameJson(semanticEvidence, metadata.allowlistEvidence)
		? undefined : 'allowlist_evidence_mismatch';
}

function validateBaseline(value) {
	if (!isRecord(value)) return 'root_shape';
	if (!hasExactKeys(value, ['files', 'policy', 'totals', 'version'])) return 'root_keys';
	if (value.version !== ACTION_OBSERVABILITY_CENSUS_VERSION) return 'version';
	if (value.policy !== POLICY) return 'policy';
	if (!isRecord(value.totals) || !hasExactKeys(value.totals, ACTION_BOUNDARY_KINDS)) return 'totals_shape';
	if (!isRecord(value.files)) return 'files_shape';
	const computedTotals = Object.fromEntries(ACTION_BOUNDARY_KINDS.map((kind) => [kind, 0]));
	for (const [path, file] of Object.entries(value.files)) {
		if (!isSafeProductionPath(path)) return 'file_path';
		if (!isRecord(file) || !hasExactKeys(file, ['boundaries', 'classification', 'reason'])) return 'file_shape';
		if (file.classification !== FILE_CLASSIFICATION) return 'file_classification';
		if (!isExplicitReason(file.reason)) return 'file_reason';
		if (!Array.isArray(file.boundaries)) return 'boundaries_shape';
		const identities = new Set();
		let priorBoundary;
		for (const boundary of file.boundaries) {
			const issue = validateBoundary(boundary);
			if (issue !== undefined) return issue;
			const identity = boundaryIdentity(boundary);
			if (identities.has(identity)) return 'duplicate_boundary';
			identities.add(identity);
			if (priorBoundary !== undefined && compareBoundaries(priorBoundary, boundary) >= 0) return 'boundary_order';
			priorBoundary = boundary;
			computedTotals[boundary.kind] += 1;
		}
	}
	for (const kind of ACTION_BOUNDARY_KINDS) {
		if (!Number.isSafeInteger(value.totals[kind]) || value.totals[kind] < 0) return 'totals_value';
		if (value.totals[kind] !== computedTotals[kind]) return 'totals_mismatch';
	}
	return undefined;
}

function validateBoundary(boundary) {
	if (!isRecord(boundary)) return 'boundary_shape';
	if (!ACTION_BOUNDARY_KINDS.includes(boundary.kind)) return 'boundary_kind';
	const expectedKeys = boundary.kind === 'promise_catch' || boundary.kind === 'callback_registration'
		? ['classification', 'column', 'endColumn', 'endLine', 'evidence', 'kind', 'line', 'reason', 'registration']
		: ['classification', 'column', 'endColumn', 'endLine', 'evidence', 'kind', 'line', 'reason'];
	if (!hasExactKeys(boundary, expectedKeys)) return 'boundary_keys';
	if (!Number.isSafeInteger(boundary.line) || boundary.line < 1
		|| !Number.isSafeInteger(boundary.column) || boundary.column < 1
		|| !Number.isSafeInteger(boundary.endLine) || boundary.endLine < boundary.line
		|| !Number.isSafeInteger(boundary.endColumn) || boundary.endColumn < 1) return 'boundary_locator';
	if (!ACTION_BOUNDARY_CLASSIFICATIONS.includes(boundary.classification)) return 'boundary_classification';
	if (!isRecord(boundary.evidence)) return 'boundary_evidence';
	if (!isExplicitReason(boundary.reason) || boundary.reason !== decisionReason(boundary)) return 'boundary_reason';
	if (boundary.kind === 'promise_catch' && boundary.registration !== 'catch') return 'boundary_registration';
	if (boundary.kind === 'callback_registration'
		&& (typeof boundary.registration !== 'string' || !CALLBACK_REGISTRATIONS.has(boundary.registration))) return 'boundary_registration';
	if (boundary.classification === 'unreviewed') {
		return hasExactKeys(boundary.evidence, ['type']) && boundary.evidence.type === 'pending_review'
			? 'boundary_unreviewed' : 'boundary_evidence';
	}
	if (boundary.classification === 'observed') {
		return hasExactKeys(boundary.evidence, ['callee', 'type'])
			&& boundary.evidence.type === 'direct_observability_call'
			&& typeof boundary.evidence.callee === 'string'
			? undefined : 'boundary_evidence';
	}
	if (boundary.kind === 'catch_clause' || boundary.kind === 'promise_catch') {
		return hasExactKeys(boundary.evidence, ['behavior', 'justification', 'scope', 'type'])
			&& boundary.evidence.type === 'reviewed_recovery'
			&& isSemanticIdentifier(boundary.evidence.behavior) && isSemanticIdentifier(boundary.evidence.scope)
			&& isSpecificAllowlistJustification(boundary)
			? undefined : 'boundary_evidence';
	}
	if (boundary.kind === 'void_expression') {
		return hasExactKeys(boundary.evidence, ['justification', 'scope', 'target', 'type'])
			&& boundary.evidence.type === 'reviewed_detached_execution'
			&& isSemanticIdentifier(boundary.evidence.scope) && isSemanticIdentifier(boundary.evidence.target)
			&& isSpecificAllowlistJustification(boundary)
			? undefined : 'boundary_evidence';
	}
	return hasExactKeys(boundary.evidence, ['justification', 'registration', 'scope', 'type'])
		&& boundary.evidence.type === 'reviewed_registered_callback'
		&& boundary.evidence.registration === boundary.registration
		&& isSemanticIdentifier(boundary.evidence.scope)
		&& isSpecificAllowlistJustification(boundary)
		? undefined : 'boundary_evidence';
}

function decisionReason(boundary) {
	if (boundary.classification === 'unreviewed') {
		return 'Pending an explicit observability review; candidate generation never approves a boundary.';
	}
	if (boundary.classification === 'observed') {
		return `Direct observability call "${boundary.evidence?.callee ?? ''}" is present inside this ${boundary.kind} boundary.`;
	}
	if (boundary.kind === 'catch_clause' || boundary.kind === 'promise_catch') {
		return `Allowlisted ${boundary.kind}: ${boundary.evidence?.justification ?? ''} Verified recovery: "${boundary.evidence?.behavior ?? ''}" in "${boundary.evidence?.scope ?? ''}".`;
	}
	if (boundary.kind === 'void_expression') {
		return `Allowlisted void_expression: ${boundary.evidence?.justification ?? ''} Verified target: "${boundary.evidence?.target ?? ''}" in "${boundary.evidence?.scope ?? ''}".`;
	}
	return `Allowlisted callback_registration: ${boundary.evidence?.justification ?? ''} Verified registration: "${boundary.evidence?.registration ?? ''}" in "${boundary.evidence?.scope ?? ''}".`;
}

function recoveryBehavior(node) {
	let hasThrow = false;
	let hasReturn = false;
	let hasControlFlow = false;
	let statementCount = 0;
	const visit = (child) => {
		if (child !== node && isFunctionLike(child)) return;
		if (ts.isThrowStatement(child)) hasThrow = true;
		if (ts.isReturnStatement(child)) hasReturn = true;
		if (ts.isBreakStatement(child) || ts.isContinueStatement(child)) hasControlFlow = true;
		if (ts.isStatement(child)) statementCount += 1;
		ts.forEachChild(child, visit);
	};
	visit(node);
	if (hasThrow) return 'rethrow';
	if (hasReturn) return 'fallback_return';
	if (hasControlFlow) return 'control_flow_recovery';
	if (statementCount === 0) return 'intentional_noop';
	return 'local_recovery';
}

function detachedTarget(node) {
	if (!ts.isVoidExpression(node)) return 'unknown';
	const expression = unwrapExpression(node.expression);
	if (ts.isCallExpression(expression)) {
		const called = unwrapExpression(expression.expression);
		if (ts.isArrowFunction(called)) return called.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
			? 'inline_async_function' : 'inline_function';
		if (ts.isFunctionExpression(called)) return 'inline_function';
		return semanticCallee(expression.expression) ?? 'computed_call';
	}
	return ts.SyntaxKind[expression.kind] ?? 'unknown';
}

function enclosingScope(node) {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isGetAccessor(current)
			|| ts.isSetAccessor(current) || ts.isConstructorDeclaration(current)) return declarationName(current);
		if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
			const parent = current.parent;
			if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
				return declarationName(parent);
			}
		}
	}
	return '<module>';
}

function declarationName(node) {
	if (ts.isConstructorDeclaration(node)) return 'constructor';
	const name = node.name;
	if (name === undefined) return '<anonymous>';
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
	return '<computed>';
}

function semanticCallee(expression) {
	const unwrapped = unwrapExpression(expression);
	if (ts.isIdentifier(unwrapped)) return unwrapped.text;
	if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return 'this';
	if (ts.isCallExpression(unwrapped)) {
		const callee = semanticCallee(unwrapped.expression);
		return callee === undefined ? undefined : `${callee}()`;
	}
	if (ts.isPropertyAccessExpression(unwrapped)) {
		const owner = semanticCallee(unwrapped.expression);
		return owner === undefined ? undefined : `${owner}.${unwrapped.name.text}`;
	}
	if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression !== undefined
		&& ts.isStringLiteralLike(unwrapped.argumentExpression)) {
		const owner = semanticCallee(unwrapped.expression);
		return owner === undefined ? undefined : `${owner}.${unwrapped.argumentExpression.text}`;
	}
	return undefined;
}

function unwrapExpression(expression) {
	let current = expression;
	while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
		|| ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
	return current;
}

function productionTypeScriptFiles(root) {
	const sourceRoot = resolve(root, 'src');
	if (!existsSync(sourceRoot)) return [];
	const files = [];
	const visit = (directory) => {
		for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
			const absolute = resolve(directory, name);
			const stats = statSync(absolute);
			if (stats.isDirectory()) visit(absolute);
			else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) files.push(absolute);
		}
	};
	visit(sourceRoot);
	return files;
}

function calledMemberName(expression) {
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined
		&& ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
	if (ts.isIdentifier(expression)) return expression.text;
	return undefined;
}

function isInlineCallback(node) { return ts.isArrowFunction(node) || ts.isFunctionExpression(node); }
function isFunctionLike(node) {
	return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
		|| ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
}
function boundaryIdentity(boundary) {
	return `${boundary.kind}:${String(boundary.line)}:${String(boundary.column)}:${String(boundary.endLine)}:${String(boundary.endColumn)}:${boundary.registration ?? ''}`;
}
function safeLocator(boundary) {
	return `${String(boundary.line)}:${String(boundary.column)}-${String(boundary.endLine)}:${String(boundary.endColumn)}`;
}
function compareBoundaries(left, right) {
	return left.line - right.line || left.column - right.column || left.endLine - right.endLine
		|| left.endColumn - right.endColumn || left.kind.localeCompare(right.kind)
		|| (left.registration ?? '').localeCompare(right.registration ?? '');
}
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hasExactKeys(value, expectedKeys) {
	const actualKeys = Object.keys(value).sort((left, right) => left.localeCompare(right));
	const sortedExpected = [...expectedKeys].sort((left, right) => left.localeCompare(right));
	return actualKeys.length === sortedExpected.length
		&& actualKeys.every((key, index) => key === sortedExpected[index]);
}
function isExplicitReason(value) { return typeof value === 'string' && value.trim().length >= 24; }
function isSemanticIdentifier(value) {
	return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\r\n]/u.test(value);
}
function isSpecificAllowlistJustification(boundary) {
	const value = boundary.evidence.justification;
	if (typeof value !== 'string' || value.length < 48 || value.length > 480 || /[\r\n]/u.test(value)) return false;
	const discriminator = boundary.evidence.behavior ?? boundary.evidence.target ?? boundary.evidence.registration;
	return value.includes(`"${boundary.evidence.scope}"`) && value.includes(`"${discriminator}"`);
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function isSafeProductionPath(path) {
	return /^src\/(?!.*(?:^|\/)\.\.?(?:\/|$)).+\.ts$/u.test(path)
		&& !path.endsWith('.test.ts') && !path.endsWith('.d.ts');
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) process.exitCode = runActionBoundaryCensusCli(process.argv.slice(2));
