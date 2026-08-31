import { aggregatePilotMetrics, type PilotAggregationV1 } from './pilot-metrics-statistics';
import { DETECTION_CORRECTION_CAUSES } from './session-detection-quality';
import type { PilotJournalHealth, PilotJournalSnapshotV1, PilotObservationV1 } from './pilot-metrics-model';

export interface PilotMetricsExportFile { path: string }
export interface PilotMetricsExportVault {
	file(path: string): PilotMetricsExportFile | null;
	read(file: PilotMetricsExportFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<PilotMetricsExportFile>;
}

export interface PilotMetricsExportPreview {
	digest: string;
	observationCount: number;
	platformCount: number;
	files: readonly string[];
	included: readonly ['sanitized_observations', 'platform_aggregates', 'version_strata', 'method_and_evidence'];
	excluded: readonly ['raw_proposal_ids', 'account_and_session_ids', 'secrets', 'paths', 'snapshots_and_payloads'];
	pseudonymous: true;
}

export type PilotMetricsExportResult =
	| { status: 'written' | 'unchanged'; files: string[]; digest: string }
	| { status: 'conflict' | 'unavailable'; files: string[] };

interface ExportBundle {
	detail: ReturnType<typeof sanitizedDetails>;
	aggregates: PilotAggregationV1;
	sampleRevision: number;
	verification: PilotJournalSnapshotV1['verification'];
}

/** Builds and writes four deterministic files only after a human accepts the returned preview. */
export class PilotMetricsExporter {
	constructor(private readonly vault: PilotMetricsExportVault) {}

	async preview(snapshot: PilotJournalSnapshotV1, health: PilotJournalHealth, outputFolder: string): Promise<PilotMetricsExportPreview> {
		const prepared = await prepare(snapshot, health, outputFolder);
		return {
			digest: prepared.digest,
			observationCount: snapshot.observations.length,
			platformCount: prepared.bundle.aggregates.platforms.length,
			files: prepared.files.map((entry) => entry.path),
			included: ['sanitized_observations', 'platform_aggregates', 'version_strata', 'method_and_evidence'],
			excluded: ['raw_proposal_ids', 'account_and_session_ids', 'secrets', 'paths', 'snapshots_and_payloads'],
			pseudonymous: true,
		};
	}

	async export(
		snapshot: PilotJournalSnapshotV1,
		health: PilotJournalHealth,
		outputFolder: string,
	): Promise<PilotMetricsExportResult> {
		try {
			const prepared = await prepare(snapshot, health, outputFolder);
			const existing: string[] = [];
			for (const target of prepared.files) {
				const file = this.vault.file(target.path);
				if (!file) continue;
				if (await this.vault.read(file) !== target.content) {
					return { status: 'conflict', files: prepared.files.map((entry) => entry.path) };
				}
				existing.push(target.path);
			}
			await ensureFolders(this.vault, `${outputFolder}/exports`);
			const written: string[] = [];
			for (const target of prepared.files) {
				if (existing.includes(target.path)) continue;
				await this.vault.create(target.path, target.content);
				written.push(target.path);
			}
			return {
				status: written.length === 0 ? 'unchanged' : 'written',
				files: prepared.files.map((entry) => entry.path),
				digest: prepared.digest,
			};
		} catch { return { status: 'unavailable', files: [] }; }
	}
}

function sanitizedDetails(observations: readonly PilotObservationV1[]) {
	return observations.map((entry) => {
		if (entry.kind === 'proposal') return {
			kind: entry.kind,
			proposalRef: entry.proposalRef,
			pseudonymous: true as const,
			phase: entry.phase,
			mode: entry.mode,
			reviewPresentedAt: entry.reviewPresentedAt,
			window: entry.window,
			pollingIntervalMs: entry.pollingIntervalMs,
			evidenceQuality: entry.evidenceQuality,
			environment: entry.environment,
			terminal: entry.terminal,
		};
		if (entry.kind === 'session') return {
			kind: entry.kind,
			startedAt: entry.startedAt,
			completedAt: entry.completedAt,
			environment: entry.environment,
		};
		return {
			kind: entry.kind,
			presentedAt: entry.presentedAt,
			recoveryKind: entry.recoveryKind,
			terminal: entry.terminal,
			environment: entry.environment,
		};
	});
}

async function prepare(snapshot: PilotJournalSnapshotV1, health: PilotJournalHealth, outputFolder: string) {
	const verification = snapshot.verification?.sampleRevision === snapshot.sampleRevision
		? snapshot.verification : null;
	const bundle: ExportBundle = {
		detail: sanitizedDetails(snapshot.observations),
		aggregates: aggregatePilotMetrics(snapshot.observations, health, verification, snapshot.sampleRevision),
		sampleRevision: snapshot.sampleRevision,
		verification,
	};
	const canonical = stableJson(bundle);
	const digest = (await sha256(canonical)).slice(0, 16);
	const root = `${outputFolder}/exports`;
	const detailJson = stableJson({
		schema: 'tyrian-pilot-observations-v1',
		privacy: 'proposalRef is a stable pseudonym, not anonymization',
		sampleRevision: bundle.sampleRevision,
		verification: bundle.verification,
		observations: bundle.detail,
	}) + '\n';
	const aggregateJson = stableJson({ schema: 'tyrian-pilot-aggregates-v1', ...bundle.aggregates }) + '\n';
	return {
		bundle, digest,
		files: [
			{ path: `${root}/pilot-observations-${digest}.json`, content: detailJson },
			{ path: `${root}/pilot-observations-${digest}.csv`, content: detailsCsv(bundle.detail) },
			{ path: `${root}/pilot-aggregates-${digest}.json`, content: aggregateJson },
			{ path: `${root}/pilot-aggregates-${digest}.csv`, content: aggregatesCsv(bundle.aggregates) },
		],
	};
}

function detailsCsv(rows: ReturnType<typeof sanitizedDetails>): string {
	const headers = [
		'kind', 'proposal_ref_pseudonymous', 'phase', 'mode', 'presented_or_started_at', 'window_from', 'window_to',
		'uncertainty_ms', 'polling_interval_ms', 'evidence_quality', 'terminal_status', 'decision', 'effective_result',
		'correction_cause', 'human_boundary_at', 'exclusion_reason', 'completed_at', 'terminal_outcome', 'terminal_recorded_at',
		'recovery_kind',
		'platform', 'platform_version', 'obsidian_version', 'tyrian_version',
	] as const;
	const values = rows.map((row) => {
		const proposal = row.kind === 'proposal' ? row : null;
		const session = row.kind === 'session' ? row : null;
		const recovery = row.kind === 'recovery' ? row : null;
		return [
			row.kind, proposal?.proposalRef ?? '', proposal?.phase ?? '', proposal?.mode ?? '',
			proposal?.reviewPresentedAt ?? session?.startedAt ?? recovery?.presentedAt ?? '',
			proposal?.window.from ?? '', proposal?.window.to ?? '', proposal?.window.uncertaintyMs ?? '',
			proposal?.pollingIntervalMs ?? '',
			proposal?.evidenceQuality ?? '', proposal?.terminal?.status ?? '', proposal?.terminal?.decision ?? '',
			proposal?.terminal?.effectiveResult ?? '', proposal?.terminal?.correctionCause ?? '',
			proposal?.terminal?.humanBoundaryAt ?? '', proposal?.terminal?.exclusionReason ?? '',
			session?.completedAt ?? '', recovery?.terminal?.outcome ?? '',
			recovery?.terminal?.recordedAt ?? '', recovery?.recoveryKind ?? '', row.environment.platform, row.environment.platformVersion,
			row.environment.obsidianVersion, row.environment.tyrianVersion,
		];
	});
	return csv(headers, values);
}

function aggregatesCsv(aggregation: PilotAggregationV1): string {
	const headers = [
		'scope', 'platform', 'platform_version', 'obsidian_version', 'tyrian_version', 'verdict',
		'start_k', 'start_n', 'start_rate', 'start_wilson_low', 'start_wilson_high', 'start_coverage',
		'start_reviews', 'start_decisions', 'start_expired', 'start_superseded', 'start_invalidated', 'start_workflow_failed',
		...DETECTION_CORRECTION_CAUSES.map((cause) => `start_cause_${cause}`),
		'stop_k', 'stop_n', 'stop_rate', 'stop_wilson_low', 'stop_wilson_high', 'stop_coverage',
		'stop_reviews', 'stop_decisions', 'stop_expired', 'stop_superseded', 'stop_invalidated', 'stop_workflow_failed',
		...DETECTION_CORRECTION_CAUSES.map((cause) => `stop_cause_${cause}`),
		'precision_count', 'precision_interval_count', 'precision_median_s', 'precision_p90_s', 'precision_max_s',
		'precision_median_intervals', 'precision_p90_intervals', 'precision_max_intervals',
		'recovery_presented', 'recovery_succeeded', 'recovery_failed', 'recovery_discarded', 'recovery_rate',
		'forced_restart_presented', 'forced_restart_succeeded', 'forced_restart_failed',
		'forced_restart_discarded', 'forced_restart_rate',
		'unclassified_presented', 'unclassified_succeeded', 'unclassified_failed', 'unclassified_discarded', 'unclassified_rate',
		'completed_sessions', 'sample_revision', 'silent_losses', 'executed_operations',
	] as const;
	const rows = [...aggregation.platforms, ...aggregation.versionStrata].map((row) => [
		row.scope.versions ? 'version_stratum' : 'platform', row.scope.platform,
		row.scope.versions?.platformVersion ?? '', row.scope.versions?.obsidianVersion ?? '',
		row.scope.versions?.tyrianVersion ?? '', row.verdict,
		row.falseStart.k, row.falseStart.n, row.falseStart.rate ?? '', row.falseStart.wilson95?.low ?? '',
		row.falseStart.wilson95?.high ?? '', row.falseStart.coverage ?? '',
		row.falseStart.reviews, row.falseStart.decisions, row.falseStart.expired, row.falseStart.superseded,
		row.falseStart.invalidated, row.falseStart.workflowFailed,
		...DETECTION_CORRECTION_CAUSES.map((cause) => row.falseStart.causes[cause]),
		row.falseStop.k, row.falseStop.n, row.falseStop.rate ?? '', row.falseStop.wilson95?.low ?? '',
		row.falseStop.wilson95?.high ?? '', row.falseStop.coverage ?? '',
		row.falseStop.reviews, row.falseStop.decisions, row.falseStop.expired, row.falseStop.superseded,
		row.falseStop.invalidated, row.falseStop.workflowFailed,
		...DETECTION_CORRECTION_CAUSES.map((cause) => row.falseStop.causes[cause]),
		row.precision.count, row.precision.intervalCount, row.precision.seconds?.median ?? '', row.precision.seconds?.p90 ?? '',
		row.precision.seconds?.maximum ?? '', row.precision.intervalMultiples?.median ?? '',
		row.precision.intervalMultiples?.p90 ?? '', row.precision.intervalMultiples?.maximum ?? '',
		row.recovery.presented, row.recovery.succeeded, row.recovery.failed, row.recovery.discarded,
		row.recovery.rate ?? '', row.recovery.forcedRestart.presented, row.recovery.forcedRestart.succeeded,
		row.recovery.forcedRestart.failed, row.recovery.forcedRestart.discarded, row.recovery.forcedRestart.rate ?? '',
		row.recovery.unclassified.presented, row.recovery.unclassified.succeeded,
		row.recovery.unclassified.failed, row.recovery.unclassified.discarded, row.recovery.unclassified.rate ?? '',
		row.completedSessions, row.evidence.sampleRevision, row.evidence.silentLosses, row.evidence.executedOperations,
	]);
	return csv(headers, rows);
}

function csv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
	return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: unknown): string {
	let text = typeof value === 'string' ? value
		: typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
	if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (typeof value !== 'object' || value === null) return value;
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, nested]) => [key, sortValue(nested)]));
}

async function ensureFolders(vault: PilotMetricsExportVault, path: string): Promise<void> {
	let current = '';
	for (const segment of path.split('/')) {
		current = current.length === 0 ? segment : `${current}/${segment}`;
		if (!vault.file(current)) {
			try { await vault.createFolder(current); }
			catch { if (!vault.file(current)) throw new Error('Pilot export folder is unavailable.'); }
		}
	}
}
