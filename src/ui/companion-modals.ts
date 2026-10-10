/**
 * The companion view's modals: the session confirmations (discard, discard unreadable, save and
 * clear, abandon, discard a stuck live session) and the detection correction. Moved out of
 * `companion-view.ts` unchanged (DE-07, audit 10 oct 2026); the view and the core open them.
 */
import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import {
	DETECTION_CORRECTION_CAUSES,
	type DetectionCorrectionCause,
	type DetectionDecisionCause,
} from '../sessions/session-detection-quality';
import { TyrianModal, type TyrianModalUi } from './tyrian-modal';

export class ConfirmDiscardSessionModal extends TyrianModal {
	constructor(
		ui: TyrianModalUi,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(ui);
	}

	override onClose(): void {
		this.onClosed();
	}

	protected override title(): string {
		return runtimeText(this.getLocale(), 'modal.discardTitle');
	}

	onOpen(): void {
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.discardDetail'),
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.discard'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		discard.addEventListener('click', () => {
			discard.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}
}

/**
 * The discard confirmation for a saved session whose recovery evidence could not even be read
 * (`SessionRecoveryState.status === 'error'`). It says plainly that nothing can be recovered from
 * it and that discarding erases it, instead of reusing `ConfirmDiscardSessionModal`'s copy, which
 * implies a readable, resumable session is being given up.
 */
export class ConfirmDiscardUnreadableSessionModal extends TyrianModal {
	constructor(
		ui: TyrianModalUi,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(ui);
	}

	override onClose(): void {
		this.onClosed();
	}

	protected override title(): string {
		return runtimeText(this.getLocale(), 'modal.discardUnreadableTitle');
	}

	onOpen(): void {
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.discardUnreadableDetail'),
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.discard'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		discard.addEventListener('click', () => {
			discard.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}
}

export class ConfirmClearCompletedSessionModal extends TyrianModal {
	constructor(
		ui: TyrianModalUi,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(ui);
	}

	protected override title(): string {
		return runtimeText(this.getLocale(), 'modal.clearTitle');
	}

	onOpen(): void {
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.clearDetail'),
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const clear = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.saveAndClear'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		clear.addEventListener('click', () => {
			clear.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}

	override onClose(): void {
		this.onClosed();
	}
}

/**
 * Confirms abandoning a session whose stop cannot finish (David, 2026-09-24). Same shape as the
 * discard and clear confirmations: keeping the session is the focused, default choice, and closing
 * the modal any other way does nothing.
 */
export class ConfirmAbandonSessionModal extends TyrianModal {
	constructor(
		ui: TyrianModalUi,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(ui);
	}

	protected override title(): string {
		return runtimeText(this.getLocale(), 'modal.abandonTitle');
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: runtimeText(this.getLocale(), 'modal.abandonDetail') });
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const abandon = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.abandonConfirm'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		abandon.addEventListener('click', () => {
			abandon.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}

	override onClose(): void {
		this.onClosed();
	}
}

/** «Descartar la sesión atascada»: says what is lost and what is not before anything is deleted. Cancel has the focus. */
export class ConfirmDiscardLiveSessionModal extends TyrianModal {
	constructor(
		ui: TyrianModalUi,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(ui);
	}

	protected override title(): string {
		return runtimeText(this.getLocale(), 'modal.discardLiveTitle');
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: runtimeText(this.getLocale(), 'modal.discardLiveDetail') });
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.discardLiveConfirm'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		discard.addEventListener('click', () => {
			discard.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}

	override onClose(): void {
		this.onClosed();
	}
}

export class DetectionCorrectionModal extends TyrianModal {
	constructor(
		ui: TyrianModalUi,
		private readonly phase: 'start' | 'stop',
		private readonly onConfirm: (cause: DetectionCorrectionCause, humanBoundaryAt: string | null) => Promise<void>,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(ui);
	}

	protected override title(): string {
		return runtimeText(this.getLocale(), this.phase === 'start' ? 'modal.correctionStartTitle' : 'modal.correctionStopTitle');
	}

	onOpen(): void {
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.correctionDetail'),
		});
		const form = this.contentEl.createEl('form', { cls: 'tyrian-companion-quality-correction' });
		const fieldset = form.createEl('fieldset');
		fieldset.createEl('legend', { text: runtimeText(this.getLocale(), 'modal.correctionCause') });
		const allowed = correctionCauses(this.phase);
		const inputs = allowed.map((cause, index) => ({
			cause,
			input: radioOption(
				fieldset,
				'detection-correction-cause',
				cause,
				detectionCauseLabel(cause, this.getLocale()),
				index === 0,
			),
		}));
		const error = form.createEl('p', { cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		const boundary = pilotBoundaryInput(form, this.getLocale());
		const actions = form.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepProposal'), type: 'button' });
		const submit = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.saveAndDismiss'), type: 'submit', cls: 'mod-cta' });
		cancel.addEventListener('click', () => this.close());
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const selected = inputs.find(({ input }) => input.checked)?.cause;
			if (!selected) {
				error.setText(runtimeText(this.getLocale(), 'modal.chooseCause'));
				return;
			}
			submit.disabled = true;
			cancel.disabled = true;
			error.setText('');
			const humanBoundaryAt = parsePilotBoundary(boundary.value);
			if (boundary.value.length > 0 && humanBoundaryAt === null) {
				error.setText(runtimeText(this.getLocale(), 'modal.pilotBoundaryInvalid'));
				submit.disabled = false;
				cancel.disabled = false;
				return;
			}
			void this.onConfirm(selected, humanBoundaryAt).then(() => this.close()).catch(() => {
				error.setText(runtimeText(this.getLocale(), 'modal.dismissFailed'));
				submit.disabled = false;
				cancel.disabled = false;
			});
		});
		inputs[0]?.input.focus();
	}
}

function pilotBoundaryInput(container: HTMLElement, locale: Locale): HTMLInputElement {
	const label = container.createEl('label', { text: runtimeText(locale, 'modal.pilotBoundaryLabel') });
	const input = label.createEl('input');
	input.type = 'datetime-local';
	input.step = '1';
	container.createEl('p', { text: runtimeText(locale, 'modal.pilotBoundaryOptional') });
	return input;
}

function parsePilotBoundary(value: string): string | null {
	if (value.length === 0) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** A runtime catalog string in `locale`; the only source of the view's and the modals' copy. */
export function runtimeText(
	locale: Locale,
	key: RuntimeTranslationKey,
	params?: Record<string, string | number>,
): string {
	return translateRuntime(createTranslator(locale), key, params);
}

function radioOption(
	container: HTMLElement,
	name: string,
	value: string,
	text: string,
	checked: boolean,
): HTMLInputElement {
	const label = container.createEl('label');
	const input = label.createEl('input', { type: 'radio', attr: { name, value } });
	input.checked = checked;
	label.appendText(text);
	return input;
}

function correctionCauses(phase: 'start' | 'stop'): DetectionCorrectionCause[] {
	const allowed: DetectionCorrectionCause[] = phase === 'start'
		? ['not_farming', 'unrelated_account_activity', 'other']
		: ['still_farming', 'temporary_pause', 'unrelated_account_activity', 'other'];
	return allowed.filter((cause) => DETECTION_CORRECTION_CAUSES.includes(cause));
}

function detectionCauseLabel(cause: DetectionDecisionCause, locale: Locale): string {
	const labels: Record<DetectionDecisionCause, RuntimeTranslationKey> = {
		manual_start: 'detection.cause.manual_start', manual_stop: 'detection.cause.manual_stop',
		relevant_item_gain: 'detection.cause.relevant_item_gain', inactivity: 'detection.cause.inactivity',
		not_farming: 'detection.cause.not_farming', still_farming: 'detection.cause.still_farming',
		temporary_pause: 'detection.cause.temporary_pause', unrelated_account_activity: 'detection.cause.unrelated_account_activity',
		other: 'detection.cause.other',
	};
	return runtimeText(locale, labels[cause]);
}
