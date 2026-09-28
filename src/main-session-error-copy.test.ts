import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * Sesión's incident callout "Copiar detalle técnico" (H18.36, boceto lámina 2.3): the code never
 * renders as visible text, only to the clipboard, so a refused write must say so instead of
 * leaving the player believing it copied. `companion-view.ts` only ever hands the detail to this
 * port (`companion-view.test.ts` covers that it never touches `navigator.clipboard`/`Notice`
 * itself, per `halloween-alert-panel.ts`'s own rule); this file covers the actual write, through
 * the host's clipboard port since R1a (`TyrianHost.clipboard`), and its Notice-on-failure.
 */
describe('"Copiar detalle técnico" (companion-view.ts incident callout)', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	interface CopyLastErrorDetailHarness {
		host: { clipboard: { writeText(text: string): Promise<void> } };
		settings: { language: 'en' | 'es' };
		emitNotice(message: string, source: string): void;
	}
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with an explicit isolated harness below.
	const copyLastErrorDetail = (TyrianCompanionCore.prototype as unknown as {
		copyLastErrorDetail(this: CopyLastErrorDetailHarness, detail: string): Promise<void>;
	}).copyLastErrorDetail;

	it('writes the detail to the clipboard and never notifies on success', async () => {
		const writeText = vi.fn(async (_text: string) => undefined);
		const emitNotice = vi.fn();

		await copyLastErrorDetail.call(
			{ host: { clipboard: { writeText } }, settings: { language: 'en' }, emitNotice },
			'network_failure · connection/connection_check · 2026-09-08T12:22:00.000Z',
		);

		expect(writeText).toHaveBeenCalledWith('network_failure · connection/connection_check · 2026-09-08T12:22:00.000Z');
		expect(emitNotice).not.toHaveBeenCalled();
	});

	it('never rejects and notifies instead when the clipboard refuses the write', async () => {
		const clipboard = {
			writeText: async () => { throw new DOMException('Document is not focused.', 'NotAllowedError'); },
		};
		const emitNotice = vi.fn();

		await expect(copyLastErrorDetail.call({ host: { clipboard }, settings: { language: 'en' }, emitNotice }, 'some detail'))
			.resolves.toBeUndefined();

		expect(emitNotice).toHaveBeenCalledOnce();
		expect(emitNotice).toHaveBeenCalledWith('The technical detail could not be copied.', 'session_error_copy');
	});
});
