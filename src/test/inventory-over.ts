/**
 * DE-01, step 3g: an `InventoryRuntime` over a plain object, through the core's own port
 * (`inventoryRuntimePort`), so the object's fields and the core's methods it lends are read exactly as
 * the moved code reads them in production. A drift of the port breaks the types here, not at run time.
 */
import { InventoryRuntime, type InventoryRuntimePort } from '../runtime/inventory-runtime';
import { TyrianCompanionCore } from '../runtime/tyrian-companion-core';

export function inventoryOver(harness: object): InventoryRuntime {
	const portOf = (TyrianCompanionCore as unknown as {
		inventoryRuntimePort(this: void, core: object): InventoryRuntimePort;
	}).inventoryRuntimePort;
	return new InventoryRuntime(portOf(harness));
}
