/**
 * R1b (SPEC-TYRIAN-EN-HEBRA.md section 4): the collector's footprint.
 *
 * Only the collector writes it, in ONE status note under the output folder
 * (`<outputFolder>/Collector status.md`): which installation collects (a stable local id), on what
 * host (platform and version) and when it last beat. Never in each note: a timestamp there would
 * turn every unchanged round (`unchanged` in inventory-vault-sync.ts) into a write and, in Hebra,
 * into conflict copies against the phone.
 *
 * The note is how two collectors INSIDE the same storage (two Obsidian with Sync, two Hebra) find
 * out about each other. On every beat the collector reads it first: when another installation holds
 * it with a recent heartbeat, this one warns once and leaves the note alone instead of fighting over
 * it; when the other heartbeat is stale, it takes the note over. A note at that path that is not a
 * status note (the player's own) is never touched.
 */

import { parseDocument } from 'yaml';

import type { Locale } from '../core/i18n';
import { createTranslator } from '../core/i18n';
import type { TyrianEnvironmentPort, TyrianPlatform, TyrianVaultFile } from '../host/tyrian-host';

/** The status note, RELATIVE to the output folder, the same way `canonicalPathFor` answers. */
export const COLLECTOR_STATUS_NOTE_RELATIVE_PATH = 'Collector status.md';
export const COLLECTOR_STATUS_NOTE_KIND = 'gw2_collector_status';
const COLLECTOR_STATUS_SCHEMA = 1;
/** One write every fifteen minutes: the status note is the only thing a quiet collector writes. */
export const COLLECTOR_HEARTBEAT_INTERVAL_MS = 15 * 60_000;
/**
 * Three missed beats. Long enough for Sync to carry a beat across devices, short enough that
 * closing Obsidian on one computer lets the other take over within the hour.
 */
export const COLLECTOR_HEARTBEAT_FRESH_MS = 3 * COLLECTOR_HEARTBEAT_INTERVAL_MS;

const PLATFORMS: ReadonlySet<string> = new Set<TyrianPlatform>(['linux', 'macos', 'windows', 'unknown']);
const INSTANCE_ID = /^[A-Za-z0-9-]{8,64}$/u;
const VERSION = /^[\w.+-]{1,64}$/u;

/** Who collects, as the status note records it. */
export interface CollectorFootprint {
	readonly instanceId: string;
	readonly platform: TyrianPlatform;
	readonly hostVersion: string;
	readonly pluginVersion: string;
	/** Exact `toISOString()`. */
	readonly heartbeatAt: string;
}

/** `<root>/Collector status.md`. */
export function collectorStatusNotePath(root: string): string {
	return `${root}/${COLLECTOR_STATUS_NOTE_RELATIVE_PATH}`;
}

/**
 * The whole note. Frontmatter only carries the footprint; the body is one line for a curious reader.
 * A platform or version outside the shape `parseCollectorStatusNote` accepts is written as
 * `unknown`: a host string it could not read back would leave a note no beat could ever reclaim.
 */
export function renderCollectorStatusNote(footprint: CollectorFootprint, locale: Locale): string {
	return [
		'---',
		`tc_kind: ${COLLECTOR_STATUS_NOTE_KIND}`,
		`tc_collector_schema: ${String(COLLECTOR_STATUS_SCHEMA)}`,
		`tc_collector_instance: ${JSON.stringify(footprint.instanceId)}`,
		`tc_collector_platform: ${PLATFORMS.has(footprint.platform) ? footprint.platform : 'unknown'}`,
		`tc_collector_host_version: ${JSON.stringify(readableVersion(footprint.hostVersion))}`,
		`tc_collector_plugin_version: ${JSON.stringify(readableVersion(footprint.pluginVersion))}`,
		`tc_collector_heartbeat_at: ${JSON.stringify(footprint.heartbeatAt)}`,
		'---',
		createTranslator(locale).t('collector.statusNote.body'),
		'',
	].join('\n');
}

/** The footprint a status note carries, or null when `text` is not exactly a status note. */
export function parseCollectorStatusNote(text: string): CollectorFootprint | null {
	const normalized = text.replace(/\r\n/gu, '\n');
	if (!normalized.startsWith('---\n')) return null;
	const end = normalized.indexOf('\n---\n', 3);
	if (end < 0) return null;
	const document = parseDocument(normalized.slice(4, end));
	if (document.errors.length > 0) return null;
	const data = document.toJS() as unknown;
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	if (record.tc_kind !== COLLECTOR_STATUS_NOTE_KIND || record.tc_collector_schema !== COLLECTOR_STATUS_SCHEMA) return null;
	const { tc_collector_instance: instanceId, tc_collector_platform: platform } = record;
	const { tc_collector_host_version: hostVersion, tc_collector_plugin_version: pluginVersion } = record;
	const heartbeatAt = record.tc_collector_heartbeat_at;
	if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) return null;
	if (typeof platform !== 'string' || !PLATFORMS.has(platform)) return null;
	if (typeof hostVersion !== 'string' || !VERSION.test(hostVersion)) return null;
	if (typeof pluginVersion !== 'string' || !VERSION.test(pluginVersion)) return null;
	if (typeof heartbeatAt !== 'string' || !exactIso(heartbeatAt)) return null;
	return { instanceId, platform: platform as TyrianPlatform, hostVersion, pluginVersion, heartbeatAt };
}

/**
 * What one installation may do with the status note it just read:
 * - `free`: there is no note yet;
 * - `own`: this installation wrote it;
 * - `stale`: another installation wrote it, but its heartbeat is older than
 *   `COLLECTOR_HEARTBEAT_FRESH_MS` (or implausibly far in the future), so it stopped collecting;
 * - `held`: another installation is collecting right now;
 * - `unrecognized`: the file there is not a status note, so it is not Tyrian's to overwrite.
 */
export type CollectorStatusVerdict =
	| { readonly kind: 'free' | 'unrecognized' }
	| { readonly kind: 'own' | 'stale' | 'held'; readonly footprint: CollectorFootprint };

export function collectorStatusVerdict(existing: string | null, instanceId: string, nowMs: number): CollectorStatusVerdict {
	if (existing === null) return { kind: 'free' };
	const footprint = parseCollectorStatusNote(existing);
	if (footprint === null) return { kind: 'unrecognized' };
	if (footprint.instanceId === instanceId) return { kind: 'own', footprint };
	const ageMs = nowMs - Date.parse(footprint.heartbeatAt);
	return Math.abs(ageMs) <= COLLECTOR_HEARTBEAT_FRESH_MS ? { kind: 'held', footprint } : { kind: 'stale', footprint };
}

/** The vault operations the heartbeat uses, a subset of `TyrianVault`. */
export interface CollectorStatusVault {
	file(path: string): TyrianVaultFile | null;
	read(file: TyrianVaultFile): Promise<string>;
	process(file: TyrianVaultFile, update: (current: string) => string): Promise<string>;
	create(path: string, content: string): Promise<TyrianVaultFile>;
	createFolder(path: string): Promise<void>;
}

export interface CollectorHeartbeatOptions {
	readonly vault: CollectorStatusVault;
	/** The output folder, read on every beat: it can move without a reload. */
	readonly root: () => string;
	/** Stable per installation and never synced (`collector-instance.ts`). */
	readonly instanceId: string;
	readonly environment: Pick<TyrianEnvironmentPort, 'platform' | 'hostVersion' | 'pluginVersion'>;
	readonly locale: () => Locale;
	/** False while nothing may be written under the root (a pending legacy folder): the beat skips. */
	readonly writable?: () => boolean;
	readonly now?: () => number;
	readonly setInterval: (callback: () => void, delayMs: number) => number;
	readonly clearInterval: (handle: number) => void;
	/** Runs one beat off the timer; the host's diagnostics own its outcome and any rejection. */
	readonly run: (beat: () => Promise<CollectorBeatOutcome>) => void;
	/** Once per episode: another installation took, or keeps, the note with a recent heartbeat. */
	readonly onConflict: (other: CollectorFootprint) => void;
}

export type CollectorBeatOutcome =
	| { readonly status: 'written' | 'skipped' | 'unrecognized' }
	| { readonly status: 'held'; readonly other: CollectorFootprint };

/** The collector's heartbeat: writes the footprint now and every `COLLECTOR_HEARTBEAT_INTERVAL_MS`. */
export class CollectorHeartbeat {
	private handle: number | null = null;
	private stopped = false;
	private conflict: CollectorFootprint | null = null;
	private readonly now: () => number;

	constructor(private readonly options: CollectorHeartbeatOptions) {
		this.now = options.now ?? Date.now;
	}

	/** Beats once now and then on the interval. Idempotent while running. */
	start(): void {
		if (this.stopped || this.handle !== null) return;
		this.options.run(() => this.beat());
		this.handle = this.options.setInterval(() => { this.options.run(() => this.beat()); }, COLLECTOR_HEARTBEAT_INTERVAL_MS);
	}

	/** Stops beating for good. The note keeps the last heartbeat and goes stale on its own. */
	stop(): void {
		this.stopped = true;
		if (this.handle !== null) this.options.clearInterval(this.handle);
		this.handle = null;
	}

	/** The installation currently holding the note with a recent heartbeat, or null. */
	currentConflict(): CollectorFootprint | null {
		return this.conflict;
	}

	/** One beat: read the note, and write the footprint only when the note is free, ours or stale. */
	async beat(): Promise<CollectorBeatOutcome> {
		if (this.stopped || !(this.options.writable?.() ?? true)) return { status: 'skipped' };
		const root = this.options.root();
		const path = collectorStatusNotePath(root);
		const nowMs = this.now();
		const content = renderCollectorStatusNote({
			instanceId: this.options.instanceId,
			platform: this.options.environment.platform,
			hostVersion: this.options.environment.hostVersion,
			pluginVersion: this.options.environment.pluginVersion,
			heartbeatAt: new Date(nowMs).toISOString(),
		}, this.options.locale());
		const file = this.options.vault.file(path);
		if (file === null) {
			await this.ensureFolder(root);
			await this.options.vault.create(path, content);
			return this.settle({ status: 'written' });
		}
		// Read before writing: a held or foreign note must not even be rewritten with its own text.
		const before = collectorStatusVerdict(await this.options.vault.read(file), this.options.instanceId, nowMs);
		if (before.kind === 'held') return this.settle({ status: 'held', other: before.footprint });
		if (before.kind === 'unrecognized') return this.settle({ status: 'unrecognized' });
		let verdict: CollectorStatusVerdict = before;
		// Decided again inside the atomic update: a beat from the other installation may land in between.
		await this.options.vault.process(file, (current) => {
			verdict = collectorStatusVerdict(current, this.options.instanceId, nowMs);
			return verdict.kind === 'held' || verdict.kind === 'unrecognized' ? current : content;
		});
		if (verdict.kind === 'held') return this.settle({ status: 'held', other: verdict.footprint });
		if (verdict.kind === 'unrecognized') return this.settle({ status: 'unrecognized' });
		return this.settle({ status: 'written' });
	}

	private settle(outcome: CollectorBeatOutcome): CollectorBeatOutcome {
		if (outcome.status === 'held') {
			const known = this.conflict?.instanceId === outcome.other.instanceId;
			this.conflict = outcome.other;
			if (!known) this.options.onConflict(outcome.other);
		} else if (outcome.status === 'written') {
			this.conflict = null;
		}
		return outcome;
	}

	/** Creates the output folder one segment at a time, the way every writer does. */
	private async ensureFolder(folder: string): Promise<void> {
		let current = '';
		for (const segment of folder.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			if (this.options.vault.file(current) === null) await this.options.vault.createFolder(current);
		}
	}
}

function readableVersion(value: unknown): string {
	return typeof value === 'string' && VERSION.test(value) ? value : 'unknown';
}

function exactIso(value: string): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
