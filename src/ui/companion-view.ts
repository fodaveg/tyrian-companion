import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export interface ConnectionActions {
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
}

export class TyrianCompanionView extends ItemView {
	private countdownInterval: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly connection: ConnectionActions,
	) {
		super(leaf);
	}

	getViewType(): string {
		return COMPANION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Tyrian companion';
	}

	getIcon(): string {
		return 'compass';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.clearCountdown();
	}

	render(): void {
		this.clearCountdown();
		const { contentEl } = this;
		const state = this.connection.getConnectionState();

		contentEl.empty();
		contentEl.addClass('tyrian-companion-view');
		contentEl.createEl('h2', { text: 'Tyrian companion' });

		const status = contentEl.createDiv({ cls: 'tyrian-companion-view__status' });
		status.setAttr('role', state.status === 'error' ? 'alert' : 'status');
		status.setAttr('aria-live', 'polite');
		this.renderState(status, state);

		const checkButton = contentEl.createEl('button', {
			text: state.status === 'checking' ? 'Checking…' : 'Check connection',
			cls: 'mod-cta',
		});
		const retryAt = getRetryAt(state);
		checkButton.disabled = state.status === 'checking' || isCoolingDown(retryAt);
		checkButton.addEventListener('click', () => {
			void this.checkConnection();
		});
		if (isCoolingDown(retryAt)) {
			this.countdownInterval = contentEl.win.setInterval(() => this.render(), 1_000);
		}

		contentEl.createEl('h3', { text: 'Modules' });
		const modules = contentEl.createEl('ul', { cls: 'tyrian-companion-view__modules' });
		for (const moduleName of ['Account', 'Advisor', 'Sessions', 'Objectives']) {
			modules.createEl('li', { text: moduleName });
		}
	}

	private async checkConnection(): Promise<void> {
		const check = this.connection.checkConnection();
		this.render();
		await check;
		this.render();
	}

	private renderState(container: HTMLElement, state: ConnectionState): void {
		if (state.status === 'idle') {
			container.createEl('h3', { text: 'Not checked' });
			container.createEl('p', { text: 'No network request has been made.' });
			return;
		}
		if (state.status === 'checking') {
			container.createEl('h3', { text: 'Checking connection' });
			container.createEl('p', { text: 'Verifying the selected API key and account.' });
			return;
		}
		if (state.status === 'error') {
			container.createEl('h3', { text: 'Connection failed' });
			container.createEl('p', { text: state.message });
			if (isCoolingDown(state.retryAt)) {
				container.createEl('p', {
					text: cooldownText(state.retryAt),
				});
			}
			return;
		}

		container.createEl('h3', {
			text: state.status === 'warning' ? 'Connected with warnings' : 'Connected',
		});
		if (state.status === 'warning') {
			container.createEl('p', { text: state.message });
			if (isCoolingDown(state.retryAt)) {
				container.createEl('p', { text: cooldownText(state.retryAt) });
			}
		}
		const details = container.createEl('dl');
		addDetail(details, 'Account', state.details.account.name);
		addDetail(details, 'API key name', state.details.keyName);
		addDetail(details, 'Permissions', state.details.scopes.join(', '));
		if (state.details.missingRecommendedScopes.length > 0) {
			addDetail(
				details,
				'Missing future permissions',
				state.details.missingRecommendedScopes.join(', '),
			);
		}
		if (state.details.hasFutureUrlRestrictions) {
			addDetail(details, 'Future URL access', 'Restricted by this subtoken');
		}
	}

	private clearCountdown(): void {
		if (this.countdownInterval !== null) {
			this.contentEl.win.clearInterval(this.countdownInterval);
			this.countdownInterval = null;
		}
	}
}

function addDetail(list: HTMLDListElement, term: string, detail: string): void {
	list.createEl('dt', { text: term });
	list.createEl('dd', { text: detail });
}

function isCoolingDown(retryAt: number | null): retryAt is number {
	return retryAt !== null && retryAt > Date.now();
}

function cooldownText(retryAt: number): string {
	return `Try again in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000))} seconds.`;
}
