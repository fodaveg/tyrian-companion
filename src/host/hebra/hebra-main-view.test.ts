// @vitest-environment happy-dom
import { createFakePluginApi } from 'hebra-plugin-api/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withFakeMainView } from '../../test/hebra-main-view-fake';
import type { TyrianSectionsViewRegistration, TyrianViewSectionRegistration } from '../tyrian-host';
import { createHebraTyrianUi } from './hebra-host-ui';
import { hebraHasMainView } from './hebra-main-view';
import type { PluginMainViewDefinition } from './plugin-api-1-3-provisional';
import { createMemorySecretsBackend, createPreloadedSecrets } from './secrets';

// The main view of Hebra's plugin API 1.3.0 (provisional) through the adapter: what reaches Hebra
// when the core registers ONE view with sections, and what Hebra's own behaviour (the fake of
// `src/test/hebra-main-view-fake.ts`, written from the contract) makes of it.

/** A Hebra before the main view: the package's fake, which is the 1.0.0 API. */
async function olderHebra() {
	const fake = createFakePluginApi({ id: 'tyrian-companion', capabilities: ['editor'] });
	const mainView = hebraHasMainView(fake.api);
	const ui = createHebraTyrianUi({ api: fake.api, mainView, ...await rest() });
	return { fake, ui, mainView };
}

/** A Hebra with the main view. */
async function hebra() {
	const fake = createFakePluginApi({ id: 'tyrian-companion', capabilities: ['editor'] });
	const widened = withFakeMainView(fake.api);
	const report = vi.fn();
	const ui = createHebraTyrianUi({ api: widened.api, mainView: hebraHasMainView(widened.api), ...await rest(), report });
	return { fake, widened, ui, report };
}

async function rest() {
	return {
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

/** The code Hebra refused the call with, or null when it went through. */
function refusal(call: () => void): string | null {
	try {
		call();
		return null;
	} catch (error) {
		return (error as { code?: string }).code ?? 'thrown without a code';
	}
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('a Hebra without the main view (1.2.0 and before)', () => {
	it('answers false to the feature without throwing, and the port has none of the three methods', async () => {
		const { ui, mainView } = await olderHebra();
		expect(mainView).toBe(false);
		expect(ui).not.toHaveProperty('registerSectionsView');
		expect(ui).not.toHaveProperty('revealSection');
		expect(ui).not.toHaveProperty('updateSection');
	});

	it('reveals a view with the type alone, as before', async () => {
		const { fake, ui } = await olderHebra();
		const revealView = vi.spyOn(fake.api.ui, 'revealView');
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
		const definition = registerView.mock.calls[0]![0] as unknown as PluginMainViewDefinition;
		expect(Object.keys(definition).sort()).toEqual(['icon', 'id', 'mountSection', 'placement', 'retainSections', 'sections', 'title']);
		expect([definition.id, definition.title, definition.icon, definition.placement, definition.retainSections])
			.toEqual(['tyrian-main-view', 'Tyrian Companion', 'sword', 'main', true]);
		expect(definition.sections).toEqual([
			{ id: 'session', title: 'Título de session', icon: 'icon-session' },
			{ id: 'inventory', title: 'Título de inventory', icon: 'icon-inventory' },
			{ id: 'sale', title: 'Título de sale', icon: 'icon-sale' },
		]);
		expect(widened.mainView.registered()).toBe('tyrian-main-view');
		expect(widened.viewTitle('tyrian-main-view')).toBe('Tyrian Companion');
		// Nothing of it is a column or dialog view, and nothing is mounted until somebody enters.
		expect(fake.recorded.views).toEqual([]);
		expect(widened.mainView.mounted()).toEqual([]);
	});

	it('mounts each section on its first visit, in the element Hebra gives it, and never tells it it is visible right then', async () => {
		const { widened, ui } = await hebra();
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));

		widened.mainView.open();
		expect(log).toEqual(['mount session in session']);
		expect(widened.mainView.current()).toBe('session');
		const el = widened.mainView.element('session')!;
		expect(el.className).toBe('hebra-module-view-content hebra-module-view-main-content');
		expect(el.parentElement?.className).toBe('hebra-module-view hebra-module-view-main');

		widened.mainView.select('sale');
		expect(log).toEqual(['mount session in session', 'hide session in session', 'mount sale in sale']);
		// Inventory was never visited: it is not mounted.
		expect(widened.mainView.mounted()).toEqual(['session', 'sale']);
	});

	it('hides and shows a mounted section instead of unmounting it, also when the user goes back to the notes', async () => {
		const { widened, ui } = await hebra();
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));
		widened.mainView.open();
		widened.mainView.select('inventory');
		log.length = 0;

		widened.mainView.select('session');
		expect(log).toEqual(['hide inventory in inventory', 'show session in session']);
		expect(widened.mainView.element('inventory')?.hidden).toBe(true);
		expect(widened.mainView.element('session')?.hidden).toBe(false);

		widened.mainView.leave();
		widened.mainView.open();
		expect(log).toEqual([
			'hide inventory in inventory', 'show session in session',
			'hide session in session', 'show session in session',
		]);
		expect(log.filter((entry) => entry.startsWith('unmount') || entry.startsWith('mount'))).toEqual([]);
	});

	it('unmounts every mounted section, with its own element and no visibility notice first, when the view is taken away', async () => {
		const { widened, ui } = await hebra();
		const log: string[] = [];
		const unregister = ui.registerSectionsView!(sectionsView(log));
		widened.mainView.open();
		widened.mainView.select('sale');
		log.length = 0;

		unregister();

		expect(log).toEqual(['unmount session in session', 'unmount sale in sale']);
		expect(widened.mainView.registered()).toBeNull();
		expect(document.querySelector('.hebra-module-view-main')).toBeNull();
		// Taking it away twice is taking it away once.
		unregister();
		expect(log).toHaveLength(2);
	});

	it('an unmount never overtakes an asynchronous mount in flight', async () => {
		const { widened, ui } = await hebra();
		const order: string[] = [];
		let mounted!: () => void;
		const slow = section('session', [], {
			mount: () => new Promise<void>((resolve) => { mounted = () => { order.push('mounted'); resolve(); }; }),
			unmount: () => { order.push('unmounted'); },
		});
		const unregister = ui.registerSectionsView!(sectionsView([], [slow]));
		widened.mainView.open();

		unregister();
		expect(order).toEqual([]);
		mounted();
		await vi.waitFor(() => expect(order).toEqual(['mounted', 'unmounted']));
	});

	it('a first synchronous mount that throws reaches Hebra; a later asynchronous failure is reported', async () => {
		const { widened, ui, report } = await hebra();
		const broken = section('session', [], { mount: () => { throw new Error('no pinta'); } });
		const flaky = section('sale', [], { mount: async () => { throw new Error('tarde'); } });
		ui.registerSectionsView!(sectionsView([], [broken, flaky]));

		expect(() => { widened.mainView.open(); }).toThrow('no pinta');
		widened.mainView.select('sale');
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'tarde' }), 'section tyrian-main-view/sale'));
	});

	it('a section without a visibility entry is hidden and shown without a call', async () => {
		const { widened, ui } = await hebra();
		const log: string[] = [];
		const quiet = section('session', log, { setVisible: undefined });
		ui.registerSectionsView!(sectionsView(log, [quiet, section('sale', log)]));
		widened.mainView.open();
		expect(() => { widened.mainView.select('sale'); widened.mainView.select('session'); }).not.toThrow();
		expect(log).toEqual(['mount session in session', 'mount sale in sale', 'hide sale in sale']);
	});
});

describe('revealSection and updateSection', () => {
	it('enters the main view on that section, and switches to it where the view is already on screen', async () => {
		const { widened, ui } = await hebra();
		const log: string[] = [];
		ui.registerSectionsView!(sectionsView(log));

		await ui.revealSection!('tyrian-main-view', 'inventory');
		expect(widened.recorded.reveals).toEqual([{ id: 'tyrian-main-view', section: 'inventory' }]);
		expect(widened.mainView.current()).toBe('inventory');

		await ui.revealSection!('tyrian-main-view', 'sale');
		expect(widened.mainView.current()).toBe('sale');
		expect(log).toEqual(['mount inventory in inventory', 'hide inventory in inventory', 'mount sale in sale']);
		// The user comes back later: Hebra remembers the last section.
		widened.mainView.leave();
		widened.mainView.open();
		expect(widened.mainView.current()).toBe('sale');
	});

	it('changes what Hebra lists for a section: its title, a subtitle, a badge; null takes the last two away', async () => {
		const { widened, ui } = await hebra();
		ui.registerSectionsView!(sectionsView([]));

		ui.updateSection!('tyrian-main-view', 'sale', { title: 'Sale', subtitle: '3 to sell', badge: 3 });
		expect(widened.mainView.sections()[2]).toEqual({ id: 'sale', title: 'Sale', icon: 'icon-sale', subtitle: '3 to sell', badge: 3 });

		ui.updateSection!('tyrian-main-view', 'sale', { subtitle: null, badge: null });
		expect(widened.mainView.sections()[2]).toEqual({ id: 'sale', title: 'Sale', icon: 'icon-sale', badge: null });
		// An omitted field stays, and nothing else of the patch reaches Hebra.
		const updateViewSection = vi.spyOn(widened.api.ui as unknown as { updateViewSection(...args: unknown[]): void }, 'updateViewSection');
		ui.updateSection!('tyrian-main-view', 'session', { title: 'Session' });
		expect(updateViewSection.mock.calls).toEqual([['tyrian-main-view', 'session', { title: 'Session' }]]);
		expect(widened.mainView.sections()[0]?.icon).toBe('icon-session');
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

describe('the fake of the main view, against the contract it was written from', () => {
	it('refuses a view with no sections, a section without id or title, repeated ids and no mountSection, and registers nothing', async () => {
		const { widened } = await hebra();
		const register = (view: Partial<PluginMainViewDefinition>): (() => void) => () => {
			(widened.api.ui as unknown as { registerView(view: unknown): void }).registerView({
				id: 'x', title: 'X', icon: 'ghost', placement: 'main', sections: [{ id: 'a', title: 'A' }], mountSection: () => undefined, ...view,
			});
		};
		expect(refusal(register({ sections: [] }))).toBe('invalid-argument');
		expect(refusal(register({ sections: [{ id: '', title: 'A' }] }))).toBe('invalid-argument');
		expect(refusal(register({ sections: [{ id: 'a', title: '' }] }))).toBe('invalid-argument');
		expect(refusal(register({ sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }))).toBe('invalid-argument');
		expect(refusal(register({ mountSection: undefined }))).toBe('invalid-argument');
		expect(widened.mainView.registered()).toBeNull();
		expect(register({})).not.toThrow();
		expect(widened.mainView.registered()).toBe('x');
	});

	it('a section that does not exist opens the remembered one, or the first, and an empty title is refused', async () => {
		const { widened, ui } = await hebra();
		ui.registerSectionsView!(sectionsView([]));

		await ui.revealSection!('tyrian-main-view', 'nope');
		expect(widened.mainView.current()).toBe('session');
		widened.mainView.select('sale');
		widened.mainView.leave();
		await ui.revealSection!('tyrian-main-view', 'nope');
		expect(widened.mainView.current()).toBe('sale');
		expect(refusal(() => { ui.updateSection!('tyrian-main-view', 'sale', { title: '' }); })).toBe('invalid-argument');
		// What does not exist does nothing.
		expect(() => { ui.updateSection!('tyrian-main-view', 'nope', { title: 'X' }); }).not.toThrow();
	});

	it('refuses a second view of a type it already has, as Hebra does, and closes an open one when it is unregistered', async () => {
		const { widened } = await hebra();
		const unmount = vi.fn();
		const view = { id: 'tyrian-companion-view', title: 'C', icon: 'sword', mount: vi.fn(), unmount };
		const unregister = widened.api.ui.registerView(view);
		expect(() => widened.api.ui.registerView(view)).toThrow();
		widened.ownViews.open('tyrian-companion-view');
		expect(widened.ownViews.opened()).toEqual(['tyrian-companion-view']);

		unregister();
		expect(unmount).toHaveBeenCalledOnce();
		expect(widened.ownViews.registered()).toEqual([]);
	});
});
