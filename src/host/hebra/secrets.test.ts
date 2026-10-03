import { describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi, TYRIAN_KEYCHAIN_ACCOUNT } from '../../test/hebra-plugin-fakes';
import {
	createMemorySecretsBackend,
	createPreloadedSecrets,
	hebraSecretsBackend,
	LEGACY_SECRET_NAME,
	parseSecretsDocument,
} from './secrets';

// Ported from Hebra's `src/lib/modules/tyrian/secrets.test.ts`, plus the backend over `api.secrets`.

describe('createPreloadedSecrets', () => {
	it('with nothing saved: empty list and null get', async () => {
		const secrets = await createPreloadedSecrets(createMemorySecretsBackend());
		expect(secrets.list()).toEqual([]);
		expect(secrets.get('gw2')).toBeNull();
	});

	it('set answers at once (synchronously) and writes the whole JSON behind', async () => {
		const backend = createMemorySecretsBackend();
		const secrets = await createPreloadedSecrets(backend);
		secrets.set('gw2-api', 'KEY-1');
		secrets.set('ingame-token', 'TOKEN-1');
		expect(secrets.get('gw2-api')).toBe('KEY-1');
		expect(secrets.list()).toEqual(['gw2-api', 'ingame-token']);
		await secrets.flush();
		expect(JSON.parse(backend.value ?? '')).toEqual({ v: 1, secrets: { 'gw2-api': 'KEY-1', 'ingame-token': 'TOKEN-1' } });
		expect((await createPreloadedSecrets(backend)).get('ingame-token')).toBe('TOKEN-1');
	});

	it('a keychain write failure is reported and does not break the next writes', async () => {
		const onError = vi.fn();
		let fail = true;
		const saved: string[] = [];
		const secrets = await createPreloadedSecrets({
			load: async () => null,
			save: async (value) => {
				if (fail) {
					fail = false;
					throw new Error('keychain locked');
				}
				saved.push(value);
			},
		}, onError);
		secrets.set('a', '1');
		secrets.set('b', '2');
		await secrets.flush();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(saved).toHaveLength(1);
		expect((JSON.parse(saved[0] ?? '') as { secrets: unknown }).secrets).toEqual({ a: '1', b: '2' });
	});
});

describe('parseSecretsDocument', () => {
	it('adopts a bare key saved before the format as a named secret, and drops values that are not text', () => {
		expect(parseSecretsDocument('ABCD-1234')).toEqual({ [LEGACY_SECRET_NAME]: 'ABCD-1234' });
		expect(parseSecretsDocument(JSON.stringify({ v: 1, secrets: { a: 'x', b: 3 } }))).toEqual({ a: 'x' });
	});
});

describe('hebraSecretsBackend', () => {
	it('reads and writes the keychain entry through api.secrets key `api-key`, the old account', async () => {
		const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { gw2: 'KEY' } })]]);
		const { api } = createTyrianTestApi({ keychain });
		const secrets = await createPreloadedSecrets(await hebraSecretsBackend(api, vi.fn()));
		expect(secrets.get('gw2')).toBe('KEY');
		secrets.set('ingame', 'TOKEN');
		await secrets.flush();
		expect(JSON.parse(keychain.get(TYRIAN_KEYCHAIN_ACCOUNT) ?? '')).toEqual({ v: 1, secrets: { gw2: 'KEY', ingame: 'TOKEN' } });
	});

	it('falls back to memory where this Hebra has no secrets (the web, or `capability-not-available`)', async () => {
		const report = vi.fn();
		const { api } = createTyrianTestApi({ keychain: null });
		expect(api.has('secrets')).toBe(false);
		const backend = await hebraSecretsBackend(api, report);
		await backend.save('kept in memory');
		expect(await backend.load()).toBe('kept in memory');
		expect(report).not.toHaveBeenCalled();
	});

	it('falls back to memory, reported once, when reading the keychain rejects', async () => {
		const report = vi.fn();
		const { api } = createTyrianTestApi();
		const failing = { ...api, secrets: { ...api.secrets, get: () => Promise.reject(new Error('locked')) } };
		const backend = await hebraSecretsBackend(failing, report);
		expect(await backend.load()).toBeNull();
		expect(report).toHaveBeenCalledWith(expect.any(Error), 'secrets.load');
	});
});
