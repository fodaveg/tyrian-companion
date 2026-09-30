import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { baseSemanticHash } from './managed-assets';
import { PUBLISHED_BASE_FINGERPRINTS } from './published-base-hashes';
import { createTranslator } from '../core/i18n';
import { projectManagedAssetsDescription } from '../ui/settings-i18n';

describe('published Base fingerprints', () => {
	it('lists the current version of every Base of the bundle, in every locale', async () => {
		const bases = (await managedAssetsBundle()).filter((asset) => asset.kind === 'base');
		expect(bases.length).toBeGreaterThan(0);
		for (const asset of bases) {
			const hash = await baseSemanticHash(asset.bytes);
			expect(
				PUBLISHED_BASE_FINGERPRINTS.some((row) => row.assetId === asset.id && row.locale === asset.locale &&
					row.contentVersion === asset.contentVersion && row.semanticHash === hash),
				`${asset.id}/${asset.locale}@${String(asset.contentVersion)} is missing from the table: run scripts/generate-published-base-hashes.ts`,
			).toBe(true);
		}
	});

	it('is well formed: lowercase sha-256 hashes and no duplicated row', () => {
		const keys = PUBLISHED_BASE_FINGERPRINTS.map((row) => `${row.assetId}|${row.locale}|${String(row.contentVersion)}|${row.semanticHash}`);
		expect(new Set(keys).size).toBe(keys.length);
		for (const row of PUBLISHED_BASE_FINGERPRINTS) expect(row.semanticHash).toMatch(/^[a-f0-9]{64}$/u);
	});
});

describe('Settings preview of files the user owns', () => {
	it.each([['es', 'Tuya, no se toca'], ['en', 'Yours, left untouched']] as const)('lists an unowned file as «%s» in %s', (language, text) => {
		const description = projectManagedAssetsDescription({
			status: 'ready', message: 'preview_ready',
			plan: { kind: 'upgrade', root: 'R', canApply: true, reasons: [], steps: [{ id: 'inventory-base', path: 'R/Bases/Inventory.base', status: 'occupied_unowned' }] },
		}, createTranslator(language));
		expect(description).toContain(`${text}: R/Bases/Inventory.base`);
	});
});
