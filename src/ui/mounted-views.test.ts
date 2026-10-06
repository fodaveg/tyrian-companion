import { describe, expect, it } from 'vitest';

import { COMPANION_VIEW_TYPE, companionView } from './companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE, inventoryAdvisorView } from './inventory-advisor-item-view';
import { MountedViews, type MountableView } from './mounted-views';
import { SALE_VIEW_TYPE, saleView } from './sale-item-view';

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
