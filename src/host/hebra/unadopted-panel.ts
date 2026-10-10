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

import type { Translator, TranslationKey } from '../../core/i18n';
import type { TyrianNoteFamily, TyrianUnadoptedNote } from './path-index';
import { createButtonControl, formatCount, type HebraTranslator } from './setting-row';

/** More rows than this do not help a manual review: how many are left is said instead. */
export const UNADOPTED_PANEL_MAX_ROWS = 50;

const FAMILY_LABEL: Readonly<Record<TyrianNoteFamily, TranslationKey>> = {
	inventory: 'hebra.unadopted.family.inventory',
	wallet: 'hebra.unadopted.family.wallet',
	session: 'hebra.unadopted.family.session',
	collector_status: 'hebra.unadopted.family.collector_status',
	other: 'hebra.unadopted.family.other',
};

/** Why the note was not adopted, in one sentence. */
export function unadoptedReasonText(note: TyrianUnadoptedNote, translator: Translator): string {
	const family = translator.t(FAMILY_LABEL[note.family]);
	if (note.reason === 'path_taken') {
		return translator.t('hebra.unadopted.reason.path_taken', { family, path: note.candidates[0] ?? '' });
	}
	return translator.t('hebra.unadopted.reason.unknown', { family });
}

export function unadoptedSummaryText(count: number, outputFolder: string, translator: Translator): string {
	return translator.t(count === 1 ? 'hebra.unadopted.summary.one' : 'hebra.unadopted.summary.many', {
		count: formatCount(translator, count), folder: outputFolder,
	});
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
	/** The active language, read on every paint. */
	translator: HebraTranslator;
	notes: readonly TyrianUnadoptedNote[];
	outputFolder: string;
	openNote: (id: string) => void;
	/** A failing "open" button: the host's diagnostics. */
	report: (error: unknown) => void;
}

/** Paints the list into `el` (the panel's slot). Returns its cleanup. */
export function mountUnadoptedNotesPanel(el: HTMLElement, options: UnadoptedPanelOptions): () => void {
	const translator = options.translator();
	const section = createEl('section');
	section.className = 'hebra-tyrian-unadopted';
	section.setAttribute('aria-label', translator.t('hebra.unadopted.title'));
	settingItem(section, translator.t('hebra.unadopted.title'), unadoptedSummaryText(options.notes.length, options.outputFolder, translator));
	// Cuts an ARRAY of notes, not a text: it cannot split a surrogate pair.
	for (const note of options.notes.slice(0, UNADOPTED_PANEL_MAX_ROWS)) {
		const title = note.title.trim() || translator.t('hebra.unadopted.untitled');
		const { controlEl } = settingItem(section, title, unadoptedReasonText(note, translator));
		const button = createButtonControl(options.report)
			.setButtonText(translator.t('hebra.unadopted.open'))
			.onClick(() => options.openNote(note.id));
		button.buttonEl.setAttribute('aria-label', translator.t('hebra.unadopted.openAria', { title }));
		controlEl.append(button.buttonEl);
	}
	const rest = options.notes.length - UNADOPTED_PANEL_MAX_ROWS;
	if (rest > 0) settingItem(section, translator.t('hebra.unadopted.more', { count: formatCount(translator, rest) }), translator.t('hebra.unadopted.moreHint'));
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
		const translator = options.translator();
		ui.notice(
			translator.t(count === 1 ? 'hebra.unadopted.notice.one' : 'hebra.unadopted.notice.many', { count: formatCount(translator, count) }),
			() => ui.openSettings(),
		);
	}
	return unregister;
}
