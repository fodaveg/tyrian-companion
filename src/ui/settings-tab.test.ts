import { describe, expect, it } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { ConnectionErrorCode } from '../account/account-service';
import type { ConnectionState } from '../account/connection-service';
import type { ManagedAssetsView } from '../assets/managed-assets-ui';
import {
	CONNECTION_ERROR_KEYS,
	projectConnectionDescription,
	projectManagedAssetsDescription,
} from './settings-i18n';

describe('Settings i18n projection', () => {
	it('keeps the connection error projection exhaustive for every gateway code', () => {
		expect(Object.keys(CONNECTION_ERROR_KEYS).sort()).toEqual([
			'invalid_response', 'key_expired', 'key_invalid', 'missing_key',
			'rate_limited', 'scope_missing', 'unavailable', 'url_restricted',
		]);
	});

	it('translates closed managed-assets messages, reasons, and step statuses in both locales', () => {
		const view: ManagedAssetsView = {
			status: 'ready', message: 'preview_blocked',
			plan: {
				kind: 'install', root: 'Tyrian Companion', canApply: false, reasons: ['modified'],
				steps: [{ id: 'sessions-base', path: 'Tyrian Companion/Bases/Sessions.base', status: 'modified' }],
			},
		};
		expect(projectManagedAssetsDescription(view, createTranslator('es')))
			.toBe('La vista previa está bloqueada: Modificado. Modificado: Tyrian Companion/Bases/Sessions.base');
		expect(projectManagedAssetsDescription(view, createTranslator('en')))
			.toBe('Preview is blocked: Modified. Modified: Tyrian Companion/Bases/Sessions.base');
	});


	it.each([
		['missing_key', 'Selecciona una clave API de Obsidian antes de comprobar la conexión.', 'Select an Obsidian API key before checking the connection.'],
		['key_invalid', 'La clave API fue rechazada. Selecciona una clave válida y vuelve a intentarlo.', 'The API key was rejected. Select a valid key and try again.'],
		['key_expired', 'La clave API ha caducado. Crea o selecciona una clave vigente y vuelve a intentarlo.', 'The API key has expired. Create or select a current key and try again.'],
		['url_restricted', 'La clave API restringe los endpoints necesarios. Usa una clave que permita tokeninfo y account.', 'The API key restricts required endpoints. Use a key that permits tokeninfo and account.'],
		['scope_missing', 'La clave API no incluye el permiso account. Crea o selecciona una clave que lo incluya.', 'The API key does not include the account permission. Create or select a key that includes it.'],
		['rate_limited', 'Guild Wars 2 limita temporalmente las comprobaciones. Espera y vuelve a intentarlo.', 'Guild Wars 2 is temporarily limiting connection checks. Wait and try again.'],
		['unavailable', 'Guild Wars 2 no está disponible para comprobar la conexión. Vuelve a intentarlo más tarde.', 'Guild Wars 2 is unavailable for a connection check. Try again later.'],
		['invalid_response', 'Guild Wars 2 devolvió una respuesta no válida. Vuelve a intentarlo y revisa la clave si continúa.', 'Guild Wars 2 returned an invalid response. Try again and check the key if it continues.'],
	] as const satisfies ReadonlyArray<readonly [ConnectionErrorCode, string, string]>)('maps %s to actionable Spanish and English guidance without exposing the raw error', (code, es, en) => {
			const error = { status: 'error', code, message: 'Raw transport failure.', retryAt: null } as const;
			expect(CONNECTION_ERROR_KEYS[code]).toMatch(/^settings\.connection\.error\./u);
			expect(projectConnectionDescription(error, createTranslator('es'), 0)).toBe(es);
			expect(projectConnectionDescription(error, createTranslator('en'), 0)).toBe(en);
		});

	it('uses a localized safe fallback for an unexpected legacy error code', () => {
		const error = { status: 'error', code: 'legacy_gateway_failure', message: 'Raw transport failure.', retryAt: null } as const;
		expect(projectConnectionDescription(error, createTranslator('es'), 0))
			.toBe('La comprobación de conexión falló de forma inesperada. Vuelve a intentarlo.');
	});

	it('localizes closed warning reasons while retaining account data as data', () => {
		const warning = {
			status: 'warning', reason: 'stale_connection', message: 'Last verified account shown.', retryAt: null,
			details: { account: { name: 'Astra.1234' }, keyName: 'vault-key', scopes: ['account'], missingRecommendedScopes: [], hasFutureUrlRestrictions: false },
		} as unknown as ConnectionState;
		expect(projectConnectionDescription(warning, createTranslator('es'), 0))
			.toBe('Se muestra la última cuenta verificada; la comprobación actual falló. Astra.1234 · vault-key · account');
	});
});
