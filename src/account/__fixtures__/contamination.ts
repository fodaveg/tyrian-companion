import { afterSnapshot, deliveryCurrency, deliveryHolding, storageDeltaSnapshot, walletCurrency } from './storage-delta';
import { buildBoundaryEvidence } from '../contamination';
import type { BoundaryEvidence, SessionClassificationContext } from '../contamination-model';
import { compareStorageSnapshots } from '../storage-delta';
import type { StorageDelta } from '../storage-delta-model';
import type { StorageSnapshot } from '../storage-snapshot-model';

export function cleanSnapshots(): { before: StorageSnapshot; after: StorageSnapshot } {
	return { before: storageDeltaSnapshot(), after: afterSnapshot() };
}

export function cleanDelta(): StorageDelta {
	const { before, after } = cleanSnapshots();
	return compareStorageSnapshots(before, after);
}

export function exactContext(
	overrides: Partial<SessionClassificationContext> = {},
): SessionClassificationContext {
	const { before, after } = cleanSnapshots();
	return {
		boundary: buildBoundaryEvidence(before, after),
		tradingPost: { status: 'complete', events: [] },
		declaration: { status: 'confirmed_clean' },
		boundaryCertainty: 'manual_confirmed',
		...overrides,
	};
}

export function boundaryFrom(
	beforeOverrides: Partial<StorageSnapshot>,
	afterOverrides: Partial<StorageSnapshot>,
): BoundaryEvidence {
	return buildBoundaryEvidence(
		storageDeltaSnapshot(beforeOverrides),
		afterSnapshot(afterOverrides),
	);
}

export const deliveryEvidenceFixtures = {
	items: boundaryFrom(
		{ holdings: [deliveryHolding(400, 2)] },
		{ holdings: [deliveryHolding(400, 3)] },
	),
	coins: boundaryFrom(
		{ currencies: [walletCurrency(1, 100), deliveryCurrency(1, 20)] },
		{ currencies: [walletCurrency(1, 100), deliveryCurrency(1, 10)] },
	),
	walletIncrease: boundaryFrom(
		{ currencies: [walletCurrency(1, 100)] },
		{ currencies: [walletCurrency(1, 120)] },
	),
	walletDecrease: boundaryFrom(
		{ currencies: [walletCurrency(1, 100)] },
		{ currencies: [walletCurrency(1, 80)] },
	),
};
