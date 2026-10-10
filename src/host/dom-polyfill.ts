/**
 * Obsidian's DOM helpers for a host that does not add them (R1c, SPEC-TYRIAN-EN-HEBRA.md §2).
 *
 * Obsidian extends `Node`, `Element` and the global scope with `createEl`, `setText`, `empty`…
 * (`obsidian.d.ts` 1.13, `declare global`), and Tyrian's UI builds every view with them. Hebra's
 * webview is a plain DOM, so `installDomHelpers` adds the ones Tyrian uses, each ONLY where it is
 * missing and with the semantics of Obsidian's own for what the UI passes them. Inside Obsidian
 * every one already exists and nothing is touched.
 *
 * Not a general Obsidian shim: a helper the UI does not call is not here, and adding a call to
 * one that is missing is what `dom-polyfill.test.ts` should then cover.
 */

/** What `createEl` and its siblings accept besides the tag: the subset Tyrian's UI passes. */
export interface DomHelperElementInfo {
	/** One class list: a space-separated string or an array. */
	readonly cls?: string | readonly string[];
	readonly text?: string;
	/** Each set through `setAttr`: `null` removes the attribute. */
	readonly attr?: Readonly<Record<string, string | number | boolean | null>>;
	readonly title?: string;
	readonly value?: string;
	readonly type?: string;
	readonly placeholder?: string;
	readonly href?: string;
	/** Appended to it, last (or first with `prepend`). The node methods set it to themselves. */
	readonly parent?: Node;
	readonly prepend?: boolean;
}

/*
 * The types of what `installDomHelpers` adds, so the UI type-checks without the `obsidian`
 * package (Hebra compiles this repo's sources). Inside this repo `obsidian.d.ts` declares the
 * same members: methods merge as overloads and the two properties carry the same type.
 */
declare global {
	interface Node {
		createEl<K extends keyof HTMLElementTagNameMap>(
			tag: K, o?: DomHelperElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void,
		): HTMLElementTagNameMap[K];
		createDiv(o?: DomHelperElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
		createSpan(o?: DomHelperElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
		empty(): void;
		appendText(val: string): void;
		doc: Document;
		win: Window;
	}
	interface Element {
		setText(val: string): void;
		addClass(...classes: string[]): void;
		removeClass(...classes: string[]): void;
		toggleClass(classes: string | string[], value: boolean): void;
		setAttr(qualifiedName: string, value: string | number | boolean | null): void;
	}
	function createEl<K extends keyof HTMLElementTagNameMap>(
		tag: K, o?: DomHelperElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void,
	): HTMLElementTagNameMap[K];
	function createDiv(o?: DomHelperElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
	function createSpan(o?: DomHelperElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
}

/** The global scope the helpers are installed on; `globalThis` in a webview. */
export interface DomHelperScope {
	readonly Node?: { readonly prototype: object };
	readonly Element?: { readonly prototype: object };
	readonly document?: Document;
	readonly window?: Window;
	createEl?: unknown;
	createDiv?: unknown;
	createSpan?: unknown;
}

type ElementOptions = DomHelperElementInfo | string | undefined;
type ElementCallback = ((element: HTMLElement) => void) | undefined;

/**
 * Installs every helper Tyrian's UI uses that `scope` lacks and returns the names it added
 * (`Node.createEl`, `Element.setText`, `createDiv`…), empty inside Obsidian. A scope without a
 * DOM (`Node`/`Element` absent, as in Vitest's node environment) gets nothing.
 */
export function installDomHelpers(scope: DomHelperScope = typeof window === 'undefined' ? {} : window): string[] {
	const node = scope.Node?.prototype;
	const element = scope.Element?.prototype;
	if (node === undefined || element === undefined) return [];
	const installed: string[] = [];
	const globalDocument = (): Document => {
		if (scope.document === undefined) throw new Error('No document to create elements in.');
		return scope.document;
	};
	const globalWindow = (): Window => {
		if (scope.window === undefined) throw new Error('No window for this node.');
		return scope.window;
	};
	const documentOf = (target: Node): Document => target.ownerDocument ?? globalDocument();

	const define = (owner: object, ownerName: string, name: string, value: unknown): void => {
		if (name in owner) return;
		Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: false });
		installed.push(`${ownerName}.${name}`);
	};
	const defineGetter = (owner: object, ownerName: string, name: string, get: (this: Node) => unknown): void => {
		if (name in owner) return;
		Object.defineProperty(owner, name, { get, configurable: true, enumerable: false });
		installed.push(`${ownerName}.${name}`);
	};

	const create = (doc: Document, tag: string, options: ElementOptions, callback: ElementCallback): HTMLElement => {
		const info = elementInfo(options);
		// This module IS the createEl/createDiv/createSpan polyfill for hosts without Obsidian's DOM helpers, so it cannot call them.
		// eslint-disable-next-line obsidianmd/prefer-create-el
		const created = doc.createElement(tag);
		applyElementInfo(created, info);
		if (info.parent !== undefined) {
			if (info.prepend === true) info.parent.insertBefore(created, info.parent.firstChild);
			else info.parent.appendChild(created);
		}
		callback?.(created);
		return created;
	};
	const createUnder = (parent: Node, tag: string, options: ElementOptions, callback: ElementCallback): HTMLElement =>
		create(documentOf(parent), tag, { ...elementInfo(options), parent }, callback);

	// Node: creating children, emptying, and the node's own document and window.
	define(node, 'Node', 'createEl', function (this: Node, tag: string, options?: ElementOptions, callback?: ElementCallback) {
		return createUnder(this, tag, options, callback);
	});
	define(node, 'Node', 'createDiv', function (this: Node, options?: ElementOptions, callback?: ElementCallback) {
		return createUnder(this, 'div', options, callback);
	});
	define(node, 'Node', 'createSpan', function (this: Node, options?: ElementOptions, callback?: ElementCallback) {
		return createUnder(this, 'span', options, callback);
	});
	define(node, 'Node', 'empty', function (this: Node) {
		while (this.lastChild !== null) this.removeChild(this.lastChild);
	});
	define(node, 'Node', 'appendText', function (this: Node, text: string) {
		this.appendChild(documentOf(this).createTextNode(text));
	});
	// "The document this node belongs to, or the global document", and that document's window.
	defineGetter(node, 'Node', 'doc', function (this: Node) { return documentOf(this); });
	defineGetter(node, 'Node', 'win', function (this: Node) { return documentOf(this).defaultView ?? globalWindow(); });

	// Element: text, classes and attributes.
	define(element, 'Element', 'setText', function (this: Element, text: string) {
		this.textContent = text;
	});
	define(element, 'Element', 'addClass', function (this: Element, ...classes: string[]) {
		this.classList.add(...classes);
	});
	define(element, 'Element', 'removeClass', function (this: Element, ...classes: string[]) {
		this.classList.remove(...classes);
	});
	define(element, 'Element', 'toggleClass', function (this: Element, classes: string | readonly string[], value: boolean) {
		for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
	});
	define(element, 'Element', 'setAttr', function (this: Element, name: string, value: string | number | boolean | null) {
		setAttr(this, name, value);
	});

	// The global creators, which make a detached element in the global document.
	const globalScope = scope as Record<string, unknown>;
	const defineGlobal = (name: string, value: unknown): void => {
		if (globalScope[name] !== undefined) return;
		globalScope[name] = value;
		installed.push(name);
	};
	defineGlobal('createEl', (tag: string, options?: ElementOptions, callback?: ElementCallback) =>
		create(globalDocument(), tag, options, callback));
	defineGlobal('createDiv', (options?: ElementOptions, callback?: ElementCallback) =>
		create(globalDocument(), 'div', options, callback));
	defineGlobal('createSpan', (options?: ElementOptions, callback?: ElementCallback) =>
		create(globalDocument(), 'span', options, callback));
	return installed;
}

/** A bare string is the class, as in Obsidian (`createDiv('name')`). */
function elementInfo(options: ElementOptions): DomHelperElementInfo {
	return typeof options === 'string' ? { cls: options } : options ?? {};
}

function setAttr(target: Element, name: string, value: string | number | boolean | null): void {
	if (value === null) target.removeAttribute(name);
	else target.setAttribute(name, String(value));
}

/** `DomElementInfo` onto a fresh element, as Obsidian's `createEl` applies it. */
function applyElementInfo(target: HTMLElement, info: DomHelperElementInfo): void {
	if (info.cls !== undefined) target.className = typeof info.cls === 'string' ? info.cls : info.cls.join(' ');
	if (info.text !== undefined) target.textContent = info.text;
	for (const [name, value] of Object.entries(info.attr ?? {})) setAttr(target, name, value);
	if (info.title !== undefined) target.setAttribute('title', info.title);
	if (info.value !== undefined) {
		if ('value' in target) (target as HTMLInputElement).value = info.value;
		else target.setAttribute('value', info.value);
	}
	if (info.type !== undefined) target.setAttribute('type', info.type);
	if (info.placeholder !== undefined) target.setAttribute('placeholder', info.placeholder);
	if (info.href !== undefined) target.setAttribute('href', info.href);
}
