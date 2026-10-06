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
	const document = container.ownerDocument;
	const row = document.createElement('div');
	row.className = 'tyrian-farming__metrics';
	const value = document.createElement('strong');
	const target = progress.goal.kind === 'bags' ? progress.goal.targetBags : progress.goal.targetDurationMs;
	value.textContent = progress.goal.kind === 'bags'
		? `${formatCount(progress.observedBags, locale)} / ${formatCount(target, locale)} ${farmingCopy(locale, 'bags')}`
		: `${progress.elapsedMs === null ? '—' : formatFarmingTime(progress.elapsedMs)} / ${formatFarmingTime(target)}`;
	row.append(value);
	const remaining = document.createElement('span');
	remaining.setAttribute('role', 'status');
	if (progress.status === 'reached') {
		remaining.textContent = farmingCopy(locale, progress.goal.kind === 'duration' ? 'durationReached' : 'reached');
	} else if (progress.remainingMs !== null && progress.remainingKind !== null) {
		remaining.textContent = `${farmingCopy(locale, progress.remainingKind === 'countdown' ? 'countdown' : 'estimate')}: ${formatFarmingTime(progress.remainingMs)}`;
	} else {
		remaining.textContent = farmingCopy(locale, 'unavailable');
		remaining.title = progress.etaUnavailableReason === null ? '' : farmingCopy(locale, progress.etaUnavailableReason);
	}
	row.append(remaining);
	container.append(row);
	if (progress.progressRatio !== null) {
		const bar = document.createElement('progress');
		bar.className = 'tyrian-farming__progress';
		bar.max = 1;
		bar.value = progress.progressRatio;
		bar.setAttribute('aria-label', farmingCopy(locale, 'goal'));
		container.append(bar);
	}
	if (progress.goal.kind === 'bags') {
		const disclosure = document.createElement('details');
		const summary = document.createElement('summary');
		summary.textContent = farmingCopy(locale, 'observed');
		disclosure.append(summary);
		const limit = document.createElement('div');
		limit.textContent = farmingCopy(locale, 'unknownTotal');
		disclosure.append(limit);
		if (progress.finalNetBags !== null) {
			const net = document.createElement('div');
			net.textContent = `${farmingCopy(locale, 'net')}: ${formatCount(progress.finalNetBags, locale)}`;
			disclosure.append(net);
		}
		container.append(disclosure);
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
		const document = container.ownerDocument;
		const locale = this.ports.locale();
		const current = this.ports.value();
		let kind = current.kind;
		const fieldset = document.createElement('fieldset');
		fieldset.className = 'tyrian-farming__editor';
		fieldset.disabled = this.busy;
		const legend = document.createElement('legend');
		legend.textContent = farmingCopy(locale, 'goal');
		fieldset.append(legend);
		const options = document.createElement('div');
		options.className = 'tyrian-farming__options';
		const numberLabel = document.createElement('label');
		numberLabel.textContent = farmingCopy(locale, 'target');
		const number = document.createElement('input');
		number.type = 'number';
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
			const label = document.createElement('label');
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = this.radioName;
			radio.value = choice;
			radio.checked = choice === kind;
			radio.addEventListener('change', () => {
				kind = choice;
				number.value = String(choice === 'duration' ? DEFAULT_FARMING_TARGET_DURATION_MS / 60_000 : DEFAULT_FARMING_TARGET_BAGS);
				updateNumber();
			});
			label.append(radio, farmingCopy(locale, choice));
			options.append(label);
		}
		fieldset.append(options);
		numberLabel.append(number);
		fieldset.append(numberLabel);
		const save = document.createElement('button');
		save.type = 'button';
		save.textContent = farmingCopy(locale, 'save');
		const feedback = document.createElement('span');
		feedback.className = 'tyrian-farming__feedback';
		feedback.setAttribute('role', 'status');
		feedback.textContent = this.busy ? farmingCopy(locale, 'saving') : '';
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
		fieldset.append(save, feedback);
		container.append(fieldset);
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
