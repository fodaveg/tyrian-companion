/**
 * The VISIBLE list of Tyrian notes the path→id index left out (SPEC-TYRIAN-EN-HEBRA.md §3: "any
 * other ambiguity leaves the note in a visible list of unadopted notes: never duplicated nor
 * overwritten").
 *
 * Where: in the plugin's settings, as one more panel under Tyrian's (`ui.settingsPanel`), which is
 * where Hebra shows each plugin's things and where its output folder is chosen; a notice goes away
 * on its own and the status bar would be permanent noise. It only appears when there is one, and is
 * registered AFTER the core's panel so "link key" (`openSettings`) still leads to Tyrian's first.
 *
 * The rows use the same classes as `ui.setting` (`setting-row.ts`), so they look like the rest of
 * the panel without CSS of their own.
 */
import type { PluginUi, PluginUnregister } from 'hebra-plugin-api';

import type { TyrianNoteFamily, TyrianUnadoptedNote } from './path-index';
import { createButtonControl } from './setting-row';

/** More rows than this do not help a manual review: how many are left is said instead. */
export const UNADOPTED_PANEL_MAX_ROWS = 50;

const FAMILY_LABEL: Readonly<Record<TyrianNoteFamily, string>> = {
	inventory: 'inventario',
	wallet: 'monedero',
	session: 'sesión',
	collector_status: 'estado del recolector',
	other: 'otra familia',
};

/** Why the note was not adopted, in one sentence. */
export function unadoptedReasonText(note: TyrianUnadoptedNote): string {
	const family = FAMILY_LABEL[note.family];
	if (note.reason === 'path_taken') {
		const path = note.candidates[0] ?? '';
		return `Nota de ${family}: otra nota ya ocupa su ruta («${path}»). Probablemente es un duplicado.`;
	}
	return `Nota de ${family} con un marcador de Tyrian que no se reconoce: Tyrian no la lee.`;
}

export function unadoptedSummaryText(count: number, outputFolder: string): string {
	const notes = count === 1 ? '1 nota' : `${count.toLocaleString('es-ES')} notas`;
	return `${notes} de «${outputFolder}» no ${count === 1 ? 'está asociada' : 'están asociadas'} a Tyrian. Hebra no las toca: ni las duplica ni las sobrescribe, y Tyrian no las ve. Revísalas a mano.`;
}

function settingItem(container: HTMLElement, name: string, description: string): { controlEl: HTMLElement } {
	const settingEl = createDiv();
	settingEl.className = 'setting-item hebra-module-setting';
	const info = createDiv();
	info.className = 'setting-item-info';
	const nameEl = createDiv();
	nameEl.className = 'setting-item-name';
	nameEl.textContent = name;
	const descEl = createDiv();
	descEl.className = 'setting-item-description';
	descEl.textContent = description;
	info.append(nameEl, descEl);
	const controlEl = createDiv();
	controlEl.className = 'setting-item-control';
	settingEl.append(info, controlEl);
	container.append(settingEl);
	return { controlEl };
}

export interface UnadoptedPanelOptions {
	notes: readonly TyrianUnadoptedNote[];
	outputFolder: string;
	openNote: (id: string) => void;
	/** A failing "open" button: the host's diagnostics. */
	report: (error: unknown) => void;
}

/** Paints the list into `el` (the panel's slot). Returns its cleanup. */
export function mountUnadoptedNotesPanel(el: HTMLElement, options: UnadoptedPanelOptions): () => void {
	const section = createEl('section');
	section.className = 'hebra-tyrian-unadopted';
	section.setAttribute('aria-label', 'Notas no adoptadas');
	settingItem(section, 'Notas no adoptadas', unadoptedSummaryText(options.notes.length, options.outputFolder));
	// Cuts an ARRAY of notes, not a text: it cannot split a surrogate pair.
	for (const note of options.notes.slice(0, UNADOPTED_PANEL_MAX_ROWS)) {
		const title = note.title.trim() || 'Sin título';
		const { controlEl } = settingItem(section, title, unadoptedReasonText(note));
		const button = createButtonControl(options.report)
			.setButtonText('Abrir')
			.onClick(() => options.openNote(note.id));
		button.buttonEl.setAttribute('aria-label', `Abrir «${title}»`);
		controlEl.append(button.buttonEl);
	}
	const rest = options.notes.length - UNADOPTED_PANEL_MAX_ROWS;
	if (rest > 0) settingItem(section, `Y ${rest.toLocaleString('es-ES')} más`, 'Revisa primero estas.');
	el.append(section);
	return () => section.remove();
}

/**
 * Registers the panel (when there is any note) and, when seeding found them NOW, gives one notice
 * that leads to the plugin's settings. Returns how to remove it; turning the plugin off removes it
 * too (Hebra undoes every registration).
 */
export function registerUnadoptedNotes(
	ui: Pick<PluginUi, 'settingsPanel' | 'notice' | 'openSettings'>,
	options: UnadoptedPanelOptions & { seededNow: boolean },
): PluginUnregister {
	if (options.notes.length === 0) return () => undefined;
	const unregister = ui.settingsPanel((el) => mountUnadoptedNotesPanel(el, options));
	if (options.seededNow) {
		const count = options.notes.length;
		ui.notice(
			`Tyrian Companion: ${count === 1 ? '1 nota no se ha adoptado' : `${count.toLocaleString('es-ES')} notas no se han adoptado`}. Míralas en los ajustes de Tyrian Companion.`,
			() => ui.openSettings(),
		);
	}
	return unregister;
}
