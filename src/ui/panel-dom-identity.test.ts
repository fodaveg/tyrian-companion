// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { installDomHelpers } from '../host/dom-polyfill';
import { emptyFarmingIngameState } from '../alerts/farming-ingame-state';
import type { FarmingGoalProgress } from '../sessions/farming-goal';
import { DEFAULT_FARMING_PREPARATION, type FarmingManualReminder, type FarmingPreparationContext } from '../sessions/farming-goal-preparation';
import type { LiveComparisonConditions, LiveComparisonGroup, LiveComparisonRow, LiveSessionComparisonView } from '../sessions/live-session-comparison';
import { FarmingDeclaredBuildEditor } from './farming-declared-build-editor';
import { FarmingGoalEditor, renderFarmingGoalProgress } from './farming-goal-panel';
import { FarmingPreparationPanel, type FarmingPreparationPanelPorts } from './farming-preparation-panel';
import { FarmingSessionPanel, type FarmingSessionPanelActions } from './farming-session-panel';
import { LiveSessionComparisonPanel } from './live-session-comparison-panel';
import { CoinFigure } from './live-session-money';
import { paintLiveSessionSetAside } from './live-session-set-aside-notice';

/*
 * DE-04/DE-10/DE-13 (audit 10 oct 2026): these panels moved from `document.createElement` to
 * Obsidian's `parent.createEl(...)` (polyfilled in Hebra by `src/host/dom-polyfill.ts`). The
 * snapshots were recorded BEFORE that change, so a different tag, class, attribute (or attribute
 * order) or child order is a red here, not a silent visual change.
 */
beforeAll(() => { installDomHelpers(window); });

function mount(): HTMLDivElement {
	const container = document.createElement('div');
	document.body.append(container);
	return container;
}

const NOW = '2026-10-06T10:20:00Z';

function progress(overrides: Partial<FarmingGoalProgress>): FarmingGoalProgress {
	return {
		goal: { version: 1, kind: 'bags', targetBags: 1_000 }, status: 'in_progress', observedBags: 200, finalNetBags: null,
		totalObtained: 'unobservable', elapsedMs: 1_200_000, progressRatio: 0.2, remainingMs: 4_800_000, remainingKind: 'estimate',
		etaUnavailableReason: null, observedAt: NOW, ...overrides,
	};
}

describe('farming goal progress DOM', () => {
	it.each([
		['bags in progress', 'es', progress({})],
		['bags reached with a net', 'en', progress({ status: 'reached', observedBags: 1_000, finalNetBags: 980, progressRatio: 1, remainingMs: null, remainingKind: null })],
		['duration countdown', 'en', progress({ goal: { version: 1, kind: 'duration', targetDurationMs: 3_600_000 }, remainingKind: 'countdown', remainingMs: 2_400_000, progressRatio: 1 / 3 })],
		['unavailable with a reason', 'es', progress({ elapsedMs: null, observedBags: null, progressRatio: null, remainingMs: null, remainingKind: null, etaUnavailableReason: 'stale_observation' })],
		['unavailable without a reason', 'en', progress({ remainingMs: null, remainingKind: null, etaUnavailableReason: null })],
		['no goal', 'en', progress({ goal: { version: 1, kind: 'none' }, status: 'none' })],
	] as const)('%s', (_name, locale, value) => {
		const container = mount();
		renderFarmingGoalProgress(container, value, locale);
		expect(container.outerHTML).toMatchSnapshot();
	});
});

describe('farming goal editor DOM', () => {
	it.each([
		['none', 'es', { version: 1, kind: 'none' }],
		['bags', 'en', { version: 1, kind: 'bags', targetBags: 750 }],
		['duration', 'es', { version: 1, kind: 'duration', targetDurationMs: 5_400_000 }],
	] as const)('%s', (_name, locale, goal) => {
		const container = mount();
		new FarmingGoalEditor({ value: () => goal, save: vi.fn(async () => {}), locale: () => locale }).render(container);
		expect(container.outerHTML.replace(/tyrian-farming-goal-\d+/g, 'tyrian-farming-goal-N')).toMatchSnapshot();
	});

	it('after an invalid save', () => {
		const container = mount();
		new FarmingGoalEditor({ value: () => ({ version: 1, kind: 'bags', targetBags: 10 }), save: vi.fn(async () => {}), locale: () => 'en' }).render(container);
		container.querySelector<HTMLInputElement>('input[type="number"]')!.value = '-3';
		container.querySelector('button')!.click();
		expect(container.outerHTML.replace(/tyrian-farming-goal-\d+/g, 'tyrian-farming-goal-N')).toMatchSnapshot();
	});
});

function preparationPorts(overrides: Partial<FarmingPreparationPanelPorts> = {}): FarmingPreparationPanelPorts {
	const reminders: FarmingManualReminder[] = [{ kind: 'food', startedAt: '2026-10-06T10:00:00Z', durationMinutes: 30 }];
	const context: FarmingPreparationContext = {
		characterName: 'Character', buildName: '', freeBagSlots: 1_234, freeBagSlotsCharacter: 'Other', freeBagSlotsObservedAt: '2026-10-06T10:15:00Z',
		collectorMode: 'collector', addonConnection: 'connected', magicFindBreakdown: { luck: 300, achievements: 50, enrichment: 1 },
		magicFindObservedAt: '2026-10-06T10:10:00Z',
	};
	return {
		settings: () => ({ ...DEFAULT_FARMING_PREPARATION, enabled: true, manualMagicFindBonus: 25, foodReminderMinutes: 30, utilityReminderMinutes: null }),
		context: () => context, reminders: () => reminders, now: () => NOW, locale: () => 'es',
		save: vi.fn(async () => {}), startReminder: vi.fn(), clearReminder: vi.fn(), ...overrides,
	};
}

describe('farming preparation DOM', () => {
	it('enabled, with facts and an active reminder', () => {
		const container = mount();
		new FarmingPreparationPanel(preparationPorts()).render(container);
		expect(container.outerHTML).toMatchSnapshot();
	});

	it('disabled, unknown facts, in English', () => {
		const container = mount();
		new FarmingPreparationPanel(preparationPorts({
			settings: () => ({ ...DEFAULT_FARMING_PREPARATION }), reminders: () => [], locale: () => 'en',
			context: () => ({ characterName: null, buildName: null, freeBagSlots: null, collectorMode: 'consult', addonConnection: 'unknown', magicFindBreakdown: null, magicFindObservedAt: null }),
		})).render(container);
		expect(container.outerHTML).toMatchSnapshot();
	});

	it('after an invalid reminder', () => {
		const container = mount();
		new FarmingPreparationPanel(preparationPorts({ reminders: () => [] })).render(container);
		container.querySelectorAll('button')[1]!.click();
		expect(container.outerHTML).toMatchSnapshot();
	});
});

describe('declared build editor DOM', () => {
	it.each([
		['empty', 'es', null],
		['malformed', 'en', { version: 99 }],
		['unsupported text', 'es', { version: 1, templateCode: '[&not a template]', label: 'Label' }],
	] as const)('%s', (_name, locale, saved) => {
		const editor = new FarmingDeclaredBuildEditor(document, {
			getLocale: () => locale, getFarmingDeclaredBuildPreference: () => saved, saveFarmingDeclaredBuildPreference: vi.fn(async () => {}),
		});
		expect(editor.element.outerHTML).toMatchSnapshot();
	});
});

const CONDITIONS: LiveComparisonConditions = {
	playerBuild: { identity: 'id', source: 'manual_template', label: 'Label', profession: 'Ranger', templateCode: '[&DQ==]' },
	groupContext: 'with_bosses', presenceScope: 'pure_labyrinth', magicFind: { value: 351, source: 'manual', manualBonus: 25 },
};
const GROUP: LiveComparisonGroup = {
	conditions: CONDITIONS, completedSessions: 3, eligibleSessions: 2, connectionMs: 3_600_000, observedItemsMs: 3_000_000,
	positiveBags: 120, negativeBags: 4, netBags: 116, status: 'ready', bagsPerHourMilli: 116_000, minimumBagsPerHourMilli: 100_500,
	maximumBagsPerHourMilli: 130_250, gapCount: 1, knownItemValueCopper: 123_456, unpricedItemCount: 2, goldPerHourCopper: null,
};
const ROW: LiveComparisonRow = {
	startedAt: '2026-10-06T09:00:00Z', endedAt: null, connectionMs: 600_000, observedItemsMs: 540_000, observedCurrenciesMs: 0,
	positiveBags: 10, negativeBags: null, netBags: null, bagsPerHourMilli: null, gapCount: 0, knownItemValueCopper: null, unpricedItemCount: 0,
	conditions: { ...CONDITIONS, playerBuild: null, groupContext: null, presenceScope: 'unknown', magicFind: { value: null, source: 'unknown', manualBonus: null } },
};
const READY: LiveSessionComparisonView = {
	history: {
		status: 'ready', ignored: 0,
		setAside: [{ path: 'Sessions/a.md', reason: 'newer_version' }, { path: 'Sessions/b.md', reason: 'unreadable' }],
		comparison: { source: 'nexus_inventory', completedSessions: 4, rows: [], groups: [
			GROUP, { ...GROUP, conditions: { ...CONDITIONS, playerBuild: null }, status: 'insufficient_sample', minimumBagsPerHourMilli: null, knownItemValueCopper: null },
		] },
	},
	provisional: ROW,
};

describe('live session comparison DOM', () => {
	it.each([
		['idle', 'en', { history: { status: 'idle' }, provisional: null }],
		['ready with groups, provisional and set-aside notes', 'es', READY],
		['ready and empty', 'en', { history: { status: 'ready', ignored: 0, setAside: [], comparison: { source: 'nexus_inventory', completedSessions: 0, rows: [], groups: [] } }, provisional: null }],
		['conflict', 'es', { history: { status: 'conflict', invalid: 1, duplicates: 2 }, provisional: null }],
	] as const)('%s', (_name, locale, view) => {
		const panel = new LiveSessionComparisonPanel(document, {
			getLocale: () => locale, getLiveSessionComparison: () => view, loadLiveSessionComparison: vi.fn(async () => {}),
		});
		expect(panel.element.outerHTML).toMatchSnapshot();
	});

	it('second page of 25 groups', () => {
		const groups = Array.from({ length: 25 }, (_, index) => ({ ...GROUP, completedSessions: index + 1 }));
		const view: LiveSessionComparisonView = { history: { status: 'ready', ignored: 0, setAside: [], comparison: { source: 'nexus_inventory', completedSessions: 25, rows: [], groups } }, provisional: null };
		const panel = new LiveSessionComparisonPanel(document, { getLocale: () => 'en', getLiveSessionComparison: () => view, loadLiveSessionComparison: vi.fn(async () => {}) });
		panel.element.querySelectorAll<HTMLButtonElement>('.tyrian-live-session__toolbar button')[2]!.click();
		expect(panel.element.outerHTML).toMatchSnapshot();
	});
});

describe('farming session panel DOM', () => {
	function actions(overrides: Partial<FarmingSessionPanelActions> = {}): FarmingSessionPanelActions {
		return {
			getLocale: () => 'en', getFarmingGoal: () => ({ version: 1, kind: 'bags', targetBags: 1_000 }), saveFarmingGoal: vi.fn(async () => {}),
			getFarmingGoalProgress: () => progress({}), getFarmingGroupContext: () => 'without_bosses', setFarmingGroupContext: vi.fn(),
			getFarmingPreparationSettings: () => ({ ...DEFAULT_FARMING_PREPARATION, enabled: true }), saveFarmingPreparationSettings: vi.fn(async () => {}),
			getFarmingPreparationContext: () => ({ characterName: 'Character', buildName: null, freeBagSlots: 8, collectorMode: 'collector', addonConnection: 'connected', magicFindBreakdown: null, magicFindObservedAt: null }),
			getFarmingReminders: () => [], startFarmingReminder: vi.fn(), clearFarmingReminder: vi.fn(),
			getFarmingIngameState: () => ({ ...emptyFarmingIngameState(), phase: 'active', observed: 200, net: 12, age: 300, slots: 8, slotAge: 600 }),
			...overrides,
		};
	}

	it('minimal, in English', () => {
		const panel = new FarmingSessionPanel(document, actions());
		expect(panel.element.outerHTML.replace(/tyrian-farming-goal-\d+/g, 'tyrian-farming-goal-N')).toMatchSnapshot();
	});

	it('with declared build and comparison, in Spanish', () => {
		const panel = new FarmingSessionPanel(document, actions({
			getLocale: () => 'es', getFarmingGoalProgress: () => null, getFarmingGroupContext: () => null,
			getFarmingDeclaredBuildPreference: () => null, saveFarmingDeclaredBuildPreference: vi.fn(async () => {}),
			getLiveSessionComparison: () => READY, loadLiveSessionComparison: vi.fn(async () => {}),
		}));
		expect(panel.element.outerHTML.replace(/tyrian-farming-goal-\d+/g, 'tyrian-farming-goal-N')).toMatchSnapshot();
	});
});

describe('set-aside notice and coin figure DOM', () => {
	it('names five paths per reason and counts the rest', () => {
		const target = mount();
		const setAside = [
			...Array.from({ length: 7 }, (_, index) => ({ path: `Sessions/new-${String(index)}.md`, reason: 'newer_version' as const })),
			{ path: 'Sessions/broken.md', reason: 'unreadable' as const },
		];
		paintLiveSessionSetAside(document, target, 'es', setAside);
		expect(target.outerHTML).toMatchSnapshot();
		paintLiveSessionSetAside(document, target, 'en', []);
		expect(target.outerHTML).toMatchSnapshot();
	});

	it.each([3_701, -12_345_678])('coin figure for %i copper', (copper) => {
		const figure = new CoinFigure(document);
		figure.set(copper, `spoken ${String(copper)}`);
		expect(figure.element.outerHTML).toMatchSnapshot();
	});
});
