import type { FarmingGoalProgress, FarmingGoalV1 } from '../sessions/farming-goal';
import type { FarmingManualReminder, FarmingPreparationContext, FarmingPreparationSettingsV1, FarmingReminderKind } from '../sessions/farming-goal-preparation';
import type { FarmingGroupContext } from '../runtime/farming-session-context';
import type { FarmingIngameState } from '../alerts/farming-ingame-state';
import { FarmingGoalEditor, renderFarmingGoalProgress } from './farming-goal-panel';
import { FarmingPreparationPanel } from './farming-preparation-panel';
import { farmingCopy } from './farming-goal-copy';

export interface FarmingSessionPanelActions {
	getLocale(): 'es' | 'en';
	getFarmingGoal(): FarmingGoalV1;
	saveFarmingGoal(goal: FarmingGoalV1): Promise<void>;
	getFarmingGoalProgress(): FarmingGoalProgress | null;
	getFarmingGroupContext(): FarmingGroupContext;
	setFarmingGroupContext(context: FarmingGroupContext): void;
	getFarmingPreparationSettings(): FarmingPreparationSettingsV1;
	saveFarmingPreparationSettings(settings: FarmingPreparationSettingsV1): Promise<void>;
	getFarmingPreparationContext(): FarmingPreparationContext;
	getFarmingReminders(): readonly FarmingManualReminder[];
	startFarmingReminder(kind: FarmingReminderKind, minutes: number): void;
	clearFarmingReminder(kind: FarmingReminderKind): void;
	getFarmingIngameState(): FarmingIngameState;
}

/** Retained editor surface: account refreshes keep focus and unsaved input intact. */
export class FarmingSessionPanel {
	readonly element: HTMLElement;
	private readonly figures: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly goalEditor: HTMLElement;
	private readonly preparation: HTMLElement;
	private readonly editor: FarmingGoalEditor;
	private readonly preparationPanel: FarmingPreparationPanel;
	private editorKey: string | null = null;
	private preparationKey: string | null = null;

	constructor(document: Document, private readonly actions: FarmingSessionPanelActions) {
		this.element = document.createElement('section');
		this.element.className = 'tyrian-farming tyrian-farming-session';
		this.figures = document.createElement('div');
		this.figures.className = 'tyrian-farming__metrics';
		this.progress = document.createElement('div');
		this.goalEditor = document.createElement('div');
		this.preparation = document.createElement('div');
		this.editor = new FarmingGoalEditor({ value: () => actions.getFarmingGoal(),
			save: async (goal) => { await actions.saveFarmingGoal(goal); }, locale: () => actions.getLocale() });
		this.preparationPanel = new FarmingPreparationPanel({
			settings: () => actions.getFarmingPreparationSettings(), context: () => actions.getFarmingPreparationContext(),
			reminders: () => actions.getFarmingReminders(), now: () => new Date().toISOString(), locale: () => actions.getLocale(),
			save: async (settings) => { await actions.saveFarmingPreparationSettings(settings); },
			startReminder: (kind, minutes) => { actions.startFarmingReminder(kind, minutes); },
			clearReminder: (kind) => { actions.clearFarmingReminder(kind); },
		});
		const defaults = document.createElement('details');
		const summary = document.createElement('summary');
		summary.textContent = actions.getLocale() === 'es' ? 'Preparar la próxima tanda' : 'Prepare the next session';
		defaults.append(summary, this.goalEditor, this.groupEditor(document), this.preparation);
		this.element.append(this.figures, this.progress, defaults);
		this.refresh();
	}

	/** Read-only metrics tick separately from editors, so a poll never resets a draft. */
	refresh(): void {
		const locale = this.actions.getLocale();
		const goalKey = JSON.stringify([locale, this.actions.getFarmingGoal()]);
		if (goalKey !== this.editorKey) { this.editorKey = goalKey; this.editor.render(this.goalEditor); }
		const preparationKey = JSON.stringify([locale, this.actions.getFarmingPreparationSettings()]);
		if (preparationKey !== this.preparationKey) {
			this.preparationKey = preparationKey;
			this.preparationPanel.render(this.preparation);
		}
		this.preparationPanel.refreshReadOnly(this.preparation);
		const state = this.actions.getFarmingIngameState();
		const observed = `${farmingCopy(locale, 'observed')}: ${state.observed === null ? '—' : String(state.observed)}`;
		const net = state.net === null ? '' : ` · ${farmingCopy(locale, 'net')}: ${String(state.net)}`;
		const age = state.age === null ? '' : ` · ${farmingCopy(locale, 'age')}: ${String(state.age)} s`;
		const slots = `${farmingCopy(locale, 'slots')}: ${state.slots === null ? '—' : String(state.slots)}`;
		const slotAge = state.slotAge === null ? '' : ` (${String(state.slotAge)} s)`;
		this.figures.textContent = `${observed}${net}${age} · ${slots}${slotAge}`;
		const progress = this.actions.getFarmingGoalProgress();
		const expanded = this.progress.querySelector('details')?.open === true;
		if (progress === null) this.progress.replaceChildren();
		else renderFarmingGoalProgress(this.progress, progress, locale);
		const detail = this.progress.querySelector('details');
		if (detail) detail.open = expanded;
	}

	private groupEditor(document: Document): HTMLElement {
		const label = document.createElement('label');
		label.className = 'tyrian-farming__editor';
		const es = this.actions.getLocale() === 'es';
		label.textContent = es ? 'Grupo de la próxima tanda (declarado)' : 'Next-session group (declared)';
		const select = document.createElement('select');
		for (const [value, text] of [['', es ? 'Sin declarar' : 'Undeclared'],
			['with_bosses', es ? 'Con jefes' : 'With bosses'], ['without_bosses', es ? 'Sin jefes' : 'Without bosses']]) {
			const option = document.createElement('option');
			option.value = value ?? '';
			option.textContent = text ?? '';
			select.append(option);
		}
		select.value = this.actions.getFarmingGroupContext() ?? '';
		select.addEventListener('change', () => {
			this.actions.setFarmingGroupContext(select.value === 'with_bosses' || select.value === 'without_bosses' ? select.value : null);
		});
		label.append(select);
		return label;
	}
}
