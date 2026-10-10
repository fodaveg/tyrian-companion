// @vitest-environment happy-dom
import type { PluginMainViewDefinition } from 'hebra-plugin-api';
import { createFakePluginApi } from 'hebra-plugin-api/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../core/i18n';
import { asHebraWithoutMainView } from '../../test/hebra-plugin-fakes';
import { withRealHostBehaviour } from '../../test/hebra-real-host';
import type { TyrianSectionsViewRegistration, TyrianViewSectionRegistration } from '../tyrian-host';
import { createHebraTyrianUi } from './hebra-host-ui';
import { hebraHasMainView } from './hebra-main-view';
import { createMemorySecretsBackend, createPreloadedSecrets } from './secrets';

// The main view of Hebra's plugin API 1.3.0 through the adapter: what reaches Hebra when the core
// registers ONE view with sections, and what Hebra makes of it. Hebra here is the package's own
// fake (`hebra-plugin-api/testing`), with `src/test/hebra-real-host.ts` around it for the few
// things the real host does and that fake does not; how the main view itself behaves is tested in
// Hebra, not here.

/** The id every test here registers its main view with. */
const MAIN = 'tyrian-main-view';

/** A Hebra before the main view (plugin API 1.2.0 and earlier): `has` says no and the newer methods are not there. */
async function olderHebra() {
	const fake = createFakePluginApi({ id: 'tyrian-companion', capabilities: ['editor'] });
	const api = asHebraWithoutMainView(fake.api);
	const mainView = hebraHasMainView(api);
	const ui = createHebraTyrianUi({ api, mainView, ...await rest() });
	return { fake, api, ui, mainView };
}

/** A Hebra with the main view. */
async function hebra(mount: 'sync' | 'deferred' = 'sync') {
	const fake = createFakePluginApi({ id: 'tyrian-companion', capabilities: ['editor'] });
	const widened = withRealHostBehaviour({ fake, api: fake.api }, { mount });
	hosts.push(widened);
	const report = vi.fn();
	const ui = createHebraTyrianUi({ api: widened.api, mainView: hebraHasMainView(widened.api), ...await rest(), report });
	return { fake, widened, ui, report };
}

/** Every Hebra a test built, so that none ends with a failure of the plugin Hebra swallowed. */
const hosts: Array<{ faults: string[] }> = [];

async function rest() {
	return {
		translator: () => createTranslator('es'),
		secrets: await createPreloadedSecrets(createMemorySecretsBackend()),
		folderPaths: async () => [],
		openNote: vi.fn(),
		report: vi.fn(),
	};
}

/** A section that records what the host does to it, with the element of each call. */
function section(id: string, log: string[], overrides: Partial<TyrianViewSectionRegistration> = {}): TyrianViewSectionRegistration {
	const of = (el: HTMLElement): string => el.dataset.section ?? '?';
	return {
		id,
		title: () => `Título de ${id}`,
		icon: `icon-${id}`,
		mount: (el) => { log.push(`mount ${id} in ${of(el)}`); },
		unmount: (el) => { log.push(`unmount ${id} in ${of(el)}`); },
		setVisible: (el, visible) => { log.push(`${visible ? 'show' : 'hide'} ${id} in ${of(el)}`); },
		...overrides,
	};
}

function sectionsView(log: string[], sections = [section('session', log), section('inventory', log), section('sale', log)]): TyrianSectionsViewRegistration {
	return { type: 'tyrian-main-view', title: () => 'Tyrian Companion', icon: 'sword', sections };
}

afterEach(() => {
	const faults = hosts.splice(0).flatMap((host) => host.faults);
	document.body.replaceChildren();
	expect(faults, 'a function of the plugin threw and Hebra swallowed it').toEqual([]);
});

describe('a Hebra without the main view (1.2.0 and before)', () => {
	it('answers false to the feature without throwing, and the port has none of the three methods', async () => {
		const { api, ui, mainView } = await olderHebra();
		expect(mainView).toBe(false);
		expect(api.apiVersion).toBe('1.2.0');
		expect(api.ui).not.toHaveProperty('updateView');
		expect(api.ui).not.toHaveProperty('updateViewSection');
		expect(ui).not.toHaveProperty('registerSectionsView');
		expect(ui).not.toHaveProperty('revealSection');
		expect(ui).not.toHaveProperty('updateSection');
	});

	it('takes a Hebra whose `has` throws for that name, or has no `has` at all, as one without the main view, and never throws itself', () => {
		const report = vi.fn();
		const failure = new Error('capacidad desconocida');
		const throwing = { has: (name: string): boolean => { if (name === 'ui.view.main') throw failure; return true; } };

		expect(hebraHasMainView(throwing as never, report)).toBe(false);
		expect(report.mock.calls).toEqual([[failure]]);
		// With nobody to tell, it still answers.
		expect(hebraHasMainView(throwing as never)).toBe(false);

		report.mockClear();
		expect(hebraHasMainView({} as never, report)).toBe(false);
		expect(hebraHasMainView({ has: 'yes' } as never, report)).toBe(false);
		expect(report).not.toHaveBeenCalled();
		// Only a plain `true` is a yes.
		expect(hebraHasMainView({ has: () => 'true' } as never, report)).toBe(false);
		expect(hebraHasMainView({ has: () => true }, report)).toBe(true);
	});

	it('reveals a view with the type alone, as before', async () => {
		const { api, ui } = await olderHebra();
		const revealView = vi.spyOn(api.ui, 'revealView');
		await ui.revealView('tyrian-companion-view');
		expect(revealView.mock.calls).toEqual([['tyrian-companion-view']]);
	});

	it('makes its ribbon button with no view tied to it', async () => {
		const { fake, ui } = await olderHebra();
		ui.ribbon({ icon: 'sword', title: 'Tyrian', onClick: vi.fn() });
		expect(fake.recorded.ribbon).toHaveLength(1);
		expect(fake.recorded.ribbon[0]).not.toHaveProperty('viewId');
		expect(Object.keys(fake.recorded.ribbon[0]!).sort()).toEqual(['icon', 'onClick', 'title']);
	});
});

describe('registerSectionsView', () => {
	it('registers ONE main view: its id, title and icon, the sections in order with their titles and icons, and retained', async () => {
		const { fake, widened, ui } = await hebra();
		const registerView = vi.spyOn(widened.api.ui, 'registerView');

		ui.registerSectionsView!(sectionsView([]));

		expect(registerView).toHaveBeenCalledOnce();
		const definition = registerView.mock.calls[0]![0] as PluginMainViewDefinition;
		expect(Object.keys(definition).sort()).toEqual(['icon', 'id', 'mountSection', 'placement', 'retainSections', 'sections', 'title']);
		expect([definition.id, definition.title, definition.icon, definition.placement, definition.retainSections])
			.toEqual(['tyrian-main-view', 'Tyrian Companion', 'sword', 'main', true]);
		expect(definition.sections).toEqual([
			{ id: 'session', title: 'Título de session', icon: 'icon-session' },
			{ id: 'inventory', title: 'Título de inventory', icon: 'icon-inventory' },
			{ id: 'sale', title: 'Título de sale', icon: 'icon-sale' },
		]);
		expect(fake.recorded.mainViews.map(({ id }) => id)).toEqual(['tyrian-main-view']);
		expect(fake.viewTitle('tyrian-main-view')).toBe('Tyrian Companion');
		// Nothing of it is a column or dialog view, and nothing is mounted until somebody enters.
		expect(fake.recorded.views).toEqual([]);
		expect(fake.mainView.mounted(MAIN)).toEqual([]);
	});

	it('lists the badge of a section that has one, as it is when the view registers, and nothing for the others', async () => {
		const { fake, ui } = await hebra();
		let count = 0;
		const badged = section('achievements', [], { badge: () => (count === 0 ? null : count) });
		ui.registerSectionsView!(sectionsView([], [section('session', []), badged]));
		expect(fake.mainView.sections(MAIN)).toEqual([
			{ id: 'session', title: 'Título de session', icon: 'icon-session' },
			{ id: 'achievements', title: 'Título de achievements', icon: 'icon-achievements', badge: null },
		]);
		// A change of the count reaches Hebra only through `updateSection`, as the core does on every change.
		count = 4;
		ui.updateSection!(MAIN, 'achievements', { badge: 4 });
		expect(fake.mainView.sections(MAIN)[1]).toMatchObject({ badge: 4 });
	});

	it('mounts each section on its first visit, in the element Hebra gives it, and never tells it it is visible right then', async () => {
		const { fake, widened, ui } = await hebra();
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));

		const el = fake.mainView.open(MAIN);
		expect(log).toEqual(['mount session in session']);
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'session' });
		expect(el).toBe(widened.view(MAIN).element('session'));
		expect(el.className).toBe('hebra-module-view-content hebra-module-view-main-content');
		expect(el.parentElement?.className).toBe('hebra-module-view hebra-module-view-main');

		fake.mainView.select('sale');
		expect(log).toEqual(['mount session in session', 'hide session in session', 'mount sale in sale']);
		// Inventory was never visited: it is not mounted.
		expect(fake.mainView.mounted(MAIN)).toEqual(['session', 'sale']);
	});

	it('hides and shows a mounted section instead of unmounting it, also when the user goes back to the notes', async () => {
		const { fake, widened, ui } = await hebra();
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));
		fake.mainView.open(MAIN);
		fake.mainView.select('inventory');
		log.length = 0;

		fake.mainView.select('session');
		expect(log).toEqual(['hide inventory in inventory', 'show session in session']);
		expect(widened.view(MAIN).element('inventory')?.hidden).toBe(true);
		expect(widened.view(MAIN).element('session')?.hidden).toBe(false);

		fake.mainView.leave();
		fake.mainView.open(MAIN);
		expect(log).toEqual([
			'hide inventory in inventory', 'show session in session',
			'hide session in session', 'show session in session',
		]);
		expect(log.filter((entry) => entry.startsWith('unmount') || entry.startsWith('mount'))).toEqual([]);
	});

	it('unmounts every mounted section, with its own element and no visibility notice first, when the view is taken away', async () => {
		const { fake, widened, ui } = await hebra();
		const log: string[] = [];
		const unregister = ui.registerSectionsView!(sectionsView(log));
		fake.mainView.open(MAIN);
		fake.mainView.select('sale');
		log.length = 0;

		unregister();

		expect(log).toEqual(['unmount session in session', 'unmount sale in sale']);
		expect(widened.view(MAIN).registered()).toBeNull();
		expect(fake.recorded.mainViews).toEqual([]);
		expect(document.querySelector('.hebra-module-view-main')).toBeNull();
		// Taking it away twice is taking it away once.
		unregister();
		expect(log).toHaveLength(2);
	});

	it('an unmount never overtakes an asynchronous mount in flight', async () => {
		const { fake, ui } = await hebra();
		const order: string[] = [];
		let mounted!: () => void;
		const slow = section('session', [], {
			mount: () => new Promise<void>((resolve) => { mounted = () => { order.push('mounted'); resolve(); }; }),
			unmount: () => { order.push('unmounted'); },
		});
		const unregister = ui.registerSectionsView!(sectionsView([], [slow]));
		fake.mainView.open(MAIN);

		unregister();
		expect(order).toEqual([]);
		mounted();
		await vi.waitFor(() => expect(order).toEqual(['mounted', 'unmounted']));
	});

	it('a first synchronous mount that throws reaches Hebra; a later asynchronous failure is reported', async () => {
		const { fake, ui, report } = await hebra();
		const broken = section('session', [], { mount: () => { throw new Error('no pinta'); } });
		const flaky = section('sale', [], { mount: async () => { throw new Error('tarde'); } });
		ui.registerSectionsView!(sectionsView([], [broken, flaky]));

		expect(() => { fake.mainView.open(MAIN); }).toThrow('no pinta');
		fake.mainView.open(MAIN, 'sale');
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'tarde' }), 'section tyrian-main-view/sale'));
	});

	it('a section without a visibility entry is hidden and shown without a call', async () => {
		const { fake, ui } = await hebra();
		const log: string[] = [];
		const quiet = section('session', log, { setVisible: undefined });
		ui.registerSectionsView!(sectionsView(log, [quiet, section('sale', log)]));
		fake.mainView.open(MAIN);
		expect(() => { fake.mainView.select('sale'); fake.mainView.select('session'); }).not.toThrow();
		expect(log).toEqual(['mount session in session', 'mount sale in sale', 'hide sale in sale']);
	});
});

describe('revealSection and updateSection', () => {
	it('enters the main view on that section, and switches to it where the view is already on screen', async () => {
		const { fake, ui } = await hebra();
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));

		await ui.revealSection!('tyrian-main-view', 'inventory');
		expect(fake.recorded.reveals).toEqual([{ id: 'tyrian-main-view', section: 'inventory' }]);
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'inventory' });

		await ui.revealSection!('tyrian-main-view', 'sale');
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'sale' });
		expect(log).toEqual(['mount inventory in inventory', 'hide inventory in inventory', 'mount sale in sale']);
		// The user comes back later: Hebra remembers the section, the plugin stores none.
		fake.mainView.leave();
		fake.mainView.open(MAIN);
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'sale' });
	});

	it('on a Hebra that mounts on its next paint, the section asked for is mounted then and not before', async () => {
		const { fake, widened, ui } = await hebra('deferred');
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));

		await ui.revealSection!('tyrian-main-view', 'inventory');
		expect(log).toEqual([]);
		expect(fake.mainView.current()).toBeNull();

		widened.mainView.paint();
		expect(log).toEqual(['mount inventory in inventory']);
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'inventory' });
	});

	it('changes what Hebra lists for a section: its title, a subtitle, a badge; null takes the last two away', async () => {
		const { fake, widened, ui } = await hebra();
		ui.registerSectionsView!(sectionsView([]));

		ui.updateSection!('tyrian-main-view', 'sale', { title: 'Sale', subtitle: '3 to sell', badge: 3 });
		expect(fake.mainView.sections(MAIN)[2]).toEqual({ id: 'sale', title: 'Sale', icon: 'icon-sale', subtitle: '3 to sell', badge: 3 });

		ui.updateSection!('tyrian-main-view', 'sale', { subtitle: null, badge: null });
		expect(fake.mainView.sections(MAIN)[2]).toEqual({ id: 'sale', title: 'Sale', icon: 'icon-sale', badge: null });
		// An omitted field stays, and nothing else of the patch reaches Hebra.
		const updateViewSection = vi.spyOn(widened.api.ui, 'updateViewSection');
		ui.updateSection!('tyrian-main-view', 'session', { title: 'Session' });
		expect(updateViewSection.mock.calls).toEqual([['tyrian-main-view', 'session', { title: 'Session' }]]);
		expect(fake.mainView.sections(MAIN)[0]?.icon).toBe('icon-session');
	});
});

describe('the ribbon button while the main view is registered', () => {
	it('carries the main view as its view, and loses it again when the view is taken away', async () => {
		const { fake, ui } = await hebra();
		const onClick = vi.fn();
		const unregister = ui.registerSectionsView!(sectionsView([]));
		ui.ribbon({ icon: 'sword', title: 'Tyrian', onClick });
		expect(fake.recorded.ribbon).toHaveLength(1);
		expect(fake.recorded.ribbon[0]).toMatchObject({ icon: 'sword', title: 'Tyrian', viewId: 'tyrian-main-view' });

		unregister();
		// Made again, not patched: Hebra has no way to change the view of a button. Still ONE button.
		expect(fake.recorded.ribbon).toHaveLength(1);
		expect(fake.recorded.ribbon[0]).not.toHaveProperty('viewId');

		ui.registerSectionsView!(sectionsView([]));
		expect(fake.recorded.ribbon).toHaveLength(1);
		expect(fake.recorded.ribbon[0]).toMatchObject({ viewId: 'tyrian-main-view' });
		// With a main view Hebra calls `onClick` on every click: the menu still opens.
		fake.recorded.ribbon[0]?.onClick();
		expect(onClick).toHaveBeenCalledOnce();
	});

	it('a button made again keeps the title and the pending flag it was last given, and the handle keeps driving it', async () => {
		const { fake, ui } = await hebra();
		const handle = ui.ribbon({ icon: 'sword', title: 'Tyrian', onClick: vi.fn() });
		expect(fake.recorded.ribbon[0]).not.toHaveProperty('viewId');
		handle.setTitle('Tyrian: finish session');
		handle.setPending(true);

		const unregister = ui.registerSectionsView!(sectionsView([]));
		expect(fake.recorded.ribbon).toHaveLength(1);
		expect(fake.recorded.ribbon[0]).toMatchObject({ title: 'Tyrian: finish session', pending: true, viewId: 'tyrian-main-view' });

		handle.setPending(false);
		handle.setTitle('Tyrian');
		unregister();
		expect(fake.recorded.ribbon).toHaveLength(1);
		expect(fake.recorded.ribbon[0]).toMatchObject({ title: 'Tyrian' });
		expect(fake.recorded.ribbon[0]).not.toHaveProperty('pending');
		expect(fake.recorded.ribbon[0]).not.toHaveProperty('viewId');
	});
});

describe('what Hebra\'s real host does and its fake does not (`withRealHostBehaviour`)', () => {
	/** A raw main view, as a plugin hands it to Hebra, that logs what Hebra does with each section. */
	function rawView(log: string[], extra: Partial<PluginMainViewDefinition> = {}): PluginMainViewDefinition {
		return {
			id: MAIN, title: 'Tyrian', icon: 'sword', placement: 'main', retainSections: true,
			sections: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
			mountSection: (_el, sectionId) => {
				log.push(`mount ${sectionId}`);
				return { unmount: () => { log.push(`unmount ${sectionId}`); } };
			},
			...extra,
		};
	}

	it('refuses a view id that is still registered, main or of its own, and takes it again once it is unregistered', async () => {
		const { widened } = await hebra();
		const column = { id: 'tyrian-companion-view', title: 'C', icon: 'sword', mount: vi.fn(), unmount: vi.fn() };
		const unregisterMain = widened.api.ui.registerView(rawView([]));
		const unregisterColumn = widened.api.ui.registerView(column);

		expect(() => widened.api.ui.registerView(rawView([]))).toThrow(/Ya hay una vista/u);
		expect(() => widened.api.ui.registerView(column)).toThrow(/Ya hay una vista/u);
		expect(() => widened.api.ui.registerView({ ...column, id: MAIN })).toThrow(/Ya hay una vista/u);

		unregisterMain();
		unregisterColumn();
		expect(() => { widened.api.ui.registerView(rawView([])); widened.api.ui.registerView(column); }).not.toThrow();
	});

	it('mounts a column or dialog view when the user opens it, and unmounts an open one when it is unregistered', async () => {
		const { fake, widened } = await hebra();
		const mount = vi.fn();
		const unmount = vi.fn();
		const unregister = widened.api.ui.registerView({ id: 'tyrian-sale-view', title: 'V', icon: 'candy', placement: 'dialog', mount, unmount });
		expect(fake.recorded.views.map(({ id }) => id)).toEqual(['tyrian-sale-view']);
		expect(() => widened.ownViews.open('tyrian-companion-view')).toThrow(/No view/u);

		const el = widened.ownViews.open('tyrian-sale-view');
		expect(mount).toHaveBeenCalledWith(el);
		expect(widened.ownViews.opened()).toEqual(['tyrian-sale-view']);

		unregister();
		expect(unmount).toHaveBeenCalledOnce();
		expect([widened.ownViews.registered(), widened.ownViews.opened(), fake.recorded.views]).toEqual([[], [], []]);
		// One that was never opened has nothing to unmount.
		const never = vi.fn();
		widened.api.ui.registerView({ id: 'tyrian-sale-view', title: 'V', icon: 'candy', mount: vi.fn(), unmount: never })();
		expect(never).not.toHaveBeenCalled();
	});

	it('with a deferred mount, what the plugin reveals waits for the paint, in order, while the user\'s own moves do not', async () => {
		const { fake, widened } = await hebra('deferred');
		const log: string[] = [];
		const unregister = widened.api.ui.registerView(rawView(log));

		widened.api.ui.revealView(MAIN, { section: 'b' });
		widened.api.ui.revealView(MAIN, { section: 'a' });
		expect(log).toEqual([]);
		expect(fake.recorded.reveals).toEqual([]);
		widened.mainView.paint();
		expect(log).toEqual(['mount b', 'mount a']);
		expect(fake.recorded.reveals).toEqual([{ id: MAIN, section: 'b' }, { id: MAIN, section: 'a' }]);
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'a' });

		// The user picks a section: that is Hebra painting.
		fake.mainView.select('b');
		expect(fake.mainView.current()).toEqual({ viewId: MAIN, sectionId: 'b' });

		// A reveal still waiting when the view goes away finds nothing to open.
		widened.api.ui.revealView(MAIN, { section: 'a' });
		unregister();
		widened.mainView.paint();
		expect(fake.mainView.current()).toBeNull();
		expect(log).toEqual(['mount b', 'mount a', 'unmount b', 'unmount a']);
		// A second paint has nothing left to apply.
		widened.mainView.paint();
		expect(fake.recorded.reveals).toHaveLength(3);
	});

	it('writes down what the plugin\'s unmount and visibility notice throw, which Hebra swallows', async () => {
		const { fake, widened } = await hebra();
		const unregister = widened.api.ui.registerView(rawView([], {
			mountSection: (_el, sectionId) => ({
				unmount: () => { if (sectionId === 'a') throw new Error('unmount a'); },
				onVisibilityChange: (visible) => { if (sectionId === 'a' && !visible) throw new Error('hide a'); },
			}),
		}));
		fake.mainView.open(MAIN, 'a');
		expect(widened.faults).toEqual([]);

		// Hebra goes on as if nothing had happened; the test would never know.
		expect(() => { fake.mainView.select('b'); fake.mainView.select('a'); fake.mainView.leave(); }).not.toThrow();
		expect(widened.faults).toEqual(['onVisibilityChange of tyrian-main-view/a', 'onVisibilityChange of tyrian-main-view/a']);

		expect(() => { unregister(); }).not.toThrow();
		expect(widened.faults).toEqual([
			'onVisibilityChange of tyrian-main-view/a', 'onVisibilityChange of tyrian-main-view/a', 'unmount of tyrian-main-view/a',
		]);
		// These faults are this test's subject, not a failure of the plugin.
		widened.faults.length = 0;
	});
});
