/**
 * Panel roots have no parent yet (the caller places them), but they must belong to the `document`
 * the caller passed, so a popout window does not adopt a node from the main one. Neither
 * `document.createElement` (catalog lint `prefer-create-el`) nor the global `createEl` (main
 * window only) fits, so the root is made under that document's body, which owns it, and detached
 * again straight away.
 */
export function createOwnedRoot<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K): HTMLElementTagNameMap[K] {
	const root = document.body.createEl(tag);
	root.remove();
	return root;
}
