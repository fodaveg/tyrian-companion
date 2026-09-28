import { TFile, type EventRef, type Plugin, type TAbstractFile } from 'obsidian';

import type { LocalDebugStoragePort } from '../../core/local-debug-writer';
import type { TyrianVault, TyrianVaultChange, TyrianVaultFile } from '../tyrian-host';

/** The optional desktop-only adapter methods; mobile's adapter has no filesystem path. */
interface DesktopAdapter {
	getBasePath?: () => string;
	getFullPath?: (path: string) => string;
}

/**
 * `TyrianVault` over `app.vault`, addressed by path.
 *
 * Every member reads `plugin.app` when it is called, never once at construction, so it always
 * answers for the vault actually open. A file carries `mtime`; a folder does not: that is how a
 * host-neutral caller tells the two apart without `instanceof TFile`.
 */
export function createObsidianVault(plugin: Plugin): TyrianVault {
	const vault = () => plugin.app.vault;
	const adapter = () => vault().adapter as unknown as DesktopAdapter;
	const requireFile = (path: string): TFile => {
		const target = vault().getAbstractFileByPath(path);
		if (!(target instanceof TFile)) throw new Error('Vault entry is not a file.');
		return target;
	};
	const storage: LocalDebugStoragePort = {
		exists: async (path) => await vault().adapter.exists(path),
		read: async (path) => await vault().adapter.read(path),
		write: async (path, data) => { await vault().adapter.write(path, data); },
		append: async (path, data) => { await vault().adapter.append(path, data); },
		mkdir: async (path) => { await vault().adapter.mkdir(path); },
		remove: async (path) => { await vault().adapter.remove(path); },
		rename: async (path, destination) => { await vault().adapter.rename(path, destination); },
	};
	return {
		markdownFiles: () => vault().getMarkdownFiles().map(fileEntry),
		listFiles: () => vault().getFiles().map(fileEntry),
		exists: (path) => vault().getAbstractFileByPath(path) !== null,
		file: (path) => vaultEntry(vault().getAbstractFileByPath(path)),
		read: async (file) => await vault().read(requireFile(file.path)),
		process: async (file, update) => await vault().process(requireFile(file.path), update),
		createFolder: async (path) => { await vault().createFolder(path); },
		create: async (path, content) => fileEntry(await vault().create(path, content)),
		trashFile: async (file) => { await plugin.app.fileManager.trashFile(requireFile(file.path)); },
		onChange: (root, listener) => watchVault(plugin, root, listener),
		get configDir() { return vault().configDir; },
		canonicalIdentity: () => adapter().getBasePath?.() ?? `${vault().getName()}\0${vault().configDir}`,
		basePath: () => adapter().getBasePath?.() ?? null,
		fullPath: (path) => adapter().getFullPath?.(path) ?? null,
		adapter: storage,
	};
}

/**
 * `stat.mtime` is always present on a real `TFile`; the fallback only keeps a test double that
 * omits `stat` on the file side of the file/folder line instead of turning it into a folder.
 */
function fileEntry(file: TFile): TyrianVaultFile {
	return { path: file.path, mtime: file.stat?.mtime ?? 0 };
}

function vaultEntry(target: TAbstractFile | null): TyrianVaultFile | null {
	if (target === null) return null;
	return target instanceof TFile ? fileEntry(target) : { path: target.path };
}

/**
 * File events under `root` (`''` = the whole vault), reduced to paths. Registered through
 * `plugin.registerEvent`, so Obsidian drops them on unload exactly as before; the disposer only
 * matters to a caller that stops listening earlier. Folder events are not reported: every
 * consumer watches notes.
 */
function watchVault(plugin: Plugin, root: string, listener: (change: TyrianVaultChange) => void): () => void {
	const vault = plugin.app.vault;
	const under = (path: string): boolean => root.length === 0 || path.startsWith(root);
	const refs: EventRef[] = [
		vault.on('create', (file) => { if (file instanceof TFile && under(file.path)) listener({ kind: 'create', path: file.path }); }),
		vault.on('modify', (file) => { if (file instanceof TFile && under(file.path)) listener({ kind: 'modify', path: file.path }); }),
		vault.on('delete', (file) => { if (file instanceof TFile && under(file.path)) listener({ kind: 'delete', path: file.path }); }),
		vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && (under(file.path) || under(oldPath))) {
				listener({ kind: 'rename', path: file.path, oldPath });
			}
		}),
	];
	for (const ref of refs) plugin.registerEvent(ref);
	return () => { for (const ref of refs) vault.offref(ref); };
}
