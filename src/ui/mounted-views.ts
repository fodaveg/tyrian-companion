import type { TyrianViewRegistration } from '../host/tyrian-host';

/** A view controller as the host drives it: opened when mounted, closed when unmounted. */
export interface MountableView {
	onOpen(): Promise<void>;
	onClose(): Promise<void>;
}

/** Everything a `TyrianViewRegistration` says about a view except how to mount it. */
export type TyrianViewDescriptor = Omit<TyrianViewRegistration, 'mount' | 'unmount'>;

/**
 * The controllers the host has mounted for ONE view type, one per container it gave (in Obsidian,
 * one per open leaf of that type). `registration` turns a descriptor into what
 * `TyrianUiPort.registerView` takes; `current()` is what `main.ts` repaints, where it used to walk
 * `workspace.getLeavesOfType(type)` and pick out its own `ItemView` subclass.
 */
export class MountedViews<T extends MountableView> {
	private readonly byContainer = new Map<HTMLElement, T>();

	constructor(private readonly create: (container: HTMLElement) => T) {}

	registration(view: TyrianViewDescriptor): TyrianViewRegistration {
		return {
			type: view.type,
			title: () => view.title(),
			icon: view.icon,
			...(view.placement === undefined ? {} : { placement: view.placement }),
			mount: async (container) => {
				const controller = this.create(container);
				this.byContainer.set(container, controller);
				await controller.onOpen();
			},
			unmount: async (container) => {
				const controller = this.byContainer.get(container);
				if (controller === undefined) return;
				this.byContainer.delete(container);
				await controller.onClose();
			},
		};
	}

	/** The controllers mounted right now, in mount order. */
	current(): T[] {
		return [...this.byContainer.values()];
	}
}
