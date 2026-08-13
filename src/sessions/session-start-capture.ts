import { HttpTransportError } from '../core/http';
import type { GuildWars2Client, GuildWars2Operation } from '../account/guild-wars-2-client';
import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';

export const MAX_MAGIC_FIND = 100_000;

export interface SessionStartInput {
	characterName: string;
	magicFind: number;
}

export interface BuildSkillSet {
	heal: number | null;
	utilities: Array<number | null>;
	elite: number | null;
}

export interface BuildSpecialization {
	id: number | null;
	traits: Array<number | null>;
}

export interface ActiveBuildReference {
	tab: number;
	name: string;
	profession: string;
	specializations: BuildSpecialization[];
	skills: BuildSkillSet;
	aquaticSkills: BuildSkillSet;
}

export interface SessionStartContext {
	characterName: string;
	magicFind: {
		value: number;
		source: 'manual';
	};
	build: ActiveBuildReference;
	capturedAt: string;
}

export type SessionStartCaptureErrorCode =
	| 'invalid_input'
	| 'character_not_found'
	| 'snapshot_not_stable'
	| 'build_scope_missing'
	| 'build_unavailable'
	| 'invalid_build';

export class SessionStartCaptureError extends Error {
	constructor(
		readonly code: SessionStartCaptureErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'SessionStartCaptureError';
	}
}

export interface SessionStartCaptureResult {
	snapshot: StorageSnapshot;
	context: SessionStartContext;
}

export function normalizeSessionStartInput(value: SessionStartInput): SessionStartInput {
	const characterName = value.characterName.trim();
	if (!characterName || characterName.length > 64) {
		throw new SessionStartCaptureError('invalid_input', 'Choose a valid character name.');
	}
	if (!Number.isSafeInteger(value.magicFind) || value.magicFind < 0 || value.magicFind > MAX_MAGIC_FIND) {
		throw new SessionStartCaptureError(
			'invalid_input',
			`Magic Find must be a whole number between 0 and ${MAX_MAGIC_FIND}.`,
		);
	}
	return { characterName, magicFind: value.magicFind };
}

/** Captures a stable baseline and the selected character's active build with one pinned key. */
export class SessionStartCaptureService {
	constructor(
		private readonly client: Pick<GuildWars2Client, 'beginOperation'>,
		private readonly snapshots: Pick<StorageSnapshotService, 'captureWithOperation'>,
		private readonly now: () => Date = () => new Date(),
	) {}

	async capture(inputValue: SessionStartInput): Promise<SessionStartCaptureResult> {
		const input = normalizeSessionStartInput(inputValue);
		const operation = this.client.beginOperation();
		const snapshot = await this.snapshots.captureWithOperation(operation);
		if (snapshot.quality !== 'stable' && snapshot.quality !== 'stable_owned_placement_changed') {
			throw new SessionStartCaptureError(
				'snapshot_not_stable',
				'The account changed while the baseline was being captured. Try again when it is idle.',
			);
		}
		if (!snapshot.roster.includes(input.characterName)) {
			throw new SessionStartCaptureError(
				'character_not_found',
				'The selected character is not present on this account.',
			);
		}
		if (snapshot.coverage.characters[input.characterName]?.status !== 'complete') {
			throw new SessionStartCaptureError(
				'snapshot_not_stable',
				'The selected character was not captured completely.',
			);
		}

		const build = await captureActiveBuild(operation, input.characterName);
		const capturedAt = this.now().toISOString();
		if (Date.parse(capturedAt) < Date.parse(snapshot.completedAt)) {
			throw new SessionStartCaptureError('invalid_build', 'The local clock moved backwards.');
		}
		return {
			snapshot,
			context: {
				characterName: input.characterName,
				magicFind: { value: input.magicFind, source: 'manual' },
				build,
				capturedAt,
			},
		};
	}
}

async function captureActiveBuild(
	operation: Pick<GuildWars2Operation, 'requestDetailed'>,
	characterName: string,
): Promise<ActiveBuildReference> {
	try {
		const response = await operation.requestDetailed(
			`characters/${encodeURIComponent(characterName)}/buildtabs/active?v=${encodeURIComponent(PINNED_SCHEMA)}`,
		);
		return parseActiveBuild(response.body);
	} catch (error) {
		if (error instanceof SessionStartCaptureError) throw error;
		if (error instanceof HttpTransportError && error.status === 403) {
			throw new SessionStartCaptureError(
				'build_scope_missing',
				'The selected API key needs the builds permission for session tracking.',
			);
		}
		if (error instanceof HttpTransportError) {
			throw new SessionStartCaptureError(
				'build_unavailable',
				'The active build could not be read from Guild Wars 2.',
			);
		}
		throw error;
	}
}

export function parseActiveBuild(value: unknown): ActiveBuildReference {
	if (!isRecord(value)
		|| !positiveInteger(value.tab)
		|| value.is_active !== true
		|| !isRecord(value.build)
		|| typeof value.build.name !== 'string'
		|| typeof value.build.profession !== 'string'
		|| value.build.profession.length === 0
		|| !Array.isArray(value.build.specializations)
		|| value.build.specializations.length !== 3) {
		throw new SessionStartCaptureError('invalid_build', 'The active build response was invalid.');
	}

	return {
		tab: value.tab,
		name: value.build.name,
		profession: value.build.profession,
		specializations: value.build.specializations.map(parseSpecialization),
		skills: parseSkillSet(value.build.skills),
		aquaticSkills: parseSkillSet(value.build.aquatic_skills),
	};
}

function parseSpecialization(value: unknown): BuildSpecialization {
	if (!isRecord(value)
		|| !nullablePositiveInteger(value.id)
		|| !Array.isArray(value.traits)
		|| value.traits.some((trait) => !nullablePositiveInteger(trait))) {
		throw new SessionStartCaptureError('invalid_build', 'The active build response was invalid.');
	}
	const traits = value.traits as Array<number | null>;
	return { id: value.id, traits: [...traits] };
}

function parseSkillSet(value: unknown): BuildSkillSet {
	if (!isRecord(value)
		|| !nullablePositiveInteger(value.heal)
		|| !Array.isArray(value.utilities)
		|| value.utilities.length !== 3
		|| value.utilities.some((skill) => !nullablePositiveInteger(skill))
		|| !nullablePositiveInteger(value.elite)) {
		throw new SessionStartCaptureError('invalid_build', 'The active build response was invalid.');
	}
	const utilities = value.utilities as Array<number | null>;
	return {
		heal: value.heal,
		utilities: [...utilities],
		elite: value.elite,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nullablePositiveInteger(value: unknown): value is number | null {
	return value === null || positiveInteger(value);
}
