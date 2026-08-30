import { describe, expect, it, vi } from 'vitest';

import { TyrianCompanionView } from './companion-view';
import type { LocalDebugStatus } from '../core/local-debug-contract';

describe('Companion local diagnostics warning', () => {
	it('renders a live degraded warning with a navigable Settings action', () => {
		const opened = vi.fn();
		const texts: string[] = [];
		let role = '';
		let click: (() => void) | null = null;
		const status: LocalDebugStatus = {
			enabled: true, minimumLevel: 'debug', state: 'degraded', path: 'test-config-dir/plugins/tyrian-companion/logs/',
			bytes: 0, fileCount: 0, lastEventAt: null, droppedRecords: 1,
			errorCode: 'logger_failure', queuedRecords: 0, recoveredTails: 0,
		};
		const warning = {
			setAttr: (name: string, value: string) => { if (name === 'role') role = value; },
			createEl: (_tag: string, options: { text: string }) => {
				texts.push(options.text);
				return { addEventListener: (_name: string, listener: () => void) => { click = listener; } };
			},
		};
		const container = { createDiv: () => warning };
		const harness = {
			actions: {
				getLocalDebugStatus: () => status,
				getLocale: () => 'en' as const,
				openLocalDebugSettings: opened,
			},
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderLocalDebugWarning(this: typeof harness, container: { createDiv(): typeof warning }): void;
		}).renderLocalDebugWarning;

		render.call(harness, container);
		expect(role).toBe('alert');
		expect(texts).toEqual([
			'Local diagnostics are degraded',
			'Some entries could not be written. Plugin actions continue to work.',
			'Local diagnostics',
		]);
		if (click === null) throw new Error('Expected a Settings action.');
		(click as () => void)();
		expect(opened).toHaveBeenCalledOnce();
	});

	it('renders nothing while the writer is healthy', () => {
		const createDiv = vi.fn();
		const harness = { actions: { getLocalDebugStatus: () => ({ state: 'ready' }) } };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderLocalDebugWarning(this: typeof harness, container: { createDiv(): unknown }): void;
		}).renderLocalDebugWarning;
		render.call(harness, { createDiv });
		expect(createDiv).not.toHaveBeenCalled();
	});
});
