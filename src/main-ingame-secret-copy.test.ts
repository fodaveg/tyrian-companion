import type { App, PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

// Every notice the plugin raises and every fallback modal it opens, with what they were handed:
// that is the whole surface this file asserts the token never leaks through.
const surfaces = vi.hoisted(() => ({
	notices: [] as string[],
	modals: [] as Array<{ secret: string; copy: { title: string; hint: string }; opened: boolean }>,
}));
vi.mock('obsidian', async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	class RecordingNotice {
		containerEl = { addEventListener: () => undefined };
		constructor(message?: string) { surfaces.notices.push(String(message)); }
	}
	return { ...original, Notice: RecordingNotice };
});
vi.mock('./ui/alert-ingame-secret-modal', () => ({
	AlertIngameSecretModal: class {
		private readonly record: (typeof surfaces.modals)[number];
		constructor(_app: unknown, secret: string, copy: { title: string; hint: string }) {
			this.record = { secret, copy, opened: false };
			surfaces.modals.push(this.record);
		}
		open(): void { this.record.opened = true; }
	},
}));

import TyrianCompanionPlugin, { ALERT_INGAME_SECRET_COMMAND_ID, type AlertIngameSecretCopyOutcome } from './main';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugLogger } from './core/local-debug-logger';
import { ALERT_INGAME_SECRET_ID, DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';

interface SecretCopyHarness {
	settings: TyrianSettings;
	copyAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome>;
	copyAlertIngameSecretFromCommand(): Promise<void>;
}

const USER_SECRET = 'u'.repeat(40);

describe('0.2.1 "Copy in-game bridge token" command', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		surfaces.notices.length = 0;
		surfaces.modals.length = 0;
	});

	it('with the bridge off says to turn it on first and generates nothing', async () => {
		const { plugin, secrets, clipboard, saved } = secretCopyPlugin({ alertIngameEnabled: false });

		await plugin.copyAlertIngameSecretFromCommand();

		expect(surfaces.notices).toEqual(['Turn on “In-game alert” in Settings → Advanced first.']);
		expect(secrets.size).toBe(0);
		expect(saved).toEqual([]);
		expect(clipboard.writes).toEqual([]);
		expect(surfaces.modals).toEqual([]);
	});

	it('generates a token when there is none, copies it and says so without the value', async () => {
		const { plugin, secrets, clipboard, saved } = secretCopyPlugin({ alertIngameEnabled: true });

		await plugin.copyAlertIngameSecretFromCommand();

		const generated = secrets.get(ALERT_INGAME_SECRET_ID);
		expect(generated).toMatch(/^[\w-]{43}$/u);
		expect(clipboard.writes).toEqual([generated]);
		// `data.json` only ever gets the entry's name.
		expect(saved).toEqual([{ alertIngameSecret: ALERT_INGAME_SECRET_ID }]);
		expect(surfaces.notices).toEqual(['New token created and copied.']);
		expect(surfaces.modals).toEqual([]);
	});

	it('copies the selected token as it is and says it was copied', async () => {
		const { plugin, secrets, clipboard } = secretCopyPlugin({ alertIngameEnabled: true, alertIngameSecret: 'mine' });
		secrets.set('mine', USER_SECRET);

		await plugin.copyAlertIngameSecretFromCommand();

		expect(clipboard.writes).toEqual([USER_SECRET]);
		expect(surfaces.notices).toEqual(['Token copied.']);
		expect(secrets.has(ALERT_INGAME_SECRET_ID)).toBe(false);
	});

	it('reports the existing failure copy when the copy itself fails', async () => {
		const { plugin, secretStorage } = secretCopyPlugin({ alertIngameEnabled: true });
		secretStorage.setSecret = () => { throw new Error('secret storage locked'); };

		await plugin.copyAlertIngameSecretFromCommand();

		expect(surfaces.notices).toEqual(['The token could not be copied.']);
	});

	it('registers the command on load, named from the catalog', () => {
		const commands: Array<{ id: string; name: string; callback?: () => void }> = [];
		const plugin = new TyrianCompanionPlugin({} as App, { id: 'tyrian-companion' } as PluginManifest);
		plugin.settings = { ...DEFAULT_SETTINGS, language: 'es' };
		plugin.addCommand = vi.fn((command: { id: string; name: string }) => {
			commands.push(command);
			return command;
		});
		(plugin as unknown as { registerAlertIngameSecretCommand(): void }).registerAlertIngameSecretCommand();
		const copy = vi.spyOn(plugin as unknown as SecretCopyHarness, 'copyAlertIngameSecretFromCommand').mockResolvedValue();

		expect(commands.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: ALERT_INGAME_SECRET_COMMAND_ID, name: 'Copiar token del puente con el juego' },
		]);
		commands[0]!.callback!();
		expect(copy).toHaveBeenCalledOnce();
	});
});

describe('0.2.1 "Copy token" clipboard fallback', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		surfaces.notices.length = 0;
		surfaces.modals.length = 0;
	});

	it('opens the modal with the token when the clipboard throws, from the settings button path', async () => {
		const { plugin, secrets, records } = secretCopyPlugin({ alertIngameEnabled: true, alertIngameSecret: 'mine' }, { clipboardFails: true });
		secrets.set('mine', USER_SECRET);

		await expect(plugin.copyAlertIngameSecret()).resolves.toBe('shown');

		expect(surfaces.modals).toEqual([{
			secret: USER_SECRET,
			copy: { title: 'Addon token', hint: 'The clipboard did not respond. Copy it with Ctrl+C (Cmd+C on macOS).' },
			opened: true,
		}]);
		expect(surfaces.notices).toEqual([]);
		const failure = records.find((record) => record.phase === 'failure');
		expect(failure).toMatchObject({
			component: 'notification', action: 'command_execute', state: 'ingame_secret_copy', level: 'warn', code: 'unavailable',
		});
		expect(JSON.stringify(records)).not.toContain(USER_SECRET);
		expect(JSON.stringify(records)).not.toContain('clipboard refused');
	});

	it('opens the modal with a freshly generated token from the command, and no notice or record carries it', async () => {
		const { plugin, secrets, records } = secretCopyPlugin({ alertIngameEnabled: true }, { clipboardFails: true });

		await plugin.copyAlertIngameSecretFromCommand();

		const generated = secrets.get(ALERT_INGAME_SECRET_ID);
		expect(generated).toMatch(/^[\w-]{43}$/u);
		expect(surfaces.modals.map(({ secret, opened }) => ({ secret, opened }))).toEqual([{ secret: generated, opened: true }]);
		expect(surfaces.notices).toEqual([]);
		expect(records.length).toBeGreaterThan(0);
		expect(JSON.stringify(records)).not.toContain(generated!);
	});
});

function secretCopyPlugin(
	settings: Partial<TyrianSettings>,
	options: { clipboardFails?: boolean } = {},
) {
	const secrets = new Map<string, string>();
	const secretStorage = {
		listSecrets: () => [...secrets.keys()],
		getSecret: (id: string) => secrets.get(id) ?? null,
		setSecret: (id: string, value: string) => { secrets.set(id, value); },
	};
	const app = { vault: { configDir: 'test-config-dir' }, secretStorage } as unknown as App;
	const plugin = new TyrianCompanionPlugin(app, { id: 'tyrian-companion' } as PluginManifest);
	const records: LocalDebugRecordInput[] = [];
	const saved: Array<Partial<TyrianSettings>> = [];
	const target = plugin as unknown as SecretCopyHarness & {
		app: App;
		localDebugActions: LocalDebugActionRunner;
		updateSettings(update: Partial<TyrianSettings>): Promise<unknown>;
	};
	target.app = app;
	target.settings = { ...structuredClone(DEFAULT_SETTINGS), language: 'en', ...settings };
	target.localDebugActions = new LocalDebugActionRunner({
		diagnostics: { record: (input: LocalDebugRecordInput) => { records.push(input); return true; } } as unknown as LocalDebugLogger,
		createId: () => 'ingame-secret-copy',
	});
	target.updateSettings = async (update) => {
		saved.push(update);
		Object.assign(target.settings, update);
		return { status: 'saved', inventoryAdvisor: 'unchanged' };
	};
	const clipboard = { writes: [] as string[] };
	vi.stubGlobal('navigator', {
		clipboard: {
			writeText: async (text: string) => {
				if (options.clipboardFails) throw new DOMException('clipboard refused: Document is not focused.', 'NotAllowedError');
				clipboard.writes.push(text);
			},
		},
	});
	return { plugin: target, secrets, secretStorage, clipboard, records, saved };
}
