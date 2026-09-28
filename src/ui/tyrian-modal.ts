import type { TyrianUiPort } from '../host/tyrian-host';

/** What a modal needs from the host: only its modal slot. */
export type TyrianModalUi = Pick<TyrianUiPort, 'openModal'>;

/**
 * The shape Tyrian's modals had as Obsidian `Modal` subclasses (`onOpen` fills `contentEl`,
 * `onClose` tears it down, `open`/`close` from outside), over `TyrianUiPort.openModal` so the host
 * decides what a modal is. `title()` replaces `setTitle` inside `onOpen`: the host shows it as the
 * modal opens. ObsidianHost opens a real `Modal`, sets that title and empties `contentEl` before
 * calling `onClose`, so each modal renders and closes exactly as it did before R1c.
 */
export abstract class TyrianModal {
	/** The host's content element, from the moment `onOpen` runs. */
	protected contentEl!: HTMLElement;
	private opened = false;
	private closeModal: (() => void) | null = null;

	constructor(private readonly ui: TyrianModalUi) {}

	/** Shown by the host as the modal's title; none by default. Read once, on `open()`. */
	protected title(): string | undefined {
		return undefined;
	}

	open(): void {
		this.opened = true;
		const handle = this.ui.openModal({
			title: this.title(),
			mount: (content, close) => {
				this.contentEl = content;
				this.closeModal = close;
				this.onOpen();
			},
			onClose: () => {
				this.opened = false;
				this.closeModal = null;
				this.onClose();
			},
		});
		// A host that has not mounted it yet (or never will) still closes it through the handle.
		if (this.opened) this.closeModal ??= () => { handle.close(); };
	}

	/** Closes it through the host, which then runs `onClose`; a modal already closed stays so. */
	close(): void {
		if (this.opened) this.closeModal?.();
	}

	abstract onOpen(): void;

	onClose(): void {}
}
