import { describe, expect, it, vi } from 'vitest';
import { createTranslator, type TranslationKey } from '../core/i18n';
import type { HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenComparisonRecordV2 } from '../halloween/halloween-loot-comparison';
import type { HalloweenPriceNoticeV1 } from '../halloween/halloween-price-alert';
import { renderHalloweenAlertPanel } from './halloween-alert-panel';

describe('Halloween alert panel DOM', () => {
	it('renders disabled without running effects and uses semantic status/label nodes', () => {
		const mount = new FakeElement('div');
		const acknowledge = vi.fn();
		renderHalloweenAlertPanel(mount as unknown as HTMLElement, {
			getHalloweenState: () => ({ status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null }),
			acknowledgeHalloweenNotice: acknowledge,
			getHalloweenPriceAlertState: disabledPriceState,
			acknowledgeHalloweenPriceNotice: vi.fn(async () => false),
		}, translator('en'));
		expect(acknowledge).not.toHaveBeenCalled();
		const all = walk(mount);
		expect(all.find(({ tag }) => tag === 'section')?.attributes.get('aria-label')).toBe('Halloween alert inbox');
		expect(all.find(({ role }) => role === 'status')?.attributes.get('aria-live')).toBe('polite');
		expect(all.map(({ text }) => text).join(' ')).toContain('does not open IndexedDB');
		const disclosure = all.find(({ tag }) => tag === 'details');
		expect(disclosure?.open).toBe(false);
		expect(all.map(({ text }) => text).join(' ')).toContain('Halloween · optional event');
	});

	it('keeps 400 ids, long/unknown names, large quantities and combined reasons reviewable', async () => {
		const mount = new FakeElement('div');
		const items = Array.from({ length: 400 }, (_, index) => ({
			itemId: index + 1, quantity: Number.MAX_SAFE_INTEGER - index,
			name: index === 0 ? 'A'.repeat(256) : index === 1 ? null : `Item ${String(index + 1)}`,
			reasons: index === 0 ? [
				{ code: 'valuable' as const, netUnitCopper: 10_000, thresholdCopper: 10_000 },
				{ code: 'first_seen' as const },
			] : [{ code: 'first_seen' as const }],
		}));
		const notice: HalloweenNoticeV1 = {
			version: 1, vaultId: 'vault', accountRef: 'account', noticeId: 'notice', episodeId: 'episode',
			observedAt: '2026-08-29T12:00:00.000Z', source: 'assisted_poll', wording: 'observed_change',
			coverage: 'partial', items, acknowledgedAt: null,
		};
		const acknowledge = vi.fn(async () => true);
		renderHalloweenAlertPanel(mount as unknown as HTMLElement, {
			getHalloweenState: () => ({ status: 'unread', notices: [notice], unreadCount: 1, lastObservedAt: notice.observedAt, comparison: null }),
			acknowledgeHalloweenNotice: acknowledge,
			getHalloweenPriceAlertState: disabledPriceState,
			acknowledgeHalloweenPriceNotice: vi.fn(async () => false),
		}, translator('en'));
		const all = walk(mount);
		expect(all.find(({ tag }) => tag === 'section')?.attributes.get('data-attention')).toBe('true');
		expect(all.some(({ tag }) => tag === 'details')).toBe(false);
		expect(all.filter(({ tag }) => tag === 'article')).toHaveLength(1);
		expect(all.filter(({ tag }) => tag === 'strong')).toHaveLength(400);
		expect(all.map(({ text }) => text).join('\n')).toContain('Item #2');
		expect(all.map(({ text }) => text).join('\n')).toContain(String(Number.MAX_SAFE_INTEGER));
		const button = all.find(({ tag }) => tag === 'button');
		button?.dispatch('click');
		await Promise.resolve();
		expect(acknowledge).toHaveBeenCalledWith('notice');
		expect(button?.disabled).toBe(true);
	});

	it('renders all 18 comparison rows and a quantity-free price notice with accessible table semantics', () => {
		const mount = new FakeElement('div');
		const comparison: HalloweenComparisonRecordV2 = {
			version: 2, modelId: 'halloween-trick-or-treat-bag-conservative', modelVersion: 1,
			vaultId: 'vault', accountRef: 'account', episodeId: 'episode',
			observedAt: '2026-08-31T12:00:00.000Z', eligible: true, reason: null,
			bagsDisappearedNet: 1_100, minimumBags: 1_100, globalPearsonMilli: '0',
			outcomes: Array.from({ length: 18 }, (_, index) => ({
				itemId: index + 1, name: index === 0 ? 'A'.repeat(256) : `Outcome ${String(index + 1)}`,
				observedUnits: Number.MAX_SAFE_INTEGER - index, expectedSampleUnits: index + 1, expectedSampleBags: 106_264,
				expectedNumerator: String((index + 1) * 1_100), differenceNumerator: '0',
				differenceBasisPoints: 0, zMilli: 0, deviates: index === 17,
			})),
		};
		const price: HalloweenPriceNoticeV1 = {
			version: 1, vaultId: 'vault', accountRef: 'account', noticeId: 'price', itemId: 36_038,
			observedAt: '2026-08-31T12:00:00.000Z', dayUtc: '2026-08-31', wording: 'bid_above_local_p90',
			bidCopper: 1_234, p90Copper: 1_000, referenceDays: 30, capturedAtMs: Date.parse('2026-08-31T12:00:00.000Z'),
			minimumAboveP90Bps: 0, cooldownHours: 24, acknowledgedAt: null,
		};
		renderHalloweenAlertPanel(mount as unknown as HTMLElement, {
			getHalloweenState: () => ({ status: 'ready', notices: [], unreadCount: 0,
				lastObservedAt: comparison.observedAt, comparison }),
			acknowledgeHalloweenNotice: vi.fn(async () => false),
			getHalloweenPriceAlertState: () => ({ status: 'unread', projection: null, notices: [price], unreadCount: 1 }),
			acknowledgeHalloweenPriceNotice: vi.fn(async () => true),
		}, translator('en'));
		const all = walk(mount);
		expect(all.filter(({ tag }) => tag === 'tbody')[0]?.children).toHaveLength(18);
		expect(all.find(({ tag }) => tag === 'caption')?.text).toContain('18 curated outcomes');
		expect(all.map(({ text }) => text).join(' ')).toContain('provisional bid close: 1234 copper');
		expect(all.map(({ text }) => text).join(' ')).not.toContain('Quantity:');
		expect(all.filter(({ tag }) => tag === 'th').every(({ attributes }) => attributes.get('scope') !== undefined)).toBe(true);
	});
});

function translator(locale: 'es' | 'en'): (key: string, params?: Record<string, string | number>) => string {
	const t = createTranslator(locale);
	return (key, params) => t.t(key as TranslationKey, params);
}
function disabledPriceState() { return { status: 'disabled' as const, projection: null, notices: [], unreadCount: 0 }; }
function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	readonly classes = new Set<string>();
	text = ''; role = ''; disabled = false; tabIndex = 0; open = false;
	constructor(readonly tag: string) {}
	createEl(tag: string, options: { text?: string; cls?: string } = {}): FakeElement {
		const child = new FakeElement(tag); child.text = options.text ?? ''; if (options.cls) child.classes.add(options.cls); this.children.push(child); return child;
	}
	createSpan(options: { text?: string; cls?: string } = {}): FakeElement {
		const child = new FakeElement('span'); child.text = options.text ?? '';
		if (options.cls) child.classes.add(options.cls); this.children.push(child); return child;
	}
	createDiv(options: { text?: string; cls?: string } = {}): FakeElement {
		const child = new FakeElement('div'); child.text = options.text ?? '';
		if (options.cls) child.classes.add(options.cls); this.children.push(child); return child;
	}
	setAttr(name: string, value: string): void { this.attributes.set(name, value); if (name === 'role') this.role = value; }
	setText(value: string): void { this.text = value; }
	addClass(value: string): void { this.classes.add(value); }
	toggleClass(value: string, enabled: boolean): void { if (enabled) this.classes.add(value); else this.classes.delete(value); }
	addEventListener(type: string, listener: () => void): void { const all = this.listeners.get(type) ?? []; all.push(listener); this.listeners.set(type, all); }
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	focus(): void { /* test double */ }
}
