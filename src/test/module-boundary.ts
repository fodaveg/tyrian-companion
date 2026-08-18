/**
 * Shared helpers for the structural guards. A module's dependency graph and its runtime export
 * surface are the two boundary properties that cannot be observed by running a behavior test, so
 * they stay here instead of being copied into every architecture suite.
 */

const SPECIFIER_PATTERNS = [
	/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
	/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
	/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
];

/** Every literal static, side-effect, dynamic and `require` specifier of a TypeScript source. */
export function moduleSpecifiers(source: string): string[] {
	return SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)]
		.map((match) => match[1])
		.filter((value): value is string => value !== undefined));
}

/** True when a loaded export is JSON-shaped data instead of a live capability object. */
export function isPlainJsonValue(value: unknown): boolean {
	if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
	if (typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((entry) => isPlainJsonValue(entry));
}
