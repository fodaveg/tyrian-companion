import { describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { LocalDebugLogger } from '../core/local-debug-logger';
import type { LocalDebugRecordInput } from '../core/local-debug-contract';
import { SESSION_NOTE_BLOCK_IDS } from './session-note-model';
import { renderAbandonedSessionNote, sha256Text } from './session-note-renderer';
import { inspectDurableSessionNote } from './session-history';
import { buildSessionHistoryAggregate } from './session-history-summary';
import type { AbandonedSessionState } from './session';
import { renderCollectorStatusNote } from '../runtime/collector-status';
import { WalletVaultSyncService, type WalletVaultPort } from '../wallet/wallet-vault-sync';
import {
	SESSION_HISTORY_CSV_FILE,
	SESSION_HISTORY_JSON_FILE,
	SessionHistoryRuntimeAuthority,
	SessionHistoryService,
	canScrubSessionHistory,
	serializeCsvCell,
	type SessionHistoryFile,
	type SessionHistoryNoteChange,
	type SessionHistoryVault,
} from './session-history';

describe('durable session history', () => {
	const scrubGate = { sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed' } as const;
	const idleAuthority = () => new SessionHistoryRuntimeAuthority(() => scrubGate);

	it('derives legacy bag comparison only from explicit positive 36038 deltas, independently of prices', async () => {
		const legacy = async (quantity: number | null, day: number, positiveDeltasJson?: string) => {
			const inspected = await inspectDurableSessionNote(await note({ tc_schema: 6, tc_build: 'legacy farm',
				tc_started_at: `2026-10-0${String(day)}T08:00:00.000Z`, tc_ended_at: `2026-10-0${String(day)}T09:00:00.000Z`,
				tc_classification: 'estimated', tc_confidence: 'medium', tc_valuation_coverage: 'partial', tc_sacks: 0,
				tc_sacks_per_hour_milli: null, tc_immediate_copper_per_hour: null, tc_listing_copper_per_hour: null,
				tc_positive_item_deltas_json: positiveDeltasJson ?? (quantity === null ? '[]' : JSON.stringify([[36038, quantity]])),
			}));
			expect(inspected.status).toBe('ok');
			if (inspected.status !== 'ok') throw new Error('Invalid legacy fixture');
			return inspected.session;
		};
		const observed = buildSessionHistoryAggregate([await legacy(100, 1), await legacy(100, 2)]);
		expect(observed.performance.groups[0]).toMatchObject({ sackBasis: 'legacy_positive_net', sacksPerHourMilli: 100_000,
			immediateCopperPerHour: null, sacksMetric: { eligibleSessions: 2, durationMs: 7_200_000 } });
		const absent = buildSessionHistoryAggregate([await legacy(null, 1), await legacy(null, 2)]);
		expect(absent.performance.groups[0]).toMatchObject({ sackBasis: 'unavailable', sacksPerHourMilli: null,
			sacksMetric: { eligibleSessions: 0 } });
		const unrelated = buildSessionHistoryAggregate([await legacy(null, 1, '[[36041,100]]'), await legacy(null, 2, '[[36041,100]]')]);
		expect(unrelated.performance.groups[0]?.sacksPerHourMilli).toBeNull();
		const fiveHundred = buildSessionHistoryAggregate([await legacy(500, 1), await legacy(500, 2)]);
		expect(fiveHundred.performance.groups[0]?.sacksPerHourMilli).toBe(500_000);
	});

	it('rejects malformed optional comparison metadata while retaining legacy schema 6 notes', async () => {
		expect((await inspectDurableSessionNote(await note({ tc_schema: 6 }))).status).toBe('ok');
		expect((await inspectDurableSessionNote(await note({ tc_schema: 6, tc_comparison_json: '{}' }))).status).toBe('invalid');
		expect((await inspectDurableSessionNote(await note({ tc_schema: 6, tc_sack_observation_json: '{"itemId":42}' }))).status).toBe('invalid');
	});

	it('keeps the future scrub gate closed around every runtime, recovery, detector, and completed state', () => {
		expect(canScrubSessionHistory({ sessionStatus: 'idle', recoveryPending: false, detectorStatus: 'disarmed' })).toBe(true);
		for (const gate of [
			{ sessionStatus: 'active', recoveryPending: false, detectorStatus: 'disarmed' },
			{ sessionStatus: 'complete', recoveryPending: false, detectorStatus: 'disarmed' },
			{ sessionStatus: 'idle', recoveryPending: true, detectorStatus: 'disarmed' },
			{ sessionStatus: 'idle', recoveryPending: false, detectorStatus: 'armed' },
		]) expect(canScrubSessionHistory(gate)).toBe(false);
		for (const sessionStatus of ['starting', 'active', 'stopping', 'provisional', 'error', 'complete']) {
			expect(canScrubSessionHistory({ ...scrubGate, sessionStatus })).toBe(false);
		}
		for (const recoveryStatus of ['available', 'busy', 'working', 'error']) {
			expect(canScrubSessionHistory({ ...scrubGate, recoveryStatus })).toBe(false);
		}
		expect(canScrubSessionHistory({ ...scrubGate, detectorStatus: 'start_proposed' })).toBe(false);
	});

	it('shares mutual exclusion between runtime transitions and a scrub lease', () => {
		const authority = idleAuthority();
		const runtime = authority.acquireRuntimeMutation();
		expect(runtime).not.toBeNull();
		expect(authority.acquireScrub()).toBeNull();
		runtime?.release();
		const scrub = authority.acquireScrub();
		expect(scrub).not.toBeNull();
		expect(authority.acquireRuntimeMutation()).toBeNull();
		scrub?.release();
		const after = authority.acquireRuntimeMutation();
		expect(after).not.toBeNull();
		after?.release();
	});

	// H15.15 (2026-09-10 incident): every catch here already had its own closed status to
	// return, so a real Vault rejection (not just an unparseable note) never reached the local
	// debug log at all, including during startup recovery's `readSession` lookup.
	it('registers a vault_read failure when a markdown file cannot be read', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const actions = new LocalDebugActionRunner({ diagnostics, createId: () => 'session-history-read' });
		const brokenVault: SessionHistoryVault = {
			markdownFiles: () => [{ path: 'Sessions/broken.md' }],
			exists: () => true,
			file: (path) => ({ path }),
			read: async () => { throw Object.assign(new Error('disk unavailable'), { name: 'EIO' }); },
			process: async () => undefined,
			createFolder: async () => undefined,
			create: async (path) => ({ path }),
		};
		const history = new SessionHistoryService(brokenVault, actions);

		await expect(history.readSession('a'.repeat(64))).resolves.toEqual({ status: 'unavailable' });

		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'vault' && input.action === 'vault_read' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'storage_failure', state: 'read_session' });
	});

	it('uses an opaque preview token to scrub only tc metadata and six validated blocks', async () => {
		const vault = new MemoryVault();
		const source = (await note()).replace('tc_schema: 2', 'descripcion: "Conservar"\ntags: ["humana"]\ntc_schema: 2')
			.replace('Human body must stay private', 'Mi texto humano permanece.');
		vault.contents.set('Sessions/one.md', source);
		const history = new SessionHistoryService(vault);
		const authority = idleAuthority();
		const concurrent = new SessionHistoryService(vault);
		const concurrentAuthority = idleAuthority();
		const preview = await history.previewScrub(authority);
		const concurrentPreview = await concurrent.previewScrub(concurrentAuthority);
		expect(preview).toMatchObject({ status: 'ready', sessions: 1 });
		if (preview.status !== 'ready') throw new Error('Expected scrub preview.');
		if (concurrentPreview.status !== 'ready') throw new Error('Expected concurrent scrub preview.');
		expect(preview.token).not.toContain('Sessions/one.md');
		await expect(history.scrub(preview.token, authority)).resolves.toEqual({ status: 'erased', erased: 1, alreadyAbsent: 0 });
		const scrubbed = vault.contents.get('Sessions/one.md')!;
		expect(scrubbed).toContain('descripcion: "Conservar"');
		expect(scrubbed).toContain('tags: ["humana"]');
		expect(scrubbed).toContain('Mi texto humano permanece.');
		expect(scrubbed).not.toMatch(/(?:^|\n)tc_/u);
		expect(scrubbed).not.toContain('tyrian-companion:managed:');
		await expect(concurrent.scrub(concurrentPreview.token, concurrentAuthority)).resolves.toEqual({ status: 'already_absent', erased: 0, alreadyAbsent: 1 });
		await expect(history.scrub(preview.token, authority)).resolves.toMatchObject({ status: 'stale' });
	});

	it('does not count an erasure the host discarded when it re-runs the update after a stale base', async () => {
		const vault = new MemoryVault();
		const source = await note();
		vault.contents.set('Sessions/one.md', source);
		const history = new SessionHistoryService(vault);
		const authority = idleAuthority();
		const preview = await history.previewScrub(authority);
		if (preview.status !== 'ready') throw new Error('Expected scrub preview.');
		const edited = source.replace('Human body must stay private', 'edited between the two runs');
		vault.staleOnce = (path) => { vault.contents.set(path, edited); };

		// A latched `erased` from the discarded first run reported an erasure that never happened.
		await expect(history.scrub(preview.token, authority)).resolves.toMatchObject({ status: 'conflict', erased: 0 });
		expect(vault.contents.get('Sessions/one.md')).toBe(edited);
	});

	it('rejects an unknown or expired preview capability as stale without vault mutation', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		const history = new SessionHistoryService(vault);

		await expect(history.scrub('not-a-preview-capability', idleAuthority())).resolves.toEqual({
			status: 'stale', erased: 0, alreadyAbsent: 0, message: 'The scrub preview is no longer valid.',
		});
		expect(vault.processes).toBe(0);
	});

	it('revokes preview capabilities on cancel, replacement, success, and dispose', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		const history = new SessionHistoryService(vault);
		const authority = idleAuthority();
		const cancelled = await history.previewScrub(authority);
		if (cancelled.status !== 'ready') throw new Error('Expected cancel preview.');
		history.revokeScrub(cancelled.token);
		await expect(history.scrub(cancelled.token, authority)).resolves.toMatchObject({ status: 'stale' });
		const abandoned = await history.previewScrub(authority);
		const replacement = await history.previewScrub(authority);
		if (abandoned.status !== 'ready' || replacement.status !== 'ready') throw new Error('Expected replacement previews.');
		await expect(history.scrub(abandoned.token, authority)).resolves.toMatchObject({ status: 'stale' });
		await expect(history.scrub(replacement.token, authority)).resolves.toMatchObject({ status: 'erased' });
		await expect(history.scrub(replacement.token, authority)).resolves.toMatchObject({ status: 'stale' });
		const disposableVault = new MemoryVault();
		disposableVault.contents.set('Sessions/two.md', await note());
		const disposable = new SessionHistoryService(disposableVault);
		const disposed = await disposable.previewScrub(authority);
		if (disposed.status !== 'ready') throw new Error('Expected disposable preview.');
		disposable.dispose();
		await expect(disposable.scrub(disposed.token, authority)).resolves.toMatchObject({ status: 'stale' });
	});

	it.each(['deleted', 'renamed'] as const)('treats a %s target after preview as conflict, never already_absent', async (change) => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		const history = new SessionHistoryService(vault);
		const authority = idleAuthority();
		const preview = await history.previewScrub(authority);
		if (preview.status !== 'ready') throw new Error('Expected scrub preview.');
		const content = vault.contents.get('Sessions/one.md')!;
		vault.contents.delete('Sessions/one.md');
		if (change === 'renamed') vault.contents.set('Sessions/renamed.md', content);

		await expect(history.scrub(preview.token, authority)).resolves.toMatchObject({
			status: 'conflict', erased: 0, alreadyAbsent: 0,
		});
		expect(vault.processes).toBe(0);
	});

	it('holds shared runtime exclusion during Vault.process and revalidates live state before every following write', async () => {
		const vault = new MemoryVault();
		const first = await note();
		const second = first.replace('tc_session_ref: "'.concat('a'.repeat(64), '"'), 'tc_session_ref: "'.concat('c'.repeat(64), '"'));
		vault.contents.set('Sessions/one.md', first);
		vault.contents.set('Sessions/two.md', second);
		let gate: { sessionStatus: string; recoveryStatus: string; detectorStatus: string } = { ...scrubGate };
		const authority = new SessionHistoryRuntimeAuthority(() => gate);
		const history = new SessionHistoryService(vault);
		const preview = await history.previewScrub(authority);
		if (preview.status !== 'ready') throw new Error('Expected scrub preview.');
		let mutationWasExcluded = false;
		vault.beforeProcess = async () => { mutationWasExcluded = !authority.runtimeMutationAllowed(); };
		vault.afterProcess = async (path) => { if (path === 'Sessions/one.md') gate = { ...gate, sessionStatus: 'active' }; };

		await expect(history.scrub(preview.token, authority)).resolves.toEqual({
			status: 'blocked', erased: 1, alreadyAbsent: 0,
			message: 'Session runtime, recovery, or detector is not idle.',
		});
		expect(mutationWasExcluded).toBe(true);
		expect(vault.processes).toBe(1);
		expect(authority.runtimeMutationAllowed()).toBe(true);
	});

	it('fails closed on CAS edits and tampered managed blocks without overwriting either', async () => {
		const vault = new MemoryVault();
		const source = await note();
		vault.contents.set('Sessions/one.md', source);
		const history = new SessionHistoryService(vault);
		const authority = idleAuthority();
		const preview = await history.previewScrub(authority);
		if (preview.status !== 'ready') throw new Error('Expected scrub preview.');
		vault.beforeProcess = async () => { vault.contents.set('Sessions/one.md', source.replace('Human body must stay private', 'edited after preview')); };
		await expect(history.scrub(preview.token, authority)).resolves.toMatchObject({ status: 'conflict', erased: 0 });
		expect(vault.contents.get('Sessions/one.md')).toContain('edited after preview');
		const tampered = new MemoryVault();
		tampered.contents.set('Sessions/tampered.md', source.replace('summary content', 'tampered summary'));
		await expect(new SessionHistoryService(tampered).previewScrub(idleAuthority())).resolves.toMatchObject({ status: 'conflict' });
		expect(tampered.processes).toBe(0);
	});

	it('is partial-safe and retries a preserved preview plan without physical deletion', async () => {
		const vault = new MemoryVault();
		const first = await note();
		const second = (await note()).replace('tc_session_ref: "'.concat('a'.repeat(64), '"'), 'tc_session_ref: "'.concat('c'.repeat(64), '"'));
		vault.contents.set('Sessions/one.md', first);
		vault.contents.set('Sessions/two.md', second);
		const history = new SessionHistoryService(vault);
		const authority = idleAuthority();
		const preview = await history.previewScrub(authority);
		if (preview.status !== 'ready') throw new Error('Expected scrub preview.');
		vault.beforeProcess = async (path) => {
			if (path === 'Sessions/two.md') vault.contents.set(path, second.replace('Human body must stay private', 'concurrent human edit'));
		};
		await expect(history.scrub(preview.token, authority)).resolves.toMatchObject({ status: 'conflict', erased: 1, alreadyAbsent: 0 });
		expect(vault.contents.get('Sessions/one.md')).toBeDefined();
		vault.beforeProcess = null;
		vault.contents.set('Sessions/two.md', second);
		await expect(history.scrub(preview.token, authority)).resolves.toMatchObject({ status: 'stale' });
		const retry = await history.previewScrub(authority);
		if (retry.status !== 'ready') throw new Error('Expected a fresh partial retry preview.');
		await expect(history.scrub(retry.token, authority)).resolves.toEqual({ status: 'erased', erased: 1, alreadyAbsent: 0 });
		expect(vault.contents.has('Sessions/one.md')).toBe(true);
		expect(vault.contents.has('Sessions/two.md')).toBe(true);
	});

	it('does no vault I/O on construction, then scans only valid H5.4/H5.7 notes', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.contents.set('Notes/human.md', '# Human note');
		const history = new SessionHistoryService(vault);
		expect(vault.reads).toBe(0);
		await expect(history.scan()).resolves.toMatchObject({ status: 'ok', ignored: 1, sessions: [{ classification: 'exact' }] });
		expect(vault.reads).toBe(2);
	});

	it('scans schema v3 notes with canonical positive item evidence', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note({
			tc_schema: 3, tc_positive_item_deltas_json: '[[100,3],[36038,25]]', tc_event: 'halloween',
			tc_event_source: 'manual_explicit', tc_build: 'Power Reaper',
		}));
		await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({
			status: 'ok', sessions: [{ sessionRef: 'a'.repeat(64), activity: 'halloween', build: 'Power Reaper' }],
		});
	});

	it('H18.11: reads a schema 5 note whose duration is the active time, and still reads every older one', async () => {
		const vault = new MemoryVault();
		// Ends at the stop (09:00), bills 50 min: ten minutes nobody observed travel next to it.
		vault.contents.set('Sessions/v5.md', await note({ tc_schema: 5, tc_duration_ms: 3_000_000, tc_unobserved_ms: 600_000 }));
		vault.contents.set('Sessions/v4.md', await note({ tc_schema: 4, tc_session_ref: 'c'.repeat(64) }));
		vault.contents.set('Sessions/v2.md', await note({ tc_session_ref: 'd'.repeat(64) }));
		const scanned = await new SessionHistoryService(vault).scan();
		if (scanned.status !== 'ok') throw new Error(`Scan failed: ${scanned.status}`);
		const byRef = new Map(scanned.sessions.map((session) => [session.sessionRef, session]));
		expect(byRef.get('a'.repeat(64))).toMatchObject({ endedAt: '2026-08-13T09:00:00.000Z', durationMs: 3_000_000 });
		expect(byRef.get('c'.repeat(64))).toMatchObject({ durationMs: 3_600_000 });
		expect(byRef.get('d'.repeat(64))).toMatchObject({ durationMs: 3_600_000 });
		// The pair must add up: an active time that ignores the unobserved one is not accepted.
		const broken = new MemoryVault();
		broken.contents.set('Sessions/v5.md', await note({ tc_schema: 5, tc_duration_ms: 3_600_000, tc_unobserved_ms: 600_000 }));
		await expect(new SessionHistoryService(broken).scan()).resolves.toMatchObject({ status: 'conflict', invalid: 1 });
	});

	it('keeps an abandoned session in the ledger and out of performance and totals', async () => {
		const vault = new MemoryVault();
		const completed = { tc_schema: 6, tc_build: 'Power Reaper', tc_event: 'halloween', tc_event_source: 'manual_explicit' };
		vault.contents.set('Sessions/one.md', await note({ ...completed }));
		vault.contents.set('Sessions/two.md', await note({ ...completed, tc_session_ref: 'c'.repeat(64) }));
		const abandoned = await renderAbandonedSessionNote({ state: abandonedState(), locale: 'es', outputFolder: 'Tyrian Companion' });
		if (abandoned.status !== 'ok') throw new Error('The abandoned note did not render.');
		expect(abandoned.note.frontmatter).toMatchObject({
			tc_outcome: 'abandoned', tc_abandon_reason: 'account_changed', tc_classification: null,
			tc_observed_immediate_copper: null, tc_sacks: null, tc_positive_item_deltas_json: '[]',
		});
		expect(abandoned.note.content).toContain('Sesión abandonada');
		vault.contents.set('Sessions/abandoned.md', abandoned.note.content);

		const scanned = await new SessionHistoryService(vault).scan();
		if (scanned.status !== 'ok') throw new Error(`Scan failed: ${scanned.status}`);
		expect(scanned.sessions).toHaveLength(3);
		expect(scanned.sessions.find((session) => session.outcome === 'abandoned')).toMatchObject({
			classification: 'abandoned', sacks: null, observedImmediateCopper: null,
		});
		const aggregate = buildSessionHistoryAggregate(scanned.sessions);
		expect(aggregate.performance).toMatchObject({ abandonedSessions: 1, qualityExcludedSessions: 0, missingContextSessions: 0 });
		expect(aggregate.performance.groups).toEqual([expect.objectContaining({
			build: 'Power Reaper', sessionCount: 2, eligibleSessions: 2, status: 'ready',
		})]);
		// The two measured sessions still add up; the abandoned one never turns a total into unknown.
		expect(aggregate).toMatchObject({ sessionCount: 3, totalSacks: 2, totalImmediateCopper: 200, totalDurationMs: 7_200_000 });
	});

	it('H18.26: scans a Labyrinth note tagged by the in-game presence', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note({
			tc_schema: 4, tc_event: 'halloween', tc_event_source: 'ingame_presence',
		}));
		await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({
			status: 'ok', sessions: [{ sessionRef: 'a'.repeat(64), activity: 'halloween' }],
		});
	});

	it('scans schema v4 notes carrying the magic find source and its manual consumables part', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note({
			tc_schema: 4, tc_magic_find: 333, tc_magic_find_source: 'derived', tc_magic_find_consumables: 0,
		}));
		await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({
			status: 'ok', sessions: [{ sessionRef: 'a'.repeat(64) }],
		});
	});

	it('keeps reading the schema v3 notes already written to the vault after the v4 bump', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/v3.md', await note({ tc_schema: 3, tc_magic_find: 250 }));
		vault.contents.set('Sessions/v2.md', await note({ tc_session_ref: 'c'.repeat(64) }));
		vault.contents.set('Sessions/v1.md', await note({ tc_schema: 1, tc_session_ref: 'd'.repeat(64) }));
		await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({ status: 'ok' });
		const scan = await new SessionHistoryService(vault).scan();
		expect(scan.status).toBe('ok');
		expect(scan.status === 'ok' ? scan.sessions.length : 0).toBe(3);
	});

	it('rejects a v4 note whose magic find provenance is missing or contradicts the total', async () => {
		for (const content of [
			// The two v4 keys are mandatory: a note claiming schema 4 without them is not a v4 note.
			(await note({ tc_schema: 4 })).replace(/^tc_magic_find_source: .*$/mu, ''),
			(await note({ tc_schema: 4 })).replace('tc_magic_find_source: "derived"', 'tc_magic_find_source: "guessed"'),
			// The declared consumables part is inside the total, never larger than it.
			await note({ tc_schema: 4, tc_magic_find: 10, tc_magic_find_consumables: 11 }),
		]) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/bad.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({ status: 'conflict', invalid: 1 });
		}
	});

	it('fails closed for corrupt blocks, future schemas, and duplicate session refs', async () => {
		const corrupt = new MemoryVault();
		corrupt.contents.set('Sessions/one.md', (await note()).replace('summary content', 'edited summary'));
		await expect(new SessionHistoryService(corrupt).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		const future = new MemoryVault();
		future.contents.set('Sessions/one.md', (await note()).replace('tc_schema: 2', 'tc_schema: 7'));
		await expect(new SessionHistoryService(future).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		const duplicate = new MemoryVault();
		duplicate.contents.set('Sessions/one.md', await note());
		duplicate.contents.set('Sessions/two.md', await note());
		await expect(new SessionHistoryService(duplicate).scan()).resolves.toEqual({ status: 'conflict', invalid: 0, duplicates: 1 });
	});

	it('keeps schema 1 absence compatible but treats any tc hint, enum, optional field, or duration mismatch as corruption', async () => {
		const legacy = new MemoryVault();
		legacy.contents.set('Sessions/v1.md', await note({ tc_schema: 1 }));
		await expect(new SessionHistoryService(legacy).scan()).resolves.toMatchObject({ status: 'ok', sessions: [{ sessionRef: 'a'.repeat(64) }] });
		for (const content of [
			(await note()).replace('tc_confidence: "high"', 'tc_confidence: "unknown"'),
			(await note()).replace('tc_build: null', 'tc_build: 4'),
			(await note()).replace('tc_duration_ms: 3600000', 'tc_duration_ms: 7'),
			'---\ntc_kind malformed',
		]) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/bad.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		}
	});

	it('enforces renderer-compatible valuation, reservation, hold, recommendation, and YAML scalar invariants', async () => {
		for (const content of [
			(await note()).replace('tc_sacks: 1', 'tc_sacks: -1'),
			(await note()).replace('tc_price_source: "gw2-commerce-prices"', 'tc_price_source: null'),
			(await note()).replace('tc_valuation_coverage: "complete"', 'tc_valuation_coverage: "not_evaluated"'),
			(await note()).replace('tc_reservation_status: "not_evaluated"', 'tc_reservation_status: "complete:met"'),
			(await note()).replace('tc_hold_status: "not_evaluated"', 'tc_hold_status: "active"'),
			(await note()).replace('tc_recommendation_action: null', 'tc_recommendation_action: "sell"'),
			(await note()).replace('tc_character: "=malicious-character"', 'tc_character: true'),
			(await note()).replace('tc_observed_immediate_copper: 100', 'tc_observed_immediate_copper: []'),
			(await note()).replace('tc_kind: "gw2_farming_session"', 'tc_kind: gw2_farming_session'),
			(await note()).replace('tc_kind: "gw2_farming_session"', "tc_kind: 'gw2_farming_session'"),
			(await note()).replace('tc_kind: "gw2_farming_session"', 'tc_kind: "gw2_farming_session'),
			(await note()).replace('tc_duration_ms: 3600000', 'tc_duration_ms: "3600000"'),
			(await note()).replace('tc_kind: "gw2_farming_session"', 'tc_kind: "gw2_farming_session"\ntc_kind: "gw2_farming_session"'),
		]) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/bad.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		}
	});

	it('accepts only the renderer classification-confidence and valuation-evidence matrix', async () => {
		const estimated = {
			tc_classification: 'estimated', tc_confidence: 'medium', tc_sacks_per_hour_milli: null,
			tc_immediate_copper_per_hour: null, tc_listing_copper_per_hour: null,
		};
		const contaminated = {
			tc_classification: 'contaminated', tc_confidence: 'high', tc_observed_immediate_copper: null,
			tc_observed_listing_copper: null, tc_sacks: null, tc_sacks_per_hour_milli: null,
			tc_immediate_copper_per_hour: null, tc_listing_copper_per_hour: null,
		};
		for (const content of [
			await note(),
			await note(estimated),
			await note({ ...estimated, tc_confidence: 'low' }),
			await note({ tc_observed_immediate_copper: -1 }),
			await note(contaminated),
		]) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/valid.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({ status: 'ok', sessions: [{ sessionRef: 'a'.repeat(64) }] });
		}
		for (const content of [
			await note({ tc_confidence: 'medium' }),
			await note({ ...estimated, tc_confidence: 'high' }),
			await note({ ...contaminated, tc_confidence: 'low' }),
			await note({ ...estimated, tc_sacks: -1 }),
			await note({ ...estimated, tc_immediate_copper_per_hour: 1 }),
			await note({ ...contaminated, tc_observed_listing_copper: 1 }),
		]) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/invalid.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		}
	});

	it.each([1, 2, 3, 4, 5, 6])('keeps signed observed net values and exact rates readable in schema %i', async (schema) => {
		for (const estimated of [false, true]) {
			const vault = new MemoryVault();
			const source = await note({
				tc_schema: schema, tc_classification: estimated ? 'estimated' : 'exact',
				tc_confidence: estimated ? 'medium' : 'high', tc_valuation_coverage: estimated ? 'partial' : 'complete',
				tc_observed_immediate_copper: -42_201, tc_observed_listing_copper: -4_713,
				tc_sacks_per_hour_milli: estimated ? null : 1000,
				tc_immediate_copper_per_hour: estimated ? null : -42_201,
				tc_listing_copper_per_hour: estimated ? null : -4_713,
			});
			vault.contents.set('Sessions/loss.md', source);
			const history = new SessionHistoryService(vault);
			for (const scanSource of ['rebuild', 'index'] as const) {
				await expect(history.scan(scanSource)).resolves.toMatchObject({ status: 'ok', sessions: [{
					observedImmediateCopper: -42_201, observedListingCopper: -4_713,
					immediateCopperPerHour: estimated ? null : -42_201,
					listingCopperPerHour: estimated ? null : -4_713,
				}] });
			}
			await expect(history.readSession('a'.repeat(64))).resolves.toMatchObject({ status: 'found' });
			expect(vault.contents.get('Sessions/loss.md')).toBe(source);
			expect(vault.processes).toBe(0);
		}
	});

	it('exports a partial estimated loss with its signed numbers while preserving the original note', async () => {
		const vault = new MemoryVault();
		const source = await note({ tc_schema: 3, tc_classification: 'estimated', tc_confidence: 'medium',
			tc_valuation_coverage: 'partial', tc_observed_immediate_copper: -42_201, tc_observed_listing_copper: -4_713,
			tc_sacks_per_hour_milli: null, tc_immediate_copper_per_hour: null, tc_listing_copper_per_hour: null });
		vault.contents.set('Sessions/loss.md', source);
		await expect(new SessionHistoryService(vault).export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 1 });
		const json: unknown = JSON.parse(vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`)!);
		expect(json).toMatchObject({ sessions: [{ observedImmediateCopper: -42_201, observedListingCopper: -4_713 }] });
		const csv = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)!;
		// Z11: signed numbers stay numbers (a number cannot be a formula); only strings are protected.
		expect(csv).toContain('"-42201","-4713"');
		expect(csv).not.toContain('\'-42201');
		expect(vault.contents.get('Sessions/loss.md')).toBe(source);
		expect(vault.processes).toBe(0);
	});

	it('rejects malformed signed money and retains nonnegative quantity and duration guards', async () => {
		const invalid: Record<string, string | number | null>[] = [];
		for (const key of ['tc_observed_immediate_copper', 'tc_observed_listing_copper',
			'tc_immediate_copper_per_hour', 'tc_listing_copper_per_hour']) {
			for (const value of [-1.5, Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, '-1', null]) {
				invalid.push({ [key]: value });
			}
		}
		for (const key of ['tc_sacks', 'tc_sacks_per_hour_milli', 'tc_magic_find', 'tc_duration_ms']) {
			invalid.push({ [key]: -1 });
		}
		invalid.push({ tc_reservation_status: 'complete:met', tc_reserved_quantity: -1 },
			{ tc_hold_status: 'active', tc_held_quantity: -1 },
			{ tc_recommendation_status: 'ready', tc_recommendation_action: 'sell', tc_recommendation_route: 'instant_sell',
				tc_recommendation_quantity: -1 });
		for (const overrides of invalid) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/invalid.md', await note(overrides));
			await expect(new SessionHistoryService(vault).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		}
	});

	it('creates deterministic create-only JSON and CRLF CSV without human data or formula injection', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note({ tc_schema: 6, tc_build: 'Private Power Reaper', tc_comparison_json: JSON.stringify({ buildRef: 'c'.repeat(64),
			magicFind: { observable: 321, manual: 123, unobservedBuffs: true }, groupContext: 'without_bosses' }),
			tc_farming_goal_json: JSON.stringify({ version: 1, kind: 'bags', targetBags: 999 }),
			tc_sack_observation_json: JSON.stringify({ itemId: 36038, observedGains: 17, netRetained: 1, totalObtained: null }) }));
		const history = new SessionHistoryService(vault);
		await expect(history.export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 1 });
		const json = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`)!;
		const csv = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)!;
		expect(json).toContain('"version": 1');
		expect(`${json}\n${csv}`).not.toContain('raw-account-id');
		expect(`${json}\n${csv}`).not.toContain('Human body must stay private');
		expect(`${json}\n${csv}`).not.toContain('=malicious-character');
		expect(`${json}\n${csv}`).not.toContain('Private Power Reaper');
		expect(`${json}\n${csv}`).not.toContain('c'.repeat(64));
		for (const field of ['groupContext', 'magicFind', 'farmingGoal', 'sackObservation', 'legacyPositiveNetSacks', 'without_bosses']) expect(`${json}\n${csv}`).not.toContain(field);
		expect(csv).toContain('\r\n');
		expect(csv.replace(/\r\n/gu, '')).not.toContain('\n');
		await expect(history.export('Tyrian Companion')).resolves.toEqual({ status: 'unchanged', sessions: 1 });
		vault.contents.set(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`, 'foreign');
		await expect(history.export('Tyrian Companion')).resolves.toMatchObject({ status: 'conflict' });
	});

	it('serializes every CSV header cell and emits no empty data row for zero sessions', async () => {
		const vault = new MemoryVault();
		await expect(new SessionHistoryService(vault).export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 0 });
		const csv = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)!;
		expect(csv).toMatch(/^"session_ref","account_ref",/u);
		expect(csv.endsWith('\r\n')).toBe(true);
		expect(csv).not.toContain('\r\n\r\n');
		expect(csv.split('\r\n')).toHaveLength(2);
	});

	it('Z11: a negative number is written bare while a string that starts with a minus stays protected', () => {
		expect(serializeCsvCell(-4)).toBe('"-4"');
		expect(serializeCsvCell(-0.5)).toBe('"-0.5"');
		expect(serializeCsvCell(7)).toBe('"7"');
		expect(serializeCsvCell('-cmd|\' /C calc\'!A0')).toBe('"\'-cmd|\' /C calc\'!A0"');
		expect(serializeCsvCell('-4')).toBe('"\'-4"');
	});

	it.each(['=1+1', ' =1+1', '\t=1+1', '\r=1+1', '\u0001@cmd'])('neutralizes CSV formula prefixes after invisible characters: %j', (value) => {
		expect(serializeCsvCell(value)).toBe(`"'${value}"`);
	});

	it('retries a partial create without overwriting the already-created JSON', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.failOnce = SESSION_HISTORY_CSV_FILE;
		const history = new SessionHistoryService(vault);
		await expect(history.export('Tyrian Companion')).resolves.toMatchObject({ status: 'unavailable' });
		const firstJson = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`);
		await expect(history.export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 1 });
		expect(vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`)).toBe(firstJson);
	});

	it('preflights both create-only outputs before writing either sibling', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.contents.set(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`, 'foreign');
		await expect(new SessionHistoryService(vault).export('Tyrian Companion')).resolves.toMatchObject({ status: 'conflict' });
		expect(vault.contents.has(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`)).toBe(false);
		const jsonConflict = new MemoryVault();
		jsonConflict.contents.set('Sessions/one.md', await note());
		jsonConflict.contents.set(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`, 'foreign');
		await expect(new SessionHistoryService(jsonConflict).export('Tyrian Companion')).resolves.toMatchObject({ status: 'conflict' });
		expect(jsonConflict.contents.has(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)).toBe(false);
	});

	it('does not mix JSON and CSV siblings when two windows export different snapshots', async () => {
		const vault = new MemoryVault();
		const initial = await note();
		vault.contents.set('Sessions/one.md', initial);
		const first = new SessionHistoryService(vault);
		const second = new SessionHistoryService(vault);
		let secondResult: unknown = null;
		vault.beforeCreate = async (path) => {
			if (!path.endsWith(SESSION_HISTORY_JSON_FILE)) return;
			vault.beforeCreate = null;
			vault.contents.set('Sessions/one.md', initial.replace('b'.repeat(64), 'c'.repeat(64)));
			secondResult = await second.export('Tyrian Companion');
		};
		await expect(first.export('Tyrian Companion')).resolves.toMatchObject({ status: 'conflict' });
		expect(secondResult).toEqual({ status: 'written', sessions: 1 });
		const json = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`)!;
		const csv = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)!;
		expect(json).toContain('c'.repeat(64));
		expect(csv).toContain('"c'.concat('c'.repeat(63), '"'));
		expect(json).not.toContain('b'.repeat(64));
	});

	it('returns immediately when JSON loses a create-only race and leaves CSV untouched', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.beforeCreate = async (path) => {
			if (path.endsWith(SESSION_HISTORY_JSON_FILE)) {
				vault.beforeCreate = null;
				vault.contents.set(path, 'foreign');
			}
		};
		await expect(new SessionHistoryService(vault).export('Tyrian Companion')).resolves.toMatchObject({ status: 'conflict' });
		expect(vault.contents.has(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)).toBe(false);
	});

	it('does not treat tc-like human body text or code blocks as a candidate', async () => {
		for (const content of ['# Note\n\n`tc_kind: gw2_farming_session`', '# Note\n```yaml\ntc_kind: gw2_farming_session\n```']) {
			const vault = new MemoryVault();
			vault.contents.set('Notes/human.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toEqual({ status: 'ok', sessions: [], ignored: 1 });
		}
		const marker = new MemoryVault();
		marker.contents.set('Notes/marker.md', '<!-- tyrian-companion:managed:start:summary sha256='.concat('a'.repeat(64), ' -->'));
		await expect(new SessionHistoryService(marker).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
	});

	it('ignores an unfinished frontmatter unless its remaining text carries a tc hint or managed marker', async () => {
		const plain = new MemoryVault();
		plain.contents.set('Notes/draft.md', '---\ntitle: Draft');
		await expect(new SessionHistoryService(plain).scan()).resolves.toEqual({ status: 'ok', sessions: [], ignored: 1 });
		const hinted = new MemoryVault();
		hinted.contents.set('Notes/hinted.md', '---\ntitle: Draft\ntc_kind: gw2_farming_session');
		await expect(new SessionHistoryService(hinted).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
	});

	// 29 sep 2026, David's vault: the scan reads the whole vault, so the 1353 inventory position
	// notes and the collector status note the plugin itself writes counted as corrupt sessions and
	// the history view refused to show anything. They are the plugin's own notes of another kind.
	it('ignores the notes the plugin writes for inventory, wallet and collector status', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.contents.set('Sessions/two.md', await note({ tc_session_ref: 'c'.repeat(64) }));
		vault.contents.set('Tyrian Companion/Inventory/Positions/19687-m-account.md', inventoryNote());
		vault.contents.set('Tyrian Companion/Collector status.md', renderCollectorStatusNote({
			instanceId: 'collector-instance-1', platform: 'macos', hostVersion: '1.14.0', pluginVersion: '0.2.10',
			heartbeatAt: '2026-09-29T08:00:00.000Z',
		}, 'es'));
		const wallet = (await new WalletVaultSyncService(emptyWalletVault(), 'vault-config').preview('Tyrian Companion', {
			schemaVersion: 1, capturedAt: '2026-09-29T08:00:01.000Z', locale: 'es',
			positions: [{ currencyId: 1, quantity: 100, order: 1, name: 'Moneda', icon: null }],
		})).steps[0];
		if (!wallet || wallet.after === null) throw new Error('Expected a rendered wallet note.');
		vault.contents.set(wallet.path, wallet.after);
		const history = new SessionHistoryService(vault);
		const scan = await history.scan();
		expect(scan).toMatchObject({ status: 'ok', ignored: 3 });
		if (scan.status !== 'ok') throw new Error('Expected an ok scan.');
		expect(scan.sessions.map((session) => session.sessionRef)).toEqual(['a'.repeat(64), 'c'.repeat(64)]);
		await expect(history.readSession('c'.repeat(64))).resolves.toMatchObject({ status: 'found', path: 'Sessions/two.md' });
		await expect(history.previewScrub(idleAuthority())).resolves.toMatchObject({ status: 'ready', sessions: 2 });
	});

	it('keeps failing closed on an unknown tc_kind or a foreign kind that carries a session identity', async () => {
		const unknown = new MemoryVault();
		unknown.contents.set('Sessions/one.md', await note());
		unknown.contents.set('Notes/unknown.md', '---\ntc_kind: gw2_farming_sesion\ntc_schema: 2\n---\n');
		await expect(new SessionHistoryService(unknown).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		const relabelled = new MemoryVault();
		relabelled.contents.set('Notes/relabelled.md', (await note()).replace('tc_kind: "gw2_farming_session"', 'tc_kind: gw2_inventory_position'));
		expect(relabelled.contents.get('Notes/relabelled.md')).toContain('tc_kind: gw2_inventory_position');
		await expect(new SessionHistoryService(relabelled).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
	});

	it('recognizes existing folders without attempting to read them as export files', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.folders.add('Tyrian Companion');
		vault.folders.add('Tyrian Companion/exports');
		await expect(new SessionHistoryService(vault).export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 1 });
		const blocked = new MemoryVault();
		blocked.contents.set('Sessions/one.md', await note());
		blocked.folders.add(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`);
		await expect(new SessionHistoryService(blocked).export('Tyrian Companion')).resolves.toMatchObject({ status: 'conflict' });
	});
});

/**
 * Audit 2.2: on a host that reports every note change, an `index` scan keeps each note's
 * inspection and reads again only what the host named or the listing no longer explains. Every
 * case compares it with what a scan that reads the whole vault answers for the same vault.
 */
describe('durable session history index', () => {
	const REF_B = 'c'.repeat(64);

	async function seeded(): Promise<{ vault: WatchedVault; history: SessionHistoryService }> {
		const vault = new WatchedVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.contents.set('Sessions/two.md', await note({ tc_session_ref: REF_B, tc_sacks: 7 }));
		vault.contents.set('Notes/human.md', '# Human note');
		vault.contents.set('Notes/other.md', '# Another human note');
		return { vault, history: new SessionHistoryService(vault) };
	}

	/** One `index` scan: what it answered, which notes it read, and that a full read answers the same. */
	async function indexed(history: SessionHistoryService, vault: WatchedVault, source: 'index' | 'rebuild' = 'index') {
		vault.takeReads();
		const scan = await history.scan(source);
		const reads = vault.takeReads();
		expect(scan).toEqual(await new SessionHistoryService(vault).scan());
		vault.takeReads();
		return { scan, reads };
	}

	it('reads every note once, then none while nothing changes, and all of them again on a rebuild', async () => {
		const { vault, history } = await seeded();
		const everyNote = ['Notes/human.md', 'Notes/other.md', 'Sessions/one.md', 'Sessions/two.md'];

		expect(vault.listeners.size).toBe(0);
		const first = await indexed(history, vault);
		expect(first.reads).toEqual(everyNote);
		expect(first.scan).toMatchObject({ status: 'ok', ignored: 2, sessions: [{ sacks: 1 }, { sacks: 7 }] });
		expect((await indexed(history, vault)).reads).toEqual([]);
		expect((await indexed(history, vault)).reads).toEqual([]);
		expect((await indexed(history, vault, 'rebuild')).reads).toEqual(everyNote);
		expect((await indexed(history, vault)).reads).toEqual([]);
	});

	it('keeps reading the whole vault for a scan that does not ask for the index, and remembers nothing from it', async () => {
		const { vault, history } = await seeded();

		await history.scan();
		await history.scan();
		expect(vault.takeReads()).toHaveLength(8);
		await expect(history.export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 2 });
		expect(vault.takeReads().filter((path) => path.endsWith('.md'))).toHaveLength(4);
		expect((await indexed(history, vault)).reads).toHaveLength(4);
	});

	it('reads the whole vault on every scan when the host does not promise to report changes', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		vault.contents.set('Notes/human.md', '# Human note');
		const history = new SessionHistoryService(vault);

		await expect(history.scan('index')).resolves.toMatchObject({ status: 'ok', ignored: 1 });
		await expect(history.scan('index')).resolves.toMatchObject({ status: 'ok', ignored: 1 });
		expect(vault.reads).toBe(4);
	});

	it('still counts a session note moved to another folder, reading only its new path', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.rename('Sessions/one.md', 'Archive/2026/one.md');

		const moved = await indexed(history, vault);
		expect(moved.reads).toEqual(['Archive/2026/one.md']);
		expect(moved.scan).toMatchObject({ status: 'ok', ignored: 2, sessions: [{ sacks: 1 }, { sacks: 7 }] });
	});

	it('still counts a renamed session note, reading only its new name', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.rename('Sessions/two.md', 'Sessions/renamed.md');

		const renamed = await indexed(history, vault);
		expect(renamed.reads).toEqual(['Sessions/renamed.md']);
		expect(renamed.scan).toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 7 }] });
	});

	it('keeps detecting the same session in two notes, from the index and when the copy appears later', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.write('Copies/one copy.md', await note());
		const duplicated = await indexed(history, vault);
		expect(duplicated.reads).toEqual(['Copies/one copy.md']);
		expect(duplicated.scan).toEqual({ status: 'conflict', invalid: 0, duplicates: 1 });
		const again = await indexed(history, vault);
		expect(again.reads).toEqual([]);
		expect(again.scan).toEqual({ status: 'conflict', invalid: 0, duplicates: 1 });

		vault.remove('Copies/one copy.md');
		const resolved = await indexed(history, vault);
		expect(resolved.reads).toEqual([]);
		expect(resolved.scan).toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 7 }] });
	});

	it('keeps detecting a corrupt session note, from the index and when a note is corrupted later', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.write('Sessions/two.md', (await note({ tc_session_ref: REF_B })).replace('summary content', 'edited summary'));
		const corrupt = await indexed(history, vault);
		expect(corrupt.reads).toEqual(['Sessions/two.md']);
		expect(corrupt.scan).toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		const again = await indexed(history, vault);
		expect(again.reads).toEqual([]);
		expect(again.scan).toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
	});

	// The port carries no modification date at all, so an index scan has none to compare: the
	// listing of an edited note is identical before and after, and only the host's event says it
	// changed. That is the "edited with the same modification date" case, by construction.
	it('reads again a note edited in place, with nothing in the listing changing', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);
		const listing = JSON.stringify(vault.markdownFiles());

		vault.write('Sessions/two.md', await note({ tc_session_ref: REF_B, tc_sacks: 9 }));

		expect(JSON.stringify(vault.markdownFiles())).toBe(listing);
		const edited = await indexed(history, vault);
		expect(edited.reads).toEqual(['Sessions/two.md']);
		expect(edited.scan).toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 9 }] });
	});

	it('reads again a note deleted and recreated at the same path between two scans', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.remove('Sessions/two.md');
		vault.write('Sessions/two.md', await note({ tc_session_ref: 'd'.repeat(64), tc_sacks: 3 }));

		const recreated = await indexed(history, vault);
		expect(recreated.reads).toEqual(['Sessions/two.md']);
		expect(recreated.scan).toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 3 }] });
	});

	it('drops a deleted session note without reading anything', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.remove('Sessions/two.md');

		const deleted = await indexed(history, vault);
		expect(deleted.reads).toEqual([]);
		expect(deleted.scan).toMatchObject({ status: 'ok', ignored: 2, sessions: [{ sacks: 1 }] });
	});

	it('follows a note that becomes a session note and a session note that stops being one', async () => {
		const { vault, history } = await seeded();
		await indexed(history, vault);

		vault.write('Notes/human.md', await note({ tc_session_ref: 'd'.repeat(64), tc_sacks: 5 }));
		const promoted = await indexed(history, vault);
		expect(promoted.reads).toEqual(['Notes/human.md']);
		expect(promoted.scan).toMatchObject({ status: 'ok', ignored: 1, sessions: [{ sacks: 1 }, { sacks: 7 }, { sacks: 5 }] });

		vault.write('Sessions/one.md', '# Rewritten by hand, no longer a session');
		const demoted = await indexed(history, vault);
		expect(demoted.reads).toEqual(['Sessions/one.md']);
		expect(demoted.scan).toMatchObject({ status: 'ok', ignored: 2, sessions: [{ sacks: 7 }, { sacks: 5 }] });
	});

	// What a failed read does today, fixed: the note counts as invalid, the scan is a conflict and
	// nothing reaches the debug log. The index adds only that the failure is never remembered.
	it('counts a note that cannot be read as invalid, and reads it again on every scan until it can be read', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const actions = new LocalDebugActionRunner({ diagnostics: { record } as unknown as LocalDebugLogger, createId: () => 'history-index' });
		const { vault } = await seeded();
		const history = new SessionHistoryService(vault, actions);
		vault.unreadable.add('Sessions/two.md');

		const failed = await indexed(history, vault);
		expect(failed.reads).toHaveLength(4);
		expect(failed.scan).toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		const failedAgain = await indexed(history, vault);
		expect(failedAgain.reads).toEqual(['Sessions/two.md']);
		expect(failedAgain.scan).toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		expect(record).not.toHaveBeenCalled();

		vault.unreadable.clear();
		const recovered = await indexed(history, vault);
		expect(recovered.reads).toEqual(['Sessions/two.md']);
		expect(recovered.scan).toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 7 }] });
		expect((await indexed(history, vault)).reads).toEqual([]);
	});

	it('does not remember a note that changed while it was being read', async () => {
		const { vault, history } = await seeded();
		const edited = await note({ tc_session_ref: REF_B, tc_sacks: 9 });
		vault.whileReading = (path) => {
			if (path !== 'Sessions/two.md') return;
			vault.whileReading = null;
			vault.write(path, edited);
		};

		// The read that was already under way answers the text from before the edit.
		await expect(history.scan('index')).resolves.toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 7 }] });

		const after = await indexed(history, vault);
		expect(after.reads).toEqual(['Sessions/two.md']);
		expect(after.scan).toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 9 }] });
	});

	// The limit of the index, fixed on purpose: it trusts the host's events. An edit the host never
	// reports stays unseen by an `index` scan, and the explicit rebuild is what reads it.
	it('serves the remembered inspection for an edit the host never reported, until a rebuild', async () => {
		const { vault, history } = await seeded();
		await history.scan('index');

		vault.contents.set('Sessions/two.md', await note({ tc_session_ref: REF_B, tc_sacks: 9 }));

		await expect(history.scan('index')).resolves.toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 7 }] });
		await expect(history.scan('rebuild')).resolves.toMatchObject({ status: 'ok', sessions: [{ sacks: 1 }, { sacks: 9 }] });
	});

	it('listens only from its first index scan, and stops and forgets on dispose', async () => {
		const { vault, history } = await seeded();
		expect(vault.listeners.size).toBe(0);
		await history.scan();
		expect(vault.listeners.size).toBe(0);
		await history.scan('index');
		await history.scan('index');
		expect(vault.listeners.size).toBe(1);

		history.dispose();

		expect(vault.listeners.size).toBe(0);
		expect((await indexed(history, vault)).reads).toHaveLength(4);
	});
});

class MemoryVault implements SessionHistoryVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	reads = 0;
	processes = 0;
	failOnce: string | null = null;
	beforeCreate: ((path: string) => Promise<void>) | null = null;
	beforeProcess: ((path: string) => Promise<void>) | null = null;
	afterProcess: ((path: string) => Promise<void>) | null = null;
	markdownFiles(): readonly SessionHistoryFile[] {
		return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path }));
	}
	file(path: string): SessionHistoryFile | null {
		return this.contents.has(path) ? { path } : null;
	}
	exists(path: string): boolean { return this.contents.has(path) || this.folders.has(path); }
	async read(file: SessionHistoryFile): Promise<string> {
		this.reads += 1;
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	/**
	 * Hebra's `process` (R1a): the update runs, the write comes back `stale` because the note
	 * changed, and the update runs AGAIN on a fresh read; only that last result is written.
	 */
	staleOnce: ((path: string) => void) | null = null;
	async process(file: SessionHistoryFile, update: (current: string) => string): Promise<void> {
		this.processes += 1;
		const before = this.beforeProcess;
		if (before) await before(file.path);
		if (this.staleOnce) {
			const first = this.contents.get(file.path);
			if (first !== undefined) update(first);
			this.staleOnce(file.path);
			this.staleOnce = null;
		}
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not_file');
		this.contents.set(file.path, update(current));
		if (this.afterProcess) await this.afterProcess(file.path);
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<SessionHistoryFile> {
		const before = this.beforeCreate;
		if (before) await before(path);
		if (this.failOnce !== null && path.endsWith(this.failOnce)) { this.failOnce = null; throw new Error('temporary'); }
		if (this.file(path)) throw new Error('exists');
		this.contents.set(path, content);
		return { path };
	}
}

/** A session abandoned after its key moved to another account; nothing about it was measured. */
function abandonedState(): AbandonedSessionState {
	return {
		version: 1, status: 'abandoned', sessionId: 'abandoned-session',
		authority: { machineId: 'machine', instanceId: 'instance', sessionId: 'abandoned-session', fence: 1, acquiredAt: Date.parse('2026-08-14T07:59:58.000Z') },
		requestedAt: '2026-08-14T07:59:59.000Z',
		baseline: {
			snapshotId: 'snapshot-abandoned', accountId: 'account-anonymous', schemaVersion: '2024-07-20T01:00:00.000Z',
			startedAt: '2026-08-14T08:00:00.000Z', completedAt: '2026-08-14T08:00:01.000Z', quality: 'stable',
		},
		startContext: {
			characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
			build: {
				tab: 1, name: 'Power Reaper', profession: 'Necromancer',
				specializations: [{ id: 3, traits: [1, 2, 3] }, { id: 52, traits: [4, 5, 6] }, { id: 63, traits: [7, 8, 9] }],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-14T08:00:02.000Z',
		},
		stopRequestedAt: '2026-08-14T09:00:00.000Z',
		abandonedAt: '2026-08-14T09:15:00.000Z',
		reason: 'account_changed',
	};
}

async function note(overrides: Record<string, string | number | null> = {}): Promise<string> {
	const frontmatter: Record<string, string | number | null> = {
		tc_schema: 2, tc_kind: 'gw2_farming_session', tc_session_ref: 'a'.repeat(64), tc_account_ref: 'b'.repeat(64),
		tc_started_at: '2026-08-13T08:00:00.000Z', tc_ended_at: '2026-08-13T09:00:00.000Z', tc_duration_ms: 3_600_000,
		tc_classification: 'exact', tc_confidence: 'high', tc_scope: 'observed_storage_net', tc_valuation_coverage: 'complete',
		tc_locale: 'en', tc_character: '=malicious-character', tc_profession: 'Guardian', tc_build: null,
		tc_magic_find: 0, tc_detection_mode: null, tc_price_source: 'gw2-commerce-prices', tc_price_captured_at: '2026-08-13T09:00:00.000Z',
		tc_observed_immediate_copper: 100, tc_observed_listing_copper: 120, tc_sacks: 1,
		tc_sacks_per_hour_milli: 1000, tc_immediate_copper_per_hour: 100, tc_listing_copper_per_hour: 120,
		tc_reservation_status: 'not_evaluated', tc_reserved_quantity: null, tc_hold_status: 'not_evaluated', tc_held_quantity: null,
		tc_recommendation_status: 'not_evaluated', tc_execution: 'manual_in_game', tc_side_effects: 'none',
		tc_event: null, tc_event_source: null, tc_recommendation_action: null, tc_recommendation_quantity: null,
		tc_recommendation_route: null, ...overrides,
	};
	if (typeof frontmatter.tc_schema === 'number' && frontmatter.tc_schema >= 3) {
		frontmatter.tc_positive_item_deltas_json ??= '[]';
	}
	if (typeof frontmatter.tc_schema === 'number' && frontmatter.tc_schema >= 4) {
		frontmatter.tc_magic_find_source ??= 'derived';
		frontmatter.tc_magic_find_consumables ??= 0;
	}
	if (frontmatter.tc_schema === 5 || frontmatter.tc_schema === 6) frontmatter.tc_unobserved_ms ??= 0;
	if (frontmatter.tc_schema === 6) {
		frontmatter.tc_outcome ??= 'completed';
		if (!('tc_abandon_reason' in frontmatter)) frontmatter.tc_abandon_reason = null;
	}
	if (frontmatter.tc_schema === 1) {
		delete frontmatter.tc_event; delete frontmatter.tc_event_source; delete frontmatter.tc_recommendation_action;
		delete frontmatter.tc_recommendation_quantity; delete frontmatter.tc_recommendation_route;
	}
	const blocks = await Promise.all(SESSION_NOTE_BLOCK_IDS.map(async (id) => {
		const content = `${id} content`;
		return `<!-- tyrian-companion:managed:start:${id} sha256=${await sha256Text(content)} -->\n${content}\n<!-- tyrian-companion:managed:end:${id} -->`;
	}));
	return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join('\n')}\n---\n# Session\n\n${blocks.join('\n\n')}\n\nHuman body must stay private\n`;
}

/**
 * An inventory position note as `renderInventoryNote` lays it out: YAML-stringified managed keys
 * (so `tc_kind` is unquoted), the position marker and the managed block. Its writer is not
 * reachable without a whole snapshot, so this keeps its shape rather than calling it.
 */
function inventoryNote(): string {
	const frontmatter = stringifyYaml({
		tc_schema: 1, tc_kind: 'gw2_inventory_position', tc_marker: 'tyrian_companion_inventory_position',
		tc_position_id: '19687-m-account', tc_item_id: 19687, tc_source: 'material', tc_character: null, tc_quantity: 250,
		tc_unit_sell_copper: 12, tc_total_sell_copper: 3000, tc_active: true, tc_item_name: 'Cadena de hierro',
		descripcion: 'Existencia de inventario gestionada por Tyrian Companion.',
	}, { lineWidth: 0 }).trimEnd();
	return `---\n${frontmatter}\n---\n<!-- tyrian-companion-inventory schema=1 marker=tyrian_companion_inventory_position position=19687-m-account hash=${'d'.repeat(64)} -->\nbloque\n<!-- /tyrian-companion-inventory -->\n`;
}

function emptyWalletVault(): WalletVaultPort {
	return {
		file: () => null, markdownFiles: () => [], read: async () => { throw new Error('not_file'); },
		createFolder: async () => { throw new Error('read_only'); }, create: async () => { throw new Error('read_only'); },
		process: async () => { throw new Error('read_only'); },
	};
}

/** A host that reports every note change: each mutation below lands, then its event is delivered. */
class WatchedVault extends MemoryVault {
	readonly listeners = new Set<(change: SessionHistoryNoteChange) => void>();
	readonly unreadable = new Set<string>();
	whileReading: ((path: string) => void) | null = null;
	private readonly readPaths: string[] = [];

	onNoteChange(listener: (change: SessionHistoryNoteChange) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	override async read(file: SessionHistoryFile): Promise<string> {
		this.readPaths.push(file.path);
		if (this.unreadable.has(file.path)) throw new Error('disk unavailable');
		const content = await super.read(file);
		this.whileReading?.(file.path);
		return content;
	}
	/** The paths read since the last call, sorted. */
	takeReads(): string[] { return this.readPaths.splice(0).sort(); }
	write(path: string, content: string): void {
		this.contents.set(path, content);
		this.emit({ path });
	}
	remove(path: string): void {
		this.contents.delete(path);
		this.emit({ path });
	}
	rename(from: string, to: string): void {
		const content = this.contents.get(from);
		if (content === undefined) throw new Error('not_file');
		this.contents.delete(from);
		this.contents.set(to, content);
		this.emit({ path: to, oldPath: from });
	}
	private emit(change: SessionHistoryNoteChange): void {
		for (const listener of [...this.listeners]) listener(change);
	}
}
