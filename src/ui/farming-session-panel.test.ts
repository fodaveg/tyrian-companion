// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { FarmingGroupContext } from '../runtime/farming-session-context';
import { emptyFarmingIngameState } from '../alerts/farming-ingame-state';
import { DEFAULT_FARMING_PREPARATION, type FarmingManualReminder } from '../sessions/farming-goal-preparation';
import { FarmingSessionPanel, type FarmingSessionPanelActions } from './farming-session-panel';

function panelHarness() {
	const reminders: FarmingManualReminder[] = [];
	const setGroup = vi.fn((_context: FarmingGroupContext) => {});
	const saveGoal = vi.fn(async () => {});
	const actions: FarmingSessionPanelActions = {
		getLocale: () => 'en', getFarmingGoal: () => ({ version: 1, kind: 'bags', targetBags: 1_000 }),
		saveFarmingGoal: saveGoal, getFarmingGoalProgress: () => null,
		getFarmingGroupContext: () => null, setFarmingGroupContext: setGroup,
		getFarmingPreparationSettings: () => ({ ...DEFAULT_FARMING_PREPARATION, enabled: true }),
		saveFarmingPreparationSettings: vi.fn(async () => {}),
		getFarmingPreparationContext: () => ({ characterName: 'Character', buildName: null, freeBagSlots: 8,
			collectorMode: 'collector', addonConnection: 'connected', magicFindBreakdown: null, magicFindObservedAt: null }),
		getFarmingReminders: () => reminders,
		startFarmingReminder: (kind, minutes) => { reminders.push({ kind, durationMinutes: minutes, startedAt: new Date().toISOString() }); },
		clearFarmingReminder: (kind) => { reminders.splice(0, reminders.length, ...reminders.filter((value) => value.kind !== kind)); },
		getFarmingIngameState: () => ({ ...emptyFarmingIngameState(), phase: 'active', observed: 200, slots: 8, age: 300, slotAge: 600 }),
	};
	return { actions, setGroup, saveGoal, panel: new FarmingSessionPanel(document, actions) };
}

describe('retained farming session consumer', () => {
	it('keeps goal and preparation drafts and focus across observation repaints', () => {
		const { panel } = panelHarness();
		document.body.append(panel.element);
		const goal = panel.element.querySelector<HTMLInputElement>('input[type="number"]')!;
		goal.value = '1234';
		goal.focus();
		panel.refresh();
		expect(panel.element.querySelector('input[type="number"]')).toBe(goal);
		expect(goal.value).toBe('1234');
		expect(document.activeElement).toBe(goal);
		expect(panel.element.textContent).toContain('Observed bags: 200');
		expect(panel.element.textContent).toContain('Observation age: 300 s');
		expect(panel.element.textContent).toContain('8 (600 s)');
		panel.element.remove();
	});

	it('reports group declaration for the next start and keeps it independent from progress', () => {
		const { panel, setGroup, saveGoal } = panelHarness();
		const group = panel.element.querySelector<HTMLSelectElement>('select')!;
		group.value = 'without_bosses';
		group.dispatchEvent(new Event('change'));
		expect(setGroup).toHaveBeenCalledWith('without_bosses');
		expect(saveGoal).not.toHaveBeenCalled();
	});

	it('updates user-started manual reminders without rebuilding a typed goal', () => {
		const { panel } = panelHarness();
		const goal = panel.element.querySelector<HTMLInputElement>('input[type="number"]')!;
		goal.value = '1234';
		const row = panel.element.querySelector<HTMLElement>('.tyrian-farming__reminder')!;
		row.querySelector<HTMLInputElement>('input')!.value = '30';
		row.querySelector<HTMLButtonElement>('button')!.click();
		panel.refresh();
		expect(row.querySelector('button')?.textContent).toBe('Clear reminder');
		expect(goal.value).toBe('1234');
		row.querySelector<HTMLButtonElement>('button')!.click();
		panel.refresh();
		expect(row.querySelector('button')?.textContent).toBe('Start reminder');
	});
});
