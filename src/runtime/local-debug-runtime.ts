/**
 * The local diagnostics log as the player sees it (DE-01, step 3g): its health, the events the
 * views leave in it, and the controls of Settings and of the Companion's warning.
 * - The bounded status the visible diagnostics read (`getLocalDebugStatus`), the lightweight
 *   events of a view opening or an Achievements refresh that failed.
 * - Opening the diagnostics settings or the log folder, copying the newest sanitized records.
 * - The closed export contents, the support package written locally, and clearing the logs.
 * - The drain `stop()` awaits after an unload, and the clipboard copy of the incident's detail.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * the logger, the action runner and the shutdown drain it records (its boot and its unload set
 * them) and hands them through `LocalDebugRuntimePort`, read live under the names of its own fields.
 *
 * Its name does not hold `session-runtime`: the persisted-session guard of `security-scan.mjs` does
 * not take it by name. The only thing it writes is the support package (an allowlisted, sanitized
 * projection of the log and of a few non-secret settings), through the host's vault.
 */
import type { LocalDebugStatus } from '../core/local-debug-contract';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import type { LocalDebugLogger } from '../core/local-debug-logger';
import { resanitizeLocalDebugRecord } from '../core/local-debug-sanitizer';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { TyrianSettings } from '../core/settings';
import type { TyrianHost } from '../host/tyrian-host';
import type { LocalDebugExportPreview } from '../ui/settings-panel-actions';

/**
 * Everything `LocalDebugRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field, read live: the logger and the runner are set in `onload`, the drain in `onunload`.
 */
export interface LocalDebugRuntimePort {
	readonly settings: TyrianSettings;
	readonly host: Pick<TyrianHost, 'diagnostics' | 'ui' | 'vault' | 'shell' | 'clipboard' | 'environment' | 'capabilities'>;
	/** Optional and fail-open: null in isolated unit harnesses and before `onload`. */
	readonly localDebug: Pick<LocalDebugLogger, 'status' | 'exportSanitized' | 'clear'> | null;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** The drain `onunload` starts; null until then. */
	readonly localDebugShutdown: Promise<void> | null;
	emitNotice(message: string, source: 'session_error_copy'): void;
}

export class LocalDebugRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: LocalDebugRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get settings(): TyrianSettings { return this.port.settings; }
	private get host(): LocalDebugRuntimePort['host'] { return this.port.host; }
	private get localDebug(): LocalDebugRuntimePort['localDebug'] { return this.port.localDebug; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get localDebugShutdown(): Promise<void> | null { return this.port.localDebugShutdown; }
	private emitNotice(message: string, source: 'session_error_copy'): void { this.port.emitNotice(message, source); }

	/** Exposes the host-initiated async drain to tests and orderly embedding environments. */
	async awaitLocalDebugShutdown(): Promise<void> {
		await this.localDebugShutdown;
	}

	/** Returns only the bounded health projection intended for visible diagnostics UI. */
	getLocalDebugStatus(): LocalDebugStatus {
		return this.localDebug?.status() ?? {
			enabled: this.settings.debugLoggingEnabled,
			minimumLevel: this.settings.debugLoggingLevel,
			state: this.settings.debugLoggingEnabled ? 'degraded' : 'disabled',
			path: `${this.host.diagnostics.directory}/`,
			bytes: 0,
			bytesComplete: true,
			fileCount: 0,
			lastEventAt: null,
			droppedRecords: 0,
			errorCode: this.settings.debugLoggingEnabled ? 'logger_failure' : null,
			queuedRecords: 0,
			recoveredTails: 0,
			errorsSinceLoad: 0,
			lastError: null,
		};
	}

	/** Emits a lightweight view lifecycle event without coupling the view to the logger implementation. */
	localDebugViewEvent(phase: 'open' | 'close'): void {
		this.localDebugActions?.event({
			component: 'ui', action: 'view_render', level: 'info', phase: 'success', code: 'ok',
			state: phase, details: { surface: 'companion' },
		});
	}

	/**
	 * «Logros» «Actualizar progreso» failed outside the reading itself (the public reads behind its ids, or the
	 * list reload after a good reading). The view says it on screen; this keeps the fact in the diagnostics, with
	 * the stage as `details.operation` (a field the sanitizer keeps for every component) and no message (the error may carry a path or a key).
	 */
	localDebugAchievementsRefreshFailure(stage: 'reading_ids' | 'reload'): void {
		this.localDebugActions?.event({
			component: 'ui', action: 'view_render', level: 'error', phase: 'failure', code: 'unavailable',
			state: 'achievements_refresh', details: { surface: 'achievements', operation: stage },
		});
	}

	/** Navigates from a degraded Companion warning to this plugin's diagnostics settings. */
	openLocalDebugSettings(): void {
		const open = (): void => { this.host.ui.openSettings(); };
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'ui', action: 'command_execute', state: 'open_debug_settings' }, open,
		);
		else open();
	}

	/**
	 * False when the host has no filesystem folder for the logs (`vault.fullPath` is null: Hebra keeps them in
	 * IndexedDB), so Settings disables "open folder" and says why instead of failing with the generic error.
	 */
	localDebugFolderAvailable(): boolean {
		return this.host.vault.fullPath(this.getLocalDebugStatus().path.replace(/\/$/u, '')) !== null;
	}

	/** Opens the resolved desktop directory through the host shell without exposing it to diagnostic records. */
	async openLocalDebugFolder(): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			const fullPath = this.host.vault.fullPath(this.getLocalDebugStatus().path.replace(/\/$/u, ''));
			if (!fullPath) return false;
			return await this.host.shell.openPath(fullPath);
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'command_execute', state: 'open_debug_folder' }, run,
		) ?? run());
	}

	/** Copies at most the requested number of newest records after removing process-local identifiers. */
	async copyLocalDebugEntries(limit = 50): Promise<number> {
		const run = async (): Promise<number> => {
			const jsonl = safeLocalDebugJsonl(await this.localDebug?.exportSanitized() ?? '', limit);
			if (jsonl.length === 0) return 0;
			await this.host.clipboard.writeText(jsonl);
			return jsonl.trimEnd().split('\n').length;
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'debug_export', details: { recordCount: limit } }, run,
		) ?? run());
	}

	/** Declares the exact closed export contents before any local file is created. */
	previewLocalDebugExport(): LocalDebugExportPreview {
		return {
			included: ['logs', 'version', 'platform', 'settingsCore', 'settingsFlags'],
			excluded: ['secret_name', 'character', 'paths', 'payloads'],
		};
	}

	/** Creates one support package locally with an explicit non-secret settings allowlist. */
	async exportLocalDebugPackage(): Promise<string | null> {
		const run = async (): Promise<string | null> => {
			const logsJsonl = safeLocalDebugSupportJsonl(await this.localDebug?.exportSanitized() ?? '');
			if (logsJsonl.length === 0) return null;
			const baseName = `diagnostic-export-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
			const directory = `${this.settings.outputFolder}/diagnostics`;
			const supportPackage = {
				schemaVersion: 1,
				pluginVersion: this.host.environment.pluginVersion,
				platform: this.host.environment.platform,
				settings: {
					schemaVersion: this.settings.schemaVersion,
					language: this.settings.language,
					pollingIntervalMinutes: this.settings.pollingIntervalMinutes,
					debugLoggingEnabled: this.settings.debugLoggingEnabled,
					debugLoggingLevel: this.settings.debugLoggingLevel,
				},
				logsJsonl,
			};
			if (this.host.capabilities?.supportPackageAsNote === true) {
				return await saveSupportPackageNote(this.host, `${directory}/${SUPPORT_PACKAGE_NOTE_NAME}.md`, supportPackage);
			}
			const adapter = this.host.vault.adapter;
			await ensureAdapterDirectory(adapter, directory);
			let suffix = 0;
			let path = `${directory}/${baseName}.json`;
			while (await adapter.exists(path)) {
				suffix += 1;
				path = `${directory}/${baseName}-${String(suffix)}.json`;
			}
			await adapter.write(path, `${JSON.stringify(supportPackage, null, '\t')}\n`);
			return path;
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'debug_export' }, run,
		) ?? run());
	}

	/** Clears retained JSONL logs only; the logger remains configured for future actions. */
	async clearLocalDebugLogs(): Promise<boolean> {
		// Clear is deliberately the one diagnostic control that is not wrapped in an
		// action: a terminal emitted after `clear()` would immediately recreate a log.
		return await this.localDebug?.clear() ?? false;
	}

	/**
	 * The incident callout's "Copiar detalle técnico" (H18.36, boceto lámina 2.3): the code
	 * deliberately never renders as visible text, only to the clipboard, so a refused write has no
	 * other way to reach the player — it must say so instead of leaving a copy that never happened.
	 * `companion-view.ts` never touches `Notice` itself (`halloween-alert-panel.ts`'s own rule); this
	 * mirrors `copyAlertIngameSecretFromCommand`'s try/notify shape.
	 */
	async copyLastErrorDetail(detail: string): Promise<void> {
		try {
			await this.host.clipboard.writeText(detail);
		} catch {
			this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'sessionCard.copyTechnicalDetailFailed'), 'session_error_copy');
		}
	}
}

/** Retains valid sanitized records, including the internal IDs required to reconstruct one action. */
function safeLocalDebugJsonl(value: string, newestLimit?: number): string {
	const records: string[] = [];
	for (const line of value.split('\n')) {
		if (line.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
			records.push(JSON.stringify(parsed));
		} catch { /* the core export boundary already reports corrupt retained lines */ }
	}
	const selected = newestLimit === undefined ? records : records.slice(-Math.max(0, newestLimit));
	return selected.length === 0 ? '' : `${selected.join('\n')}\n`;
}

/** Projects support logs to structural diagnostics without free text, stacks or personal data. */
function safeLocalDebugSupportJsonl(value: string): string {
	const records: string[] = [];
	for (const line of value.split('\n')) {
		if (line.length === 0) continue;
		try {
			const record = resanitizeLocalDebugRecord(JSON.parse(line));
			if (record === null) continue;
			const supportRecord = {
				schemaVersion: record.schemaVersion,
				timestampUtc: record.timestampUtc,
				sequence: record.sequence,
				pluginVersion: record.pluginVersion,
				level: record.level,
				component: record.component,
				action: record.action,
				phase: record.phase,
				code: record.code,
				actionId: record.actionId,
				correlationId: record.correlationId,
				...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
				...(record.attempt === undefined ? {} : { attempt: record.attempt }),
			};
			records.push(JSON.stringify(supportRecord));
		} catch { /* the core export boundary already reports corrupt retained lines */ }
	}
	return records.length === 0 ? '' : `${records.join('\n')}\n`;
}

/**
 * Hebra has no folder to open, so the support package is a note of the library: created the
 * first time and rewritten after that (found by the host in the library, not by path), and opened for
 * the user. It deliberately carries no
 * frontmatter and no Tyrian marker, so neither the session history, the Bases nor the seeding of
 * the path index take it for one of theirs. The package is the allowlisted one built by the caller.
 */
async function saveSupportPackageNote(
	host: Pick<TyrianHost, 'vault' | 'ui'>, path: string, supportPackage: object,
): Promise<string> {
	const body = [
		`# ${SUPPORT_PACKAGE_NOTE_NAME}`,
		'',
		'Generated by Tyrian Companion. It holds sanitized diagnostic records and a few non-secret settings; review it before sharing it. Exporting again replaces this note.',
		'',
		'```json',
		JSON.stringify(supportPackage, null, '\t'),
		'```',
		'',
	].join('\n');
	if (host.vault.saveNote === undefined) throw new Error('support package: the host declares supportPackageAsNote without vault.saveNote');
	await host.vault.saveNote(path, body);
	host.ui.openNote(path);
	return path;
}

/** Title and file name of the support package when the host keeps it as a note (Hebra). */
const SUPPORT_PACKAGE_NOTE_NAME = 'Tyrian - Paquete de soporte';

/** Creates each missing portable segment so package writes remain create-only outside log rotation. */
async function ensureAdapterDirectory(
	adapter: { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void> },
	directory: string,
): Promise<void> {
	let current = '';
	for (const segment of directory.split('/')) {
		current = current.length === 0 ? segment : `${current}/${segment}`;
		if (!await adapter.exists(current)) await adapter.mkdir(current);
	}
}
