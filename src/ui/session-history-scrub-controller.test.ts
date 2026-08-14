import { describe, expect, it, vi } from 'vitest';

import type { SessionHistoryScrubResult } from '../sessions/session-history';
import {
	SessionHistoryScrubController,
	type SessionHistoryScrubControllerPorts,
} from './session-history-scrub-controller';

describe('SessionHistoryScrubController', () => {
	it('cancels after preview without invoking the destructive operation', async () => {
		const ports = portsHarness();
		ports.confirm.mockResolvedValue(false);
		const controller = new SessionHistoryScrubController(ports);

		await expect(controller.run()).resolves.toMatchObject({ status: 'cancelled' });
		expect(ports.preview).toHaveBeenCalledOnce();
		expect(ports.cancelPreview).toHaveBeenCalledOnce();
		expect(ports.cancelPreview).toHaveBeenCalledWith('opaque-preview-token');
		expect(ports.scrub).not.toHaveBeenCalled();
	});

	it('keeps preview, modal, and scrub in one single flight', async () => {
		const ports = portsHarness();
		let resolveConfirmation!: (confirmed: boolean) => void;
		ports.confirm.mockReturnValue(new Promise((resolve) => { resolveConfirmation = resolve; }));
		const controller = new SessionHistoryScrubController(ports);

		const first = controller.run();
		const second = controller.run();
		expect(second).toBe(first);
		await Promise.resolve();
		expect(ports.preview).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(ports.confirm).toHaveBeenCalledOnce();
		resolveConfirmation(true);
		await first;
		expect(ports.scrub).toHaveBeenCalledOnce();
		expect(ports.scrub).toHaveBeenCalledWith('opaque-preview-token');
	});

	it('surfaces a stale capability without retrying or bypassing the preview', async () => {
		const ports = portsHarness();
		ports.scrub.mockResolvedValue({
			status: 'stale', erased: 0, alreadyAbsent: 0, message: 'The scrub preview is no longer valid.',
		});
		const controller = new SessionHistoryScrubController(ports);

		await expect(controller.run()).resolves.toMatchObject({
			status: 'completed', result: { status: 'stale', erased: 0, alreadyAbsent: 0 },
		});
		expect(ports.preview).toHaveBeenCalledOnce();
		expect(ports.scrub).toHaveBeenCalledOnce();
	});
});

function portsHarness() {
	const ports = {
		preview: vi.fn(async () => ({ status: 'ready', token: 'opaque-preview-token', sessions: 2 } as const)),
		confirm: vi.fn(async () => true),
		cancelPreview: vi.fn(),
		scrub: vi.fn(async (): Promise<SessionHistoryScrubResult> => ({ status: 'erased', erased: 2, alreadyAbsent: 0 })),
	} satisfies SessionHistoryScrubControllerPorts;
	return ports;
}
