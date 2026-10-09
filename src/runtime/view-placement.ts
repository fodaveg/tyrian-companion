import type { TyrianLocalStoragePort } from '../host/tyrian-host';

/**
 * Where THIS device shows the plugin, in a host that can do both (`capabilities.mainView`): on its
 * main screen or in its sidebar. The device's choice, like the collector mode, so it lives in the
 * host's local storage (`host.localStorage`; in Hebra, `api.storage.device`) and never in the
 * synced settings: two devices on one library each keep their own.
 */
export type ViewPlacement = 'main' | 'sidebar';

/** David: «por defecto se verá en la principal». */
export const DEFAULT_VIEW_PLACEMENT: ViewPlacement = 'main';

/** Key of the choice in `TyrianLocalStoragePort`. */
export const VIEW_PLACEMENT_KEY = 'tyrian-companion:view-placement';

/**
 * Strict reload boundary. Anything but the two known values reads as the default: nothing stored
 * yet, a value some other build wrote, a corrupt one.
 */
export function readViewPlacement(value: unknown): ViewPlacement {
	return value === 'main' || value === 'sidebar' ? value : DEFAULT_VIEW_PLACEMENT;
}

/** The stored choice; the default for a host that keeps no local storage. */
export function loadViewPlacement(storage: TyrianLocalStoragePort | undefined): ViewPlacement {
	return readViewPlacement(storage?.load(VIEW_PLACEMENT_KEY));
}

/** Stores the choice. A host that keeps no local storage keeps none, like the in-game session link. */
export function saveViewPlacement(storage: TyrianLocalStoragePort | undefined, placement: ViewPlacement): void {
	storage?.save(VIEW_PLACEMENT_KEY, placement);
}
