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
	constructor(private readonly ports: FarmingPreparationPanelPorts) {}

	render(container: HTMLElement): void {
		const wasOpen = container.querySelector('details')?.open ?? false;
		container.replaceChildren();
		container.classList.add('tyrian-farming');
		const document = container.ownerDocument;
		const locale = this.ports.locale();
		const current = this.ports.settings();
		const context = this.ports.context();
		const details = document.createElement('details');
		details.open = wasOpen;
		const summary = document.createElement('summary');
		summary.textContent = farmingCopy(locale, 'preparation');
		details.append(summary);
		const fieldset = document.createElement('fieldset');
		fieldset.className = 'tyrian-farming__editor';
		fieldset.disabled = this.busy;
		const enabledLabel = document.createElement('label');
		const enabled = document.createElement('input');
		enabled.type = 'checkbox';
		enabled.checked = current.enabled;
		enabledLabel.append(enabled, farmingCopy(locale, 'enabled'));
		fieldset.append(enabledLabel);
		const body = document.createElement('div');
		body.hidden = !current.enabled;
		body.className = 'tyrian-farming__preparation';
		const facts = document.createElement('dl');
		facts.className = 'tyrian-farming__facts';
		const fact = (label: string, value: string): void => {
			const term = document.createElement('dt');
			term.textContent = label;
			const description = document.createElement('dd');
			description.textContent = value;
			facts.append(term, description);
		};
		fact(farmingCopy(locale, 'character'), context.characterName ?? '—');
		fact(farmingCopy(locale, 'build'), context.buildName === '' ? farmingCopy(locale, 'noBuildName') : context.buildName ?? '—');
		fact(farmingCopy(locale, 'slots'), context.freeBagSlots === null ? '—' : new Intl.NumberFormat(locale).format(context.freeBagSlots));
		fact(farmingCopy(locale, 'collector'), farmingCopy(locale, context.collectorMode === 'collector' ? 'collectorMode' : 'consultMode'));
		fact(farmingCopy(locale, 'addon'), farmingCopy(locale, context.addonConnection));
		const breakdown = context.magicFindBreakdown;
		const observable = breakdown === null ? null : breakdown.luck + breakdown.achievements + breakdown.enrichment;
		fact(farmingCopy(locale, 'magicFind'), observable === null ? '—' : `${new Intl.NumberFormat(locale).format(observable)}%`);
		if (context.magicFindObservedAt !== null) {
			const age = Date.parse(this.ports.now()) - Date.parse(context.magicFindObservedAt);
			fact(farmingCopy(locale, 'age'), Number.isFinite(age) && age >= 0 ? formatFarmingTime(age) : '—');
		}
		body.append(facts);
		const bonusLabel = document.createElement('label');
		bonusLabel.textContent = farmingCopy(locale, 'manual');
		const bonus = numericInput(document, current.manualMagicFindBonus, 0, 100_000);
		bonus.placeholder = farmingCopy(locale, 'unknown');
		bonusLabel.append(bonus);
		body.append(bonusLabel);
		const limit = document.createElement('div');
		limit.className = 'tyrian-farming__caption';
		limit.textContent = farmingCopy(locale, 'mfLimit');
		body.append(limit);
		const reviewedLabel = document.createElement('label');
		const reviewed = document.createElement('input');
		reviewed.type = 'checkbox';
		reviewed.checked = this.reviewed;
		reviewed.addEventListener('change', () => { this.reviewed = reviewed.checked; });
		reviewedLabel.append(reviewed, farmingCopy(locale, 'reviewed'));
		body.append(reviewedLabel);
		const reminderInputs = new Map<FarmingReminderKind, HTMLInputElement>();
		for (const kind of ['food', 'utility'] as const) {
			const row = document.createElement('div');
			row.className = 'tyrian-farming__reminder';
			const label = document.createElement('label');
			label.textContent = `${farmingCopy(locale, kind)} · ${farmingCopy(locale, 'reminder')}`;
			const interval = numericInput(document, kind === 'food' ? current.foodReminderMinutes : current.utilityReminderMinutes, 1, 1_440);
			interval.setAttribute('aria-label', `${farmingCopy(locale, kind)} · ${farmingCopy(locale, 'reminderMinutes')}`);
			interval.placeholder = '—';
			label.append(interval);
			row.append(label);
			reminderInputs.set(kind, interval);
			const active = this.ports.reminders().find((reminder) => reminder.kind === kind);
			if (active !== undefined) {
				const progress = projectFarmingManualReminder(active, this.ports.now());
				const status = document.createElement('span');
				status.setAttribute('role', 'status');
				status.textContent = progress.status === 'due' ? farmingCopy(locale, 'due')
					: progress.remainingMs === null ? '—' : formatFarmingTime(progress.remainingMs);
				status.title = farmingCopy(locale, 'reminderLimit');
				row.append(status);
			}
			const action = document.createElement('button');
			action.type = 'button';
			action.textContent = farmingCopy(locale, active === undefined ? 'startReminder' : 'clearReminder');
			action.title = farmingCopy(locale, 'reminderLimit');
			action.addEventListener('click', () => {
				if (active !== undefined) { this.ports.clearReminder(kind); return; }
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
			});
			row.append(action);
			body.append(row);
		}
		enabled.addEventListener('change', () => { body.hidden = !enabled.checked; });
		fieldset.append(body);
		const save = document.createElement('button');
		save.type = 'button';
		save.textContent = farmingCopy(locale, 'save');
		const feedback = document.createElement('span');
		feedback.className = 'tyrian-farming__feedback';
		feedback.setAttribute('role', 'status');
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
		fieldset.append(save, feedback);
		details.append(fieldset);
		container.append(details);
	}

	private async apply(settings: FarmingPreparationSettingsV1, fieldset: HTMLFieldSetElement, feedback: HTMLElement, locale: 'es' | 'en'): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		fieldset.disabled = true;
		feedback.setAttribute('role', 'status');
		feedback.textContent = farmingCopy(locale, 'saving');
		try {
			await this.ports.save(settings);
			feedback.textContent = farmingCopy(locale, 'saved');
		} catch {
			feedback.setAttribute('role', 'alert');
			feedback.textContent = farmingCopy(locale, 'failed');
		} finally {
			this.busy = false;
			fieldset.disabled = false;
		}
	}
}

function numericInput(document: Document, value: number | null, minimum: number, maximum: number): HTMLInputElement {
	const input = document.createElement('input');
	input.type = 'number';
	input.min = String(minimum);
	input.max = String(maximum);
	input.step = '1';
	input.value = value === null ? '' : String(value);
	return input;
}
function parseNullableInteger(input: HTMLInputElement): number | null {
	return input.value.trim() === '' ? null : Number(input.value);
}
