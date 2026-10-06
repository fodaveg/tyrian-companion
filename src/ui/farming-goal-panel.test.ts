// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { projectFarmingGoal, type FarmingGoalV1 } from '../sessions/farming-goal';
import {
	DEFAULT_FARMING_PREPARATION, type FarmingManualReminder, type FarmingPreparationContext,
} from '../sessions/farming-goal-preparation';
import { FarmingGoalEditor, renderFarmingGoalProgress } from './farming-goal-panel';
import { FarmingPreparationPanel, type FarmingPreparationPanelPorts } from './farming-preparation-panel';

function container(): HTMLDivElement { return document.createElement('div'); }
const observation = {
	startedAt: '2026-10-06T10:00:00Z', now: '2026-10-06T10:20:00Z', observedBags: 200,
	observedFrom: '2026-10-06T10:00:00Z', observedAt: '2026-10-06T10:20:00Z', sampleCount: 3,
};

describe('host-neutral farming components', () => {
	it.each(['es', 'en'] as const)('renders observed targets, limits and approximate ETA in %s', (locale) => {
		const mount = container();
		renderFarmingGoalProgress(mount, projectFarmingGoal({ version: 1, kind: 'bags', targetBags: 1_000 }, observation), locale);
		expect(mount.querySelector('progress')?.value).toBe(0.2);
		expect(mount.textContent).toContain(locale === 'es' ? 'Tiempo restante aproximado' : 'Approximate time remaining');
		expect(mount.textContent).toContain(locale === 'es' ? 'no es observable' : 'cannot be observed');
		expect(mount.querySelector('details')?.open).toBe(false);
	});

	it('uses a dash for unknown increments, hides stale ETA and distinguishes duration countdown', () => {
		const mount = container();
		const goal = { version: 1, kind: 'bags', targetBags: 1_000 } as const;
		renderFarmingGoalProgress(mount, projectFarmingGoal(goal, { ...observation, observedBags: null }), 'en');
		expect(mount.textContent).toContain('— / 1,000');
		expect(mount.querySelector('progress')).toBeNull();
		renderFarmingGoalProgress(mount, projectFarmingGoal(goal, { ...observation, now: '2026-10-06T11:00:00Z' }), 'en');
		expect(mount.querySelector('[role="status"]')?.textContent).toBe('Estimate not available yet');
		expect(mount.querySelector('[role="status"]')?.getAttribute('title')).toBe('Observation is old');
		renderFarmingGoalProgress(mount, projectFarmingGoal({ version: 1, kind: 'duration', targetDurationMs: 3_600_000 }, observation), 'en');
		expect(mount.textContent).toContain('Time remaining: 40:00');
		expect(mount.textContent).not.toContain('Approximate');
	});

	it('edits one exclusive target, saves the next-session default and rejects invalid numbers', async () => {
		const mount = container();
		let goal: FarmingGoalV1 = { version: 1, kind: 'none' };
		const save = vi.fn(async (value: FarmingGoalV1) => { goal = value; });
		new FarmingGoalEditor({ value: () => goal, save, locale: () => 'en' }).render(mount);
		const duration = mount.querySelector<HTMLInputElement>('input[value="duration"]')!;
		duration.checked = true;
		duration.dispatchEvent(new Event('change'));
		const number = mount.querySelector<HTMLInputElement>('input[type="number"]')!;
		expect(number.value).toBe('60');
		number.value = '-1';
		mount.querySelector('button')!.click();
		expect(save).not.toHaveBeenCalled();
		expect(number.getAttribute('aria-invalid')).toBe('true');
		number.value = '60';
		mount.querySelector('button')!.click();
		await Promise.resolve();
		expect(goal).toEqual({ version: 1, kind: 'duration', targetDurationMs: 3_600_000 });
		expect(mount.textContent).toContain('Saved for the next session');
	});

	it('shows save failure inline without throwing or printing rejection details', async () => {
		const mount = container();
		new FarmingGoalEditor({ value: () => ({ version: 1, kind: 'none' }), locale: () => 'en',
			save: async () => { throw new Error('private path'); } }).render(mount);
		mount.querySelector('button')!.click();
		await Promise.resolve();
		expect(mount.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
		expect(mount.textContent).not.toContain('private path');
	});

	it.each(['resolve', 'reject'] as const)('restores the visible goal editor after a pending save and repaint (%s)', async (outcome) => {
		const mount = container();
		let resolve!: () => void;
		let reject!: (reason: Error) => void;
		const save = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
		const editor = new FarmingGoalEditor({ value: () => ({ version: 1, kind: 'bags', targetBags: 1_000 }),
			locale: () => 'en', save: () => save });
		editor.render(mount);
		mount.querySelector('button')!.click();
		editor.render(mount);
		expect(mount.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);
		expect(mount.textContent).toContain('Saving…');
		if (outcome === 'resolve') resolve(); else reject(new Error('private path'));
		await Promise.resolve();
		expect(mount.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
		expect(mount.querySelector<HTMLInputElement>('input[type="radio"]')!.disabled).toBe(false);
		expect(mount.querySelector<HTMLInputElement>('input[type="number"]')!.disabled).toBe(false);
		expect(mount.querySelector('button')!.disabled).toBe(false);
		expect(mount.textContent).toContain(outcome === 'resolve' ? 'Saved for the next session' : 'Could not save');
	});

	it.each(['resolve', 'reject'] as const)('restores the visible preparation editor after a pending save and repaint (%s)', async (outcome) => {
		const mount = container();
		let resolve!: () => void;
		let reject!: (reason: Error) => void;
		const save = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
		const editor = new FarmingPreparationPanel({ ...preparationPorts('en'), save: () => save });
		editor.render(mount);
		Array.from(mount.querySelectorAll('button')).find((button) => button.textContent === 'Save')!.click();
		editor.render(mount);
		expect(mount.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);
		expect(mount.textContent).toContain('Saving…');
		if (outcome === 'resolve') resolve(); else reject(new Error('private path'));
		await Promise.resolve();
		expect(mount.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
		expect(mount.textContent).toContain(outcome === 'resolve' ? 'Saved for the next session' : 'Could not save');
	});

	it('refreshes reminder actions, countdowns and API facts without replacing a preference draft', () => {
		const mount = container();
		document.body.append(mount);
		const ports = preparationPorts('en');
		let now = observation.now;
		let context: FarmingPreparationContext = ports.context();
		let reminders: FarmingManualReminder[] = [];
		const panel = new FarmingPreparationPanel({ ...ports, now: () => now, context: () => context,
			reminders: () => reminders,
			startReminder: (kind, durationMinutes) => { reminders = [{ kind, durationMinutes, startedAt: now }]; },
			clearReminder: (kind) => { reminders = reminders.filter((reminder) => reminder.kind !== kind); },
		});
		panel.render(mount);
		const bonus = mount.querySelector<HTMLInputElement>('input[type="number"]')!;
		bonus.value = '17';
		bonus.focus();
		const food = mount.querySelector<HTMLInputElement>('input[aria-label^="Food"]')!;
		food.value = '30';
		const action = Array.from(mount.querySelectorAll('button')).find((button) => button.textContent === 'Start reminder')!;
		action.click();
		expect(action.textContent).toBe('Clear reminder');
		expect(mount.textContent).toContain('30:00');
		now = '2026-10-06T10:25:00Z';
		context = { ...context, freeBagSlots: 5, freeBagSlotsObservedAt: observation.observedAt, characterName: 'New Farmer' };
		panel.refreshReadOnly(mount);
		expect(mount.textContent).toContain('25:00');
		expect(mount.textContent).toContain('New Farmer');
		expect(mount.textContent).toContain('5:00');
		expect(mount.querySelector('input[type="number"]')).toBe(bonus);
		expect(bonus.value).toBe('17');
		expect(food.value).toBe('30');
		expect(document.activeElement).toBe(bonus);
		now = '2026-10-06T11:00:00Z';
		panel.refreshReadOnly(mount);
		expect(mount.textContent).toContain('Reminder due');
		action.click();
		expect(action.textContent).toBe('Start reminder');
		expect(reminders).toHaveLength(0);
		expect(mount.textContent).not.toContain('Reminder due');
		mount.remove();
	});

	it.each(['es', 'en'] as const)('labels current-character bags separately from the captured character/build/MF in %s', (locale) => {
		const mount = container();
		const ports = preparationPorts(locale);
		const panel = new FarmingPreparationPanel({ ...ports, context: () => ({ ...ports.context(),
			characterName: 'Captured Farmer', buildName: 'Captured build',
			freeBagSlots: 5, freeBagSlotsCharacter: 'Current Farmer', freeBagSlotsObservedAt: observation.observedAt,
		}) });
		panel.render(mount);
		const slotsLabel = locale === 'es' ? 'Huecos libres en las bolsas del personaje' : 'Free character bag slots';
		const terms = Array.from(mount.querySelectorAll('dt'));
		const slots = terms.find((term) => term.textContent === `${slotsLabel} · Current Farmer`)!;
		expect(slots.nextElementSibling?.textContent).toBe('5');
		expect(terms.some((term) => term.textContent === `${slotsLabel} · Captured Farmer`)).toBe(false);
		expect(terms.some((term) => term.textContent?.startsWith(`${slotsLabel} · Current Farmer ·`))).toBe(true);
		expect(mount.textContent).toContain('Captured Farmer');
		expect(mount.textContent).toContain('Captured build');
		expect(mount.textContent).toContain('370%');
	});

	it.each(['es', 'en'] as const)('keeps preparation off, blank unknown manual inputs and no timer on render in %s', (locale) => {
		const mount = container();
		const ports = preparationPorts(locale);
		new FarmingPreparationPanel(ports).render(mount);
		expect(mount.querySelector('details')?.open).toBe(false);
		expect(mount.querySelector<HTMLElement>('.tyrian-farming__preparation')?.hidden).toBe(true);
		expect(mount.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('');
		expect(ports.startReminder).not.toHaveBeenCalled();
	});

	it('records explicit manual zero, starts a manual reminder only on click and shows partial MF', async () => {
		const mount = container();
		const ports = preparationPorts('en');
		new FarmingPreparationPanel(ports).render(mount);
		const enabled = mount.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		enabled.checked = true;
		enabled.dispatchEvent(new Event('change'));
		const inputs = mount.querySelectorAll<HTMLInputElement>('input[type="number"]');
		inputs[0]!.value = '0';
		inputs[1]!.value = '30';
		const start = Array.from(mount.querySelectorAll('button')).find((button) => button.textContent === 'Start reminder')!;
		start.click();
		expect(ports.startReminder).toHaveBeenCalledWith('food', 30);
		expect(start.title).toContain('does not detect');
		const save = Array.from(mount.querySelectorAll('button')).find((button) => button.textContent === 'Save')!;
		save.click();
		await Promise.resolve();
		expect(ports.save).toHaveBeenCalledWith({ version: 1, enabled: true, manualMagicFindBonus: 0, foodReminderMinutes: 30, utilityReminderMinutes: null });
		expect(mount.textContent).toContain('Magic Find · Partial');
		expect(mount.textContent).toContain('370%');
	});
});

function preparationPorts(locale: 'es' | 'en') {
	return {
		settings: () => ({ ...DEFAULT_FARMING_PREPARATION }),
		context: () => ({ characterName: 'Farmer', buildName: '', freeBagSlots: null, collectorMode: 'consult',
			addonConnection: 'disconnected', magicFindBreakdown: { luck: 300, achievements: 50, enrichment: 20 },
			magicFindObservedAt: null }),
		reminders: () => [], now: () => observation.now, locale: () => locale,
		save: vi.fn(async () => {}), startReminder: vi.fn(), clearReminder: vi.fn(),
	} satisfies FarmingPreparationPanelPorts;
}
