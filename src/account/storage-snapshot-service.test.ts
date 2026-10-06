import { describe, expect, it, vi } from 'vitest';

import type { HttpResponse } from '../core/http';
import { HttpTransportError } from '../core/http';
import {
	bankFixture,
	characterInventoryFixture,
	characterName,
	completePassFixture,
} from './__fixtures__/storage';
import {
	InvalidSnapshotPayloadError,
	SnapshotCapabilityError,
	type ItemHolding,
} from './storage-snapshot-model';
import {
	compareStorageSnapshots,
	isComparableStorageSnapshot,
	isInventoryAdvisorStorageSnapshot,
} from './storage-delta';
import { parseCharacterInventory } from './storage-snapshot-parsers';
import { StorageSnapshotService, type StorageSnapshotCaptureProgress, type StorageSnapshotPassTelemetry } from './storage-snapshot-service';

type PassFixture = Record<string, unknown>;

const requiredPermissions = new Set(['account', 'characters', 'inventories']);
const allPermissions = new Set([...requiredPermissions, 'wallet', 'tradingpost']);
const accountId = 'fixture-account-id';
const requiredRestrictedUrls = [
	'/v2/account',
	'/v2/characters',
	`/v2/characters/${encodeURIComponent(characterName)}/inventory`,
	'/v2/account/inventory',
	'/v2/account/bank',
	'/v2/account/materials',
];

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, body };
}

function clientFor(
	passes: PassFixture[],
	opts: {
		seen?: string[];
		onRequest?: (path: string) => Promise<void>;
		permissions?: ReadonlySet<string>;
		tokenId?: string;
		tokenIds?: string[];
		accountId?: string;
		accountIds?: string[];
		urls?: string[];
	} = {},
): { client: { beginOperation: () => Operation }; beginCalls: () => number } {
	const callsByPath = new Map<string, number>();
	let beginCount = 0;
	const requestDetailed: Operation['requestDetailed'] = async (path) => {
		opts.seen?.push(path);
		await opts.onRequest?.(path);
		const rawPath = path.split('?')[0];
		if (!rawPath) throw new Error('Missing fixture path.');
		const call = callsByPath.get(rawPath) ?? 0;
		callsByPath.set(rawPath, call + 1);
		const pass = passes[Math.min(call, passes.length - 1)];
		if (!pass || !(rawPath in pass)) throw new Error(`Missing fixture for ${rawPath}.`);
		const value = pass[rawPath];
		if (value instanceof Error) throw value;
		return isHttpResponse(value) ? value : response(200, value);
	};
	return {
		client: {
			beginOperation: () => {
				const operationIndex = beginCount;
				beginCount += 1;
				return {
					request: async (path) => {
						if (path === 'tokeninfo') {
							return {
								id: opts.tokenIds?.[operationIndex] ?? opts.tokenId ?? 'fixture-token-id',
								name: 'Fixture key',
								permissions: [...(opts.permissions ?? requiredPermissions)],
								urls: opts.urls,
							};
						}
						if (path === 'account') {
							return {
								id: opts.accountIds?.[operationIndex] ?? opts.accountId ?? accountId,
								name: 'Fixture account',
								world: 1001,
								created: '2020-01-01T00:00:00Z',
								access: ['GuildWars2'],
								commander: false,
							};
						}
						throw new Error(`Unexpected context path: ${path}`);
					},
					requestDetailed,
				};
			},
		},
		beginCalls: () => beginCount,
	};
}

interface Operation {
	request(path: string, retryStatuses?: ReadonlySet<number>): Promise<unknown>;
	requestDetailed(path: string, retryStatuses?: ReadonlySet<number>): Promise<HttpResponse>;
}

function isHttpResponse(value: unknown): value is HttpResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		'status' in value &&
		'headers' in value &&
		'body' in value
	);
}

function passWith(overrides: PassFixture = {}): PassFixture {
	return { ...completePassFixture, ...overrides };
}

describe('StorageSnapshotService', () => {
	it('captures every item store for the advisor without requiring bank or materials and without the wallet', async () => {
		const seen: string[] = [];
		const fixture = clientFor([passWith()], { seen });
		const operation = fixture.client.beginOperation();
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(operation);

		expect(new Set(seen.map((path) => path.split('?')[0]))).toEqual(new Set([
			'characters',
			'account/inventory',
			'account/bank',
			'account/materials',
			`characters/${encodeURIComponent(characterName)}/inventory`,
		]));
		expect(seen.map((path) => path.split('?')[0])).not.toContain('account/wallet');
		expect(snapshot).toMatchObject({
			quality: 'stable',
			passes: 2,
			coverage: {
				sources: {
					characters: { status: 'complete' },
					shared_inventory: { status: 'complete' },
					bank: { status: 'complete' },
					materials: { status: 'complete' },
					wallet: { status: 'skipped', reason: 'not_requested' },
				},
			},
		});
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
		expect(isComparableStorageSnapshot(snapshot)).toBe(true);
	});

	it('H18.39 (David, 26 sep 2026): reports real roster, per-character and per-store durations, never a name or an id', async () => {
		const fixture = clientFor([passWith(), passWith()]);
		let clock = 0;
		const telemetry: StorageSnapshotPassTelemetry[] = [];
		const snapshot = await new StorageSnapshotService(fixture.client, { now: () => { clock += 1; return clock; } })
			.captureInventoryWithOperation(
				fixture.client.beginOperation(), undefined, (pass) => telemetry.push(pass),
			);
		// The default fixture's core is complete on the first pass, so the advisor still runs its
		// confirmatory second pass (`passes: 2` in the neighboring test above): one telemetry entry
		// per pass, in order.
		expect(snapshot.passes).toBe(2);
		expect(telemetry.map((pass) => pass.pass)).toEqual([1, 2]);
		for (const pass of telemetry) {
			expect(pass.durationMs).toBeGreaterThan(0);
			expect(pass.roster.characterCount).toBe(1);
			expect(pass.roster.durationMs).toBeGreaterThan(0);
			// One entry per character, in roster order — an index, never the character's own name.
			expect(pass.characters).toHaveLength(1);
			expect(pass.characters[0]).toMatchObject({ index: 0 });
			expect(pass.characters[0]!.durationMs).toBeGreaterThan(0);
			expect(pass.characters[0]!.itemCount).toBeGreaterThan(0);
			// Every account store this fixture's token can reach: shared inventory, bank, materials.
			expect(pass.stores.map((store) => store.source).sort()).toEqual(['bank', 'materials', 'shared_inventory']);
			for (const store of pass.stores) expect(store.durationMs).toBeGreaterThan(0);
			expect(JSON.stringify(pass)).not.toContain(characterName);
		}
	});

	it('carries free slots per bag, character, and bank into the finished snapshot (H18.15)', async () => {
		const fixture = clientFor([passWith()]);
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot.freeSlots).toEqual({
			bank: { total: 2, free: 1 },
			sharedInventory: { total: 2, free: 1 },
			characterBags: [
				{ character: characterName, bagIndex: 0, bagItemId: 1_001, total: 20, free: 19 },
			],
		});
	});

	it('keeps the advisor core usable when optional stores fail twice', async () => {
		const fixture = clientFor([passWith()], {
			onRequest: async (path) => {
				if (path.startsWith('account/bank') || path.startsWith('account/materials')) {
					throw new HttpTransportError('http', 503, null, 'Request failed with status 503.');
				}
			},
		});
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot.coverage.sources.bank.status).not.toBe('complete');
		expect(snapshot.coverage.sources.materials.status).not.toBe('complete');
		expect(snapshot).toMatchObject({ quality: 'unstable', passes: 2 });
		expect(snapshot.holdings.every(({ location }) =>
			location.source === 'character' || location.source === 'shared_inventory')).toBe(true);
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
	});

	it.each([
		['account/bank', 'bank'],
		['account/materials', 'materials'],
		['commerce/delivery', 'commerce_delivery'],
	] as const)('degrades an advisor %s 403 without discarding bags and shared inventory', async (path, source) => {
		const fixture = clientFor([passWith()], {
			permissions: allPermissions,
			onRequest: async (requested) => {
				if (requested.startsWith(path)) {
					throw new HttpTransportError('http', 403, null, 'Forbidden.');
				}
			},
		});
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot.coverage.sources[source]).toEqual({
			status: 'partial', reason: 'unavailable',
			diagnostic: { kind: 'http', status: 403, retryAfterMs: null },
		});
		expect(snapshot.coverage.sources.shared_inventory).toEqual({ status: 'complete' });
		expect(snapshot.coverage.sources.characters).toEqual({ status: 'complete' });
		expect(snapshot.passes).toBe(1);
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
	});

	it('recovers a transient core failure despite a non-retryable optional limitation', async () => {
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const first = passWith({
			[inventoryPath]: new HttpTransportError('http', 503, null, 'Unavailable.'),
		});
		const fixture = clientFor([first, passWith()], {
			onRequest: async (path) => {
				if (path.startsWith('account/bank')) {
					throw new HttpTransportError('http', 403, null, 'Forbidden.');
				}
			},
		});

		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'unstable', passes: 2,
			coverage: { sources: {
				characters: { status: 'complete' }, shared_inventory: { status: 'complete' },
				bank: { status: 'partial', reason: 'unavailable', diagnostic: { status: 403 } },
			} },
		});
		expect(snapshot.passCoverages[0]?.sources.characters.status).toBe('partial');
		expect(snapshot.passCoverages[1]?.sources.characters).toEqual({ status: 'complete' });
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
		expect(isComparableStorageSnapshot(snapshot)).toBe(false);
	});

	it('still rejects a 401 from an optional advisor store because the pinned credential is invalid', async () => {
		const fixture = clientFor([passWith()], {
			onRequest: async (path) => {
				if (path.startsWith('account/bank')) {
					throw new HttpTransportError('http', 401, null, 'Unauthorized.');
				}
			},
		});
		await expect(new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation()))
			.rejects.toMatchObject({ status: 401 });
	});

	describe('advisor character concurrency', () => {
		it('reads up to four character inventories at once for the advisor scope, under the global limit, in both passes', async () => {
			const names = advisorRoster(8);
			const pass = rosterPass(names);
			let passIndex = -1;
			let active = 0;
			let activeCharacters = 0;
			const maxActive: number[] = [];
			const maxCharacters: number[] = [];
			const fixture = clientFor([pass, pass], {
				onRequest: async (path) => {
					if (isRosterPath(path)) {
						passIndex += 1;
						maxActive[passIndex] = 0;
						maxCharacters[passIndex] = 0;
					}
					const isCharacter = isCharacterInventoryPath(path);
					active += 1;
					maxActive[passIndex] = Math.max(maxActive[passIndex]!, active);
					if (isCharacter) {
						activeCharacters += 1;
						maxCharacters[passIndex] = Math.max(maxCharacters[passIndex]!, activeCharacters);
						// A character answers one macrotask later, after every account store already has.
						await macrotasks(1);
						activeCharacters -= 1;
					} else {
						await Promise.resolve();
					}
					active -= 1;
				},
			});

			const snapshot = await new StorageSnapshotService(fixture.client)
				.captureInventoryWithOperation(fixture.client.beginOperation());

			expect(snapshot).toMatchObject({ quality: 'stable', passes: 2 });
			expect(maxCharacters).toEqual([4, 4]);
			expect(maxActive).toHaveLength(2);
			for (const max of maxActive) expect(max).toBeLessThanOrEqual(6);
		});

		it('reports each character its own index and item count when requests finish out of roster order around a store', async () => {
			const names = advisorRoster(4);
			// Character `index` carries `index + 1` items, so no two characters share a count.
			const pass = rosterPass(names, (index) => index + 1, {
				'account/bank': Array.from({ length: 5 }, (_value, slot) => ({ id: 7_000 + slot, count: 1 })),
			});
			const expected = names.map((name, index) => ({
				index,
				itemCount: parseCharacterInventory(pass[characterInventoryPath(name)], name).length,
			}));
			const finished: string[][] = [];
			const fixture = clientFor([pass, pass], {
				onRequest: async (path) => {
					if (isRosterPath(path)) finished.push([]);
					const log = finished.at(-1)!;
					if (isCharacterInventoryPath(path)) {
						// Reverse roster order: character 3 answers after 2 macrotasks, character 0 after 8.
						const index = names.indexOf(characterOfPath(path));
						await macrotasks((names.length - index) * 2);
						log.push(`character ${index}`);
					} else if (path.startsWith('account/bank')) {
						// Between characters 2 (4 macrotasks) and 1 (6 macrotasks).
						await macrotasks(5);
						log.push('bank');
					}
				},
			});
			let clock = 0;
			const telemetry: StorageSnapshotPassTelemetry[] = [];

			await new StorageSnapshotService(fixture.client, { now: () => { clock += 1; return clock; } })
				.captureInventoryWithOperation(fixture.client.beginOperation(), undefined, (entry) => telemetry.push(entry));

			expect(telemetry.map((entry) => entry.pass)).toEqual([1, 2]);
			for (const entry of telemetry) {
				expect(
					[...entry.characters]
						.sort((left, right) => left.index - right.index)
						.map(({ index, itemCount }) => ({ index, itemCount })),
				).toEqual(expected);
				expect(entry.stores.find((store) => store.source === 'bank')?.itemCount).toBe(5);
				// The entries land in completion order, which here is the reverse of the roster.
				expect(entry.characters.map((character) => character.index)).toEqual([3, 2, 1, 0]);
			}
			const reverseAroundBank = ['character 3', 'character 2', 'bank', 'character 1', 'character 0'];
			expect(finished).toEqual([reverseAroundBank, reverseAroundBank]);
		});

		it('recovers a timeout among parallel characters with a second pass, and never repeats a 429', async () => {
			const names = advisorRoster(8);
			const failingPath = characterInventoryPath(names[5]!);
			const slowCharacters = async (path: string): Promise<void> => {
				if (isCharacterInventoryPath(path)) await macrotasks(1);
			};

			const timeoutSeen: string[] = [];
			const timedOut = clientFor([
				rosterPass(names, () => 1, {
					[failingPath]: new HttpTransportError('timeout', null, null, 'Timed out.'),
				}),
				rosterPass(names),
			], { seen: timeoutSeen, onRequest: slowCharacters });
			const recovered = await new StorageSnapshotService(timedOut.client)
				.captureInventoryWithOperation(timedOut.client.beginOperation());

			expect(recovered).toMatchObject({ quality: 'unstable', passes: 2 });
			expect(recovered.passCoverages[0]?.characters[names[5]!]).toMatchObject({
				status: 'partial', diagnostic: { kind: 'timeout' },
			});
			expect(recovered.passCoverages[1]?.characters[names[5]!]).toEqual({ status: 'complete' });
			for (const name of names) {
				expect(timeoutSeen.filter((path) => path.startsWith(`${characterInventoryPath(name)}?`))).toHaveLength(2);
			}

			const rateLimitSeen: string[] = [];
			const rateLimited = clientFor([
				rosterPass(names, () => 1, {
					[failingPath]: new HttpTransportError('http', 429, 2_000, 'Rate limited.'),
				}),
				rosterPass(names),
			], { seen: rateLimitSeen, onRequest: slowCharacters });
			const limited = await new StorageSnapshotService(rateLimited.client)
				.captureInventoryWithOperation(rateLimited.client.beginOperation());

			expect(limited).toMatchObject({ quality: 'partial', passes: 1 });
			expect(limited.coverage.sources.characters).toMatchObject({
				status: 'partial', diagnostic: { status: 429, retryAfterMs: 2_000 },
			});
			// The siblings already in flight still finish, and nobody is asked a second time.
			for (const name of names) {
				expect(rateLimitSeen.filter((path) => path.startsWith(`${characterInventoryPath(name)}?`))).toHaveLength(1);
			}
			expect(rateLimitSeen.filter(isRosterPath)).toHaveLength(1);
		});

		it('qualifies two passes with the same content as stable when their characters finish in a different order', async () => {
			const names = advisorRoster(4);
			const pass = rosterPass(names, (index) => index + 1);
			let passIndex = -1;
			const fixture = clientFor([pass, pass], {
				onRequest: async (path) => {
					if (isRosterPath(path)) passIndex += 1;
					if (!isCharacterInventoryPath(path)) return;
					const index = names.indexOf(characterOfPath(path));
					// Pass 1 finishes in roster order, pass 2 in the reverse one.
					await macrotasks(passIndex === 0 ? index + 1 : names.length - index);
				},
			});
			const telemetry: StorageSnapshotPassTelemetry[] = [];

			const snapshot = await new StorageSnapshotService(fixture.client)
				.captureInventoryWithOperation(fixture.client.beginOperation(), undefined, (entry) => telemetry.push(entry));

			expect(snapshot).toMatchObject({ quality: 'stable', passes: 2 });
			expect(snapshot.holdings.filter(({ location }) => location.source === 'character')).toHaveLength(
				names.reduce((total, name) => total + parseCharacterInventory(pass[characterInventoryPath(name)], name).length, 0),
			);
			// Without this the test would prove nothing: both passes really did push in opposite orders.
			expect(telemetry.map((entry) => entry.characters.map((character) => character.index))).toEqual([
				[0, 1, 2, 3],
				[3, 2, 1, 0],
			]);
		});

		it('never lets the completed character count go down and ends at twice the roster when characters finish out of order', async () => {
			const names = advisorRoster(8);
			const pass = rosterPass(names);
			const fixture = clientFor([pass, pass], {
				onRequest: async (path) => {
					if (!isCharacterInventoryPath(path)) return;
					await macrotasks(names.length - names.indexOf(characterOfPath(path)));
				},
			});
			const ticks: StorageSnapshotCaptureProgress[] = [];

			await new StorageSnapshotService(fixture.client).captureInventoryWithOperation(
				fixture.client.beginOperation(),
				(progress) => ticks.push(progress),
			);

			for (let index = 1; index < ticks.length; index += 1) {
				expect(ticks[index]!.characters.completed).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.completed);
				expect(ticks[index]!.characters.total).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.total);
			}
			for (const tick of ticks) expect(tick.characters.completed).toBeLessThanOrEqual(tick.characters.total);
			expect(ticks.at(-1)!.characters).toEqual({ completed: 2 * names.length, total: 2 * names.length });
		});
	});

	it('keeps two divergent advisor observations as limited evidence without a third pass', async () => {
		const changing = [1, 2].map((count) => passWith({
			'account/inventory': [{ id: 2_002, count }],
		}));
		const operationFixture = clientFor(changing);
		const operation = operationFixture.client.beginOperation();
		const snapshot = await new StorageSnapshotService(operationFixture.client)
			.captureInventoryWithOperation(operation);

		expect(snapshot).toMatchObject({
			quality: 'unstable',
			passes: 2,
			availableByItem: { '2002': 2 },
			coverage: { sources: {
				characters: { status: 'complete' },
				shared_inventory: { status: 'complete' },
			} },
		});
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
		expect(isComparableStorageSnapshot(snapshot)).toBe(false);
	});

	it.each([
		['character to bank', 'character', 'bank'],
		['character to materials', 'character', 'materials'],
		['bank to character', 'bank', 'character'],
		['bank to materials', 'bank', 'materials'],
		['materials to character', 'materials', 'character'],
		['materials to bank', 'materials', 'bank'],
	] as const)(
		'keeps a split or merged stack neutral when it moves from %s',
		async (_label, from, to) => {
			const service = new StorageSnapshotService(
				clientFor([
					passWithAccountItem(from),
					passWithAccountItem(from),
					passWithAccountItem(to),
					passWithAccountItem(to),
				], { permissions: allPermissions }).client,
			);
			const before = await service.capture();
			const after = await service.capture();
			const delta = compareStorageSnapshots(before, after);
			const beforeHoldings = accountItemHoldings(from);
			const afterHoldings = accountItemHoldings(to);

			expect({
				beforeHoldings: before.holdings.filter((holding) => holding.itemId === 777),
				afterHoldings: after.holdings.filter((holding) => holding.itemId === 777),
				delta: {
					status: delta.status,
					itemChanges: delta.itemChanges,
					availabilityChanges: delta.availabilityChanges,
					composition: delta.compositionChanges.filter(
						(change) => change.kind === 'item' && change.id === 777,
					),
				},
			}).toEqual({
				beforeHoldings,
				afterHoldings,
				delta: {
					status: 'comparable',
					itemChanges: [],
					availabilityChanges: [],
					composition: [{
						kind: 'item',
						id: 777,
						before: accountItemComposition(from),
						after: accountItemComposition(to),
					}],
				},
			});
		},
	);

	it('pins one operation, encodes names, pins the schema, and builds availability totals', async () => {
		const seen: string[] = [];
		const fixture = clientFor([passWith(), passWith()], { seen, permissions: allPermissions });
		const snapshot = await new StorageSnapshotService(fixture.client).capture();

		expect(fixture.beginCalls()).toBe(1);
		expect(seen).toHaveLength(14);
		expect(seen.every((path) => path.includes('?v=2024-07-20T01%3A00%3A00.000Z'))).toBe(true);
		expect(seen).toContain(
			`characters/${encodeURIComponent(characterName)}/inventory?v=2024-07-20T01%3A00%3A00.000Z`,
		);
			expect(snapshot).toMatchObject({
			accountId,
			quality: 'stable',
			passes: 2,
			availableByItem: {
				'2001': 2,
				'2002': 3,
				'2003': 4,
				'2004': 5,
				'2005': 6,
			},
			ownedByItem: {
				'1001': 1,
				'2001': 2,
				'2002': 3,
				'2003': 4,
				'2004': 5,
				'2005': 6,
				'3001': 1,
				'4001': 1,
			},
			currencyById: { '1': { total: 13_023, wallet: 12_345, delivery: 678 } },
		});
		expect(snapshot.snapshotId).toBeTruthy();
		expect(snapshot.startedAt).toBeTruthy();
		expect(snapshot.completedAt).toBeTruthy();
		expect(snapshot.availableByItem['1001']).toBeUndefined();
		expect(snapshot.availableByItem['3001']).toBeUndefined();
		expect(snapshot.availableByItem['4001']).toBeUndefined();
		for (const [itemId, quantity] of Object.entries(snapshot.availableByItem)) {
			expect(snapshot.ownedByItem[itemId]).toBeGreaterThanOrEqual(quantity);
		}
	});

	it('never coalesces verified contexts from different keys or accounts', async () => {
		const roster = Array.from({ length: 8 }, (_value, index) => `Alt ${index}`);
		const inventoryRoutes = Object.fromEntries(
			roster.map((name) => [`characters/${encodeURIComponent(name)}/inventory`, { bags: [] }]),
		);
		const pass = passWith({ characters: roster, ...inventoryRoutes });
		let active = 0;
		let maxActive = 0;
		let activeCharacters = 0;
		let maxCharacters = 0;
		const fixture = clientFor([pass, pass, pass, pass], {
			tokenIds: ['token-a', 'token-b'],
			accountIds: ['account-a', 'account-b'],
			onRequest: async (path) => {
				const isCharacter = path.startsWith('characters/') && path.includes('/inventory');
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (isCharacter) {
					activeCharacters += 1;
					maxCharacters = Math.max(maxCharacters, activeCharacters);
				}
				await Promise.resolve();
				active -= 1;
				if (isCharacter) activeCharacters -= 1;
			},
		});
		const service = new StorageSnapshotService(fixture.client);
		const snapshots = await Promise.all([service.capture(), service.capture()]);

		expect(snapshots.map((snapshot) => snapshot.accountId).sort()).toEqual([
			'account-a',
			'account-b',
		]);
		expect(snapshots[0]?.snapshotId).not.toBe(snapshots[1]?.snapshotId);
		expect(maxActive).toBeLessThanOrEqual(6);
		expect(maxCharacters).toBeLessThanOrEqual(4);
	});

	it('marks unchanged ownership with moved placement separately', async () => {
		const movedBank = [null, bankFixture[0]];
		const fixture = clientFor([
			passWith({ 'account/bank': bankFixture }),
			passWith({ 'account/bank': movedBank }),
		]);

		await expect(
			new StorageSnapshotService(fixture.client).capture(),
		).resolves.toMatchObject({ quality: 'stable_owned_placement_changed', passes: 2 });
	});

	it('uses a third pass and requires consecutive ownership equality', async () => {
		const fixtures = [1, 2, 2].map((count) =>
			passWith({ 'account/bank': [{ id: 2_003, count }] }),
		);
		const stable = await new StorageSnapshotService(clientFor(fixtures).client).capture();

		expect(stable).toMatchObject({ quality: 'stable', passes: 3, ownedByItem: { '2003': 2 } });

		const changing = [1, 2, 3].map((count) =>
			passWith({ 'account/bank': [{ id: 2_003, count }] }),
		);
		await expect(
			new StorageSnapshotService(clientFor(changing).client).capture(),
		).resolves.toMatchObject({ quality: 'unstable', passes: 3, ownedByItem: { '2003': 3 } });
	});

	it('uses canonical order-independent fingerprints', async () => {
		const secondCharacter = 'Boreal Dos';
		const inventory = { bags: [{ id: 9_001, inventory: [] }] };
		const inventoryPath = `characters/${encodeURIComponent(secondCharacter)}/inventory`;
		const first = passWith({
			characters: [characterName, secondCharacter],
			[inventoryPath]: inventory,
		});
		const second = passWith({
			characters: [secondCharacter, characterName],
			[inventoryPath]: inventory,
		});

		await expect(
			new StorageSnapshotService(clientFor([first, second]).client).capture(),
		).resolves.toMatchObject({ quality: 'stable', passes: 2 });
	});

	it('keeps repeated partial coverage blocked but recovers after two complete consecutive passes', async () => {
		const partial = passWith({ 'account/bank': response(206, bankFixture) });
		await expect(
			new StorageSnapshotService(clientFor([partial, partial]).client).capture(),
		).resolves.toMatchObject({
			quality: 'partial',
			coverage: { sources: { bank: { status: 'partial', reason: 'partial_response' } } },
		});

		const changedPartial = passWith({
			'account/bank': response(206, [{ id: 2_003, count: 1 }]),
		});
		const laterComplete = passWith({ 'account/bank': [{ id: 2_003, count: 2 }] });
		await expect(
			new StorageSnapshotService(
				clientFor([changedPartial, laterComplete, laterComplete]).client,
			).capture(),
		).resolves.toMatchObject({
			quality: 'stable',
			passes: 3,
			coverage: { sources: { bank: { status: 'complete' } } },
		});

	});

	it('qualifies a capture whose only hole is a character answering 404', async () => {
		const missingCharacter = passWith({
			[`characters/${encodeURIComponent(characterName)}/inventory`]: new HttpTransportError(
				'http',
				404,
				null,
				'Request failed with status 404.',
			),
		});

		// No extra pass can fill a 404, so the capture stays usable as a session boundary
		// and hands the hole to the delta as coverage evidence.
		await expect(
			new StorageSnapshotService(clientFor([missingCharacter, missingCharacter]).client).capture(),
		).resolves.toMatchObject({
			quality: 'stable',
			passes: 2,
			coverage: {
				sources: { characters: { status: 'partial', reason: 'missing_character' } },
				characters: {
					[characterName]: {
						status: 'partial',
						reason: 'missing_character',
						diagnostic: { kind: 'http', status: 404, retryAfterMs: null },
					},
				},
			},
		});
	});

	it('keeps two transiently partial advisor observations fail-closed', async () => {
		const unavailableRoster = passWith({
			characters: new HttpTransportError('http', 500, null, 'Unavailable.'),
		});
		const fixture = clientFor([unavailableRoster, unavailableRoster]);
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'partial',
			passes: 2,
			coverage: {
				sources: { characters: { status: 'partial', reason: 'unavailable' } },
				characters: {},
			},
		});
		expect(snapshot.passCoverages.map((coverage) => coverage.sources.characters)).toEqual([
			{
				status: 'partial',
				reason: 'unavailable',
				diagnostic: { kind: 'http', status: 500, retryAfterMs: null },
			},
			{
				status: 'partial',
				reason: 'unavailable',
				diagnostic: { kind: 'http', status: 500, retryAfterMs: null },
			},
		]);
	});

	it.each([
		['timeout', new HttpTransportError('timeout', null, null, 'Timed out.')],
		['partial response', response(206, characterInventoryFixture)],
	] as const)('recovers one transient %s into usable but unstable advisor evidence', async (
		_label, transient,
	) => {
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const fixture = clientFor([
			passWith({ [inventoryPath]: transient }),
			passWith(),
		]);

		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'unstable', passes: 2,
			coverage: {
				sources: { characters: { status: 'complete' }, shared_inventory: { status: 'complete' } },
				characters: { [characterName]: { status: 'complete' } },
			},
		});
		expect(snapshot.passCoverages[0]?.characters[characterName]?.status).toBe('partial');
		expect(snapshot.passCoverages[1]?.characters[characterName]).toEqual({ status: 'complete' });
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
		expect(isComparableStorageSnapshot(snapshot)).toBe(false);
	});

	it('returns a first-pass 429 immediately so the wrapper can arm its cooldown', async () => {
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const seen: string[] = [];
		const rateLimited = passWith({
			[inventoryPath]: new HttpTransportError('http', 429, 2_000, 'Rate limited.'),
		});
		const fixture = clientFor([rateLimited, passWith()], { seen });

		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({ quality: 'partial', passes: 1 });
		expect(snapshot.coverage.sources.characters).toMatchObject({
			status: 'partial', diagnostic: { status: 429, retryAfterMs: 2_000 },
		});
		expect(seen.filter((path) => path.startsWith(`${inventoryPath}?`))).toHaveLength(1);
	});

	it('requires two complete equivalent advisor observations before claiming stability', async () => {
		const seen: string[] = [];
		const fixture = clientFor([passWith()], { seen });
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'stable',
			passes: 2,
			coverage: {
				sources: { characters: { status: 'complete' }, shared_inventory: { status: 'complete' } },
				characters: { [characterName]: { status: 'complete' } },
			},
		});
		expect(snapshot.passCoverages).toHaveLength(2);
		expect(seen).toHaveLength(10);
	});

	it('withholds advisor stability when ownership is equal but placement changes', async () => {
		const movedBank = [null, bankFixture[0]];
		const fixture = clientFor([
			passWith({ 'account/bank': bankFixture }),
			passWith({ 'account/bank': movedBank }),
		]);

		await expect(new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation()))
			.resolves.toMatchObject({ quality: 'stable_owned_placement_changed', passes: 2 });
	});

	it('does not launch another advisor observation after a partial second pass', async () => {
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const seen: string[] = [];
		const second = passWith({
			[inventoryPath]: new HttpTransportError('http', 429, 2_000, 'Rate limited.'),
		});
		const fixture = clientFor([passWith(), second, passWith()], { seen });

		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'partial', passes: 2,
			coverage: { sources: { characters: {
				status: 'partial', reason: 'unavailable',
				diagnostic: { kind: 'http', status: 429, retryAfterMs: 2_000 },
			} } },
		});
		expect(seen.filter((path) => path.startsWith(`${inventoryPath}?`))).toHaveLength(2);
	});

	it('rejects duplicate roster entries instead of double-counting a character', async () => {
		const duplicateRoster = passWith({ characters: [characterName, characterName] });
		await expect(
			new StorageSnapshotService(clientFor([duplicateRoster]).client).capture(),
		).rejects.toBeInstanceOf(InvalidSnapshotPayloadError);
	});

	it('validates every required URL restriction, including the dynamic character route', async () => {
		const withoutBank = clientFor([passWith()], {
			urls: requiredRestrictedUrls.filter((url) => url !== '/v2/account/bank'),
		});
		await expect(new StorageSnapshotService(withoutBank.client).capture()).rejects.toMatchObject({
			missingScopes: ['url:/v2/account/bank'],
		});

		const withoutCharacterInventory = clientFor([passWith()], {
			urls: requiredRestrictedUrls.filter((url) => !url.includes('/inventory') || url.includes('/account/')),
		});
		await expect(
			new StorageSnapshotService(withoutCharacterInventory.client).capture(),
		).rejects.toMatchObject({
			missingScopes: [`url:/v2/characters/${encodeURIComponent(characterName)}/inventory`],
		});
	});

	it('skips URL-restricted optional sources without aborting a valid inventory snapshot', async () => {
		const fixture = clientFor([passWith(), passWith()], {
			permissions: allPermissions,
			urls: requiredRestrictedUrls,
		});
		await expect(new StorageSnapshotService(fixture.client).capture()).resolves.toMatchObject({
			quality: 'stable',
			coverage: {
				sources: {
					wallet: { status: 'skipped', reason: 'url_restricted' },
					commerce_delivery: { status: 'skipped', reason: 'url_restricted' },
				},
			},
		});
	});

	it('skips optional capabilities and rejects missing required ones before network', async () => {
		const fixture = clientFor([passWith(), passWith()]);
		const snapshot = await new StorageSnapshotService(fixture.client).capture();
		expect(snapshot.coverage.sources.wallet).toEqual({
			status: 'skipped',
			reason: 'missing_scope',
		});
		expect(snapshot.coverage.sources.commerce_delivery).toEqual({
			status: 'skipped',
			reason: 'missing_scope',
		});

		const blocked = clientFor([passWith()], {
			permissions: new Set(['account', 'characters']),
		});
		await expect(
			new StorageSnapshotService(blocked.client).capture(),
		).rejects.toBeInstanceOf(SnapshotCapabilityError);
		expect(blocked.beginCalls()).toBe(1);
	});

	it('coalesces concurrent captures and respects global and character concurrency limits', async () => {
		const roster = Array.from({ length: 8 }, (_value, index) => `Person ${index}`);
		const inventoryRoutes = Object.fromEntries(
			roster.map((name) => [`characters/${encodeURIComponent(name)}/inventory`, { bags: [] }]),
		);
		const pass = passWith({ characters: roster, ...inventoryRoutes });
		let active = 0;
		let maxActive = 0;
		let activeCharacters = 0;
		let maxCharacters = 0;
		const fixture = clientFor([pass, pass], {
			onRequest: async (path) => {
				const isCharacter = path.startsWith('characters/') && path.includes('/inventory');
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (isCharacter) {
					activeCharacters += 1;
					maxCharacters = Math.max(maxCharacters, activeCharacters);
				}
				await Promise.resolve();
				active -= 1;
				if (isCharacter) activeCharacters -= 1;
			},
		});
		const service = new StorageSnapshotService(fixture.client);
		const first = service.capture();
		const second = service.capture();

		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(firstSnapshot.snapshotId).toBe(secondSnapshot.snapshotId);
		expect(fixture.beginCalls()).toBe(2);
		expect(maxActive).toBeLessThanOrEqual(6);
		expect(maxCharacters).toBeLessThanOrEqual(4);
	});

	it('a capture that must start after an instant waits out the one already running instead of adopting it', async () => {
		// Real incident (6 oct 2026): a session start joined the snapshot the detection arm had begun
		// seconds earlier, so its baseline started before its own request and the state machine
		// rejected the confirmation.
		const bagsPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let blocked = false;
		const fixture = clientFor([passWith(), passWith()], {
			onRequest: async (path) => {
				if (path.split('?')[0] === bagsPath && !blocked) {
					blocked = true;
					await gate;
				}
			},
		});
		const service = new StorageSnapshotService(fixture.client);
		const running = service.capture();
		await vi.waitFor(() => { expect(blocked).toBe(true); });
		const floor = Date.now() + 1;
		const joinedByDefault = service.capture();
		const later = service.captureWithOperation(fixture.client.beginOperation(), { startedNotBefore: floor });
		release();

		const [first, joined, fresh] = await Promise.all([running, joinedByDefault, later]);
		expect(joined.snapshotId).toBe(first.snapshotId);
		expect(fresh.snapshotId).not.toBe(first.snapshotId);
		expect(Date.parse(fresh.startedAt)).toBeGreaterThanOrEqual(floor);
	});

	it('treats wallet-to-delivery transfer as placement change, not ownership change', async () => {
		const first = passWith({
			'account/wallet': [{ id: 1, value: 100 }],
			'commerce/delivery': { coins: 50, items: [] },
		});
		const second = passWith({
			'account/wallet': [{ id: 1, value: 150 }],
			'commerce/delivery': { coins: 0, items: [] },
		});
		await expect(
			new StorageSnapshotService(
				clientFor([first, second], { permissions: allPermissions }).client,
			).capture(),
		).resolves.toMatchObject({
			quality: 'stable_owned_placement_changed',
			passes: 2,
			currencyById: { '1': { total: 150, wallet: 150, delivery: 0 } },
		});
	});

	it('does not hide invalid payloads or authorization failures as partial snapshots', async () => {
		const malformed = passWith({ 'account/bank': { not: 'an array' } });
		await expect(
			new StorageSnapshotService(clientFor([malformed]).client).capture(),
		).rejects.toBeInstanceOf(InvalidSnapshotPayloadError);

		const forbidden = passWith({
			'account/bank': new HttpTransportError('http', 403, null, 'Forbidden.'),
		});
		await expect(
			new StorageSnapshotService(clientFor([forbidden]).client).capture(),
		).rejects.toMatchObject({ status: 403 });
	});

	it('drains sibling requests before releasing a failed capture', async () => {
		let releaseSlowRequest!: () => void;
		let markSlowStarted!: () => void;
		const slowStarted = new Promise<void>((resolve) => {
			markSlowStarted = resolve;
		});
		const slowRequest = new Promise<void>((resolve) => {
			releaseSlowRequest = resolve;
		});
		const malformed = passWith({ 'account/bank': { not: 'an array' } });
		const fixture = clientFor([malformed], {
			onRequest: async (path) => {
				if (path.startsWith('characters/') && path.includes('/inventory')) {
					markSlowStarted();
					await slowRequest;
				}
			},
		});
		let settled = false;
		const capture = new StorageSnapshotService(fixture.client).capture().finally(() => {
			settled = true;
		});
		await slowStarted;
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseSlowRequest();
		await expect(capture).rejects.toBeInstanceOf(InvalidSnapshotPayloadError);
	});

	it('distinguishes unavailable character data from a missing character', async () => {
		const unavailableCharacter = passWith({
			[`characters/${encodeURIComponent(characterName)}/inventory`]: new HttpTransportError(
				'http',
				500,
				null,
				'Unavailable.',
			),
		});
		await expect(
			new StorageSnapshotService(
				clientFor([unavailableCharacter, unavailableCharacter]).client,
			).capture(),
		).resolves.toMatchObject({
			quality: 'partial',
			coverage: { sources: { characters: {
				status: 'partial',
				reason: 'unavailable',
				diagnostic: { kind: 'http', status: 500, retryAfterMs: null },
			} } },
		});
	});

	it.each([
		['timeout', new HttpTransportError('timeout', null, null, 'Timed out.')],
		['network', new HttpTransportError('network', null, null, 'Network failed.')],
		['server failure', new HttpTransportError('http', 503, null, 'Unavailable.')],
	] as const)('retries a single transient character %s once and never degrades the pass over it', async (_label, failure) => {
		// H14.10: `capturePass` now gives one character a single patient retry (never the whole
		// roster) before recording it partial. This fixture's second slot is a clean success, so
		// the retry recovers pass 1 outright and the capture never needed the old "return partial
		// after one pass" fallback below at all.
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const seen: string[] = [];
		const first = passWith({ [inventoryPath]: failure });
		const service = new StorageSnapshotService(clientFor([
			first,
			passWith(),
			passWith(),
		], { seen }).client);

		const snapshot = await service.capture();

		expect(snapshot).toMatchObject({
			quality: 'stable',
			passes: 2,
			coverage: {
				sources: { characters: { status: 'complete' } },
				characters: { [characterName]: { status: 'complete' } },
			},
		});
		expect(snapshot.passCoverages).toHaveLength(2);
		// Attempt 1 (fails), the in-pass retry (recovers), then pass 2's own fetch: 3, never 2N.
		expect(seen.filter((path) => path.startsWith(`${inventoryPath}?`))).toHaveLength(3);
	});

	it.each([
		['timeout', new HttpTransportError('timeout', null, null, 'Timed out.')],
		['network', new HttpTransportError('network', null, null, 'Network failed.')],
		['server failure', new HttpTransportError('http', 503, null, 'Unavailable.')],
	] as const)('still stops after one pass, fine-grained by character, when the retry also fails (%s)', async (
		_label, failure,
	) => {
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const seen: string[] = [];
		const first = passWith({ [inventoryPath]: failure });
		const service = new StorageSnapshotService(clientFor([first], { seen }).client);

		const snapshot = await service.capture();

		expect(snapshot).toMatchObject({
			quality: 'partial',
			passes: 1,
			coverage: {
				sources: { characters: { status: 'partial', reason: 'unavailable' } },
				characters: { [characterName]: { status: 'partial', reason: 'unavailable' } },
			},
		});
		expect(snapshot.passCoverages).toHaveLength(1);
		// The one retry still only ever touches this character, never the whole roster.
		expect(seen.filter((path) => path.startsWith(`${inventoryPath}?`))).toHaveLength(2);
	});

	it('does not launch a third account-wide pass when the retried hole persists in the second', async () => {
		const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
		const seen: string[] = [];
		const second = passWith({
			[inventoryPath]: new HttpTransportError('timeout', null, null, 'Timed out.'),
		});
		const service = new StorageSnapshotService(clientFor([
			passWith(),
			second,
		], { seen }).client);

		const snapshot = await service.capture();

		expect(snapshot).toMatchObject({ quality: 'partial', passes: 2 });
		expect(snapshot.passCoverages).toHaveLength(2);
		expect(snapshot.passCoverages[0]?.characters[characterName]).toEqual({ status: 'complete' });
		expect(snapshot.passCoverages[1]?.characters[characterName]).toMatchObject({
			status: 'partial', reason: 'unavailable', diagnostic: { kind: 'timeout' },
		});
		// Pass 1's fetch, pass 2's own fetch (fails), and its one in-pass retry (fails again): 3.
		expect(seen.filter((path) => path.startsWith(`${inventoryPath}?`))).toHaveLength(3);
	});

	describe('H14.10 last-modified anchor skip', () => {
		const lastModified = 'Mon, 01 Sep 2026 00:00:00 GMT';

		it('skips the second full pass and stays stable when the account last-modified is unchanged', async () => {
			const seen: string[] = [];
			const fixture = clientFor([
				passWith({
					'account/inventory': response(200, completePassFixture['account/inventory'], { 'last-modified': lastModified }),
				}),
			], { seen, permissions: allPermissions });

			const snapshot = await new StorageSnapshotService(fixture.client).capture();

			expect(snapshot).toMatchObject({ quality: 'stable', passes: 1 });
			expect(snapshot.passCoverages).toHaveLength(1);
			// roster + 5 stores + 1 character = 7, plus the one anchor recheck = 8. Never the old
			// 14 (7 fixed x 2 passes) that a full, unconditional second pass would cost.
			expect(seen).toHaveLength(8);
			expect(seen.filter((path) => path.startsWith('account/inventory?'))).toHaveLength(2);
		});

		it('falls back to a real second pass when the account last-modified has moved on', async () => {
			const seen: string[] = [];
			const fixture = clientFor([
				passWith({
					'account/inventory': response(200, completePassFixture['account/inventory'], { 'last-modified': lastModified }),
				}),
				passWith({
					'account/inventory': response(200, completePassFixture['account/inventory'], { 'last-modified': 'Tue, 02 Sep 2026 00:00:00 GMT' }),
				}),
			], { seen });

			const snapshot = await new StorageSnapshotService(fixture.client).capture();

			expect(snapshot).toMatchObject({ quality: 'stable', passes: 2 });
			expect(snapshot.passCoverages).toHaveLength(2);
		});

		it('keeps a persisted single-character hole usable as stable via the anchor, in one pass', async () => {
			const inventoryPath = `characters/${encodeURIComponent(characterName)}/inventory`;
			const seen: string[] = [];
			const fixture = clientFor([
				passWith({
					[inventoryPath]: new HttpTransportError('timeout', null, null, 'Timed out.'),
					'account/inventory': response(200, completePassFixture['account/inventory'], { 'last-modified': lastModified }),
				}),
			], { seen });

			const snapshot = await new StorageSnapshotService(fixture.client).capture();

			expect(snapshot).toMatchObject({
				quality: 'stable',
				passes: 1,
				coverage: {
					characters: {
						[characterName]: { status: 'partial', reason: 'unavailable', diagnostic: { kind: 'timeout' } },
					},
				},
			});
			expect(snapshot.passCoverages).toHaveLength(1);
			// The original attempt, its one in-pass retry (both fail), then the anchor recheck:
			// never a full second pass of every store and the whole roster.
			expect(seen.filter((path) => path.startsWith(`${inventoryPath}?`))).toHaveLength(2);
		});

		it('never attempts the anchor when an account-wide store already failed transiently', async () => {
			const seen: string[] = [];
			const fixture = clientFor([
				passWith({
					'account/bank': new HttpTransportError('timeout', null, null, 'Timed out.'),
					'account/inventory': response(200, completePassFixture['account/inventory'], { 'last-modified': lastModified }),
				}),
			], { seen });

			const snapshot = await new StorageSnapshotService(fixture.client).capture();

			expect(snapshot).toMatchObject({ quality: 'partial', passes: 1 });
			expect(seen.filter((path) => path.startsWith('account/inventory?'))).toHaveLength(1);
		});
	});

	describe('capture progress', () => {
		it('reports a real, growing completed/total for each character as its own request settles', async () => {
			const names = ['Astra', 'Borja', 'Carla'];
			const fixture = clientFor([passWith({
				characters: names,
				...Object.fromEntries(names.map((name) => [
					`characters/${encodeURIComponent(name)}/inventory`,
					{ ...characterInventoryFixture, name },
				])),
			})]);
			const ticks: StorageSnapshotCaptureProgress[] = [];
			await new StorageSnapshotService(fixture.client).captureInventoryWithOperation(
				fixture.client.beginOperation(),
				(progress) => ticks.push(progress),
			);

			expect(ticks.length).toBeGreaterThan(1);
			// Totals expose only observations whose roster has already landed.
			expect(ticks[0]).toEqual({
				roster: { completed: 1, total: 1 },
				accountStores: { completed: 0, total: 3 },
				characters: { completed: 0, total: 3 },
			});
			const last = ticks.at(-1)!;
			expect(last).toEqual({
				roster: { completed: 2, total: 2 },
				accountStores: { completed: 6, total: 6 },
				characters: { completed: 6, total: 6 },
			});
			// Every counter is monotonically non-decreasing across the whole capture.
			for (let index = 1; index < ticks.length; index += 1) {
				expect(ticks[index]!.accountStores.completed).toBeGreaterThanOrEqual(ticks[index - 1]!.accountStores.completed);
				expect(ticks[index]!.characters.completed).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.completed);
				expect(ticks[index]!.accountStores.total).toBeGreaterThanOrEqual(ticks[index - 1]!.accountStores.total);
				expect(ticks[index]!.characters.total).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.total);
			}
		});

		it.each([
			['grows', [characterName], [characterName, 'Boreal Dos']],
			['shrinks', [characterName, 'Boreal Dos'], [characterName]],
		] as const)('keeps real monotonic totals when the roster %s between observations', async (
			_label, firstRoster, secondRoster,
		) => {
			const secondCharacter = 'Boreal Dos';
			const inventoryPath = `characters/${encodeURIComponent(secondCharacter)}/inventory`;
			const extraInventory = { bags: [{ id: 9_001, inventory: [] }] };
			const fixture = clientFor([
				passWith({ characters: [...firstRoster], [inventoryPath]: extraInventory }),
				passWith({ characters: [...secondRoster], [inventoryPath]: extraInventory }),
			]);
			const ticks: StorageSnapshotCaptureProgress[] = [];

			await new StorageSnapshotService(fixture.client).captureInventoryWithOperation(
				fixture.client.beginOperation(),
				(progress) => ticks.push(progress),
			);

			for (let index = 1; index < ticks.length; index += 1) {
				expect(ticks[index]!.roster.total).toBeGreaterThanOrEqual(ticks[index - 1]!.roster.total);
				expect(ticks[index]!.accountStores.total).toBeGreaterThanOrEqual(ticks[index - 1]!.accountStores.total);
				expect(ticks[index]!.characters.total).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.total);
				expect(ticks[index]!.characters.completed).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.completed);
			}
			expect(ticks.at(-1)).toEqual({
				roster: { completed: 2, total: 2 },
				accountStores: { completed: 6, total: 6 },
				characters: { completed: 3, total: 3 },
			});
		});

		it('never divides by zero and never regresses when the account has no characters', async () => {
			const fixture = clientFor([passWith({ characters: [] })]);
			const ticks: StorageSnapshotCaptureProgress[] = [];
			await new StorageSnapshotService(fixture.client).captureInventoryWithOperation(
				fixture.client.beginOperation(),
				(progress) => ticks.push(progress),
			);

			expect(ticks.length).toBeGreaterThan(0);
			for (const tick of ticks) {
				expect(tick.characters.total).toBe(0);
				expect(tick.characters.completed).toBe(0);
				expect(Number.isNaN(tick.characters.completed)).toBe(false);
			}
			expect(ticks.at(-1)).toEqual({
				roster: { completed: 2, total: 2 },
				accountStores: { completed: 6, total: 6 },
				characters: { completed: 0, total: 0 },
			});
		});

		it('stabilizes even when the caller does not pass a progress callback', async () => {
			const seen: string[] = [];
			const fixture = clientFor([passWith()], { seen });
			const snapshot = await new StorageSnapshotService(fixture.client)
				.captureInventoryWithOperation(fixture.client.beginOperation());

			expect(snapshot).toMatchObject({ quality: 'stable', passes: 2 });
			expect(seen.map((path) => path.split('?')[0])).toContain('account/inventory');
		});
	});
});

/** `count` distinct character names, in roster order. */
function advisorRoster(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `Roster ${index}`);
}

function characterInventoryPath(name: string): string {
	return `characters/${encodeURIComponent(name)}/inventory`;
}

function isCharacterInventoryPath(path: string): boolean {
	return path.startsWith('characters/') && path.includes('/inventory');
}

function isRosterPath(path: string): boolean {
	return path.startsWith('characters?');
}

function characterOfPath(path: string): string {
	return decodeURIComponent(path.split('/')[1] ?? '');
}

/** A complete pass whose roster is `names`; character `index` holds `itemsFor(index)` items no other character has. */
function rosterPass(
	names: readonly string[],
	itemsFor: (index: number) => number = () => 1,
	overrides: PassFixture = {},
): PassFixture {
	return passWith({
		characters: [...names],
		...Object.fromEntries(names.map((name, index) => [characterInventoryPath(name), {
			bags: [{
				id: 9_001,
				size: 20,
				inventory: Array.from({ length: itemsFor(index) }, (_value, slot) => ({ id: 8_000 + index * 100 + slot, count: 1 })),
			}],
		}])),
		...overrides,
	});
}

/**
 * Waits `count` macrotasks. Zero-delay timers fire in the order they were queued, so requests
 * started in the same turn finish in the order of their counts, with no wall-clock delay to tune.
 */
async function macrotasks(count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
	}
}

type AccountItemSurface = 'character' | 'bank' | 'materials';

function passWithAccountItem(surface: AccountItemSurface): PassFixture {
	return passWith({
		[`characters/${encodeURIComponent(characterName)}/inventory`]: {
			bags: [{
				id: 1_001,
				inventory: surface === 'character'
					? [{ id: 777, count: 1 }, { id: 777, count: 2 }]
					: [null, null],
			}],
		},
		'account/bank': surface === 'bank' ? [{ id: 777, count: 3 }] : [],
		'account/materials': surface === 'materials' ? [{ id: 777, category: 7, count: 3 }] : [],
	});
}

function accountItemHoldings(surface: AccountItemSurface): ItemHolding[] {
	if (surface === 'character') {
		return [
			{
				kind: 'item', itemId: 777, quantity: 1, state: 'loose', metadata: {},
				location: { source: 'character', character: characterName, container: 'bag', bagIndex: 0, slot: 0 },
			},
			{
				kind: 'item', itemId: 777, quantity: 2, state: 'loose', metadata: {},
				location: { source: 'character', character: characterName, container: 'bag', bagIndex: 0, slot: 1 },
			},
		];
	}
	return [{
		kind: 'item', itemId: 777, quantity: 3, state: 'loose', metadata: {},
		location: surface === 'bank' ? { source: 'bank', slot: 0 } : { source: 'materials', category: 7 },
	}];
}

function accountItemComposition(surface: AccountItemSurface) {
	return accountItemHoldings(surface).map(({ quantity, state, location, metadata }) => ({
		quantity,
		state,
		location,
		metadata,
	}));
}

describe('character activity across captures', () => {
	it('keeps the previous successful baseline across both consistency passes', async () => {
		const activity = (age: number) => passWith({ characters: [{ name: characterName, age }] });
		const fixture = clientFor([activity(100), activity(100), activity(120), activity(120)]);
		const service = new StorageSnapshotService(fixture.client);
		expect((await service.capture()).lastPlayedCharacter).toBeNull();
		expect((await service.capture()).lastPlayedCharacter).toEqual({ character: characterName, source: 'age_delta' });
	});
	it('does not compare a different account against the previous account baseline', async () => {
		const activity = (age: number) => passWith({ characters: [{ name: characterName, age }] });
		const fixture = clientFor([activity(100), activity(100), activity(120), activity(120)], { accountIds: ['one', 'two'] });
		const service = new StorageSnapshotService(fixture.client);
		await service.capture();
		expect((await service.capture()).lastPlayedCharacter).toBeNull();
	});
});
