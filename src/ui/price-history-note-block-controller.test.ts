import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
import { PriceHistoryPanelSeedService } from '../economy/price-seed-panel-service';
import { priceHistoryNoteBlockMarkdown } from '../inventory/price-history-note-block';
import { paintPriceHistoryNoteBlock, type PriceHistoryNoteBlockPorts } from './price-history-note-block-controller';

afterEach(() => vi.unstubAllGlobals());

const RECORDS = [
	{ date: '2026-08-01', buy_price_avg: 100, sell_price_avg: 110 },
	{ date: '2026-08-02', buy_price_avg: 105, sell_price_avg: 115 },
];

describe('price history note block controller', () => {
	it('never touches the network while the plugin loads; painting a piloto block does', async () => {
		const requests: HttpRequest[] = [];
		const factory = new IDBFactory();
		// Constructing the service is exactly what the plugin does at load: no request yet.
		const service = new PriceHistoryPanelSeedService({
			factory, vaultId: 'vault', transport: transportOf(requests), now: () => Date.parse('2026-09-04T00:00:00.000Z'),
		});
		expect(requests).toHaveLength(0);

		const mount = createMount();
		const { source } = piloto36038();
		await paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, source, portsFor(service));
		expect(requests).toHaveLength(1);
	});

	it('does not repeat the request on a second paint of the same note inside 24h', async () => {
		const requests: HttpRequest[] = [];
		const factory = new IDBFactory();
		const service = new PriceHistoryPanelSeedService({
			factory, vaultId: 'vault', transport: transportOf(requests), now: () => Date.parse('2026-09-04T00:00:00.000Z'),
		});
		const mount = createMount();
		const { source } = piloto36038();
		await paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, source, portsFor(service));
		await paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, source, portsFor(service));
		expect(requests).toHaveLength(1);
	});

	it('paints a no-history state and never throws when datawars2 is down', async () => {
		const factory = new IDBFactory();
		const service = new PriceHistoryPanelSeedService({
			factory, vaultId: 'vault',
			transport: { send: async () => ({ status: 503, headers: {}, body: null }) },
			now: () => Date.parse('2026-09-04T00:00:00.000Z'),
		});
		const mount = createMount();
		const { source } = piloto36038();
		await expect(paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, source, portsFor(service)))
			.resolves.toBeUndefined();
		const text = walk(mount.container).map((element) => element.textContent).join('\n');
		expect(text).toContain('no history available');
	});

	it('paints a no-history state and never throws when `ensure` itself rejects', async () => {
		const mount = createMount();
		const ports: PriceHistoryNoteBlockPorts = {
			translator: createTranslator('en'),
			ready: () => true,
			getState: () => ({ status: 'idle', itemId: 36_038, days: [], failureReason: null, retrievedAt: null }),
			ensure: async () => { throw new Error('boom'); },
		};
		await expect(paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, piloto36038().source, ports))
			.resolves.toBeUndefined();
		const text = walk(mount.container).map((element) => element.textContent).join('\n');
		expect(text).toContain('no history available');
	});

	it('never calls ensure for an item outside the piloto allowlist', async () => {
		const ensure = vi.fn();
		const mount = createMount();
		const ports: PriceHistoryNoteBlockPorts = {
			translator: createTranslator('en'), ready: () => true,
			getState: () => ({ status: 'idle', itemId: 100_063, days: [], failureReason: null, retrievedAt: null }),
			ensure,
		};
		await paintPriceHistoryNoteBlock(
			mount.container as unknown as HTMLElement,
			'# Reliquia de sobrecarga (#100063)\nitemId: 100063',
			ports,
		);
		expect(ensure).not.toHaveBeenCalled();
		const text = walk(mount.container).map((element) => element.textContent).join('\n');
		expect(text.toLowerCase()).toContain('not part of the in-note history piloto');
	});

	it('never calls ensure for a block it cannot parse', async () => {
		const ensure = vi.fn();
		const mount = createMount();
		const ports: PriceHistoryNoteBlockPorts = {
			translator: createTranslator('en'), ready: () => true,
			getState: () => { throw new Error('must not be called'); }, ensure,
		};
		await paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, 'not a valid block at all', ports);
		expect(ensure).not.toHaveBeenCalled();
	});

	it('never calls ensure while the plugin runtime has not finished starting', async () => {
		const ensure = vi.fn();
		const mount = createMount();
		const ports: PriceHistoryNoteBlockPorts = {
			translator: createTranslator('en'), ready: () => false,
			getState: () => { throw new Error('must not be called'); }, ensure,
		};
		await paintPriceHistoryNoteBlock(mount.container as unknown as HTMLElement, piloto36038().source, ports);
		expect(ensure).not.toHaveBeenCalled();
	});
});

function transportOf(sink: HttpRequest[]): HttpTransport {
	return {
		send: async (request) => {
			sink.push(request);
			return await Promise.resolve<HttpResponse>({ status: 200, headers: {}, body: RECORDS });
		},
	};
}

function portsFor(service: PriceHistoryPanelSeedService): PriceHistoryNoteBlockPorts {
	return {
		translator: createTranslator('en'),
		ready: () => true,
		getState: (itemId) => service.getState(itemId),
		ensure: (itemId) => service.ensure(itemId),
	};
}

/** The exact source an inventory note carries for item 36038; parsed straight from the writer's own output. */
function piloto36038(): { source: string } {
	const markdown = priceHistoryNoteBlockMarkdown(36_038, 'Trick-or-Treat Bag')!;
	return { source: markdown.split('\n').slice(1, -1).join('\n') };
}

function createMount(): { container: FakeElement } {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, document));
	vi.stubGlobal('createDiv', () => new FakeElement('div', document));
	vi.stubGlobal('createSpan', () => new FakeElement('span', document));
	return { container: new FakeElement('div', document) };
}
function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }
class FakeDocument {
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = ''; textContent: string | null = null; type = ''; value = ''; disabled = false;
	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	addEventListener(type: string, listener: () => void): void { const entries = this.listeners.get(type) ?? []; entries.push(listener); this.listeners.set(type, entries); }
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	setAttribute(name: string, value: string): void {
		if (name === 'class') this.className = value; else this.attributes.set(name, value);
	}
}
