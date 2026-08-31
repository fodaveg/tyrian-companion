import { buildLootPresentation, type LootPresentationV1 } from './loot-presentation';
import type { PreparedSessionNote } from './session-note-model';
import {
	LocalDebugPersistenceProbe,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';
import type { LocalDebugCode } from '../core/local-debug-contract';

export type LootPresentationRefreshStage = 'source_read' | 'projection' | 'publish';

export type LootPresentationRefreshResult =
	| { status: 'updated' | 'superseded' }
	| {
		status: 'failed';
		stage: LootPresentationRefreshStage;
		code: Extract<LocalDebugCode, 'storage_failure' | 'precondition_failed' | 'internal_failure'>;
		cause: unknown;
	};

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
		attempt.success();
		return this.value === null ? null : structuredClone(this.value);
	}

	invalidate(context?: LocalDebugPersistenceContext): void {
		const attempt = this.diagnostics.begin('loot_presentation', 'delete', context);
		this.run += 1;
		const changed = this.value !== null;
		this.value = null;
		if (changed) this.onChange();
		attempt.success();
	}

	async refresh<Source>(
		load: () => Promise<Source | null>,
		project: (source: Source) => PreparedSessionNote | null,
		context?: LocalDebugPersistenceContext,
	): Promise<LootPresentationRefreshResult> {
		const run = ++this.run;
		let stage: LootPresentationRefreshStage = 'source_read';
		let next: LootPresentationV1 | null;
		try {
			const source = await load();
			stage = 'projection';
			const note = source === null ? null : project(source);
			next = note === null ? null : buildLootPresentation(note);
		} catch (cause) {
			if (run !== this.run) return { status: 'superseded' };
			return { status: 'failed', stage, code: refreshFailureCode(stage, cause), cause };
		}
		if (run !== this.run) return { status: 'superseded' };
		const attempt = this.diagnostics.begin('loot_presentation', 'write', context);
		this.value = next;
		attempt.success();
		stage = 'publish';
		try {
			this.onChange();
		} catch (cause) {
			return { status: 'failed', stage, code: 'internal_failure', cause };
		}
		return { status: 'updated' };
	}
}

/** Classifies only failures from the callback stage; cache persistence has its own probe. */
function refreshFailureCode(
	stage: Exclude<LootPresentationRefreshStage, 'publish'>,
	cause: unknown,
): Extract<LocalDebugCode, 'storage_failure' | 'precondition_failed' | 'internal_failure'> {
	if (stage === 'source_read') return 'storage_failure';
	return cause instanceof TypeError ? 'precondition_failed' : 'internal_failure';
}
