/**
 * Panel roots have no parent yet (the caller places them), but they must belong to the `document`
 * the caller passed, so a popout window does not adopt a node from the main one. The options that
 * look natural do not fit: `document.createElement` trips the catalog lint `prefer-create-el`, the
 * global `createEl` builds in the main window only, `body.createEl` + `remove()` shows real
 * mutations to any MutationObserver, and `win.createFragment` exists neither in the `obsidian`
 * typings nor in Hebra's DOM polyfill. An empty fragment of that document owns the new element and
 * touches nothing live; it leaves the fragment by itself when the caller inserts the root.
 *
 * The fragment comes from the constructor of the document's own window, whose fragments belong to
 * that window's document. Never from markup (`createContextualFragment('')`, `innerHTML`): Hebra's
 * desktop page carries `require-trusted-types-for 'script'` and WebKitGTK refuses any HTML parsed
 * from a string there, which left the Session section empty in Hebra 0.2.0-21 on Linux (HP-03).
 */
function emptyFragment(document: Document): DocumentFragment {
	const view = document.defaultView;
	if (view === null) throw new Error('A panel root needs a document with a window.');
	return new view.DocumentFragment();
}

export function createOwnedRoot<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K): HTMLElementTagNameMap[K] {
	return emptyFragment(document).createEl(tag);
}
