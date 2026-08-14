import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EVIDENCE_FILES = readdirSync('src/advisor')
	.filter((file) => /^inventory-advisor-evidence.*\.ts$/u.test(file) && !file.endsWith('.test.ts'))
	.sort()
	.map((file) => ({ file, source: readFileSync(`src/advisor/${file}`, 'utf8') }));

const FORBIDDEN = [
	/\bonload\b/u, /from ['"]obsidian['"]/u,
	/\b(?:Vault|vault|workspace|Notice|Modal|setViewState|createEl)\b/u,
	/\b(?:indexedDB|IndexedDB|localStorage|sessionStorage|readFileSync|writeFileSync)\b/u,
	/\b(?:setTimeout|setInterval|requestAnimationFrame)\b/u,
	/\b(?:deleteItem|salvageItem|openContainer|destroyItem)\b/u,
];

describe('inventory advisor H4.14 evidence boundary', () => {
	it('censuses every productive evidence module and keeps it explicit, pure and non-executing', () => {
		expect(EVIDENCE_FILES.map(({ file }) => file)).toEqual([
			'inventory-advisor-evidence-contract.ts',
			'inventory-advisor-evidence-model.ts',
			'inventory-advisor-evidence.ts',
		]);
		for (const { source } of EVIDENCE_FILES) {
			for (const forbidden of FORBIDDEN) expect(source).not.toMatch(forbidden);
		}
	});

	it('turns red for each forbidden side-effect family', () => {
		for (const source of [
			'window.onload = () => undefined;', 'localStorage.setItem(\'key\', \'value\');',
			'setTimeout(() => undefined, 1);', 'indexedDB.open(\'evidence\');', 'vault.deleteItem(itemId);', 'new Notice(\'saved\');',
		]) {
			expect(FORBIDDEN.some((forbidden) => forbidden.test(source))).toBe(true);
		}
	});

	it('contains no implicit capture at module evaluation', async () => {
		const module = await import('./inventory-advisor-evidence');
		expect(module.InventoryAdvisorEvidenceService).toBeTypeOf('function');
	});
});
