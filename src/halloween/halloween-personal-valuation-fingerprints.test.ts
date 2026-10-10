import { describe, expect, it } from 'vitest';

import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import { sha256StandardCanonicalValue } from '../advisor/inventory-advisor-contract';
import { halloweenTrickOrTreatBagModel } from '../economy/models/halloween-trick-or-treat-bag';

// Split out of `halloween-personal-valuation-architecture.test.ts` (GR-04): this one loads the built-in
// bundle and hashes it, it does not read module source, so it runs in `check` while the architecture file
// stays in the frozen source-text list.
describe('H11.6 personal Halloween valuation fingerprints', () => {
	it('keeps the manual overlay outside the curated model, economy pack and fingerprints', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:23:00.000Z');
		if (loaded.status !== 'available') throw new Error('Expected built-in bundle.');
		const model = halloweenTrickOrTreatBagModel();
		expect(loaded.bundle.economyPack.modelFingerprint).toBe(
			'97341d809b96df1bd575e42cb72fb7f23b3c9fd8dea548fa5bbc6fb53a310a8a',
		);
		expect(loaded.bundle.economyPack.modelFingerprint).toBe(sha256StandardCanonicalValue(model));
		expect(loaded.bundle.economyPack.sha256).toBe(
			'394d119fd65bd86ce58a14d0ef506eebf9ccb9091fb43d80d5c045f760ff97ab',
		);
		expect(JSON.stringify(model)).not.toContain('personalValuation');
		expect(JSON.stringify(loaded.bundle.economyPack)).not.toContain('personalValuation');
	});
});
