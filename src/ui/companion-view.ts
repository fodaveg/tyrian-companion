import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
import type { SessionState } from '../sessions/session';
import type { SessionStartFailure } from '../sessions/manual-session-start-service';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export interface CompanionActions {
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
	getSessionState(): SessionState;
	getSessionStartFailure(): SessionStartFailure | null;
	openManualSessionStart(): void;
}

export class TyrianCompanionView extends ItemView {
	private countdownInterval: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly actions: CompanionActions,
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
		const connectionState = this.actions.getConnectionState();
		const sessionState = this.actions.getSessionState();

		contentEl.empty();
		contentEl.addClass('tyrian-companion-view');
		contentEl.createEl('h2', { text: 'Tyrian companion' });

		const status = contentEl.createDiv({ cls: 'tyrian-companion-view__status' });
		status.setAttr('role', connectionState.status === 'error' ? 'alert' : 'status');
		status.setAttr('aria-live', 'polite');
		this.renderConnectionState(status, connectionState);

		const checkButton = contentEl.createEl('button', {
			text: connectionState.status === 'checking' ? 'Checking…' : 'Check connection',
			cls: 'mod-cta',
		});
		const retryAt = getRetryAt(connectionState);
		checkButton.disabled = connectionState.status === 'checking' || isCoolingDown(retryAt);
		checkButton.addEventListener('click', () => {
			void this.checkConnection();
		});
		if (isCoolingDown(retryAt)) {
			this.countdownInterval = contentEl.win.setInterval(() => this.render(), 1_000);
		}

		this.renderSession(contentEl, connectionState, sessionState);

		contentEl.createEl('h3', { text: 'Modules' });
		const modules = contentEl.createEl('ul', { cls: 'tyrian-companion-view__modules' });
		for (const moduleName of ['Account', 'Advisor', 'Sessions', 'Objectives']) {
			modules.createEl('li', { text: moduleName });
		}
	}

	private async checkConnection(): Promise<void> {
		const check = this.actions.checkConnection();
		this.render();
		await check;
		this.render();
	}

	private renderConnectionState(container: HTMLElement, state: ConnectionState): void {
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

	private renderSession(
		container: HTMLElement,
		connection: ConnectionState,
		state: SessionState,
	): void {
		const card = container.createDiv({ cls: 'tyrian-companion-view__session' });
		card.setAttr('role', state.status === 'error' ? 'alert' : 'status');
		card.setAttr('aria-live', 'polite');
		card.createEl('h3', { text: 'Farming session' });

		if (state.status === 'idle') {
			card.createEl('p', { text: 'No farming session is active.' });
			const failure = this.actions.getSessionStartFailure();
			if (failure) card.createEl('p', { text: failure.message, cls: 'tyrian-companion-view__session-error' });
			const start = card.createEl('button', { text: 'Start session', cls: 'mod-cta' });
			const connected = connection.status === 'connected' || connection.status === 'warning';
			start.disabled = !connected;
			start.addEventListener('click', () => this.actions.openManualSessionStart());
			if (!connected) {
				card.createEl('p', {
					text: 'Check the account connection before starting.',
				});
			}
			return;
		}

		if (state.status === 'starting') {
			card.createEl('p', { text: 'Capturing a stable account baseline and active build…' });
			const button = card.createEl('button', { text: 'Starting…' });
			button.disabled = true;
			return;
		}

		const observed = state.status === 'error' ? state.failedState : state;
		if (observed.status === 'active' || observed.status === 'stopping' || observed.status === 'provisional') {
			card.createEl('p', {
				text: state.status === 'error' ? 'The active session lost its authority.' : 'Baseline captured. The session is active.',
			});
			const details = card.createEl('dl');
			addDetail(details, 'Character', observed.startContext.characterName);
			addDetail(
				details,
				'Build',
				observed.startContext.build.name || observed.startContext.build.profession,
			);
			addDetail(details, 'Profession', observed.startContext.build.profession);
			addDetail(details, 'Magic Find', `${observed.startContext.magicFind.value} (manual)`);
			addDetail(details, 'Started', formatTimestamp(observed.baseline.completedAt));
			return;
		}

		card.createEl('p', { text: `Session status: ${state.status}.` });
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

function formatTimestamp(value: string): string {
	return new Date(value).toLocaleString();
}
