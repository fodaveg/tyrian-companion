#!/usr/bin/env node
// Regenerates `src/achievements/known-achievement-sets.ts`: for every meta achievement of the public GW2 API
// (CategoryDisplay, no bits) the list of achievements that count towards it, taken from the `objectives` of its
// row on the official wiki and crossed with the API ids. The plugin never requests the wiki; this script does,
// by hand, with a cache.
//
// Usage: node scripts/generate-known-achievement-sets.mjs --cache <dir> [--out <file>] [--ids-out <file>] --date YYYY-MM-DD [--report <file>]
//
// - `<dir>/ach-en.json`, `<dir>/cats-en.json` and `<dir>/wiki/<title>.txt` are the cache: whatever is there is
//   not requested again. A missing file is fetched (API: 200 ids per request; wiki: one request at a time,
//   500 ms apart, with an identifiable User-Agent) and kept.
// - `--out` defaults to src/achievements/known-achievement-sets.ts. `--ids-out` writes the fixture the coherence test
//   reads (every id the sets mention, with its last tier).
// - The report (stdout, or `--report`) lists what the wiki did not settle: metas without a wiki row, without
//   `objectives`, with lines that match no API id, or with fewer achievements than their bar asks for.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/u, ''), process.argv[i + 1]);
const cache = resolve(args.get('cache') ?? '');
if (!args.has('cache')) { console.error('usage: --cache <dir> [--out f] [--ids-out f] --date d [--report f]'); process.exit(2); }
const out = resolve(args.get('out') ?? 'src/achievements/known-achievement-sets.ts');
const idsOut = args.get('ids-out') === undefined ? null : resolve(args.get('ids-out'));
// The date is written into the module: without it the output would change with the day it is run.
if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.get('date') ?? '')) { console.error('--date YYYY-MM-DD is required (the day the wiki and the API were read)'); process.exit(2); }
const date = args.get('date');

const USER_AGENT = 'tyrian-companion-known-sets/1.0 (https://github.com/fodaveg/tyrian-companion; one-off cache-first sweep)';
const API = 'https://api.guildwars2.com/v2';
const WIKI = process.env.KNOWN_SETS_WIKI_BASE ?? 'https://wiki.guildwars2.com/wiki/';
const sleep = (ms) => delay(ms);
mkdirSync(join(cache, 'wiki'), { recursive: true });

async function cachedJson(name, load) {
	const file = join(cache, name);
	if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
	const value = await load();
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${name}: the API answered no list`);
	writeFileSync(file, JSON.stringify(value));
	return value;
}
const fetchJson = async (url, headers = {}) => {
	const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
	if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
	return response.json();
};

const achievements = await cachedJson('ach-en.json', async () => {
	const ids = await fetchJson(`${API}/achievements`);
	const all = [];
	for (let i = 0; i < ids.length; i += 200) {
		all.push(...await fetchJson(`${API}/achievements?lang=en&ids=${ids.slice(i, i + 200).join(',')}`));
		await sleep(300);
	}
	return all;
});
const categories = await cachedJson('cats-en.json', () => fetchJson(`${API}/achievements/categories?ids=all&lang=en`, { 'X-Schema-Version': '2022-03-23T19:00:00.000Z' }));

const byId = new Map(achievements.map((a) => [a.id, a]));
const idOfEntry = (entry) => (typeof entry === 'number' ? entry : entry.id);
const categoryOf = new Map();
for (const category of categories) for (const entry of category.achievements) if (!categoryOf.has(idOfEntry(entry))) categoryOf.set(idOfEntry(entry), category);
const tierMax = (a) => Math.max(0, ...a.tiers.map((tier) => tier.count));
const clean = (text) => text.replace(/\s+/gu, ' ').trim();
const norm = (text) => clean(text).toLowerCase().replace(/[‘’]/gu, "'");

const nameIndex = new Map();
for (const a of achievements) {
	const key = norm(a.name);
	nameIndex.set(key, [...(nameIndex.get(key) ?? []), a.id]);
}

let lastRequest = 0;
/** Titles that answered anything but a 200 with a body in this run: asked once, never written to the cache. */
const missing = new Set();
/** Answers that say nothing about the page (429, 5xx, no network): the run cannot be trusted and exits non-zero without writing. A 404 is a real «no such page». */
const unreliable = [];
async function wikiPage(title) {
	const file = join(cache, 'wiki', `${encodeURIComponent(title).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}.txt`);
	if (missing.has(title)) return '';
	if (existsSync(file)) {
		const kept = readFileSync(file, 'utf8');
		if (kept.length > 0 && !kept.startsWith('#ERROR')) return kept;
	}
	const wait = lastRequest + 500 - Date.now();
	if (wait > 0) await sleep(wait);
	lastRequest = Date.now();
	let body = '';
	try {
		const response = await fetch(`${WIKI}${encodeURIComponent(title.replaceAll(' ', '_')).replaceAll('%28', '(').replaceAll('%29', ')').replaceAll('%27', "'").replaceAll('%3A', ':')}?action=raw`, { headers: { 'User-Agent': USER_AGENT } });
		if (response.ok) body = await response.text();
		else if (response.status !== 404) unreliable.push(`${title}: HTTP ${String(response.status)}`);
	} catch (error) {
		unreliable.push(`${title}: ${String(error)}`);
	}
	// Only a 200 with a body is kept: an error answer is not the page, and a later run asks again.
	if (body.length === 0 || body.startsWith('#ERROR')) { missing.add(title); return ''; }
	writeFileSync(file, body);
	return body;
}

/** Rows of an «Achievement table row» page: id, name and the text of the row. */
function rowsOf(body) {
	return body.split('{{Achievement table row').slice(1).flatMap((chunk) => {
		const id = /\|\s*id\s*=\s*(\d+)/u.exec(chunk);
		const name = /\|\s*name\s*=\s*(.*)/u.exec(chunk);
		return id === null ? [] : [{ id: Number(id[1]), name: name === null ? '' : clean(name[1]), text: chunk }];
	});
}

/** The visible text of a wiki line: links keep their label, templates and markup go. */
function visibleText(line) {
	return clean(line
		.replace(/\{\{[^}]*\}\}/gu, '')
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/gu, '$2')
		.replace(/\[\[([^\]#]*#)?([^\]]*)\]\]/gu, '$2')
		.replace(/'''?/gu, '').replace(/<[^>]*>/gu, '').replace(/&nbsp;/gu, ' '));
}

/**
 * Metas whose bar counts something other than achievements. Measured 10 oct 2026: 223 «The Emperor's New Wardrobe»
 * asks 90 = 5 specialty armors x 18 pieces; the wiki has no row for it. Its contributors are the five «Specialty
 * Armors» achievements (93 to 97, 18 pieces each); the other two of its category (1567 «Fashion Forward», 3935
 * «Lunatic's Fashion») count something else and stay out.
 */
const BAR_UNITS = new Map([[223, { unit: 'pieces', members: [93, 94, 95, 96, 97] }]]);
const metas = achievements.filter((a) => (a.bits ?? []).length === 0 && a.flags.includes('CategoryDisplay'));
const sets = [];
/** Ids the wiki names by anchor that the API does not serve. */
const unserved = new Set();
const report = [];
const counts = { metas: metas.length, emitted: 0, same: 0, unresolved: 0, unservedIds: 0 };

for (const meta of metas) {
	const category = categoryOf.get(meta.id) ?? null;
	const apiMembers = category === null ? [] : category.achievements.map(idOfEntry).filter((id) => id !== meta.id);
	const unit = BAR_UNITS.get(meta.id);
	if (unit !== undefined) { sets.push({ meta, members: unit.members, wikiAll: false, barUnit: unit.unit }); counts.emitted += 1; continue; }
	const titles = [];
	if (category !== null) titles.push(`${clean(category.name)} (achievements)`, clean(category.name));
	titles.push(`${meta.name} (achievements)`, meta.name);
	let page = null;
	let row = null;
	for (const title of titles) {
		const body = await wikiPage(title);
		const rows = rowsOf(body);
		const found = rows.find((candidate) => candidate.id === meta.id);
		if (found !== undefined) { page = { title, rows }; row = found; break; }
	}
	const head = `${String(meta.id)} ${meta.name} (bar ${String(tierMax(meta))}, API category ${category === null ? 'none' : String(apiMembers.length)})`;
	if (row === null) { counts.unresolved += 1; report.push(`${head}: no wiki row`); continue; }
	const objectives = /\|\s*objectives\s*=([\s\S]*?)(?=\n\|\s*[a-z][a-z ]*=|\n\}\}|$)/u.exec(row.text);
	if (objectives === null) { counts.unresolved += 1; report.push(`${head}: wiki row (${page.title}) has no objectives`); continue; }
	const lines = objectives[1].split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
	const pageNames = new Map();
	for (const candidate of page.rows) pageNames.set(norm(candidate.name), [...(pageNames.get(norm(candidate.name)) ?? []), candidate.id]);
	const members = [];
	const missed = [];
	for (const line of lines) {
		const anchor = /#achievement(\d+)/u.exec(line);
		let id = anchor !== null && byId.has(Number(anchor[1])) ? Number(anchor[1]) : null;
		if (id === null) {
			const key = norm(visibleText(line));
			const pick = (candidates) => {
				const known = [...new Set(candidates ?? [])].filter((candidate) => byId.has(candidate));
				if (known.length === 1) return known[0];
				const inCategory = known.filter((candidate) => apiMembers.includes(candidate));
				return inCategory.length === 1 ? inCategory[0] : null;
			};
			id = pick(pageNames.get(key)) ?? pick(nameIndex.get(key));
		}
		// The wiki names it by an explicit achievement anchor and the API does not serve it (hidden, retired or not yet
		// published): it still counts for the meta, shown by id.
		if (id === null && anchor !== null) { id = Number(anchor[1]); unserved.add(id); }
		if (id === null) missed.push(line); else if (id !== meta.id && !members.includes(id)) members.push(id);
	}
	if (missed.length > 0) { counts.unresolved += 1; report.push(`${head}: ${String(missed.length)} of ${String(lines.length)} wiki lines match no API id, e.g. ${JSON.stringify(missed[0].slice(0, 80))}`); continue; }
	if (members.length < tierMax(meta)) { counts.unresolved += 1; report.push(`${head}: the wiki lists ${String(members.length)}, fewer than the bar`); continue; }
	if (members.length === apiMembers.length && members.every((id) => apiMembers.includes(id))) { counts.same += 1; continue; }
	const description = /\|\s*description\s*=(.*)/u.exec(row.text);
	// «Complete all 24 Return meta-achievements»: the wiki says the bar is the whole list.
	const all = description === null ? null : /complete all (?:the )?(\d+)/iu.exec(description[1]);
	const wikiAll = all !== null && Number(all[1]) === tierMax(meta) && members.length === tierMax(meta);
	if (all !== null && !wikiAll) report.push(`${head}: NOTE the wiki says «complete all ${all[1]}» but its objectives list ${String(members.length)}; the list is used`);
	sets.push({ meta, members, wikiAll, page: page.title });
	counts.emitted += 1;
}

counts.unservedIds = new Set(sets.flatMap((set) => set.members.filter((id) => unserved.has(id)))).size;
const q = (text) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const wrapIds = (ids) => {
	const rows = [];
	for (let i = 0; i < ids.length; i += 12) rows.push(`\t\t\t${ids.slice(i, i + 12).join(', ')},`);
	return rows.join('\n');
};
const moduleText = `/**
 * Metas whose elements the public API does not give, or gives wrongly: the achievements that count towards each
 * are fixed DATA taken from the official wiki, like \`leyspring-set.ts\`. The plugin never requests the wiki
 * (\`docs/PLATFORM_POLICY.md\`); a set is only a list of ids that the «Logros» section reads as the elements of
 * the followed meta (\`tracked-achievements-model.ts\`), with the same checks, links and progress as the
 * elements of a category. A meta with a known set uses it before the category rule.
 *
 * GENERATED by \`scripts/generate-known-achievement-sets.mjs\` (do not edit by hand; regenerate). Source: the
 * \`objectives\` of the row of each meta on the achievement pages of https://wiki.guildwars2.com/ (\`?action=raw\`,
 * read on ${date}), each line crossed with \`/v2/achievements\` (en) by its \`#achievement<id>\` anchor or, when the
 * line is only a name, by that name on the same page. ${String(counts.metas)} metas have \`CategoryDisplay\` and no bits:
 * ${String(counts.emitted)} are here (the wiki's list differs from the API category's, or the API has no category), ${String(counts.same)}
 * need nothing (the wiki's list is the category's), ${String(counts.unresolved)} the wiki does not settle (the category rule applies).
 * A wiki id the API does not serve is replaced by the API's achievement of the same name (e.g. «Return to Siren's
 * Landing»: the wiki says 9991, the API serves 5748); when no name matches it is kept by id (${String(counts.unservedIds)} ids: hidden,
 * retired or not yet published achievements).
 */

/** What a bar counts when it is not achievements: each element of the list contributes several. */
export type KnownBarUnit = 'pieces';

export interface KnownAchievementSet {
	/** The meta achievement. */
	readonly meta: number;
	/** The meta's name in the API (en). */
	readonly name: string;
	/** The meta's last tier: what its bar counts up to. */
	readonly tierMax: number;
	/** The wiki says «Complete all N» with N equal to the bar: the set is exactly what the bar counts. */
	readonly wikiAll: boolean;
	/** Set when the bar counts something else than achievements (pieces): the list is short of the bar on purpose. */
	readonly barUnit?: KnownBarUnit;
	/** The achievements that count, in the wiki's order. */
	readonly members: readonly number[];
}

export const KNOWN_ACHIEVEMENT_SETS: readonly KnownAchievementSet[] = [
${sets.map((set) => `\t{\n\t\tmeta: ${String(set.meta.id)}, name: ${q(set.meta.name)}, tierMax: ${String(tierMax(set.meta))}, wikiAll: ${String(set.wikiAll)},${set.barUnit === undefined ? '' : ` barUnit: ${q(set.barUnit)},`}\n\t\tmembers: [\n${wrapIds(set.members)}\n\t\t],\n\t},`).join('\n')}
];

const BY_META: ReadonlyMap<number, readonly number[]> = new Map(KNOWN_ACHIEVEMENT_SETS.map((set) => [set.meta, set.members]));

/** What the bar of the meta \`id\` counts when it is not achievements; null otherwise. */
export function knownBarUnitOf(id: number): KnownBarUnit | null {
	return KNOWN_ACHIEVEMENT_SETS.find((set) => set.meta === id)?.barUnit ?? null;
}

/** The ids that count towards the meta \`id\`, in the wiki's order; null when there is no known set for it. */
export function knownSetMembersOf(id: number): number[] | null {
	const members = BY_META.get(id);
	return members === undefined ? null : [...members];
}
`;
if (unreliable.length > 0) {
	console.error(`${String(unreliable.length)} wiki requests got neither a page nor a 404 (rate limit, server error or network); nothing was written. First: ${unreliable[0]}`);
	process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, moduleText);

if (idsOut !== null) {
	const wanted = [...new Set(sets.flatMap((set) => [set.meta.id, ...set.members]))].sort((a, b) => a - b);
	const rows = wanted.map((id) => `\t[${String(id)}, ${byId.has(id) ? String(tierMax(byId.get(id))) : 'null'}],`).join('\n');
	writeFileSync(idsOut, `/**
 * Every achievement id that \`known-achievement-sets.ts\` mentions (the metas and their members) with its last
 * tier, as the API served them on ${date} (null: the wiki names it by anchor and the API does not serve it). GENERATED together with that module by
 * \`scripts/generate-known-achievement-sets.mjs --ids-out\`. Only tests import this file.
 */
export const KNOWN_SETS_API_SNAPSHOT: ReadonlyMap<number, number | null> = new Map([
${rows}
]);
`);
}

const summary = `known sets: ${JSON.stringify(counts)}\n${report.join('\n')}\n`;
if (args.has('report')) writeFileSync(resolve(args.get('report')), summary); else process.stdout.write(summary);
