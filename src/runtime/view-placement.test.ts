import { describe, expect, it } from 'vitest';

import type { TyrianLocalStoragePort } from '../host/tyrian-host';
import {
	DEFAULT_VIEW_PLACEMENT,
	VIEW_PLACEMENT_KEY,
	loadViewPlacement,
	readViewPlacement,
	saveViewPlacement,
} from './view-placement';

/** A device's local storage as a host keeps it: by key, null for what was never stored. */
function deviceStorage(initial: Record<string, unknown> = {}): TyrianLocalStoragePort & { readonly values: Map<string, unknown> } {
	const values = new Map<string, unknown>(Object.entries(initial));
	return {
		values,
		load: (key) => values.get(key) ?? null,
		save: (key, value) => {
			if (value === null) values.delete(key);
			else values.set(key, value);
		},
	};
}

describe('where this device shows the plugin', () => {
	it('is the main screen by default', () => {
		expect(DEFAULT_VIEW_PLACEMENT).toBe('main');
		expect(loadViewPlacement(deviceStorage())).toBe('main');
	});

	it('reads back the two values it knows', () => {
		expect(readViewPlacement('main')).toBe('main');
		expect(readViewPlacement('sidebar')).toBe('sidebar');
	});

	it.each([
		['nothing stored', null],
		['undefined', undefined],
		['a value another build wrote', 'floating'],
		['the right word in the wrong case', 'Sidebar'],
		['an empty string', ''],
		['a number', 1],
		['a boolean', true],
		['an object', { placement: 'sidebar' }],
		['an array', ['sidebar']],
	])('falls back to the default on %s', (_label, stored) => {
		expect(readViewPlacement(stored)).toBe(DEFAULT_VIEW_PLACEMENT);
		expect(loadViewPlacement(deviceStorage({ [VIEW_PLACEMENT_KEY]: stored }))).toBe(DEFAULT_VIEW_PLACEMENT);
	});

	it('saves the choice under its own key of the device storage and loads it back', () => {
		const storage = deviceStorage({ 'tyrian-companion:ingame-session-link': { sessionId: 'a' } });

		saveViewPlacement(storage, 'sidebar');
		expect([...storage.values.keys()].sort()).toEqual(['tyrian-companion:ingame-session-link', VIEW_PLACEMENT_KEY]);
		expect(storage.values.get(VIEW_PLACEMENT_KEY)).toBe('sidebar');
		expect(loadViewPlacement(storage)).toBe('sidebar');

		saveViewPlacement(storage, 'main');
		expect(loadViewPlacement(storage)).toBe('main');
		// The other values of the device are not its to touch.
		expect(storage.values.get('tyrian-companion:ingame-session-link')).toEqual({ sessionId: 'a' });
	});

	it('keeps nothing, and the default, on a host without local storage', () => {
		expect(() => { saveViewPlacement(undefined, 'sidebar'); }).not.toThrow();
		expect(loadViewPlacement(undefined)).toBe('main');
	});
});
