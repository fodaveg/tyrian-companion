/**
 * The `test` of the Hebra surface e2e, with WebKit possible.
 *
 * Copied from Hebra `cfd4561f`, `e2e/c1-l3/navegador.ts`: Playwright's WebKit only has OPFS in a
 * PERSISTENT context, and Hebra's library does not open without OPFS, so under WebKit the context is a
 * persistent one over a throwaway profile, with the origin's storage wiped first. Under Chromium it is
 * the usual context. Added here: `isMobile` and `hasTouch` reach the context (the iPhone project needs
 * them, and the original only forwarded viewport, user agent and scale), and `skipWithoutHebra`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base, webkit } from '@playwright/test';

import { hebraUnavailable } from './entorno';

/** WebKit keeps OPFS per ORIGIN between runs on this machine: emptied first. */
async function wipeOriginStorage(): Promise<void> {
	const root = await navigator.storage.getDirectory();
	const names: string[] = [];
	for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
	for (const name of names) await root.removeEntry(name, { recursive: true });
	const databases = (await indexedDB.databases?.()) ?? [];
	await Promise.all(databases.map((database) => new Promise<void>((resolve) => {
		if (!database.name) {
			resolve();
			return;
		}
		const request = indexedDB.deleteDatabase(database.name);
		request.onsuccess = request.onerror = request.onblocked = () => resolve();
	})));
	localStorage.clear();
}

export const test = base.extend({
	context: async ({ browser, browserName, baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, contextOptions }, use) => {
		const options = {
			...contextOptions,
			baseURL,
			viewport,
			userAgent,
			deviceScaleFactor,
			isMobile,
			hasTouch,
			serviceWorkers: 'block' as const,
		};
		if (browserName !== 'webkit') {
			const context = await browser.newContext(options);
			await use(context);
			await context.close();
			return;
		}
		const userDataDir = mkdtempSync(join(tmpdir(), 'tyrian-hebra-surface-webkit-'));
		try {
			const context = await webkit.launchPersistentContext(userDataDir, options);
			const blank = '/__tyrian_e2e_blank';
			const page = await context.newPage();
			await page.route(`**${blank}`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>e2e</p>' }));
			await page.goto(`${baseURL ?? ''}${blank}`);
			await page.evaluate(wipeOriginStorage);
			await page.close();
			await use(context);
			await context.close();
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	},
});

/**
 * Skips the calling spec file when there is no Hebra to run against. Called at the top of each spec:
 * a `test.skip` here would only reach the first file that imports this module (it is evaluated once).
 */
export function skipWithoutHebra(): void {
	const unavailable = hebraUnavailable();
	test.skip(unavailable !== null, unavailable ?? '');
}

export { expect } from '@playwright/test';
