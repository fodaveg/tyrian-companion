/**
 * Panel roots have no parent yet (the caller places them), but they must belong to the `document`
 * the caller passed, so a popout window does not adopt a node from the main one. The options that
 * look natural do not fit: `document.createElement` trips the catalog lint `prefer-create-el`, the
 * global `createEl` builds in the main window only, `body.createEl` + `remove()` shows real
 * mutations to any MutationObserver, and `win.createFragment` exists neither in the `obsidian`
 * typings nor in Hebra's DOM polyfill. An empty fragment of that document owns the new element and
 * touches nothing live; it leaves the fragment by itself when the caller inserts the root.
 */
function emptyFragment(document: Document): DocumentFragment {
	return document.createRange().createContextualFragment('');
}

export function createOwnedRoot<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K): HTMLElementTagNameMap[K] {
	return emptyFragment(document).createEl(tag);
}
