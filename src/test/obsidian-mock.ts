export class AbstractInputSuggest<T> {
	private selectCallback: ((value: T, evt: MouseEvent | KeyboardEvent) => void) | null = null;

	constructor(_app: unknown, protected readonly textInputEl: HTMLInputElement | HTMLDivElement) {}

	setValue(value: string): void {
		if ('value' in this.textInputEl) this.textInputEl.value = value;
	}

	getValue(): string {
		return 'value' in this.textInputEl ? this.textInputEl.value : '';
	}

	close(): void {}

	onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => void): this {
		this.selectCallback = callback;
		return this;
	}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.selectCallback?.(value, evt);
	}
}

export class Modal {
	contentEl = { empty: () => undefined };

	open(): void {}

	close(): void {
		this.onClose();
	}

	onClose(): void {}
}

export class Plugin {}
export class ItemView {}
export class Menu {}
export class Notice {
	/** No real DOM in the default (node) test environment: enough surface for a caller that wires
	 * an optional click action (H15.2's `notices.pluginStartFailed`) without needing jsdom. */
	containerEl: { addEventListener: (type: string, listener: () => void) => void } = {
		addEventListener: () => undefined,
	};
	constructor(_message?: string, _timeout?: number) {}
}
export class PluginSettingTab {}
export class SecretComponent {}
export class Setting {}
export class TFile {}

/**
 * The shape `requestUrl` resolves to.
 *
 * The real one decodes `arrayBuffer` as UTF-8 into `text`, and `json` is a getter that parses
 * that text. Since R1a the plugin reads only `text` (`ObsidianHost`'s HTTP port) and parses it
 * itself, so a responder may give `text` directly or leave it out and give `json`: the mock then
 * serializes `json` into `text`, the body a real server would have sent for that value.
 */
export interface MockRequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text?: string;
}

export type MockRequestUrlResponder = (request: unknown) => MockRequestUrlResponse;

let requestUrlResponder: MockRequestUrlResponder | null = null;

export async function requestUrl(request?: unknown): Promise<MockRequestUrlResponse & { text: string }> {
	const response = requestUrlResponder !== null
		? requestUrlResponder(request)
		: { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
	return { ...response, text: response.text ?? JSON.stringify(response.json) };
}

/** No real tooltip in the node test environment; records nothing. */
export function setTooltip(): void {}

/**
 * Test-only companion to `requestUrl`; the real Obsidian API exposes no setter.
 *
 * Passing `null` restores the empty 200 above, and every test that sets one must
 * restore it: the responder is module state shared by the whole run.
 */
export function setMockRequestUrl(responder: MockRequestUrlResponder | null): void {
	requestUrlResponder = responder;
}

let appLanguage = 'en';

/** Mirrors Obsidian's configured app language, which defaults to `en` like the real API. */
export function getLanguage(): string {
	return appLanguage;
}

/** Test-only companion to `getLanguage`; the real Obsidian API exposes no setter. */
export function setMockLanguage(isoCode: string): void {
	appLanguage = isoCode;
}

/** Records the requested Lucide icon id on the element instead of rendering real markup. */
export function setIcon(el: { setAttribute(name: string, value: string): void }, iconId: string): void {
	el.setAttribute('data-icon', iconId);
}
