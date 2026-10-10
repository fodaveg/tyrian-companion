import {
	DEFAULT_FARMING_TARGET_BAGS,
	DEFAULT_FARMING_TARGET_DURATION_MS,
	isFarmingGoal,
	type FarmingGoalProgress,
	type FarmingGoalV1,
} from '../sessions/farming-goal';
import { farmingCopy, formatFarmingTime } from './farming-goal-copy';

/** Renders one read-only projection for either host. Unknown values are never displayed as zero. */
export function renderFarmingGoalProgress(container: HTMLElement, progress: FarmingGoalProgress, locale: 'es' | 'en'): void {
	container.replaceChildren();
	container.classList.add('tyrian-farming');
	if (progress.goal.kind === 'none') return;
	const row = container.createDiv({ cls: 'tyrian-farming__metrics' });
	const target = progress.goal.kind === 'bags' ? progress.goal.targetBags : progress.goal.targetDurationMs;
	row.createEl('strong', { text: progress.goal.kind === 'bags'
		? `${formatCount(progress.observedBags, locale)} / ${formatCount(target, locale)} ${farmingCopy(locale, 'bags')}`
		: `${progress.elapsedMs === null ? '—' : formatFarmingTime(progress.elapsedMs)} / ${formatFarmingTime(target)}` });
	const remaining = row.createSpan({ attr: { role: 'status' } });
	if (progress.status === 'reached') {
		remaining.textContent = farmingCopy(locale, progress.goal.kind === 'duration' ? 'durationReached' : 'reached');
	} else if (progress.remainingMs !== null && progress.remainingKind !== null) {
		remaining.textContent = `${farmingCopy(locale, progress.remainingKind === 'countdown' ? 'countdown' : 'estimate')}: ${formatFarmingTime(progress.remainingMs)}`;
	} else {
		remaining.textContent = farmingCopy(locale, 'unavailable');
		remaining.title = progress.etaUnavailableReason === null ? '' : farmingCopy(locale, progress.etaUnavailableReason);
	}
	if (progress.progressRatio !== null) {
		// `max` and `value` before the label, as they always were, so the attribute order does not move.
		const bar = container.createEl('progress', { cls: 'tyrian-farming__progress' });
		bar.max = 1;
		bar.value = progress.progressRatio;
		bar.setAttribute('aria-label', farmingCopy(locale, 'goal'));
	}
	if (progress.goal.kind === 'bags') {
		const disclosure = container.createEl('details');
		disclosure.createEl('summary', { text: farmingCopy(locale, 'observed') });
		disclosure.createDiv({ text: farmingCopy(locale, 'unknownTotal') });
		if (progress.finalNetBags !== null) {
			disclosure.createDiv({ text: `${farmingCopy(locale, 'net')}: ${formatCount(progress.finalNetBags, locale)}` });
		}
	}
}

export interface FarmingGoalEditorPorts {
	value(): FarmingGoalV1;
	save(goal: FarmingGoalV1): Promise<void>;
	locale(): 'es' | 'en';
}

let nextEditorId = 0;

/** Edits the default for the NEXT session; saving does not rewrite a captured session target. */
export class FarmingGoalEditor {
	private busy = false;
	private rendered: { fieldset: HTMLFieldSetElement; feedback: HTMLElement } | null = null;
	private readonly radioName = `tyrian-farming-goal-${++nextEditorId}`;
	constructor(private readonly ports: FarmingGoalEditorPorts) {}

	render(container: HTMLElement): void {
		container.replaceChildren();
		container.classList.add('tyrian-farming');
		const locale = this.ports.locale();
		const current = this.ports.value();
		let kind = current.kind;
		const fieldset = container.createEl('fieldset', { cls: 'tyrian-farming__editor' });
		fieldset.disabled = this.busy;
		fieldset.createEl('legend', { text: farmingCopy(locale, 'goal') });
		// The choices go first and the number after them, but the radios' listeners need the number.
		const options = fieldset.createDiv({ cls: 'tyrian-farming__options' });
		const numberLabel = fieldset.createEl('label', { text: farmingCopy(locale, 'target') });
		const number = numberLabel.createEl('input', { type: 'number' });
		number.min = '1';
		number.step = '1';
		number.disabled = current.kind === 'none';
		number.value = String(current.kind === 'bags' ? current.targetBags
			: current.kind === 'duration' ? current.targetDurationMs / 60_000 : DEFAULT_FARMING_TARGET_BAGS);
		const updateNumber = (): void => {
			number.disabled = kind === 'none';
			number.max = kind === 'duration' ? '10080' : '1000000000';
			number.setAttribute('aria-label', farmingCopy(locale, kind === 'duration' ? 'minutes' : 'bags'));
		};
		updateNumber();
		for (const choice of ['none', 'bags', 'duration'] as const) {
			const label = options.createEl('label');
			const radio = label.createEl('input', { type: 'radio' });
			radio.name = this.radioName;
			radio.value = choice;
			radio.checked = choice === kind;
			radio.addEventListener('change', () => {
				kind = choice;
				number.value = String(choice === 'duration' ? DEFAULT_FARMING_TARGET_DURATION_MS / 60_000 : DEFAULT_FARMING_TARGET_BAGS);
				updateNumber();
			});
			label.append(farmingCopy(locale, choice));
		}
		const save = fieldset.createEl('button', { text: farmingCopy(locale, 'save'), attr: { type: 'button' } });
		const feedback = fieldset.createSpan({
			cls: 'tyrian-farming__feedback', text: this.busy ? farmingCopy(locale, 'saving') : '', attr: { role: 'status' },
		});
		this.rendered = { fieldset, feedback };
		save.addEventListener('click', () => {
			const parsed = Number(number.value);
			const goal: FarmingGoalV1 = kind === 'none' ? { version: 1, kind }
				: kind === 'bags' ? { version: 1, kind, targetBags: parsed }
					: { version: 1, kind, targetDurationMs: parsed * 60_000 };
			if (kind !== 'none' && (!Number.isSafeInteger(parsed) || !isFarmingGoal(goal))) {
				feedback.setAttribute('role', 'alert');
				feedback.textContent = farmingCopy(locale, 'invalid');
				number.setAttribute('aria-invalid', 'true');
				number.focus();
				return;
			}
			number.removeAttribute('aria-invalid');
			void this.apply(goal, fieldset, feedback, locale);
		});
	}

	private async apply(goal: FarmingGoalV1, fieldset: HTMLFieldSetElement, feedback: HTMLElement, locale: 'es' | 'en'): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		fieldset.disabled = true;
		feedback.setAttribute('role', 'status');
		feedback.textContent = farmingCopy(locale, 'saving');
		try {
			await this.ports.save(goal);
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

function formatCount(value: number | null, locale: 'es' | 'en'): string {
	return value === null ? '—' : new Intl.NumberFormat(locale).format(value);
}
