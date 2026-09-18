import { describe, expect, it } from 'vitest';

import { parseManualSessionForm } from './manual-session-start-modal';

describe('parseManualSessionForm', () => {
	it('leaves magicFind null and does not throw when the field is left empty', () => {
		expect(parseManualSessionForm('Astra Uno', '', ''))
			.toEqual({ characterName: 'Astra Uno', magicFind: null, consumablesBonus: 0 });
	});

	it('leaves magicFind null for a whitespace-only field', () => {
		expect(parseManualSessionForm('Astra Uno', '   ', '  '))
			.toEqual({ characterName: 'Astra Uno', magicFind: null, consumablesBonus: 0 });
	});

	it('parses a typed-in whole number into magicFind', () => {
		expect(parseManualSessionForm('Astra Uno', '333', '15'))
			.toEqual({ characterName: 'Astra Uno', magicFind: 333, consumablesBonus: 15 });
	});

	it.each([
		['non-numeric text', 'abc'],
		['a fractional number', '12.5'],
		['a negative number', '-1'],
	])('still throws for %s in the Magic Find field', (_label, magicFindText) => {
		expect(() => parseManualSessionForm('Astra Uno', magicFindText, '')).toThrow();
	});

	it('still throws for non-integer text in the consumables bonus field', () => {
		expect(() => parseManualSessionForm('Astra Uno', '', '12.5')).toThrow();
	});
});
