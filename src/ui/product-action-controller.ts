import { getRetryAt, type ConnectionState } from '../account/connection-service';
import { createTranslator, type Locale, type TranslationKey, type Translator } from '../core/i18n';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { ProposalQueueState } from '../sessions/pending-proposal-service';
import type { SessionCommandController, SessionCommandOutcome } from './session-command-controller';
import { SESSION_COMMAND_IDS, type SessionCommandId } from './session-command-model';

export const PRODUCT_ACTION_IDS = [
	'open-companion',
	'open-inventory-advisor',
	'review-pending-farming-proposal',
	...SESSION_COMMAND_IDS,
	'arm-assisted-detection',
	'disarm-assisted-detection',
	'refresh-inventory-advisor',
	'preview-inventory-vault-sync',
	'apply-inventory-vault-sync',
	'preview-wallet-vault-sync',
	'apply-wallet-vault-sync',
] as const;

export type ProductActionId = typeof PRODUCT_ACTION_IDS[number];
export type ProductActionGroup = 'navigation' | 'session' | 'detection' | 'inventory';
export type ProductActionState = 'idle' | 'running' | 'error' | 'cooldown';
export type ProductActionOutcome = SessionCommandOutcome;

export interface ProductActionDescriptor {
	readonly id: ProductActionId;
	readonly group: ProductActionGroup;
	readonly name: string;
	readonly description: string;
	readonly buttonLabel: string;
	readonly available: boolean;
	readonly disabledReason: string | null;
	readonly destructive: boolean;
	readonly state: ProductActionState;
}

export interface ProductActionControllerPorts {
	getLocale(): Locale;
	isRuntimeReady(): boolean;
	hasApiKey(): boolean;
	getConnectionState(): ConnectionState;
	getPendingProposals(): ProposalQueueState;
	getDetectionState(): AssistedDetectionState;
	canArmDetection(): boolean;
	canApplyInventory(): boolean;
	canApplyWallet(): boolean;
	isInventoryBusy(): boolean;
	sessionCommands: Pick<SessionCommandController, 'describe' | 'runWithOutcome'>;
	execute(id: Exclude<ProductActionId, SessionCommandId>): ProductActionOutcome | Promise<ProductActionOutcome>;
}

export interface ProductActionFeedback {
	readonly kind: 'running' | 'success' | 'neutral' | 'error';
	readonly actionId: ProductActionId;
	readonly message: string;
}

const GROUP_BY_ID: Readonly<Record<ProductActionId, ProductActionGroup>> = {
	'open-companion': 'navigation',
	'open-inventory-advisor': 'navigation',
	'review-pending-farming-proposal': 'session',
	'start-farming-session': 'session',
	'finish-farming-session': 'session',
	'review-session': 'session',
	'recover-saved-session': 'session',
	'discard-saved-session': 'session',
	'clear-completed-session': 'session',
	'arm-assisted-detection': 'detection',
	'disarm-assisted-detection': 'detection',
	'refresh-inventory-advisor': 'inventory',
	'preview-inventory-vault-sync': 'inventory',
	'apply-inventory-vault-sync': 'inventory',
	'preview-wallet-vault-sync': 'inventory',
	'apply-wallet-vault-sync': 'inventory',
};

const TRANSLATION_BY_ID: Readonly<Record<ProductActionId, TranslationKey>> = {
	'open-companion': 'commands.openCompanion',
	'open-inventory-advisor': 'commands.openInventoryAdvisor',
	'review-pending-farming-proposal': 'commands.reviewPending',
	'start-farming-session': 'commands.startSession',
	'finish-farming-session': 'commands.finishSession',
	'review-session': 'commands.reviewSession',
	'recover-saved-session': 'commands.recoverSession',
	'discard-saved-session': 'commands.discardSession',
	'clear-completed-session': 'commands.clearSession',
	'arm-assisted-detection': 'commands.armDetection',
	'disarm-assisted-detection': 'commands.disarmDetection',
	'refresh-inventory-advisor': 'commands.refreshInventoryAdvisor',
	'preview-inventory-vault-sync': 'commands.previewInventoryVault',
	'apply-inventory-vault-sync': 'commands.applyInventoryVault',
	'preview-wallet-vault-sync': 'commands.previewWalletVault',
	'apply-wallet-vault-sync': 'commands.applyWalletVault',
};

const DESCRIPTION_KEY_BY_ID: Readonly<Record<ProductActionId, TranslationKey>> = {
	'open-companion': 'productAction.desc.open-companion',
	'open-inventory-advisor': 'productAction.desc.open-inventory-advisor',
	'review-pending-farming-proposal': 'productAction.desc.review-pending-farming-proposal',
	'start-farming-session': 'productAction.desc.start-farming-session',
	'finish-farming-session': 'productAction.desc.finish-farming-session',
	'review-session': 'productAction.desc.review-session',
	'recover-saved-session': 'productAction.desc.recover-saved-session',
	'discard-saved-session': 'productAction.desc.discard-saved-session',
	'clear-completed-session': 'productAction.desc.clear-completed-session',
	'arm-assisted-detection': 'productAction.desc.arm-assisted-detection',
	'disarm-assisted-detection': 'productAction.desc.disarm-assisted-detection',
	'refresh-inventory-advisor': 'productAction.desc.refresh-inventory-advisor',
	'preview-inventory-vault-sync': 'productAction.desc.preview-inventory-vault-sync',
	'apply-inventory-vault-sync': 'productAction.desc.apply-inventory-vault-sync',
	'preview-wallet-vault-sync': 'productAction.desc.preview-wallet-vault-sync',
	'apply-wallet-vault-sync': 'productAction.desc.apply-wallet-vault-sync',
};

/** One execution boundary shared by the command palette and every visible action panel. */
export class ProductActionController {
	private readonly running = new Set<ProductActionId>();
	private readonly failed = new Set<ProductActionId>();
	private readonly inventoryBusySources = new Set<object>();
	private readonly listeners = new Set<() => void>();
	private feedback: ProductActionFeedback | null = null;
	private cooldownTimer: number | null = null;

	constructor(private readonly ports: ProductActionControllerPorts) {}

	describe(id: ProductActionId): ProductActionDescriptor {
		const locale = this.ports.getLocale();
		const translator = createTranslator(locale);
		const session = isSessionCommand(id) ? this.ports.sessionCommands.describe(id) : null;
		const availability = isSessionCommand(id)
			? { available: session!.available, reason: session!.available ? null : translator.t('productAction.reason.state') }
			: this.nonSessionAvailability(id);
		const retryAt = getRetryAt(this.ports.getConnectionState());
		const coolingDown = retryAt !== null && retryAt > Date.now();
		const externallyRunning = GROUP_BY_ID[id] === 'inventory' && this.ports.isInventoryBusy()
			|| GROUP_BY_ID[id] === 'inventory' && this.inventoryBusySources.size > 0
			|| id === 'arm-assisted-detection' && this.ports.getDetectionState().status === 'arming';
		const state = this.running.has(id) || externallyRunning ? 'running'
			: this.failed.has(id) ? 'error'
				: coolingDown && requiresAccountRequest(id)
					? 'cooldown' : 'idle';
		const enabled = availability.available && state !== 'running' && state !== 'cooldown';
		return {
			id,
			group: GROUP_BY_ID[id],
			name: session?.name ?? this.actionName(id as Exclude<ProductActionId, SessionCommandId>),
			description: translator.t(DESCRIPTION_KEY_BY_ID[id]),
			buttonLabel: buttonLabel(id, translator),
			available: enabled,
			disabledReason: enabled ? null
				: state === 'running' ? translator.t('productAction.reason.busy')
					: state === 'cooldown' ? translator.t('productAction.reason.cooldown') : availability.reason,
			destructive: session?.destructive ?? false,
			state,
		};
	}

	all(): ProductActionDescriptor[] {
		return PRODUCT_ACTION_IDS.map((id) => this.describe(id));
	}

	currentFeedback(): ProductActionFeedback | null {
		return this.feedback;
	}

	/** Reprojects external runtime state without rebuilding any product view. */
	refresh(): void {
		this.notify();
	}

	/** Includes busy work owned by a retained Inventory view in the shared projection. */
	setInventorySurfaceBusy(source: object, busy: boolean): void {
		const changed = busy ? !this.inventoryBusySources.has(source) : this.inventoryBusySources.has(source);
		if (!changed) return;
		if (busy) this.inventoryBusySources.add(source);
		else this.inventoryBusySources.delete(source);
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		this.scheduleCooldownRefresh();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.clearCooldownTimer();
		};
	}

	/**
	 * Defense in depth alongside the last `subscribe()` unsubscribe above: a plugin unload does
	 * not wait for every view's own teardown to run first, so `shutdownRuntime` calls this
	 * directly instead of trusting that every listener already left.
	 */
	dispose(): void {
		this.clearCooldownTimer();
	}

	async run(id: ProductActionId): Promise<ProductActionOutcome> {
		if (!this.describe(id).available || this.running.has(id)) return 'unavailable';
		this.running.add(id);
		this.failed.delete(id);
		this.feedback = { kind: 'running', actionId: id, message: feedbackCopy(this.ports.getLocale(), 'running') };
		this.notify();
		try {
			const outcome = isSessionCommand(id)
				? await this.ports.sessionCommands.runWithOutcome(id)
				: await this.ports.execute(id);
			if (outcome === 'failed') throw new Error('Product action failed.');
			this.feedback = outcome === 'completed'
				? { kind: 'success', actionId: id, message: feedbackCopy(this.ports.getLocale(), 'success') }
				: { kind: 'neutral', actionId: id, message: feedbackCopy(this.ports.getLocale(), outcome) };
			return outcome;
		} catch (error) {
			this.failed.add(id);
			this.feedback = { kind: 'error', actionId: id, message: feedbackCopy(this.ports.getLocale(), 'error') };
			throw error;
		} finally {
			this.running.delete(id);
			this.notify();
		}
	}

	private notify(): void {
		this.scheduleCooldownRefresh();
		for (const listener of this.listeners) listener();
	}

	private scheduleCooldownRefresh(): void {
		this.clearCooldownTimer();
		if (this.listeners.size === 0) return;
		const retryAt = getRetryAt(this.ports.getConnectionState());
		if (retryAt === null) return;
		const remaining = retryAt - Date.now();
		if (remaining <= 0) return;
		this.cooldownTimer = window.setTimeout(() => {
			this.cooldownTimer = null;
			this.notify();
		}, remaining);
	}

	private clearCooldownTimer(): void {
		if (this.cooldownTimer === null) return;
		window.clearTimeout(this.cooldownTimer);
		this.cooldownTimer = null;
	}

	private actionName(id: Exclude<ProductActionId, SessionCommandId>): string {
		const translator = createTranslator(this.ports.getLocale());
		return translator.t(TRANSLATION_BY_ID[id]);
	}

	private nonSessionAvailability(id: Exclude<ProductActionId, SessionCommandId>): { available: boolean; reason: string | null } {
		const t = createTranslator(this.ports.getLocale());
		if (id === 'open-companion' || id === 'open-inventory-advisor') return { available: true, reason: null };
		if (!this.ports.isRuntimeReady()) return { available: false, reason: t.t('productAction.reason.runtime') };
		if (id === 'review-pending-farming-proposal') return this.ports.getPendingProposals().pendingCount > 0
			? { available: true, reason: null } : { available: false, reason: t.t('productAction.reason.pending') };
		if (id === 'arm-assisted-detection') {
			if (!this.ports.hasApiKey()) return { available: false, reason: t.t('productAction.reason.key') };
			if (this.ports.getDetectionState().status !== 'disarmed') return { available: false, reason: t.t('productAction.reason.armed') };
			return this.ports.canArmDetection() ? { available: true, reason: null } : { available: false, reason: t.t('productAction.reason.state') };
		}
		if (id === 'disarm-assisted-detection') return this.ports.getDetectionState().status === 'disarmed'
			? { available: false, reason: t.t('productAction.reason.disarmed') } : { available: true, reason: null };
		if (!this.ports.hasApiKey()) return { available: false, reason: t.t('productAction.reason.key') };
		if (this.ports.isInventoryBusy()) return { available: false, reason: t.t('productAction.reason.busy') };
		if (id === 'apply-inventory-vault-sync') return this.ports.canApplyInventory()
			? { available: true, reason: null } : { available: false, reason: t.t('productAction.reason.preview') };
		if (id === 'apply-wallet-vault-sync') return this.ports.canApplyWallet()
			? { available: true, reason: null } : { available: false, reason: t.t('productAction.reason.preview') };
		return { available: true, reason: null };
	}
}

export function registerProductActionPalette(
	registry: { addCommand(spec: { id: ProductActionId; name: string; checkCallback(checking: boolean): boolean }): void },
	controller: Pick<ProductActionController, 'describe' | 'run'>,
): void {
	for (const id of PRODUCT_ACTION_IDS) registry.addCommand({
		id,
		name: controller.describe(id).name,
		checkCallback: (checking) => {
			const available = controller.describe(id).available;
			if (!checking && available) void controller.run(id).catch(() => undefined);
			return available;
		},
	});
}

function isSessionCommand(id: ProductActionId): id is SessionCommandId {
	return (SESSION_COMMAND_IDS as readonly string[]).includes(id);
}

function buttonLabel(id: ProductActionId, t: Translator): string {
	if (id.startsWith('open-')) return t.t('productAction.open');
	if (id === 'review-pending-farming-proposal' || id === 'review-session') return t.t('productAction.review');
	if (id.startsWith('preview-')) return t.t('productAction.preview');
	if (id.startsWith('apply-')) return t.t('productAction.apply');
	return t.t('productAction.run');
}

function requiresAccountRequest(id: ProductActionId): boolean {
	return [
		'start-farming-session', 'finish-farming-session', 'arm-assisted-detection',
		'refresh-inventory-advisor', 'preview-inventory-vault-sync', 'preview-wallet-vault-sync',
	].includes(id);
}

function feedbackCopy(
	locale: Locale,
	kind: ProductActionFeedback['kind'] | Extract<ProductActionOutcome, 'cancelled' | 'unavailable'>,
): string {
	const t = createTranslator(locale);
	if (kind === 'running') return t.t('productAction.feedback.running');
	if (kind === 'success') return t.t('productAction.feedback.success');
	if (kind === 'cancelled') return t.t('productAction.feedback.cancelled');
	if (kind === 'unavailable') return t.t('productAction.feedback.unavailable');
	return t.t('productAction.feedback.failed');
}
