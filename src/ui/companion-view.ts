import { ItemView, Modal, type App, type WorkspaceLeaf } from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
import type { SessionState } from '../sessions/session';
import type { StorageDelta } from '../account/storage-delta-model';
import type {
	SessionStartFailure,
	SessionRecoveryState,
	SessionStopFailure,
} from '../sessions/manual-session-start-service';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export interface CompanionActions {
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
	getSessionState(): SessionState;
	getSessionStartFailure(): SessionStartFailure | null;
	getSessionStopFailure(): SessionStopFailure | null;
	getProvisionalDelta(): StorageDelta | null;
	getSessionRecoveryState(): SessionRecoveryState;
	openManualSessionStart(): void;
	stopManualSession(): Promise<void>;
	recoverSession(): Promise<void>;
	discardRecoveredSession(): Promise<void>;
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
			const recovery = this.actions.getSessionRecoveryState();
			if (recovery.status !== 'none') {
				this.renderRecovery(card, recovery);
				return;
			}
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

		if (state.status === 'stopping') {
			const failure = this.actions.getSessionStopFailure();
			card.createEl('p', {
				text: failure
					? 'The final snapshot failed. The baseline is intact and the stop can be retried.'
					: 'Capturing a stable final account snapshot…',
			});
			if (failure) {
				card.createEl('p', { text: failure.message, cls: 'tyrian-companion-view__session-error' });
			}
			const button = card.createEl('button', { text: failure ? 'Retry stop' : 'Stopping…' });
			button.disabled = failure === null;
			button.addEventListener('click', () => { void this.actions.stopManualSession(); });
			this.renderSessionDetails(card, state);
			return;
		}

		if (state.status === 'provisional') {
			card.createEl('p', {
				text: 'Final snapshot and account delta captured. The session is ready for contamination review.',
			});
			this.renderSessionDetails(card, state);
			const delta = this.actions.getProvisionalDelta();
			if (delta) {
				const details = card.createEl('dl');
				addDetail(details, 'Delta quality', delta.status);
				addDetail(details, 'Changed item IDs', String(delta.itemChanges.length));
				addDetail(details, 'Changed currencies', String(delta.currencyChanges.length));
			}
			return;
		}

		const observed = state.status === 'error' ? state.failedState : state;
		if (observed.status === 'active' || observed.status === 'stopping' || observed.status === 'provisional') {
			card.createEl('p', {
				text: state.status === 'error' ? 'The active session lost its authority.' : 'Baseline captured. The session is active.',
			});
			this.renderSessionDetails(card, observed);
			if (state.status === 'active') {
				const stop = card.createEl('button', { text: 'Stop session' });
				stop.addEventListener('click', () => { void this.actions.stopManualSession(); });
			}
			return;
		}

		card.createEl('p', { text: `Session status: ${state.status}.` });
	}

	private renderRecovery(container: HTMLElement, recovery: SessionRecoveryState): void {
		if (recovery.status === 'none') return;
		if (recovery.status === 'error') {
			container.setAttr('role', 'alert');
			container.createEl('p', {
				text: recovery.message,
				cls: 'tyrian-companion-view__session-error',
			});
			container.createEl('p', {
				text: 'Starting a new session is disabled to avoid overwriting recoverable evidence.',
			});
			return;
		}
		const observed = recovery.state.status === 'error'
			? recovery.state.failedState
			: recovery.state;
		if (recovery.status === 'busy') container.setAttr('role', 'alert');
		container.createEl('p', {
			text: recovery.status === 'working'
				? recovery.action === 'recover' ? 'Recovering the saved session…' : 'Discarding the saved session…'
				: 'A farming session from a previous Obsidian run is available.',
		});
		this.renderSessionDetails(container, observed);
		if ('message' in recovery && recovery.message) {
			container.createEl('p', {
				text: recovery.message,
				cls: recovery.status === 'busy' ? 'tyrian-companion-view__session-error' : undefined,
			});
		}
		const actions = container.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const recover = actions.createEl('button', { text: 'Recover session', cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: 'Discard saved session' });
		const working = recovery.status === 'working';
		recover.disabled = working;
		discard.disabled = working;
		recover.addEventListener('click', () => { void this.runRecovery(); });
		discard.addEventListener('click', () => {
			new ConfirmDiscardSessionModal(this.app, async () => {
				await this.actions.discardRecoveredSession();
				this.render();
			}).open();
		});
	}

	private async runRecovery(): Promise<void> {
		const recovery = this.actions.recoverSession();
		this.render();
		await recovery;
		this.render();
	}

	private renderSessionDetails(
		container: HTMLElement,
		state: Extract<SessionState, { status: 'active' | 'stopping' | 'provisional' }>,
	): void {
		const details = container.createEl('dl');
		addDetail(details, 'Character', state.startContext.characterName);
		addDetail(details, 'Build', state.startContext.build.name || state.startContext.build.profession);
		addDetail(details, 'Profession', state.startContext.build.profession);
		addDetail(details, 'Magic Find', `${state.startContext.magicFind.value} (manual)`);
		addDetail(details, 'Started', formatTimestamp(state.baseline.completedAt));
	}

	private clearCountdown(): void {
		if (this.countdownInterval !== null) {
			this.contentEl.win.clearInterval(this.countdownInterval);
			this.countdownInterval = null;
		}
	}
}

class ConfirmDiscardSessionModal extends Modal {
	constructor(app: App, private readonly onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Discard saved farming session?');
		this.contentEl.createEl('p', {
			text: 'This removes the saved baseline and any captured final snapshot. It cannot be undone.',
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: 'Keep session', cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: 'Discard', cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		discard.addEventListener('click', () => {
			discard.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
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
