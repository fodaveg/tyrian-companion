export interface MaterialStorageDepositDecision {
	action: string;
	itemId: number;
	quantity: number;
	materialStorage?: {
		capacity: number;
		capacitySource: string;
		storedQuantity: number;
		spaceBefore: number;
	};
}

/** Validates the shared capacity budget across every deposit slice of one item. */
export function materialStorageDepositsFit(
	decisions: readonly MaterialStorageDepositDecision[],
): boolean {
	const deposits = new Map<number, { context: NonNullable<MaterialStorageDepositDecision['materialStorage']>; quantity: number }>();
	for (const decision of decisions) {
		if (decision.action !== 'deposit_material') continue;
		const context = decision.materialStorage;
		if (context === undefined) return false;
		const current = deposits.get(decision.itemId);
		if (current === undefined) {
			if (decision.quantity > context.spaceBefore) return false;
			deposits.set(decision.itemId, { context, quantity: decision.quantity });
			continue;
		}
		if (!sameContext(current.context, context)) return false;
		const quantity = current.quantity + decision.quantity;
		if (!Number.isSafeInteger(quantity) || quantity > context.spaceBefore) return false;
		current.quantity = quantity;
	}
	return true;
}

function sameContext(
	left: NonNullable<MaterialStorageDepositDecision['materialStorage']>,
	right: NonNullable<MaterialStorageDepositDecision['materialStorage']>,
): boolean {
	return left.capacity === right.capacity
		&& left.capacitySource === right.capacitySource
		&& left.storedQuantity === right.storedQuantity
		&& left.spaceBefore === right.spaceBefore;
}
