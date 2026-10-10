// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi, hebraSettingsKey, TYRIAN_KEYCHAIN_ACCOUNT, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { createTyrianRuntime, type TyrianCompanionCore } from '../../runtime/tyrian-companion-core';
import { activateTyrian } from './hebra-runtime';

/**
 * Hebra, 10 oct 2026 («los assets no se aplican al intentar darle a aplicar»). In Hebra the vault IS the
 * output folder, so after the user picks another Hebra folder as output the root the durable pointer names
 * lies outside the vault: it reads as empty, Move cannot read it, and Apply into the new folder answered
 * `operation_conflict` for ever (the new folder has no manifest, and only that install could write one).
 * This runs the REAL core over HebraHost and clicks the real «Aplicar» button of the Settings panel.
 */

interface ApplyCore {
	settings: { managedAssetsRoot: string | null; outputFolder: string };
	getManagedAssetsView(): { status: string; message: string };
}

afterEach(() => {
	document.body.replaceChildren();
	document.body.className = '';
});

describe('Tyrian in Hebra: «Aplicar» on managed assets after the output folder changed', () => {
	it('installs the Bases into the new output folder and leaves the old folder untouched', async () => {
		const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { 'gw2-main': 'KEY' } })]]);
		const test = createTyrianTestApi({ keychain });
		test.library.addFolder('first', 'root', 'Tyrian Companion');
		test.library.addFolder('second', 'root', 'Other');
		const factory = new IDBFactory();
		saveSettings(test, { outputFolder: 'Tyrian Companion' });

		// First start: the Bases are installed in «Tyrian Companion» and the pointer remembers that root.
		const first = await activate(test, factory);
		await clickApply(test);
		expect(first.core.settings.managedAssetsRoot).toBe('Tyrian Companion');
		const oldFolderFiles = [...test.library.files.values()].filter((file) => file.folderId !== 'second').map((file) => file.id);
		expect(oldFolderFiles.length).toBeGreaterThan(1);
		await first.cleanup();

		// The user picks «Other» as the output folder; managedAssetsRoot still names the old one.
		saveSettings(test, { outputFolder: 'Other', managedAssetsRoot: 'Tyrian Companion' });
		const second = await activate(test, factory);
		expect(second.core.settings).toMatchObject({ outputFolder: 'Other', managedAssetsRoot: 'Tyrian Companion' });
		await clickApply(test);

		expect(second.core.getManagedAssetsView()).toEqual({ status: 'ready', message: 'lifecycle_ready', plan: null });
		expect(second.core.settings.managedAssetsRoot).toBe('Other');
		const names = (folderId: string) => [...test.library.files.values()].filter((file) => file.folderId === folderId).map((file) => file.name);
		expect(names('second')).toContain('Tyrian Companion Assets.json');
		expect(test.library.folders.filter((folder) => folder.name === 'Bases' && folder.parentId === 'second')).toHaveLength(1);
		expect([...test.library.files.values()].filter((file) => file.name.endsWith('.base') && file.trashedAt === null)).toHaveLength(6);
		for (const id of oldFolderFiles) expect(test.library.files.get(id)?.trashedAt).toBeNull();
		await second.cleanup();
	}, 30_000);

	/**
	 * Review of c16a4a76: with Move switched off for all of Hebra, picking the PARENT of the old root as output
	 * (the old root is still inside the vault and readable) left Apply answering `operation_conflict` for ever,
	 * where the start used to move the Bases on its own. Moving depends on the old root being readable, not on Hebra.
	 */
	it('moves the Bases on its own when the new output folder is the PARENT of the old root', async () => {
		const test = nestedHebra();
		const factory = new IDBFactory();
		saveSettings(test, { outputFolder: 'Other/Tyrian Companion' });
		const first = await activate(test, factory);
		await clickApply(test);
		expect(first.core.settings.managedAssetsRoot).toBe('Other/Tyrian Companion');
		await first.cleanup();

		saveSettings(test, { outputFolder: 'Other', managedAssetsRoot: 'Other/Tyrian Companion' });
		const second = await activate(test, factory);
		await new Promise((resolve) => { window.setTimeout(resolve, 600); });
		expect(second.core.settings.managedAssetsRoot).toBe('Other');
		expect(second.core.getManagedAssetsView()).toMatchObject({ status: 'ready' });
		const manifests = [...test.library.files.values()].filter((file) => file.name === 'Tyrian Companion Assets.json' && file.trashedAt === null);
		expect(manifests.map((file) => file.folderId)).toContain('outer');
		// The Bases left the old folder (Move trashes the intact ones) and now live under the new root.
		expect([...test.library.files.values()].filter((file) => file.folderId !== 'outer' && file.name.endsWith('.base') && file.trashedAt === null && test.library.folders.find((folder) => folder.id === file.folderId)?.parentId === 'first')).toEqual([]);

		// And Apply, pressed anyway, is not a conflict.
		await clickApply(test);
		expect(second.core.getManagedAssetsView()).toMatchObject({ status: 'ready' });
		await second.cleanup();
	}, 30_000);

	/** Second review: the manifest of the old root is lost but its Bases are intact; the parent folder is still the output. */
	it('moves the Bases when the new output folder is the PARENT of the old root and its manifest is lost', async () => {
		const test = nestedHebra();
		const factory = new IDBFactory();
		saveSettings(test, { outputFolder: 'Other/Tyrian Companion' });
		const first = await activate(test, factory);
		await clickApply(test);
		await first.cleanup();
		for (const file of test.library.files.values()) if (file.name === 'Tyrian Companion Assets.json') file.trashedAt = Date.now();

		saveSettings(test, { outputFolder: 'Other', managedAssetsRoot: 'Other/Tyrian Companion' });
		const second = await activate(test, factory);
		await new Promise((resolve) => { window.setTimeout(resolve, 600); });
		await clickApply(test);

		expect(second.core.getManagedAssetsView()).toMatchObject({ status: 'ready' });
		expect(second.core.settings.managedAssetsRoot).toBe('Other');
		const live = [...test.library.files.values()].filter((file) => file.trashedAt === null);
		expect(live.some((file) => file.folderId === 'outer' && file.name === 'Tyrian Companion Assets.json')).toBe(true);
		await second.cleanup();
	}, 30_000);

	it('installs by Apply when the new output folder is INSIDE the old root (the old root is not readable)', async () => {
		const test = nestedHebra();
		test.library.addFolder('inner', 'first', 'Sub');
		const factory = new IDBFactory();
		saveSettings(test, { outputFolder: 'Other/Tyrian Companion' });
		const first = await activate(test, factory);
		await clickApply(test);
		await first.cleanup();

		saveSettings(test, { outputFolder: 'Other/Tyrian Companion/Sub', managedAssetsRoot: 'Other/Tyrian Companion' });
		const second = await activate(test, factory);
		await clickApply(test);
		expect(second.core.getManagedAssetsView()).toMatchObject({ status: 'ready', message: 'lifecycle_ready' });
		expect(second.core.settings.managedAssetsRoot).toBe('Other/Tyrian Companion/Sub');
		expect([...test.library.files.values()].some((file) => file.folderId === 'inner' && file.name === 'Tyrian Companion Assets.json')).toBe(true);
		await second.cleanup();
	}, 30_000);

	it('installs by Apply when the new output folder is the «Bases» folder of the old root', async () => {
		const test = nestedHebra();
		const factory = new IDBFactory();
		saveSettings(test, { outputFolder: 'Other/Tyrian Companion' });
		const first = await activate(test, factory);
		await clickApply(test);
		await first.cleanup();

		saveSettings(test, { outputFolder: 'Other/Tyrian Companion/Bases', managedAssetsRoot: 'Other/Tyrian Companion' });
		const second = await activate(test, factory);
		await clickApply(test);
		expect(second.core.getManagedAssetsView()).toMatchObject({ status: 'ready', message: 'lifecycle_ready' });
		const inner = test.library.folders.find((folder) => folder.name === 'Bases' && folder.parentId === 'first')!.id;
		expect([...test.library.files.values()].some((file) => file.folderId === inner && file.name === 'Tyrian Companion Assets.json')).toBe(true);
		expect(second.core.settings.managedAssetsRoot).toBe('Other/Tyrian Companion/Bases');
		await second.cleanup();
	}, 30_000);
});

function nestedHebra(): TyrianTestApi {
	const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { 'gw2-main': 'KEY' } })]]);
	const test = createTyrianTestApi({ keychain });
	test.library.addFolder('outer', 'root', 'Other');
	test.library.addFolder('first', 'outer', 'Tyrian Companion');
	return test;
}

function saveSettings(test: TyrianTestApi, value: Record<string, unknown>): void {
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({ apiKeySecret: 'gw2-main', ...value }));
}

/** Mounts the plugin's Settings panel in Hebra's container and presses «Aplicar» once the boot work settled. */
async function clickApply(test: TyrianTestApi): Promise<void> {
	const el = document.body.appendChild(document.createElementNS('http://www.w3.org/1999/xhtml', 'div'));
	test.fake.recorded.settingsPanels.at(-1)!(el);
	await new Promise((resolve) => { window.setTimeout(resolve, 400); });
	const apply = Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'Aplicar');
	expect(apply, 'the «Aplicar» button of the managed assets row').toBeDefined();
	expect(apply?.disabled).toBe(false);
	apply?.click();
	await new Promise((resolve) => { window.setTimeout(resolve, 400); });
}

async function activate(test: TyrianTestApi, factory: IDBFactory): Promise<{ core: ApplyCore; cleanup: () => Promise<void> }> {
	let core: TyrianCompanionCore | null = null;
	const cleanup = await activateTyrian(test.api, {
		indexedDB: factory,
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
	});
	await new Promise((resolve) => { window.setTimeout(resolve, 50); });
	return { core: core as unknown as ApplyCore, cleanup: async () => { await cleanup(); test.unloadPlugin(); } };
}
