import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createJiti } from '/home/fodaveg/code/tyrian-companion/node_modules/jiti/lib/jiti.mjs';

const candidate = '875eb05869799d5cbc939e1c3b183a3e8260ceef';
const root = '/home/fodaveg/code/tyrian-companion/.claude/worktrees/h18-29-evidence-20261002';
const source = '/home/fodaveg/Documentos/fodaveg/40-49 Aficiones y creación/42 Guild Wars 2/42.31 Datos de cuenta de Guild Wars 2/sessions/2026';
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { SessionHistoryService, inspectDurableSessionNote } = await jiti.import(join(root, 'src/sessions/session-history.ts'));
const { buildSessionHistoryAggregate } = await jiti.import(join(root, 'src/sessions/session-history-summary.ts'));
const { inspectStoredSessionNote } = await jiti.import(join(root, 'src/sessions/session-note-renderer.ts'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const files = [];
async function discover(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name);
    if (item.isDirectory()) await discover(path);
    else if (item.isFile() && item.name.endsWith('.md')) files.push({ path });
  }
}
await discover(source);
files.sort((a, b) => a.path.localeCompare(b.path));
assert.equal(files.length, 29, 'Expected exactly 29 canonical Markdown notes');
let mutations = 0;
const deny = async () => { mutations += 1; throw new Error('Read-only evidence port prohibits mutation'); };
const contents = new Map();
for (const file of files) contents.set(file.path, await readFile(file.path, 'utf8'));
const port = {
  markdownFiles: () => files,
  exists: (path) => contents.has(path),
  file: (path) => contents.has(path) ? { path } : null,
  read: async (file) => { assert(contents.has(file.path)); return contents.get(file.path); },
  process: deny, createFolder: deny, create: deny,
};
const scan = await new SessionHistoryService(port).scan();
if (scan.status !== 'ok') {
  const inspections = [];
  for (const file of files) {
    const inspected = await inspectDurableSessionNote(contents.get(file.path));
    inspections.push({ noteName: basename(file.path), contentSha256: sha256(contents.get(file.path)), status: inspected.status });
  }
  await writeFile('/tmp/tyrian-h18-29-probe/conflict.json', JSON.stringify({ candidate, scan, inspections }, null, 2) + '\n');
  console.log(JSON.stringify({ scan, inspections }, null, 2));
}
assert.deepEqual(scan, { status: 'conflict', invalid: 1, duplicates: 0 }, 'Full supplied corpus is blocked by one invalid note');
const perNote = [];
const validSessions = [];
const invalidNotes = [];
for (const file of files) {
  const content = contents.get(file.path);
  const result = await inspectDurableSessionNote(content);
  if (result.status !== 'ok') {
    const stored = await inspectStoredSessionNote(content);
    const fm = stored?.frontmatter ?? {};
    const blocks = [...content.matchAll(/<!-- tyrian-companion:managed:start:([a-z_]+) sha256=([a-f0-9]+) -->\n([\s\S]*?)\n<!-- tyrian-companion:managed:end:\1 -->/gu)]
      .map((match) => ({ block: match[1], expectedHash: match[2], observedHash: sha256(match[3]), hashMatches: sha256(match[3]) === match[2] }));
    const clampImmediate = content.replace(/^tc_observed_immediate_copper:.*$/mu, 'tc_observed_immediate_copper: 0');
    const clampListing = content.replace(/^tc_observed_listing_copper:.*$/mu, 'tc_observed_listing_copper: 0');
    const clampBoth = clampImmediate.replace(/^tc_observed_listing_copper:.*$/mu, 'tc_observed_listing_copper: 0');
    const controls = { immediateOnly: (await inspectDurableSessionNote(clampImmediate)).status,
      listingOnly: (await inspectDurableSessionNote(clampListing)).status,
      both: (await inspectDurableSessionNote(clampBoth)).status };
    assert.deepEqual(controls, { immediateOnly: 'invalid', listingOnly: 'invalid', both: 'ok' });
    invalidNotes.push({ noteName: basename(file.path), contentSha256: sha256(content), status: result.status,
      storedParseSucceeded: stored !== null, managedBlocksValid: stored?.managedBlocksValid, hasInvalidScalar: stored?.hasInvalidScalar,
      tcKeys: Object.keys(fm).filter((key) => key.startsWith('tc_')), blocks,
      metadataChecks: { sessionIdentityFormatValid: /^[a-f0-9]{64}$/u.test(fm.tc_session_ref), accountIdentityFormatValid: /^[a-f0-9]{64}$/u.test(fm.tc_account_ref),
        durationConsistent: Date.parse(fm.tc_ended_at) - Date.parse(fm.tc_started_at) === fm.tc_duration_ms,
        characterIsString: typeof fm.tc_character === 'string', professionIsString: typeof fm.tc_profession === 'string',
        buildIsNullableString: fm.tc_build === null || typeof fm.tc_build === 'string' },
      metadataValues: Object.fromEntries(Object.entries(fm).filter(([key]) => !['tc_session_ref', 'tc_account_ref', 'tc_character', 'tc_profession', 'tc_build', 'tc_positive_item_deltas_json'].includes(key))),
      isolatedCause: 'validValuationMetadata rejects negative observed monetary values through safeNonNegative',
      diagnosticMemoryOnlyControls: controls,
      safeMetadata: Object.fromEntries(['tc_schema', 'tc_kind', 'tc_started_at', 'tc_ended_at', 'tc_duration_ms', 'tc_unobserved_ms', 'tc_classification', 'tc_confidence', 'tc_valuation_coverage', 'tc_outcome'].map((key) => [key, fm[key] ?? null])) });
    continue;
  }
  validSessions.push(result.session);
  const session = result.session;
  perNote.push({ noteName: basename(file.path), contentSha256: sha256(content), schema: result.evidence.schema,
    startedAt: session.startedAt, endedAt: session.endedAt, durationMs: session.durationMs,
    classification: session.classification, confidence: session.confidence, valuationCoverage: session.valuationCoverage,
    outcome: session.outcome, sacks: session.sacks, immediateCopper: session.observedImmediateCopper,
    listingCopper: session.observedListingCopper, sacksPerHourMilli: session.sacksPerHourMilli,
    immediateCopperPerHour: session.immediateCopperPerHour, listingCopperPerHour: session.listingCopperPerHour,
    lootRowCount: session.lootRows.length });
}
const aggregate = buildSessionHistoryAggregate(validSessions);
assert.equal(aggregate.sessionCount, 28);
const recentFiles = [...files].sort((a,b) => b.path.localeCompare(a.path)).slice(0, 7);
const recentScan = await new SessionHistoryService({ ...port, markdownFiles: () => recentFiles }).scan();
assert.equal(recentScan.status, 'ok');
assert.equal(recentScan.sessions.length, 7);
const recentAggregate = buildSessionHistoryAggregate(recentScan.sessions);
const measured = validSessions.filter((session) => session.outcome !== 'abandoned')
  .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || b.startedAt.localeCompare(a.startedAt));
assert.equal(aggregate.comparison.latestEndedAt, measured[0].endedAt);
assert.equal(aggregate.comparison.previousEndedAt, measured[1].endedAt);
assert.equal(aggregate.comparison.durationDeltaMs, measured[0].durationMs - measured[1].durationMs);
const delta = (field) => measured[0][field] === null || measured[1][field] === null ? null : measured[0][field] - measured[1][field];
assert.equal(aggregate.comparison.sacksPerHourMilliDelta, delta('sacksPerHourMilli'));
assert.equal(aggregate.comparison.immediateCopperPerHourDelta, delta('immediateCopperPerHour'));
assert.equal(aggregate.comparison.listingCopperPerHourDelta, delta('listingCopperPerHour'));
for (const group of aggregate.performance.groups) {
  const matching = validSessions.filter((session) => session.outcome !== 'abandoned' &&
    (session.activity === 'halloween' ? 'halloween' : 'general') === group.activity &&
    session.build?.trim() === group.build &&
    (group.quality === 'exact' ? session.classification === 'exact' && session.confidence === 'high' : session.classification === 'estimated'));
  assert.equal(group.sessionCount, matching.length, 'Quality buckets must preserve real-session membership');
}
const first = files[0];
const valid = contents.get(first.path);
const corrupt = valid.replace(/^tc_duration_ms:.*$/mu, 'tc_duration_ms: -1');
assert.notEqual(corrupt, valid, 'Corruption must change the in-memory note');
const negative = await new SessionHistoryService({ ...port, markdownFiles: () => [first], read: async () => corrupt }).scan();
assert.deepEqual(negative, { status: 'conflict', invalid: 1, duplicates: 0 });
for (const file of files) assert.equal(sha256(await readFile(file.path, 'utf8')), sha256(contents.get(file.path)), 'Source content must remain unchanged');
assert.equal(mutations, 0);
const countsBy = (field) => perNote.reduce((counts, row) => { const key = String(row[field]); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
const missingMetrics = Object.fromEntries(['sacks', 'immediateCopper', 'listingCopper', 'sacksPerHourMilli', 'immediateCopperPerHour', 'listingCopperPerHour'].map((field) => [field, perNote.filter((row) => row[field] === null).length]));
const { sessions: omittedRows, ...aggregateWithoutLoot } = aggregate;
const report = { candidate, version: '0.2.17', generatedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version },
  sourceScope: 'canonical sessions/2026 subtree; exactly 29 Markdown notes',
  scan, validNoteCount: validSessions.length, invalidNotes,
  recentSeven: { scan: { status: recentScan.status, sessionCount: recentScan.sessions.length, ignored: recentScan.ignored },
    comparison: recentAggregate.comparison, performance: recentAggregate.performance },
  classifications: countsBy('classification'), confidences: countsBy('confidence'), valuationCoverage: countsBy('valuationCoverage'), schemas: countsBy('schema'),
  missingMetrics, atLeast60Minutes: perNote.filter((row) => row.durationMs >= 3600000),
  atLeast60MinutesAllNotes: [...perNote.map((row) => ({ noteName: row.noteName, startedAt: row.startedAt, endedAt: row.endedAt, durationMs: row.durationMs, status: 'ok' })),
    ...invalidNotes.map((row) => ({ noteName: row.noteName, startedAt: row.safeMetadata.tc_started_at, endedAt: row.safeMetadata.tc_ended_at, durationMs: row.safeMetadata.tc_duration_ms, status: row.status }))].filter((row) => row.durationMs >= 3600000), aggregate: aggregateWithoutLoot,
  latestTwo: perNote.sort((a,b) => b.endedAt.localeCompare(a.endedAt) || b.startedAt.localeCompare(a.startedAt)).slice(0, 2),
  notes: perNote, aggregateScope: 'Exploratory aggregation of 28 individually validated notes; the consumer scan of all 29 returns conflict and exposes no sessions.', negativeControl: { mutation: 'tc_duration_ms = -1 in memory only; single valid source note', result: negative },
  invariants: { sourceHashesUnchanged: true, writeAttempts: mutations, latestTwoComparisonChecked: true, qualityMembershipChecked: true },
  limitations: ['No real Obsidian or BRAT UI was observed.', 'Read-only port covers the supplied 29-note subtree, not the entire vault.', 'Saved metrics are validated and aggregated, not recalculated from a live GW2 account.'] };
const serialized = JSON.stringify(report, null, 2) + '\n';
for (const forbidden of ['accountRef', 'sessionRef']) assert.equal(serialized.includes(forbidden), false);
await writeFile('/tmp/tyrian-h18-29-probe/evidence.json', serialized, 'utf8');
console.log(JSON.stringify({ candidate, scan: report.scan, invalidNotes, recentSeven: report.recentSeven, classifications: report.classifications, missingMetrics, performance: report.aggregate.performance, comparison: report.aggregate.comparison, longSessions: report.atLeast60Minutes.length, negativeControl: negative, sourceHashesUnchanged: true, writeAttempts: mutations, evidence: '/tmp/tyrian-h18-29-probe/evidence.json' }, null, 2));
