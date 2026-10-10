import { Plugin } from 'obsidian';

import { createObsidianHost } from './host/obsidian/obsidian-host';
import { createTyrianRuntime, type TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * The Obsidian plugin (R1c): a thin adapter and nothing else. Everything Tyrian does is the
 * host-neutral core `createTyrianRuntime` composes (`src/runtime/tyrian-companion-core.ts`), the
 * same object Hebra starts; this class only hands it the `ObsidianHost` built over itself
 * (`src/host/obsidian/`) and forwards Obsidian's lifecycle to it.
 *
 * `onload` is the runtime's `start()`. `onunload` is the synchronous half of its `stop()`:
 * Obsidian does not await an unload, so the drain that follows runs on its own, exactly as it did
 * when this class was the core (`TyrianCompanionCore.awaitLocalDebugShutdown` exposes it).
 */
export default class TyrianCompanionPlugin extends Plugin {
	private companionCore: TyrianCompanionCore | null = null;

	/**
	 * The core over this plugin's `ObsidianHost`. Built on first use rather than in the
	 * constructor, like the host before it, so it reads the `app` and `manifest` the plugin holds
	 * by then (the host itself reads them on every call).
	 */
	get core(): TyrianCompanionCore {
		this.companionCore ??= createTyrianRuntime(createObsidianHost(this));
		return this.companionCore;
	}

	override async onload(): Promise<void> {
		await this.core.start();
	}

	override onunload(): void {
		this.core.onunload();
	}
}
