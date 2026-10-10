// @vitest-environment happy-dom
import { join } from 'node:path';

import type { HebraPluginApi } from 'hebra-plugin-api';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator, TRANSLATIONS, type Locale } from '../../core/i18n';
import { createTyrianRuntime, EXPORT_LEGACY_SESSION_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID, TYRIAN_MAIN_VIEW_TYPE, type TyrianCompanionCore } from '../../runtime/tyrian-companion-core';
import { createTyrianTestApi, hebraSettingsKey, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { fixedCopyIn, fixedCopyOffenders } from '../../test/module-boundary';
import { withRealHostBehaviour, type RealHost } from '../../test/hebra-real-host';
import { COMPANION_VIEW_TYPE } from '../../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from '../../ui/inventory-advisor-item-view';
import { SALE_VIEW_TYPE } from '../../ui/sale-item-view';
import { installDomHelpers } from '../dom-polyfill';
import { attachFolderPicker } from './folder-picker';
import { outputFolderChangedNotice, outputFolderRestartFailedNotice } from './hebra-host';
import { activateTyrian } from './hebra-runtime';
import { createMemorySecretsBackend, createPreloadedSecrets } from './secrets';
import { createHebraTranslator, createSecretControl } from './setting-row';
import { mountUnadoptedNotesPanel, registerUnadoptedNotes } from './unadopted-panel';
import type { TyrianUnadoptedNote } from './path-index';

/**
 * Every fixed text of the Hebra adapter (HP-04) in both languages, and the titles of the views
 * following a language change (HP-08). The units use the adapter's own translator; the end-to-end
 * ones run the real core over the real host on the package's fake of Hebra.
 */

installDomHelpers();

const LOCALES: readonly Locale[] = ['es', 'en'];
const translatorFor = (locale: Locale) => () => createTranslator(locale);
const hosts: RealHost[] = [];

afterEach(() => {
	const faults = hosts.splice(0).flatMap((host) => host.faults);
	document.body.replaceChildren();
	vi.restoreAllMocks();
	expect(faults, 'a function of the plugin threw and Hebra swallowed it').toEqual([]);
});

const duplicate: TyrianUnadoptedNote = {
	id: 'n-dup', title: 'Ectoplasm', family: 'inventory', reason: 'path_taken', candidates: ['Inventory/a.md'],
};
const broken: TyrianUnadoptedNote = { id: 'n-broken', title: '', family: 'collector_status', reason: 'invalid_marker', candidates: [] };

describe('no fixed user-facing text is left in the adapter', () => {
	it('src/host/hebra/*.ts (tests aside) hands the user only catalogue or variable text', () => {
		expect(fixedCopyOffenders(join(process.cwd(), 'src/host/hebra'))).toEqual([]);
	});

	// The detector itself: the ways of writing a fixed text it must catch, and the ones it must let through.
	it.each([
		["u.notice('Could not restart the plugin.');", 1],
		["u.notice('Reinicia el plugin ahora');", 1],
		["u.notice(`\nEstá roto\n`);", 1],
		["u.notice('http://x Está');", 1],
		["u.notice(`Reiniciado: ${folder}`);", 1],
		["el.textContent = flag ? 'Sí' : t.t('k');", 1],
		["el.setAttribute('aria-label', 'Nombre');", 1],
		["openModal(mount, { title: 'Nuevo' });", 1],
		["el.placeholder = 'Valor' + x;", 1],
		["u.notice(t.t('hebra.command.unavailable'));", 0],
		["u.notice(message);", 0],
		["el.textContent = '';", 0],
		["el.setAttribute('role', 'presentation');", 0],
		["el.className = 'hebra-module-setting';", 0],
		["const r = { title: view.title(), name: command.name };", 0],
	])('detector: %s -> %i site(s)', (code, count) => {
		expect(fixedCopyIn(code, 'probe.ts')).toHaveLength(count);
	});
});

describe('the adapter picks the language the core uses', () => {
	it('the saved language wins; without one, the app\'s (es* is Spanish, anything else English)', () => {
		const make = (saved: unknown, app: string) => createHebraTranslator(() => saved, () => app)().locale;
		expect(make({ language: 'en' }, 'es-ES')).toBe('en');
		expect(make({ language: 'es' }, 'en-US')).toBe('es');
		expect(make(null, 'es_MX')).toBe('es');
		expect(make({}, 'en-GB')).toBe('en');
		expect(make({ language: 'fr' }, 'es')).toBe('es');
	});

	it('reads the language on every call, so a change is seen by the next paint', () => {
		let settings: unknown = { language: 'es' };
		const translator = createHebraTranslator(() => settings, () => 'es');
		expect(translator().t('hebra.secret.save')).toBe('Guardar');
		settings = { language: 'en' };
		expect(translator().t('hebra.secret.save')).toBe('Save');
	});

	it('every hebra.* key exists in both languages, with the same placeholders', () => {
		const keys = Object.keys(TRANSLATIONS.es).filter((key) => key.startsWith('hebra.'));
		expect(keys.length).toBeGreaterThan(30);
		for (const key of keys) {
			const placeholders = (locale: Locale): string[] =>
				(TRANSLATIONS[locale][key as keyof typeof TRANSLATIONS.es].match(/\{\{\w+\}\}/gu) ?? []).sort();
			expect(placeholders('en'), key).toEqual(placeholders('es'));
			expect(TRANSLATIONS.en[key as keyof typeof TRANSLATIONS.en], key).not.toBe(TRANSLATIONS.es[key as keyof typeof TRANSLATIONS.es]);
		}
	});
});

describe.each(LOCALES)('unadopted-notes panel in %s', (locale) => {
	it('paints the title, summary, reasons, buttons and the rest line in that language, with its number format', () => {
		const t = createTranslator(locale);
		const el = createDiv();
		const notes = Array.from({ length: 12_345 }, (_, i) => ({ ...broken, id: `n-${String(i)}`, title: i === 0 ? '' : `Note ${String(i)}` }));
		notes[1] = duplicate;
		mountUnadoptedNotesPanel(el, { notes, outputFolder: 'GW2', translator: translatorFor(locale), openNote: vi.fn(), report: vi.fn() });
		const rows = Array.from(el.querySelectorAll('.setting-item'));
		const grouped = locale === 'es' ? '12.345' : '12,345';
		expect(rows[0]?.querySelector('.setting-item-name')?.textContent).toBe(t.t('hebra.unadopted.title'));
		expect(rows[0]?.querySelector('.setting-item-description')?.textContent).toContain(grouped);
		expect(rows[1]?.querySelector('.setting-item-name')?.textContent).toBe(t.t('hebra.unadopted.untitled'));
		expect(rows[1]?.querySelector('.setting-item-description')?.textContent)
			.toBe(t.t('hebra.unadopted.reason.unknown', { family: t.t('hebra.unadopted.family.collector_status') }));
		expect(rows[2]?.querySelector('.setting-item-description')?.textContent)
			.toBe(t.t('hebra.unadopted.reason.path_taken', { family: t.t('hebra.unadopted.family.inventory'), path: 'Inventory/a.md' }));
		expect(rows[1]?.querySelector('button')?.textContent).toBe(locale === 'es' ? 'Abrir' : 'Open');
		expect(rows[2]?.querySelector('button')?.getAttribute('aria-label')).toBe(locale === 'es' ? 'Abrir «Ectoplasm»' : 'Open "Ectoplasm"');
		expect(rows.at(-1)?.querySelector('.setting-item-name')?.textContent).toBe(locale === 'es' ? 'Y 12.295 más' : 'And 12,295 more');
		expect(el.querySelector('section')?.getAttribute('aria-label')).toBe(locale === 'es' ? 'Notas no adoptadas' : 'Unadopted notes');
	});

	it('the seeding notice, in the singular and the plural, names the count in that language', () => {
		const notices: string[] = [];
		const ui = { settingsPanel: vi.fn(() => () => undefined), notice: (text: string) => { notices.push(text); }, openSettings: vi.fn() };
		const base = { outputFolder: 'GW2', seededNow: true, translator: translatorFor(locale), openNote: vi.fn(), report: vi.fn() };
		registerUnadoptedNotes(ui, { ...base, notes: [duplicate] });
		registerUnadoptedNotes(ui, { ...base, notes: [duplicate, broken] });
		expect(notices).toEqual(locale === 'es'
			? ['Tyrian Companion: 1 nota no se ha adoptado. Míralas en los ajustes de Tyrian Companion.', 'Tyrian Companion: 2 notas no se han adoptado. Míralas en los ajustes de Tyrian Companion.']
			: ['Tyrian Companion: 1 note was not adopted. Look at it in the Tyrian Companion settings.', 'Tyrian Companion: 2 notes were not adopted. Look at them in the Tyrian Companion settings.']);
	});
});

describe.each(LOCALES)('folder picker in %s', (locale) => {
	async function mount(paths: readonly string[] | Promise<never[]>, saved = 'GW2') {
		const input = createEl('input');
		input.value = saved;
		document.body.append(input);
		attachFolderPicker({
			folderPaths: () => Promise.resolve(paths), report: vi.fn(), translator: translatorFor(locale),
		}, input, vi.fn());
		const root = input.nextElementSibling as HTMLElement;
		const field = root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
		await new Promise((resolve) => { window.setTimeout(resolve, 0); });
		return { root, field, list: root.querySelector<HTMLElement>('[role="listbox"]')!, note: root.querySelector<HTMLElement>('.hebra-module-folder-note')! };
	}

	it('says that no folder matches, how many more there are, and that the saved one is missing', async () => {
		const many = Array.from({ length: 60 }, (_, i) => `Carpeta ${String(i)}`);
		const { field, list, note } = await mount(many, 'Otra');
		expect(note.textContent).toBe(locale === 'es' ? '«Otra» no existe en la biblioteca.' : '"Otra" does not exist in the library.');
		field.focus();
		field.value = 'Carpeta';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		expect(list.textContent).toContain(locale === 'es' ? '10 más: escribe para acotar.' : '10 more: type to narrow down.');
		field.value = 'zzz';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		expect(list.textContent).toBe(locale === 'es' ? 'Ninguna carpeta coincide.' : 'No folder matches.');
	});

	it('says it is loading while the folders have not arrived', async () => {
		const input = createEl('input');
		input.value = 'GW2';
		document.body.append(input);
		attachFolderPicker({ folderPaths: () => new Promise(() => undefined), report: vi.fn(), translator: translatorFor(locale) }, input, vi.fn());
		const root = input.nextElementSibling as HTMLElement;
		const field = root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
		field.focus();
		field.dispatchEvent(new Event('input', { bubbles: true }));
		expect(root.querySelector('[role="listbox"]')?.textContent).toBe(locale === 'es' ? 'Cargando carpetas…' : 'Loading folders…');
	});
});

describe.each(LOCALES)('secret control and dialog in %s', (locale) => {
	it('the button, the empty option, the dialog title, labels, placeholders and buttons', async () => {
		const secrets = await createPreloadedSecrets(createMemorySecretsBackend());
		let dialogTitle: string | undefined;
		const host = {
			openModal: (mount: (content: HTMLElement) => void, options?: { title?: string }) => {
				dialogTitle = options?.title;
				const content = createDiv();
				document.body.append(content);
				mount(content);
				return { close: vi.fn() };
			},
		};
		const parent = createDiv();
		document.body.append(parent);
		createSecretControl(parent, { secrets, host, report: vi.fn(), translator: translatorFor(locale) });
		const es = locale === 'es';
		expect(parent.querySelector('option')?.textContent).toBe(es ? 'Ninguno' : 'None');
		const create = parent.querySelector('button')!;
		expect(create.textContent).toBe(es ? 'Nuevo secreto…' : 'New secret…');
		create.click();
		expect(dialogTitle).toBe(es ? 'Nuevo secreto' : 'New secret');
		const inputs = Array.from(document.querySelectorAll('form input'));
		expect(inputs.map((input) => input.getAttribute('aria-label'))).toEqual(es ? ['Nombre del secreto', 'Valor del secreto'] : ['Secret name', 'Secret value']);
		expect(inputs.map((input) => input.getAttribute('placeholder'))).toEqual(es ? ['Nombre', 'Valor'] : ['Name', 'Value']);
		expect(Array.from(document.querySelectorAll('form button')).map((button) => button.textContent)).toEqual(es ? ['Cancelar', 'Guardar'] : ['Cancel', 'Save']);
	});
});

it.each(LOCALES)('the output-folder restart notices in %s', (locale) => {
	const t = createTranslator(locale);
	expect(outputFolderChangedNotice('Games/GW2', t)).toBe(locale === 'es'
		? 'Tyrian Companion se ha reiniciado para usar «Games/GW2».' : 'Tyrian Companion restarted to use "Games/GW2".');
	expect(outputFolderRestartFailedNotice('Games/GW2', t)).toContain(locale === 'es' ? 'no ha podido reiniciarse' : 'could not restart');
});

interface Started {
	test: TyrianTestApi;
	hebra: RealHost | null;
	core: TyrianCompanionCore;
	cleanup(): Promise<void>;
}

/** The real core over the real host. `language` is the SAVED setting; `appLocale` what `api.env.locale()` says. */
async function start(options: { mainView: boolean; appLocale?: string; language?: Locale }): Promise<Started> {
	const test = createTyrianTestApi({ mainView: options.mainView });
	test.library.addFolder('tc', 'root', 'Tyrian Companion');
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({
		outputFolder: 'Tyrian Companion', ...(options.language === undefined ? {} : { language: options.language }),
	}));
	const env = Object.assign(Object.create(test.api.env) as HebraPluginApi['env'], { locale: () => options.appLocale ?? 'es' });
	const base: HebraPluginApi = { ...test.api, env };
	const hebra = options.mainView ? withRealHostBehaviour({ fake: test.fake, api: base }, { mount: 'sync' }) : null;
	if (hebra !== null) hosts.push(hebra);
	let core: TyrianCompanionCore | null = null;
	const stop = await activateTyrian(hebra?.api ?? base, {
		indexedDB: new IDBFactory(),
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
	});
	await new Promise((resolve) => { window.setTimeout(resolve, 50); });
	return { test, hebra, core: core as unknown as TyrianCompanionCore, cleanup: async () => { await stop(); } };
}

describe.each(LOCALES)('the real plugin in %s', (locale) => {
	it('the two session exports say why they are unavailable, and an unknown note is named, in that language', async () => {
		const started = await start({ mainView: false, appLocale: locale });
		const { test } = started;
		const run = (id: string) => test.fake.recorded.commands.find((entry) => entry.id === `tyrian-companion:${id}`)!.run();
		void run(EXPORT_LIVE_SESSION_COMMAND_ID);
		void run(EXPORT_LEGACY_SESSION_COMMAND_ID);
		expect(test.fake.recorded.notices).toEqual(locale === 'es'
			? ['No hay ninguna sesión en curso que exportar.', 'No hay ninguna sesión antigua guardada que exportar.']
			: ['There is no current session to export.', 'There is no saved old session to export.']);
		await started.cleanup();
	}, 30_000);

	it('a command the core does not describe still falls back to the generic notice in that language', async () => {
		const started = await start({ mainView: false, appLocale: locale });
		const ui = (started.core as unknown as { host: { ui: { registerCommand(command: unknown): unknown } } }).host.ui;
		ui.registerCommand({ id: 'probe', name: 'Probe', checkCallback: () => false });
		test_run(started, 'probe');
		expect(started.test.fake.recorded.notices.at(-1)).toBe(locale === 'es' ? '«Probe» no está disponible ahora.' : '"Probe" is not available right now.');
		await started.cleanup();
	}, 30_000);
});

function test_run({ test }: Started, id: string): void {
	void test.fake.recorded.commands.find((entry) => entry.id === `tyrian-companion:${id}`)!.run();
}

describe('the saved language wins over the app\'s in the adapter\'s notices', () => {
	it('app in English, plugin saved in Spanish: Spanish', async () => {
		const started = await start({ mainView: false, appLocale: 'en-US', language: 'es' });
		test_run(started, EXPORT_LIVE_SESSION_COMMAND_ID);
		expect(started.test.fake.recorded.notices).toEqual(['No hay ninguna sesión en curso que exportar.']);
		await started.cleanup();
	}, 30_000);
});

describe('HP-08: the titles of the views follow a language change', () => {
	it('main screen: the main view is updated once, with its title in the new language', async () => {
		const started = await start({ mainView: true, language: 'es' });
		const { hebra, core } = started;
		const updateView = vi.spyOn(hebra!.api.ui, 'updateView');
		await core.updateSettings({ language: 'en' });
		expect(updateView).toHaveBeenCalledTimes(1);
		expect(updateView).toHaveBeenCalledWith(TYRIAN_MAIN_VIEW_TYPE, { title: 'Tyrian Companion' });
		await started.cleanup();
	}, 30_000);

	it('three column views: each is updated with its title in the new language', async () => {
		const started = await start({ mainView: true, language: 'es' });
		const { test, hebra, core } = started;
		await core.updateViewPlacement('sidebar');
		const ids = [COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE];
		expect(hebra!.ownViews.registered()).toEqual(ids);
		const before = ids.map((id) => test.fake.viewTitle(id));
		await core.updateSettings({ language: 'en' });
		const after = ids.map((id) => test.fake.viewTitle(id));
		expect(after).not.toEqual(before);
		expect(after.every((title) => title !== null && title !== '')).toBe(true);
		expect(after[1]).toBe(createTranslator('en').t('advisor.view.title'));
		expect(before[1]).toBe(createTranslator('es').t('advisor.view.title'));
		await started.cleanup();
	}, 30_000);

	it('a Hebra without the main view (no updateView at all): a language change calls nothing and does not throw', async () => {
		const started = await start({ mainView: false, language: 'es' });
		const { test, core } = started;
		// Hebra 1.2.0 has no `ui.updateView`: changing language must not throw nor call anything.
		expect(test.api.ui).not.toHaveProperty('updateView');
		await expect(core.updateSettings({ language: 'en' })).resolves.toMatchObject({ status: 'saved' });
		await started.cleanup();
	}, 30_000);

	it('a language that does not change updates nothing', async () => {
		const started = await start({ mainView: true, language: 'es' });
		const updateView = vi.spyOn(started.hebra!.api.ui, 'updateView');
		await started.core.updateSettings({ language: 'es' });
		expect(updateView).not.toHaveBeenCalled();
		await started.cleanup();
	}, 30_000);
});
