import {
	PINNED_SCHEMA,
	type CurrencyTotal,
	type SnapshotCoverage,
	type SnapshotQuality,
	type StorageSnapshot,
	type StorageSnapshotPass,
} from './storage-snapshot-model';

export interface QualifiedStorageSnapshotPasses {
	pass: StorageSnapshotPass;
	quality: SnapshotQuality;
	coveragePasses: StorageSnapshotPass[];
	passes:
		| [StorageSnapshotPass]
		| [StorageSnapshotPass, StorageSnapshotPass]
		| [StorageSnapshotPass, StorageSnapshotPass, StorageSnapshotPass];
}

export type StorageSnapshotPairQualification =
	| { status: 'qualified'; value: QualifiedStorageSnapshotPasses }
	| { status: 'needs_third_pass' };

export interface StorageSnapshotIdentity {
	accountId: string;
	snapshotId: string;
	startedAt: string;
	completedAt: string;
}

/** Builds the normalized pass consumed by the production stability qualifier. */
export function buildStorageSnapshotPass(
	holdings: StorageSnapshotPass['holdings'],
	currencies: StorageSnapshotPass['currencies'],
	coverage: SnapshotCoverage,
	roster: string[],
): StorageSnapshotPass {
	const availableByItem: Record<string, number> = {};
	const ownedByItem: Record<string, number> = {};
	const currencyById: Record<string, CurrencyTotal> = {};
	for (const holding of holdings) {
		add(ownedByItem, holding.itemId, holding.quantity);
		if (holding.state === 'loose' || holding.state === 'pending_claim') {
			add(availableByItem, holding.itemId, holding.quantity);
		}
	}
	for (const currency of currencies) {
		const key = String(currency.currencyId);
		const total = (currencyById[key] ??= { total: 0, wallet: 0, delivery: 0 });
		total.total += currency.quantity;
		total[currency.namespace] += currency.quantity;
	}
	return {
		holdings,
		currencies,
		availableByItem,
		ownedByItem,
		currencyById,
		coverage,
		roster: [...roster].sort(),
	};
}

/** Applies the exact two-pass decision used by StorageSnapshotService. */
export function qualifyStorageSnapshotPair(
	first: StorageSnapshotPass,
	second: StorageSnapshotPass,
): StorageSnapshotPairQualification {
	if (isPartial(first.coverage) || isPartial(second.coverage) || !sameOwnership(first, second)) {
		return { status: 'needs_third_pass' };
	}
	return {
		status: 'qualified',
		value: {
			pass: second,
			quality: classifyConsecutive(first, second),
			coveragePasses: [first, second],
			passes: [first, second],
		},
	};
}

/** Applies the production fallback after the first two passes disagree. */
export function qualifyStorageSnapshotTriple(
	first: StorageSnapshotPass,
	second: StorageSnapshotPass,
	third: StorageSnapshotPass,
): QualifiedStorageSnapshotPasses {
	const recentPairComplete = !isPartial(second.coverage) && !isPartial(third.coverage);
	if (recentPairComplete) {
		return {
			pass: third,
			quality: sameOwnership(second, third)
				? classifyConsecutive(second, third)
				: 'unstable',
			coveragePasses: [second, third],
			passes: [first, second, third],
		};
	}
	const fallback = [third, second, first].find((entry) => !isPartial(entry.coverage));
	if (fallback) {
		return {
			pass: fallback,
			quality: 'unstable',
			coveragePasses: [fallback],
			passes: [first, second, third],
		};
	}
	return {
		pass: third,
		quality: 'partial',
		coveragePasses: [second, third],
		passes: [first, second, third],
	};
}

export function finalizeStorageSnapshot(
	qualified: QualifiedStorageSnapshotPasses,
	identity: StorageSnapshotIdentity,
): StorageSnapshot {
	return {
		...qualified.pass,
		coverage: mergeCoverages(qualified.coveragePasses.map((entry) => entry.coverage)),
		snapshotId: identity.snapshotId,
		accountId: identity.accountId,
		startedAt: identity.startedAt,
		completedAt: identity.completedAt,
		passCoverages: qualified.passes.map((entry) => entry.coverage),
		quality: qualified.quality,
		passes: qualified.passes.length,
		schemaVersion: PINNED_SCHEMA,
	};
}

export function canonicalSnapshotValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalSnapshotValue).sort().join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalSnapshotValue(child)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function add(target: Record<string, number>, key: string | number, quantity: number): void {
	const normalized = String(key);
	target[normalized] = (target[normalized] ?? 0) + quantity;
}

function sameOwnership(left: StorageSnapshotPass, right: StorageSnapshotPass): boolean {
	return (
		canonicalSnapshotValue(left.ownedByItem) === canonicalSnapshotValue(right.ownedByItem) &&
		canonicalSnapshotValue(currencyOwnership(left)) === canonicalSnapshotValue(currencyOwnership(right)) &&
		canonicalSnapshotValue(left.roster) === canonicalSnapshotValue(right.roster)
	);
}

function classifyConsecutive(
	left: StorageSnapshotPass,
	right: StorageSnapshotPass,
): SnapshotQuality {
	if (isPartial(left.coverage) || isPartial(right.coverage)) return 'partial';
	return placementFingerprint(left) === placementFingerprint(right)
		? 'stable'
		: 'stable_owned_placement_changed';
}

function placementFingerprint(pass: StorageSnapshotPass): string {
	return canonicalSnapshotValue({
		holdings: pass.holdings,
		currencies: pass.currencies,
		roster: pass.roster,
	});
}

function isPartial(coverage: SnapshotCoverage): boolean {
	// A character that answers 404 is a hole no extra pass can fill, and the coverage keeps
	// the evidence for the delta. Retrying only for it would burn passes and leave the
	// capture unusable as a session boundary, so it does not disqualify the pass.
	return [...Object.values(coverage.sources), ...Object.values(coverage.characters)].some(
		(entry) => entry.status === 'partial' && entry.reason !== 'missing_character',
	);
}

function currencyOwnership(pass: StorageSnapshotPass): Record<string, number> {
	return Object.fromEntries(
		Object.entries(pass.currencyById).map(([currencyId, value]) => [currencyId, value.total]),
	);
}

function mergeCoverages(coverages: SnapshotCoverage[]): SnapshotCoverage {
	const merged: SnapshotCoverage = { sources: { ...coverages[0]!.sources }, characters: {} };
	for (const coverage of coverages) {
		for (const [source, entry] of Object.entries(coverage.sources)) {
			if (entry.status === 'partial') {
				merged.sources[source as keyof SnapshotCoverage['sources']] = { ...entry };
			}
		}
		for (const [character, entry] of Object.entries(coverage.characters)) {
			const current = merged.characters[character];
			if (!current || entry.status === 'partial') merged.characters[character] = { ...entry };
		}
	}
	return merged;
}
