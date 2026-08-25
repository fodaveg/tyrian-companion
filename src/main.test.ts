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

interface InventoryVaultIntentHarness {
	inventoryVaultSync: {
		preview(): Promise<unknown>;
		apply(): Promise<unknown>;
	};
	activateInventoryAdvisorView(): Promise<unknown>;
	renderInventoryAdvisorViews(): void;
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

describe('durable inventory Vault commands', () => {
	it('does not capture on construction and previews only through the explicit command', async () => {
		const pending = deferred<void>();
		const preview = vi.fn(() => pending.promise);
		const render = vi.fn();
		const activate = vi.fn(async () => undefined);
		const plugin = { inventoryVaultSync: { preview, apply: vi.fn() }, activateInventoryAdvisorView: activate, renderInventoryAdvisorViews: render };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const invoke = (TyrianCompanionPlugin.prototype as unknown as {
			previewInventoryVaultSync(this: InventoryVaultIntentHarness, openView?: boolean): Promise<void>;
		}).previewInventoryVaultSync;
		expect(preview).not.toHaveBeenCalled();
		const operation = invoke.call(plugin, false);
		expect(preview).toHaveBeenCalledOnce();
		expect(activate).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledOnce();
		pending.resolve(undefined);
		await operation;
		expect(render).toHaveBeenCalledTimes(2);
	});

	it('opens the existing advisor before command preview and applies only the retained plan action', async () => {
		const order: string[] = [];
		const plugin = {
			inventoryVaultSync: {
				preview: vi.fn(async () => { order.push('preview'); }),
				apply: vi.fn(async () => { order.push('apply'); }),
			},
			activateInventoryAdvisorView: vi.fn(async () => { order.push('open'); }),
			renderInventoryAdvisorViews: vi.fn(() => { order.push('render'); }),
		};
		const prototype = TyrianCompanionPlugin.prototype as unknown as {
			previewInventoryVaultSync(this: InventoryVaultIntentHarness, openView?: boolean): Promise<void>;
			applyInventoryVaultSync(this: InventoryVaultIntentHarness): Promise<void>;
		};
		await prototype.previewInventoryVaultSync.call(plugin, true);
		expect(order.slice(0, 2)).toEqual(['open', 'preview']);
		order.length = 0;
		await prototype.applyInventoryVaultSync.call(plugin);
		expect(plugin.inventoryVaultSync.preview).toHaveBeenCalledOnce();
		expect(plugin.inventoryVaultSync.apply).toHaveBeenCalledOnce();
		expect(order).toEqual(['apply', 'render', 'render']);
	});
});

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
