// @vitest-environment happy-dom
import { createFakePluginApi } from 'hebra-plugin-api/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDomHelpers } from '../dom-polyfill';
import type { TyrianUnadoptedNote } from './path-index';
import { mountUnadoptedNotesPanel, registerUnadoptedNotes, UNADOPTED_PANEL_MAX_ROWS, unadoptedReasonText } from './unadopted-panel';

// Ported from Hebra's `src/lib/modules/tyrian/unadopted-panel.test.ts`, registering on `api.ui`
// (the package's fake records the panels) instead of Hebra's `ModuleHostRegistry`.

const duplicate: TyrianUnadoptedNote = {
	id: 'n-dup', title: 'Ectoplasma', family: 'inventory', reason: 'path_taken', candidates: ['Inventory/Positions/19721-b-account.md'],
};
const broken: TyrianUnadoptedNote = { id: 'n-broken', title: '', family: 'wallet', reason: 'invalid_marker', candidates: [] };

// The panel is built with Obsidian's DOM helpers, which the plugin installs on activation.
installDomHelpers();

afterEach(() => {
	document.body.replaceChildren();
});

describe('mountUnadoptedNotesPanel', () => {
	it('paints the summary and one row per note with its reason; "Abrir" opens the note', async () => {
		const el = createDiv();
		document.body.append(el);
		const openNote = vi.fn();
		const unmount = mountUnadoptedNotesPanel(el, { notes: [duplicate, broken], outputFolder: 'Juegos/GW2', openNote, report: vi.fn() });
		const rows = Array.from(el.querySelectorAll('.setting-item'));
		expect(rows).toHaveLength(3);
		expect(rows[0]?.querySelector('.setting-item-name')?.textContent).toBe('Notas no adoptadas');
		expect(rows[0]?.querySelector('.setting-item-description')?.textContent).toContain('2 notas de «Juegos/GW2» no están asociadas a Tyrian');
		expect(rows[1]?.querySelector('.setting-item-name')?.textContent).toBe('Ectoplasma');
		expect(rows[1]?.querySelector('.setting-item-description')?.textContent).toBe(unadoptedReasonText(duplicate));
		expect(rows[2]?.querySelector('.setting-item-name')?.textContent).toBe('Sin título');
		const open = rows[1]?.querySelector('button');
		expect(open?.getAttribute('aria-label')).toBe('Abrir «Ectoplasma»');
		open?.click();
		await vi.waitFor(() => expect(openNote).toHaveBeenCalledWith('n-dup'));
		unmount();
		expect(el.children).toHaveLength(0);
	});

	it(`with more than ${String(UNADOPTED_PANEL_MAX_ROWS)} it says how many are left instead of painting them all`, () => {
		const el = createDiv();
		const notes = Array.from({ length: UNADOPTED_PANEL_MAX_ROWS + 7 }, (_, i) => ({ ...broken, id: `n-${String(i)}`, title: `Note ${String(i)}` }));
		mountUnadoptedNotesPanel(el, { notes, outputFolder: 'Tyrian Companion', openNote: vi.fn(), report: vi.fn() });
		expect(el.querySelectorAll('button')).toHaveLength(UNADOPTED_PANEL_MAX_ROWS);
		expect(el.textContent).toContain('Y 7 más');
	});

	it('the reason names the family and, when another note holds its path, the path', () => {
		expect(unadoptedReasonText(duplicate)).toBe('Nota de inventario: otra nota ya ocupa su ruta («Inventory/Positions/19721-b-account.md»). Probablemente es un duplicado.');
		expect(unadoptedReasonText(broken)).toBe('Nota de monedero con un marcador de Tyrian que no se reconoce: Tyrian no la lee.');
	});
});

describe('registerUnadoptedNotes', () => {
	it('without notes it registers nothing and gives no notice', () => {
		const fake = createFakePluginApi({ id: 'tyrian-companion' });
		registerUnadoptedNotes(fake.api.ui, { notes: [], outputFolder: 'Tyrian Companion', seededNow: true, openNote: vi.fn(), report: vi.fn() });
		expect(fake.recorded.settingsPanels).toHaveLength(0);
		expect(fake.recorded.notices).toEqual([]);
	});

	it('with notes: one panel of the plugin; a notice only when seeding happened now, which opens the settings', () => {
		const fake = createFakePluginApi({ id: 'tyrian-companion' });
		const openSettings = vi.spyOn(fake.api.ui, 'openSettings');
		const notice = vi.spyOn(fake.api.ui, 'notice');
		const unregister = registerUnadoptedNotes(fake.api.ui, { notes: [duplicate], outputFolder: 'Tyrian Companion', seededNow: false, openNote: vi.fn(), report: vi.fn() });
		expect(fake.recorded.settingsPanels).toHaveLength(1);
		expect(notice).not.toHaveBeenCalled();
		registerUnadoptedNotes(fake.api.ui, { notes: [duplicate, broken], outputFolder: 'Tyrian Companion', seededNow: true, openNote: vi.fn(), report: vi.fn() });
		expect(notice).toHaveBeenCalledTimes(1);
		const [text, onClick] = notice.mock.calls[0] ?? [];
		expect(text).toBe('Tyrian Companion: 2 notas no se han adoptado. Míralas en los ajustes de Tyrian Companion.');
		onClick?.();
		expect(openSettings).toHaveBeenCalledTimes(1);
		unregister();
		expect(fake.recorded.settingsPanels).toHaveLength(1);
	});
});
