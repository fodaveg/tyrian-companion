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

import TyrianCompanionPlugin from './main';
import { obsidianPluginCore } from './test/obsidian-host-harness';
import { ALERT_INGAME_SECRET_COMMAND_ID, type AlertIngameSecretCopyOutcome } from './runtime/tyrian-companion-core';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugLogger } from './core/local-debug-logger';
import { ALERT_INGAME_SECRET_ID, DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';

interface SecretCopyHarness {
	settings: TyrianSettings;
	copyAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome>;
	copyAlertIngameSecretFromCommand(): Promise<void>;
	hasAlertIngameSecret(): boolean;
	regenerateAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome>;
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

		expect(surfaces.notices).toEqual(['Turn on “In-game alert” in the plugin settings first.']);
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

	it('knows whether a usable token exists, and "create new" replaces it, selects it and copies it', async () => {
		const { plugin, secrets, clipboard } = secretCopyPlugin({ alertIngameEnabled: true, alertIngameSecret: 'mine' });
		expect(plugin.hasAlertIngameSecret()).toBe(false);
		secrets.set('mine', USER_SECRET);
		expect(plugin.hasAlertIngameSecret()).toBe(true);

		await expect(plugin.regenerateAlertIngameSecret()).resolves.toBe('generated');

		const created = secrets.get(ALERT_INGAME_SECRET_ID);
		expect(created).toMatch(/^[\w-]{43}$/u);
		expect(created).not.toBe(USER_SECRET);
		expect(plugin.settings.alertIngameSecret).toBe(ALERT_INGAME_SECRET_ID);
		expect(clipboard.writes).toEqual([created]);

		await expect(plugin.regenerateAlertIngameSecret()).resolves.toBe('generated');
		expect(secrets.get(ALERT_INGAME_SECRET_ID)).not.toBe(created);
	});

	it('keeps the working token when "create new" cannot save its selection', async () => {
		const { plugin, secrets, clipboard } = secretCopyPlugin({ alertIngameEnabled: true, alertIngameSecret: ALERT_INGAME_SECRET_ID });
		secrets.set(ALERT_INGAME_SECRET_ID, USER_SECRET);
		const target = plugin as unknown as { updateSettings: (update: Partial<TyrianSettings>) => Promise<unknown> };
		target.updateSettings = async () => ({ status: 'blocked', reason: 'runtime_starting' });

		await expect(plugin.regenerateAlertIngameSecret()).rejects.toThrow();

		expect(secrets.get(ALERT_INGAME_SECRET_ID)).toBe(USER_SECRET);
		// HP-15: copied before the save, then overwritten once the save failed.
		expect(clipboard.writes).toHaveLength(2);
		expect(clipboard.writes[0]).toMatch(/^[\w-]{43}$/u);
		expect(clipboard.writes[0]).not.toBe(USER_SECRET);
		expect(clipboard.writes[1]).toBe('');

		target.updateSettings = async () => { throw new Error('disk full'); };
		await expect(plugin.regenerateAlertIngameSecret()).rejects.toThrow('disk full');
		expect(secrets.get(ALERT_INGAME_SECRET_ID)).toBe(USER_SECRET);
		expect(clipboard.writes.at(-1)).toBe('');
	});

	it('reports the existing failure copy when the copy itself fails', async () => {
		const { plugin, secretStorage } = secretCopyPlugin({ alertIngameEnabled: true });
		secretStorage.setSecret = () => { throw new Error('secret storage locked'); };

		await plugin.copyAlertIngameSecretFromCommand();

		expect(surfaces.notices).toEqual(['The token could not be copied.']);
	});

	// Before the runtime is ready `updateSettings` answers `blocked`: the generated token is in
	// SecretStorage but not selected, so the bridge would reject it. Neither "created and copied"
	// nor a token left in the clipboard (HP-15: the copy lands before the save, so it is
	// overwritten), and the next attempt reuses that same token instead of minting another.
	it('reports a failure and leaves no token copied when the token selection is not saved, then reuses the stored token', async () => {
		const { plugin, secrets, clipboard, saved, records } = secretCopyPlugin({ alertIngameEnabled: true });
		const target = plugin as unknown as { updateSettings: (update: Partial<TyrianSettings>) => Promise<unknown> };
		const save = target.updateSettings;
		target.updateSettings = async (update) => {
			saved.push(update);
			return { status: 'blocked', reason: 'runtime_starting' };
		};

		await plugin.copyAlertIngameSecretFromCommand();

		expect(surfaces.notices).toEqual(['The token could not be copied.']);
		const stored = secrets.get(ALERT_INGAME_SECRET_ID);
		expect(stored).toMatch(/^[\w-]{43}$/u);
		expect(clipboard.writes).toEqual([stored, '']);
		expect(surfaces.modals).toEqual([]);
		expect(plugin.settings.alertIngameSecret).toBe('');
		expect(records.find((record) => record.phase === 'failure')).toMatchObject({
			component: 'notification', action: 'command_execute', state: 'ingame_secret_copy',
		});
		await expect(plugin.copyAlertIngameSecret()).rejects.toThrow();
		expect(clipboard.writes).toEqual([stored, '', stored, '']);

		target.updateSettings = save;
		surfaces.notices.length = 0;
		clipboard.writes.length = 0;
		await plugin.copyAlertIngameSecretFromCommand();

		expect(secrets.get(ALERT_INGAME_SECRET_ID)).toBe(stored);
		expect(clipboard.writes).toEqual([stored]);
		expect(surfaces.notices).toEqual(['New token created and copied.']);
		expect(JSON.stringify(records)).not.toContain(stored!);
	});

	it('registers the command on load, named from the catalog', () => {
		const commands: Array<{ id: string; name: string; callback?: () => void }> = [];
		const plugin = new TyrianCompanionPlugin({} as App, { id: 'tyrian-companion' } as PluginManifest);
		// Registered through the core's host, which hands Obsidian's `addCommand` the command.
		plugin.addCommand = vi.fn((command: { id: string; name: string }) => {
			commands.push(command);
			return command;
		});
		plugin.core.settings = { ...DEFAULT_SETTINGS, language: 'es' };
		(plugin.core as unknown as { registerAlertIngameSecretCommand(): void }).registerAlertIngameSecretCommand();
		const copy = vi.spyOn((plugin.core as unknown as { alerts: SecretCopyHarness }).alerts, 'copyAlertIngameSecretFromCommand').mockResolvedValue();

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

// HP-15: WebKit (Hebra on Linux, macOS and iOS) accepts `writeText` only while the click's transient
// activation lasts. The fake below loses it at the first microtask after the click, so any `await`
// before the write (saving the token selection, for one) makes the clipboard refuse it.
describe('HP-15 "Create token" copies within the click\'s activation', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		surfaces.notices.length = 0;
		surfaces.modals.length = 0;
	});

	/** Turns the activation on for this task only, as a click does, then runs the action. */
	function click<T>(activation: { active: boolean }, action: () => Promise<T>): Promise<T> {
		activation.active = true;
		queueMicrotask(() => { activation.active = false; });
		return action();
	}

	it('creates the first token, saves its selection and copies it, from the settings button', async () => {
		const activation = { active: false };
		const { plugin, secrets, clipboard, saved } = secretCopyPlugin({ alertIngameEnabled: true }, { activation });

		await expect(click(activation, () => plugin.copyAlertIngameSecret())).resolves.toBe('generated');

		const generated = secrets.get(ALERT_INGAME_SECRET_ID);
		expect(generated).toMatch(/^[\w-]{43}$/u);
		expect(clipboard.writes).toEqual([generated]);
		expect(saved).toEqual([{ alertIngameSecret: ALERT_INGAME_SECRET_ID }]);
		expect(surfaces.modals).toEqual([]);
	});

	it('copies the replacement token from "create new"', async () => {
		const activation = { active: false };
		const { plugin, secrets, clipboard } = secretCopyPlugin({ alertIngameEnabled: true, alertIngameSecret: ALERT_INGAME_SECRET_ID }, { activation });
		secrets.set(ALERT_INGAME_SECRET_ID, USER_SECRET);

		await expect(click(activation, () => plugin.regenerateAlertIngameSecret())).resolves.toBe('generated');

		const created = secrets.get(ALERT_INGAME_SECRET_ID);
		expect(created).not.toBe(USER_SECRET);
		expect(clipboard.writes).toEqual([created]);
		expect(surfaces.modals).toEqual([]);
	});

	it('copies a new token from the palette command and says it was created and copied', async () => {
		const activation = { active: false };
		const { plugin, secrets, clipboard } = secretCopyPlugin({ alertIngameEnabled: true }, { activation });

		await click(activation, () => plugin.copyAlertIngameSecretFromCommand());

		expect(clipboard.writes).toEqual([secrets.get(ALERT_INGAME_SECRET_ID)]);
		expect(surfaces.notices).toEqual(['New token created and copied.']);
		expect(surfaces.modals).toEqual([]);
	});

	// The copy has landed by the time the save fails, and the activation is gone, so WebKit refuses
	// the overwrite: the token stays in the clipboard, but the failure copy of today says nothing was
	// copied, no "created and copied" claims it and no modal offers it.
	it('keeps today\'s failure copy when the selection is not saved after the copy landed', async () => {
		const activation = { active: false };
		const { plugin, secrets, clipboard, records } = secretCopyPlugin({ alertIngameEnabled: true }, { activation });
		const target = plugin as unknown as { updateSettings: (update: Partial<TyrianSettings>) => Promise<unknown> };
		target.updateSettings = async () => ({ status: 'blocked', reason: 'runtime_starting' });

		await click(activation, () => plugin.copyAlertIngameSecretFromCommand());

		expect(surfaces.notices).toEqual(['The token could not be copied.']);
		expect(surfaces.modals).toEqual([]);
		expect(clipboard.writes).toEqual([secrets.get(ALERT_INGAME_SECRET_ID)]);
		expect(plugin.settings.alertIngameSecret).toBe('');
		// The refused overwrite, then the action's own failure.
		expect(records.filter((record) => record.phase === 'failure').map(({ level, code }) => ({ level, code }))).toEqual([
			{ level: 'warn', code: 'unavailable' },
			{ level: 'error', code: 'unknown_failure' },
		]);
		expect(JSON.stringify(records)).not.toContain(secrets.get(ALERT_INGAME_SECRET_ID)!);
	});
});

/**
 * `activation.active` stands for WebKit's transient user activation: the test turns it on, queues a
 * microtask that turns it off, then calls the action. Any `await` before `writeText` lets that
 * microtask run first, so the fake clipboard refuses the write the way WebKit does.
 */
function secretCopyPlugin(
	settings: Partial<TyrianSettings>,
	options: { clipboardFails?: boolean; activation?: { active: boolean } } = {},
) {
	const secrets = new Map<string, string>();
	const secretStorage = {
		listSecrets: () => [...secrets.keys()],
		getSecret: (id: string) => secrets.get(id) ?? null,
		setSecret: (id: string, value: string) => { secrets.set(id, value); },
	};
	const app = { vault: { configDir: 'test-config-dir' }, secretStorage } as unknown as App;
	const { core } = obsidianPluginCore(app, { id: 'tyrian-companion' } as PluginManifest);
	const records: LocalDebugRecordInput[] = [];
	const saved: Array<Partial<TyrianSettings>> = [];
	const target = core as unknown as SecretCopyHarness & {
		localDebugActions: LocalDebugActionRunner;
		updateSettings(update: Partial<TyrianSettings>): Promise<unknown>;
	};
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
			writeText: (text: string) => {
				// Checked when `writeText` is called, not when its promise settles, as WebKit does.
				if (options.clipboardFails) return Promise.reject(new DOMException('clipboard refused: Document is not focused.', 'NotAllowedError'));
				if (options.activation?.active === false) return Promise.reject(new DOMException('clipboard refused: no user activation.', 'NotAllowedError'));
				clipboard.writes.push(text);
				return Promise.resolve();
			},
		},
	});
	return { plugin: target, secrets, secretStorage, clipboard, records, saved };
}
