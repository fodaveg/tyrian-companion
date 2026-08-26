export const MAX_VAULT_RELATIVE_PATH_LENGTH = 240;
export const MAX_VAULT_PATH_SEGMENT_LENGTH = 120;

export interface VaultRelativePathOptions {
	forbiddenPathPrefixes?: readonly string[];
	forbiddenSegments?: readonly string[];
	forbiddenRootSegments?: readonly string[];
	maxPathLength?: number;
	maxSegmentLength?: number;
}

/**
 * Accepts a portable relative Vault path. NFC is canonicalized here rather than required of
 * the caller: macOS routinely hands back NFD-decomposed accents, and a folder typed with either
 * form must resolve to the same path instead of silently falling back to a different one. The
 * rest of the contract is deliberately narrower than any one filesystem so generated artifacts
 * can travel through Sync.
 */
export function normalizeVaultRelativePath(
	value: unknown,
	options: VaultRelativePathOptions = {},
): string | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	const normalized = value.normalize('NFC');
	if (normalized.startsWith('/') || normalized.includes('\\') ||
		normalized.length > (options.maxPathLength ?? MAX_VAULT_RELATIVE_PATH_LENGTH)) return null;

	const segments = normalized.split('/');
	const foldedPath = foldForWindows(normalized);
	const forbiddenPrefixes = (options.forbiddenPathPrefixes ?? []).map(foldForWindows);
	const forbiddenRoots = new Set((options.forbiddenRootSegments ?? []).map(foldForWindows));
	const forbiddenSegments = new Set((options.forbiddenSegments ?? []).map(foldForWindows));
	if (forbiddenPrefixes.some((prefix) => foldedPath === prefix || foldedPath.startsWith(`${prefix}/`)) ||
		forbiddenRoots.has(foldForWindows(segments[0] ?? '')) ||
		segments.some((segment) => forbiddenSegments.has(foldForWindows(segment)) ||
		!isPortableSegment(segment, options.maxSegmentLength ?? MAX_VAULT_PATH_SEGMENT_LENGTH))) return null;

	return segments.join('/');
}

function isPortableSegment(segment: string, maxLength: number): boolean {
	if (segment.length === 0 || segment.length > maxLength || segment === '.' || segment === '..' ||
		/[\p{Cc}\p{Cs}:*?"<>|]/u.test(segment) || /[. ]$/u.test(segment)) return false;
	const stem = (segment.split('.', 1)[0] ?? '').trimEnd();
	return !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(stem);
}

function foldForWindows(value: string): string {
	return value.toLocaleLowerCase('en-US');
}
