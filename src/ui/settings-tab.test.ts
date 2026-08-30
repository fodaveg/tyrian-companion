import { describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import { DEFAULT_SETTINGS, type TyrianSettings } from '../core/settings';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import type { ConnectionErrorCode } from '../account/account-service';
import type { ConnectionState } from '../account/connection-service';
import type { ManagedAssetsView } from '../assets/managed-assets-ui';
import {
	CONNECTION_ERROR_KEYS,
	projectConnectionDescription,
	projectManagedAssetsDescription,
} from './settings-i18n';
import {
	TyrianCompanionSettingTab,
	projectLocalDebugStatus,
	runConfirmedLocalDebugClear,
	runConfirmedLocalDebugExport,
} from './settings-tab';

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

	it('prefixes a clear divergence notice when the managed root left the output folder', () => {
		const view: ManagedAssetsView = { status: 'ready', message: 'assets_ready', plan: null };
		const divergence = { managedAssetsRoot: 'Tyrian Companion', outputFolder: '02 - Áreas/Guild Wars 2/Tyrian Companion' };
		expect(projectManagedAssetsDescription(view, createTranslator('es'), divergence)).toBe(
			'Los assets gestionados siguen en «Tyrian Companion», no en la carpeta de salida «02 - Áreas/Guild Wars 2/Tyrian Companion». '
			+ 'Usa Mover para llevarlos ahí. Los assets gestionados están listos.',
		);
		expect(projectManagedAssetsDescription(view, createTranslator('en'), divergence)).toBe(
			'Managed assets still live in "Tyrian Companion", not in the output folder "02 - Áreas/Guild Wars 2/Tyrian Companion". '
			+ 'Use Move to relocate them there. Managed assets are ready.',
		);
	});

	it('omits the divergence notice once both roots match', () => {
		const view: ManagedAssetsView = { status: 'ready', message: 'assets_ready', plan: null };
		expect(projectManagedAssetsDescription(view, createTranslator('es'), null)).toBe('Los assets gestionados están listos.');
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

describe('Halloween price-alert settings wiring', () => {
	it('rebuilds the open settings tab and immediately reflects enabled controls after every change', async () => {
		const plugin = settingsPlugin();
		const tab = new TyrianCompanionSettingTab({ vault: { configDir: 'config-dir' } } as never, plugin as never);
		const refresh = vi.spyOn(tab, 'refreshForSettingsChange').mockImplementation(() => undefined);
		const definitions = () => tab.getSettingDefinitions() as unknown as RenderableSettingDefinition[];
		const byName = (name: string) => definitions().find((definition) => definition.name === name)!;
		const enabledName = 'Local bag price alert';
		const marginName = 'Minimum margin above p90';
		const cooldownName = 'Price-alert cooldown';

		expect(renderControl(byName(marginName), 'text').disabled).toBe(true);
		expect(renderControl(byName(cooldownName), 'dropdown').disabled).toBe(true);
		await renderControl(byName(enabledName), 'dropdown').change('on');
		expect(plugin.settings.halloweenPriceAlertEnabled).toBe(true);
		expect(refresh).toHaveBeenCalledOnce();
		expect(renderControl(byName(marginName), 'text').disabled).toBe(false);
		expect(renderControl(byName(cooldownName), 'dropdown').disabled).toBe(false);

		await renderControl(byName(marginName), 'text').change('125');
		await renderControl(byName(cooldownName), 'dropdown').change('48');
		expect(plugin.settings).toMatchObject({
			halloweenPriceAlertMinimumAboveP90Bps: 125, halloweenPriceAlertCooldownHours: 48,
		});
		expect(refresh).toHaveBeenCalledTimes(3);
		await renderControl(byName(enabledName), 'dropdown').change('off');
		expect(renderControl(byName(marginName), 'text').disabled).toBe(true);
		expect(refresh).toHaveBeenCalledTimes(4);
	});
});

describe('assisted-detection polling settings', () => {
	it('offers and selects the two-minute beta cadence', () => {
		const plugin = settingsPlugin();
		const tab = new TyrianCompanionSettingTab({ vault: { configDir: 'config-dir' } } as never, plugin as never);
		const definition = (tab.getSettingDefinitions() as unknown as RenderableSettingDefinition[])
			.find((candidate) => candidate.name === 'Polling interval');
		if (definition === undefined) throw new Error('Expected polling interval setting.');

		const control = renderControl(definition, 'dropdown');

		expect(plugin.settings.pollingIntervalMinutes).toBe(2);
		expect(control.options).toContain('2');
		expect(control.value).toBe('2');

		plugin.settings.pollingIntervalMinutes = 60;
		const existing = renderControl(definition, 'dropdown');
		expect(existing.value).toBe('60');
		return expect(existing.change('2')).resolves.toBeUndefined().then(() => {
			expect(plugin.settings.pollingIntervalMinutes).toBe(2);
		});
	});
});

describe('settings information architecture', () => {
	it('assigns all 25 existing rows to explicit intent categories', () => {
		const tab = new TyrianCompanionSettingTab({ vault: { configDir: 'config-dir' } } as never, settingsPlugin() as never);
		const assignments = tab.getSettingCategoryAssignments();
		expect(assignments).toHaveLength(25);
		expect(assignments.filter(({ category }) => category === 'account')).toHaveLength(7);
		expect(assignments.filter(({ category }) => category === 'inventory')).toHaveLength(5);
		expect(assignments.filter(({ category }) => category === 'economy')).toHaveLength(10);
		expect(assignments.filter(({ category }) => category === 'diagnostics')).toHaveLength(3);
		expect(assignments.every(({ category }) => ['account', 'inventory', 'economy', 'diagnostics'].includes(category))).toBe(true);
	});
});

describe('local diagnostics settings', () => {
	it('projects degraded writer health as an alert with bounded operational details', () => {
		const status: LocalDebugStatus = {
			enabled: true, minimumLevel: 'warn', state: 'degraded',
			path: 'test-config-dir/plugins/tyrian-companion/logs/', bytes: 2048, fileCount: 2,
			lastEventAt: '2026-08-30T04:00:00.000Z', droppedRecords: 3,
			errorCode: 'logger_failure', queuedRecords: 0, recoveredTails: 0,
		};
		const translator = createTranslator('en');
		expect(projectLocalDebugStatus(status, translator.t.bind(translator))).toEqual({
			role: 'alert',
			lines: [
				'Writer degraded: some entries could not be saved.',
				'Folder: test-config-dir/plugins/tyrian-companion/logs/',
				'2048 bytes in 2 files',
				'Last event: 2026-08-30T04:00:00.000Z',
				'Dropped entries: 3',
			],
		});
	});

	it('never exports or clears before confirmation and executes exactly once after acceptance', async () => {
		const exportPackage = vi.fn(async () => 'Tyrian Companion/diagnostics/package.json');
		const clear = vi.fn(async () => true);
		await expect(runConfirmedLocalDebugExport(async () => false, exportPackage)).resolves.toBe(false);
		await expect(runConfirmedLocalDebugClear(async () => false, clear)).resolves.toBeNull();
		expect(exportPackage).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
		await expect(runConfirmedLocalDebugExport(async () => true, exportPackage))
			.resolves.toBe('Tyrian Companion/diagnostics/package.json');
		await expect(runConfirmedLocalDebugClear(async () => true, clear)).resolves.toBe(true);
		expect(exportPackage).toHaveBeenCalledOnce();
		expect(clear).toHaveBeenCalledOnce();
	});
});

function settingsPlugin() {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, language: 'en' as const } as TyrianSettings,
		updateSettings: async (update: Partial<TyrianSettings>) => { Object.assign(plugin.settings, update); },
		previewSessionHistoryScrub: async () => undefined,
		cancelSessionHistoryScrubPreview: () => undefined,
		scrubSessionHistory: async () => undefined,
		getManagedAssetsView: () => ({ status: 'ready' as const, message: 'assets_ready' as const, plan: null }),
		getSessionHistoryView: () => ({ status: 'idle' as const, sessions: 0 }),
		getConnectionState: () => ({ status: 'idle' as const }),
		hasManagedAssetsRoot: () => false,
	};
	return plugin;
}

interface FakeControl {
	disabled: boolean;
	options: readonly string[];
	value: string;
	change(value: string): Promise<void>;
}

interface RenderableSettingDefinition {
	name: string;
	render(setting: never): void;
}

function renderControl(
	definition: RenderableSettingDefinition,
	kind: 'dropdown' | 'text',
): FakeControl {
	let listener: (value: string) => Promise<void> | void = () => undefined;
	let selectedValue = '';
	const options: string[] = [];
	const component = {
		disabled: false,
		addOption: (value: string) => { options.push(value); return component; },
		setValue: (value: string) => { selectedValue = value; return component; },
		setDisabled: (disabled: boolean) => { component.disabled = disabled; return component; },
		onChange: (next: typeof listener) => { listener = next; return component; },
	};
	const setting = {
		addDropdown: (render: (control: typeof component) => unknown) => { if (kind === 'dropdown') render(component); return setting; },
		addText: (render: (control: typeof component) => unknown) => { if (kind === 'text') render(component); return setting; },
	};
	definition.render(setting as never);
	return {
		get disabled() { return component.disabled; },
		get value() { return selectedValue; },
		options,
		change: async (value) => { await listener(value); },
	};
}
