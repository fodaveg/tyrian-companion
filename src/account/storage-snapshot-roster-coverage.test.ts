import { describe, expect, it } from 'vitest';

import { HttpTransportError, type HttpResponse } from '../core/http';
import { compareStorageSnapshots, isComparableStorageSnapshot } from './storage-delta';
import { StorageSnapshotService } from './storage-snapshot-service';

const LAST_MODIFIED = 'Mon, 01 Sep 2026 00:00:00 GMT';
const bag = (id: number) => ({ bags: [{ id: 9000 + id, size: 20, inventory: [{ id, count: 5 }] }] });

type Answer = { status: number; body: unknown };

function client(roster: Answer, characters: Record<string, Answer>) {
	const requestDetailed = async (path: string): Promise<HttpResponse> => {
		const raw = path.split('?')[0]!;
		if (raw === 'characters') return { status: roster.status, headers: {}, body: roster.body };
		if (raw === 'account/inventory') return { status: 200, headers: { 'last-modified': LAST_MODIFIED }, body: [] };
		if (raw === 'account/bank' || raw === 'account/materials') return { status: 200, headers: {}, body: [] };
		const match = /^characters\/(.+)\/inventory$/u.exec(raw);
		if (match) {
			const answer = characters[decodeURIComponent(match[1]!)]!;
			if (answer.status >= 400) throw new HttpTransportError('http', answer.status, null, `Request failed with status ${answer.status}.`);
			return { status: answer.status, headers: {}, body: answer.body };
		}
		throw new Error(`unexpected ${raw}`);
	};
	return {
		beginOperation: () => ({
			request: async (path: string) => path === 'tokeninfo'
				? { id: 't', name: 'k', permissions: ['account', 'characters', 'inventories'] }
				: { id: 'acc', name: 'n', world: 1, created: '2020-01-01T00:00:00Z', access: [], commander: false },
			requestDetailed,
		}),
	};
}

async function capture(roster: Answer, characters: Record<string, Answer>) {
	const source = client(roster, characters);
	return new StorageSnapshotService(source).captureWithOperation(source.beginOperation() as never);
}

describe('Z4-1 a roster read that answered 206', () => {
	it('is not accepted as a stable boundary and never books the missing character as losses', async () => {
		const before = await capture({ status: 200, body: [{ name: 'A' }, { name: 'B' }] },
			{ A: { status: 200, body: bag(1) }, B: { status: 200, body: bag(2) } });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const after = await capture({ status: 206, body: [{ name: 'A' }] }, { A: { status: 200, body: bag(1) } });
		expect(after.quality).not.toBe('stable');
		expect(after.coverage.sources.characters.status).toBe('partial');
		expect(after.coverage.sources.characters.reason).toBe('partial_response');
		const delta = compareStorageSnapshots(before, after);
		expect(delta.itemChanges.some((change) => change.delta < 0)).toBe(false);
		expect(isComparableStorageSnapshot(after)).toBe(false);
	});

	it('keeps its own gap when a character also fails (the character mirror does not replace it)', async () => {
		const snapshot = await capture({ status: 206, body: [{ name: 'A' }, { name: 'B' }] },
			{ A: { status: 200, body: bag(1) }, B: { status: 500, body: null } });
		expect(snapshot.coverage.sources.characters.reason).toBe('partial_response');
		expect(snapshot.coverage.characters.B?.status).toBe('partial');
	});
});

describe('Z4-1 a single character that failed on a whole roster', () => {
	it('still mirrors on the aggregate source and stays comparable', async () => {
		const snapshot = await capture({ status: 200, body: [{ name: 'A' }, { name: 'B' }] },
			{ A: { status: 200, body: bag(1) }, B: { status: 404, body: null } });
		expect(snapshot.coverage.sources.characters.reason).toBe('missing_character');
		expect(isComparableStorageSnapshot(snapshot)).toBe(true);
	});
});
