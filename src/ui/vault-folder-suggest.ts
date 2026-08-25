import { AbstractInputSuggest, type App } from 'obsidian';

/**
 * Case-insensitive substring match against known Vault folders, ordered and capped so the
 * dropdown stays short. Kept free of any DOM API so it can be tested without an Obsidian app.
 */
export function matchVaultFolders(folderPaths: readonly string[], query: string, limit = 100): string[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	return folderPaths
		.filter((path) => path.toLocaleLowerCase().includes(normalizedQuery))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, limit);
}

/**
 * Suggests existing Vault folders while a folder-path setting is typed. A path that does not
 * yet exist remains fully typeable: this only offers matches, it never rejects free text.
 */
export class VaultFolderInputSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, inputEl: HTMLInputElement, onSelectFolder: (path: string) => void | Promise<void>) {
		super(app, inputEl);
		this.onSelect((path) => {
			this.setValue(path);
			this.close();
			void onSelectFolder(path);
		});
	}

	protected getSuggestions(query: string): string[] {
		const folderPaths = this.app.vault.getAllFolders(true).map((folder) => (folder.isRoot() ? '' : folder.path));
		return matchVaultFolders(folderPaths, query);
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path === '' ? '/' : path);
	}
}
