import { describe, expect, it } from 'vitest';
import { provenanceJsonLines } from './live-session-note-renderer';

/** The regex the scan replaced: reference for semantics (it overflows the stack on big two-byte strings). */
const legacy = (text: string): string[] => [...text.matchAll(/^```json\n([^\n]+)\n```$/gmu)].map((m) => m[1]!);

describe('provenanceJsonLines', () => {
	it('matches the legacy regex on zero, one, several and misplaced blocks', () => {
		const cases = ['', 'x', '```json\n{"a":1}\n```', 'a\n```json\n{"a":1}\n```\nb', '```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
			'x```json\n{"a":1}\n```', '```json\n{"a":1}\n```x', '```json\n\n```', '```json\n{"a":1}\r\n```', '```json\r\n{"a":1}\n```',
			'a\r```json\n{"a":1}\n``` ', '```json\n```json\n{"a":1}\n```', '```json\n{"a":1}\n``` \n```json\n{"b":2}\n```', '```json\n→\n```\n```json\n—\n```'];
		for (const text of cases) expect(provenanceJsonLines(text), JSON.stringify(text)).toEqual(legacy(text));
	});
	it('reads a line past 8 MiB of two-byte text without overflowing the stack', () => {
		const line = JSON.stringify({ v: '→—−'.repeat(3 * 1024 * 1024) });
		const out = provenanceJsonLines(`## x\n\`\`\`json\n${line}\n\`\`\`\n`);
		expect(out).toHaveLength(1); expect(out[0]!.length).toBe(line.length);
		expect(() => legacy(`\`\`\`json\n${line}\n\`\`\``)).toThrow(RangeError);
	});
});
