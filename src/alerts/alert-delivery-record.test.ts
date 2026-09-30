import { describe, expect, it } from 'vitest';

import {
	createAlertDeliveryRecord,
	isAlertDeliveryRecord,
	readAlertDelivery,
	type AlertDeliveryRecordV1,
} from './alert-delivery-record';

const BASE = { vaultId: 'vault', accountRef: 'account', alertId: 'alert:valuable_loot:1:2026-10-05T10:00:00.000Z', emittedAt: '2026-10-05T10:00:00.000Z' };

describe('H18.38 alert delivery record', () => {
	it('builds one record per receipt state, hosts in fixed order and only the fields that state owns', () => {
		expect(createAlertDeliveryRecord({ ...BASE, sentTo: ['blish', 'nexus'], receipt: { state: 'pending' } }))
			.toMatchObject({ sentTo: ['nexus', 'blish'], state: 'pending', cause: null, receivedBy: null, receivedAt: null });
		expect(createAlertDeliveryRecord({ ...BASE, sentTo: ['nexus'], receipt: { state: 'received', client: 'nexus', atMs: Date.parse('2026-10-05T10:00:03.000Z') } }))
			.toMatchObject({ state: 'received', receivedBy: 'nexus', receivedAt: '2026-10-05T10:00:03.000Z', cause: null });
		expect(createAlertDeliveryRecord({ ...BASE, sentTo: [], receipt: { state: 'unconfirmed', cause: 'no_addon' } }))
			.toMatchObject({ state: 'unconfirmed', cause: 'no_addon', sentTo: [] });
	});

	it('refuses shapes that contradict themselves', () => {
		const good = createAlertDeliveryRecord({ ...BASE, sentTo: ['nexus'], receipt: { state: 'pending' } }) as AlertDeliveryRecordV1;
		expect(isAlertDeliveryRecord(good)).toBe(true);
		for (const broken of [
			{ ...good, extra: 1 },
			{ ...good, cause: 'timeout' },
			{ ...good, sentTo: [] },
			{ ...good, sentTo: ['nexus', 'nexus'] },
			{ ...good, sentTo: ['arcdps'] },
			{ ...good, state: 'received', receivedBy: null },
			{ ...good, state: 'unconfirmed', cause: null },
			{ ...good, emittedAt: 'yesterday' },
			{ ...good, version: 2 },
		]) expect(isAlertDeliveryRecord(broken)).toBe(false);
		expect(createAlertDeliveryRecord({ ...BASE, sentTo: ['nexus'], receipt: { state: 'received', client: 'nexus', atMs: -1 } })).toBeNull();
	});

	it('reads a pending record nobody waits on as unconfirmed by restart, and leaves the rest alone', () => {
		const pending = createAlertDeliveryRecord({ ...BASE, sentTo: ['nexus'], receipt: { state: 'pending' } }) as AlertDeliveryRecordV1;
		expect(readAlertDelivery(pending, true)).toBe(pending);
		expect(readAlertDelivery(pending, false)).toMatchObject({ state: 'unconfirmed', cause: 'restart' });
		const received = createAlertDeliveryRecord({ ...BASE, sentTo: ['blish'], receipt: { state: 'received', client: 'blish', atMs: 5 } }) as AlertDeliveryRecordV1;
		expect(readAlertDelivery(received, false)).toBe(received);
	});
});
