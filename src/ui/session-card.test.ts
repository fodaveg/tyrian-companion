import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderSessionCard, type SessionCardModel } from './session-card';

/**
 * DOM coverage for the five mockup states (`diseno-sesion/sesion.html`, cases 1-5): reposo,
 * activa 0 s, activa 30 min, terminada and reposo+callout. `session-card.ts` is a pure render, so
 * every case here builds its own explicit `SessionCardModel` instead of driving the real runtime.
 */

function baseDrawers(): Pick<SessionCardModel, 'detail' | 'alerts' | 'history'> {
	return {
		detail: { summary: 'Detalle', suffix: 'Detección desactivada' },
		alerts: { summary: 'Avisos', suffix: '0 sin revisar' },
		history: { summary: 'Historial', suffix: 'sin cargar' },
	};
}

function idleModel(): SessionCardModel {
	return {
		ariaLabel: 'Sesión de farmeo',
		state: 'Listo para empezar',
		meta: { text: 'La conexión se comprobará al iniciar' },
		actions: [{ text: 'Iniciar sesión', cta: true, onClick: () => undefined }],
		callout: null,
		figures: [],
		...baseDrawers(),
	};
}

function activeZeroModel(): SessionCardModel {
	return {
		ariaLabel: 'Sesión de farmeo',
		state: 'Sesión activa',
		meta: { clock: '00:00:14', text: '· Rinopopo' },
		actions: [{ text: 'Terminar', cta: true, onClick: () => undefined }],
		callout: null,
		figures: [{ label: 'Primera lectura', value: '12:18', band: 'La API de cuenta responde desde una caché de 5 a 10 minutos.', pending: true }],
		detail: { summary: 'Detalle', suffix: 'Detección activa · próxima 12:18' },
		alerts: { summary: 'Avisos', suffix: '0 nuevos' },
		history: { summary: 'Historial', suffix: 'sin cargar' },
	};
}

function activeThirtyModel(): SessionCardModel {
	return {
		ariaLabel: 'Sesión de farmeo',
		state: 'Sesión activa',
		meta: { clock: '00:30:12', text: '· Rinopopo' },
		actions: [{ text: 'Terminar', cta: true, onClick: () => undefined }],
		callout: null,
		figures: [
			{ label: 'Valor observado', value: '4g 12s 0c', band: '6,2–12,4 g/h' },
			{ label: 'Sacos observados', value: '31', band: '46,5–93,0 sacos/h' },
			{ label: 'Última consulta', value: '12:38' },
		],
		detail: { summary: 'Detalle', suffix: 'Detección activa · próxima 12:43' },
		alerts: { summary: 'Avisos', suffix: '1 nuevo' },
		history: { summary: 'Historial', suffix: 'sin cargar' },
	};
}

function finishedModel(): SessionCardModel {
	return {
		ariaLabel: 'Sesión de farmeo',
		state: 'Resumen guardado',
		badge: { text: 'Limitada', title: 'Calidad: Comparación de almacenamiento · Limitado', ariaLabel: 'Calidad: Limitada. Comparación de almacenamiento · Limitado' },
		meta: { clock: '01:55', text: '· Rinopopo' },
		actions: [
			{ text: 'Nueva sesión', onClick: () => undefined },
			{ text: 'Abrir la nota', cta: true, onClick: () => undefined },
		],
		callout: null,
		figures: [
			{ label: 'Valor neto guardado', value: '12g 25s 0c', band: '5,9–7,0 g/h' },
			{ label: 'Sacos observados', value: '0', band: '0,0 sacos/h' },
			{ label: 'Última consulta', value: '14:13' },
		],
		detail: { summary: 'Detalle', suffix: 'Detección desactivada' },
		alerts: { summary: 'Avisos', suffix: 'Todas las alertas están revisadas' },
		history: { summary: 'Historial', suffix: '12 sesiones', open: true },
	};
}

function idleWithCalloutModel(): SessionCardModel {
	return {
		ariaLabel: 'Sesión de farmeo',
		state: 'Listo para empezar',
		meta: { text: 'Cuenta conectada · Rinopopo' },
		actions: [{ text: 'Iniciar sesión', cta: true, onClick: () => undefined }],
		callout: {
			tone: 'error',
			title: 'Errores desde la carga: 2',
			titleButton: { text: 'Registros de diagnóstico', onClick: () => undefined },
			lines: [
				{ text: 'Último fallo: validation_failed en session/session_recover, hoy a las 7:09' },
				{ text: 'La operación de assets gestionados entró en conflicto y no se aplicó.', button: { text: 'Resolver', onClick: () => undefined } },
			],
		},
		figures: [],
		...baseDrawers(),
	};
}

describe('renderSessionCard', () => {
	it('renders the idle state with no figures, no callout and a single mod-cta', () => {
		const root = new FakeElement('div');
		const mount = renderSessionCard(root as unknown as HTMLElement, idleModel());
		const fakeRoot = mount.root as unknown as FakeElement;

		expect(fakeRoot.className).toContain('tyrian-companion-session');
		expect(fakeRoot.attributes.get('aria-label')).toBe('Sesión de farmeo');
		expect(findAll(root, (n) => n.className.includes('tyrian-companion-session__figure'))).toHaveLength(0);
		expect(findAll(root, (n) => n.className === 'callout')).toHaveLength(0);
		const ctas = findAll(root, (n) => n.tag === 'button' && n.className.includes('mod-cta'));
		expect(ctas).toHaveLength(1);
		expect(mount.clock).toBeNull();
		// Nothing measured yet: no fabricated zero anywhere in the tree.
		expect(texts(root).some((text) => text === '0')).toBe(false);
	});

	it('renders active-0s with a single pending figure and no fabricated zero', () => {
		const root = new FakeElement('div');
		const mount = renderSessionCard(root as unknown as HTMLElement, activeZeroModel());

		const figures = findAll(root, (n) => n.className.includes('tyrian-companion-session__figure') && n.tag === 'div');
		expect(figures).toHaveLength(1);
		expect(figures[0]?.attributes.get('data-pending')).toBe('true');
		expect(mount.clock?.textContent).toBe('00:00:14');
		expect(texts(root).some((text) => text === '0' || text.includes('0g'))).toBe(false);
		const dlAttr = findAll(root, (n) => n.tag === 'dl')[0]?.attributes.get('style');
		expect(dlAttr).toBe('--tyrian-figures:1');
	});

	it('renders active-30min with three figures and the drawers in Detalle · Avisos · Historial order', () => {
		const root = new FakeElement('div');
		renderSessionCard(root as unknown as HTMLElement, activeThirtyModel());

		const figures = findAll(root, (n) => n.className.includes('tyrian-companion-session__figure') && n.tag === 'div');
		expect(figures).toHaveLength(3);
		expect(figures[1]?.children.find((c) => c.tag === 'small')?.textContent).toBe('46,5–93,0 sacos/h');

		const drawers = findAll(root, (n) => n.tag === 'details');
		expect(drawers).toHaveLength(3);
		expect(drawers.map((d) => d.children.find((c) => c.tag === 'summary')?.textContent)).toEqual(['Detalle', 'Avisos', 'Historial']);
	});

	it('renders the finished state with the badge, two actions and one mod-cta on "Abrir la nota"', () => {
		const root = new FakeElement('div');
		renderSessionCard(root as unknown as HTMLElement, finishedModel());

		const badge = findAll(root, (n) => n.className.includes('tyrian-companion-session__badge'))[0];
		expect(badge?.textContent).toBe('Limitada');
		const buttons = findAll(root, (n) => n.tag === 'button');
		expect(buttons).toHaveLength(2);
		const ctas = buttons.filter((b) => b.className.includes('mod-cta'));
		expect(ctas).toHaveLength(1);
		expect(ctas[0]?.textContent).toBe('Abrir la nota');
		// The history drawer is the one open in this fixture; the other two stay closed.
		const drawers = findAll(root, (n) => n.tag === 'details');
		expect(drawers.map((d) => d.open)).toEqual([false, false, true]);
	});

	it('renders the idle+callout state with a data-callout attribute and a relative-day line', () => {
		const root = new FakeElement('div');
		renderSessionCard(root as unknown as HTMLElement, idleWithCalloutModel());

		const callout = findAll(root, (n) => n.className === 'callout')[0];
		expect(callout?.attributes.get('data-callout')).toBe('error');
		expect(callout?.attributes.get('role')).toBe('alert');
		expect(texts(root).some((text) => text.includes('hoy a las'))).toBe(true);
		expect(texts(root).some((text) => /\d{4}-\d{2}-\d{2}T/u.test(text))).toBe(false);
		// A single mod-cta even with the callout mounted.
		expect(findAll(root, (n) => n.tag === 'button' && n.className.includes('mod-cta'))).toHaveLength(1);
	});

	it('keeps a single .tyrian-companion-session__drawer class shared by the three gaveteros', () => {
		const root = new FakeElement('div');
		renderSessionCard(root as unknown as HTMLElement, activeThirtyModel());
		const drawers = findAll(root, (n) => n.tag === 'details');
		expect(drawers.every((d) => d.className === 'tyrian-companion-session__drawer')).toBe(true);
	});
});

describe('styles.css container queries (no fixed pixel widths inside the component)', () => {
	it('keeps every declaration inside the tyrian-companion-session rules unit-free of hardcoded px widths', () => {
		const cssPath = fileURLToPath(new URL('../../styles.css', import.meta.url));
		const css = readFileSync(cssPath, 'utf8');
		const start = css.indexOf('.tyrian-companion-session {');
		expect(start).toBeGreaterThan(-1);
		const end = css.indexOf('.tyrian-product-shell {', start);
		expect(end).toBeGreaterThan(start);
		const block = css.slice(start, end);
		// A hardcoded pixel width would defeat the container-query responsive design (FICHA §8);
		// every size in this block must come from an Obsidian var() or the layout token. `width: 0`/
		// `min-width: 0` resets are not sizes, and `@container (max-width: …px)` breakpoints are the
		// responsive design itself, not an element size, so only an unqualified `width:` counts.
		const pxWidths = block.match(/(?<!max-)width:\s*\d[\d.]*(px|rem|em)/gu) ?? [];
		expect(pxWidths).toHaveLength(0);
	});
});

interface FakeOptions {
	readonly text?: string;
	readonly cls?: string;
	readonly attr?: Record<string, string>;
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = '';
	textContent = '';
	disabled = false;
	open = false;

	constructor(readonly tag: string, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	createEl(tag: string, options?: FakeOptions): FakeElement { return this.appendChild(tag, options); }
	createDiv(options?: FakeOptions): FakeElement { return this.appendChild('div', options); }
	createSpan(options?: FakeOptions): FakeElement { return this.appendChild('span', options); }
	private appendChild(tag: string, options?: FakeOptions): FakeElement {
		const child = new FakeElement(tag, options);
		this.children.push(child);
		return child;
	}
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	appendText(value: string): void { this.textContent = `${this.textContent}${value}`; }
	empty(): void { this.children.splice(0); this.textContent = ''; }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function findAll(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement[] {
	return walk(root).filter(predicate);
}

function texts(root: FakeElement): string[] {
	return walk(root).map(({ textContent }) => textContent);
}
