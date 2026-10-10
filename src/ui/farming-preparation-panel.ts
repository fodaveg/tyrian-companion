import {
	isFarmingPreparationSettings,
	projectFarmingManualReminder,
	type FarmingManualReminder,
	type FarmingPreparationContext,
	type FarmingPreparationSettingsV1,
	type FarmingReminderKind,
} from '../sessions/farming-goal-preparation';
import { farmingCopy, formatFarmingTime } from './farming-goal-copy';

export interface FarmingPreparationPanelPorts {
	settings(): FarmingPreparationSettingsV1;
	context(): FarmingPreparationContext;
	reminders(): readonly FarmingManualReminder[];
	now(): string;
	locale(): 'es' | 'en';
	save(settings: FarmingPreparationSettingsV1): Promise<void>;
	startReminder(kind: FarmingReminderKind, minutes: number): void;
	clearReminder(kind: FarmingReminderKind): void;
}

/** Optional, collapsed checklist. None of its controls gates session start or detects buffs. */
export class FarmingPreparationPanel {
	private busy = false;
	private reviewed = false;
	private rendered: { fieldset: HTMLFieldSetElement; feedback: HTMLElement } | null = null;
	private readOnly: {
		container: HTMLElement;
		facts: HTMLDListElement;
		reminders: Map<FarmingReminderKind, { status: HTMLElement; action: HTMLButtonElement }>;
	} | null = null;
	constructor(private readonly ports: FarmingPreparationPanelPorts) {}

	render(container: HTMLElement): void {
		const wasOpen = container.querySelector('details')?.open ?? false;
		container.replaceChildren();
		container.classList.add('tyrian-farming');
		const locale = this.ports.locale();
		const current = this.ports.settings();
		const details = container.createEl('details');
		details.open = wasOpen;
		details.createEl('summary', { text: farmingCopy(locale, 'preparation') });
		const fieldset = details.createEl('fieldset', { cls: 'tyrian-farming__editor' });
		fieldset.disabled = this.busy;
		const enabledLabel = fieldset.createEl('label');
		const enabled = enabledLabel.createEl('input', { type: 'checkbox' });
		enabled.checked = current.enabled;
		enabledLabel.append(farmingCopy(locale, 'enabled'));
		// `hidden` before the class, as it always was, so the attribute order does not move.
		const body = fieldset.createDiv();
		body.hidden = !current.enabled;
		body.className = 'tyrian-farming__preparation';
		const facts = body.createEl('dl', { cls: 'tyrian-farming__facts' });
		const bonusLabel = body.createEl('label', { text: farmingCopy(locale, 'manual') });
		const bonus = numericInput(bonusLabel, current.manualMagicFindBonus, 0, 100_000);
		bonus.placeholder = farmingCopy(locale, 'unknown');
		body.createDiv({ cls: 'tyrian-farming__caption', text: farmingCopy(locale, 'mfLimit') });
		const reviewedLabel = body.createEl('label');
		const reviewed = reviewedLabel.createEl('input', { type: 'checkbox' });
		reviewed.checked = this.reviewed;
		reviewed.addEventListener('change', () => { this.reviewed = reviewed.checked; });
		reviewedLabel.append(farmingCopy(locale, 'reviewed'));
		const reminderInputs = new Map<FarmingReminderKind, HTMLInputElement>();
		const reminderDisplays = new Map<FarmingReminderKind, { status: HTMLElement; action: HTMLButtonElement }>();
		for (const kind of ['food', 'utility'] as const) {
			const row = body.createDiv({ cls: 'tyrian-farming__reminder' });
			const label = row.createEl('label', { text: `${farmingCopy(locale, kind)} · ${farmingCopy(locale, 'reminder')}` });
			const interval = numericInput(label, kind === 'food' ? current.foodReminderMinutes : current.utilityReminderMinutes, 1, 1_440);
			interval.setAttribute('aria-label', `${farmingCopy(locale, kind)} · ${farmingCopy(locale, 'reminderMinutes')}`);
			interval.placeholder = '—';
			reminderInputs.set(kind, interval);
			const status = row.createSpan({ attr: { role: 'status' }, title: farmingCopy(locale, 'reminderLimit') });
			const action = row.createEl('button', { attr: { type: 'button' }, title: farmingCopy(locale, 'reminderLimit') });
			reminderDisplays.set(kind, { status, action });
			action.addEventListener('click', () => {
				const active = this.ports.reminders().find((reminder) => reminder.kind === kind);
				if (active !== undefined) {
					this.ports.clearReminder(kind);
					this.refreshReadOnly(container);
					return;
				}
				const minutes = parseNullableInteger(interval);
				if (minutes === null || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
					interval.setAttribute('aria-invalid', 'true');
					interval.focus();
					feedback.setAttribute('role', 'alert');
					feedback.textContent = farmingCopy(locale, 'invalid');
					return;
				}
				interval.removeAttribute('aria-invalid');
				this.ports.startReminder(kind, minutes);
				this.refreshReadOnly(container);
			});
		}
		enabled.addEventListener('change', () => { body.hidden = !enabled.checked; });
		const save = fieldset.createEl('button', { text: farmingCopy(locale, 'save'), attr: { type: 'button' } });
		const feedback = fieldset.createSpan({
			cls: 'tyrian-farming__feedback', text: this.busy ? farmingCopy(locale, 'saving') : '', attr: { role: 'status' },
		});
		this.rendered = { fieldset, feedback };
		save.addEventListener('click', () => {
			const candidate: FarmingPreparationSettingsV1 = {
				version: 1, enabled: enabled.checked, manualMagicFindBonus: parseNullableInteger(bonus),
				foodReminderMinutes: parseNullableInteger(reminderInputs.get('food')!),
				utilityReminderMinutes: parseNullableInteger(reminderInputs.get('utility')!),
			};
			if (!isFarmingPreparationSettings(candidate)) {
				feedback.setAttribute('role', 'alert');
				feedback.textContent = farmingCopy(locale, 'invalid');
				return;
			}
			void this.apply(candidate, fieldset, feedback, locale);
		});
		this.readOnly = { container, facts, reminders: reminderDisplays };
		this.refreshReadOnly(container);
	}

	/** Refreshes API facts and manual countdowns without replacing preference inputs or focus. */
	refreshReadOnly(container: HTMLElement): void {
		const nodes = this.readOnly;
		if (nodes === null || nodes.container !== container) return;
		const locale = this.ports.locale();
		const context = this.ports.context();
		nodes.facts.replaceChildren();
		const fact = (label: string, value: string): void => {
			nodes.facts.createEl('dt', { text: label });
			nodes.facts.createEl('dd', { text: value });
		};
		const age = (observedAt: string | null | undefined): string => {
			const milliseconds = observedAt == null ? NaN : Date.parse(this.ports.now()) - Date.parse(observedAt);
			return Number.isFinite(milliseconds) && milliseconds >= 0 ? formatFarmingTime(milliseconds) : '—';
		};
		fact(farmingCopy(locale, 'character'), context.characterName ?? '—');
		fact(farmingCopy(locale, 'build'), context.buildName === '' ? farmingCopy(locale, 'noBuildName') : context.buildName ?? '—');
		const slotsLabel = context.freeBagSlotsCharacter === undefined ? farmingCopy(locale, 'slots')
			: `${farmingCopy(locale, 'slots')} · ${context.freeBagSlotsCharacter ?? '—'}`;
		fact(slotsLabel, context.freeBagSlots === null ? '—' : new Intl.NumberFormat(locale).format(context.freeBagSlots));
		if (context.freeBagSlotsObservedAt !== undefined) {
			fact(`${slotsLabel} · ${farmingCopy(locale, 'age')}`, age(context.freeBagSlotsObservedAt));
		}
		fact(farmingCopy(locale, 'collector'), farmingCopy(locale, context.collectorMode === 'collector' ? 'collectorMode' : 'consultMode'));
		fact(farmingCopy(locale, 'addon'), farmingCopy(locale, context.addonConnection));
		const breakdown = context.magicFindBreakdown;
		const observable = breakdown === null ? null : breakdown.luck + breakdown.achievements + breakdown.enrichment;
		fact(farmingCopy(locale, 'magicFind'), observable === null ? '—' : `${new Intl.NumberFormat(locale).format(observable)}%`);
		if (context.magicFindObservedAt !== null) fact(farmingCopy(locale, 'age'), age(context.magicFindObservedAt));
		for (const [kind, display] of nodes.reminders) {
			const active = this.ports.reminders().find((reminder) => reminder.kind === kind);
			display.action.textContent = farmingCopy(locale, active === undefined ? 'startReminder' : 'clearReminder');
			if (active === undefined) { display.status.textContent = ''; continue; }
			const progress = projectFarmingManualReminder(active, this.ports.now());
			display.status.textContent = progress.status === 'due' ? farmingCopy(locale, 'due')
				: progress.remainingMs === null ? '—' : formatFarmingTime(progress.remainingMs);
		}
	}

	private async apply(settings: FarmingPreparationSettingsV1, fieldset: HTMLFieldSetElement, feedback: HTMLElement, locale: 'es' | 'en'): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		fieldset.disabled = true;
		feedback.setAttribute('role', 'status');
		feedback.textContent = farmingCopy(locale, 'saving');
		try {
			await this.ports.save(settings);
			(this.rendered?.feedback ?? feedback).textContent = farmingCopy(locale, 'saved');
		} catch {
			const visibleFeedback = this.rendered?.feedback ?? feedback;
			visibleFeedback.setAttribute('role', 'alert');
			visibleFeedback.textContent = farmingCopy(locale, 'failed');
		} finally {
			this.busy = false;
			fieldset.disabled = false;
			if (this.rendered !== null) this.rendered.fieldset.disabled = false;
		}
	}
}

/** A whole-number input appended to `parent`; blank means unknown, never zero. */
function numericInput(parent: HTMLElement, value: number | null, minimum: number, maximum: number): HTMLInputElement {
	const input = parent.createEl('input', { type: 'number' });
	input.min = String(minimum);
	input.max = String(maximum);
	input.step = '1';
	input.value = value === null ? '' : String(value);
	return input;
}
function parseNullableInteger(input: HTMLInputElement): number | null {
	return input.value.trim() === '' ? null : Number(input.value);
}
