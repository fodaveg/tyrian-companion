import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import type { SessionTradingPostContaminationProposal } from '../sessions/session-contamination-review';
import { SessionContaminationReviewModal } from './companion-view';

describe('SessionContaminationReviewModal Trading Post evidence', () => {
	it('announces loading, partial, empty and error states without changing the review', async () => {
		let resolve!: (proposal: SessionTradingPostContaminationProposal) => void;
		const pending = new Promise<SessionTradingPostContaminationProposal>((settle) => { resolve = settle; });
		const loading = mount(() => pending);
		expect(loading.text()).toContain('Checking recent Trading Post history…');
		expect(loading.status()?.attributes.get('aria-live')).toBe('polite');
		resolve({ status: 'unavailable', reason: 'coverage_incomplete', requiresHumanReview: true, suggestedActivities: [] });
		await flush();
		expect(loading.text()).toContain('Trading Post history is incomplete');
		expect(loading.checkedActivities()).toEqual([]);

		const empty = mount(async () => ready([]));
		await flush();
		expect(empty.text()).toContain('Complete history suggests no purchases or sales');

		const unavailable = mount(async () => ({
			status: 'unavailable', reason: 'capture_unavailable', requiresHumanReview: true, suggestedActivities: [],
		}));
		await flush();
		expect(unavailable.text()).toContain('Trading Post history could not be checked');

		const rejected = mount(async () => { throw new Error('offline'); });
		await flush();
		expect(rejected.text()).toContain('Trading Post history could not be checked');
	});

	it('keeps multiple proposals inert until the user accepts or dismisses them', async () => {
		const accepted = mount(async () => ready(['tpBuy', 'tpSell'], 12, 34));
		await flush();
		expect(accepted.text()).toContain('12 completed purchase(s) detected');
		expect(accepted.text()).toContain('34 completed sale(s) detected');
		expect(accepted.checkedActivities()).toEqual([]);
		expect(accepted.submit).not.toHaveBeenCalled();

		accepted.button('Mark suggested activities').dispatch('click');
		expect(accepted.checkedActivities()).toEqual(['tpBuy', 'tpSell']);
		expect(accepted.text()).toContain('Suggestions marked. You can still change them before saving.');
		expect(accepted.submit).not.toHaveBeenCalled();

		const dismissed = mount(async () => ready(['tpBuy'], 1, 0));
		await flush();
		dismissed.button('Ignore suggestions').dispatch('click');
		expect(dismissed.checkedActivities()).toEqual([]);
		expect(dismissed.text()).toContain('Suggestions ignored. The review remains under your control.');
		expect(dismissed.submit).not.toHaveBeenCalled();
	});
});

function mount(load: () => Promise<SessionTradingPostContaminationProposal>) {
	const root = new FakeElement('div');
	const submit = vi.fn(async () => null);
	const modal = new SessionContaminationReviewModal({} as App, null, load, submit, () => undefined, () => 'en');
	Object.assign(modal, { contentEl: root, setTitle: vi.fn() });
	modal.onOpen();
	return {
		submit,
		text: () => text(root),
		status: () => walk(root).find((element) => element.attributes.get('role') === 'status'),
		button: (label: string) => {
			const button = walk(root).find((element) => element.tagName === 'BUTTON' && element.textContent === label);
			if (!button) throw new Error(`Expected button: ${label}`);
			return button;
		},
		checkedActivities: () => walk(root)
			.filter((element) => element.tagName === 'LABEL' && element.children[0]?.checked)
			.map((element) => element.textContent)
			.filter((label) => label === 'Buy on the Trading Post' || label === 'Sell on the Trading Post')
			.map((label) => label === 'Buy on the Trading Post' ? 'tpBuy' : 'tpSell'),
	};
}

function ready(
	suggestedActivities: Array<'tpBuy' | 'tpSell'>,
	buys = 0,
	sells = 0,
): SessionTradingPostContaminationProposal {
	return { status: 'ready', requiresHumanReview: true, suggestedActivities, eventCounts: { buys, sells } };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
	readonly tagName: string;
	textContent = '';
	checked = false;
	disabled = false;
	id = '';
	type = '';

	constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }

	createEl(tagName: string, options: {
		text?: string; type?: string; cls?: string; attr?: Record<string, string>;
	} = {}): FakeElement {
		const child = new FakeElement(tagName);
		child.textContent = options.text ?? '';
		child.type = options.type ?? '';
		if (options.cls) child.attributes.set('class', options.cls);
		for (const [name, value] of Object.entries(options.attr ?? {})) child.attributes.set(name, value);
		this.children.push(child);
		return child;
	}

	createDiv(options: { cls?: string } = {}): FakeElement {
		const child = new FakeElement('div');
		if (options.cls) child.attributes.set('class', options.cls);
		this.children.push(child);
		return child;
	}
	appendText(value: string): void { this.textContent += value; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	focus(): void {}
	addEventListener(name: string, listener: (event: { preventDefault(): void }) => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
	}
	dispatch(name: string): void {
		for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault: () => undefined });
	}
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function text(root: FakeElement): string {
	return walk(root).map((element) => element.textContent).filter(Boolean).join(' ');
}
