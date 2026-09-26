import { setIcon } from 'obsidian';

/**
 * The 3-step "recorrido" (boceto `docs/diseno/h18-31-interfaz`, decisión A): a fixed 3-column list
 * that narrates an operation as done · in progress/failed · not reached yet, reused by the session
 * card's own cierre (`companion-view.ts`) and, later, by an aviso's own delivery path. Pure render,
 * no clock and no translator: every label and time is formatted by the caller.
 */

export type ReceiptStepStatus = 'done' | 'current' | 'failed' | 'skip';

export interface ReceiptStep {
	readonly status: ReceiptStepStatus;
	/** A Lucide icon id (`setIcon`'s own vocabulary), chosen by the caller per step, not derived
	 *  from `status`: a `skip` step can mean "not applicable" (`minus`) or "not reached yet"
	 *  (`circle-dashed`), and only the caller knows which. */
	readonly icon: string;
	readonly label: string;
	/** `time` for a real instant (`<time>`), `small` for a relative/qualitative note ("al cerrar"). */
	readonly detail?: { readonly kind: 'time' | 'small'; readonly text: string };
}

export function renderReceipt(container: HTMLElement, ariaLabel: string, steps: readonly ReceiptStep[]): HTMLElement {
	const list = container.createEl('ol', { cls: 'tyrian-receipt', attr: { 'aria-label': ariaLabel } });
	for (const step of steps) {
		const li = list.createEl('li');
		li.setAttr('data-step', step.status);
		const icon = li.createSpan({ cls: 'svg-icon is-small' });
		icon.setAttr('aria-hidden', 'true');
		setIcon(icon, step.icon);
		li.createSpan({ text: step.label });
		if (step.detail !== undefined) li.createEl(step.detail.kind, { text: step.detail.text });
	}
	return list;
}
