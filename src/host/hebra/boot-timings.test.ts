// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../../core/boot-trace';
import { LocalDebugLogger } from '../../core/local-debug-logger';
import type { LocalDebugRecordInput } from '../../core/local-debug-contract';
import { sanitizeLocalDebugRecord } from '../../core/local-debug-sanitizer';
import { createTyrianTestApi, hebraSettingsKey, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { CORE_MODULE_EVALUATED_MS, createTyrianRuntime } from '../../runtime/tyrian-companion-core';
import { activateTyrian } from './hebra-runtime';

/**
 * Z26 in Hebra: the REAL core over HebraHost, with the debug log on, writes ONE `plugin_load` line `boot_timings` that
 * carries the host's own phases and the counters of the first walk of the library next to the core's.
 */

afterEach(() => {
	document.body.className = '';
	vi.restoreAllMocks();
});

/** A trace whose clock moves 10 ms per reading, starting after the module evaluated, so the order is the order of the marks. */
function steppedTrace() {
	let now = CORE_MODULE_EVALUATED_MS;
	return createBootTrace(() => (now += 10), 0);
}

function hebraWithNotes(logging: boolean): TyrianTestApi {
	const test = createTyrianTestApi({ platform: 'linux' });
	test.library.addFolder('tc', 'root', 'Tyrian Companion');
	test.library.addNote('broken', '<!-- tyrian-companion-wallet broken -->\n# Gold', { folderId: 'tc' });
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({
		outputFolder: 'Tyrian Companion', debugLoggingEnabled: logging, debugLoggingLevel: 'debug', schemaVersion: 99,
	}));
	return test;
}

async function start(test: TyrianTestApi, bootTrace = steppedTrace()): Promise<() => Promise<void>> {
	const cleanup = await activateTyrian(test.api, {
		indexedDB: new IDBFactory(),
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		createRuntime: (host) => createTyrianRuntime(host),
		bootTrace,
	});
	return async () => { await cleanup(); };
}

/** What the logger was handed, as the file would hold it (through the sanitizer). */
function recordedBootLines(inputs: LocalDebugRecordInput[]) {
	return inputs
		.filter((input) => input.action === 'plugin_load' && input.state === 'boot_timings')
		.map((input) => sanitizeLocalDebugRecord(input, { timestampMs: 0, sequence: 1, pluginVersion: 'test' }));
}

describe('boot_timings on Hebra', () => {
	it('writes the host phases and the walk counters once, before the core\'s own phases, in order', async () => {
		// The spy lets the call through: the logger is the real one.
		const record = vi.spyOn(LocalDebugLogger.prototype, 'record');
		const inputs = (): LocalDebugRecordInput[] => record.mock.calls.map(([input]) => input);
		const test = hebraWithNotes(true);
		const cleanup = await start(test);
		await vi.waitFor(() => { expect(recordedBootLines(inputs())).toHaveLength(1); }, { timeout: 15_000 });
		await new Promise((resolve) => { window.setTimeout(resolve, 100); });

		const lines = recordedBootLines(inputs());
		expect(lines).toHaveLength(1);
		const details = lines[0]!.details as { bootMs: Record<string, number>; bootCounts: Record<string, number> };
		const phases = Object.keys(details.bootMs);
		expect(phases.slice(0, 6)).toEqual(['module', 'hebraReady', 'hebraSettings', 'hebraIndex', 'hebraSeed', 'hebraHost']);
		for (const phase of ['onload', 'settings', 'registered', 'diagnostics', 'runtimeStart', 'mode', 'sessions', 'live', 'ready', 'priceHistory', 'halloween', 'renderRequested']) {
			expect(phases, phase).toContain(phase);
		}
		expect(phases.indexOf('hebraHost')).toBeLessThan(phases.indexOf('onload'));
		expect(phases.indexOf('renderRequested')).toBe(phases.length - 1);
		const values = Object.values(details.bootMs);
		expect(values.every((value) => Number.isInteger(value))).toBe(true);
		expect(values).toEqual([...values].sort((left, right) => left - right));
		// The walk read one page of notes (the one note there is) and opened it; nothing was adopted.
		expect(details.bootCounts.pages).toBeGreaterThanOrEqual(1);
		expect(details.bootCounts.notesRead).toBe(1);
		expect(details.bootCounts.newlyAdopted).toBe(0);
		expect(Object.keys(details.bootCounts).sort()).toEqual(['newlyAdopted', 'notesRead', 'pages']);
		// Numbers only: no note id, title or path in the line.
		expect(JSON.stringify(lines[0])).not.toMatch(/broken|Gold|Tyrian Companion/u);
		await cleanup();
	}, 30_000);

	it('writes nothing with the debug log off', async () => {
		const record = vi.spyOn(LocalDebugLogger.prototype, 'record');
		const bootTrace = steppedTrace();
		const cleanup = await start(hebraWithNotes(false), bootTrace);
		// The trace is spent when the start ends, and the logger, which is the gate, took no line of it.
		await vi.waitFor(() => { expect(bootTrace.take()).toBeNull(); }, { timeout: 15_000 });
		await cleanup();
		const taken: unknown[] = [];
		record.mock.calls.forEach(([input], call) => { if (input.state === 'boot_timings') taken.push(record.mock.results[call]?.value); });
		expect(taken.every((value) => value === false)).toBe(true);
	}, 30_000);
});
