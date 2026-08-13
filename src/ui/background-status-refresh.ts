export interface BackgroundStatusViewPort { refreshBackgroundStatus(): void }

/** Background delivery may update existing text/attributes, never rebuild the view tree. */
export function refreshBackgroundStatus(views: readonly BackgroundStatusViewPort[]): void {
	for (const view of views) view.refreshBackgroundStatus();
}
