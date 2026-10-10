// @vitest-environment happy-dom
import type { HebraPluginApi } from 'hebra-plugin-api';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VIEW_PLACEMENT_KEY } from '../../runtime/view-placement';
import { createTyrianRuntime, TYRIAN_MAIN_VIEW_TYPE, type TyrianCompanionCore } from '../../runtime/tyrian-companion-core';
import { createTyrianTestApi, hebraDeviceKey, hebraSettingsKey, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { withRealHostBehaviour, type RealHost } from '../../test/hebra-real-host';
import { COMPANION_VIEW_TYPE } from '../../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from '../../ui/inventory-advisor-item-view';
import { SALE_VIEW_TYPE } from '../../ui/sale-item-view';
import { ACHIEVEMENTS_VIEW_TYPE } from '../../ui/achievements-item-view';
import { activateTyrian } from './hebra-runtime';

/**
 * The REAL core over the REAL HebraHost, on a Hebra with the main view of the plugin API 1.3.0
 * (the package's own fake, with `src/test/hebra-real-host.ts` around it for what the real host
 * does and that fake does not) and on one without it (a Hebra 1.2.0: `has` says no and the newer
 * methods are not there). What is registered, where a section opens from outside, what the option
 * in Settings swaps without a reload, and what a section does while Hebra keeps it mounted but
 * hidden.
 */

/** The sections as views of their own, in the order the core registers them (the sidebar placement). */
const OWN_VIEWS = [COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE, ACHIEVEMENTS_VIEW_TYPE];
const PLACEMENT_ROW = 'Dónde se muestra';

/** What these tests read of the core besides its public methods. */
interface CoreInside {
	viewControllers: Record<'companion' | 'inventoryAdvisor' | 'sale' | 'achievements', { current(): Array<{ contentEl: HTMLElement; render(): void }> }> | null;
	registeredPlacement: 'main' | 'sidebar' | null;
	renderViews(): void;
	renderInventoryAdvisorViews(): void;
}

interface Started {
	test: TyrianTestApi;
	/** Null on a Hebra without the main view. */
	hebra: RealHost | null;
	api: HebraPluginApi;
	core: TyrianCompanionCore;
	inside: CoreInside;
	cleanup(): Promise<void>;
}

async function start(options: {
	mainView: boolean;
	/** What this device stored as its choice, before the plugin starts. */
	stored?: unknown;
	/** The device storage throws when the choice is read. */
	unreadable?: boolean;
	/** `'deferred'`: Hebra mounts what the plugin reveals on its next paint, as the real one does. */
	mount?: 'sync' | 'deferred';
} = { mainView: true }): Promise<Started> {
	// Without the main view this is a Hebra 1.2.0; with it, the package's fake, which is 1.3.0.
	const test = createTyrianTestApi({ mainView: options.mainView });
	test.library.addFolder('tc', 'root', 'Tyrian Companion');
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({ outputFolder: 'Tyrian Companion' }));
	if (options.stored !== undefined) {
		test.local.set(hebraDeviceKey('tyrian-companion', test.library.libraryId(), VIEW_PLACEMENT_KEY), JSON.stringify(options.stored));
	}
	const device = test.api.storage.device;
	const base: HebraPluginApi = options.unreadable === true
		? { ...test.api, storage: { ...test.api.storage, device: {
			get: (key: string) => {
				if (key === VIEW_PLACEMENT_KEY) throw new Error('The device storage cannot be read.');
				return device.get(key);
			},
			set: (key: string, value: unknown) => { device.set(key, value); },
			remove: (key: string) => { device.remove(key); },
		} } }
		: test.api;
	const hebra = options.mainView ? withRealHostBehaviour({ fake: test.fake, api: base }, { mount: options.mount ?? 'sync' }) : null;
	if (hebra !== null) hosts.push(hebra);
	const api = hebra?.api ?? base;
	let core: TyrianCompanionCore | null = null;
	const stop = await activateTyrian(api, {
		indexedDB: new IDBFactory(),
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
	});
	// The boot's fire-and-forget work (IndexedDB, the first reads) settles first.
	await new Promise((resolve) => { window.setTimeout(resolve, 50); });
	const started = core as unknown as TyrianCompanionCore;
	return { test, hebra, api, core: started, inside: started as unknown as CoreInside, cleanup: async () => { await stop(); } };
}

/** The names of the rows the plugin's settings panel mounts in Hebra's container. */
function settingsRows({ test }: Started): { el: HTMLElement; names: string[] } {
	const el = document.body.appendChild(document.createElementNS('http://www.w3.org/1999/xhtml', 'div'));
	test.fake.recorded.settingsPanels[0]!(el);
	return { el, names: Array.from(el.querySelectorAll('.setting-item-name')).map((name) => name.textContent ?? '') };
}

const command = ({ test }: Started, id: string) => test.fake.recorded.commands.find((entry) => entry.id === `tyrian-companion:${id}`)!;
const mountedCount = ({ inside }: Started): number[] => [
	inside.viewControllers?.companion.current().length ?? 0,
	inside.viewControllers?.inventoryAdvisor.current().length ?? 0,
	inside.viewControllers?.sale.current().length ?? 0,
];

/** Every Hebra with a main view a test started, so that none ends with a failure of the plugin Hebra swallowed. */
const hosts: RealHost[] = [];

afterEach(() => {
	const faults = hosts.splice(0).flatMap((host) => host.faults);
	document.body.replaceChildren();
	document.body.className = '';
	vi.restoreAllMocks();
	expect(faults, 'a function of the plugin threw and Hebra swallowed it').toEqual([]);
});

describe('(a) a Hebra without the main view: everything as before', () => {
	it('registers the three views, offers no choice in Settings and calls nothing of the newer API', async () => {
		const started = await start({ mainView: false });
		const { test, core } = started;
		// A Hebra 1.2.0: it says no to the feature, and the two methods 1.3.0 adds do not exist on it.
		expect(test.api.apiVersion).toBe('1.2.0');
		expect(test.api.has('ui.view.main')).toBe(false);
		expect(test.api.ui).not.toHaveProperty('updateView');
		expect(test.api.ui).not.toHaveProperty('updateViewSection');

		expect(core.mainViewSupported()).toBe(false);
		expect(started.inside.registeredPlacement).toBe('sidebar');
		expect(test.fake.recorded.views.map(({ id, placement }) => [id, placement])).toEqual([
			[COMPANION_VIEW_TYPE, 'column'], [INVENTORY_ADVISOR_VIEW_TYPE, 'dialog'], [SALE_VIEW_TYPE, 'dialog'], [ACHIEVEMENTS_VIEW_TYPE, 'dialog'],
		]);
		expect(test.fake.recorded.views.map(({ title }) => title)).toEqual(['Acompañante de Tyria', 'Asesor de inventario', 'Venta de Halloween', 'Logros']);
		expect(settingsRows(started).names).not.toContain(PLACEMENT_ROW);
		expect(test.fake.recorded.ribbon[0]).not.toHaveProperty('viewId');

		// Opening from outside still reveals a view by its type, with that one argument.
		const revealView = vi.spyOn(test.api.ui, 'revealView');
		await command(started, 'open-companion').run();
		await command(started, 'open-inventory-advisor').run();
		await command(started, 'open-sale').run();
		expect(revealView.mock.calls).toEqual([[COMPANION_VIEW_TYPE], [INVENTORY_ADVISOR_VIEW_TYPE], [SALE_VIEW_TYPE]]);

		// A choice stored by another build changes nothing here: there is no main screen to go to.
		await core.updateViewPlacement('sidebar');
		await core.updateViewPlacement('main');
		expect(test.fake.recorded.views.map(({ id }) => id)).toEqual(OWN_VIEWS);
		await started.cleanup();
	}, 30_000);
});

describe('(b) a Hebra with the main view and the default choice', () => {
	it('registers ONE view on the main screen with Session, Inventory and Sale in that order, retained', async () => {
		const started = await start({ mainView: true });
		const { test, hebra, core } = started;
		expect(test.api.apiVersion).toBe('1.4.0');
		expect(core.mainViewSupported()).toBe(true);

		// What Hebra's own fake recorded: one main view and none of the three views of their own.
		expect(test.fake.recorded.mainViews).toHaveLength(1);
		const definition = test.fake.recorded.mainViews[0]!;
		expect([definition.id, definition.title, definition.icon, definition.placement, definition.retainSections])
			.toEqual([TYRIAN_MAIN_VIEW_TYPE, 'Tyrian Companion', 'sword', 'main', true]);
		expect(definition.sections).toEqual([
			{ id: 'session', title: 'Sesión', icon: 'sword' },
			{ id: 'inventory', title: 'Inventario', icon: 'package-search' },
			{ id: 'sale', title: 'Venta', icon: 'candy' },
			{ id: 'achievements', title: 'Logros', icon: 'trophy', badge: null },
		]);
		expect(test.fake.viewTitle(TYRIAN_MAIN_VIEW_TYPE)).toBe('Tyrian Companion');
		expect(test.fake.recorded.views).toEqual([]);
		expect(hebra!.ownViews.registered()).toEqual([]);
		// Nothing is mounted, and nothing was opened for the player, before somebody enters.
		expect(test.fake.mainView.mounted(TYRIAN_MAIN_VIEW_TYPE)).toEqual([]);
		expect(test.fake.mainView.current()).toBeNull();
		expect(test.fake.recorded.reveals).toEqual([]);
		await started.cleanup();
	}, 30_000);

	it('offers the choice in Settings, right after the mode, showing the main screen', async () => {
		const started = await start({ mainView: true });
		const { el, names } = settingsRows(started);
		expect(names.indexOf(PLACEMENT_ROW)).toBe(names.indexOf('Modo de esta instalación') + 1);
		const select = el.querySelectorAll<HTMLSelectElement>('.setting-item select')[1]!;
		expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
			['main', 'Pantalla principal'], ['sidebar', 'Barra lateral'],
		]);
		expect(select.value).toBe('main');
		await started.cleanup();
	}, 30_000);
});

describe('(c) a Hebra with the main view and the sidebar chosen on this device', () => {
	it('registers the three views of always and nothing on the main screen', async () => {
		const started = await start({ mainView: true, stored: 'sidebar' });
		const { hebra, core } = started;
		expect(core.mainViewSupported()).toBe(true);
		expect(core.getViewPlacement()).toBe('sidebar');
		expect(hebra!.ownViews.registered()).toEqual(OWN_VIEWS);
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).registered()).toBeNull();
		expect(hebra!.recorded.mainViews).toEqual([]);
		expect(started.test.fake.recorded.ribbon[0]).not.toHaveProperty('viewId');
		// The row is still there: it is how the device goes back to the main screen.
		expect(settingsRows(started).names).toContain(PLACEMENT_ROW);
		await started.cleanup();
	}, 30_000);

	it('a stored value this build does not know is the main screen', async () => {
		const started = await start({ mainView: true, stored: 'floating' });
		expect(started.core.getViewPlacement()).toBe('main');
		expect(started.hebra!.view(TYRIAN_MAIN_VIEW_TYPE).registered()).toBe(TYRIAN_MAIN_VIEW_TYPE);
		await started.cleanup();
	}, 30_000);
});

describe('(d) changing the choice in Settings swaps what is registered, without a reload', () => {
	it('from the main screen to the sidebar and back: nothing is left mounted, nothing is mounted twice', async () => {
		const started = await start({ mainView: true });
		const { hebra, core, test } = started;
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('inventory');
		expect(mountedCount(started)).toEqual([1, 1, 0]);
		const sessionEl = hebra!.view(TYRIAN_MAIN_VIEW_TYPE).element('session')!;

		// The player changes the option in the plugin's settings, as the row does.
		const { el } = settingsRows(started);
		const select = el.querySelectorAll<HTMLSelectElement>('.setting-item select')[1]!;
		select.value = 'sidebar';
		select.dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(started.inside.registeredPlacement).toBe('sidebar'));

		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).registered()).toBeNull();
		expect(hebra!.ownViews.registered()).toEqual(OWN_VIEWS);
		// Hebra unmounted the two sections it had mounted: no controller, timer or listener survives.
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 0, 0]));
		expect(sessionEl.isConnected).toBe(false);
		expect(test.fake.recorded.ribbon).toHaveLength(1);
		expect(test.fake.recorded.ribbon[0]).not.toHaveProperty('viewId');
		expect(test.local.get(hebraDeviceKey('tyrian-companion', test.library.libraryId(), VIEW_PLACEMENT_KEY))).toBe('"sidebar"');

		// As views of their own they mount again, once each.
		const columnEl = hebra!.ownViews.open(COMPANION_VIEW_TYPE);
		hebra!.ownViews.open(SALE_VIEW_TYPE);
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([1, 0, 1]));
		expect(columnEl.querySelector('.tyrian-product-shell__nav')).not.toBeNull();

		// And back to the main screen.
		await core.updateViewPlacement('main');
		expect(hebra!.ownViews.registered()).toEqual([]);
		expect(hebra!.ownViews.opened()).toEqual([]);
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).registered()).toBe(TYRIAN_MAIN_VIEW_TYPE);
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 0, 0]));
		expect(test.fake.recorded.ribbon).toHaveLength(1);
		expect(test.fake.recorded.ribbon[0]).toMatchObject({ viewId: TYRIAN_MAIN_VIEW_TYPE });
		// Nothing is opened by the change: Hebra's Settings already left the main screen.
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).current()).toBeNull();
		expect(hebra!.recorded.reveals).toEqual([]);

		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('sale');
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('session');
		expect(mountedCount(started)).toEqual([1, 0, 1]);
		// Saving the same choice again registers nothing again.
		const registerView = vi.spyOn(hebra!.api.ui, 'registerView');
		await core.updateViewPlacement('main');
		expect(registerView).not.toHaveBeenCalled();
		expect(mountedCount(started)).toEqual([1, 0, 1]);
		await started.cleanup();
	}, 30_000);

	it('takes the old views away and registers the new one in the same tick, never both and never neither', async () => {
		const started = await start({ mainView: true });
		const { hebra, core } = started;
		const order: string[] = [];
		const registerView = hebra!.api.ui.registerView.bind(hebra!.api.ui);
		hebra!.api.ui.registerView = (view) => {
			order.push(`register ${view.id}`);
			const unregister = registerView(view);
			return () => {
				order.push(`unregister ${view.id}`);
				// A microtask queued by the first unregister runs only once the synchronous swap is over.
				queueMicrotask(() => { order.push('tick'); });
				unregister();
			};
		};
		// Registered through the wrapper, so its unregister is the recorded one.
		await core.updateViewPlacement('sidebar');
		order.length = 0;

		await core.updateViewPlacement('main');
		expect(order.slice(0, 5)).toEqual([
			`unregister ${COMPANION_VIEW_TYPE}`, `unregister ${INVENTORY_ADVISOR_VIEW_TYPE}`, `unregister ${SALE_VIEW_TYPE}`,
			`unregister ${ACHIEVEMENTS_VIEW_TYPE}`,
			`register ${TYRIAN_MAIN_VIEW_TYPE}`,
		]);
		order.length = 0;

		await core.updateViewPlacement('sidebar');
		expect(order.slice(0, 5)).toEqual([
			`unregister ${TYRIAN_MAIN_VIEW_TYPE}`,
			`register ${COMPANION_VIEW_TYPE}`, `register ${INVENTORY_ADVISOR_VIEW_TYPE}`, `register ${SALE_VIEW_TYPE}`,
			`register ${ACHIEVEMENTS_VIEW_TYPE}`,
		]);
		expect(order.slice(5)).toEqual(['tick']);
		await started.cleanup();
	}, 30_000);
});

describe('(d) what is left open and mounted after the swap, in each direction', () => {
	it('shares no view id between the two placements, so neither swap can keep anything open', () => {
		expect(OWN_VIEWS).not.toContain(TYRIAN_MAIN_VIEW_TYPE);
		expect(new Set([...OWN_VIEWS, TYRIAN_MAIN_VIEW_TYPE]).size).toBe(5);
	});

	it('main screen to sidebar: the main view is unmounted whole and nothing is open, not even a moment later', async () => {
		const started = await start({ mainView: true });
		const { hebra, core } = started;
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);
		main.open();
		main.select('sale');
		main.select('inventory');
		const elements = ['session', 'sale', 'inventory'].map((id) => main.element(id)!);
		expect(hebra!.mainView.current()).toEqual({ viewId: TYRIAN_MAIN_VIEW_TYPE, sectionId: 'inventory' });
		expect(mountedCount(started)).toEqual([1, 1, 1]);

		const swapped = core.updateViewPlacement('sidebar');
		await swapped;

		// The retained and hidden sections go too, and their elements leave the document with the wrapper.
		expect(main.registered()).toBeNull();
		expect(main.mounted()).toEqual([]);
		expect(elements.map((el) => el.isConnected)).toEqual([false, false, false]);
		expect(document.querySelector('.hebra-module-view-main')).toBeNull();
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 0, 0]));
		// Nothing is open: the three views are registered and none was opened for the player.
		expect(hebra!.mainView.current()).toBeNull();
		expect(hebra!.ownViews.registered()).toEqual(OWN_VIEWS);
		expect(hebra!.ownViews.opened()).toEqual([]);
		expect(hebra!.recorded.reveals).toEqual([]);
		await Promise.resolve();
		expect(hebra!.mainView.current()).toBeNull();
		await started.cleanup();
	}, 30_000);

	it('sidebar to main screen: every open view of its own is closed, the main view is registered and not open, nothing mounted', async () => {
		const started = await start({ mainView: true, stored: 'sidebar' });
		const { hebra, core } = started;
		const column = hebra!.ownViews.open(COMPANION_VIEW_TYPE);
		const dialog = hebra!.ownViews.open(INVENTORY_ADVISOR_VIEW_TYPE);
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([1, 1, 0]));
		expect(column.querySelector('.tyrian-product-shell')).not.toBeNull();
		expect(dialog.querySelector('.tyrian-product-shell')).not.toBeNull();

		await core.updateViewPlacement('main');

		expect(hebra!.ownViews.registered()).toEqual([]);
		expect(hebra!.ownViews.opened()).toEqual([]);
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 0, 0]));
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);
		expect(main.registered()).toBe(TYRIAN_MAIN_VIEW_TYPE);
		expect(hebra!.mainView.current()).toBeNull();
		expect(main.mounted()).toEqual([]);
		expect(hebra!.recorded.reveals).toEqual([]);
		// Entered afterwards, it starts on its first section and mounts only that one.
		main.open();
		expect(main.current()).toBe('session');
		expect(mountedCount(started)).toEqual([1, 0, 0]);
		await started.cleanup();
	}, 30_000);

	it('on the main screen the Session cannot be opened through its column view: it is not registered, and nothing reveals it', async () => {
		const started = await start({ mainView: true });
		const { hebra, test } = started;
		expect(hebra!.ownViews.registered()).toEqual([]);
		expect(test.fake.recorded.views).toEqual([]);
		expect(() => hebra!.ownViews.open(COMPANION_VIEW_TYPE)).toThrow(/No view/u);

		// So no reveal of a column view can ever take the player out of the main view.
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);
		main.open('inventory');
		await command(started, 'open-companion').run();
		expect(hebra!.mainView.current()).toEqual({ viewId: TYRIAN_MAIN_VIEW_TYPE, sectionId: 'session' });
		expect(hebra!.recorded.reveals.map(({ id }) => id)).toEqual([TYRIAN_MAIN_VIEW_TYPE]);
		expect(main.mounted()).toEqual(['inventory', 'session']);
		await started.cleanup();
	}, 30_000);

	it('in the sidebar, opening Inventory or Sale (dialogs) needs no main view: none is registered and none is touched', async () => {
		const started = await start({ mainView: true, stored: 'sidebar' });
		const { hebra } = started;
		expect(hebra!.recorded.mainViews).toEqual([]);

		await command(started, 'open-inventory-advisor').run();
		await command(started, 'open-sale').run();

		expect(hebra!.recorded.reveals).toEqual([{ id: INVENTORY_ADVISOR_VIEW_TYPE }, { id: SALE_VIEW_TYPE }]);
		expect(hebra!.recorded.mainViews).toEqual([]);
		expect(hebra!.mainView.current()).toBeNull();
		// Hebra opens the dialogs it was asked for, each with its own controller.
		const inventory = hebra!.ownViews.open(INVENTORY_ADVISOR_VIEW_TYPE);
		const sale = hebra!.ownViews.open(SALE_VIEW_TYPE);
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 1, 1]));
		expect(inventory.querySelector('.tyrian-product-shell__nav')).not.toBeNull();
		expect(sale.querySelector('.tyrian-product-shell__nav')).not.toBeNull();
		await started.cleanup();
	}, 30_000);
});

describe('(B) a Hebra that mounts on its next paint, as the real one does', () => {
	it('opening a section from outside mounts nothing until Hebra paints, and then exactly that section', async () => {
		const started = await start({ mainView: true, mount: 'deferred' });
		const { hebra } = started;
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);

		await command(started, 'open-inventory-advisor').run();
		// `revealView` has returned and the command is over: nothing is mounted yet.
		expect(main.mounted()).toEqual([]);
		expect(main.current()).toBeNull();
		expect(mountedCount(started)).toEqual([0, 0, 0]);

		hebra!.mainView.paint();
		expect(hebra!.recorded.reveals).toEqual([{ id: TYRIAN_MAIN_VIEW_TYPE, section: 'inventory' }]);
		expect(main.current()).toBe('inventory');
		expect(mountedCount(started)).toEqual([0, 1, 0]);
		expect(main.element('inventory')!.querySelector('.tyrian-product-shell')).not.toBeNull();

		// Two asked for before one paint: the last one is what is on screen, both mounted in order.
		await command(started, 'open-sale').run();
		await command(started, 'open-companion').run();
		expect(main.current()).toBe('inventory');
		hebra!.mainView.paint();
		expect(main.current()).toBe('session');
		expect(main.mounted()).toEqual(['inventory', 'sale', 'session']);
		expect(mountedCount(started)).toEqual([1, 1, 1]);
		await started.cleanup();
	}, 30_000);

	it('the swap works the same: a section asked for and not painted yet is dropped with its view, and nothing is mounted twice', async () => {
		const started = await start({ mainView: true, mount: 'deferred' });
		const { hebra, core } = started;
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);
		main.open();
		await command(started, 'open-sale').run();

		// The player changes to the sidebar before Hebra has painted the Sale that was asked for.
		await core.updateViewPlacement('sidebar');
		hebra!.mainView.paint();
		expect(main.registered()).toBeNull();
		expect(hebra!.mainView.current()).toBeNull();
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 0, 0]));
		expect(hebra!.ownViews.registered()).toEqual(OWN_VIEWS);

		// A view of its own asked for from outside, and then back to the main screen.
		await command(started, 'open-companion').run();
		hebra!.mainView.paint();
		hebra!.ownViews.open(COMPANION_VIEW_TYPE);
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([1, 0, 0]));
		await core.updateViewPlacement('main');
		hebra!.mainView.paint();
		await vi.waitFor(() => expect(mountedCount(started)).toEqual([0, 0, 0]));
		expect(hebra!.mainView.current()).toBeNull();

		await command(started, 'open-sale').run();
		hebra!.mainView.paint();
		expect(main.current()).toBe('sale');
		expect(mountedCount(started)).toEqual([0, 0, 1]);
		await started.cleanup();
	}, 30_000);

	it('repaints the same: the core repainting before the section exists does nothing, and a hidden one repaints once when shown', async () => {
		const started = await start({ mainView: true, mount: 'deferred' });
		const { hebra, inside } = started;
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);

		await command(started, 'open-companion').run();
		// Asked for and not painted: the core's repaints find no controller, and that is fine.
		expect(() => { inside.renderViews(); inside.renderInventoryAdvisorViews(); }).not.toThrow();
		await Promise.resolve();
		expect(mountedCount(started)).toEqual([0, 0, 0]);

		hebra!.mainView.paint();
		const session = main.element('session')!;
		const sessionPaints = vi.spyOn(session as unknown as { addClass(name: string): void }, 'addClass');
		const fullSessionPaints = (): number => sessionPaints.mock.calls.filter(([name]) => name === 'tyrian-companion-view').length;

		await command(started, 'open-inventory-advisor').run();
		hebra!.mainView.paint();
		expect([session.hidden, main.element('inventory')!.hidden]).toEqual([true, false]);
		inside.renderViews();
		await Promise.resolve();
		inside.renderViews();
		await Promise.resolve();
		expect(fullSessionPaints()).toBe(0);

		await command(started, 'open-companion').run();
		// Still hidden until the paint: asking for it repaints nothing.
		expect(fullSessionPaints()).toBe(0);
		hebra!.mainView.paint();
		expect(session.hidden).toBe(false);
		expect(fullSessionPaints()).toBe(1);
		await started.cleanup();
	}, 30_000);
});

describe('(e) a section Hebra keeps mounted but hidden', () => {
	it('paints nothing while hidden, however often the core repaints, and repaints once when it is shown again', async () => {
		const started = await start({ mainView: true });
		const { hebra, inside } = started;
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('inventory');
		const session = hebra!.view(TYRIAN_MAIN_VIEW_TYPE).element('session')!;
		const inventory = hebra!.view(TYRIAN_MAIN_VIEW_TYPE).element('inventory')!;
		expect([session.hidden, inventory.hidden]).toEqual([true, false]);

		// Every full repaint of a section puts its surface class on the element; a hidden one must not.
		const sessionPaints = vi.spyOn(session as unknown as { addClass(name: string): void }, 'addClass');
		const fullSessionPaints = (): number => sessionPaints.mock.calls.filter(([name]) => name === 'tyrian-companion-view').length;
		inside.renderViews();
		inside.renderViews();
		await Promise.resolve();
		inside.renderViews();
		await Promise.resolve();
		expect(fullSessionPaints(), 'the hidden Session section was repainted').toBe(0);

		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('session');
		expect(fullSessionPaints(), 'the repaints asked for while hidden are one').toBe(1);
		// Now Inventory is the hidden one: the advisor's repaints do not reach its DOM.
		const before = inventory.innerHTML;
		const inventoryController = inside.viewControllers!.inventoryAdvisor.current()[0]!;
		const shown = vi.spyOn(inventoryController, 'render');
		inside.renderInventoryAdvisorViews();
		inside.renderInventoryAdvisorViews();
		expect(inventory.innerHTML).toBe(before);
		shown.mockClear();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('inventory');
		expect(shown).toHaveBeenCalledOnce();

		// Back to the notes hides whatever was on screen, and coming back shows the same section.
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).leave();
		expect(inventory.hidden).toBe(true);
		inside.renderInventoryAdvisorViews();
		expect(inventory.innerHTML).toBe(before);
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).current()).toBe('inventory');
		expect(mountedCount(started)).toEqual([1, 1, 0]);
		await started.cleanup();
	}, 30_000);

	it('refreshes Sale only when somebody opens Sale, never because the main view registered or another section was opened', async () => {
		const started = await start({ mainView: true });
		const { hebra, core } = started;
		const refreshSale = vi.spyOn(core, 'refreshSale').mockResolvedValue();
		// The advisor never analyzed this session: the state in which opening Sale refreshes by itself.
		vi.spyOn(core, 'getSaleViewModel').mockReturnValue({ ...core.getSaleViewModel(), status: 'loading' });

		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('inventory');
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).leave();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		expect(refreshSale).not.toHaveBeenCalled();
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).mounted()).toEqual(['session', 'inventory']);

		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('sale');
		expect(refreshSale.mock.calls).toEqual([[{ refreshSeeds: false }]]);
		// Coming back to a Sale already mounted repaints it; it does not ask again.
		await Promise.resolve();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('session');
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('sale');
		expect(refreshSale).toHaveBeenCalledOnce();
		await started.cleanup();
	}, 30_000);
});

describe('(f) opening a section from outside it', () => {
	it('enters that section of the main view: the three commands, and the ribbon menu\'s way to the Session', async () => {
		const started = await start({ mainView: true });
		const { hebra, test } = started;
		// One palette command per section: what reaches a section where Hebra shows no list of them.
		expect(['open-companion', 'open-inventory-advisor', 'open-sale'].map((id) => command(started, id).name))
			.toEqual(['Abrir acompañante', 'Abrir asesor de inventario', 'Abrir venta de Halloween']);

		await command(started, 'open-inventory-advisor').run();
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).current()).toBe('inventory');
		await command(started, 'open-sale').run();
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).current()).toBe('sale');
		await command(started, 'open-companion').run();
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).current()).toBe('session');
		expect(hebra!.recorded.reveals).toEqual([
			{ id: TYRIAN_MAIN_VIEW_TYPE, section: 'inventory' },
			{ id: TYRIAN_MAIN_VIEW_TYPE, section: 'sale' },
			{ id: TYRIAN_MAIN_VIEW_TYPE, section: 'session' },
		]);
		// No view of its own exists to reveal: every reveal above named the main view.
		expect(hebra!.ownViews.registered()).toEqual([]);
		expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).mounted()).toEqual(['inventory', 'sale', 'session']);

		// The ribbon: tied to the main view, and a click still reaches the plugin (the menu).
		const ribbon = test.fake.recorded.ribbon[0]!;
		expect(ribbon.viewId).toBe(TYRIAN_MAIN_VIEW_TYPE);
		const openMenu = vi.spyOn(hebra!.api.ui, 'openMenu');
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).leave();
		ribbon.onClick(new MouseEvent('click'));
		await vi.waitFor(() => expect(openMenu).toHaveBeenCalledOnce());
		const open = openMenu.mock.calls[0]![0].find((entry) => 'label' in entry && entry.icon === 'sword');
		expect(open).toBeDefined();
		(open as { onClick(): void }).onClick();
		await vi.waitFor(() => expect(hebra!.view(TYRIAN_MAIN_VIEW_TYPE).current()).toBe('session'));
		await started.cleanup();
	}, 30_000);

	it('opens the section\'s own view once the device chose the sidebar', async () => {
		const started = await start({ mainView: true, stored: 'sidebar' });
		const revealOwnView = vi.spyOn(started.test.fake.api.ui, 'revealView');
		await command(started, 'open-sale').run();
		expect(started.hebra!.recorded.reveals).toEqual([{ id: SALE_VIEW_TYPE }]);
		expect(revealOwnView.mock.calls).toEqual([[SALE_VIEW_TYPE]]);
		await started.cleanup();
	}, 30_000);
});

describe('(g) the plugin\'s own bar of tabs', () => {
	it('has no tabs in any section of the main view, where Hebra lists them, keeps its settings button there, and is whole in each view of its own', async () => {
		const started = await start({ mainView: true });
		const { hebra, core } = started;
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).open();
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('inventory');
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('sale');
		hebra!.view(TYRIAN_MAIN_VIEW_TYPE).select('achievements');
		const openSettings = vi.spyOn(hebra!.api.ui, 'openSettings');
		for (const id of ['session', 'inventory', 'sale', 'achievements']) {
			const el = hebra!.view(TYRIAN_MAIN_VIEW_TYPE).element(id)!;
			expect(el.querySelector('.tyrian-product-shell'), `${id}: no shell`).not.toBeNull();
			expect(el.querySelector('nav'), `${id}: a navigation of its own`).toBeNull();
			expect(Array.from(el.querySelectorAll('button')).map((button) => button.textContent), `${id}: a tab of its own`)
				.not.toEqual(expect.arrayContaining(['Sesión']));
			// The settings button stays, alone in its row at the top of the shell, and opens the plugin's settings.
			const tools = el.querySelector('.tyrian-product-shell')!.firstElementChild!;
			expect(tools.className, `${id}: the row of the settings button`).toBe('tyrian-product-shell__tools');
			expect(tools.children, `${id}: only the settings button`).toHaveLength(1);
			const settings = tools.querySelector<HTMLButtonElement>('button.tyrian-product-shell__settings')!;
			expect(settings.getAttribute('aria-label')).toBe('Ajustes de Tyrian Companion');
			const before = openSettings.mock.calls.length;
			settings.click();
			expect(openSettings.mock.calls.length, `${id}: the settings button does nothing`).toBe(before + 1);
		}

		await core.updateViewPlacement('sidebar');
		for (const type of OWN_VIEWS) {
			const el = hebra!.ownViews.open(type);
			await vi.waitFor(() => expect(el.querySelector('.tyrian-product-shell__nav'), `${type}: no bar`).not.toBeNull());
			expect(Array.from(el.querySelectorAll('.tyrian-product-shell__nav button:not(.tyrian-product-shell__settings)')).map((tab) => tab.textContent))
				.toEqual(['Sesión', 'Inventario', 'Venta', 'Logros']);
		}
		await started.cleanup();
	}, 30_000);
});

describe('(i) the «Logros» section (L2, 0.6.30)', () => {
	it('is listed fourth with the followed count as its badge, opening it asks nothing with the key, and following tells Hebra the new count', async () => {
		const started = await start({ mainView: true });
		const { hebra, test, core } = started;
		expect(test.fake.recorded.mainViews[0]!.sections[3]).toEqual({ id: 'achievements', title: 'Logros', icon: 'trophy', badge: null });

		// Entering the section mounts the view: the search, the followed list, the button; nothing keyed was asked.
		const main = hebra!.view(TYRIAN_MAIN_VIEW_TYPE);
		main.open();
		main.select('achievements');
		const el = main.element('achievements')!;
		await vi.waitFor(() => expect(el.querySelector('.tyrian-achievements')).not.toBeNull());
		expect(el.querySelector('input[type="search"]')).not.toBeNull();
		expect(el.querySelector('.tyrian-achievements__refresh')).not.toBeNull();
		expect(el.querySelector('nav')).toBeNull();
		await new Promise((resolve) => { window.setTimeout(resolve, 20); });
		expect(test.fake.recorded.httpRequests.filter((request) => /\/account/u.test(request.url))).toEqual([]);

		// Following goes through the settings, and the badge reaches Hebra through `updateViewSection`.
		const updateViewSection = vi.spyOn(hebra!.api.ui, 'updateViewSection');
		await vi.waitFor(async () => { expect((await core.updateSettings({ trackedAchievementIds: [1, 2] })).status).toBe('saved'); }, { timeout: 10_000 });
		expect(updateViewSection).toHaveBeenCalledWith(TYRIAN_MAIN_VIEW_TYPE, 'achievements', { badge: 2 });
		expect(test.fake.mainView.sections(TYRIAN_MAIN_VIEW_TYPE)[3]).toMatchObject({ id: 'achievements', badge: 2 });
		await core.updateSettings({ trackedAchievementIds: [] });
		expect(test.fake.mainView.sections(TYRIAN_MAIN_VIEW_TYPE)[3]).toMatchObject({ id: 'achievements', badge: null });
		expect(test.fake.recorded.httpRequests.filter((request) => /\/account/u.test(request.url))).toEqual([]);

		// The command enters the section, like the other three.
		expect(command(started, 'open-achievements').name).toBe('Abrir logros');
		main.select('session');
		await command(started, 'open-achievements').run();
		expect(main.current()).toBe('achievements');
		await started.cleanup();
	}, 30_000);
});

describe('(h) a device storage that cannot be read', () => {
	it('falls back to the main screen instead of leaving the plugin without views', async () => {
		const started = await start({ mainView: true, unreadable: true });
		expect(started.core.getViewPlacement()).toBe('main');
		expect(started.hebra!.view(TYRIAN_MAIN_VIEW_TYPE).registered()).toBe(TYRIAN_MAIN_VIEW_TYPE);
		expect(started.hebra!.ownViews.registered()).toEqual([]);
		// The choice can still be written, and takes effect.
		await started.core.updateViewPlacement('sidebar');
		expect(started.hebra!.ownViews.registered()).toEqual(OWN_VIEWS);
		await started.cleanup();
	}, 30_000);
});
