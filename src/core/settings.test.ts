import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalizeSettings } from './settings';

describe('normalizeSettings', () => {
	it('uses defaults for missing or invalid persisted data', () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ apiKeySecret: 42 })).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps only the SecretStorage name', () => {
		expect(
			normalizeSettings({
				apiKeySecret: 'gw2-primary',
				apiKey: 'must-not-be-persisted',
			}),
		).toEqual({ apiKeySecret: 'gw2-primary' });
	});
});
