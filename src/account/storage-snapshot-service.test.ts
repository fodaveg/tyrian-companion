import { describe, expect, it } from 'vitest';

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
import { StorageSnapshotService, type StorageSnapshotCaptureProgress } from './storage-snapshot-service';

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

function response(status: number, body: unknown): HttpResponse {
	return { status, headers: {}, body };
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
			quality: 'unstable',
			passes: 1,
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
		expect(isComparableStorageSnapshot(snapshot)).toBe(false);
	});

	it('keeps an advisor capture usable when only the optional stores fail', async () => {
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
		expect(snapshot.quality).toBe('unstable');
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
		expect(isInventoryAdvisorStorageSnapshot(snapshot)).toBe(true);
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

	it('serializes character inventory requests only for the advisor scope', async () => {
		const secondCharacter = 'Boreal Dos';
		const inventoryPath = `characters/${encodeURIComponent(secondCharacter)}/inventory`;
		const inventory = { bags: [{ id: 9_001, inventory: [] }] };
		let activeCharacters = 0;
		let maxActiveCharacters = 0;
		const fixture = clientFor([
			passWith({ characters: [characterName, secondCharacter], [inventoryPath]: inventory }),
			passWith({ characters: [characterName, secondCharacter], [inventoryPath]: inventory }),
		], {
			onRequest: async (path) => {
				if (!path.startsWith('characters/') || !path.includes('/inventory')) return;
				activeCharacters += 1;
				maxActiveCharacters = Math.max(maxActiveCharacters, activeCharacters);
				await Promise.resolve();
				activeCharacters -= 1;
			},
		});

		await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());
		expect(maxActiveCharacters).toBe(1);
	});

	it('keeps a fully covered changing inventory usable as limited advisor evidence', async () => {
		const changing = [1].map((count) => passWith({
			'account/inventory': [{ id: 2_002, count }],
		}));
		const operationFixture = clientFor(changing);
		const operation = operationFixture.client.beginOperation();
		const snapshot = await new StorageSnapshotService(operationFixture.client)
			.captureInventoryWithOperation(operation);

		expect(snapshot).toMatchObject({
			quality: 'unstable',
			passes: 1,
			availableByItem: { '2002': 1 },
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

		const missingCharacter = passWith({
			[`characters/${encodeURIComponent(characterName)}/inventory`]: new HttpTransportError(
				'http',
				404,
				null,
				'Request failed with status 404.',
			),
		});
		await expect(
			new StorageSnapshotService(clientFor([missingCharacter, missingCharacter]).client).capture(),
		).resolves.toMatchObject({
			quality: 'partial',
			coverage: { sources: { characters: { status: 'partial', reason: 'missing_character' } } },
		});
	});

	it('returns one bounded partial advisor pass when the roster is unavailable', async () => {
		const unavailableRoster = passWith({
			characters: new HttpTransportError('http', 500, null, 'Unavailable.'),
		});
		const fixture = clientFor([unavailableRoster]);
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'partial',
			passes: 1,
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
		]);
	});

	it('does not repeat a complete advisor pass only to claim stability', async () => {
		const seen: string[] = [];
		const fixture = clientFor([passWith()], { seen });
		const snapshot = await new StorageSnapshotService(fixture.client)
			.captureInventoryWithOperation(fixture.client.beginOperation());

		expect(snapshot).toMatchObject({
			quality: 'unstable',
			passes: 1,
			coverage: {
				sources: { characters: { status: 'complete' }, shared_inventory: { status: 'complete' } },
				characters: { [characterName]: { status: 'complete' } },
			},
		});
		expect(snapshot.passCoverages).toHaveLength(1);
		expect(seen).toHaveLength(5);
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
			// The very first tick lands the instant the roster answers: every total is
			// already known (3 characters), nothing is completed yet but the roster itself.
			expect(ticks[0]).toEqual({
				roster: { completed: 1, total: 1 },
				accountStores: { completed: 0, total: 3 },
				characters: { completed: 0, total: 3 },
			});
			const last = ticks.at(-1)!;
			expect(last).toEqual({
				roster: { completed: 1, total: 1 },
				accountStores: { completed: 3, total: 3 },
				characters: { completed: 3, total: 3 },
			});
			// Every counter is monotonically non-decreasing across the whole capture.
			for (let index = 1; index < ticks.length; index += 1) {
				expect(ticks[index]!.accountStores.completed).toBeGreaterThanOrEqual(ticks[index - 1]!.accountStores.completed);
				expect(ticks[index]!.characters.completed).toBeGreaterThanOrEqual(ticks[index - 1]!.characters.completed);
			}
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
				roster: { completed: 1, total: 1 },
				accountStores: { completed: 3, total: 3 },
				characters: { completed: 0, total: 0 },
			});
		});

		it('captures exactly as before when the caller does not pass a progress callback', async () => {
			const seen: string[] = [];
			const fixture = clientFor([passWith()], { seen });
			const snapshot = await new StorageSnapshotService(fixture.client)
				.captureInventoryWithOperation(fixture.client.beginOperation());

			expect(snapshot.quality).toBe('unstable');
			expect(seen.map((path) => path.split('?')[0])).toContain('account/inventory');
		});
	});
});

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
