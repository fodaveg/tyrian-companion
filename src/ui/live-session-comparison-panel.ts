import { formatCopperVisual } from '../core/copper-format';
import type { LiveComparisonConditions, LiveComparisonGroup, LiveComparisonRow, LiveSessionComparisonView } from '../sessions/live-session-comparison';
import { formatFarmingTime } from './farming-goal-copy';
import { paintLiveSessionSetAside } from './live-session-set-aside-notice';
import { liveComparisonCopy, type LiveComparisonCopyKey } from './live-session-comparison-copy';

export interface LiveSessionComparisonActions {
	getLocale(): 'es' | 'en';
	getLiveSessionComparison(): LiveSessionComparisonView;
	loadLiveSessionComparison(): Promise<void>;
}
const PAGE_SIZE = 20;

/** Retained explicit-load controls compare saved Nexus evidence without resetting preparation drafts. */
export class LiveSessionComparisonPanel {
	readonly element: HTMLDetailsElement;
	private readonly loadButton: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly content: HTMLElement;
	private readonly provisional: HTMLElement;
	private readonly aside: HTMLElement;
	private readonly previous: HTMLButtonElement;
	private readonly next: HTMLButtonElement;
	private readonly pageLabel: HTMLElement;
	private working = false;
	private failed = false;
	private page = 0;
	private historyKey = '';

	constructor(private readonly document: Document, private readonly actions: LiveSessionComparisonActions) {
		this.element = document.createElement('details'); this.element.className = 'tyrian-live-comparison tyrian-live-session';
		this.element.append(this.node('summary', this.copy('title')), this.node('p', this.copy('limit')));
		this.loadButton = this.button(this.copy('load'), () => { void this.load(); });
		this.status = this.node('p'); this.status.setAttribute('role', 'status');
		this.provisional = this.node('div'); this.content = this.node('div');
		this.aside = this.node('div'); this.aside.setAttribute('role', 'status'); this.aside.hidden = true;
		const toolbar = this.node('div'); toolbar.className = 'tyrian-live-session__toolbar';
		this.previous = this.button(this.copy('previous'), () => { this.page = Math.max(0, this.page - 1); this.historyKey = ''; this.refresh(); });
		this.next = this.button(this.copy('next'), () => { this.page++; this.historyKey = ''; this.refresh(); });
		this.pageLabel = this.node('span'); toolbar.append(this.loadButton, this.previous, this.pageLabel, this.next);
		this.element.append(toolbar, this.status, this.aside, this.provisional, this.content); this.refresh();
	}
	refresh(): void {
		const { history, provisional } = this.actions.getLiveSessionComparison();
		const busy = this.working || history.status === 'loading';
		this.loadButton.setAttribute('aria-disabled', String(busy)); this.loadButton.setAttribute('aria-busy', String(busy));
		this.loadButton.textContent = this.copy(busy ? 'loading' : 'load');
		this.status.setAttribute('role', this.failed || history.status === 'conflict' || history.status === 'unavailable' ? 'alert' : 'status');
		this.status.textContent = this.failed ? this.copy('unavailable') : history.status === 'ready'
			? `${this.copy('finalCount')}: ${String(history.comparison.completedSessions)}` : this.copy(history.status === 'loading' ? 'loading' : history.status);
		paintLiveSessionSetAside(this.document, this.aside, this.actions.getLocale(), history.status === 'ready' ? history.setAside : []);
		this.provisional.replaceChildren();
		if (provisional) this.renderProvisional(provisional);
		const key = JSON.stringify([history, this.page]);
		if (key === this.historyKey) return;
		this.historyKey = key; this.content.replaceChildren();
		const groups = history.status === 'ready' ? history.comparison.groups : [];
		this.page = Math.min(this.page, Math.max(0, Math.ceil(groups.length / PAGE_SIZE) - 1));
		this.previous.disabled = this.page === 0; this.next.disabled = (this.page + 1) * PAGE_SIZE >= groups.length;
		this.pageLabel.textContent = groups.length === 0 ? '' : `${String(this.page * PAGE_SIZE + 1)}–${String(Math.min(groups.length, (this.page + 1) * PAGE_SIZE))} / ${String(groups.length)}`;
		if (history.status === 'ready' && groups.length === 0) this.content.append(this.node('p', this.copy('empty')));
		for (const group of groups.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) this.renderGroup(group);
	}
	private async load(): Promise<void> {
		if (this.working || this.actions.getLiveSessionComparison().history.status === 'loading') return;
		this.working = true; this.failed = false; this.refresh();
		try { await this.actions.loadLiveSessionComparison(); this.page = 0; }
		catch { this.failed = true; }
		finally { this.working = false; this.refresh(); }
	}
	private renderGroup(group: LiveComparisonGroup): void {
		const section = this.node('section'); section.append(this.node('h4', group.conditions.playerBuild === null ? this.copy('buildUnknown') : `${group.conditions.playerBuild.profession}${group.conditions.playerBuild.label === null ? '' : ` · ${group.conditions.playerBuild.label}`} · ${this.copy('buildManual')}`), this.node('p', this.conditions(group.conditions)));
		if (group.conditions.playerBuild !== null) {
			const template = this.node('details'); template.append(this.node('summary', this.copy('buildTemplate')), this.node('code', group.conditions.playerBuild.templateCode)); section.append(template);
		}
		const metrics = this.metrics(section);
		this.metric(metrics, 'finalCount', group.completedSessions); this.metric(metrics, 'eligible', group.eligibleSessions);
		this.metric(metrics, 'connection', this.time(group.connectionMs)); this.metric(metrics, 'coverage', this.time(group.observedItemsMs));
		this.metric(metrics, 'positive', group.positiveBags); this.metric(metrics, 'negative', group.negativeBags); this.metric(metrics, 'net', group.netBags);
		this.metric(metrics, 'rate', this.rate(group.bagsPerHourMilli));
		this.metric(metrics, 'gaps', group.gapCount);
		this.metric(metrics, 'knownValue', group.knownItemValueCopper === null ? null : formatCopperVisual(group.knownItemValueCopper));
		this.metric(metrics, 'partialPrices', group.unpricedItemCount);
		this.metric(metrics, 'range', group.minimumBagsPerHourMilli === null || group.maximumBagsPerHourMilli === null ? null
			: `${this.rate(group.minimumBagsPerHourMilli)}–${this.rate(group.maximumBagsPerHourMilli)}`);
		if (group.status !== 'ready') section.append(this.node('p', this.copy('minimum')));
		section.append(this.node('p', this.copy('gold'))); this.content.append(section);
	}
	private renderProvisional(row: LiveComparisonRow): void {
		this.provisional.append(this.node('h4', this.copy('provisional')), this.node('p', row.conditions.playerBuild === null ? this.copy('buildUnknown') : `${row.conditions.playerBuild.label ?? row.conditions.playerBuild.profession} · ${this.copy('buildManual')}`), this.node('p', this.conditions(row.conditions)));
		const metrics = this.metrics(this.provisional);
		this.metric(metrics, 'connection', this.time(row.connectionMs)); this.metric(metrics, 'coverage', this.time(row.observedItemsMs));
		this.metric(metrics, 'positive', row.positiveBags); this.metric(metrics, 'negative', row.negativeBags); this.metric(metrics, 'net', row.netBags);
		this.metric(metrics, 'gaps', row.gapCount); this.metric(metrics, 'knownValue', row.knownItemValueCopper === null ? null : formatCopperVisual(row.knownItemValueCopper));
		this.metric(metrics, 'partialPrices', row.unpricedItemCount);
	}
	private conditions(value: LiveComparisonConditions): string {
		return `${this.copy(value.groupContext ?? 'groupUnknown')} · ${this.copy(value.presenceScope)} · ${this.copy('magicFind')}: ${value.magicFind.value === null ? '—' : String(value.magicFind.value)} (${this.copy(value.magicFind.source === 'unknown' ? 'sourceUnknown' : value.magicFind.source)}) · ${this.copy('manualBonus')}: ${value.magicFind.manualBonus === null ? '—' : String(value.magicFind.manualBonus)}`;
	}
	private metrics(parent: HTMLElement): HTMLElement { const dl = this.node('dl'); dl.className = 'tyrian-live-session__metrics'; parent.append(dl); return dl; }
	private metric(parent: HTMLElement, key: LiveComparisonCopyKey, value: string | number | null): void { parent.append(this.node('dt', this.copy(key)), this.node('dd', value === null ? '—' : String(value))); }
	private time(value: number | null): string | null { return value === null ? null : formatFarmingTime(value); }
	private rate(value: number | null): string | null { return value === null ? null : (value / 1000).toLocaleString(this.actions.getLocale(), { maximumFractionDigits: 3 }); }
	private node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] { const node = this.document.createElement(tag); node.textContent = text; return node; }
	private button(text: string, action: () => void): HTMLButtonElement { const button = this.node('button', text); button.type = 'button'; button.addEventListener('click', action); return button; }
	private copy(key: LiveComparisonCopyKey): string { return liveComparisonCopy(this.actions.getLocale(), key); }
}
