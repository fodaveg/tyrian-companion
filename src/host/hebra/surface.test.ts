// @vitest-environment happy-dom
import { Window as HappyDomWindow } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHebraSurfaces, hebraSurfaceClass, isDomElement } from './surface';

// Plugin API 2.0 (SPEC-PLUGINS-EXTERNOS.md §5.5.2): each surface Hebra hands the plugin is a frame of its own,
// another realm. A second happy-dom `Window` stands for that frame here: its own document and window. Limit: happy-dom
// shares its element classes between windows, so it cannot show the separate prototypes (or `instanceof` being false)
// of a real frame; that the helpers go on the SURFACE's window is checked by what `installDomHelpers` is given.

const installs = vi.hoisted(() => ({ scopes: [] as unknown[] }));
vi.mock('../dom-polyfill', async (importOriginal) => {
	const real = await importOriginal<typeof import('../dom-polyfill')>();
	return { ...real, installDomHelpers: (scope?: Parameters<typeof real.installDomHelpers>[0]) => { installs.scopes.push(scope); return real.installDomHelpers(scope); } };
});

const windows: HappyDomWindow[] = [];

function surfaceFrame(matches = false) {
	const frame = new HappyDomWindow({ url: 'https://tyrian-companion.plugins.hebra.test/__hebra/surface.html' });
	windows.push(frame);
	const listeners: Array<() => void> = [];
	Object.assign(frame, {
		matchMedia: () => ({ matches, addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); }, removeEventListener: vi.fn() }),
	});
	const doc = frame.document as unknown as Document;
	const el = doc.body.appendChild(doc.createElement('div'));
	return { frame, doc, el };
}

afterEach(async () => {
	for (const frame of windows.splice(0)) await frame.happyDOM.close();
});

describe('a surface of another realm', () => {
	it('installs Obsidian\'s DOM helpers on the SURFACE\'s window, once, so the core\'s `el.createDiv()` paints in the surface\'s document', () => {
		const { frame, doc, el } = surfaceFrame();
		installs.scopes.length = 0;
		const surfaces = createHebraSurfaces({ appleMobile: false, openExternal: vi.fn(), report: vi.fn() });
		surfaces.prepare(el);
		surfaces.prepare(doc.body.appendChild(doc.createElement('section')));
		expect(installs.scopes).toEqual([frame]);
		const child = el.createDiv({ cls: 'tyrian-x', text: 'hola' });
		expect({ owner: child.ownerDocument === doc, cls: child.className, text: el.textContent }).toEqual({ owner: true, cls: 'tyrian-x', text: 'hola' });
		expect(isDomElement(el)).toBe(true);
	});

	it('puts is-mobile on the surface\'s body (where its stylesheet is), not on the plugin\'s own document, and dispose takes it away', () => {
		const { doc, el } = surfaceFrame();
		const surfaces = createHebraSurfaces({ appleMobile: true, openExternal: vi.fn(), report: vi.fn() });
		surfaces.prepare(el);
		expect({ surface: doc.body.classList.contains('is-mobile'), own: document.body.classList.contains('is-mobile') }).toEqual({ surface: true, own: false });
		surfaces.dispose();
		expect(doc.body.classList.contains('is-mobile')).toBe(false);
	});

	it('opens a web link clicked inside the surface through Hebra (openExternal), and leaves alone one the core already handled', () => {
		const { doc, el } = surfaceFrame();
		const openExternal = vi.fn();
		const surfaces = createHebraSurfaces({ appleMobile: false, openExternal, report: vi.fn() });
		surfaces.prepare(el);
		const link = el.appendChild(doc.createElement('a'));
		link.setAttribute('href', 'https://wiki.guildwars2.com/wiki/Mystic_Coin');
		link.setAttribute('target', '_blank');
		const label = link.appendChild(doc.createElement('span'));
		const click = new (doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true });
		label.dispatchEvent(click);
		expect({ opened: openExternal.mock.calls, prevented: click.defaultPrevented })
			.toEqual({ opened: [['https://wiki.guildwars2.com/wiki/Mystic_Coin']], prevented: true });

		const handled = new (doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true });
		link.addEventListener('click', (event) => { event.preventDefault(); }, { once: true });
		link.dispatchEvent(handled);
		expect(openExternal).toHaveBeenCalledTimes(1);

		const local = el.appendChild(doc.createElement('a'));
		local.setAttribute('href', '#section');
		local.dispatchEvent(new (doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(openExternal).toHaveBeenCalledTimes(1);

		surfaces.dispose();
		label.dispatchEvent(new (doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(openExternal, 'no listener left after dispose').toHaveBeenCalledTimes(1);
	});

	// A note block is a new frame on every render: what a surface left behind must go with its frame, not wait for dispose.
	it('lets go of a surface when its frame goes away (pagehide): class, listener and its entry, while another surface keeps them', () => {
		const first = surfaceFrame();
		const second = surfaceFrame();
		const openExternal = vi.fn();
		const surfaces = createHebraSurfaces({ appleMobile: true, openExternal, report: vi.fn() });
		surfaces.prepare(first.el);
		surfaces.prepare(second.el);
		const linkIn = (doc: Document, el: HTMLElement): HTMLAnchorElement => {
			const link = el.appendChild(doc.createElement('a'));
			link.setAttribute('href', 'https://wiki.guildwars2.com/');
			return link;
		};
		const firstLink = linkIn(first.doc, first.el);
		const secondLink = linkIn(second.doc, second.el);

		first.frame.dispatchEvent(new first.frame.Event('pagehide'));
		firstLink.dispatchEvent(new (first.doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true }));
		secondLink.dispatchEvent(new (second.doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true }));

		expect({
			firstClass: first.doc.body.classList.contains('is-mobile'),
			secondClass: second.doc.body.classList.contains('is-mobile'),
			opened: openExternal.mock.calls.length,
			firstHeld: surfaces.isPrepared(first.doc),
			secondHeld: surfaces.isPrepared(second.doc),
		}).toEqual({ firstClass: false, secondClass: true, opened: 1, firstHeld: false, secondHeld: true });
	});

	// hebra-styles.css tells the kinds of surface apart by this class: the 2.x document only has #hebra-surface-root.
	it('marks the root with the kind of surface it is, on every mount, also of a document already readied', () => {
		const { doc, el } = surfaceFrame();
		const surfaces = createHebraSurfaces({ appleMobile: false, openExternal: vi.fn(), report: vi.fn() });
		surfaces.prepare(el, 'code-block');
		const other = doc.body.appendChild(doc.createElement('div'));
		surfaces.prepare(other, 'modal');
		surfaces.prepare(doc.body.appendChild(doc.createElement('div')));
		expect([el.className, other.className, hebraSurfaceClass('main')])
			.toEqual(['tyrian-hebra-surface--code-block', 'tyrian-hebra-surface--modal', 'tyrian-hebra-surface--main']);
	});

	it('readies a document once, however many mounts it gets', () => {
		const { doc, el } = surfaceFrame();
		const openExternal = vi.fn();
		const surfaces = createHebraSurfaces({ appleMobile: false, openExternal, report: vi.fn() });
		surfaces.prepare(el);
		surfaces.prepare(el);
		surfaces.prepare(doc.body.appendChild(doc.createElement('section')));
		const link = el.appendChild(doc.createElement('a'));
		link.setAttribute('href', 'https://render.guildwars2.com/');
		link.dispatchEvent(new (doc.defaultView as unknown as typeof window).MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(openExternal).toHaveBeenCalledTimes(1);
	});
});

describe('isDomElement', () => {
	it('answers for an element of any realm and nothing else', () => {
		const { el, doc } = surfaceFrame();
		expect([isDomElement(el), isDomElement(document.body), isDomElement(doc.createTextNode('x')), isDomElement(null), isDomElement({ nodeType: 1 })])
			.toEqual([true, true, false, false, false]);
	});
});
