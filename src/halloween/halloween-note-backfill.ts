import { parse as parseYaml } from 'yaml';
import type { HalloweenBackfillCandidate } from './halloween-model';
import { decodeHalloweenNoteEvidence } from './halloween-note-evidence';

export interface HalloweenBackfillFile { path: string }
export interface HalloweenBackfillVault {
	markdownFiles(): readonly HalloweenBackfillFile[];
	read(file: HalloweenBackfillFile): Promise<string>;
}

const REF = /^[a-f0-9]{64}$/u;

/** Reads only explicit Halloween session notes; human prose never becomes inventory evidence. */
export async function scanHalloweenSessionNotes(
	vault: HalloweenBackfillVault,
	accountRef: string,
): Promise<HalloweenBackfillCandidate[]> {
	const candidates: HalloweenBackfillCandidate[] = [];
	const observed = new Set<string>();
	for (const file of [...vault.markdownFiles()].sort((left, right) => left.path.localeCompare(right.path))) {
		const content = await vault.read(file);
		let frontmatter: Record<string, string | number | null> | null = null;
		try { frontmatter = parseFrontmatter(content); }
		catch (error) {
			if (/\btc_event\s*:\s*["']?halloween\b/iu.test(content)) throw error;
			continue;
		}
		if (frontmatter?.tc_kind !== 'gw2_farming_session' || frontmatter.tc_event !== 'halloween' ||
			frontmatter.tc_account_ref !== accountRef ||
			typeof frontmatter.tc_session_ref !== 'string' || !REF.test(frontmatter.tc_session_ref) ||
			typeof frontmatter.tc_ended_at !== 'string' || !isIso(frontmatter.tc_ended_at)) continue;
		const observationId = `note:${frontmatter.tc_session_ref}`;
		if (observed.has(observationId)) throw new Error('Duplicate Halloween session note reference.');
		observed.add(observationId);
		const decoded = decodeHalloweenNoteEvidence(frontmatter);
		candidates.push({
			observationId,
			episodeId: `note-session:${frontmatter.tc_session_ref}`,
			observedAt: frontmatter.tc_ended_at,
			coverage: decoded.status === 'exact' ? 'complete' : 'partial',
			gains: decoded.status === 'exact' ? decoded.gains : [],
		});
	}
	return candidates.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
		left.observationId.localeCompare(right.observationId));
}

function parseFrontmatter(content: string): Record<string, string | number | null> | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
	if (!match) return null;
	const parsed: unknown = parseYaml(match[1]!);
	if (!isRecord(parsed)) return null;
	for (const value of Object.values(parsed)) {
		if (value !== null && typeof value !== 'string' && typeof value !== 'number') return null;
	}
	return parsed as Record<string, string | number | null>;
}

function isIso(value: string): boolean {
	return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
