import { describe, expect, it, vi } from 'vitest';

import TyrianCompanionPlugin from './main';
import { SessionCommandController } from './ui/session-command-controller';
import type { PreparedSessionCommand, SessionCommandPorts } from './ui/session-command-controller';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import type { SessionStartInput } from './sessions/session-start-capture';

interface StartIntentHarness {
	app: unknown;
	settings: { language: 'en'; preferredCharacter: string };
	startModal: ManualSessionStartModal | null;
	startManualSession(input: SessionStartInput): Promise<void>;
}

describe('manual session start command', () => {
	it('resolves Cancel or Esc from the real start modal without calling its backend or mutating runtime', async () => {
		const runtime = { mutations: 0 };
		const startManualSession = vi.fn(async () => { runtime.mutations += 1; });
		const plugin: StartIntentHarness = {
			app: {},
			settings: { language: 'en', preferredCharacter: 'Astra Uno' },
			startModal: null,
			startManualSession,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const prepareStartIntent = (TyrianCompanionPlugin.prototype as unknown as {
			prepareStartIntent(this: StartIntentHarness): Promise<PreparedSessionCommand | null>;
		}).prepareStartIntent;
		const notify = vi.fn();
		const controller = new SessionCommandController({
			getContext: () => ({
				state: { version: 1, status: 'idle' },
				recovery: { status: 'none' },
				connection: 'connected',
				stopFailure: null,
			}),
			prepare: () => prepareStartIntent.call(plugin),
			notify,
		} satisfies SessionCommandPorts);

		const run = controller.run('start-farming-session');
		await flush();
		expect(plugin.startModal).toBeInstanceOf(ManualSessionStartModal);
		if (!plugin.startModal) throw new Error('Expected the start modal to be open.');
		plugin.startModal.close();
		await expect(run).resolves.toBeUndefined();

		expect(plugin.startModal).toBeNull();
		expect(startManualSession).not.toHaveBeenCalled();
		expect(runtime.mutations).toBe(0);
		expect(notify).not.toHaveBeenCalled();
	});
});

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
