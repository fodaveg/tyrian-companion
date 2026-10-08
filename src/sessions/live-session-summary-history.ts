/**
 * «Tu media en sesiones parecidas» comes from the summaries already in the vault, not from the
 * plugin's retained sessions (it keeps only eight): each summary stores its main map, its per-hour
 * figure and its observed minutes in `tyrian_summary_*` frontmatter keys, and this reads them back.
 */

const MAX_SUMMARIES_READ = 200;

export interface SummaryHistoryVault {
	markdownFiles(): readonly { path: string }[];
	read(file: { path: string }): Promise<string>;
}

/** Per-hour figures (copper) of earlier summaries on `mainMapId`, newest first; never the session's own. */
export async function readComparablePerHour(vault: SummaryHistoryVault, folder: string, mainMapId: number | null, ownSessionRef: string): Promise<number[]> {
	if (mainMapId === null) return [];
	const prefix = `${folder}/summaries/`;
	const files = vault.markdownFiles().filter((file) => file.path.startsWith(prefix)).sort((a, b) => b.path.localeCompare(a.path)).slice(0, MAX_SUMMARIES_READ);
	const found: number[] = [];
	for (const file of files) {
		const head = await readHead(vault, file);
		if (head === null || head.of === ownSessionRef || head.mainMap !== mainMapId || head.perHour === null) continue;
		found.push(head.perHour);
	}
	return found;
}

async function readHead(vault: SummaryHistoryVault, file: { path: string }): Promise<{ of: string | null; mainMap: number | null; perHour: number | null } | null> {
	try {
		const text = await vault.read(file);
		if (!text.startsWith('---\n')) return null;
		const end = text.indexOf('\n---\n', 4);
		const frontmatter = text.slice(4, end < 0 ? undefined : end);
		const value = (key: string): string | null => new RegExp(`^tyrian_summary_${key}: (.+)$`, 'mu').exec(frontmatter)?.[1]?.trim() ?? null;
		const number = (key: string): number | null => { const raw = value(key); return raw !== null && /^-?\d+$/u.test(raw) ? Number(raw) : null; };
		if (value('of') === null) return null;
		return { of: value('of') === null ? null : value('of')!.replace(/^"|"$/gu, ''), mainMap: number('main_map'), perHour: number('per_hour_copper') };
	} catch { return null; }
}
