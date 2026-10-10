import { MAX_DECLARED_BUILD_LABEL_LENGTH, readFarmingDeclaredBuild, type FarmingDeclaredBuildPreferenceV1 } from '../sessions/manual-build-model';
import { MAX_BUILD_TEMPLATE_CODE_LENGTH } from '../sessions/build-template-parser';

export interface FarmingDeclaredBuildActions {
	getLocale(): 'es' | 'en';
	getFarmingDeclaredBuildPreference(): unknown;
	saveFarmingDeclaredBuildPreference(value: FarmingDeclaredBuildPreferenceV1 | null): Promise<void>;
}
const COPY = {
	es: { title: 'Build de la próxima tanda (declarada)', code: 'Pegar plantilla de GW2 [&…]', label: 'Etiqueta opcional', save: 'Guardar declaración',
		limit: 'Plantilla manual de la próxima tanda. No verifica la build activa ni el equipo; guardar no cambia una tanda abierta.',
		empty: 'Sin build declarada; la próxima tanda conservará identidad desconocida.', invalid: 'La declaración no es válida. El texto se conserva; la próxima tanda tendrá build desconocida.',
		unsupported: 'Esta plantilla aún no se puede interpretar. El texto se conserva; la próxima tanda tendrá build desconocida.',
		valid: 'Plantilla manual', saving: 'Guardando…', saved: 'Declaración guardada para la próxima tanda.', failed: 'No se pudo guardar. El borrador se conserva; vuelve a intentarlo.',
		malformed: 'La declaración guardada no se pudo interpretar. Se conserva íntegra hasta que guardes un reemplazo.' },
	en: { title: 'Next-session build (declared)', code: 'Paste a GW2 template [&…]', label: 'Optional label', save: 'Save declaration',
		limit: 'Manual template for the next session. It does not verify the active build or equipment; saving does not change an open session.',
		empty: 'No declared build; the next session will retain unknown identity.', invalid: 'The declaration is invalid. Your text is kept; the next session will have an unknown build.',
		unsupported: 'This template cannot be interpreted yet. Your text is kept; the next session will have an unknown build.',
		valid: 'Manual template', saving: 'Saving…', saved: 'Declaration saved for the next session.', failed: 'Could not save. Your draft is kept; try again.',
		malformed: 'The saved declaration could not be interpreted. It is kept intact until you save a replacement.' },
} as const;

/** An independent raw draft survives invalid/unsupported input and never edits captured active metadata. */
export class FarmingDeclaredBuildEditor {
	readonly element: HTMLFieldSetElement;
	private readonly code: HTMLTextAreaElement;
	private readonly label: HTMLInputElement;
	private readonly preview: HTMLElement;
	private readonly feedback: HTMLElement;
	private readonly saveButton: HTMLButtonElement;
	private loaded: unknown;
	private dirty = false;
	private working = false;

	constructor(document: Document, private readonly actions: FarmingDeclaredBuildActions) {
		const copy = COPY[actions.getLocale()];
		// The root has no parent yet (the caller places it), so only it comes from `document`.
		this.element = document.createElement('fieldset'); this.element.className = 'tyrian-farming__editor tyrian-declared-build';
		this.element.createEl('legend', { text: copy.title });
		this.element.createEl('p', { text: copy.limit });
		const codeLabel = this.element.createEl('label', { text: copy.code });
		this.code = codeLabel.createEl('textarea'); this.code.rows = 2; this.code.maxLength = MAX_BUILD_TEMPLATE_CODE_LENGTH;
		const label = this.element.createEl('label', { text: copy.label });
		this.label = label.createEl('input', { type: 'text' }); this.label.maxLength = MAX_DECLARED_BUILD_LABEL_LENGTH;
		this.preview = this.element.createEl('p', { attr: { role: 'status' } });
		this.saveButton = this.element.createEl('button', { text: copy.save, attr: { type: 'button' } });
		this.feedback = this.element.createEl('p', { attr: { role: 'status' } });
		this.code.addEventListener('input', () => { this.dirty = true; this.renderPreview(); });
		this.label.addEventListener('input', () => { this.dirty = true; this.renderPreview(); });
		this.saveButton.addEventListener('click', () => { void this.save(); });
		this.refresh();
	}
	refresh(): void {
		const saved = this.actions.getFarmingDeclaredBuildPreference();
		if (this.dirty || this.working || saved === this.loaded && this.loaded !== undefined) return;
		this.loaded = saved;
		const fields = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved as Record<string, unknown> : null;
		this.code.value = typeof fields?.templateCode === 'string' ? fields.templateCode : '';
		this.label.value = typeof fields?.label === 'string' ? fields.label : '';
		const result = readFarmingDeclaredBuild(saved);
		if (result.status === 'invalid' && result.reason === 'invalid_preference') {
			this.preview.setAttribute('role', 'alert'); this.preview.textContent = COPY[this.actions.getLocale()].malformed;
		} else this.renderPreview();
	}
	private preference(): FarmingDeclaredBuildPreferenceV1 | null {
		return this.code.value.trim() === '' && this.label.value.trim() === '' ? null
			: { version: 1, templateCode: this.code.value, label: this.label.value.trim() === '' ? null : this.label.value };
	}
	private renderPreview(): void {
		const result = readFarmingDeclaredBuild(this.preference()); const copy = COPY[this.actions.getLocale()];
		this.preview.setAttribute('role', result.status === 'invalid' || result.status === 'unsupported' ? 'alert' : 'status');
		this.preview.textContent = result.status === 'valid' ? `${result.value.configuration.profession} · ${copy.valid}` : copy[result.status];
	}
	private async save(): Promise<void> {
		if (this.working) return;
		this.working = true; this.code.disabled = true; this.label.disabled = true;
		this.saveButton.setAttribute('aria-disabled', 'true'); this.saveButton.setAttribute('aria-busy', 'true');
		this.saveButton.textContent = COPY[this.actions.getLocale()].saving; this.feedback.textContent = '';
		try {
			await this.actions.saveFarmingDeclaredBuildPreference(this.preference()); this.dirty = false;
			this.loaded = this.actions.getFarmingDeclaredBuildPreference();
			this.feedback.setAttribute('role', 'status'); this.feedback.textContent = COPY[this.actions.getLocale()].saved;
		} catch { this.feedback.setAttribute('role', 'alert'); this.feedback.textContent = COPY[this.actions.getLocale()].failed; }
		finally {
			this.working = false; this.code.disabled = false; this.label.disabled = false;
			this.saveButton.setAttribute('aria-disabled', 'false'); this.saveButton.setAttribute('aria-busy', 'false');
			this.saveButton.textContent = COPY[this.actions.getLocale()].save;
		}
	}
}
