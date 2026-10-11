import { describe, expect, it } from 'vitest';

import { moduleBoundaryFacts, propertyCallChains, referencedNames, sourceModulePaths } from './test/module-boundary';

/**
 * No source module of the plugin feeds a string to a Trusted Types sink. Hebra's desktop page carries
 * `require-trusted-types-for 'script'` and WebKitGTK enforces it: a sink given a plain string throws
 * `This assignment requires a TrustedHTML`. One such call (`createContextualFragment('')` in
 * `ui/owned-root.ts`) left the Session section empty in Hebra 0.2.0-21 on Linux (HP-03, 11 Oct 2026),
 * and nothing in Obsidian or in happy-dom shows it, so a sink on a path no test mounts would ship.
 *
 * Decided over the AST projections of `test/module-boundary.ts` (identifiers, member names, string
 * literals and call chains), never over the text: a comment that names a sink is not a use of it.
 * `setAttribute('on…')` and `new Function` are not covered here: their names do not tell a use apart
 * (`request.onerror` of IndexedDB, a `Function` type). The mounted-sections test in
 * `host/hebra/hebra-main-view-runtime.test.ts` closes the `on*` attributes at run time.
 */
const NAME_SINKS: readonly string[] = [
	'createContextualFragment',
	'innerHTML',
	'outerHTML',
	'insertAdjacentHTML',
	'setHTMLUnsafe',
	'parseHTMLUnsafe',
	'DOMParser',
	'parseFromString',
	'srcdoc',
	'eval',
];
/** `document.write` and `writeln`, through any name the code reaches a document by. */
const DOCUMENT_NAMES = new Set(['document', 'doc', 'ownerDocument', 'activeDocument']);
const DOCUMENT_WRITES = new Set(['write', 'writeln']);

function sinksIn(names: ReadonlySet<string>, chains: readonly string[]): string[] {
	const found = NAME_SINKS.filter((name) => names.has(name));
	for (const chain of chains) {
		const segments = chain.split('.');
		const [owner, member] = segments.slice(-2);
		if (owner !== undefined && member !== undefined && DOCUMENT_NAMES.has(owner) && DOCUMENT_WRITES.has(member)) found.push(chain);
	}
	return found;
}

const sinksInSource = (source: string): string[] => sinksIn(referencedNames(source), propertyCallChains(source));

describe('the plugin feeds no string to a Trusted Types sink (Hebra desktop CSP)', () => {
	it('finds each sink it names, and none in a comment or in a lookalike', () => {
		expect(sinksInSource('const fragment = document.createRange().createContextualFragment("");')).toEqual(['createContextualFragment']);
		expect(sinksInSource('el.innerHTML = markup; el.outerHTML = markup; el.insertAdjacentHTML("beforeend", markup);'))
			.toEqual(['innerHTML', 'outerHTML', 'insertAdjacentHTML']);
		expect(sinksInSource('el.setHTMLUnsafe(markup); Document.parseHTMLUnsafe(markup);')).toEqual(['setHTMLUnsafe', 'parseHTMLUnsafe']);
		expect(sinksInSource('new DOMParser().parseFromString(markup, "text/html");')).toEqual(['DOMParser', 'parseFromString']);
		expect(sinksInSource('frame.srcdoc = markup; eval(code);')).toEqual(['srcdoc', 'eval']);
		expect(sinksInSource('document.write(markup); this.document.writeln(markup); el.doc.write(markup);'))
			.toEqual(['document.write', 'this.document.writeln', 'el.doc.write']);
		// Not uses: a comment, a member that only sounds alike, and a write that is not a document's.
		expect(sinksInSource('// never innerHTML or createContextualFragment here\nel.textContent = text; vault.write(path, data);')).toEqual([]);
	});

	it('finds none in any source module under src/', () => {
		const offenders = sourceModulePaths().flatMap((path) => {
			const facts = moduleBoundaryFacts(path);
			return sinksIn(facts.names, facts.propertyCallChains).map((sink) => `${path}: ${sink}`);
		});
		expect(offenders).toEqual([]);
	}, 60_000); // parses every src/ module: 4.4 s alone, 7.4 s in the 0.6.46 gate beside the rest of the suite, past the 5 s default
});
