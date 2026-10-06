import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { FarmingDeclaredBuildEditor } from './farming-declared-build-editor';

const fixtures = JSON.parse(readFileSync(new URL('../sessions/__fixtures__/build-template-chatlinks.json', import.meta.url), 'utf8')) as { samples: { code: string }[] };
function setup(initial: unknown = null) {
	const document = new Window().document as unknown as Document; let saved = initial;
	const save = vi.fn(async (value: unknown) => { saved = value; });
	const actions = { getLocale: () => 'es' as const, getFarmingDeclaredBuildPreference: () => saved, saveFarmingDeclaredBuildPreference: save };
	const editor = new FarmingDeclaredBuildEditor(document, actions); document.body.append(editor.element);
	return { document, editor, actions, save, code: editor.element.querySelector('textarea')!, label: editor.element.querySelector('input')!, button: editor.element.querySelector('button')! };
}
function input(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
	element.value = value; element.dispatchEvent(new element.ownerDocument.defaultView!.Event('input', { bubbles: true }));
}
describe('manual build declaration editor', () => {
	it('previews shared-parser profession with manual provenance, saving only next-session preferences', async () => {
		const ui = setup(); input(ui.code, fixtures.samples[0]!.code); input(ui.label, 'My build');
		expect(ui.editor.element.textContent).toContain('Ranger · Plantilla manual');
		expect(ui.editor.element.textContent).toContain('No verifica la build activa ni el equipo');
		ui.button.focus(); ui.button.click(); await vi.waitFor(() => { expect(ui.button.getAttribute('aria-busy')).toBe('false'); });
		expect(ui.save).toHaveBeenCalledWith({ version: 1, templateCode: fixtures.samples[0]!.code, label: 'My build' });
		expect(ui.document.activeElement).toBe(ui.button);
	});
	it('keeps an invalid raw draft across refresh, save and remount without silently retaining a previously valid build', async () => {
		const ui = setup({ version: 1, templateCode: fixtures.samples[0]!.code, label: 'Valid before' });
		input(ui.code, '[&broken]'); ui.editor.refresh(); expect(ui.code.value).toBe('[&broken]');
		ui.button.click(); await vi.waitFor(() => { expect(ui.save).toHaveBeenCalledOnce(); });
		const reopened = new FarmingDeclaredBuildEditor(ui.document, ui.actions);
		expect(reopened.element.querySelector('textarea')!.value).toBe('[&broken]');
		expect(reopened.element.textContent).toContain('próxima tanda tendrá build desconocida');
	});
	it('keeps unsupported raw templates visible and saved rather than falling back to valid state', async () => {
		const raw = Uint8Array.from(Buffer.from(fixtures.samples[0]!.code.slice(2, -1), 'base64')); raw[32] = 1;
		const unsupported = `[&${Buffer.from(raw).toString('base64')}]`; const ui = setup(); input(ui.code, unsupported);
		expect(ui.editor.element.textContent).toContain('aún no se puede interpretar'); ui.button.click();
		await vi.waitFor(() => { expect(ui.save).toHaveBeenCalledOnce(); });
		expect(ui.actions.getFarmingDeclaredBuildPreference()).toEqual({ version: 1, templateCode: unsupported, label: null });
	});
	it('preserves a malformed stored object until explicit replacement, and keeps a failed-save draft', async () => {
		const malformed = { version: 999, templateCode: 'kept raw', extra: { keep: true } }; const ui = setup(malformed);
		ui.editor.refresh(); expect(ui.actions.getFarmingDeclaredBuildPreference()).toBe(malformed); expect(ui.save).not.toHaveBeenCalled();
		expect(ui.editor.element.textContent).toContain('conserva íntegra');
		ui.save.mockRejectedValueOnce(new Error('disk')); input(ui.code, 'new raw'); ui.button.click();
		await vi.waitFor(() => { expect(ui.editor.element.textContent).toContain('borrador se conserva'); });
		ui.editor.refresh(); expect(ui.code.value).toBe('new raw'); expect(ui.actions.getFarmingDeclaredBuildPreference()).toBe(malformed);
	});
	it('rejects duplicate activation while saving and retains its focused control', async () => {
		const ui = setup(); let resolve!: () => void; ui.save.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
		input(ui.code, 'invalid raw'); ui.button.focus(); ui.button.click(); ui.button.click();
		expect(ui.save).toHaveBeenCalledOnce(); expect(ui.document.activeElement).toBe(ui.button);
		resolve(); await vi.waitFor(() => { expect(ui.button.getAttribute('aria-busy')).toBe('false'); });
	});
});
