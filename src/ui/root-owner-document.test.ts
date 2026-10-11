// @vitest-environment happy-dom
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import { installDomHelpers } from '../host/dom-polyfill';
import { emptyFarmingIngameState } from '../alerts/farming-ingame-state';
import { DEFAULT_FARMING_PREPARATION } from '../sessions/farming-goal-preparation';
import { FarmingDeclaredBuildEditor } from './farming-declared-build-editor';
import { FarmingSessionPanel, type FarmingSessionPanelActions } from './farming-session-panel';
import { LiveSessionComparisonPanel } from './live-session-comparison-panel';
import { CoinFigure } from './live-session-money';

/*
 * The four panel roots are built without `document.createElement` (catalog lint `prefer-create-el`),
 * through an empty fragment of the `document` they receive. A root made with the global `createEl` would
 * belong to the main window and be adopted when a popout window inserts it.
 */
function foreignDocument(): Document {
	const document = new Window().document as unknown as Document;
	installDomHelpers(document.defaultView ?? {});
	return document;
}

const sessionActions: FarmingSessionPanelActions = {
	getLocale: () => 'en', getFarmingGoal: () => ({ version: 1, kind: 'bags', targetBags: 1_000 }),
	saveFarmingGoal: vi.fn(async () => {}), getFarmingGoalProgress: () => null,
	getFarmingGroupContext: () => null, setFarmingGroupContext: vi.fn(),
	getFarmingPreparationSettings: () => ({ ...DEFAULT_FARMING_PREPARATION, enabled: true }),
	saveFarmingPreparationSettings: vi.fn(async () => {}),
	getFarmingPreparationContext: () => ({ characterName: 'Character', buildName: null, freeBagSlots: 8,
		collectorMode: 'collector', addonConnection: 'connected', magicFindBreakdown: null, magicFindObservedAt: null }),
	getFarmingReminders: () => [], startFarmingReminder: vi.fn(), clearFarmingReminder: vi.fn(),
	getFarmingIngameState: () => ({ ...emptyFarmingIngameState(), phase: 'active', observed: 200, slots: 8, age: 300, slotAge: 600 }),
};

describe('panel roots belong to the document they were given', () => {
	it('farming session panel', () => {
		const foreign = foreignDocument();
		const root = new FarmingSessionPanel(foreign, sessionActions).element;
		expect(root.ownerDocument).toBe(foreign);
		expect(root.ownerDocument).not.toBe(document);
	});
	it('declared build editor', () => {
		const foreign = foreignDocument();
		const root = new FarmingDeclaredBuildEditor(foreign, { getLocale: () => 'en', getFarmingDeclaredBuildPreference: () => null,
			saveFarmingDeclaredBuildPreference: vi.fn(async () => {}) }).element;
		expect(root.ownerDocument).toBe(foreign);
		expect(root.ownerDocument).not.toBe(document);
	});
	it('live comparison panel', () => {
		const foreign = foreignDocument();
		const root = new LiveSessionComparisonPanel(foreign, { getLocale: () => 'en',
			getLiveSessionComparison: () => ({ history: { status: 'idle' }, provisional: null }), loadLiveSessionComparison: vi.fn(async () => {}) }).element;
		expect(root.ownerDocument).toBe(foreign);
		expect(root.ownerDocument).not.toBe(document);
	});
	it('coin figure', () => {
		const foreign = foreignDocument();
		const root = new CoinFigure(foreign).element;
		expect(root.ownerDocument).toBe(foreign);
		expect(root.ownerDocument).not.toBe(document);
	});
});
