import { describe, expect, it } from 'vitest';

import { COMPANION_VIEW_SLOT, COMPANION_VIEW_TYPE, companionSection, companionView } from './companion-view';
import {
	INVENTORY_ADVISOR_VIEW_SLOT,
	INVENTORY_ADVISOR_VIEW_TYPE,
	inventoryAdvisorSection,
	inventoryAdvisorView,
} from './inventory-advisor-item-view';
import {
	MountedViews,
	sectionsViewRegistration,
	sectionViewDescriptor,
	sectionViewRegistration,
	type MountableView,
	type TyrianSection,
	type TyrianViewDescriptor,
} from './mounted-views';
import { SALE_VIEW_SLOT, SALE_VIEW_TYPE, saleSection, saleView } from './sale-item-view';

class RecordingView implements MountableView {
	readonly events: string[] = [];
	constructor(readonly container: HTMLElement) {}
	async onOpen(): Promise<void> { this.events.push('open'); }
	async onClose(): Promise<void> { this.events.push('close'); }
}

const container = (name: string): HTMLElement => ({ name }) as unknown as HTMLElement;

describe('MountedViews', () => {
	it('turns a descriptor into a registration that says the same', () => {
		const views = new MountedViews((element) => new RecordingView(element));
		const registration = views.registration({ type: 'tyrian-x', title: () => 'Equis', icon: 'compass', placement: 'dialog' });
		expect([registration.type, registration.title(), registration.icon, registration.placement])
			.toEqual(['tyrian-x', 'Equis', 'compass', 'dialog']);
		expect('placement' in views.registration({ type: 'tyrian-y', title: () => 'Y', icon: 'x' })).toBe(false);
	});

	it('creates and opens one controller per container the host mounts, and closes and forgets it on unmount', async () => {
		const views = new MountedViews((element) => new RecordingView(element));
		const registration = views.registration({ type: 'tyrian-x', title: () => 'Equis', icon: 'compass' });
		const left = container('left');
		const right = container('right');

		await registration.mount(left);
		await registration.mount(right);
		const [first, second] = views.current();
		expect([first?.container, second?.container]).toEqual([left, right]);
		expect(first?.events).toEqual(['open']);

		await registration.unmount(left);
		expect(first?.events).toEqual(['open', 'close']);
		expect(views.current()).toEqual([second]);

		// A container it never mounted, or one already unmounted, is nothing to close.
		await registration.unmount(left);
		await registration.unmount(container('other'));
		expect(first?.events).toEqual(['open', 'close']);
		expect(views.current()).toEqual([second]);
	});
});

describe('the product views as the host registers them', () => {
	it('declare where Hebra shows each one: the Companion in the column, Inventory and Sale in the dialog', () => {
		const locale = { getLocale: () => 'es' as const, getInventoryAdvisorLocale: () => 'es' as const, getSaleLocale: () => 'es' as const };
		const described = [companionView(locale), inventoryAdvisorView(locale), saleView(locale)]
			.map(({ type, icon, placement }) => ({ type, icon, placement }));
		expect(described).toEqual([
			{ type: COMPANION_VIEW_TYPE, icon: 'sword', placement: 'column' },
			{ type: INVENTORY_ADVISOR_VIEW_TYPE, icon: 'package-search', placement: 'dialog' },
			{ type: SALE_VIEW_TYPE, icon: 'candy', placement: 'dialog' },
		]);
	});

	it('title each one in the current language, read on every call', () => {
		let locale: 'es' | 'en' = 'es';
		const companion = companionView({ getLocale: () => locale });
		const inventory = inventoryAdvisorView({ getInventoryAdvisorLocale: () => locale });
		const sale = saleView({ getSaleLocale: () => locale });
		const spanish = [companion.title(), inventory.title(), sale.title()];
		locale = 'en';
		const english = [companion.title(), inventory.title(), sale.title()];
		expect(spanish[2]).toBe('Venta de Halloween');
		expect(english[2]).toBe('Halloween sale');
		expect(spanish).not.toEqual(english);
	});
});

/** A view that also listens to being hidden and shown without being unmounted. */
class HideableView extends RecordingView {
	setVisible(visible: boolean): void { this.events.push(visible ? 'shown' : 'hidden'); }
}

describe('a section, apart from where the host registers it', () => {
	it('says what it is and nothing about where: an id, a title and a short label read on every call, an icon and how it mounts', () => {
		let title = 'Equis';
		const section = new MountedViews((element) => new RecordingView(element))
			.section({ id: 'sale', title: () => title, label: () => `${title} corta`, icon: 'compass' });
		expect(Object.keys(section).sort()).toEqual(['icon', 'id', 'label', 'mount', 'setVisible', 'title', 'unmount']);
		expect([section.id, section.title(), section.label(), section.icon]).toEqual(['sale', 'Equis', 'Equis corta', 'compass']);
		title = 'Otra';
		expect([section.title(), section.label()]).toEqual(['Otra', 'Otra corta']);
	});

	it('mounts one controller per container and closes and forgets it on unmount, like the view it used to be', async () => {
		const views = new MountedViews((element) => new RecordingView(element));
		const section = views.section({ id: 'session', title: () => 'Equis', label: () => 'X', icon: 'compass' });
		const left = container('left');
		const right = container('right');

		await section.mount(left);
		await section.mount(right);
		const [first, second] = views.current();
		expect([first?.container, second?.container]).toEqual([left, right]);
		expect(first?.events).toEqual(['open']);

		await section.unmount(left);
		await section.unmount(left);
		await section.unmount(container('other'));
		expect(first?.events).toEqual(['open', 'close']);
		expect(views.current()).toEqual([second]);
	});

	it('tells only the controller of that container that it was hidden or shown, and never mounts or unmounts for it', async () => {
		const views = new MountedViews((element) => new HideableView(element));
		const section = views.section({ id: 'inventory', title: () => 'Equis', label: () => 'X', icon: 'compass' });
		const left = container('left');
		const right = container('right');
		await section.mount(left);
		await section.mount(right);
		const [first, second] = views.current();

		section.setVisible?.(left, false);
		section.setVisible?.(left, true);
		expect(first?.events).toEqual(['open', 'hidden', 'shown']);
		expect(second?.events).toEqual(['open']);
		expect(views.current()).toEqual([first, second]);

		// A container that is not mounted has nobody to tell.
		await section.unmount(left);
		section.setVisible?.(left, false);
		section.setVisible?.(container('other'), false);
		expect(first?.events).toEqual(['open', 'hidden', 'shown', 'close']);
	});

	it('is a no-op to hide or show a controller that does not listen', async () => {
		const views = new MountedViews((element) => new RecordingView(element));
		const section = views.section({ id: 'sale', title: () => 'Equis', label: () => 'X', icon: 'compass' });
		const only = container('only');
		await section.mount(only);
		expect(() => { section.setVisible?.(only, false); }).not.toThrow();
		expect(views.current()[0]?.events).toEqual(['open']);
	});
});

describe('from a section to the view the host registers', () => {
	const fakeSection = (calls: string[]): TyrianSection => ({
		id: 'sale',
		title: () => 'Equis',
		label: () => 'X',
		icon: 'compass',
		mount: async (element) => { calls.push(`mount:${(element as unknown as { name: string }).name}`); },
		unmount: async (element) => { calls.push(`unmount:${(element as unknown as { name: string }).name}`); },
		setVisible: () => { calls.push('setVisible'); },
	});

	it('takes the type and the placement from the slot and the title and the icon from the section', () => {
		const descriptor = sectionViewDescriptor({ id: 'sale', title: () => 'Equis', label: () => 'X', icon: 'compass' }, { type: 'tyrian-x', placement: 'dialog' });
		expect(Object.keys(descriptor).sort()).toEqual(['icon', 'placement', 'title', 'type']);
		expect([descriptor.type, descriptor.title(), descriptor.icon, descriptor.placement]).toEqual(['tyrian-x', 'Equis', 'compass', 'dialog']);
		// A slot without a placement leaves it out, so the host applies its own default.
		expect('placement' in sectionViewDescriptor({ id: 'sale', title: () => 'Y', label: () => 'y', icon: 'x' }, { type: 'tyrian-y' })).toBe(false);
	});

	it('registers exactly a view: the six fields of a registration, with the section\'s own mount and unmount behind them', async () => {
		const calls: string[] = [];
		const registration = sectionViewRegistration(fakeSection(calls), { type: 'tyrian-x', placement: 'column' });
		// Nothing of the section leaks into what `registerView` takes: no id, no visibility entry.
		expect(Object.keys(registration).sort()).toEqual(['icon', 'mount', 'placement', 'title', 'type', 'unmount']);
		expect([registration.type, registration.title(), registration.icon, registration.placement]).toEqual(['tyrian-x', 'Equis', 'compass', 'column']);
		expect('placement' in sectionViewRegistration(fakeSection(calls), { type: 'tyrian-y' })).toBe(false);

		await registration.mount(container('left'));
		await registration.unmount(container('left'));
		expect(calls).toEqual(['mount:left', 'unmount:left']);
	});

	it('gives the three product views the same type, title, icon and placement they registered with before', () => {
		let locale: 'es' | 'en' = 'es';
		const actions = { getLocale: () => locale, getInventoryAdvisorLocale: () => locale, getSaleLocale: () => locale };
		const views = new MountedViews((element) => new RecordingView(element));
		const derived = [
			sectionViewRegistration(views.section(companionSection(actions)), COMPANION_VIEW_SLOT),
			sectionViewRegistration(views.section(inventoryAdvisorSection(actions)), INVENTORY_ADVISOR_VIEW_SLOT),
			sectionViewRegistration(views.section(saleSection(actions)), SALE_VIEW_SLOT),
		];
		const say = (view: TyrianViewDescriptor) => ({ type: view.type, title: view.title(), icon: view.icon, placement: view.placement });
		const facts = () => derived.map(say);

		expect(facts()).toEqual([
			{ type: 'tyrian-companion-view', title: 'Acompañante de Tyria', icon: 'sword', placement: 'column' },
			{ type: 'tyrian-inventory-advisor-view', title: 'Asesor de inventario', icon: 'package-search', placement: 'dialog' },
			{ type: 'tyrian-sale-view', title: 'Venta de Halloween', icon: 'candy', placement: 'dialog' },
		]);
		locale = 'en';
		expect(facts().map(({ title }) => title)).toEqual(['Tyrian companion', 'Inventory advisor', 'Halloween sale']);
		// The descriptor each view still exports is the same derivation.
		expect([companionView(actions), inventoryAdvisorView(actions), saleView(actions)].map(say)).toEqual(facts());
	});

	it('names the three sections with ids that do not change with the language', () => {
		const ids = (locale: 'es' | 'en') => [
			companionSection({ getLocale: () => locale }).id,
			inventoryAdvisorSection({ getInventoryAdvisorLocale: () => locale }).id,
			saleSection({ getSaleLocale: () => locale }).id,
		];
		expect(ids('es')).toEqual(['session', 'inventory', 'sale']);
		expect(ids('en')).toEqual(ids('es'));
	});

	it('lists the same sections together in ONE view: in the order given, each under its short label and with its own icon', () => {
		let locale: 'es' | 'en' = 'es';
		const actions = { getLocale: () => locale, getInventoryAdvisorLocale: () => locale, getSaleLocale: () => locale };
		const views = new MountedViews((element) => new RecordingView(element));
		const registration = sectionsViewRegistration({ type: 'tyrian-main', title: () => 'Tyrian', icon: 'sword' }, [
			views.section(companionSection(actions)), views.section(inventoryAdvisorSection(actions)), views.section(saleSection(actions)),
		]);
		const listed = () => registration.sections.map((section) => [section.id, section.title(), section.icon]);

		expect(Object.keys(registration).sort()).toEqual(['icon', 'sections', 'title', 'type']);
		expect([registration.type, registration.title(), registration.icon]).toEqual(['tyrian-main', 'Tyrian', 'sword']);
		expect(listed()).toEqual([
			['session', 'Sesión', 'sword'], ['inventory', 'Inventario', 'package-search'], ['sale', 'Venta', 'candy'],
		]);
		locale = 'en';
		expect(listed().map(([, title]) => title)).toEqual(['Session', 'Inventory', 'Sale']);
		// The label is for the list only: the title of each section as a view of its own is another.
		expect(companionSection(actions).title()).toBe('Tyrian companion');
	});

	it('mounts, unmounts and tells a listed section it is hidden or shown through the same controllers, each in its own container', async () => {
		const sessions = new MountedViews((element) => new HideableView(element));
		const sales = new MountedViews((element) => new HideableView(element));
		const registration = sectionsViewRegistration({ type: 'tyrian-main', title: () => 'Tyrian', icon: 'sword' }, [
			sessions.section({ id: 'session', title: () => 'S', label: () => 's', icon: 'a' }),
			sales.section({ id: 'sale', title: () => 'V', label: () => 'v', icon: 'b' }),
		]);
		const [session, sale] = registration.sections;
		const first = container('first');
		const second = container('second');

		await session!.mount(first);
		await sale!.mount(second);
		session!.setVisible?.(first, false);
		sale!.setVisible?.(second, false);
		sale!.setVisible?.(second, true);
		expect(sessions.current()[0]?.events).toEqual(['open', 'hidden']);
		expect(sales.current()[0]?.events).toEqual(['open', 'hidden', 'shown']);

		const closing = sessions.current()[0];
		await session!.unmount(first);
		expect(closing?.events).toEqual(['open', 'hidden', 'close']);
		expect([sessions.current().length, sales.current().length]).toEqual([0, 1]);
	});

	it('mounts the derived view through the same controllers the repaints walk', async () => {
		const views = new MountedViews((element) => new RecordingView(element));
		const registration = sectionViewRegistration(
			views.section(saleSection({ getSaleLocale: () => 'es' })), SALE_VIEW_SLOT,
		);
		const leaf = container('leaf');

		await registration.mount(leaf);
		const [mounted] = views.current();
		expect(mounted?.container).toBe(leaf);
		expect(mounted?.events).toEqual(['open']);

		await registration.unmount(leaf);
		expect(mounted?.events).toEqual(['open', 'close']);
		expect(views.current()).toEqual([]);
	});
});
