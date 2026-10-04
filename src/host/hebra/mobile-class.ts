/**
 * Obsidian's `is-mobile` class on `<body>` while the plugin runs on a touch device (R5).
 *
 * In Obsidian it is the `body` class of its mobile app, and `styles.css` reads it as
 * `.is-mobile .tyrian-…` to grow targets to 44 px (`docs/HEBRA-CSS-VARIABLES.md`, row `is-mobile`).
 * Hebra's own choices, kept from the compiled module:
 *
 * - on `<body>` and not on each slot's root: it is then seen the same in the inspector sheet, the
 *   view dialog, a modal, the settings and the note block, and Hebra uses it in no selector;
 * - with Hebra's own touch-device rule, not the window width: an iPhone or iPad
 *   (`api.env.appleMobile()`, the iPad that announces itself as a Mac included) or a coarse main
 *   pointer (`pointer: coarse`). A narrow desktop window is NOT mobile, as in Obsidian;
 * - the `pointer: coarse` change is followed live, and the class leaves with the plugin.
 *
 * The stylesheet itself is not installed here: Hebra injects the plugin's `hebra-styles.css`
 * (SPEC-PLUGINS-EXTERNOS.md §3.1), the concatenation `build:host-esm` generates.
 */

/** The class Obsidian puts on `<body>` in its mobile app (iPhone, iPad, Android). */
export const OBSIDIAN_MOBILE_CLASS = 'is-mobile';

/** What `installObsidianMobileClass` reads of the window (injectable in tests). */
export interface MobileClassWindow {
	matchMedia(query: string): Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
}

const COARSE_POINTER = '(pointer: coarse)';

export function installObsidianMobileClass(doc: Document, win: MobileClassWindow, appleMobile: boolean): () => void {
	const coarse = win.matchMedia(COARSE_POINTER);
	const apply = (): void => {
		doc.body.classList.toggle(OBSIDIAN_MOBILE_CLASS, appleMobile || coarse.matches);
	};
	apply();
	coarse.addEventListener('change', apply);
	return () => {
		coarse.removeEventListener('change', apply);
		doc.body.classList.remove(OBSIDIAN_MOBILE_CLASS);
	};
}
