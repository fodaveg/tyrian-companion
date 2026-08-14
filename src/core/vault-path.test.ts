import { describe, expect, it } from 'vitest';

import { normalizeVaultRelativePath } from './vault-path';

const CONFIG_SEGMENT = `.${'obsidian'}`;

describe('normalizeVaultRelativePath', () => {
	it('accepts a canonical portable relative path', () => {
		expect(normalizeVaultRelativePath('Guild Wars 2/Éxito')).toBe('Guild Wars 2/Éxito');
	});

	it.each([
		'', '/absolute', 'C:/Users/David', '\\\\server\\share', 'a//b', 'a/./b', 'a/../b',
		'a/b:c', 'a/b*c', 'a/b?c', 'a/b"c', 'a/b<c', 'a/b>c', 'a/b|c', 'a/b\\c',
		'a/\u0001b', 'a/\u007fb', 'a/\ud800b', 'a/b.', 'a/b ', 'a/e\u0301', 'CON', 'a/PRN.md',
		'a/AUX', 'a/NUL.txt', 'a/COM1 ', 'a/COM9.log', 'a/COM¹.log', 'a/LPT1.base', 'a/LPT³.md', 'a/COM1 .md',
		'a/'.concat('b'.repeat(121)), 'a'.repeat(241),
	])('rejects an unsafe or non-portable path %j', (path) => {
		expect(normalizeVaultRelativePath(path)).toBeNull();
	});

	it('blocks forbidden root folders case-insensitively', () => {
		const caseVariant = CONFIG_SEGMENT.replace('o', 'O');
		expect(normalizeVaultRelativePath(`${caseVariant}/plugins`, { forbiddenRootSegments: [CONFIG_SEGMENT] })).toBeNull();
		expect(normalizeVaultRelativePath(`Notes/${CONFIG_SEGMENT}`, { forbiddenRootSegments: [CONFIG_SEGMENT] })).toBe(`Notes/${CONFIG_SEGMENT}`);
	});

	it('blocks a forbidden segment at every depth when requested', () => {
		expect(normalizeVaultRelativePath(`Notes/${CONFIG_SEGMENT}/plugins`, { forbiddenSegments: [CONFIG_SEGMENT] })).toBeNull();
	});

	it('blocks a configured folder prefix without matching a sibling', () => {
		expect(normalizeVaultRelativePath('Config/Plugin/data', { forbiddenPathPrefixes: ['config/plugin'] })).toBeNull();
		expect(normalizeVaultRelativePath('Config/plugins', { forbiddenPathPrefixes: ['config/plugin'] })).toBe('Config/plugins');
	});
});
