#!/usr/bin/env node

import { readFileSync, writeSync } from 'node:fs';

const sourcePath = process.argv[2];
if (sourcePath === undefined) process.exit(2);

const tokens = cTokens(readFileSync(sourcePath, 'utf8'));
const main = functionBody(tokens, 'main');
const failures = [];

if (main === undefined) failures.push('main body missing');
if (!hasExactArguments(main ?? [], 'OpenFileMappingW', ['0x0004u', '0', 'MUMBLE_MAPPING_NAME'])) {
	failures.push('expanded OpenFileMappingW arguments differ');
}
if (!hasExactArguments(main ?? [], 'MapViewOfFile', [
	'mapping', '0x0004u', '0u', '0u', '5460u',
])) failures.push('expanded MapViewOfFile arguments differ');
if (!containsSequence(tokens, [
	'static', 'const', 'wchar_t', 'MUMBLE_MAPPING_NAME', '[', ']', '=', 'L"MumbleLink"', ';',
])) failures.push('expanded mapping name differs');

if (failures.length > 0) {
	writeSync(process.stderr.fd, `h8 preprocessed wrapper: FAIL (${failures.join('; ')})\n`);
	process.exitCode = 1;
}
process.stdout.write('h8 preprocessed wrapper: PASS\n');

function hasExactArguments(body, name, expected) {
	const calls = invocationArguments(body, name);
	return calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify(expected);
}

function invocationArguments(tokensToRead, name) {
	const calls = [];
	for (let index = 0; index < tokensToRead.length - 1; index += 1) {
		if (tokensToRead[index] !== name || tokensToRead[index + 1] !== '(') continue;
		const args = [];
		let current = '';
		let depth = 1;
		for (index += 2; index < tokensToRead.length && depth > 0; index += 1) {
			const token = tokensToRead[index];
			if (token === '(') depth += 1;
			if (token === ')') depth -= 1;
			if (depth === 0) {
				args.push(current);
				break;
			}
			if (token === ',' && depth === 1) {
				args.push(current);
				current = '';
			} else {
				current += token;
			}
		}
		calls.push(args);
	}
	return calls;
}

function functionBody(tokensToRead, name) {
	const nameIndex = tokensToRead.findIndex((token, index) => token === name
		&& tokensToRead[index + 1] === '(');
	if (nameIndex < 0) return undefined;
	const openBrace = tokensToRead.indexOf('{', nameIndex + 2);
	if (openBrace < 0) return undefined;
	let depth = 1;
	for (let index = openBrace + 1; index < tokensToRead.length; index += 1) {
		if (tokensToRead[index] === '{') depth += 1;
		if (tokensToRead[index] === '}') depth -= 1;
		if (depth === 0) return tokensToRead.slice(openBrace + 1, index);
	}
	return undefined;
}

function containsSequence(tokensToRead, expected) {
	return tokensToRead.some((_, start) => expected.every(
		(token, offset) => tokensToRead[start + offset] === token,
	));
}

function cTokens(source) {
	const pattern = /L?"(?:\\.|[^"\\])*"|L?'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|0[xX][0-9A-Fa-f]+(?:[uUlL]+)?|\d+(?:[uUlL]+)?|[^\s]/gu;
	return [...source.matchAll(pattern)].map((match) => match[0]);
}
