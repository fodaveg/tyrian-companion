import { describe, expect, it } from 'vitest';

import { renderReceipt, type ReceiptStep } from './receipt';

describe('renderReceipt', () => {
	it('mounts one <li data-step> per step, with the icon, label and a time/small detail', () => {
		const container = new FakeElement('div');
		const steps: ReceiptStep[] = [
			{ status: 'done', icon: 'check', label: 'Visto en la cuenta', detail: { kind: 'time', text: '21:58' } },
			{ status: 'failed', icon: 'x', label: 'No llegó a Nexus', detail: { kind: 'small', text: 'sin conexión' } },
			{ status: 'skip', icon: 'minus', label: 'En la nota', detail: { kind: 'small', text: 'al cerrar' } },
		];
		const list = renderReceipt(container as unknown as HTMLElement, 'Recorrido del aviso', steps);
		expect((list as unknown as FakeElement).tag).toBe('ol');
		expect((list as unknown as FakeElement).attributes.get('aria-label')).toBe('Recorrido del aviso');
		const items = (list as unknown as FakeElement).children;
		expect(items).toHaveLength(3);
		expect(items.map((item) => item.attributes.get('data-step'))).toEqual(['done', 'failed', 'skip']);

		const [done, failed, skip] = items;
		expect(done!.children[0]?.attributes.get('data-icon')).toBe('check');
		expect(done!.children[1]?.textContent).toBe('Visto en la cuenta');
		expect(done!.children[2]?.tag).toBe('time');
		expect(done!.children[2]?.textContent).toBe('21:58');

		expect(failed!.children[2]?.tag).toBe('small');
		expect(failed!.children[2]?.textContent).toBe('sin conexión');
		expect(skip!.children[2]?.textContent).toBe('al cerrar');
	});

	it('omits the detail element for a step with none', () => {
		const container = new FakeElement('div');
		const list = renderReceipt(container as unknown as HTMLElement, 'x', [{ status: 'current', icon: 'hourglass', label: 'Lectura final' }]);
		const item = (list as unknown as FakeElement).children[0]!;
		expect(item.children).toHaveLength(2);
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
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}
