// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { projectFarmingGoal, type FarmingGoalV1 } from '../sessions/farming-goal';
import { DEFAULT_FARMING_PREPARATION } from '../sessions/farming-goal-preparation';
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
