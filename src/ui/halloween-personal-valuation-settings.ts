import type { Translator } from '../core/i18n';
import type { ContainerPersonalValuationV1 } from '../economy/container-personal-valuation';
import { resolveContainerPersonalValuation } from '../economy/container-personal-valuation';
import { halloweenTrickOrTreatBagModel } from '../economy/models/halloween-trick-or-treat-bag';

export interface HalloweenPersonalValuationSettingsPorts {
	value(): ContainerPersonalValuationV1;
	save(value: ContainerPersonalValuationV1): Promise<void>;
	translator(): Translator;
}

type RowFeedback = 'saved' | 'removed' | 'save_failed' | null;

/** Separate Settings editor for the ten explicit, manually valued outcomes. */
export class HalloweenPersonalValuationSettings {
	private busyKey: string | null = null;
	private feedback = new Map<string, RowFeedback>();
	private mount: HTMLElement | null = null;

	constructor(private readonly ports: HalloweenPersonalValuationSettingsPorts) {}

	render(container: HTMLElement): void {
		this.mount = container;
		const translator = this.ports.translator();
		container.replaceChildren();
		container.classList.add('tyrian-personal-valuation');
		const model = halloweenTrickOrTreatBagModel();
		const outcomes = model.outcomes.filter((outcome) => outcome.valuationPolicy === 'excluded');
		const current = this.ports.value();
		const values = new Map(current.values.map((entry) => [entry.outcomeKey, entry.unitCopper]));
		const resolved = resolveContainerPersonalValuation(model, current);

		const summary = container.createEl('p');
		summary.className = 'tyrian-personal-valuation__summary';
		summary.setAttribute('aria-live', 'polite');
		summary.textContent = resolved.status === 'ok'
			? translator.t(`settings.halloween.personal.coverage.${resolved.value.coverage}`, {
				valued: resolved.value.lines.length, total: outcomes.length,
			})
			: translator.t('settings.halloween.personal.invalidStored');

		const grid = container.createDiv();
		grid.className = 'tyrian-personal-valuation__grid';
		for (const outcome of outcomes) {
			const row = grid.createDiv();
			row.className = 'tyrian-personal-valuation__row';
			const inputId = `tyrian-personal-valuation-${outcome.key.replace(':', '-')}`;
			const errorId = `${inputId}-error`;
			const label = row.createEl('label');
			label.htmlFor = inputId;
			label.textContent = outcome.label;
			label.title = outcome.label;
			const meta = label.createSpan();
			meta.className = 'tyrian-personal-valuation__meta';
			meta.textContent = translator.t('settings.halloween.personal.rowMeta');

			const input = row.createEl('input');
			input.id = inputId;
			input.type = 'text';
			input.inputMode = 'numeric';
			input.autocomplete = 'off';
			input.value = values.has(outcome.key) ? String(values.get(outcome.key)) : '';
			input.placeholder = translator.t('settings.halloween.personal.empty');
			input.setAttribute('aria-label', translator.t('settings.halloween.personal.inputLabel', {
				outcome: outcome.label,
			}));
			input.setAttribute('aria-describedby', errorId);
			input.disabled = this.busyKey !== null;

			const remove = row.createEl('button');
			remove.type = 'button';
			remove.textContent = translator.t('settings.halloween.personal.remove');
			remove.setAttribute('aria-label', translator.t('settings.halloween.personal.removeLabel', {
				outcome: outcome.label,
			}));
			remove.disabled = this.busyKey !== null || !values.has(outcome.key);

			const message = row.createSpan();
			message.id = errorId;
			message.className = 'tyrian-personal-valuation__message';
			message.setAttribute('aria-live', 'polite');
			const feedback = this.feedback.get(outcome.key) ?? null;
			if (this.busyKey === outcome.key) {
				message.setAttribute('role', 'status');
				message.textContent = translator.t('settings.halloween.personal.saving');
			} else if (feedback !== null) {
				message.setAttribute('role', feedback === 'save_failed' ? 'alert' : 'status');
				message.textContent = translator.t(`settings.halloween.personal.${feedback}`);
			}

			input.addEventListener('change', () => {
				const parsed = parseCopper(input.value);
				if (parsed.status === 'invalid') {
					message.setAttribute('role', 'alert');
					message.textContent = translator.t('settings.halloween.personal.invalid');
					input.setAttribute('aria-invalid', 'true');
					input.focus();
					return;
				}
				input.removeAttribute('aria-invalid');
				void this.apply(outcome.key, parsed.value, { input, message });
			});
			remove.addEventListener('click', () => { void this.apply(outcome.key, null); });
		}

		const warning = container.createEl('p');
		warning.className = 'tyrian-personal-valuation__warning';
		warning.textContent = translator.t('settings.halloween.personal.outsideWarning', {
			units: model.excluded.reduce((sum, entry) => sum + entry.sampleUnits, 0),
		});
	}

	private async apply(
		outcomeKey: string,
		unitCopper: number | null,
		invalidTarget?: { input: HTMLInputElement; message: HTMLSpanElement },
	): Promise<void> {
		if (this.busyKey !== null) return;
		const current = this.ports.value();
		const values = current.values.filter((entry) => entry.outcomeKey !== outcomeKey);
		if (unitCopper !== null) values.push({ outcomeKey, unitCopper, origin: 'manual' });
		values.sort((left, right) => left.outcomeKey.localeCompare(right.outcomeKey));
		const candidate: ContainerPersonalValuationV1 = { version: 1, values };
		if (resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), candidate).status === 'invalid') {
			if (invalidTarget !== undefined) {
				invalidTarget.message.setAttribute('role', 'alert');
				invalidTarget.message.textContent = this.ports.translator().t('settings.halloween.personal.invalid');
				invalidTarget.input.setAttribute('aria-invalid', 'true');
				invalidTarget.input.focus();
			}
			return;
		}
		this.busyKey = outcomeKey;
		this.feedback.delete(outcomeKey);
		const container = this.mount;
		if (container !== null) this.render(container);
		try {
			await this.ports.save(candidate);
			this.feedback.set(outcomeKey, unitCopper === null ? 'removed' : 'saved');
		} catch {
			this.feedback.set(outcomeKey, 'save_failed');
		} finally {
			this.busyKey = null;
			if (container !== null) this.render(container);
		}
	}
}

function parseCopper(value: string): { status: 'valid'; value: number | null } | { status: 'invalid' } {
	const trimmed = value.trim();
	if (trimmed === '') return { status: 'valid', value: null };
	if (!/^\d+$/u.test(trimmed)) return { status: 'invalid' };
	const number = Number(trimmed);
	return Number.isSafeInteger(number) && number >= 0
		? { status: 'valid', value: number }
		: { status: 'invalid' };
}
