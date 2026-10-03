/**
 * Tyrian as an external Hebra plugin (SPEC-PLUGINS-EXTERNOS.md §3 and §11.3): what `activate(api)`
 * does with the API Hebra hands it.
 *
 * 1. waits for the library to be open (`ui.onReady`: on the web only the owning tab gets there);
 * 2. builds HebraHost over the API: Hebra's HTTP without CORS where it has it, the keychain entry
 *    the compiled module used (through the `api-key` alias), the TCP bridge, system notifications
 *    and background activity where the platform has them, and the same storage keys and IndexedDB
 *    databases as before, so nothing is copied (§11.2);
 * 3. puts Obsidian's `is-mobile` class on a touch device and starts `createTyrianRuntime(host)`.
 *    The stylesheet is not installed here: Hebra injects `hebra-styles.css` itself (§3.1);
 * 4. when the index left Tyrian notes unadopted, shows them in the plugin's settings.
 *
 * The cleanup it returns removes the class and stops the core; Hebra undoes the `ui`
 * registrations. It RETURNS the promise of stopping the core: a restart (`workspace.restart`)
 * waits for it before starting the new one, so the two never overlap (alert socket, storage,
 * IndexedDB, keychain).
 *
 * On iPhone and the web the same code runs in consultation mode, as it did inside Hebra: there is
 * no TCP bridge nor system notifications there (`api.has` says so), and on the web neither HTTP nor
 * the keychain until Hebra has them.
 */
import type { HebraPluginApi, PluginCleanup } from 'hebra-plugin-api';

import { canonicalPathFor } from '../../runtime/canonical-path';
import { createTyrianRuntime } from '../../runtime/tyrian-companion-core';
import { installDomHelpers } from '../dom-polyfill';
import type { TyrianHost, TyrianRuntime } from '../tyrian-host';
import {
	createHebraHost,
	createHostFailureChannel,
	tyrianPlatform,
	type HebraHostWindow,
	type HostFailureChannel,
} from './hebra-host';
import { createIndexedDbFileBackend, LOCAL_FILES_DATABASE } from './local-storage';
import { installObsidianMobileClass, type MobileClassWindow } from './mobile-class';
import { createIndexedDbPathIndexKv, PATH_INDEX_DATABASE } from './path-index-kv';
import { hebraSecretsBackend } from './secrets';
import { registerUnadoptedNotes } from './unadopted-panel';

/** What the plugin reads of the page besides the API (injectable for tests). */
export interface HebraRuntimeEnvironment {
	readonly indexedDB: IDBFactory;
	readonly window: HebraHostWindow & MobileClassWindow;
	readonly document: Document;
	/** The URL this module was loaded from (`import.meta.url`: a `blob:` URL inside Hebra). */
	readonly moduleUrl?: string;
	readonly createRuntime?: (host: TyrianHost) => TyrianRuntime;
	/** Where the adapter's failures go (tests); by default the core's diagnostic log. */
	readonly failures?: HostFailureChannel;
}

export async function activateTyrian(api: HebraPluginApi, environment: HebraRuntimeEnvironment): Promise<PluginCleanup> {
	const failures = environment.failures ?? createHostFailureChannel();
	const report = (error: unknown, where: string): void => failures.report(error, where);
	// The adapter's own DOM (settings rows, folder picker) is built with Obsidian's helpers, like the
	// core's UI; the core installs them too, but this does not depend on it having started yet.
	installDomHelpers();
	await new Promise<void>((resolve) => { api.ui.onReady(resolve); });
	const handle = await createHebraHost({
		api,
		indexedDB: environment.indexedDB,
		pathIndexKv: createIndexedDbPathIndexKv(environment.indexedDB, api.storage.indexedDbName(PATH_INDEX_DATABASE)),
		fileBackend: createIndexedDbFileBackend(environment.indexedDB, api.storage.indexedDbName(LOCAL_FILES_DATABASE)),
		secretsBackend: await hebraSecretsBackend(api, report),
		canonicalPathFor,
		platform: tyrianPlatform(api.env),
		window: environment.window,
		report,
		failures,
		...(environment.moduleUrl === undefined ? {} : { moduleUrl: environment.moduleUrl }),
	});
	const removeMobileClass = installObsidianMobileClass(environment.document, environment.window, api.env.appleMobile());
	const runtime = (environment.createRuntime ?? createTyrianRuntime)(handle.host);
	try {
		await runtime.start();
	} catch (error) {
		handle.dispose();
		removeMobileClass();
		throw error;
	}
	// After `start()`: the core's panel stays first in the plugin's settings.
	registerUnadoptedNotes(api.ui, {
		notes: handle.unadopted,
		outputFolder: handle.outputFolder,
		seededNow: handle.seed !== null,
		openNote: (id) => api.workspace.openNote(id),
		report: (error) => report(error, 'unadopted'),
	});
	return () => {
		handle.dispose();
		removeMobileClass();
		return runtime.stop()
			.then(() => handle.flush())
			.catch((error: unknown) => report(error, 'stop'));
	};
}
