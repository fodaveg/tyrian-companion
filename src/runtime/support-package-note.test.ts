import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../core/settings';
import { TyrianCompanionCore } from './tyrian-companion-core';

const NOTE_PATH = 'Tyrian Companion/diagnostics/Tyrian - Paquete de soporte.md';
const RECORD = JSON.stringify({
	schemaVersion: 1, timestampUtc: '2026-10-09T08:00:00.000Z', sequence: 1,
	pluginVersion: '0.6.16', level: 'error', actionId: 'action-1', correlationId: 'flow-1',
	component: 'session', action: 'session_projection', phase: 'failure', code: 'precondition_failed',
});

/** A Hebra-like host: the support package has no filesystem to land on, so it asks for a note. */
function hebraHarness(asNote: boolean) {
	const notes = new Map<string, string>();
	const adapterWrite = vi.fn(async () => undefined);
	const openNote = vi.fn();
	const host = {
		capabilities: { supportPackageAsNote: asNote },
		environment: { pluginVersion: '0.6.16', platform: 'linux' },
		vault: {
			saveNote: vi.fn(async (path: string, content: string) => { notes.set(path, content); }),
			adapter: {
				exists: async () => false, mkdir: async () => undefined, write: adapterWrite,
			},
		},
		ui: { openNote },
	};
	const harness = {
		host,
		settings: {
			...DEFAULT_SETTINGS,
			apiKeySecret: 'private-secret-name',
			alertWebhookUrl: 'https://hooks.example.test/services/SECRET-TOKEN',
		},
		localDebug: { exportSanitized: async () => `${RECORD}\n` },
		localDebugActions: null,
	};
	const exportPackage = (TyrianCompanionCore.prototype as unknown as {
		exportLocalDebugPackage: (this: typeof harness) => Promise<string | null>;
	}).exportLocalDebugPackage;
	return { harness, notes, adapterWrite, openNote, run: () => exportPackage.call(harness) };
}

describe('support package as a Hebra note', () => {
	it('creates one library note, opens it and writes nothing to the local file store', async () => {
		const { notes, adapterWrite, openNote, run } = hebraHarness(true);
		await expect(run()).resolves.toBe(NOTE_PATH);
		expect(adapterWrite).not.toHaveBeenCalled();
		expect(notes.size).toBe(1);
		expect(openNote).toHaveBeenCalledWith(NOTE_PATH);
		const body = notes.get(NOTE_PATH)!;
		expect(body).toContain('# Tyrian - Paquete de soporte');
		expect(body).toContain('precondition_failed');
	});

	it('updates the same note on the next export instead of piling up copies', async () => {
		const { notes, run, harness } = hebraHarness(true);
		await run();
		harness.localDebug.exportSanitized = async () => `${RECORD.replace('flow-1', 'flow-2')}\n`;
		await expect(run()).resolves.toBe(NOTE_PATH);
		expect(notes.size).toBe(1);
		expect(notes.get(NOTE_PATH)).toContain('flow-2');
		expect(notes.get(NOTE_PATH)).not.toContain('flow-1');
	});

	it('carries no secret and is not mistaken for a session, inventory or Base note', async () => {
		const { notes, run } = hebraHarness(true);
		await run();
		const body = notes.get(NOTE_PATH)!;
		expect(body).not.toContain('private-secret-name');
		expect(body).not.toContain('SECRET-TOKEN');
		expect(body).not.toContain('hooks.example.test');
		// No frontmatter at all, no Tyrian kind key and no tag the history or the Bases read.
		expect(body.startsWith('---')).toBe(false);
		expect(body).not.toMatch(/^tc_[a-z_]+:/mu);
		expect(body).not.toMatch(/^tags?:/mu);
		expect(body).not.toContain('gw2_');
		expect(body).not.toContain('tyrian-companion-');
	});

	it('keeps the local file when the host does not ask for a note (Obsidian)', async () => {
		const { adapterWrite, notes, openNote, run } = hebraHarness(false);
		await expect(run()).resolves.toMatch(/^Tyrian Companion\/diagnostics\/diagnostic-export-/u);
		expect(adapterWrite).toHaveBeenCalledTimes(1);
		expect(notes.size).toBe(0);
		expect(openNote).not.toHaveBeenCalled();
	});
});
