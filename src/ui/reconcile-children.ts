/**
 * Makes `parent`'s element children exactly `wanted`, in that order, and touches only what is out
 * of place: a child already where it belongs is never removed and put back, because an element that
 * leaves the tree loses the focus and the scroll offset it held, even for a single statement.
 *
 * It creates nothing. The caller owns the nodes and decides, by its own key, which ones it keeps.
 */
export function reconcileChildren(parent: HTMLElement, wanted: readonly HTMLElement[]): void {
	const kept = new Set<Element>(wanted);
	for (const child of Array.from(parent.children)) {
		if (!kept.has(child)) parent.removeChild(child);
	}
	wanted.forEach((node, index) => {
		const current: Element | undefined = parent.children[index];
		if (current !== node) parent.insertBefore(node, current ?? null);
	});
}

/**
 * Leaves `kept` in place and moves every sibling that follows it to just before it, in their own
 * order: the way to keep a retained element last under a parent that appends, without detaching it.
 * A `kept` that is not under `parent` yet is appended instead.
 */
export function settleLast(parent: HTMLElement, kept: HTMLElement): void {
	const children = Array.from(parent.children);
	const index = children.indexOf(kept);
	if (index === -1) { parent.append(kept); return; }
	for (const sibling of children.slice(index + 1)) parent.insertBefore(sibling, kept);
}

/** Removes every child of `parent` except `kept`, which stays attached where it is. */
export function emptyExcept(parent: HTMLElement, kept: HTMLElement | null): void {
	const children = Array.from(parent.children);
	if (kept === null || !children.includes(kept)) { parent.empty(); return; }
	for (const child of children) {
		if (child !== kept) parent.removeChild(child);
	}
}
