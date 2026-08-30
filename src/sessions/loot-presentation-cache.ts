import { buildLootPresentation, type LootPresentationV1 } from './loot-presentation';
import type { PreparedSessionNote } from './session-note-model';
import {
	LocalDebugPersistenceProbe,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';

/** Latest-wins cache for the asynchronous completed-runtime read used by the synchronous view. */
export class LootPresentationCache {
	private run = 0;
	private value: LootPresentationV1 | null = null;

	constructor(
		private readonly onChange: () => void = () => undefined,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {}

	get(context?: LocalDebugPersistenceContext): LootPresentationV1 | null {
		const attempt = this.diagnostics.begin('loot_presentation', 'read', context);
		if (this.value === null) attempt.skip();
		else attempt.success();
		return this.value === null ? null : structuredClone(this.value);
	}

	invalidate(context?: LocalDebugPersistenceContext): void {
		const attempt = this.diagnostics.begin('loot_presentation', 'delete', context);
		this.run += 1;
		const changed = this.value !== null;
		this.value = null;
		if (changed) this.onChange();
		if (changed) attempt.success(); else attempt.skip();
	}

	async refresh(
		load: () => Promise<PreparedSessionNote | null>,
		context?: LocalDebugPersistenceContext,
	): Promise<void> {
		const attempt = this.diagnostics.begin('loot_presentation', 'write', context);
		const run = ++this.run;
		try {
			const note = await load();
			if (run !== this.run) { attempt.skip(); return; }
			this.value = note === null ? null : buildLootPresentation(note);
			this.onChange();
			attempt.success();
		} catch (error) {
			attempt.failure();
			throw error;
		}
	}
}
