import { afterEach, describe, expect, it } from 'vitest';

import { installDomHelpers, type DomHelperScope } from './dom-polyfill';

/**
 * A standard DOM with NONE of Obsidian's helpers, the way Hebra's webview is: only what the
 * platform itself has (`createElement`, `appendChild`, `classList`, `setAttribute`…). The repo has
 * no jsdom; this is the smallest DOM the helpers can be proven against.
 */
class StandardNode {
	readonly childNodes: StandardNode[] = [];
	parentNode: StandardNode | null = null;
	constructor(readonly ownerDocument: StandardDocument | null) {}
	get firstChild(): StandardNode | null { return this.childNodes[0] ?? null; }
	get lastChild(): StandardNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
	appendChild(child: StandardNode): StandardNode { return this.insertBefore(child, null); }
	insertBefore(child: StandardNode, before: StandardNode | null): StandardNode {
		child.parentNode?.removeChild(child);
		const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
		this.childNodes.splice(index, 0, child);
		child.parentNode = this;
		return child;
	}
	removeChild(child: StandardNode): StandardNode {
		this.childNodes.splice(this.childNodes.indexOf(child), 1);
		child.parentNode = null;
		return child;
	}
	get textContent(): string { return this.childNodes.map((child) => child.textContent).join(''); }
	set textContent(value: string) {
		for (const child of [...this.childNodes]) this.removeChild(child);
		if (value !== '') this.appendChild(new StandardText(this.ownerDocument, value));
	}
}

class StandardText extends StandardNode {
	constructor(ownerDocument: StandardDocument | null, private data: string) { super(ownerDocument); }
	override get textContent(): string { return this.data; }
	override set textContent(value: string) { this.data = value; }
}

class StandardElement extends StandardNode {
	readonly attributes = new Map<string, string>();
	constructor(ownerDocument: StandardDocument, readonly tagName: string) { super(ownerDocument); }
	get className(): string { return this.attributes.get('class') ?? ''; }
	set className(value: string) { this.attributes.set('class', value); }
	readonly classList = {
		list: (): string[] => this.className.split(' ').filter((name) => name !== ''),
		add: (...names: string[]): void => { this.className = [...new Set([...this.classList.list(), ...names])].join(' '); },
		remove: (...names: string[]): void => { this.className = this.classList.list().filter((name) => !names.includes(name)).join(' '); },
		toggle: (name: string, force: boolean): void => { if (force) this.classList.add(name); else this.classList.remove(name); },
		contains: (name: string): boolean => this.classList.list().includes(name),
	};
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	removeAttribute(name: string): void { this.attributes.delete(name); }
}

class StandardInput extends StandardElement {
	value = '';
}

class StandardDocument extends StandardNode {
	constructor(readonly defaultView: object | null) { super(null); }
	createElement(tag: string): StandardElement {
		return tag === 'input' ? new StandardInput(this, 'INPUT') : new StandardElement(this, tag.toUpperCase());
	}
	createTextNode(data: string): StandardText { return new StandardText(this, data); }
}

/** A fresh global scope per test, never the real one. The prototypes are shared: see `afterEach`. */
function standardDom() {
	const window = {};
	const document = new StandardDocument(window);
	const scope = { Node: StandardNode, Element: StandardElement, document, window } as unknown as DomHelperScope;
	return { scope, document, window, globals: scope as unknown as Record<string, (...args: unknown[]) => unknown> };
}

// The helpers land on the shared `StandardNode`/`StandardElement` prototypes: take them off
// after every test so each one starts from a DOM without them.
afterEach(() => {
	for (const name of ['createEl', 'createDiv', 'createSpan', 'empty', 'appendText', 'doc', 'win']) {
		Reflect.deleteProperty(StandardNode.prototype, name);
	}
	for (const name of ['setText', 'addClass', 'removeClass', 'toggleClass', 'setAttr']) {
		Reflect.deleteProperty(StandardElement.prototype, name);
	}
});

type Helpers = StandardElement & {
	createEl(tag: string, options?: unknown, callback?: (el: unknown) => void): StandardElement & Helpers;
	createDiv(options?: unknown): StandardElement & Helpers;
	createSpan(options?: unknown): StandardElement & Helpers;
	empty(): void;
	appendText(text: string): void;
	setText(text: string): void;
	addClass(...classes: string[]): void;
	removeClass(...classes: string[]): void;
	toggleClass(classes: string | string[], value: boolean): void;
	setAttr(name: string, value: string | number | boolean | null): void;
	readonly doc: unknown;
	readonly win: unknown;
};

function installedDom() {
	const dom = standardDom();
	installDomHelpers(dom.scope);
	return { ...dom, root: () => dom.document.createElement('div') as unknown as Helpers };
}

describe('installDomHelpers on a DOM without them', () => {
	it('installs every helper the UI uses, on the prototypes and the global scope', () => {
		const { scope } = standardDom();
		expect(installDomHelpers(scope)).toEqual([
			'Node.createEl', 'Node.createDiv', 'Node.createSpan', 'Node.empty', 'Node.appendText', 'Node.doc', 'Node.win',
			'Element.setText', 'Element.addClass', 'Element.removeClass', 'Element.toggleClass', 'Element.setAttr',
			'createEl', 'createDiv', 'createSpan',
		]);
		// Non-enumerable, like a native method: a `for…in` over an element does not list them.
		expect(Object.keys(StandardNode.prototype)).not.toContain('createEl');
		// Installed once: a second call finds them all and adds nothing.
		expect(installDomHelpers(scope)).toEqual([]);
	});

	it('touches nothing that already exists (inside Obsidian, every helper does)', () => {
		const createEl = (): string => 'obsidian';
		const empty = (): string => 'obsidian';
		class ObsidianNode {}
		Object.assign(ObsidianNode.prototype, { createEl, createDiv: createEl, createSpan: createEl, empty, appendText: empty });
		Object.defineProperty(ObsidianNode.prototype, 'doc', { get: () => 'obsidian-doc' });
		Object.defineProperty(ObsidianNode.prototype, 'win', { get: () => 'obsidian-win' });
		class ObsidianElement {}
		Object.assign(ObsidianElement.prototype, { setText: empty, addClass: empty, removeClass: empty, toggleClass: empty, setAttr: empty });
		const scope = { Node: ObsidianNode, Element: ObsidianElement, createEl, createDiv: createEl, createSpan: createEl } as unknown as DomHelperScope;

		expect(installDomHelpers(scope)).toEqual([]);
		expect((ObsidianNode.prototype as unknown as { empty: unknown }).empty).toBe(empty);
		expect(scope.createEl).toBe(createEl);
	});

	it('does nothing in a scope with no DOM at all (Vitest\'s node environment)', () => {
		expect(installDomHelpers({})).toEqual([]);
	});
});

describe('the installed helpers', () => {
	it('createEl appends a child with the class, text and attributes of its options', () => {
		const { document, root } = installedDom();
		const parent = root();
		const first = parent.createEl('p', { cls: 'intro', text: 'Hola' });
		const input = parent.createEl('input', {
			cls: ['tyrian-field', 'is-wide'], type: 'checkbox', value: 'on', placeholder: '0', title: 'Tip',
			attr: { readonly: '', 'aria-label': 'Campo', tabindex: 0, hidden: null },
		});
		expect(parent.childNodes).toEqual([first, input]);
		expect(first.tagName).toBe('P');
		expect(first.className).toBe('intro');
		expect(first.textContent).toBe('Hola');
		expect(input.className).toBe('tyrian-field is-wide');
		expect((input as unknown as StandardInput).value).toBe('on');
		expect(Object.fromEntries(input.attributes)).toEqual({
			class: 'tyrian-field is-wide', readonly: '', 'aria-label': 'Campo', tabindex: '0',
			title: 'Tip', type: 'checkbox', placeholder: '0',
		});
		expect(input.ownerDocument).toBe(document);
	});

	it('a bare string is the class; createDiv and createSpan are createEl of div and span', () => {
		const { root } = installedDom();
		const parent = root();
		const div = parent.createDiv('tyrian-row');
		const span = parent.createSpan({ text: '12 g' });
		const called: unknown[] = [];
		const small = parent.createEl('small', undefined, (el) => { called.push(el); });
		expect([div.tagName, div.className]).toEqual(['DIV', 'tyrian-row']);
		expect([span.tagName, span.textContent]).toEqual(['SPAN', '12 g']);
		expect(called).toEqual([small]);
		expect(parent.childNodes).toEqual([div, span, small]);
	});

	it('the global creators make a detached element in the global document', () => {
		const { document, globals } = installedDom();
		const section = globals.createEl!('section', { cls: 'tyrian-inventory-advisor' }) as StandardElement;
		const div = globals.createDiv!() as StandardElement;
		const span = globals.createSpan!('tc-money') as StandardElement;
		expect([section.tagName, section.className, section.parentNode]).toEqual(['SECTION', 'tyrian-inventory-advisor', null]);
		expect([div.tagName, span.tagName, span.className]).toEqual(['DIV', 'SPAN', 'tc-money']);
		expect(section.ownerDocument).toBe(document);
	});

	it('empty removes every child; setText replaces them with one text; appendText adds one', () => {
		const { root } = installedDom();
		const parent = root();
		parent.createDiv();
		parent.createSpan({ text: 'x' });
		parent.empty();
		expect(parent.childNodes).toEqual([]);
		parent.createDiv({ text: 'viejo' });
		parent.setText('Nuevo');
		expect(parent.childNodes).toHaveLength(1);
		expect(parent.textContent).toBe('Nuevo');
		parent.appendText(' y más');
		expect(parent.textContent).toBe('Nuevo y más');
		expect(parent.childNodes).toHaveLength(2);
	});

	it('addClass, removeClass and toggleClass edit the class list; setAttr sets, stringifies and removes', () => {
		const { root } = installedDom();
		const element = root();
		element.addClass('a', 'b');
		element.removeClass('a');
		element.toggleClass('is-pending', true);
		element.toggleClass(['b', 'c'], false);
		expect(element.className).toBe('is-pending');
		element.toggleClass('is-pending', false);
		expect(element.className).toBe('');
		element.setAttr('aria-expanded', true);
		element.setAttr('data-count', 3);
		expect(Object.fromEntries(element.attributes)).toMatchObject({ 'aria-expanded': 'true', 'data-count': '3' });
		element.setAttr('aria-expanded', null);
		expect(element.getAttribute('aria-expanded')).toBeNull();
	});

	it('doc and win are the node\'s own document and its window', () => {
		const { document, window, root } = installedDom();
		const element = root();
		expect(element.doc).toBe(document);
		expect(element.win).toBe(window);
	});
});
