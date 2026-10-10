import { describe, expect, it } from 'vitest';

import type { TyrianModalRequest } from '../host/tyrian-host';
import { TyrianModal, type TyrianModalUi } from './tyrian-modal';

class RecordingModal extends TyrianModal {
	readonly events: string[] = [];
	mountedInto: unknown = null;

	protected override title(): string { return 'Título'; }

	onOpen(): void {
		this.mountedInto = this.contentEl;
		this.events.push('open');
	}

	override onClose(): void { this.events.push('close'); }
}

/** A host slot that mounts at once (Obsidian's `Modal.open` runs `onOpen` synchronously). */
function immediateHost() {
	const requests: TyrianModalRequest[] = [];
	const content = { id: 'content' } as unknown as HTMLElement;
	const hostCloses: number[] = [];
	const ui: TyrianModalUi = {
		openModal: (request) => {
			requests.push(request);
			request.mount(content, () => { hostCloses.push(1); request.onClose?.(); });
			return { close: () => { hostCloses.push(2); request.onClose?.(); } };
		},
	};
	return { ui, requests, content, hostCloses };
}

describe('TyrianModal', () => {
	it('opens through the host with its title and fills the content the host mounts', () => {
		const host = immediateHost();
		const modal = new RecordingModal(host.ui);

		modal.open();

		expect(host.requests.map((request) => request.title)).toEqual(['Título']);
		expect(modal.mountedInto).toBe(host.content);
		expect(modal.events).toEqual(['open']);
	});

	it('closes through the close the host handed to mount, runs onClose once, and ignores a second close', () => {
		const host = immediateHost();
		const modal = new RecordingModal(host.ui);
		modal.open();

		modal.close();
		modal.close();

		expect(host.hostCloses).toEqual([1]);
		expect(modal.events).toEqual(['open', 'close']);
	});

	it('closes through the handle when the host has not mounted it (yet)', () => {
		let request: TyrianModalRequest | null = null;
		let handleCloses = 0;
		const ui: TyrianModalUi = {
			openModal: (next) => {
				request = next;
				return { close: () => { handleCloses += 1; next.onClose?.(); } };
			},
		};
		const modal = new RecordingModal(ui);
		modal.open();
		expect(request).not.toBeNull();

		modal.close();

		expect(handleCloses).toBe(1);
		expect(modal.events).toEqual(['close']);
	});

	it('treats a close from the host itself (Esc, the ✕) like its own: onClose runs and close() is then a no-op', () => {
		const host = immediateHost();
		const modal = new RecordingModal(host.ui);
		modal.open();

		host.requests[0]!.onClose?.();
		modal.close();

		expect(modal.events).toEqual(['open', 'close']);
		expect(host.hostCloses).toEqual([]);
	});

	it('has no title unless the modal gives one', () => {
		const host = immediateHost();
		new class extends TyrianModal { onOpen(): void {} }(host.ui).open();
		expect(host.requests[0]!.title).toBeUndefined();
	});
});
