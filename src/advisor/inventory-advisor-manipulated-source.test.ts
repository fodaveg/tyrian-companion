import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import { createInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import type { ReservationGoal } from '../economy/reservation-model';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './inventory-advisor-contract';
import { applyInventoryDiscardAllowlist, isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';
import type { InventoryDiscardAllowlistResultV1 } from './inventory-advisor-discard-model';
import type { InventoryAdvisorReportV1, InventoryAdvisorResultV1 } from './inventory-advisor-model';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';
import { isInventoryAdvisorResult, isInventoryAdvisorResultForInput } from './inventory-advisor-result';

/**
 * The trust boundary of the public route: whatever a caller hands to the discard allowlist or to
 * the presentation is reproduced from the input it comes with, so a result that is coherent in
 * itself (its own hashes, envelope and proof recomputed) but was not produced from that input is
 * refused. Every forgery below is first shown to be well formed and to present on its own input,
 * so what refuses it is the reproduction and not its shape.
 */
describe('inventory advisor public route refuses a manipulated source', () => {
	it.each([
		['other goals', (value: InventoryAdvisorEngineInputV1) => { value.input.goals = [reserve('goal-b', 'Objetivo B', 2)]; }],
		['no goals', (value: InventoryAdvisorEngineInputV1) => { value.input.goals = []; }],
		['no keep exceptions', (value: InventoryAdvisorEngineInputV1) => { value.input.keepExceptions = []; }],
		['another rule pack', (value: InventoryAdvisorEngineInputV1) => {
			value.input.rulePack.version = 2;
			value.input.rulePack.sha256 = sha256InventoryRulePack(value.input.rulePack);
		}],
		['another account', (value: InventoryAdvisorEngineInputV1) => {
			value.input.snapshot.accountId = 'account-2';
			value.input.prices.accountId = 'account-2';
			value.input.accountSignals.accountId = 'account-2';
		}],
		['another snapshot', (value: InventoryAdvisorEngineInputV1) => {
			value.input.snapshot.snapshotId = 'snapshot-2';
			value.input.catalog.snapshotId = 'snapshot-2';
			value.input.prices.snapshotId = 'snapshot-2';
		}],
		['other positions', (value: InventoryAdvisorEngineInputV1) => {
			// The same owned total of item 10, one unit moved from the bank to the character bag.
			value.input.snapshot.holdings[0]!.quantity = 6;
			value.input.snapshot.holdings[2]!.quantity = 6;
		}],
		['another bid', (value: InventoryAdvisorEngineInputV1) => {
			value.input.prices.items[0]!.bid = { unitCopper: 20, quantity: 40 };
		}],
	] as const)('refuses an analysis of %s presented against this input', (_name, change) => {
		const engineInput = multiLocationFixture();
		const other = multiLocationFixture();
		change(other);
		const produced = analyse(other);
		// The forgery is a real analysis: it presents on the input it was produced from.
		expect(produced.presentation.status).toBe('ready');
		expect(sha256CanonicalValue(produced.producerResult)).not.toBe(sha256CanonicalValue(analyse(engineInput).producerResult));

		expectRefused(engineInput, produced.producerResult, produced.result);
		// A producer-only source has no context to reproduce; the result contract alone refuses these.
		expect(buildInventoryAdvisorPresentation({ input: engineInput.input, result: produced.producerResult }).status)
			.toBe('invalid');
	});

	it.each([
		['a renamed line', renameLine],
		['every market route turned into keep', marketRoutesInto('keep')],
		['every market route turned into review', marketRoutesInto('review')],
	] as const)('refuses a result edited by hand (%s) whose envelope, report hash and producer hash were recomputed', (_name, edit) => {
		const engineInput = multiLocationFixture();
		const honest = analyse(engineInput);
		const forged = forge(honest, edit);
		// Coherent in itself: the shape contract accepts both halves and their hashes agree.
		expect(isInventoryAdvisorResult(forged.producerResult)).toBe(true);
		expect(forged.result.producerResultSha256).toBe(sha256CanonicalValue(forged.producerResult));
		expect(forged.result.envelope?.reportSha256).not.toBe(honest.result.envelope?.reportSha256);

		expectRefused(engineInput, forged.producerResult, forged.result);
	});

	it('refuses a manipulated discard result next to the honest producer result, and the reverse', () => {
		const engineInput = multiLocationFixture();
		const honest = analyse(engineInput);
		const forged = forge(honest, renameLine);
		const discardContext = { engineInput, producerResult: honest.producerResult };
		expect(isInventoryDiscardAllowlistResultForInput(forged.result, discardContext)).toBe(false);
		expect(buildInventoryAdvisorPresentation({ input: engineInput.input, result: forged.result, discardContext }).status)
			.toBe('invalid');
		// The honest discard result carries the hash of the honest producer, not of the forged one.
		const forgedContext = { engineInput, producerResult: forged.producerResult };
		expect(isInventoryDiscardAllowlistResultForInput(honest.result, forgedContext)).toBe(false);
		expect(buildInventoryAdvisorPresentation({
			input: engineInput.input, result: honest.result, discardContext: forgedContext,
		}).status).toBe('invalid');
	});

	it('refuses a context whose engine input is not the very input of the source, however equal', () => {
		const engineInput = multiLocationFixture();
		const honest = analyse(engineInput);
		const copy = structuredClone(engineInput);
		expect(buildInventoryAdvisorPresentation({
			input: engineInput.input, result: honest.result,
			discardContext: { engineInput: copy, producerResult: honest.producerResult },
		})).toMatchObject({ status: 'invalid', invalidCause: 'presentation_context_identity' });
	});

	it('refuses a context whose market depth is not the one the producer classified with', () => {
		const engineInput = multiLocationFixture();
		const honest = analyse(engineInput);
		const itemIds = engineInput.input.prices.requestedItemIds;
		const depth = (
			status: 'complete' | 'unavailable',
			item: (itemId: number) => NonNullable<InventoryAdvisorEngineInputV1['marketDepth']>['items'][number],
		): InventoryAdvisorEngineInputV1 => ({ ...engineInput, marketDepth: {
			version: 1, capturedAt: engineInput.input.asOf, source: 'gw2-commerce-listings',
			requestedItemIds: [...itemIds], status, items: itemIds.map(item),
		} });
		for (const tampered of [
			depth('unavailable', (itemId) => ({ itemId, coverage: 'missing', buys: [], sells: [] })),
			// A book deep enough to sell at once what the producer, with a bid two deep, had to list.
			depth('complete', (itemId) => ({ itemId, coverage: 'complete',
				buys: [{ unitCopper: 20, quantity: 500 }], sells: [{ unitCopper: 21, quantity: 500 }] })),
		]) {
			// The context does change what the classifier produces from the same input.
			expect(sha256CanonicalValue(classifyInventoryAdvisor(tampered))).not.toBe(sha256CanonicalValue(honest.producerResult));
			expectRefused(tampered, honest.producerResult, honest.result);
		}
	});
});

/**
 * Known behaviour, fixed here so that a change to it is a decision and not an accident. The result
 * contract (`isInventoryAdvisorResultForInput`) reproduces the routes that act on an object and
 * the quantities a line protects, but takes `keep` and `review` as given and never looks at the
 * name of a line. Alone, with no context to reproduce the classifier from, it is all that stands
 * behind a producer-only presentation source `{ input, result }`. The workflow never builds one:
 * its sources carry the context, and the tests above show the same edits refused there.
 */
describe('inventory advisor result contract: what keep and review let a hand-edited result do', () => {
	it.each([
		['a renamed line', renameLine, ['Another name']],
		['every market route turned into keep', marketRoutesInto('keep'), ['keep', 'review']],
		['every market route turned into review', marketRoutesInto('review'), ['keep', 'review']],
	] as const)('accepts %s, and a producer-only source presents it', (_name, edit, expected) => {
		const engineInput = multiLocationFixture();
		const honest = analyse(engineInput);
		const forged = forge(honest, edit).producerResult;
		expect(sha256CanonicalValue(forged)).not.toBe(sha256CanonicalValue(honest.producerResult));
		expect(isInventoryAdvisorResultForInput(forged, engineInput.input, engineInput.knowledgePack)).toBe(true);
		const presentation = buildInventoryAdvisorPresentation({ input: engineInput.input, result: forged });
		expect(presentation.status).toBe('ready');
		const rows = presentation.groups.flatMap((group) => group.rows).filter((row) => row.itemId === 10);
		expect([...new Set(rows.map((row) => expected[0] === 'Another name' ? row.name : row.action))].sort()).toEqual(expected);
		// Nothing left to act on: the object is only ever withheld, never routed somewhere it was not.
		if (expected[0] !== 'Another name') {
			expect(rows.some((row) => row.value.status === 'available')).toBe(false);
		}
	});

	// What it does not let through. Each edit is the most coherent one available (quantities moved
	// with the decision, order and reasons rebuilt), and `shape` says whether the forgery got as far as
	// the reproduction against the input or was already refused as a malformed report.
	it.each([
		['a reserved keep turned into a sale', 'well_formed', (report: InventoryAdvisorReportV1) => {
			retarget(report, (decision, reasons) => decision.action === 'keep' && reasons.includes('reserved_for_goal'), 'sell');
		}],
		['a keep exception turned into a listing', 'well_formed', (report: InventoryAdvisorReportV1) => {
			retarget(report, (decision, reasons) => decision.action === 'keep' && reasons.includes('user_keep_exception'), 'list');
		}],
		['a review of a pending claim turned into a sale', 'malformed', (report: InventoryAdvisorReportV1) => {
			retarget(report, (decision) => decision.action === 'review', 'sell');
		}],
		['a listing turned into a sale the bid does not cover', 'well_formed', (report: InventoryAdvisorReportV1) => {
			retarget(report, (decision) => decision.action === 'list', 'sell');
		}],
		['less reserved than the plan protects', 'well_formed', (report: InventoryAdvisorReportV1) => {
			const line = report.lines.find((entry) => entry.itemId === 10)!;
			line.reservedQuantity -= 1;
			line.retainedQuantity += 1;
		}],
		['a keep of more units than the position holds', 'malformed', (report: InventoryAdvisorReportV1) => {
			const line = report.lines.find((entry) => entry.itemId === 10)!;
			const decision = line.decisions.find((entry) => entry.action === 'keep')!;
			decision.quantity += 1;
			decision.allocations[0]!.quantity += 1;
			line.retainedQuantity += 1;
		}],
	] as const)('refuses %s (%s), also from a producer-only source', (_name, shape, edit) => {
		const engineInput = multiLocationFixture();
		const honest = analyse(engineInput);
		const report = structuredClone(honest.producerResult.report!);
		edit(report);
		const envelope = createInventoryRecommendationEnvelope(report);
		const forged = { status: honest.producerResult.status, report, envelope };
		expect(isInventoryAdvisorResult(forged) ? 'well_formed' : 'malformed').toBe(shape);
		expect(isInventoryAdvisorResultForInput(forged, engineInput.input, engineInput.knowledgePack)).toBe(false);
		expect(buildInventoryAdvisorPresentation({ input: engineInput.input, result: forged as InventoryAdvisorResultV1 }).status)
			.toBe('invalid');
	});
});

function renameLine(report: InventoryAdvisorReportV1): void {
	report.lines.find((line) => line.itemId === 10)!.name = 'Another name';
}

/** Turns every sale and listing of item 10 into `action`, with the quantities of the line moved to match. */
function marketRoutesInto(action: 'keep' | 'review'): (report: InventoryAdvisorReportV1) => void {
	return (report) => {
		const line = report.lines.find((entry) => entry.itemId === 10)!;
		for (const decision of line.decisions) {
			if (decision.action !== 'sell' && decision.action !== 'list') continue;
			decision.action = action;
			report.explanations.find((entry) => entry.ref === decision.explanationRef)!.action = action;
			line.actionedQuantity -= decision.quantity;
			if (action === 'keep') line.retainedQuantity += decision.quantity;
			else line.unclassifiedQuantity += decision.quantity;
		}
		restoreReportOrder(report);
	};
}

/** Turns the decisions of item 10 that `match` into `action`, moving the quantities of the line with them. */
function retarget(
	report: InventoryAdvisorReportV1,
	match: (decision: InventoryAdvisorReportV1['lines'][number]['decisions'][number], reasons: readonly string[]) => boolean,
	action: 'sell' | 'list',
): void {
	const line = report.lines.find((entry) => entry.itemId === 10)!;
	for (const decision of line.decisions) {
		const explanation = report.explanations.find((entry) => entry.ref === decision.explanationRef)!;
		if (!match(decision, explanation.reasonCodes)) continue;
		if (decision.action === 'review') line.unclassifiedQuantity -= decision.quantity;
		else if (explanation.reasonCodes.includes('reserved_for_goal')) line.reservedQuantity -= decision.quantity;
		else if (explanation.reasonCodes.includes('user_keep_exception')) line.exceptionQuantity -= decision.quantity;
		else if (decision.action === 'keep') line.retainedQuantity -= decision.quantity;
		if (decision.action !== 'list' && decision.action !== 'sell') line.actionedQuantity += decision.quantity;
		decision.action = action;
		explanation.action = action;
		explanation.reasonCodes = ['alternative_route_exists'];
	}
	restoreReportOrder(report);
}

/** What a careful forger rebuilds after an edit: the order of the decisions and the reasons each line and the report list. */
function restoreReportOrder(report: InventoryAdvisorReportV1): void {
	for (const line of report.lines) {
		line.decisions.sort((left, right) => left.action.localeCompare(right.action)
			|| left.explanationRef.localeCompare(right.explanationRef));
		const codes = new Set(line.decisions.flatMap((decision) => report.explanations
			.find((entry) => entry.ref === decision.explanationRef)!.reasonCodes));
		line.reasons = [...codes].sort((left, right) => left.localeCompare(right))
			.map((code) => ({ code, itemId: line.itemId, goalId: null, ruleId: null }));
	}
	report.reasons = report.lines.flatMap((line) => line.reasons);
}

interface Analysis {
	producerResult: InventoryAdvisorResultV1;
	result: InventoryDiscardAllowlistResultV1;
	presentation: ReturnType<typeof buildInventoryAdvisorPresentation>;
}

function analyse(engineInput: InventoryAdvisorEngineInputV1): Analysis {
	const producerResult = classifyInventoryAdvisor(engineInput);
	const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
	const presentation = buildInventoryAdvisorPresentation({
		input: engineInput.input, result, discardContext: { engineInput, producerResult },
	});
	return { producerResult, result, presentation };
}

/** Every public door of the route, against `engineInput`, for a producer and discard result it did not produce. */
function expectRefused(
	engineInput: InventoryAdvisorEngineInputV1,
	producerResult: InventoryAdvisorResultV1,
	result: InventoryDiscardAllowlistResultV1,
): void {
	const discardContext = { engineInput, producerResult };
	expect(applyInventoryDiscardAllowlist(discardContext).status).toBe('invalid');
	expect(isInventoryDiscardAllowlistResultForInput(result, discardContext)).toBe(false);
	expect(buildInventoryAdvisorPresentation({ input: engineInput.input, result, discardContext }).status).toBe('invalid');
}

/** The same edit on the producer report and on the discard report, with every dependent hash recomputed. */
function forge(honest: Analysis, edit: (report: InventoryAdvisorReportV1) => void): Pick<Analysis, 'producerResult' | 'result'> {
	if (honest.producerResult.status === 'invalid' || honest.result.report === null) throw new Error('Expected a valid analysis.');
	const producerReport = structuredClone(honest.producerResult.report);
	edit(producerReport);
	const producerEnvelope = createInventoryRecommendationEnvelope(producerReport);
	const report = structuredClone(honest.result.report);
	edit(report);
	const envelope = createInventoryRecommendationEnvelope(report);
	if (producerEnvelope === null || envelope === null) throw new Error('Expected the edited report to keep its shape.');
	const producerResult: InventoryAdvisorResultV1 = {
		status: honest.producerResult.status, report: producerReport, envelope: producerEnvelope,
	};
	return {
		producerResult,
		result: { ...structuredClone(honest.result), producerResultSha256: sha256CanonicalValue(producerResult), report, envelope },
	};
}

/** Item 10 in a character bag, the bank, material storage, the shared slots and the delivery box. */
function multiLocationFixture(): InventoryAdvisorEngineInputV1 {
	const value = accountFixture([
		{ itemId: 10, quantity: 5, location: { source: 'character', character: 'Hero', container: 'bag', bagIndex: 0, slot: 0 } },
		{ itemId: 11, quantity: 4, location: { source: 'bank', slot: 0 } },
		{ itemId: 10, quantity: 7, location: { source: 'bank', slot: 1 } },
		{ itemId: 12, quantity: 1, location: { source: 'bank', slot: 2 } },
		{ itemId: 10, quantity: 20, location: { source: 'materials', category: 7 } },
		{ itemId: 10, quantity: 3, location: { source: 'shared_inventory', slot: 0 } },
		{ itemId: 10, quantity: 2, state: 'pending_claim', location: { source: 'commerce_delivery', slot: 0 } },
	]);
	// A bid two deep: the free quantity splits into an instant sale and two listings.
	value.input.prices.items[0]!.bid = { unitCopper: 20, quantity: 2 };
	value.input.goals = [reserve('goal-a', 'Objetivo A', 6)];
	value.input.keepExceptions = [
		{ version: 1, exceptionId: 'exception-a', itemId: 10, status: 'active', basis: 'owned',
			quantity: { mode: 'minimum', value: 9 }, reason: 'build' },
		{ version: 1, exceptionId: 'exception-b', itemId: 11, status: 'active', basis: 'available',
			quantity: { mode: 'all' }, reason: 'gift' },
	];
	return value;
}

function reserve(goalId: string, title: string, targetQuantity: number): ReservationGoal {
	return {
		schemaVersion: 1, goalId, title, status: 'active', priority: 100, reason: 'purchase',
		requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity, creditedQuantity: 0,
			basis: 'available', intendedUse: 'consume' }],
	};
}

interface FixtureStack {
	itemId: number;
	quantity: number;
	state?: StorageSnapshot['holdings'][number]['state'];
	location: StorageSnapshot['holdings'][number]['location'];
}

/** A stable two-pass account holding exactly `stacks`, every item priced and resolved. */
function accountFixture(stacks: FixtureStack[]): InventoryAdvisorEngineInputV1 {
	const holdings: StorageSnapshot['holdings'] = stacks.map((stack) => ({
		kind: 'item', itemId: stack.itemId, quantity: stack.quantity, state: stack.state ?? 'loose',
		location: stack.location, metadata: {},
	}));
	const itemIds = [...new Set(stacks.map((stack) => stack.itemId))].sort((left, right) => left - right);
	const quantities = Object.fromEntries(itemIds.map((itemId) => [String(itemId), stacks
		.filter((stack) => stack.itemId === itemId).reduce((total, stack) => total + stack.quantity, 0)]));
	const roster = [...new Set(stacks.flatMap((stack) => stack.location.source === 'character'
		? [stack.location.character] : []))];
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings, currencies: [], availableByItem: { ...quantities }, ownedByItem: { ...quantities }, currencyById: {},
		roster, coverage: coverage(roster), passCoverages: [coverage(roster), coverage(roster)],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [],
	};
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return {
		input: {
			version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot,
			catalog: {
				snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z',
				items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), {
					kind: 'item', id: itemId, name: `Item ${String(itemId)}`, type: 'Trophy', rarity: 'Basic', level: 0,
					vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
				}])),
				currencies: {}, materials: {}, warnings: [],
				coverage: {
					items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), { status: 'resolved', source: 'network' }])),
					currencies: {}, materials: {},
				},
			},
			prices: {
				version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
				source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: itemIds, status: 'complete',
				items: itemIds.map((itemId) => ({
					itemId, whitelisted: true, bid: { unitCopper: 20, quantity: 1 }, ask: { unitCopper: 21, quantity: 1 },
				})),
				missingItemIds: [],
			},
			goals: [], keepExceptions: [],
			accountSignals: {
				version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z',
				schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full',
				endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() },
				unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
				achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
			},
			rulePack,
			policy: {
				version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
				maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
				listingMinimumAdvantageBps: 1_000,
			},
		},
		knowledgePack: knowledge,
	};
}

function coverage(roster: string[]): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: Object.fromEntries(roster.map((character) => [character, { status: 'complete' as const }])) };
}
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
