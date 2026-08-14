import { buildLootPresentation, type LootPresentationV1 } from './loot-presentation';
import type { PreparedSessionNote } from './session-note-model';

/** Latest-wins cache for the asynchronous completed-runtime read used by the synchronous view. */
export class LootPresentationCache {
	private run = 0;
	private value: LootPresentationV1 | null = null;

	constructor(private readonly onChange: () => void = () => undefined) {}

	get(): LootPresentationV1 | null {
		return this.value === null ? null : structuredClone(this.value);
	}

	invalidate(): void {
		this.run += 1;
		const changed = this.value !== null;
		this.value = null;
		if (changed) this.onChange();
	}

	async refresh(load: () => Promise<PreparedSessionNote | null>): Promise<void> {
		const run = ++this.run;
		const note = await load();
		if (run !== this.run) return;
		this.value = note === null ? null : buildLootPresentation(note);
		this.onChange();
	}
}
