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
export class Notice {}
export class PluginSettingTab {}
export class SecretComponent {}
export class Setting {}
export class TFile {}

export async function requestUrl(): Promise<{ status: number; headers: Record<string, string>; json: unknown }> {
	return { status: 200, headers: {}, json: {} };
}
