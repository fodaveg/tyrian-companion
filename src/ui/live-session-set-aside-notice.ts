import type { LiveSessionSetAside } from '../sessions/live-session-comparison';

/** Paths named in one notice; the rest are counted, so a library full of them does not become a wall of text. */
const NAMED_PATHS = 5;

const COPY = {
	en: {
		newer_version: (n: number, paths: string) => `${n === 1 ? '1 saved session note was' : `${String(n)} saved session notes were`} written by a newer version of the plugin and cannot be read here: ${paths}. ${n === 1 ? 'It was' : 'They were'} left untouched; update the plugin to see ${n === 1 ? 'it' : 'them'}.`,
		unreadable: (n: number, paths: string) => `${n === 1 ? '1 saved session note is' : `${String(n)} saved session notes are`} unreadable or was edited inside its managed blocks: ${paths}. ${n === 1 ? 'It was' : 'They were'} left untouched and ${n === 1 ? 'is' : 'are'} not counted here.`,
		more: (n: number) => `and ${String(n)} more`,
	},
	es: {
		newer_version: (n: number, paths: string) => `${n === 1 ? '1 nota de sesión guardada la escribió' : `${String(n)} notas de sesión guardadas las escribió`} una versión más nueva del plugin y no se puede${n === 1 ? '' : 'n'} leer aquí: ${paths}. Se ${n === 1 ? 'ha dejado intacta' : 'han dejado intactas'}; actualiza el plugin para verla${n === 1 ? '' : 's'}.`,
		unreadable: (n: number, paths: string) => `${n === 1 ? '1 nota de sesión guardada es ilegible o se editó' : `${String(n)} notas de sesión guardadas son ilegibles o se editaron`} dentro de sus bloques gestionados: ${paths}. Se ${n === 1 ? 'ha dejado intacta y no cuenta' : 'han dejado intactas y no cuentan'} aquí.`,
		more: (n: number) => `y ${String(n)} más`,
	},
} as const;

/** One sentence per reason that has notes, each naming up to five by path. Empty when nothing was set aside. */
export function liveSessionSetAsideNotice(locale: 'es' | 'en', setAside: readonly LiveSessionSetAside[]): string[] {
	const copy = COPY[locale];
	const lines: string[] = [];
	for (const reason of ['newer_version', 'unreadable'] as const) {
		const paths = setAside.filter((row) => row.reason === reason).map((row) => row.path);
		if (paths.length === 0) continue;
		const named = paths.slice(0, NAMED_PATHS).join(', ');
		lines.push(copy[reason](paths.length, paths.length > NAMED_PATHS ? `${named}, ${copy.more(paths.length - NAMED_PATHS)}` : named));
	}
	return lines;
}

/** Fills `target` (a status region) with the notice, one paragraph per sentence; hides it when there is none. */
export function paintLiveSessionSetAside(document: Document, target: HTMLElement, locale: 'es' | 'en', setAside: readonly LiveSessionSetAside[]): void {
	const lines = liveSessionSetAsideNotice(locale, setAside);
	target.hidden = lines.length === 0;
	target.replaceChildren(...lines.map((line) => { const p = document.createElement('p'); p.textContent = line; return p; }));
}
