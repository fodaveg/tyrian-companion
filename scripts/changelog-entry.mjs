// H14.18: the release workflow used to publish every tag with the same fixed
// sentence as its GitHub Release body (`release.yml`, "Tyrian Companion
// ${TAG}. Assets: ..."), which repeats a version number that already lives in
// `manifest.json` and tells a reader nothing about what changed. This reads
// the real per-release section out of `docs/CHANGELOG.md` instead, so the
// release notes are the same prose a human reads in the changelog.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class ChangelogEntryError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
		this.name = 'ChangelogEntryError';
	}
}

const HEADING_RE = /^## Release beta (\S+)(?: - (.*))?$/gmu;

/**
 * @param {string} changelog raw contents of `docs/CHANGELOG.md`
 * @param {string} version exact `manifest.json` version, e.g. `0.1.30`
 * @returns {{ subtitle: string | null; body: string }}
 */
export function extractChangelogEntry(changelog, version) {
	if (typeof version !== 'string' || version.length === 0) throw new ChangelogEntryError('invalid-version');
	const headings = [...changelog.matchAll(HEADING_RE)];
	const index = headings.findIndex((match) => match[1] === version);
	if (index === -1) throw new ChangelogEntryError('version-not-found');
	const match = headings[index];
	const start = match.index + match[0].length;
	const end = index + 1 < headings.length ? headings[index + 1].index : changelog.length;
	const body = changelog.slice(start, end).trim();
	if (body.length === 0) throw new ChangelogEntryError('empty-entry');
	return { subtitle: match[2] ?? null, body };
}

/** Renders the notes text handed to `gh release create --notes`. */
export function renderReleaseNotes(entry) {
	const heading = entry.subtitle === null ? '' : `**${entry.subtitle}**\n\n`;
	return `${heading}${entry.body}`;
}

async function main() {
	const version = process.argv[2];
	if (!version) {
		process.stderr.write('usage: node scripts/changelog-entry.mjs <version>\n');
		process.exitCode = 1;
		return;
	}
	const changelogPath = resolve(process.cwd(), 'docs/CHANGELOG.md');
	let entry;
	try {
		entry = extractChangelogEntry(readFileSync(changelogPath, 'utf8'), version);
	} catch (error) {
		if (error instanceof ChangelogEntryError) {
			process.stderr.write(`changelog-entry: ${error.code} for version ${version}\n`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
	process.stdout.write(`${renderReleaseNotes(entry)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
