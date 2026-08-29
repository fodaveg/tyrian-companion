import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createTranslator, type Locale } from '../core/i18n';
import type { ContainerPersonalValuationV1 } from '../economy/container-personal-valuation';
import { HalloweenPersonalValuationSettings } from './halloween-personal-valuation-settings';

describe('Halloween personal valuation Settings DOM', () => {
	it.each(['es', 'en'] as const)('renders ten real outcome rows, summary and outside-model warning in %s', (locale) => {
		const harness = mount(locale);
		const inputs = harness.elements().filter((element) => element.tagName === 'INPUT');
		expect(inputs).toHaveLength(10);
		expect(inputs.map((input) => input.attributes.get('aria-label'))).toContain(
			locale === 'es'
				? 'Valor manual en cobre por unidad para Limited-Use Scarecrow Finisher'
				: 'Manual copper-per-unit value for Limited-Use Scarecrow Finisher',
		);
		expect(harness.text()).toContain(locale === 'es' ? '0 de 10 resultados valorados' : '0 of 10 outcomes valued');
		expect(harness.text()).toContain(locale === 'es' ? 'Cobre/unidad · origen: manual' : 'Copper/unit · origin: manual');
		expect(harness.text()).toContain('1');
		expect(harness.text()).toContain('171');
	});

	it('distinguishes empty, explicit zero, valid large value and removal', async () => {
		const harness = mount('en');
		let input = harness.inputs()[0]!;
		expect(input.value).toBe('');

		input.value = '0';
		input.dispatch('change');
		await flush();
		expect(harness.value.values[0]).toMatchObject({ unitCopper: 0, origin: 'manual' });
		expect(harness.text()).toContain('1 of 10 outcomes valued');

		input = harness.inputs()[0]!;
		input.value = '1000000000';
		input.dispatch('change');
		await flush();
		expect(harness.value.values[0]?.unitCopper).toBe(1_000_000_000);

		input = harness.inputs()[0]!;
		input.value = '';
		input.dispatch('change');
		await flush();
		expect(harness.value.values).toEqual([]);
		expect(harness.text()).toContain('Value removed.');

		input = harness.inputs()[0]!;
		input.value = '5';
		input.dispatch('change');
		await flush();
		const remove = harness.elements().find((element) => element.tagName === 'BUTTON');
		if (remove === undefined) throw new Error('Expected remove button.');
		remove.dispatch('click');
		await flush();
		expect(harness.value.values).toEqual([]);
		expect(harness.text()).toContain('Value removed.');
	});

	it('keeps the last saved value, marks an inline alert and restores focus for invalid input', async () => {
		const harness = mount('en', { version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
		] });
		const input = harness.inputs()[0]!;
		input.value = '-1';
		input.dispatch('change');
		await flush();

		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.value.values[0]?.unitCopper).toBe(25);
		expect(input.attributes.get('aria-invalid')).toBe('true');
		expect(input.focused).toBe(true);
		expect(harness.elements().some((element) => element.attributes.get('role') === 'alert')).toBe(true);
		expect(harness.text()).toContain('The last saved value is preserved.');
	});

	it('rejects a structurally safe copper value whose expected contribution would overflow', async () => {
		const harness = mount('en', { version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
		] });
		const input = harness.inputs()[0]!;
		input.value = String(Number.MAX_SAFE_INTEGER);
		input.dispatch('change');
		await flush();
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.value.values[0]?.unitCopper).toBe(25);
		expect(input.attributes.get('aria-invalid')).toBe('true');
		expect(input.focused).toBe(true);
		expect(harness.text()).toContain('expected adjustment stays in range');
	});

	it('disables every control while saving and reports the settled reclassification', async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const harness = mount('en', undefined, pending);
		const input = harness.inputs()[0]!;
		input.value = '125';
		input.dispatch('change');

		expect(harness.elements().filter((element) => element.tagName === 'INPUT' || element.tagName === 'BUTTON')
			.every((element) => element.disabled)).toBe(true);
		expect(harness.text()).toContain('Saving…');
		release();
		await flush();
		expect(harness.text()).toContain('Saved and reclassified without a new capture.');
	});

	it('restores the saved value and announces an inline alert when persistence fails', async () => {
		let reject!: (error: Error) => void;
		const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
		const harness = mount('en', { version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
		] }, pending);
		const input = harness.inputs()[0]!;
		input.value = '30';
		input.dispatch('change');
		reject(new Error('persistence unavailable'));
		await flush();
		expect(harness.value.values[0]?.unitCopper).toBe(25);
		expect(harness.inputs()[0]?.value).toBe('25');
		expect(harness.text()).toContain('Could not save. The last saved value is preserved.');
		expect(harness.elements().some((element) => element.attributes.get('role') === 'alert')).toBe(true);
	});

	it('pins the responsive and accessible control rules at 760, 480 and 320 px', () => {
		const styles = readFileSync('styles.css', 'utf8');
		for (const width of [760, 480, 320]) expect(styles).toContain(`@container (max-width: ${String(width)}px)`);
		expect(styles).toMatch(/\.tyrian-personal-valuation__row input,[\s\S]*min-block-size: 44px/u);
	});
});

function mount(
	locale: Locale,
	initial: ContainerPersonalValuationV1 = { version: 1, values: [] },
	pending?: Promise<void>,
) {
	const document = new FakeDocument();
	const container = document.createElement('div');
	let value = structuredClone(initial);
	const save = vi.fn(async (next: ContainerPersonalValuationV1) => {
		if (pending) await pending;
		value = structuredClone(next);
	});
	const component = new HalloweenPersonalValuationSettings({
		value: () => structuredClone(value), save, translator: () => createTranslator(locale),
	});
	component.render(container as unknown as HTMLElement);
	return {
		container,
		get value() { return value; },
		save,
		elements: () => walk(container),
		inputs: () => walk(container).filter((element) => element.tagName === 'INPUT'),
		text: () => walk(container).map((element) => element.textContent).join(' '),
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

class FakeDocument {
	createElement(tagName: string): FakeElement {
		return new FakeElement(tagName, this);
	}
}

class FakeClassList {
	constructor(private readonly owner: FakeElement) {}
	add(...values: string[]): void {
		const classes = new Set(this.owner.className.split(/\s+/u).filter(Boolean));
		values.forEach((value) => classes.add(value));
		this.owner.className = [...classes].join(' ');
	}
}

class FakeElement {
	readonly tagName: string;
	readonly attributes = new Map<string, string>();
	readonly children: FakeElement[] = [];
	readonly listeners = new Map<string, Array<() => void>>();
	readonly classList = new FakeClassList(this);
	className = '';
	textContent = '';
	value = '';
	disabled = false;
	focused = false;
	id = '';
	type = '';
	inputMode = '';
	autocomplete = '';
	placeholder = '';
	htmlFor = '';
	title = '';
	readonly ownerDocument: FakeDocument;

	constructor(tagName: string, document: FakeDocument) {
		this.tagName = tagName.toUpperCase();
		this.ownerDocument = document;
	}

	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(name: string, listener: () => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
	}
	dispatch(name: string): void { this.listeners.get(name)?.forEach((listener) => listener()); }
	focus(): void { this.focused = true; }
	append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
	createEl(tagName: string): FakeElement {
		const child = this.ownerDocument.createElement(tagName);
		this.append(child);
		return child;
	}
	createDiv(): FakeElement {
		const child = this.ownerDocument.createElement('div');
		this.append(child);
		return child;
	}
	createSpan(): FakeElement {
		const child = this.ownerDocument.createElement('span');
		this.append(child);
		return child;
	}
	replaceChildren(...nodes: FakeElement[]): void { this.children.length = 0; this.children.push(...nodes); }
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}
