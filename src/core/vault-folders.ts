/** The two vault calls both folder helpers need; every vault port in the plugin satisfies it. */
export interface FolderCreatingVault {
	file(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
}

/**
 * Creates every missing ancestor of `path`, shortest first, by joining the leading segments again
 * on each step (`segments.slice(0, n).join('/')`). A create that fails is tolerated only when the
 * folder exists afterwards (another writer won the race); otherwise it throws
 * `Error(unavailableMessage)`. Differs from `ensureFoldersBySegments` only for a path with a leading
 * empty segment (`'/a'` asks for `'/a'` here and for `'a'` there).
 */
export async function ensureFoldersFromPrefixes(
	vault: FolderCreatingVault,
	path: string,
	unavailableMessage: string,
): Promise<void> {
	const segments = path.split('/');
	for (let index = 1; index <= segments.length; index += 1) {
		const folder = segments.slice(0, index).join('/');
		if (vault.file(folder)) continue;
		try { await vault.createFolder(folder); }
		catch (error) { if (!vault.file(folder)) throw Object.assign(new Error(unavailableMessage), { cause: error }); }
	}
}

/**
 * Same contract as `ensureFoldersFromPrefixes`, but it accumulates the folder one segment at a time
 * and an empty accumulated path takes the next segment as is, so a leading empty segment is skipped
 * instead of producing a leading slash.
 */
export async function ensureFoldersBySegments(
	vault: FolderCreatingVault,
	path: string,
	unavailableMessage: string,
): Promise<void> {
	let current = '';
	for (const segment of path.split('/')) {
		current = current ? `${current}/${segment}` : segment;
		if (!vault.file(current)) {
			try { await vault.createFolder(current); }
			catch (error) { if (!vault.file(current)) throw Object.assign(new Error(unavailableMessage), { cause: error }); }
		}
	}
}
