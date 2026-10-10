import type { TyrianSectionsViewRegistration, TyrianViewRegistration } from '../host/tyrian-host';

/** A view controller as the host drives it: opened when mounted, closed when unmounted. */
export interface MountableView {
	onOpen(): Promise<void>;
	onClose(): Promise<void>;
	/**
	 * The host showed or hid the container WITHOUT unmounting it (see `TyrianSection.setVisible`).
	 * Hidden, the controller ticks nothing and paints nothing; shown again, it repaints at most once.
	 */
	setVisible?(visible: boolean): void;
}

/** Everything a `TyrianViewRegistration` says about a view except how to mount it. */
export type TyrianViewDescriptor = Omit<TyrianViewRegistration, 'mount' | 'unmount'>;

/** The plugin's sections. Stable: the same in every language, version and host. */
export type TyrianSectionId = 'session' | 'inventory' | 'sale' | 'achievements';

/** What a section says about itself, wherever a host shows it; `MountedViews.section` adds how it mounts. */
export interface TyrianSectionDescriptor {
	readonly id: TyrianSectionId;
	/** Localized, so read on every paint. The title of the section as a view of its own. */
	title(): string;
	/** Localized. Its short name where a host lists the sections together («Sesión», «Inventario», «Venta», «Logros»). */
	label(): string;
	/** Lucide name. */
	readonly icon: string;
	/** A short mark beside the label where a host lists the sections (the count of followed achievements); null shows nothing. */
	badge?(): string | number | null;
}

/**
 * One section of the plugin (Session, Inventory, Sale, Achievements) as a host can show it: what it
 * is and how it is painted into an element, with nothing about WHERE. Where is a separate fact, so
 * the same four sections are four views of their own (`sectionViewRegistration`, each in its
 * `TyrianSectionViewSlot`) or the parts of one view (`sectionsViewRegistration`).
 */
export interface TyrianSection extends TyrianSectionDescriptor {
	mount(container: HTMLElement): void | Promise<void>;
	unmount(container: HTMLElement): void | Promise<void>;
	/**
	 * For a host that keeps a section mounted while another one is on screen: tells the section in
	 * `container` that it was hidden (false) or shown again (true). Only the sections view calls it
	 * (`sectionsViewRegistration`); a section that is a view of its own is unmounted instead.
	 */
	setVisible?(container: HTMLElement, visible: boolean): void;
}

/** Where a section is a view of its own for `TyrianUiPort.registerView`: the rest of its `TyrianViewRegistration`. */
export type TyrianSectionViewSlot = Pick<TyrianViewRegistration, 'type' | 'placement'>;

/** The view descriptor of a section registered in `slot`: the section's title and icon under the slot's type and placement. */
export function sectionViewDescriptor(section: TyrianSectionDescriptor, slot: TyrianSectionViewSlot): TyrianViewDescriptor {
	return {
		type: slot.type,
		title: () => section.title(),
		icon: section.icon,
		...(slot.placement === undefined ? {} : { placement: slot.placement }),
	};
}

/** What `TyrianUiPort.registerView` takes for a section registered in `slot`; it mounts as the section does. */
export function sectionViewRegistration(section: TyrianSection, slot: TyrianSectionViewSlot): TyrianViewRegistration {
	return viewRegistration(sectionViewDescriptor(section, slot), section);
}

/** What a sections view says of itself, apart from its sections. */
export type TyrianSectionsViewDescriptor = Omit<TyrianSectionsViewRegistration, 'sections'>;

/**
 * What `TyrianUiPort.registerSectionsView` takes for the sections together in ONE view, in the
 * order given: each listed under its short label and with its own icon, mounted, unmounted and
 * told of its visibility as the section is.
 */
export function sectionsViewRegistration(
	view: TyrianSectionsViewDescriptor,
	sections: readonly TyrianSection[],
): TyrianSectionsViewRegistration {
	return {
		type: view.type,
		title: () => view.title(),
		icon: view.icon,
		sections: sections.map((section) => ({
			id: section.id,
			title: () => section.label(),
			icon: section.icon,
			// Only a section with a mark lists one: the host paints nothing for a section without the entry.
			...(section.badge === undefined ? {} : { badge: () => section.badge!() }),
			mount: (container) => section.mount(container),
			unmount: (container) => section.unmount(container),
			setVisible: (container, visible) => { section.setVisible?.(container, visible); },
		})),
	};
}

function viewRegistration(
	view: TyrianViewDescriptor,
	mounting: Pick<TyrianViewRegistration, 'mount' | 'unmount'>,
): TyrianViewRegistration {
	return {
		type: view.type,
		title: () => view.title(),
		icon: view.icon,
		...(view.placement === undefined ? {} : { placement: view.placement }),
		mount: (container) => mounting.mount(container),
		unmount: (container) => mounting.unmount(container),
	};
}

/**
 * The controllers the host has mounted for ONE section, one per container it gave (in Obsidian,
 * one per open leaf of that view type). `section` turns a descriptor into the section a host
 * mounts, and `registration` a view descriptor into what `TyrianUiPort.registerView` takes;
 * `current()` is what `main.ts` repaints, where it used to walk
 * `workspace.getLeavesOfType(type)` and pick out its own `ItemView` subclass.
 */
export class MountedViews<T extends MountableView> {
	private readonly byContainer = new Map<HTMLElement, T>();

	constructor(private readonly create: (container: HTMLElement) => T) {}

	section(section: TyrianSectionDescriptor): TyrianSection {
		return {
			id: section.id,
			title: () => section.title(),
			label: () => section.label(),
			icon: section.icon,
			...(section.badge === undefined ? {} : { badge: () => section.badge!() }),
			mount: (container) => this.open(container),
			unmount: (container) => this.close(container),
			setVisible: (container, visible) => { this.byContainer.get(container)?.setVisible?.(visible); },
		};
	}

	registration(view: TyrianViewDescriptor): TyrianViewRegistration {
		return viewRegistration(view, {
			mount: (container) => this.open(container),
			unmount: (container) => this.close(container),
		});
	}

	/** The controllers mounted right now, in mount order. */
	current(): T[] {
		return [...this.byContainer.values()];
	}

	private async open(container: HTMLElement): Promise<void> {
		const controller = this.create(container);
		this.byContainer.set(container, controller);
		await controller.onOpen();
	}

	private async close(container: HTMLElement): Promise<void> {
		const controller = this.byContainer.get(container);
		if (controller === undefined) return;
		this.byContainer.delete(container);
		await controller.onClose();
	}
}
