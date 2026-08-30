import { getRetryAt, type ConnectionState } from '../account/connection-service';
import { createTranslator, type Locale, type TranslationKey } from '../core/i18n';
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

const TRANSLATION_BY_ID: Readonly<Record<ProductActionId, TranslationKey | 'commands.reviewPending'>> = {
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

const COPY = {
	es: {
		open: 'Abrir', run: 'Ejecutar', review: 'Revisar', apply: 'Aplicar', preview: 'Prever',
		descriptions: {
			'open-companion': 'Vista de sesión, detección y estado',
			'open-inventory-advisor': 'Análisis, preferencias e histórico',
			'review-pending-farming-proposal': 'Abre la siguiente confirmación pendiente',
			'start-farming-session': 'Captura una línea base antes de empezar',
			'finish-farming-session': 'Captura la instantánea final',
			'review-session': 'Declara actividad externa antes de completar',
			'recover-saved-session': 'Recupera el estado durable de una sesión',
			'discard-saved-session': 'Elimina una recuperación tras confirmar',
			'clear-completed-session': 'Escribe la nota durable antes de limpiar',
			'arm-assisted-detection': 'Solo propone; nunca cambia una sesión en silencio',
			'disarm-assisted-detection': 'Detiene las consultas futuras',
			'refresh-inventory-advisor': 'Lee cuenta, catálogo y precios',
			'preview-inventory-vault-sync': 'Prepara un plan sin escribir en el vault',
			'apply-inventory-vault-sync': 'Escribe el plan de inventario validado',
			'preview-wallet-vault-sync': 'Prepara un plan sin escribir en el vault',
			'apply-wallet-vault-sync': 'Escribe el plan de cartera validado',
		},
		reasons: { runtime: 'El plugin todavía se está iniciando.', key: 'Vincula una clave API en Ajustes.', pending: 'No hay propuestas pendientes.', state: 'No está disponible en el estado actual.', armed: 'La detección ya está activada.', disarmed: 'La detección ya está desactivada.', preview: 'Haz una vista previa válida primero.', busy: 'Hay una operación en curso.', cooldown: 'Espera a que termine el cooldown de la API.' },
	},
	en: {
		open: 'Open', run: 'Run', review: 'Review', apply: 'Apply', preview: 'Preview',
		descriptions: {
			'open-companion': 'Session, detection, and status view',
			'open-inventory-advisor': 'Analysis, preferences, and history',
			'review-pending-farming-proposal': 'Opens the next pending confirmation',
			'start-farming-session': 'Captures a baseline before starting',
			'finish-farming-session': 'Captures the final snapshot',
			'review-session': 'Declares outside activity before completion',
			'recover-saved-session': 'Recovers durable session state',
			'discard-saved-session': 'Deletes recovery state after confirmation',
			'clear-completed-session': 'Writes the durable note before clearing',
			'arm-assisted-detection': 'Only proposes; never changes a session silently',
			'disarm-assisted-detection': 'Stops future polls',
			'refresh-inventory-advisor': 'Reads the account, catalogue, and prices',
			'preview-inventory-vault-sync': 'Prepares a plan without writing to the Vault',
			'apply-inventory-vault-sync': 'Writes the validated inventory plan',
			'preview-wallet-vault-sync': 'Prepares a plan without writing to the Vault',
			'apply-wallet-vault-sync': 'Writes the validated wallet plan',
		},
		reasons: { runtime: 'The plugin is still starting.', key: 'Link an API key in Settings.', pending: 'There are no pending proposals.', state: 'Unavailable in the current state.', armed: 'Detection is already armed.', disarmed: 'Detection is already disarmed.', preview: 'Create a valid preview first.', busy: 'Another operation is running.', cooldown: 'Wait for the API cooldown to finish.' },
	},
} as const;

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
		const copy = COPY[locale];
		const session = isSessionCommand(id) ? this.ports.sessionCommands.describe(id) : null;
		const availability = isSessionCommand(id)
			? { available: session!.available, reason: session!.available ? null : copy.reasons.state }
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
			description: copy.descriptions[id],
			buttonLabel: buttonLabel(id, copy),
			available: enabled,
			disabledReason: enabled ? null
				: state === 'running' ? copy.reasons.busy
					: state === 'cooldown' ? copy.reasons.cooldown : availability.reason,
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
		const key = TRANSLATION_BY_ID[id];
		return key === 'commands.reviewPending'
			? this.ports.getLocale() === 'es' ? 'Revisar propuesta de farmeo pendiente' : 'Review pending farming proposal'
			: translator.t(key);
	}

	private nonSessionAvailability(id: Exclude<ProductActionId, SessionCommandId>): { available: boolean; reason: string | null } {
		const copy = COPY[this.ports.getLocale()];
		if (id === 'open-companion' || id === 'open-inventory-advisor') return { available: true, reason: null };
		if (!this.ports.isRuntimeReady()) return { available: false, reason: copy.reasons.runtime };
		if (id === 'review-pending-farming-proposal') return this.ports.getPendingProposals().pendingCount > 0
			? { available: true, reason: null } : { available: false, reason: copy.reasons.pending };
		if (id === 'arm-assisted-detection') {
			if (!this.ports.hasApiKey()) return { available: false, reason: copy.reasons.key };
			if (this.ports.getDetectionState().status !== 'disarmed') return { available: false, reason: copy.reasons.armed };
			return this.ports.canArmDetection() ? { available: true, reason: null } : { available: false, reason: copy.reasons.state };
		}
		if (id === 'disarm-assisted-detection') return this.ports.getDetectionState().status === 'disarmed'
			? { available: false, reason: copy.reasons.disarmed } : { available: true, reason: null };
		if (!this.ports.hasApiKey()) return { available: false, reason: copy.reasons.key };
		if (this.ports.isInventoryBusy()) return { available: false, reason: copy.reasons.busy };
		if (id === 'apply-inventory-vault-sync') return this.ports.canApplyInventory()
			? { available: true, reason: null } : { available: false, reason: copy.reasons.preview };
		if (id === 'apply-wallet-vault-sync') return this.ports.canApplyWallet()
			? { available: true, reason: null } : { available: false, reason: copy.reasons.preview };
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

function buttonLabel(id: ProductActionId, copy: typeof COPY.es | typeof COPY.en): string {
	if (id.startsWith('open-')) return copy.open;
	if (id === 'review-pending-farming-proposal' || id === 'review-session') return copy.review;
	if (id.startsWith('preview-')) return copy.preview;
	if (id.startsWith('apply-')) return copy.apply;
	return copy.run;
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
	if (locale === 'es') {
		if (kind === 'running') return 'Acción en curso…';
		if (kind === 'success') return 'Acción completada.';
		if (kind === 'cancelled') return 'Acción cancelada; no se aplicaron cambios.';
		if (kind === 'unavailable') return 'La acción ya no está disponible.';
		return 'No se pudo completar la acción. El estado anterior se conserva.';
	}
	if (kind === 'running') return 'Action running…';
	if (kind === 'success') return 'Action completed.';
	if (kind === 'cancelled') return 'Action cancelled; no changes were applied.';
	if (kind === 'unavailable') return 'The action is no longer available.';
	return 'The action could not be completed. The previous state is preserved.';
}
