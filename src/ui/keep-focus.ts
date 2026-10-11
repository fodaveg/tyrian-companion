/**
 * Runs `rebuild`, which replaces the DOM under `root`, and gives the focus back to the control that
 * matches `selector` afterwards, but only when it was on one before: a player who has moved on is
 * never pulled back. A control that is `disabled` cannot take the focus, so the controls this
 * protects mark their busy state with `aria-disabled` instead.
 */
export function keepFocusOnRebuild(root: HTMLElement, selector: string, rebuild: () => void): void {
	const active = root.ownerDocument?.activeElement ?? null;
	const hadFocus = active !== null && typeof active.matches === 'function' && active.matches(selector)
		&& typeof root.contains === 'function' && root.contains(active);
	rebuild();
	if (hadFocus) root.querySelector<HTMLElement>(selector)?.focus();
}
