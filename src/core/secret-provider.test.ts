import { describe, expect, it } from 'vitest';

import { ObsidianApiKeyProvider } from './secret-provider';

function createProvider(secretNames: string[], selection: string): ObsidianApiKeyProvider {
	return new ObsidianApiKeyProvider(
		{
			secretStorage: {
				listSecrets: () => secretNames,
				getSecret: (id) => (secretNames.includes(id) ? 'secret-value' : null),
			},
		},
		() => selection,
	);
}

describe('ObsidianApiKeyProvider', () => {
	it('is not configured when no secret is selected', () => {
		expect(createProvider(['gw2-primary'], '').hasSelection()).toBe(false);
	});

	it('is configured when the selected secret exists', () => {
		expect(createProvider(['gw2-primary'], 'gw2-primary').hasSelection()).toBe(true);
	});

	it('is not configured after the selected secret is deleted', () => {
		const secretNames = ['gw2-primary'];
		const provider = createProvider(secretNames, 'gw2-primary');

		expect(provider.hasSelection()).toBe(true);
		secretNames.splice(0, 1);
		expect(provider.hasSelection()).toBe(false);
		expect(provider.getApiKey()).toBeNull();
	});
});
