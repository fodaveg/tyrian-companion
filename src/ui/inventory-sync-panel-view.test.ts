import { describe, expect, it } from 'vitest';

import { createTranslator } from '../core/i18n';
import { inventorySyncPanel, inventorySyncSummaryParams } from './inventory-sync-panel-view';

describe('inventory sync panel projection', () => {
	it('projects idle, live progress, and saved failure without I/O or timers', () => {
		const translator = createTranslator('es');
		expect(inventorySyncPanel({ status: 'idle', lastRun: null }, translator)).toMatchObject({
			statusWord: 'INACTIVO', percent: 0, tone: 'normal',
		});
		expect(inventorySyncPanel({
			status: 'running', phase: 'apply', percent: 90, completed: 9, total: 10,
			captureStep: null, captureLeg: null, elapsedMs: 12_000,
		}, translator)).toMatchObject({
			statusWord: 'EN CURSO', percent: 90, progressLabel: '90% · 9/10 · Escritura · 12 s',
		});
		expect(inventorySyncPanel({
			status: 'idle', lastRun: {
				status: 'error', finishedAt: '2026-08-29T04:00:00.000Z', durationMs: 1,
				summary: null, error: 'write_unavailable',
			},
		}, translator)).toMatchObject({
			statusWord: 'ERROR', tone: 'error', message: 'No se pudieron escribir las notas de inventario de forma segura.',
		});
	});

	it('keeps summary interpolation redacted and structurally complete', () => {
		expect(inventorySyncSummaryParams({
			positions: 5, create: 1, update: 2, unchanged: 1, deactivate: 1, conflicts: 0,
		})).toEqual({ positions: 5, create: 1, update: 2, unchanged: 1, deactivate: 1, conflicts: 0 });
	});
});
