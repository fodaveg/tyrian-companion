import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TyrianTcpConnection, TyrianTcpServerPort } from '../host/tyrian-host';
import { startAlertIngameServer } from './alert-ingame-server';
import { LIVE_INGAME_BUILD, LIVE_INGAME_PROFILE, type LiveIngamePort, type LiveIngameSample, type LiveIngameSource, type LiveIngameGap, type LiveIngameReadyStatus, type LiveIngameAckStatus } from './live-loot-protocol';
import { emptyFarmingIngameState } from './farming-ingame-state';

const epoch = 'AgICAgICAgICAgICAgICAg';
const nextEpoch = 'AwMDAwMDAwMDAwMDAwMDAw';
const context = { state: 'gameplay', mapId: 866, character: 'Selected Farmer' };

class LiveClient implements TyrianTcpConnection {
	readonly lines: Record<string, unknown>[] = [];
	private read: (chunk: Uint8Array) => void = () => {};
	private closed: () => void = () => {};
	seq = 0;
	onData(listener: (chunk: Uint8Array) => void): void { this.read = listener; }
	onClose(listener: () => void): void { this.closed = listener; }
	onError(): void {}
	write(line: string): void { this.lines.push(JSON.parse(line) as Record<string, unknown>); }
	end(line?: string): void { if (line) this.write(line); this.closed(); }
	destroySoon(): void { this.closed(); }
	destroy(): void { this.closed(); }
	hello(version = 3, client = 'nexus', instance = 'AAAAAAAAAAAAAAAAAAAAAA'): void {
		this.raw(JSON.stringify({ v: version, type: 'hello', client, instance, clientVersion: '1.0', token: 'x'.repeat(43) }));
	}
	raw(line: string): void { this.read(new TextEncoder().encode(line + '\n')); }
	send(type: string, fields: Record<string, unknown> = {}): void {
		this.raw(JSON.stringify({ v: 3, type, nonce: this.lines[0]?.nonce, seq: this.seq++, ...fields }));
	}
	live(type: string, fields: Record<string, unknown> = {}): void { this.send(type, { tag: 'live1', epoch, ...fields }); }
}
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (result: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

async function bridge(enabled = true) {
	let accept: (socket: TyrianTcpConnection) => void = () => {};
	let random = 0;
	const open = vi.fn(async (_source: LiveIngameSource): Promise<LiveIngameReadyStatus> => 'ready');
	const commit = vi.fn(async (_sample: LiveIngameSample): Promise<LiveIngameAckStatus> => 'stored');
	const gap = vi.fn(async (_gap: LiveIngameGap) => {});
	const error = vi.fn();
	const events = vi.fn();
	const ack = vi.fn();
	const live: LiveIngamePort = { open, commit, gap, onError: error };
	const tcp: TyrianTcpServerPort = { listen: async (_port, _host, listener) => {
		accept = listener; return { address: '127.0.0.1', port: 47823, close: async () => {} };
	} };
	const server = await startAlertIngameServer(tcp, 47823, {
		schedule: (callback, milliseconds) => setTimeout(callback, milliseconds), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	}, { authenticate: () => true, fillRandom: (bytes) => { bytes.fill(++random); }, now: () => Date.now(),
		onConnectionEvent: events, onAlertAck: ack, farmingState: emptyFarmingIngameState, ...(enabled ? { live } : {}) });
	return { server, open, commit, gap, error, events, ack, connect: (version = 3, client = 'nexus', instance = 'AAAAAAAAAAAAAAAAAAAAAA') => {
		const socket = new LiveClient(); accept(socket); socket.hello(version, client, instance); return socket;
	} };
}
async function open(client: LiveClient): Promise<void> {
	client.send('context', context);
	client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
	await flush();
}
function sample(client: LiveClient, fields: Record<string, unknown> = {}): void {
	client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 2, ...fields });
	client.live('live_rows', { cursor: fields.cursor ?? 0, part: 0, rows: [[0, 12147, 0], [0, 36038, 200]], epoch: fields.epoch ?? epoch });
	client.live('live_end', { cursor: fields.cursor ?? 0, epoch: fields.epoch ?? epoch });
}

describe('live1 authenticated atomic consumer', () => {
	afterEach(() => vi.useRealTimers());

	it('negotiates only Nexus v3 with a configured live owner and preserves all previous message shapes', async () => {
		vi.useFakeTimers(); const h = await bridge();
		expect(h.connect(2).lines.map((l) => l.type)).toEqual(['welcome']);
		expect(h.connect(3, 'blish').lines.map((l) => l.type)).toEqual(['welcome', 'farming_cap']);
		const modern = h.connect(); expect(modern.lines.map((l) => l.type)).toEqual(['welcome', 'farming_cap', 'live_cap']);
		const oldHost = await bridge(false); expect(oldHost.connect().lines.map((l) => l.type)).toEqual(['welcome', 'farming_cap']);
		modern.send('context', context); modern.send('farming_sub', { tag: 'farm1' });
		h.server.broadcastAlert(99, (v) => JSON.stringify({ v, type: 'alert', seq: 99 })); modern.send('alert_ack', { alertSeq: 99 });
		expect(h.ack).toHaveBeenCalledWith(expect.objectContaining({ alertSeq: 99 })); expect(h.commit).not.toHaveBeenCalled();
		await h.server.close(); await oldHost.server.close(); expect(vi.getTimerCount()).toBe(0);
	});

	it('waits for open and durable commit, never publishes a partial batch or advances while saving', async () => {
		vi.useFakeTimers(); const h = await bridge(); const opening = deferred<LiveIngameReadyStatus>(); h.open.mockReturnValueOnce(opening.promise);
		const client = h.connect(); client.send('context', context); client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
		await flush(); expect(client.lines.some((l) => l.type === 'live_ready')).toBe(false);
		opening.resolve('ready'); await flush(); expect(client.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'ready' });
		const storing = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(storing.promise);
		client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: 8, rows: 2 });
		client.live('live_rows', { cursor: 0, part: 0, rows: [[0, 12147, 0], [0, 36038, 200]] }); expect(h.commit).not.toHaveBeenCalled();
		client.live('live_end', { cursor: 0 }); await flush(); expect(h.commit).toHaveBeenCalledTimes(1); expect(client.lines.some((l) => l.type === 'live_ack')).toBe(false);
		storing.resolve('stored'); await flush(); expect(client.lines.at(-1)).toMatchObject({ type: 'live_ack', cursor: 0, status: 'stored' });
		expect(Object.isFrozen(h.commit.mock.calls[0]?.[0].rows[0])).toBe(true); await h.server.close();
	});

	it('accepts a periodic identical context mid-batch and attributes only the selected producer context', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const blish = h.connect(3, 'blish'); blish.send('context', { ...context, character: 'Unrelated Blish', mapId: 1 });
		client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 2 });
		client.send('context', context); client.live('live_rows', { cursor: 0, part: 0, rows: [[0, 12147, 0], [0, 36038, 200]] }); client.live('live_end', { cursor: 0 }); await flush();
		expect(h.commit).toHaveBeenCalledWith(expect.objectContaining({ context, contextSeq: 0, freeSlots: null, currencyCoverage: 'none' })); expect(h.gap).not.toHaveBeenCalled(); await h.server.close();
	});

	it('rejects conflicting producers and live messages from Blish without replacing the owner', async () => {
		vi.useFakeTimers(); const h = await bridge(); const first = h.connect(); await open(first);
		const second = h.connect(3, 'nexus', 'AQEBAQEBAQEBAQEBAQEBAQ'); await open(second);
		expect(second.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'source_conflict' }); expect(h.open).toHaveBeenCalledTimes(1);
		const blish = h.connect(3, 'blish'); blish.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
		expect(blish.lines.at(-1)).toMatchObject({ type: 'error', code: 'unexpected_message' }); sample(first); await flush(); expect(h.commit).toHaveBeenCalledTimes(1); await h.server.close();
	});

	it('returns only failure receipts for durable failure and records callback errors without leaking them', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const failure = new Error('private raw input must never reach the wire'); h.commit.mockRejectedValueOnce(failure); sample(client); await flush();
		expect(h.error).toHaveBeenCalledWith(failure); expect(client.lines.at(-1)).toMatchObject({ type: 'live_ack', status: 'storage_unavailable' });
		expect(JSON.stringify(client.lines)).not.toContain(failure.message); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'storage_unavailable' })); await h.server.close();
	});

	it('retries only the last identical baseline with original ctx, never refreshing freshness or reopening the source', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client); sample(client); await flush();
		client.send('context', context); client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		vi.advanceTimersByTime(4_000); sample(client); await flush(); expect(h.open).toHaveBeenCalledTimes(1); expect(h.commit).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(1_000); await flush(); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'source_stale' }));
		expect(h.server.clientCount()).toBe(1); await h.server.close();
	});

	it('invalidates a real context change even if it returns, without closing presence, and requires a new baseline epoch', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 2 });
		client.send('context', { ...context, mapId: 1 }); client.send('context', context); await flush(); expect(h.commit).not.toHaveBeenCalled();
		expect(h.gap).toHaveBeenCalledTimes(1); expect(h.server.clientCount()).toBe(1);
		client.live('live_open', { epoch: nextEpoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		expect(client.lines.at(-1)).toMatchObject({ type: 'live_ready', epoch: nextEpoch, status: 'ready' });
		sample(client, { epoch: nextEpoch, ctx: 4 }); await flush(); expect(h.commit).toHaveBeenCalledTimes(1); await h.server.close();
	});

	it('discards source status and connection loss and allows same-instance reconnect with a new epoch', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client); sample(client); await flush();
		client.live('live_status', { status: 'unavailable', reason: 'read_failed' }); await flush(); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'read_failed' })); client.destroy();
		const next = h.connect(); next.send('context', context); next.live('live_open', { epoch: nextEpoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush(); sample(next, { epoch: nextEpoch }); await flush();
		expect(h.commit).toHaveBeenCalledTimes(2); expect(h.commit.mock.calls[1]?.[0].sourceInstance).toBe(h.commit.mock.calls[0]?.[0].sourceInstance); await h.server.close(); expect(vi.getTimerCount()).toBe(0);
	});

	it('closes on nonce/shared seq violations and on duplicate/out-of-order rows, without committing partial data', async () => {
		vi.useFakeTimers(); const h = await bridge();
		for (const changed of [{ nonce: 'AAAAAAAAAAAAAAAAAAAAAA' }, { seq: 9 }]) { const client = h.connect(); client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE, ...changed }); expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: changed.nonce ? 'nonce_mismatch' : 'sequence_mismatch' }); }
		for (const rows of [[[0, 1, 1], [0, 1, 2]], [[0, 2, 1], [0, 1, 2]]]) { const client = h.connect(); await open(client); client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 2 }); client.live('live_rows', { cursor: 0, part: 0, rows }); expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: 'frame_schema' }); await flush(); }
		expect(h.commit).not.toHaveBeenCalled(); await h.server.close();
	});
	it('suppresses obsolete ready and durably orders context gaps before reopening', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect();
		const opening = deferred<LiveIngameReadyStatus>(); h.open.mockReturnValueOnce(opening.promise);
		client.send('context', context); client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		client.send('context', { ...context, character: 'Changed Farmer' });
		client.live('live_open', { epoch: nextEpoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
		expect(h.gap).not.toHaveBeenCalled(); expect(h.open).toHaveBeenCalledTimes(1);
		opening.resolve('ready'); await flush();
		expect(client.lines.filter((l) => l.type === 'live_ready')).toEqual([expect.objectContaining({ epoch: nextEpoch, status: 'ready' })]);
		expect(h.gap.mock.invocationCallOrder[0]).toBeLessThan(h.open.mock.invocationCallOrder[1]!);
		sample(client, { epoch: nextEpoch, ctx: 2 }); await flush(); expect(h.commit).toHaveBeenCalledTimes(1); await h.server.close();
	});

	it('keeps historical durable ACK after a real change without restoring the epoch or freshness', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const storing = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(storing.promise); sample(client); await flush();
		client.send('context', { ...context, mapId: 1 }); client.send('heartbeat'); expect(h.gap).not.toHaveBeenCalled();
		storing.resolve('stored'); await flush(); expect(client.lines.at(-1)).toMatchObject({ type: 'live_ack', status: 'stored' });
		expect(h.gap.mock.invocationCallOrder[0]).toBeGreaterThan(h.commit.mock.invocationCallOrder[0]!);
		client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		expect(client.lines.filter((l) => l.type === 'live_ready')).toHaveLength(1);
		vi.advanceTimersByTime(5_000); await flush(); expect(h.gap).toHaveBeenCalledTimes(1); await h.server.close();
	});

	it('never acknowledges closed nonces, and cleans timers during pending open or commit', async () => {
		vi.useFakeTimers();
		for (const operation of ['open', 'commit'] as const) {
			const h = await bridge(); const client = h.connect();
			const waiting = deferred<LiveIngameReadyStatus | LiveIngameAckStatus>();
			if (operation === 'open') { h.open.mockReturnValueOnce(waiting.promise as Promise<LiveIngameReadyStatus>); client.send('context', context); client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); }
			else { await open(client); h.commit.mockReturnValueOnce(waiting.promise as Promise<LiveIngameAckStatus>); sample(client); }
			await flush(); const before = client.lines.length; client.destroy(); waiting.resolve(operation === 'open' ? 'ready' : 'stored'); await flush();
			expect(client.lines).toHaveLength(before); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'disconnect' }));
			await h.server.close(); expect(vi.getTimerCount()).toBe(0);
		}
	});

	it('rejects overlap during durable commit rather than scheduling extra acquisition work', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const waiting = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(waiting.promise); sample(client); await flush(); sample(client);
		expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: 'unexpected_message' });
		waiting.resolve('stored'); await flush(); expect(h.commit).toHaveBeenCalledTimes(1); expect(client.lines.some((l) => l.type === 'live_ack')).toBe(false); await h.server.close();
	});

	it('keeps excluded, unsupported and not-gameplay sources out of the sample consumer', async () => {
		vi.useFakeTimers(); const h = await bridge();
		const absent = h.connect(); absent.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
		expect(absent.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'not_gameplay' }); expect(h.open).not.toHaveBeenCalled(); absent.destroy();
		for (const status of ['unsupported_build', 'source_conflict', 'not_gameplay'] as const) {
			h.open.mockResolvedValueOnce(status); const client = h.connect(); await open(client);
			expect(client.lines.at(-1)).toMatchObject({ type: 'live_ready', status }); sample(client);
			expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: 'unexpected_message' });
		}
		expect(h.commit).not.toHaveBeenCalled(); await h.server.close();
	});

	it('keeps source stale separate from transport heartbeats and discards incomplete samples', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 2 });
		client.live('live_rows', { cursor: 0, part: 0, rows: [[0, 12147, 0]] });
		for (let second = 0; second < 5; second++) { client.send('heartbeat'); vi.advanceTimersByTime(1_000); }
		await flush(); expect(h.commit).not.toHaveBeenCalled(); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'source_stale' })); expect(h.server.clientCount()).toBe(1);
		client.live('live_end', { cursor: 0 }); expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: 'unexpected_message' }); await h.server.close();
	});

	it('accepts a 512-byte CRLF frame and rejects a 513-byte live frame at the consumer boundary', async () => {
		vi.useFakeTimers(); const h = await bridge();
		for (const size of [512, 513]) {
			const client = h.connect(); client.send('context', context);
			const record = { v: 3, type: 'live_open', nonce: client.lines[0]?.nonce, seq: client.seq++, tag: 'live1', epoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE };
			const line = JSON.stringify(record); client.raw(line + ' '.repeat(size - new TextEncoder().encode(line).length) + '\r'); await flush();
			expect(client.lines.at(-1)).toMatchObject(size === 512 ? { type: 'live_ready', status: 'ready' } : { type: 'error', code: 'frame_length' }); client.destroy(); await flush();
		}
		await h.server.close();
	});

	it('rejects missing parts, end without begin, cursor jumps and replay changes before any durable callback', async () => {
		vi.useFakeTimers(); const h = await bridge();
		for (const violation of ['end', 'part', 'count', 'jump'] as const) {
			const client = h.connect(); await open(client);
			if (violation === 'end') client.live('live_end', { cursor: 0 });
			else {
				client.live('live_begin', { cursor: violation === 'jump' ? 2 : 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 2 });
				if (violation === 'part') client.live('live_rows', { cursor: 0, part: 1, rows: [[0, 12147, 0]] });
				if (violation === 'count') client.live('live_end', { cursor: 0 });
			}
			expect(client.lines.at(-1)).toMatchObject({ type: 'error' }); await flush();
		}
		expect(h.commit).not.toHaveBeenCalled();
		const client = h.connect(); await open(client); sample(client); await flush(); sample(client, { slots: 1 }); await flush();
		expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: 'frame_schema' }); expect(h.commit).toHaveBeenCalledTimes(1); await h.server.close();
	});

	it('accepts partial item samples with covered currencies without inventing missing data or an epoch gap', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		client.live('live_begin', { cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'partial', currencies: 'listed', unknown: 1, slots: null, rows: 2 });
		client.live('live_rows', { cursor: 0, part: 0, rows: [[0, 12147, 251], [1, 1, 0]] }); client.live('live_end', { cursor: 0 }); await flush();
		expect(h.commit).toHaveBeenCalledWith(expect.objectContaining({ itemCoverage: 'partial', currencyCoverage: 'listed', freeSlots: null, rows: [[0, 12147, 251], [1, 1, 0]] })); expect(h.gap).not.toHaveBeenCalled(); await h.server.close();
	});

	it('reports unavailable diagnostics before open and returns not_owner without fake stored ACK', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect();
		client.live('live_status', { epoch: null, status: 'unavailable', reason: 'root_unavailable' }); await flush(); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ epoch: null, reason: 'source_missing' }));
		await open(client); h.commit.mockResolvedValueOnce('not_owner'); sample(client, { ctx: 1 }); await flush();
		expect(client.lines.at(-1)).toMatchObject({ type: 'live_ack', status: 'not_owner' }); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'source_missing', epoch })); await h.server.close();
	});

	it('holds selection until the old nonce commit and disconnect gap drain before a replacement open', async () => {
		vi.useFakeTimers(); const h = await bridge(); const first = h.connect(); await open(first);
		const storing = deferred<LiveIngameAckStatus>(); const gapping = deferred<void>();
		h.commit.mockReturnValueOnce(storing.promise); h.gap.mockReturnValueOnce(gapping.promise); sample(first); await flush(); first.destroy();
		const early = h.connect(); await open(early); expect(early.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'source_conflict' }); expect(h.open).toHaveBeenCalledTimes(1); early.destroy();
		storing.resolve('stored'); await flush(); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'disconnect' }));
		const stillEarly = h.connect(); await open(stillEarly); expect(stillEarly.lines.at(-1)).toMatchObject({ status: 'source_conflict' }); stillEarly.destroy();
		gapping.resolve(); await flush(); const replacement = h.connect(); await open(replacement); expect(replacement.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'ready' });
		expect(h.gap.mock.invocationCallOrder[0]).toBeLessThan(h.open.mock.invocationCallOrder[1]!); await h.server.close();
	});

	it('observes failed open/gap calls and suppresses queued ready after a failed durable gap', async () => {
		vi.useFakeTimers(); const h = await bridge(); const failure = new Error('private durable diagnostic');
		const client = h.connect(); h.open.mockRejectedValueOnce(failure); await open(client);
		expect(h.error).toHaveBeenCalledWith(failure); expect(client.lines.some((l) => l.type === 'live_ready')).toBe(false); client.destroy(); await flush();
		const next = h.connect(); await open(next); const gap = deferred<void>(); h.gap.mockReturnValueOnce(gap.promise);
		next.send('context', { ...context, mapId: 1 }); next.live('live_open', { epoch: nextEpoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
		await flush(); gap.reject(failure); await flush();
		expect(h.open).toHaveBeenCalledTimes(2); expect(h.error).toHaveBeenCalledTimes(2);
		expect(next.lines.filter((line) => line.type === 'live_ready')).toHaveLength(1);
		expect(JSON.stringify(next.lines)).not.toContain(failure.message); await h.server.close();
	});

	it('does not complete server close until a pending commit and its disconnect gap are durable', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const commit = deferred<LiveIngameAckStatus>(); const gap = deferred<void>(); h.commit.mockReturnValueOnce(commit.promise); h.gap.mockReturnValueOnce(gap.promise);
		sample(client); await flush(); let closed = false; const closing = h.server.close().then(() => { closed = true; }); await flush();
		expect(closed).toBe(false); expect(h.gap).not.toHaveBeenCalled();
		commit.resolve('stored'); await flush(); expect(h.gap).toHaveBeenCalledTimes(1); expect(closed).toBe(false);
		gap.resolve(); await closing; expect(closed).toBe(true); expect(client.lines.some((line) => line.type === 'live_ack')).toBe(false);
		const replacement = await bridge(); const next = replacement.connect(); await open(next); expect(next.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'ready' }); await replacement.server.close();
	});

	it('anchors sample freshness to reception rather than a delayed commit completion', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		vi.advanceTimersByTime(1_000); const commit = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(commit.promise); sample(client); await flush();
		vi.advanceTimersByTime(3_000); commit.resolve('stored'); await flush();
		vi.advanceTimersByTime(1_999); await flush(); expect(h.gap).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1); await flush(); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'source_stale' })); await h.server.close();
	});

	it('retains a failed gap and prevents a later open until the same obligation is durably reconciled', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const failure = new Error('gap persistence unavailable'); h.gap.mockRejectedValueOnce(failure); h.gap.mockRejectedValueOnce(failure);
		client.send('context', { ...context, mapId: 1 }); await flush(); expect(h.gap).toHaveBeenCalledTimes(1);
		client.live('live_open', { epoch: nextEpoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		expect(h.open).toHaveBeenCalledTimes(1); expect(h.gap).toHaveBeenCalledTimes(2); expect(h.gap.mock.calls[1]?.[0]).toEqual(h.gap.mock.calls[0]?.[0]);
		client.live('live_open', { epoch: nextEpoch, build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		expect(h.gap).toHaveBeenCalledTimes(3); expect(h.open).toHaveBeenCalledTimes(2); expect(client.lines.at(-1)).toMatchObject({ type: 'live_ready', epoch: nextEpoch, status: 'ready' }); await h.server.close();
	});

	it('drains previously disconnected source work and rejects close when its retained gap still fails', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const commit = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(commit.promise); sample(client); await flush(); client.destroy();
		const gapError = new Error('still unavailable'); h.gap.mockRejectedValue(gapError); const closing = h.server.close();
		const rejection = expect(closing).rejects.toThrow('Live source gap has not been durably stored.');
		commit.resolve('stored'); await rejection; expect(h.gap).toHaveBeenCalledTimes(2); expect(h.gap.mock.calls[1]?.[0]).toEqual(h.gap.mock.calls[0]?.[0]);
		h.gap.mockResolvedValue(undefined); await h.server.close(); expect(h.gap).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
	});

	it('captures diagnostic sink exceptions locally and reports them through close without a false receipt', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const observerError = new Error('observer failure'); h.error.mockImplementation(() => { throw observerError; });
		h.commit.mockRejectedValueOnce(new Error('commit failure')); sample(client); await flush();
		expect(client.lines.at(-1)).toMatchObject({ type: 'live_ack', status: 'storage_unavailable' });
		await expect(h.server.close()).rejects.toBe(observerError); expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects new connections while close waits for durable source work', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const commit = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(commit.promise); sample(client); await flush();
		const closing = h.server.close(); const late = h.connect(); expect(late.lines).toEqual([]); expect(h.server.clientCount()).toBe(0);
		commit.resolve('stored'); await closing;
	});

	it('expires immediately when the complete reception date is already stale at durable completion', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect(); await open(client);
		const commit = deferred<LiveIngameAckStatus>(); h.commit.mockReturnValueOnce(commit.promise); sample(client); await flush();
		vi.setSystemTime(Date.now() + 6_000); commit.resolve('stored'); await flush();
		expect(client.lines.at(-1)).toMatchObject({ type: 'live_ack', status: 'stored' }); expect(h.gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'source_stale' })); await h.server.close();
	});

	it('does not let an unselected diagnostic failure invalidate the selected producer', async () => {
		vi.useFakeTimers(); const h = await bridge(); const owner = h.connect(); await open(owner); sample(owner); await flush();
		const diagnostic = h.connect(3, 'nexus', 'AQEBAQEBAQEBAQEBAQEBAQ'); h.gap.mockRejectedValueOnce(new Error('unselected gap failure'));
		diagnostic.live('live_status', { epoch: null, status: 'unavailable', reason: 'root_unavailable' }); await flush();
		sample(owner, { cursor: 1, mode: 'sample', ms: 1 }); await flush(); expect(h.commit).toHaveBeenCalledTimes(2); expect(owner.lines.at(-1)).toMatchObject({ type: 'live_ack', status: 'stored', cursor: 1 }); await h.server.close();
	});

	it('frees the producer lease even when the disconnect gap of a closed channel cannot be stored', async () => {
		vi.useFakeTimers(); const h = await bridge(); const first = h.connect(); await open(first);
		h.gap.mockRejectedValueOnce(new Error('disconnect gap persistence unavailable')); first.destroy(); await flush();
		const replacement = h.connect(3, 'nexus', 'AQEBAQEBAQEBAQEBAQEBAQ'); await open(replacement);
		expect(replacement.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'ready' }); await h.server.close();
	});

	it('frees the lease when a gap already retained by an OPEN channel fails again as the channel closes', async () => {
		vi.useFakeTimers(); const h = await bridge(); const first = h.connect(); await open(first);
		h.gap.mockRejectedValue(new Error('gap persistence unavailable'));
		first.live('live_status', { epoch, status: 'unavailable', reason: 'read_failed' }); await flush();
		first.destroy(); await flush();
		h.gap.mockResolvedValue(undefined);
		const replacement = h.connect(3, 'nexus', 'AQEBAQEBAQEBAQEBAQEBAQ'); await open(replacement);
		expect(replacement.lines.at(-1), 'a retained gap kept the lease: source_conflict until reload').toMatchObject({ type: 'live_ready', status: 'ready' });
		await h.server.close();
	});

	/** A producer that opens its epoch and drops while storage refuses its disconnect gap: the channel closes with the gap unwritten. */
	async function abandon(h: Awaited<ReturnType<typeof bridge>>, round: number): Promise<void> {
		const client = h.connect(3, 'nexus', `${String.fromCharCode(66 + round)}${'A'.repeat(21)}`); await open(client);
		expect(client.lines.at(-1), `producer ${String(round)} was offered live1 and opened`).toMatchObject({ type: 'live_ready', status: 'ready' });
		client.destroy(); await flush();
	}

	it('a closed channel whose gap cannot be stored gives its live seat back, and shutdown still owes the gap', async () => {
		vi.useFakeTimers(); const h = await bridge(); h.gap.mockRejectedValue(new Error('gap persistence unavailable'));
		for (let round = 0; round < 4; round += 1) await abandon(h, round);
		expect(h.gap).toHaveBeenCalledTimes(4); expect(h.error).toHaveBeenCalledTimes(4); expect(h.server.clientCount()).toBe(0);
		// The four seats are free again: the next producer is offered live1 and can open.
		const next = h.connect(3, 'nexus', 'AQEBAQEBAQEBAQEBAQEBAQ'); expect(next.lines.map((l) => l.type)).toEqual(['welcome', 'farming_cap', 'live_cap']);
		await open(next); expect(next.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'ready' });
		// Nothing was dropped: the four gaps are written when storage answers again, at shutdown at the latest.
		h.gap.mockClear(); h.gap.mockResolvedValue(undefined); await h.server.close();
		expect(h.gap.mock.calls.map(([gap]) => gap.sourceInstance).sort()).toEqual(['AQEBAQEBAQEBAQEBAQEBAQ', ...[0, 1, 2, 3].map((round) => `${String.fromCharCode(66 + round)}${'A'.repeat(21)}`)]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps a bounded number of unwritten gaps and reports each one it gives up', async () => {
		vi.useFakeTimers(); const h = await bridge(); h.gap.mockRejectedValue(new Error('gap persistence unavailable'));
		for (let round = 0; round < 6; round += 1) await abandon(h, round);
		const next = h.connect(3, 'nexus', 'AQEBAQEBAQEBAQEBAQEBAQ'); expect(next.lines.map((l) => l.type)).toContain('live_cap');
		const dropped = h.error.mock.calls.map(([error]) => (error as Error).message).filter((message) => message === 'Live source gap was dropped: it could not be stored.');
		expect(dropped, 'the oldest ones beyond the bound are given up, never in silence').toHaveLength(2);
		h.gap.mockClear(); h.gap.mockResolvedValue(undefined); await h.server.close();
		expect(h.gap.mock.calls.map(([gap]) => gap.sourceInstance).sort(), 'the newest four are still written').toEqual([2, 3, 4, 5].map((round) => `${String.fromCharCode(66 + round)}${'A'.repeat(21)}`));
	});

	it('answers live_status with a null epoch after a rejected live_open without closing the connection', async () => {
		vi.useFakeTimers(); const h = await bridge(); const client = h.connect();
		client.live('live_open', { build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }); await flush();
		expect(client.lines.at(-1)).toMatchObject({ type: 'live_ready', status: 'not_gameplay' });
		client.live('live_status', { epoch: null, status: 'unavailable', reason: 'root_unavailable' }); await flush();
		expect(client.lines.some((l) => l.type === 'error')).toBe(false); expect(h.server.clientCount()).toBe(1); await h.server.close();
	});

});
