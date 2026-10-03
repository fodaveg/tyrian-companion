/**
 * `ui.setting(container)` and `ui.secretPicker` of HebraHost (R1c): the part of Obsidian's
 * `Setting` and of its controls (`TextComponent`, `DropdownComponent`, `ToggleComponent`,
 * `ButtonComponent`, `SecretComponent`) that `ui/settings-tab.ts` and
 * `ui/manual-session-start-modal.ts` use, in plain DOM (never `innerHTML`: Trusted Types) with the
 * look of Hebra's settings rows.
 *
 * The classes are Obsidian's (`setting-item`, `setting-item-info`, `setting-item-name`,
 * `setting-item-description`, `setting-item-control`, `mod-cta`, `checkbox-container`/`is-enabled`)
 * because the core LOOKS for them (settings-tab finds `.setting-item-description` for its "saved"
 * line) and `styles.css` hangs from them; `tyrian-host.css` maps them to Hebra's tokens. Each call
 * returns the same row or control, so they chain as in Obsidian.
 */
import type { PluginUi } from 'hebra-plugin-api';

import type {
	TyrianButtonControl,
	TyrianDropdownControl,
	TyrianSecretControl,
	TyrianSecretsPort,
	TyrianSettingRow,
	TyrianTextControl,
	TyrianToggleControl,
} from '../tyrian-host';

export type ErrorReporter = (error: unknown) => void;

export interface SettingRowDeps {
	/** For `addSecret`: the list of names and saving a new one. */
	secrets: TyrianSecretsPort;
	/** For `addSecret`: the "new secret" dialog. */
	host: Pick<PluginUi, 'openModal'>;
	/** A control callback of the core that fails: the host's diagnostics. */
	report: ErrorReporter;
}

let idSeq = 0;
const nextId = (prefix: string): string => `hebra-tyrian-${prefix}-${String(++idSeq)}`;

/** A core callback that returns a promise cannot break the control when it fails. */
function fire<T>(callback: ((value: T) => unknown) | undefined, value: T, report: ErrorReporter): void {
	if (!callback) return;
	void Promise.resolve()
		.then(() => callback(value))
		.catch((error: unknown) => report(error));
}

export function createSettingRow(container: HTMLElement, deps: SettingRowDeps): TyrianSettingRow {
	const settingEl = createDiv();
	settingEl.className = 'setting-item hebra-module-setting';
	const info = createDiv();
	info.className = 'setting-item-info';
	const nameEl = createDiv();
	nameEl.className = 'setting-item-name';
	nameEl.id = nextId('setting-name');
	const descEl = createDiv();
	descEl.className = 'setting-item-description';
	info.append(nameEl, descEl);
	const controlEl = createDiv();
	controlEl.className = 'setting-item-control';
	settingEl.append(info, controlEl);
	container.append(settingEl);

	/** The controls' accessible name: the row's, when it has one. */
	const label = (el: HTMLElement): void => el.setAttribute('aria-labelledby', nameEl.id);
	const { report } = deps;

	const row: TyrianSettingRow = {
		settingEl,
		descEl,
		controlEl,
		setName(name) {
			nameEl.textContent = name;
			return row;
		},
		setDesc(description) {
			descEl.textContent = description;
			return row;
		},
		setTooltip(tooltip) {
			nameEl.title = tooltip;
			return row;
		},
		addText(build) {
			const control = createTextControl(report);
			label(control.inputEl);
			controlEl.append(control.inputEl);
			build(control);
			return row;
		},
		addDropdown(build) {
			const control = createDropdownControl(report);
			label(control.selectEl);
			controlEl.append(control.selectEl);
			build(control);
			return row;
		},
		addToggle(build) {
			const control = createToggleControl(report);
			label(control.toggleEl);
			controlEl.append(control.toggleEl);
			build(control);
			return row;
		},
		addButton(build) {
			const control = createButtonControl(report);
			controlEl.append(control.buttonEl);
			build(control);
			return row;
		},
		addSecret(build) {
			build(createSecretControl(controlEl, deps, nameEl.id));
			return row;
		},
	};
	return row;
}

export function createTextControl(report: ErrorReporter): TyrianTextControl {
	const inputEl = createEl('input');
	inputEl.type = 'text';
	inputEl.className = 'hebra-module-setting-input';
	inputEl.spellcheck = false;
	let callback: ((value: string) => unknown) | undefined;
	inputEl.addEventListener('input', () => fire(callback, inputEl.value, report));
	const control: TyrianTextControl = {
		inputEl,
		setPlaceholder(placeholder) {
			inputEl.placeholder = placeholder;
			return control;
		},
		setValue(value) {
			inputEl.value = value;
			return control;
		},
		setDisabled(disabled) {
			inputEl.disabled = disabled;
			return control;
		},
		onChange(next) {
			callback = next;
			return control;
		},
	};
	return control;
}

export function createDropdownControl(report: ErrorReporter): TyrianDropdownControl {
	const selectEl = createEl('select');
	selectEl.className = 'dropdown hebra-module-setting-select';
	let callback: ((value: string) => unknown) | undefined;
	selectEl.addEventListener('change', () => fire(callback, selectEl.value, report));
	const control: TyrianDropdownControl = {
		selectEl,
		addOption(value, display) {
			const option = createEl('option');
			option.value = value;
			option.textContent = display;
			selectEl.append(option);
			return control;
		},
		setValue(value) {
			selectEl.value = value;
			return control;
		},
		setDisabled(disabled) {
			selectEl.disabled = disabled;
			return control;
		},
		onChange(next) {
			callback = next;
			return control;
		},
	};
	return control;
}

/** A switch (`role="switch"`), not a native checkbox: Obsidian's `toggleEl` is a container that
 *  takes the click, and the core only treats it as an `HTMLElement`. */
export function createToggleControl(report: ErrorReporter): TyrianToggleControl {
	const toggleEl = createEl('button');
	toggleEl.type = 'button';
	toggleEl.className = 'checkbox-container hebra-module-setting-toggle';
	toggleEl.setAttribute('role', 'switch');
	let on = false;
	let callback: ((value: boolean) => unknown) | undefined;
	const paint = (): void => {
		toggleEl.setAttribute('aria-checked', String(on));
		toggleEl.classList.toggle('is-enabled', on);
	};
	paint();
	toggleEl.addEventListener('click', () => {
		if (toggleEl.disabled) return;
		on = !on;
		paint();
		fire(callback, on, report);
	});
	const control: TyrianToggleControl = {
		toggleEl,
		setValue(value) {
			on = value;
			paint();
			return control;
		},
		setDisabled(disabled) {
			toggleEl.disabled = disabled;
			return control;
		},
		setTooltip(tooltip) {
			toggleEl.title = tooltip;
			return control;
		},
		onChange(next) {
			callback = next;
			return control;
		},
	};
	return control;
}

export function createButtonControl(report: ErrorReporter): TyrianButtonControl {
	const buttonEl = createEl('button');
	buttonEl.type = 'button';
	buttonEl.className = 'hebra-module-setting-button';
	const control: TyrianButtonControl = {
		buttonEl,
		setButtonText(text) {
			buttonEl.textContent = text;
			return control;
		},
		setCta() {
			buttonEl.classList.add('mod-cta');
			return control;
		},
		setDisabled(disabled) {
			buttonEl.disabled = disabled;
			return control;
		},
		onClick(callback) {
			buttonEl.addEventListener('click', (event) => fire(callback, event, report));
			return control;
		},
	};
	return control;
}

const NO_SECRET = '';

/**
 * `SecretComponent`: picks one of the plugin's named secrets or creates a new one (name + value,
 * in a dialog). The control's value is the NAME, never the secret: the value only travels from the
 * password box to `secrets.set`.
 */
export function createSecretControl(
	parent: HTMLElement,
	deps: SettingRowDeps,
	labelledBy?: string,
): TyrianSecretControl & { readonly selectEl: HTMLSelectElement } {
	const wrapper = createDiv();
	wrapper.className = 'hebra-module-setting-secret';
	const selectEl = createEl('select');
	selectEl.className = 'dropdown hebra-module-setting-select';
	if (labelledBy) selectEl.setAttribute('aria-labelledby', labelledBy);
	const create = createEl('button');
	create.type = 'button';
	create.className = 'hebra-module-setting-button';
	create.textContent = 'Nuevo secreto…';
	wrapper.append(selectEl, create);
	parent.append(wrapper);

	let value = NO_SECRET;
	let callback: ((name: string) => unknown) | undefined;
	const { report } = deps;

	const repaint = (): void => {
		const none = createEl('option');
		none.value = NO_SECRET;
		none.textContent = 'Ninguno';
		const options: HTMLOptionElement[] = [none];
		for (const name of new Set([...deps.secrets.list(), ...(value === NO_SECRET ? [] : [value])])) {
			const option = createEl('option');
			option.value = name;
			option.textContent = name;
			options.push(option);
		}
		selectEl.replaceChildren(...options);
		selectEl.value = value;
	};
	repaint();

	selectEl.addEventListener('change', () => {
		value = selectEl.value;
		fire(callback, value, report);
	});
	create.addEventListener('click', () => {
		openNewSecretDialog(deps, (name) => {
			value = name;
			repaint();
			fire(callback, value, report);
		});
	});

	const control = {
		selectEl,
		setValue(name: string) {
			value = name;
			repaint();
			return control;
		},
		onChange(next: (name: string) => unknown) {
			callback = next;
			return control;
		},
	};
	return control;
}

function openNewSecretDialog(deps: SettingRowDeps, onSaved: (name: string) => void): void {
	const handle = deps.host.openModal((content) => {
		content.classList.add('hebra-module-secret-dialog');
		const form = createEl('form');
		const nameInput = createEl('input');
		nameInput.type = 'text';
		nameInput.required = true;
		nameInput.className = 'hebra-module-setting-input';
		nameInput.setAttribute('aria-label', 'Nombre del secreto');
		nameInput.placeholder = 'Nombre';
		const valueInput = createEl('input');
		valueInput.type = 'password';
		valueInput.required = true;
		valueInput.autocomplete = 'off';
		valueInput.className = 'hebra-module-setting-input';
		valueInput.setAttribute('aria-label', 'Valor del secreto');
		valueInput.placeholder = 'Valor';
		const actions = createDiv();
		actions.className = 'hebra-module-setting-actions';
		const cancel = createEl('button');
		cancel.type = 'button';
		cancel.className = 'hebra-module-setting-button';
		cancel.textContent = 'Cancelar';
		cancel.addEventListener('click', () => handle.close());
		const save = createEl('button');
		save.type = 'submit';
		save.className = 'hebra-module-setting-button mod-cta';
		save.textContent = 'Guardar';
		actions.append(cancel, save);
		form.append(nameInput, valueInput, actions);
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const name = nameInput.value.trim();
			if (name.length === 0 || valueInput.value.length === 0) return;
			deps.secrets.set(name, valueInput.value);
			valueInput.value = '';
			handle.close();
			onSaved(name);
		});
		content.append(form);
		nameInput.focus();
	}, { title: 'Nuevo secreto' });
}
