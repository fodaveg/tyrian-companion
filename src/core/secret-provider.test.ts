import { describe, expect, it } from 'vitest';

import { HostApiKeyProvider } from './secret-provider';

function createProvider(secretNames: string[], selection: string): HostApiKeyProvider {
	return new HostApiKeyProvider(
		{
			list: () => secretNames,
			get: (id) => (secretNames.includes(id) ? 'secret-value' : null),
		},
		() => selection,
	);
}

describe('HostApiKeyProvider', () => {
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
		expect(provider.readSelectedApiKey()).toBeNull();
	});

	it('reads the selected value from the host on every call and keeps nothing', () => {
		const values = new Map([['gw2-primary', 'first']]);
		const provider = new HostApiKeyProvider(
			{ list: () => [...values.keys()], get: (id) => values.get(id) ?? null },
			() => 'gw2-primary',
		);

		expect(provider.readSelectedApiKey()).toBe('first');
		values.set('gw2-primary', 'rotated');
		expect(provider.readSelectedApiKey()).toBe('rotated');
	});
});
