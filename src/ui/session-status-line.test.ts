import { describe, expect, it } from 'vitest';

import { buildSessionStatusLine, renderSessionStatusLine, type SessionStatusItem } from './session-status-line';
import { formatClock } from './format-time';

describe('buildSessionStatusLine', () => {
	it('says the addon is connected while present, with no attention tone', () => {
		const items = buildSessionStatusLine({
			addonPresence: { status: 'present', lastSeenAtMs: null },
			accountLastReadAtMs: null, accountNextReadAtMs: null,
		}, 'es');
		expect(items).toEqual([{ text: 'Nexus conectado' }]);
	});

	it('says the addon has had no signal since its last frame, with an attention tone', () => {
		const items = buildSessionStatusLine({
			addonPresence: { status: 'lost', lastSeenAtMs: Date.UTC(2026, 8, 26, 22, 40) },
			accountLastReadAtMs: null, accountNextReadAtMs: null,
		}, 'es');
		expect(items).toHaveLength(1);
		expect(items[0]?.text).toContain('Nexus sin señal desde las');
		expect(items[0]?.tone).toBe('attention');
	});

	// Sabotage: dropping the `presence.status === 'absent'` fallthrough (returning `items` with no
	// branch matched) and instead defaulting to the `'present'` line would fabricate "Nexus
	// conectado" for an addon that never connected at all. This asserts the honest empty result.
	it('claims nothing for an addon that never connected (absent), never a guessed state', () => {
		const items = buildSessionStatusLine({
			addonPresence: { status: 'absent', lastSeenAtMs: null },
			accountLastReadAtMs: null, accountNextReadAtMs: null,
		}, 'es');
		expect(items).toEqual([]);
	});

	it('adds the account read/next items only once a poll has actually answered', () => {
		const lastRead = Date.UTC(2026, 8, 26, 21, 36);
		const nextRead = Date.UTC(2026, 8, 26, 21, 47);
		const items = buildSessionStatusLine({
			addonPresence: null, accountLastReadAtMs: lastRead, accountNextReadAtMs: nextRead,
		}, 'es');
		expect(items.map((item) => item.text)).toEqual([
			`Cuenta leída a las ${formatClock(lastRead, 'es')}`, `siguiente hacia las ${formatClock(nextRead, 'es')}`,
		]);
	});

	it('omits "siguiente" without a scheduled next read, but keeps the last-read item', () => {
		const items = buildSessionStatusLine({
			addonPresence: null, accountLastReadAtMs: Date.UTC(2026, 8, 26, 21, 36), accountNextReadAtMs: null,
		}, 'es');
		expect(items).toHaveLength(1);
	});

	it('combines the addon and the account items in the boceto\'s own order', () => {
		const lastRead = Date.UTC(2026, 8, 26, 21, 36);
		const nextRead = Date.UTC(2026, 8, 26, 21, 47);
		const items = buildSessionStatusLine({
			addonPresence: { status: 'present', lastSeenAtMs: null },
			accountLastReadAtMs: lastRead, accountNextReadAtMs: nextRead,
		}, 'es');
		expect(items.map((item) => item.text)).toEqual([
			'Nexus conectado', `Cuenta leída a las ${formatClock(lastRead, 'es')}`, `siguiente hacia las ${formatClock(nextRead, 'es')}`,
		]);
	});
});

describe('renderSessionStatusLine', () => {
	function makeEl(tag: string): FakeElement { return new FakeElement(tag); }

	it('mounts one span per item, with the attention tone as a data attribute', () => {
		const container = makeEl('div');
		const items: SessionStatusItem[] = [{ text: 'a' }, { text: 'b', tone: 'attention' }];
		const line = renderSessionStatusLine(container as unknown as HTMLElement, items);
		expect((line as unknown as FakeElement | null)?.attributes.get('role')).toBe('status');
		expect(container.children).toHaveLength(1);
		const spans = container.children[0]!.children;
		expect(spans.map((span) => span.textContent)).toEqual(['a', 'b']);
		expect(spans[1]?.attributes.get('data-tone')).toBe('attention');
		expect(spans[0]?.attributes.has('data-tone')).toBe(false);
	});

	it('mounts nothing at all for an empty line', () => {
		const container = makeEl('div');
		const line = renderSessionStatusLine(container as unknown as HTMLElement, []);
		expect(line).toBeNull();
		expect(container.children).toHaveLength(0);
	});
});

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	textContent: string | null = null;
	className = '';

	constructor(readonly tag: string, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? null;
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, options); this.children.push(child); return child; }
	createSpan(options?: FakeOptions): FakeElement { const child = new FakeElement('span', options); this.children.push(child); return child; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
}
