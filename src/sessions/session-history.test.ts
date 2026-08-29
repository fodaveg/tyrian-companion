import { describe, expect, it } from 'vitest';

import { SESSION_NOTE_BLOCK_IDS } from './session-note-model';
import { sha256Text } from './session-note-renderer';
import {
	SESSION_HISTORY_CSV_FILE,
	SESSION_HISTORY_JSON_FILE,
	SessionHistoryRuntimeAuthority,
	SessionHistoryService,
	canScrubSessionHistory,
	serializeCsvCell,
	type SessionHistoryFile,
	type SessionHistoryVault,
} from './session-history';

describe('durable session history', () => {
	const scrubGate = { sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed' } as const;
	const idleAuthority = () => new SessionHistoryRuntimeAuthority(() => scrubGate);

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
			tc_schema: 3, tc_positive_item_deltas_json: '[[100,3],[36038,25]]',
		}));
		await expect(new SessionHistoryService(vault).scan()).resolves.toMatchObject({
			status: 'ok', sessions: [{ sessionRef: 'a'.repeat(64) }],
		});
	});

	it('fails closed for corrupt blocks, future schemas, and duplicate session refs', async () => {
		const corrupt = new MemoryVault();
		corrupt.contents.set('Sessions/one.md', (await note()).replace('summary content', 'edited summary'));
		await expect(new SessionHistoryService(corrupt).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		const future = new MemoryVault();
		future.contents.set('Sessions/one.md', (await note()).replace('tc_schema: 2', 'tc_schema: 4'));
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
			await note({ tc_observed_immediate_copper: -1 }),
			await note({ ...estimated, tc_sacks: -1 }),
			await note({ ...estimated, tc_immediate_copper_per_hour: 1 }),
			await note({ ...contaminated, tc_observed_listing_copper: 1 }),
		]) {
			const vault = new MemoryVault();
			vault.contents.set('Sessions/invalid.md', content);
			await expect(new SessionHistoryService(vault).scan()).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		}
	});

	it('creates deterministic create-only JSON and CRLF CSV without human data or formula injection', async () => {
		const vault = new MemoryVault();
		vault.contents.set('Sessions/one.md', await note());
		const history = new SessionHistoryService(vault);
		await expect(history.export('Tyrian Companion')).resolves.toEqual({ status: 'written', sessions: 1 });
		const json = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_JSON_FILE}`)!;
		const csv = vault.contents.get(`Tyrian Companion/exports/${SESSION_HISTORY_CSV_FILE}`)!;
		expect(json).toContain('"version": 1');
		expect(`${json}\n${csv}`).not.toContain('raw-account-id');
		expect(`${json}\n${csv}`).not.toContain('Human body must stay private');
		expect(`${json}\n${csv}`).not.toContain('=malicious-character');
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
	async process(file: SessionHistoryFile, update: (current: string) => string): Promise<void> {
		this.processes += 1;
		const before = this.beforeProcess;
		if (before) await before(file.path);
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
