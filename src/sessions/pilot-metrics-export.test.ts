import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import { PilotMetricsExporter, type PilotMetricsExportFile, type PilotMetricsExportVault } from './pilot-metrics-export';
import { createPilotEnvironment, pilotProposalRef, type PilotJournalSnapshotV1 } from './pilot-metrics-model';
import { IndexedDbPilotMetricsStore } from './pilot-metrics-store';

describe('PilotMetricsExporter', () => {
	it('previews without writing, then creates four deterministic sanitized files', async () => {
		const vault = new MemoryVault();
		const exporter = new PilotMetricsExporter(vault);
		const snapshot = await fixture('inactivity-stop:secret-account-id:before:after');
		const preview = await exporter.preview(snapshot, 'ready', 'Tyrian Companion');
		expect(vault.contents.size).toBe(0);
		expect(preview.files).toHaveLength(4);
		expect(preview.pseudonymous).toBe(true);
		const result = await exporter.export(snapshot, 'ready', 'Tyrian Companion');
		expect(result).toMatchObject({ status: 'written', digest: preview.digest });
		expect(vault.createdFiles).toHaveLength(4);
		const payload = [...vault.contents.values()].join('\n');
		for (const canary of ['secret-account-id', 'apiKey', '/home/david', 'snapshotId', '=HYPERLINK']) {
			expect(payload).not.toContain(canary);
		}
		expect(payload).toContain('stable pseudonym, not anonymization');
		expect(payload).toContain('"start_workflow_failed"');
		expect(payload).toContain('"stop_cause_temporary_pause"');
		expect(payload).toContain('"mode"');
		expect(payload).toContain('"assisted"');
		expect(payload).toContain('"uncertainty_ms"');
	});

	it('is create-only, returns unchanged for exact files and preflights conflicts before any write', async () => {
		const snapshot = await fixture('proposal-safe');
		const vault = new MemoryVault();
		const exporter = new PilotMetricsExporter(vault);
		await expect(exporter.export(snapshot, 'ready', 'Output')).resolves.toMatchObject({ status: 'written' });
		await expect(exporter.export(snapshot, 'ready', 'Output')).resolves.toMatchObject({ status: 'unchanged' });
		const writes = vault.createdFiles.length;
		const path = vault.createdFiles[0]!;
		vault.contents.set(path, 'contradictory');
		await expect(exporter.export(snapshot, 'ready', 'Output')).resolves.toMatchObject({ status: 'conflict' });
		expect(vault.createdFiles).toHaveLength(writes);
	});

	it('retries an interrupted identical four-file set without overwriting existing files', async () => {
		const snapshot = await fixture('proposal-retry');
		const vault = new MemoryVault(2);
		const exporter = new PilotMetricsExporter(vault);
		await expect(exporter.export(snapshot, 'ready', 'Output')).resolves.toMatchObject({ status: 'unavailable' });
		expect(vault.createdFiles).toHaveLength(2);
		vault.failAfter = null;
		await expect(exporter.export(snapshot, 'ready', 'Output')).resolves.toMatchObject({ status: 'written' });
		expect(vault.contents.size).toBeGreaterThanOrEqual(4);
		expect(new Set(vault.createdFiles)).toHaveLength(4);
	});

	it('exports only the snapshot from its vault-scoped journal', async () => {
		const factory = new IDBFactory();
		const database = `pilot-export-scope-${crypto.randomUUID()}`;
		const first = new IndexedDbPilotMetricsStore(factory, 'vault-a', database);
		const second = new IndexedDbPilotMetricsStore(factory, 'vault-b', database);
		const linux = await fixture('linux-only');
		const windows = await fixture('windows-only');
		windows.profile = { ...windows.profile, platform: 'windows_beta', platformVersion: '11.24H2' };
		windows.observations[0]!.environment = windows.profile;
		await first.saveProfile(linux.profile);
		await first.ensureObservation(linux.observations[0]!);
		await second.saveProfile(windows.profile);
		await second.ensureObservation(windows.observations[0]!);
		const loadedLinux = await first.load();
		const loadedWindows = await second.load();
		if (loadedLinux.status !== 'ok' || loadedWindows.status !== 'ok') throw new Error('Expected scoped journals.');
		const vault = new MemoryVault();
		const exporter = new PilotMetricsExporter(vault);
		const linuxResult = await exporter.export(loadedLinux.value, 'ready', 'Linux');
		const windowsResult = await exporter.export(loadedWindows.value, 'ready', 'Windows');
		if (linuxResult.status !== 'written' || windowsResult.status !== 'written') throw new Error('Expected exports.');
		const linuxPayload = linuxResult.files.map((path) => vault.contents.get(path)).join('\n');
		const windowsPayload = windowsResult.files.map((path) => vault.contents.get(path)).join('\n');
		expect(linuxPayload).toContain('linux_steam_proton');
		expect(linuxPayload).not.toContain('windows_beta');
		expect(windowsPayload).toContain('windows_beta');
		expect(windowsPayload).not.toContain('linux_steam_proton');
	});
});

class MemoryVault implements PilotMetricsExportVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly createdFiles: string[] = [];
	constructor(public failAfter: number | null = null) {}
	file(path: string): PilotMetricsExportFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	async read(file: PilotMetricsExportFile): Promise<string> { return this.contents.get(file.path)!; }
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<PilotMetricsExportFile> {
		if (this.failAfter !== null && this.createdFiles.length >= this.failAfter) throw new Error('simulated quota');
		if (this.contents.has(path)) throw new Error('overwrite');
		this.contents.set(path, content); this.createdFiles.push(path); return { path };
	}
}

async function fixture(proposalId: string): Promise<PilotJournalSnapshotV1> {
	const environment = createPilotEnvironment({
		platform: 'linux_steam_proton', platformVersion: '10.0-1', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
	})!;
	return {
		version: 1, profile: environment,
		verification: { version: 1, silentLosses: 'none_observed', reviewedAt: '2026-08-20T10:02:00.000Z' },
		observations: [{
			version: 1, kind: 'proposal', proposalRef: await pilotProposalRef(proposalId), phase: 'stop', mode: 'assisted',
			reviewPresentedAt: '2026-08-20T10:00:00.000Z',
			window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z', uncertaintyMs: 60_000 },
			pollingIntervalMs: 60_000, evidenceQuality: 'complete', environment,
			terminal: {
				status: 'decided', decidedAt: '2026-08-20T10:01:00.000Z', decision: 'accepted',
				effectiveResult: 'accepted_workflow_succeeded', correctionCause: null, humanBoundaryAt: null,
			},
		}],
	};
}
