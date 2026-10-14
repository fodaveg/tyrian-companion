/**
 * Where the «En vivo» HUD gets its figures (David, 14 Oct 2026). One shape for the views (`LiveHudData`), two sources:
 *
 * - the COLLECTOR paints from its own live session (`local`, exact to the second), and nothing here reads the vault for it;
 * - a device in CONSULT paints from the frontmatter of `<outputFolder>/Live panel.md`, the note the collector writes
 *   (`sessions/live-panel-note.ts`): read once when the first HUD view subscribes, read again on every vault event at that
 *   path (Hebra's sync delivers the collector's writes as changes), and dropped when the last view unsubscribes. No timer: the
 *   vault's own `onChange` is the only clock, and a view that counts seconds does so by itself.
 *
 * A note missing at that path is `missing`; one that is not a readable live panel note (the player's own, a corrupt one, one
 * of a later format) is `invalid`. A failed read is reported by the host (`run`) and leaves what was shown before.
 */

import type { TyrianVault, TyrianVaultChange } from '../host/tyrian-host-storage';
import { livePanelNotePath, parseLivePanelNote, type LivePanelLiveV1 } from '../sessions/live-panel-note';
import type { LiveHudData } from '../ui/live-hud-view';

export interface LiveHudRuntimeOptions {
	readonly vault: Pick<TyrianVault, 'file' | 'read' | 'onChange'>;
	/** The output folder, read on every look: it can move without a reload. */
	readonly root: () => string;
	/** True on a device in consult mode, the only one that reads the note. */
	readonly consulting: () => boolean;
	/** The collector's own figures, from the live session; may throw, which reaches the view's repaint like any other read. */
	readonly local: () => LivePanelLiveV1;
	/** Runs one read off a vault event; the host's diagnostics own its outcome and any rejection. */
	readonly run: (read: () => Promise<void>) => void;
}

const MISSING: LiveHudData = { state: 'missing', live: null, source: 'note' };
const INVALID: LiveHudData = { state: 'invalid', live: null, source: 'note' };

export class LiveHudRuntime {
	private readonly listeners = new Set<() => void>();
	/** The vault subscription while at least one view listens. */
	private detach: (() => void) | null = null;
	/** What the note last said on a device in consult; null before the first read and once nobody listens. */
	private note: LiveHudData | null = null;
	/** A read is on its way: a second ask before it lands does not start another. */
	private reading = false;
	private disposed = false;

	constructor(private readonly options: LiveHudRuntimeOptions) {}

	/** The figures right now, from the source this device's mode asks for. */
	current(): LiveHudData {
		if (!this.options.consulting()) {
			const live = this.options.local();
			return { state: live.state, live, source: 'local' };
		}
		// A device that switched to consult while the HUD was open has no note yet: ask for it, show «missing» meanwhile.
		if (this.note === null && this.detach !== null) this.readSoon();
		return this.note ?? MISSING;
	}

	/** Tells `listener` when the note changed what the HUD shows. The first listener starts watching the vault; the last one stops. */
	subscribe(listener: () => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		if (this.detach === null) {
			this.detach = this.options.vault.onChange(this.options.root(), (change) => { this.onChange(change); });
			if (this.options.consulting()) this.readSoon();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.release();
		};
	}

	/** Unload: stops watching for good. */
	dispose(): void {
		this.disposed = true;
		this.release();
		this.listeners.clear();
	}

	private release(): void {
		this.detach?.();
		this.detach = null;
		this.note = null;
	}

	/** A vault event: only the note at its path matters, and only to a device in consult (the collector paints from its session). */
	private onChange(change: TyrianVaultChange): void {
		const path = livePanelNotePath(this.options.root());
		if (change.path !== path && change.oldPath !== path) return;
		if (!this.options.consulting()) return;
		this.readSoon();
	}

	private readSoon(): void {
		if (this.reading || this.detach === null) return;
		this.reading = true;
		this.options.run(() => this.read());
	}

	private async read(): Promise<void> {
		try {
			const file = this.options.vault.file(livePanelNotePath(this.options.root()));
			const text = file === null ? null : await this.options.vault.read(file);
			// Released while the read was in flight: nobody is listening any more.
			if (this.detach === null) return;
			const parsed = text === null ? null : parseLivePanelNote(text);
			this.note = text === null ? MISSING : parsed === null || parsed.live === null ? INVALID : { state: parsed.state, live: parsed.live, source: 'note' };
			for (const listener of [...this.listeners]) listener();
		} finally {
			this.reading = false;
		}
	}
}
