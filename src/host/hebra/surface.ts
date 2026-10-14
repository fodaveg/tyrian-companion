/**
 * What each Hebra SURFACE needs before the core paints into it (plugin API 2.0,
 * SPEC-PLUGINS-EXTERNOS.md §5.5.2).
 *
 * In the 2.0 the plugin runs in a hidden frame and every view, section, settings panel, modal and
 * note block Hebra hands it (`mount(el)`) lives in ANOTHER frame of the plugin's origin. That frame is
 * another realm: its own `document`, its own `window` and its own `Node`/`Element` prototypes. So:
 *
 * - Obsidian's DOM helpers (`createDiv`, `setText`…, `dom-polyfill.ts`) installed on the hidden
 *   frame's prototypes do not reach `el`: they are installed in the surface's window too, once per
 *   window, before the first mount;
 * - Obsidian's `is-mobile` class (`mobile-class.ts`) goes on the surface's `<body>`, the one its
 *   stylesheet sees (`hebra-styles.css` is loaded in each surface, never in the hidden frame);
 * - a link that leaves for the web (`<a href="https://…">`) cannot be trusted to open from inside a
 *   frame, so a click on one that nothing else handled goes through `api.ui.openExternal`, which
 *   Hebra opens in the browser after its own confirmation.
 *
 * Everything is keyed by the surface's document (a frame can be mounted into more than once) and
 * undone when that frame goes away (`pagehide`: a note block is a new frame on every render, and a dead
 * one must not stay referenced) or, for what is left, by `dispose`. In Obsidian, and in a test with a single document, it changes nothing the
 * hidden frame already had: the helpers exist, and the class and the listener go on that document.
 */
import { installDomHelpers } from '../dom-polyfill';
import { installObsidianMobileClass, type MobileClassWindow } from './mobile-class';

export interface HebraSurfaceDeps {
	/** `api.env.appleMobile()`: iPhone or iPad, where `is-mobile` is always on. */
	appleMobile: boolean;
	/** Opens an `https:`/`http:` URL out of Hebra (`api.ui.openExternal`). */
	openExternal(url: string): void;
	/** A failure preparing a surface: reported, never thrown at the mount. */
	report(error: unknown, where: string): void;
}

/**
 * What a surface is, marked on its root as `tyrian-hebra-surface--<kind>` for `hebra-styles.css`
 * (`tyrian-host.css`): in the 2.x every surface's document only has `#hebra-surface-root`, so the
 * rules that differed between the 1.x slots (the main screen, a modal's button row, a note block
 * on the page's paper) read this class instead.
 */
export type HebraSurfaceKind = 'view' | 'main' | 'modal' | 'settings' | 'code-block';

/** The class `prepare` puts on the root of a surface of that kind. */
export function hebraSurfaceClass(kind: HebraSurfaceKind): string {
	return `tyrian-hebra-surface--${kind}`;
}

export interface HebraSurfaces {
	/**
	 * Readies the document `el` belongs to (cheap and idempotent per document) and, with `kind`,
	 * marks `el` with its class (`hebraSurfaceClass`).
	 */
	prepare(el: HTMLElement, kind?: HebraSurfaceKind): void;
	/** Whether it still holds anything of `doc` (what it put there, to take it away). */
	isPrepared(doc: Document): boolean;
	/** Removes the class and the listeners it put on every document it prepared. */
	dispose(): void;
}

/** Is `value` an element of ANY realm? `instanceof Element` is false for one from another frame. */
export function isDomElement(value: unknown): value is Element {
	return typeof value === 'object' && value !== null
		&& (value as Partial<Node>).nodeType === 1
		&& typeof (value as Partial<Element>).closest === 'function';
}

/** The web link a click landed on, when it is one the browser should open (`http:`/`https:`). */
function webLinkOf(event: Event): string | null {
	if (event.defaultPrevented) return null;
	const anchor = isDomElement(event.target) ? event.target.closest('a[href]') : null;
	const href = anchor?.getAttribute('href') ?? null;
	if (href === null) return null;
	try {
		const url = new URL(href);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

export function createHebraSurfaces(deps: HebraSurfaceDeps): HebraSurfaces {
	// What to undo on each document prepared now. A surface's frame can go away long before the plugin does (a note
	// block is a new frame on every render), so its entry goes with its frame (`pagehide`), never holding a dead
	// document until `dispose`; `dispose` takes whatever is left.
	const undoByDocument = new Map<Document, Array<() => void>>();
	// Never renewed: the helpers stay on a window's prototypes once installed (each only where missing).
	const helpersInstalled = new WeakSet<object>();
	const release = (doc: Document): void => {
		const steps = undoByDocument.get(doc);
		if (steps === undefined) return;
		undoByDocument.delete(doc);
		for (const step of steps.reverse()) {
			try { step(); } catch (error) { deps.report(error, 'surface.dispose'); }
		}
	};
	return {
		prepare(el, kind) {
			if (kind !== undefined) el.classList.add(hebraSurfaceClass(kind));
			const doc = el.ownerDocument;
			if (undoByDocument.has(doc)) return;
			const undo: Array<() => void> = [];
			undoByDocument.set(doc, undo);
			const win = doc.defaultView;
			try {
				if (win !== null && !helpersInstalled.has(win)) {
					helpersInstalled.add(win);
					installDomHelpers(win);
				}
			} catch (error) {
				deps.report(error, 'surface.dom-helpers');
			}
			try {
				if (win !== null && typeof (win as Partial<MobileClassWindow>).matchMedia === 'function') {
					undo.push(installObsidianMobileClass(doc, win, deps.appleMobile));
				}
			} catch (error) {
				deps.report(error, 'surface.mobile-class');
			}
			// Bubbling, so a handler of the core that already opened the link (`preventDefault`) wins.
			const onClick = (event: MouseEvent): void => {
				const url = webLinkOf(event);
				if (url === null) return;
				event.preventDefault();
				deps.openExternal(url);
			};
			doc.addEventListener('click', onClick);
			undo.push(() => { doc.removeEventListener('click', onClick); });
			if (win !== null) {
				const onPageHide = (): void => { release(doc); };
				win.addEventListener('pagehide', onPageHide, { once: true });
				undo.push(() => { win.removeEventListener('pagehide', onPageHide); });
			}
		},
		isPrepared: (doc) => undoByDocument.has(doc),
		dispose() {
			for (const doc of [...undoByDocument.keys()]) release(doc);
		},
	};
}
