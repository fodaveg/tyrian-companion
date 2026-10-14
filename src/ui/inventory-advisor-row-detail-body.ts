import type { Locale, Translator } from '../core/i18n';
import type { InventoryContainerEconomyDecisionV1 } from '../advisor/inventory-container-economy';
import {
	POSITION_RECOMMENDATION_REASON_CODES,
	type PositionRecommendationReasonCode,
} from '../advisor/inventory-position-recommendation';
import {
	evidenceGroup,
	type InventoryAdvisorValueConcentration,
	type InventoryAdvisorViewAction,
	type InventoryAdvisorViewCoverage,
	type InventoryAdvisorViewRow,
} from './inventory-advisor-view-model';

/**
 * The body of a row's «Detalles»: the facts list («Por qué», owned, unit value, location,
 * evidence), the price chart under it and the sub-details (context, advanced evidence, season,
 * container economy and tail, salvage). Lifted out of `inventory-advisor-view.ts` on 14 oct 2026
 * so Venta paints the SAME body for the same object (David: «en venta, quiero que los elementos
 * tengan el mismo detalle que en inventario»); every function below is the advisor's own, moved,
 * with its output unchanged.
 */

/** What a row's body shows besides the row itself. */
export interface RowDetailBodyOptions {
	/** The row's share of the value of the rows visible now; null paints no value line (Venta has no such list). */
	readonly concentration: InventoryAdvisorValueConcentration | null;
	/** With little free space the row says what it frees (H18.15). */
	readonly showSlotsFreed: boolean;
	/**
	 * «Ver en Venta» on a container row (H18.31, lámina 3.1, decision E). `'offer'` paints the button
	 * (its click calls `onOpenSale`, when given); `'omit'` paints none: Venta is where it would lead.
	 */
	readonly viewInSale: 'offer' | 'omit';
	readonly onOpenSale?: () => void;
	readonly bagCharacter: string | null;
	/** The row's price-history block, already built; null paints no chart. */
	readonly priceHistory: HTMLElement | null;
}

/** What a row's detail shows once open, in order. */
export function rowDetailBody(row: InventoryAdvisorViewRow, translator: Translator, options: RowDetailBodyOptions): HTMLElement[] {
	const body: HTMLElement[] = [];
	if (options.viewInSale === 'offer' && row.containerEconomy !== undefined) {
		const viewInSale = createEl('button');
		viewInSale.className = 'mod-link';
		viewInSale.type = 'button';
		viewInSale.textContent = translator.t('advisor.view.list.viewInSale');
		viewInSale.addEventListener('click', () => options.onOpenSale?.());
		body.push(viewInSale);
	}
	const list = createEl('dl');
	const explanationAndMoment = [explanationLabel(row, translator), decisionMomentLabel(row, translator), sellOrWaitLabel(row, translator)]
		.filter((part): part is string => part !== null && part.length > 0).join(' · ');
	if (explanationAndMoment.length > 0) addDefinition(list, translator.t('advisor.view.list.headExplanation'), explanationAndMoment);
	addDefinition(list, translator.t('advisor.view.owned'), ownershipLabel(row, translator));
	addDefinition(list, translator.t('advisor.view.unitValue'), unitValueLabel(row, translator));
	// The row's own money cell already shows `valueLabel`; only the concentration this row adds
	// on top of it (never a second copy of the value itself) belongs in the detail disclosure.
	const concentration = options.concentration;
	if (concentration !== null) addDefinition(list, translator.t('sale.row.head.value'), translator.t('advisor.view.valueConcentration', {
		share: formatBasisPoints(concentration.shareBasisPoints, translator),
		cumulative: formatBasisPoints(concentration.cumulativeBasisPoints, translator),
	}));
	addDefinition(list, translator.t('advisor.view.location'), allocationLabel(row, translator));
	addDefinition(list, translator.t('advisor.view.evidence'), evidenceLabel(row.coverage, translator));
	body.push(list);
	// The price chart of this item, right under the facts it helps to weigh.
	if (options.priceHistory !== null) body.push(options.priceHistory);
	const context = rowContextDetails(row, translator, options.showSlotsFreed, options.bagCharacter);
	if (context !== null) body.push(context);
	const advanced = advancedEvidenceDetails(row.coverage, translator);
	if (advanced !== null) body.push(advanced);
	const season = containerSeasonNotice(row, translator);
	if (season !== null) body.push(season);
	const economy = containerEconomyDetails(row, translator);
	if (economy !== null) body.push(economy);
	const tail = containerTailDetails(row, translator);
	if (tail !== null) body.push(tail);
	const salvage = equipmentSalvageDetails(row, translator);
	if (salvage !== null) body.push(salvage);
	return body;
}

function appendCell(row: HTMLTableRowElement, value: string, className = ''): void {
	const cell = createEl('td');
	cell.className = className;
	cell.textContent = value;
	row.append(cell);
}

function addDefinition(list: HTMLDListElement, term: string, value: string): void {
	const definitionTerm = createEl('dt');
	definitionTerm.textContent = term;
	const definitionValue = createEl('dd');
	definitionValue.textContent = value;
	list.append(definitionTerm, definitionValue);
}

export function actionLabelFor(action: InventoryAdvisorViewAction, translator: Translator): string {
	return translator.t(`advisor.view.action.${action}`);
}

/**
 * The economy layer's `hold` reads as `keep` on screen, the same mapping the
 * classifier applies. Two vocabularies for one outcome would put "hold" in the
 * detail panel and "keep" in the row above it for the same stack.
 */
function economyActionLabel(action: InventoryContainerEconomyDecisionV1['action']): InventoryAdvisorViewAction {
	return action === 'hold' ? 'keep' : action;
}

/**
 * The moment behind a row's decision, when the moment stage set it: why now or why wait, then its
 * three clocks, never mixed (H18.19): when the price was quoted, how long the analysis holds, and
 * the window it suggests selling in. Null for a route with no timing model, whose explanation
 * already says everything.
 */
function decisionMomentLabel(row: InventoryAdvisorViewRow, translator: Translator): string | null {
	const decision = row.decision ?? null;
	if (decision === null || !isPositionReasonCode(decision.reason)) return null;
	const parts = [translator.t(`inventory.decision.reason.${decision.reason}`)];
	if (decision.priceQuotedAt !== null) parts.push(translator.t('inventory.decision.clock.quotedAt', { date: decision.priceQuotedAt.slice(0, 10) }));
	if (decision.until !== null) parts.push(translator.t('advisor.view.decisionUntil', { date: decision.until.slice(0, 10) }));
	if (decision.sellWindowFromDay !== null && decision.sellWindowToDay !== null) {
		parts.push(translator.t('inventory.decision.clock.window', { from: decision.sellWindowFromDay, to: decision.sellWindowToDay }));
	}
	return parts.join(' · ');
}

/**
 * H18.19: sell now or wait, for the row's free quantity and in its own sale mode: the net advantage
 * of waiting, its range, the seasons behind it and the risk of not selling now. Null without one.
 */
function sellOrWaitLabel(row: InventoryAdvisorViewRow, translator: Translator): string | null {
	const comparison = row.decision?.sellOrWait ?? null;
	if (comparison === null) return null;
	const mode = translator.t(`inventory.sellOrWait.mode.${comparison.mode}`);
	if (comparison.verdict === 'insufficient_data') {
		return translator.t('inventory.sellOrWait.insufficient_data', { mode, seasons: comparison.seasons });
	}
	if (comparison.strategy === 'sell_now') {
		return translator.t('inventory.sellOrWait.no_wait_chosen', { mode, quantity: comparison.quantity });
	}
	const figures = {
		mode, quantity: comparison.quantity, seasons: comparison.seasons,
		advantage: comparisonCopper(comparison.netAdvantageCopper, translator),
		low: comparisonCopper(comparison.netAdvantageLowCopper, translator),
		high: comparisonCopper(comparison.netAdvantageHighCopper, translator),
	};
	const risk = translator.t('inventory.sellOrWait.risk', { lost: comparison.seasonsLost, seasons: comparison.seasons });
	return `${translator.t(`inventory.sellOrWait.${comparison.verdict}`, figures)} ${risk}`;
}

function comparisonCopper(copper: number | null, translator: Translator): string {
	return copper === null ? translator.t('advisor.view.value.unavailable') : signedCopper(copper, translator);
}

function isPositionReasonCode(value: string): value is PositionRecommendationReasonCode {
	return (POSITION_RECOMMENDATION_REASON_CODES as readonly string[]).includes(value);
}

export function allocationLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	return row.allocations.map((allocation) => {
		return `${formatInventoryAdvisorLocation(allocation.location, translator)} ×${String(allocation.quantity)}`;
	}).join(' · ');
}

export function formatInventoryAdvisorLocation(
	location: InventoryAdvisorViewRow['allocations'][number]['location'],
	translator: Translator,
): string {
	switch (location.source) {
		case 'character': {
			const character = `${translator.t('advisor.view.location.character')}: ${location.character}`;
			return location.container === 'equipped_bag'
				? `${character} · ${translator.t('advisor.view.location.equippedBag', { bag: location.bagIndex + 1 })}`
				: `${character} · ${translator.t('advisor.view.location.bagSlot', { bag: location.bagIndex + 1, slot: location.slot + 1 })}`;
		}
		case 'shared_inventory':
		case 'bank':
		case 'commerce_delivery':
			return `${translator.t(`advisor.view.location.${location.source}`)} · ${translator.t('advisor.view.location.slot', { slot: location.slot + 1 })}`;
		case 'materials':
			return `${translator.t('advisor.view.location.materials')} · ${translator.t('advisor.view.location.category', { category: location.category })}`;
		default:
			return assertNeverLocation(location);
	}
}

function assertNeverLocation(value: never): never {
	throw new Error(`Unsupported Inventory Advisor location: ${JSON.stringify(value)}`);
}

/** Derives the per-unit figure from the demonstrated net total; it never re-prices an item. */
function unitValueLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.value.status !== 'available') return priceOrFallback(null, row.value.status, translator);
	return priceOrFallback(row.quantity <= 0 ? null : Math.floor(row.value.copper / row.quantity), 'unavailable', translator);
}

/** Formats demonstrated copper, otherwise preserving the caller's exact fallback copy. */
export function priceOrFallback(
	copper: number | null,
	fallback: Exclude<InventoryAdvisorViewRow['value']['status'], 'available'>,
	translator: Translator,
): string {
	return copper === null ? translator.t(`advisor.view.value.${fallback}`) : formatInventoryAdvisorCopper(copper, translator);
}

export function formatInventoryAdvisorCopper(copper: number, translator: Translator): string {
	return translator.t('advisor.view.valueCoins', {
		gold: Math.floor(copper / 10_000),
		silver: Math.floor(copper / 100) % 100,
		copper: copper % 100,
	});
}

function ownershipLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	return row.ownedQuantity === row.availableQuantity
		? String(row.ownedQuantity)
		: translator.t('advisor.view.ownershipDifference', {
			owned: row.ownedQuantity, available: row.availableQuantity,
		});
}

function explanationLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.action === 'discard_review') {
		return row.discardProof === null
			? translator.t('advisor.view.reviewRequired')
			: translator.t('advisor.view.discardProof', { rule: row.discardProof.discardRuleId });
	}
	return row.reasonCodes.length === 0
		? translator.t('advisor.view.noExplanation')
		: row.reasonCodes.map((code) => translator.t(`advisor.view.reason.${code}`)).join(' · ');
}

function rowContextDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
	showSlotsFreed = false,
	bagCharacter: string | null = null,
): HTMLDListElement | null {
	// H18.15: with little free space the list is ordered by it, so each row says what it frees.
	const slotsFreed = showSlotsFreed && (row.slotsFreed ?? 0) > 0 ? row.slotsFreed ?? 0 : 0;
	if (row.burden === null && row.protectionReasons.length === 0 && row.marketComparison === null
		&& row.materialStorage == null && slotsFreed === 0) return null;
	const list = createEl('dl');
	list.className = 'tyrian-inventory-advisor__row-context';
	if (slotsFreed > 0) addDefinition(
		list,
		translator.t('advisor.view.slotsFreed.label'),
		translator.t(bagCharacter === null
			? (slotsFreed === 1 ? 'advisor.view.slotsFreed.one' : 'advisor.view.slotsFreed.many')
			: (slotsFreed === 1 ? 'advisor.view.slotsFreed.namedOne' : 'advisor.view.slotsFreed.namedMany'),
			{ count: slotsFreed, character: bagCharacter ?? '' }),
	);
	if (row.materialStorage != null) addDefinition(
		list,
		translator.t('advisor.view.materialStorage.capacity'),
		translator.t('advisor.view.materialStorage.value', {
			// H18.15: an observed minimum is a floor the stacks prove, never the real capacity.
			capacity: row.materialStorage.capacitySource === 'observed_minimum'
				? translator.t('advisor.view.materialStorage.atLeast', { capacity: row.materialStorage.capacity })
				: row.materialStorage.capacity,
			stored: row.materialStorage.storedQuantity,
			space: row.materialStorage.spaceBefore,
			source: translator.t(`advisor.view.materialStorage.source.${row.materialStorage.capacitySource}`),
		}),
	);
	if (row.burden !== null) addDefinition(
		list,
		translator.t(`advisor.view.burden.${row.burden.kind}`),
		translator.t('advisor.view.burden.value', {
			slots: row.burden.occupiedSlots,
			quantity: row.burden.quantity,
		}),
	);
	for (const reason of row.protectionReasons) {
		if (reason.kind === 'reservation_goal') addDefinition(
			list,
			translator.t('advisor.view.protection.goal', { title: reason.title }),
			translator.t('advisor.view.protection.goalValue', {
				quantity: reason.quantity,
				reason: translator.t(`advisor.preferences.reason.${reason.reason}`),
				basis: translator.t(`advisor.preferences.basis.${reason.basis}`),
				use: translator.t(`advisor.preferences.intendedUse.${reason.intendedUse}`),
			}),
		);
		else addDefinition(
			list,
			translator.t('advisor.view.protection.exception'),
			translator.t('advisor.view.protection.exceptionValue', {
				quantity: reason.quantity,
				reason: translator.t(`advisor.preferences.reason.${reason.reason}`),
				basis: translator.t(`advisor.preferences.basis.${reason.basis}`),
			}),
		);
	}
	const comparison = row.marketComparison;
	if (comparison !== null) {
		if (comparison.depthStatus !== undefined) addDefinition(
			list,
			translator.t('advisor.view.marketDepth.status'),
			translator.t(`advisor.view.marketDepth.status.${comparison.depthStatus}`),
		);
		if (comparison.coveredQuantity !== undefined && comparison.uncoveredQuantity !== undefined) addDefinition(
			list,
			translator.t('advisor.view.marketDepth.coverage'),
			translator.t('advisor.view.marketDepth.coverageValue', {
				covered: comparison.coveredQuantity,
				uncovered: comparison.uncoveredQuantity,
			}),
		);
		addDefinition(list, translator.t('advisor.view.marketComparison.instant'),
			priceOrFallback(comparison.instantSellCopper, 'unavailable', translator));
		addDefinition(list, translator.t('advisor.view.marketComparison.listing'),
			priceOrFallback(comparison.listingCopper, 'unavailable', translator));
		addDefinition(list, translator.t('advisor.view.marketComparison.difference'),
			comparison.differenceCopper === null ? translator.t('advisor.view.value.unavailable')
				: translator.t('advisor.view.marketComparison.differenceValue', {
					value: signedCopper(comparison.differenceCopper, translator),
					percent: comparison.differenceBasisPoints === null
						? translator.t('advisor.view.value.unavailable')
						: signedBasisPoints(comparison.differenceBasisPoints, translator),
				}));
	}
	return list;
}

function signedCopper(copper: number, translator: Translator): string {
	const sign = copper > 0 ? '+' : copper < 0 ? '−' : '';
	return `${sign}${formatInventoryAdvisorCopper(Math.abs(copper), translator)}`;
}

function signedBasisPoints(basisPoints: number, translator: Translator): string {
	const sign = basisPoints > 0 ? '+' : basisPoints < 0 ? '−' : '';
	return `${sign}${formatBasisPoints(Math.abs(basisPoints), translator)}%`;
}

function formatBasisPoints(basisPoints: number, translator: Translator): string {
	return new Intl.NumberFormat(translator.locale, { maximumFractionDigits: 2 })
		.format(basisPoints / 100);
}

/** H11.6 disclosure. It adds no statistical interval and never hides the liquid-only baseline. */
function containerEconomyDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLDetailsElement | null {
	const economy = row.containerEconomy;
	if (economy == null) return null;
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__container-economy';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.containerEconomy.title');
	const list = createEl('dl');
	addDefinition(list, translator.t('advisor.containerEconomy.liquidEv'),
		formatMicroCopper(economy.liquidOnly.explanation.open.evPerContainerMicroCopper, translator));
	const coverage = economy.personal.valuation.coverage;
	addDefinition(list, translator.t('advisor.containerEconomy.knownAdjustment'), coverage === 'none'
		? translator.t('advisor.containerEconomy.adjustmentUnknown')
		: coverage === 'partial'
			? translator.t('advisor.containerEconomy.adjustmentLowerBound', {
				value: formatMicroCopper(economy.personal.valuation.knownAdjustment, translator),
			})
			: formatMicroCopper(economy.personal.valuation.knownAdjustment, translator));
	addDefinition(list, translator.t('advisor.containerEconomy.personalEv'),
		economy.personal.openEvPerContainerMicroCopper === null
			? translator.t('advisor.containerEconomy.pending', {
				pending: economy.personal.valuation.unvalued.length,
				total: economy.personal.valuation.lines.length + economy.personal.valuation.unvalued.length,
			})
			: formatMicroCopper(economy.personal.openEvPerContainerMicroCopper, translator));
	addDefinition(list, translator.t('advisor.containerEconomy.sellNow'),
		formatInventoryAdvisorCopper(economy.liquidOnly.explanation.sellNow.netCopper, translator));
	addDefinition(list, translator.t('advisor.containerEconomy.threshold'),
		translator.t('advisor.containerEconomy.thresholdValue', {
			margin: economy.liquidOnly.explanation.threshold.marginBps / 100,
			value: formatMicroCopperString(
				economy.liquidOnly.explanation.threshold.requiredOpenMicroCopper, translator,
			),
		}));
	const liquidAction = actionLabelFor(economyActionLabel(economy.liquidOnly.decision.action), translator);
	const personalAction = economy.personal.decision === null
		? null : actionLabelFor(economyActionLabel(economy.personal.decision.action), translator);
	addDefinition(list, translator.t('advisor.containerEconomy.decisions'), personalAction === null
		? translator.t('advisor.containerEconomy.liquidDecisionOnly', { liquid: liquidAction })
		: personalAction === liquidAction
			? translator.t('advisor.containerEconomy.sameDecision', { action: personalAction })
			: translator.t('advisor.containerEconomy.differentDecisions', {
				liquid: liquidAction, personal: personalAction,
			}));
	addDefinition(list, translator.t('advisor.containerEconomy.recommendationBasis'),
		translator.t(`advisor.containerEconomy.basis.${economy.recommendationBasis}`));
	const outside = createEl('p');
	outside.textContent = translator.t('advisor.containerEconomy.outsideModel', {
		units: economy.personal.valuation.outsideModelSampleUnits,
	});
	details.append(summary, list, routesTable(economy.liquidOnly.explanation, translator), outside);
	return details;
}

/**
 * Both sale bases as two rows with their own verdict.
 *
 * They are shown side by side rather than merged because they answer different
 * questions and can disagree: the immediate row is money a buyer is already
 * offering, the listing row is a price nobody has yet accepted. The execution
 * column carries that difference in words, so the second row can never be read
 * as a promise of a sale.
 */
function routesTable(
	explanation: NonNullable<InventoryAdvisorViewRow['containerEconomy']>['liquidOnly']['explanation'],
	translator: Translator,
): HTMLTableElement {
	const table = createEl('table');
	table.className = 'tyrian-inventory-advisor__container-routes';
	const caption = createEl('caption');
	caption.textContent = translator.t('advisor.containerEconomy.routes.title');
	const head = createEl('thead');
	const headRow = createEl('tr');
	for (const key of ['basis', 'sale', 'open', 'threshold', 'verdict', 'execution'] as const) {
		const cell = createEl('th');
		cell.scope = 'col';
		cell.textContent = translator.t(`advisor.containerEconomy.routes.${key}`);
		headRow.append(cell);
	}
	head.append(headRow);
	const body = createEl('tbody');
	for (const route of explanation.routes) {
		const row = createEl('tr');
		const basis = createEl('th');
		basis.scope = 'row';
		basis.textContent = route.saleBasis === explanation.preferredSaleBasis
			? translator.t('advisor.containerEconomy.routes.preferred', {
				basis: translator.t(`advisor.containerEconomy.routes.basisName.${route.saleBasis}`),
			})
			: translator.t(`advisor.containerEconomy.routes.basisName.${route.saleBasis}`);
		row.append(basis);
		appendCell(row, formatInventoryAdvisorCopper(route.sellNow.netCopper, translator));
		appendCell(row, route.open.coverage === 'complete'
			? formatMicroCopper(route.open.evPerContainerMicroCopper, translator)
			: translator.t('advisor.containerEconomy.routes.noCounterparty', {
				value: formatMicroCopper(route.open.evPerContainerMicroCopper, translator),
				ids: route.open.noCounterpartyItemIds.join(', '),
			}));
		appendCell(row, formatMicroCopperString(route.threshold.requiredOpenMicroCopper, translator));
		appendCell(row, actionLabelFor(route.decision.action, translator));
		appendCell(row, translator.t(`advisor.containerEconomy.routes.execution.${route.execution}`));
		body.append(row);
	}
	table.append(caption, head, body);
	return table;
}

/**
 * The excluded tail, priced and kept strictly apart.
 *
 * It is a separate collapsed disclosure and never touches the recommendation.
 * The standard deviation travels with the mean on purpose: for this bag it is
 * two orders of magnitude larger, which is the only honest way to say that the
 * tail is a real expected return and still not a plan for a hundred bags.
 */
function containerTailDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLDetailsElement | null {
	const tail = row.containerEconomy?.liquidOnly.explanation.tail;
	if (tail == null) return null;
	const routes = row.containerEconomy?.liquidOnly.explanation.routes ?? [];
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__container-tail';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.containerEconomy.tail.title');
	const intro = createEl('p');
	intro.textContent = translator.t('advisor.containerEconomy.tail.intro');
	const list = createEl('dl');
	for (const route of routes) {
		const basisName = translator.t(`advisor.containerEconomy.routes.basisName.${route.saleBasis}`);
		const withTail = route.openIncludingTail;
		addDefinition(list, translator.t('advisor.containerEconomy.tail.ev', { route: basisName }),
			withTail === null ? translator.t('advisor.view.value.unavailable')
				: translator.t('advisor.containerEconomy.tail.variance', {
					value: formatMicroCopper(withTail.evPerContainerMicroCopper, translator),
					deviation: formatMicroCopper(withTail.deviationPerContainerMicroCopper, translator),
					verdict: translator.t(withTail.meetsThreshold
						? 'advisor.containerEconomy.tail.meetsThreshold'
						: 'advisor.containerEconomy.tail.belowThreshold'),
				}));
		const basisTail = route.saleBasis === 'immediate' ? tail.immediate : tail.listing;
		if (basisTail.unpricedItemIds.length > 0) {
			addDefinition(list, translator.t('advisor.containerEconomy.tail.unpriced', { route: basisName }),
				basisTail.unpricedItemIds.join(', '));
		}
	}
	const itemized = createEl('p');
	itemized.textContent = translator.t('advisor.containerEconomy.tail.itemized', {
		itemized: tail.itemizedSampleUnits, bucket: tail.bucketSampleUnits,
	});
	details.append(summary, intro, list, itemized);
	return details;
}

/** Out of the declared window the advisor says so instead of pretending to watch. */
function containerSeasonNotice(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLParagraphElement | null {
	const season = row.containerSeason;
	if (season == null) return null;
	const notice = createEl('p');
	notice.className = 'tyrian-inventory-advisor__season';
	notice.setAttribute('role', 'status');
	notice.textContent = translator.t('advisor.containerEconomy.season.outOfSeason', {
		month: monthName(season.returnsInMonth, translator),
	});
	return notice;
}

function monthName(month: number, translator: Translator): string {
	return new Intl.DateTimeFormat(translator.locale, { month: 'long', timeZone: 'UTC' })
		.format(new Date(Date.UTC(2000, month - 1, 1)));
}

/** H9.16/H9.3 disclosure keeps every excluded output and optional preference visible. */
function equipmentSalvageDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLDetailsElement | null {
	const salvage = row.equipmentSalvage;
	if (salvage == null) return null;
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__equipment-salvage';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.salvageEconomy.title');
	const list = createEl('dl');
	if (salvage.status === 'review') {
		addDefinition(list, translator.t('advisor.salvageEconomy.status'),
			translator.t(`advisor.salvageEconomy.review.${salvage.reason}`));
		addDefinition(list, translator.t('advisor.salvageEconomy.rule'), salvage.ruleId ?? translator.t('advisor.view.value.unavailable'));
		addDefinition(list, translator.t('advisor.salvageEconomy.sources'), salvage.sourceIds.length === 0
			? translator.t('advisor.view.value.unavailable') : salvage.sourceIds.join(', '));
		details.append(summary, list);
		return details;
	}
	const economy = salvage.economics;
	addDefinition(list, translator.t('advisor.salvageEconomy.rule'), economy.ruleId);
	addDefinition(list, translator.t('advisor.salvageEconomy.expectedOutput'),
		translator.t('advisor.salvageEconomy.expectedOutputValue', {
			quantity: economy.quantity,
			expected: new Intl.NumberFormat(translator.locale, { maximumFractionDigits: 6 })
				.format(economy.expectedOutputMillionths * economy.quantity / 1_000_000),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.outputStrategy'),
		translator.t(`advisor.salvageEconomy.outputStrategy.${economy.outputStrategySource}`, {
			strategy: translator.t(`advisor.salvageEconomy.strategy.${economy.outputStrategy}`),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.grossOutput'),
		formatSignedMicroCopper(economy.grossOutputMicroCopper, translator));
	addDefinition(list, translator.t('advisor.salvageEconomy.kit'),
		translator.t(`advisor.salvageEconomy.kit.${economy.kitSource}`, {
			kit: translator.t(`advisor.salvageEconomy.kitName.${economy.kit}`),
			cost: formatSignedMicroCopper(economy.kitCostMicroCopper, translator),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.time'), economy.timeCostSource === 'configured'
		? formatSignedMicroCopper(economy.timeCostMicroCopper, translator)
		: translator.t('advisor.salvageEconomy.time.excluded'));
	addDefinition(list, translator.t('advisor.salvageEconomy.net'),
		formatSignedMicroCopper(economy.netSalvageMicroCopper, translator));
	addDefinition(list, translator.t('advisor.salvageEconomy.market'),
		translator.t('advisor.salvageEconomy.marketValue', {
			instant: priceOrFallback(economy.marketAlternatives.instantSellCopper, 'unavailable', translator),
			listing: priceOrFallback(economy.marketAlternatives.listingCopper, 'unavailable', translator),
			vendor: priceOrFallback(economy.marketAlternatives.vendorCopper, 'unavailable', translator),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.sources'), economy.sourceIds.join(', '));
	const excluded = createEl('p');
	excluded.textContent = translator.t('advisor.salvageEconomy.excluded');
	details.append(summary, list, excluded);
	return details;
}

function formatSignedMicroCopper(value: number, translator: Translator): string {
	const sign = value < 0 ? '−' : '';
	return `${sign}${formatMicroCopper(Math.abs(value), translator)}`;
}

function formatMicroCopper(value: number, translator: Translator): string {
	return formatMicroCopperBigInt(BigInt(value), translator);
}

function formatMicroCopperString(value: string, translator: Translator): string {
	return formatMicroCopperBigInt(BigInt(value), translator);
}

function formatMicroCopperBigInt(microCopper: bigint, translator: Translator): string {
	const whole = microCopper / 1_000_000n;
	const fraction = (microCopper % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '');
	const decimal = new Intl.NumberFormat(translator.locale).formatToParts(1.1)
		.find((part) => part.type === 'decimal')?.value ?? '.';
	return translator.t('advisor.containerEconomy.microCopper', {
		value: fraction.length === 0
			? formatNumber(whole, translator.locale)
			: `${formatNumber(whole, translator.locale)}${decimal}${fraction}`,
	});
}

/** The one place a plain integer or bigint reaches the screen; keeps every digit-grouping decision in one spot. */
function formatNumber(value: number | bigint, locale: Locale): string {
	return new Intl.NumberFormat(locale).format(value);
}

const COVERAGE_AXES = [
	'snapshot', 'inventory', 'catalog', 'prices', 'reservations', 'accountSignals', 'rules',
] as const;

/** Keeps the normal surface to one of three user-facing evidence messages. */
function evidenceLabel(coverage: InventoryAdvisorViewCoverage, translator: Translator): string {
	return translator.t(`advisor.view.evidence.${evidenceGroup(coverage)}`);
}

/** Exposes internal axes only behind an explicit advanced disclosure. */
function advancedEvidenceDetails(
	coverage: InventoryAdvisorViewCoverage,
	translator: Translator,
): HTMLDetailsElement | null {
	const incomplete = COVERAGE_AXES.filter((axis) => coverage[axis] !== 'complete');
	if (incomplete.length === 0) return null;
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__advanced-evidence';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.view.advancedDetails');
	const detail = createEl('p');
	detail.textContent = translator.t('advisor.view.evidenceDetail', {
		level: evidenceLabel(coverage, translator),
		axes: incomplete.map((axis) => translator.t(`advisor.view.coverage.${axis}`)).join(', '),
	});
	details.append(summary, detail);
	return details;
}
