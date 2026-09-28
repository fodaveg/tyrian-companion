/**
 * Case-insensitive substring match against known Vault folders, ordered and capped so the
 * dropdown stays short. Kept free of any DOM API so it can be tested without an Obsidian app.
 * The suggestion popup itself is the host's (`TyrianUiPort.pickFolder`; in Obsidian, the
 * `AbstractInputSuggest` in `host/obsidian/obsidian-ui.ts`).
 */
export function matchVaultFolders(folderPaths: readonly string[], query: string, limit = 100): string[] {
	const normalizedQuery = query.trim().toLowerCase();
	return folderPaths
		.filter((path) => path.toLowerCase().includes(normalizedQuery))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, limit);
}
