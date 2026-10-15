/**
 * The harness that puts Tyrian's bundle in a Hebra web dev server with the plugin API 2.x and opens it.
 *
 * Copied, trimmed to what the Tyrian specs need, from Hebra `cfd4561f`:
 * - `e2e/c1-tyrian/c1-tyrian-070.spec.ts`: `frameCsp`, `attachFakeNetwork`, `attachFakeHttpRelay`,
 *   `attachFakeGithub`, `serveFrameOrigin`, `openLibrary`, `installAndEnable`;
 * - `e2e/c1-l3/marco-harness.ts`: `bootScript`, `allowFrameOrigin`;
 * - `e2e/lumbre-session-semilla.mjs`: `sembrarCredencialEnElNavegador`, `sembrarSesionLumbreConectada`
 *   and its echo of the sync socket (Hebra's library does not open without a live Lumbre session).
 *
 * What it IMITATES (the web dev server has no Rust and no vhost): the plugin origin
 * (`http://tyrian-companion.localhost:<port>`) is served here with the frame CSP Hebra's `frame_csp`
 * computes; Hebra's own `frame-src` is widened to that one origin, only in this e2e; the frame boot is
 * Hebra's real `src/lib/plugins/frame/frame-boot.ts`, bundled with Hebra's own Vite. Network: nothing
 * but localhost leaves; GW2 and datawars2 answer a fake 401 (directly and through Hebra's relay),
 * `render.guildwars2.com` a 1 px PNG, GitHub is a fake that serves the bundle under test, signed
 * with Hebra's TEST key (`firma.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Frame, Page, Route, WebSocketRoute } from '@playwright/test';

import { BUNDLE_DIR, FRAME_ORIGIN_TEMPLATE, hebraUnavailable, HEBRA_ORIGIN, HEBRA_REPO } from './entorno';
import { releaseFileBytes, SIGNATURE_FILE, TEST_SIGNING_KEY } from './firma';
import { expect } from './navegador';

interface Manifest {
	id: string;
	name: string;
	version: string;
	repo: string;
	files: Record<string, string>;
	network?: { images?: string[] };
}

function readManifest(): Manifest {
	if (hebraUnavailable() !== null) return { id: 'tyrian-companion', name: 'Tyrian Companion', version: '0', repo: '', files: {} };
	return JSON.parse(readFileSync(join(BUNDLE_DIR, 'hebra.json'), 'utf8')) as Manifest;
}

export const manifest = readManifest();
export const PLUGIN_ID = manifest.id;
export const FRAME_ORIGIN = FRAME_ORIGIN_TEMPLATE.replaceAll('{id}', PLUGIN_ID);
const SERVED_FILES = ['hebra.json', ...Object.keys(manifest.files), SIGNATURE_FILE];
const CATALOG_URL = 'https://raw.githubusercontent.com/fodaveg/hebra-plugins/main/plugins.json';
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'accept, authorization, content-type',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The frame CSP of Hebra's `frame_csp` (Rust): `img-src` with `network.images`, `frame-ancestors` Hebra. */
function frameCsp(): string {
	const images = (manifest.network?.images ?? []).map((host) => ` https://${host}`).join('');
	return `default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; `
		+ `img-src 'self' data: blob:${images}; font-src 'self' data:; media-src 'self' blob: data:; `
		+ `connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; `
		+ `frame-ancestors ${HEBRA_ORIGIN}`;
}

/** Adds `sources` to `frame-src` of a CSP, and nothing else. */
function allowFrameOrigin(csp: string, ...sources: string[]): string {
	return csp
		.split(';')
		.map((directive) => (directive.trim().startsWith('frame-src ') ? `${directive.trim()} ${sources.join(' ')}` : directive.trim()))
		.join('; ');
}

/** Hebra's frame boot (`frame-boot.ts`), bundled into ONE module with Hebra's own Vite, and started. */
async function bootScript(): Promise<string> {
	const vitePackage = JSON.parse(readFileSync(join(HEBRA_REPO, 'node_modules', 'vite', 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
	const entry = vitePackage.exports['.'];
	if (typeof entry !== 'string') throw new Error('unexpected exports of Hebra\'s vite');
	// eslint-disable-next-line no-unsanitized/method -- Hebra's own Vite, from the HEBRA_REPO checkout this harness drives.
	const vite = (await import(pathToFileURL(join(HEBRA_REPO, 'node_modules', 'vite', entry)).href)) as {
		build(config: unknown): Promise<unknown>;
	};
	const result = await vite.build({
		configFile: false,
		root: HEBRA_REPO,
		logLevel: 'silent',
		build: {
			write: false,
			minify: false,
			lib: {
				entry: join(HEBRA_REPO, 'src', 'lib', 'plugins', 'frame', 'frame-boot.ts'),
				formats: ['es'],
				fileName: () => 'boot.js',
			},
		},
	});
	type Chunk = { type: string; code?: string };
	const outputs = (Array.isArray(result) ? result : [result]) as Array<{ output?: Chunk[] }>;
	const chunk = outputs.flatMap((output) => output.output ?? []).find((item) => item.type === 'chunk');
	if (chunk?.code === undefined) throw new Error('Hebra\'s Vite did not bundle the frame boot');
	const code = chunk.code.replace(/^export\s*\{[^}]*\};?\s*$/mu, '');
	return `${code}\nbootPluginFrame(window);\n`;
}

let bootCache: Promise<string> | null = null;

/** Everything not on localhost is cut; GW2 and datawars2 answer 401, the icon service a 1 px PNG. */
async function attachFakeNetwork(page: Page): Promise<void> {
	// Registered FIRST: the routes added later take precedence and pass what is theirs; this gets the rest.
	await page.context().route('**/*', (route) => {
		const url = new URL(route.request().url());
		const host = url.hostname;
		if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) return route.fallback();
		if (url.protocol === 'data:' || url.protocol === 'blob:') return route.fallback();
		if (host === 'api.guildwars2.com' || host === 'api.datawars2.ie') {
			if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			return route.fulfill({ status: 401, contentType: 'application/json', headers: CORS, body: JSON.stringify({ text: 'Invalid access token' }) });
		}
		if (host === 'render.guildwars2.com') return route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG_1PX });
		return route.abort('blockedbyclient');
	});
	// Hebra's web relay of `api.http` (`/plugins-http/<host>/...`, served by Caddy in production; the dev
	// server would answer 404): answered as GW2 would answer without a key.
	await page.route('**/plugins-http/**', (route) => {
		const options = route.request().method() === 'OPTIONS';
		return route.fulfill({
			status: options ? 204 : 401,
			contentType: 'application/json',
			headers: CORS,
			body: options ? '' : JSON.stringify({ text: 'Invalid access token' }),
		});
	});
}

/** The fake catalogue and GitHub release of the bundle under test, with the TEST signature. */
async function attachFakeGithub(page: Page): Promise<void> {
	const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
	const preflight = (route: Route) => route.request().method() === 'OPTIONS';
	await page.route('https://raw.githubusercontent.com/**', (route) => {
		if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
		if (route.request().url() !== CATALOG_URL) return route.fulfill({ status: 404, headers: CORS, body: 'no' });
		return json(route, {
			schema: 1,
			plugins: [{
				id: PLUGIN_ID,
				name: manifest.name,
				description: 'Tyrian Companion under the surface e2e.',
				author: 'fodaveg',
				repo: manifest.repo,
				icon: 'sword',
				platforms: ['web', 'macos', 'ios', 'linux', 'windows'],
				ageRating: '4+',
				signingKey: TEST_SIGNING_KEY,
			}],
		});
	});
	await page.route('https://api.github.com/**', (route) => {
		if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
		if (route.request().url() !== `https://api.github.com/repos/${manifest.repo}/releases`) return route.fulfill({ status: 404, headers: CORS, body: '{}' });
		return json(route, [{
			tag_name: manifest.version,
			draft: false,
			prerelease: false,
			assets: SERVED_FILES.map((name) => ({
				name,
				browser_download_url: `https://github.com/${manifest.repo}/releases/download/${manifest.version}/${name}`,
			})),
		}]);
	});
	await page.route('https://github.com/**', (route) => route.fulfill({ status: 404, headers: CORS, body: 'no' }));
	await page.route('**/plugins-relay/**', (route) => {
		const url = new URL(route.request().url());
		const match = new RegExp(`^/plugins-relay/${manifest.repo}/releases/download/${manifest.version}/([^/?]+)$`, 'u').exec(url.pathname);
		const name = match?.[1];
		if (route.request().method() !== 'GET' || name === undefined || !SERVED_FILES.includes(name)) return route.fulfill({ status: 404, body: '' });
		return route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' },
			body: releaseFileBytes(BUNDLE_DIR, name),
		});
	});
}

/** Serves the plugin origin (what L2 does) and opens Hebra's `frame-src` to it. */
async function serveFrameOrigin(page: Page): Promise<void> {
	bootCache ??= bootScript();
	const boot = await bootCache;
	const csp = frameCsp();
	await page.context().route(`${FRAME_ORIGIN}/**`, (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === '/__hebra/runtime.html') {
			return route.fulfill({
				status: 200,
				contentType: 'text/html',
				headers: { 'Content-Security-Policy': csp },
				body: '<!doctype html><meta charset="utf-8"><title>runtime</title><script type="module" src="/__hebra/boot.js"></script>',
			});
		}
		if (url.pathname === '/__hebra/boot.js') {
			return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Content-Security-Policy': csp }, body: boot });
		}
		const name = url.pathname.slice(1);
		if (name in manifest.files) {
			return route.fulfill({
				status: 200,
				contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript',
				headers: { 'Content-Security-Policy': csp },
				body: readFileSync(join(BUNDLE_DIR, name)),
			});
		}
		return route.fulfill({ status: 404, body: '' });
	});
	await page.route(`${HEBRA_ORIGIN}/**`, async (route) => {
		const request = route.request();
		if (request.resourceType() !== 'document' || request.frame() !== page.mainFrame()) return route.fallback();
		const response = await route.fetch();
		const headers = { ...response.headers() };
		const policy = headers['content-security-policy'];
		if (policy !== undefined) headers['content-security-policy'] = allowFrameOrigin(policy, FRAME_ORIGIN);
		const body = (await response.text()).replace(
			/(<meta http-equiv="content-security-policy" content=")([^"]*)(")/iu,
			(_all, start: string, csp: string, end: string) => `${start}${allowFrameOrigin(csp, FRAME_ORIGIN)}${end}`,
		);
		return route.fulfill({ response, headers, body });
	});
}

const LUMBRE_DATABASE = { databaseName: 'hebra-integrations', databaseVersion: 2 };
const FAKE_LUMBRE_CONNECTION = {
	credentialId: 'e2e-credential',
	readToken: 'e2e-read-token',
	writeToken: 'e2e-write-token',
	apiOrigin: 'https://app.lumbre.pro',
	connectedAt: '2026-01-01T00:00:00.000Z',
};
/** `Y.encodeStateAsUpdate(new Y.Doc())`: an empty but valid Yjs update. */
const EMPTY_YJS_UPDATE_BASE64 = 'AAA=';
/** The header of an empty attachment batch (`HBA1` and a zero record count). */
const EMPTY_EAGER_ATTACHMENT_BATCH = Buffer.from([0x48, 0x42, 0x41, 0x31, 0, 0, 0, 0]);

/**
 * Writes a Lumbre credential in the IndexedDB Hebra's `credential-vault.ts` opens. Self-contained:
 * Playwright serialises it with `toString()` into every document, and it does nothing in a frame.
 */
function seedLumbreCredential(payload: { databaseName: string; databaseVersion: number; connection: unknown }): Promise<void> {
	if (typeof window !== 'undefined' && window.top !== window) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(payload.databaseName, payload.databaseVersion);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('credentials')) db.createObjectStore('credentials');
			if (!db.objectStoreNames.contains('operations')) db.createObjectStore('operations', { keyPath: 'id' });
			if (!db.objectStoreNames.contains('links')) {
				const links = db.createObjectStore('links', { keyPath: 'id' });
				links.createIndex('by-note', 'noteId');
				links.createIndex('by-task', 'taskId');
				links.createIndex('by-target', 'targetKey');
			}
			if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
		request.onsuccess = () => {
			const transaction = request.result.transaction('credentials', 'readwrite');
			transaction.objectStore('credentials').put(payload.connection, 'lumbre');
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'));
		};
	});
}

/** Hebra's library opens only with a live Lumbre session: credential, status probe, attachments, sync socket. */
async function seedConnectedLumbreSession(page: Page): Promise<void> {
	await page.addInitScript(seedLumbreCredential, { ...LUMBRE_DATABASE, connection: FAKE_LUMBRE_CONNECTION });
	await page.route('**/api/integrations/hebra/tasks*', (route) => route.request().method() === 'OPTIONS'
		? route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } })
		: route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ tasks: [] }) }));
	await page.route('**/api/integrations/hebra/attachments/manifest*', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(route.request().method() === 'POST' ? { missing: [] } : { attachments: [], nextCursor: null }),
	}));
	await page.route('**/api/integrations/hebra/attachments/eager', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: EMPTY_EAGER_ATTACHMENT_BATCH }));
	await page.routeWebSocket('**/hebra-sync', (ws: WebSocketRoute) => {
		ws.onMessage((raw) => {
			let message: { requestId?: unknown };
			try {
				message = JSON.parse(String(raw)) as { requestId?: unknown };
			} catch {
				return;
			}
			if (typeof message.requestId !== 'string') return;
			ws.send(JSON.stringify({ type: 'sync-result', requestId: message.requestId, update: EMPTY_YJS_UPDATE_BASE64 }));
		});
	});
}

/** Fakes the network, serves the plugin origin and opens Hebra's library. */
export async function openLibrary(page: Page): Promise<void> {
	await attachFakeNetwork(page);
	await attachFakeGithub(page);
	await serveFrameOrigin(page);
	await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
	await seedConnectedLumbreSession(page);
	await page.goto('/');
	await expect(page.locator('[data-library="v1"]')).toBeVisible({ timeout: 30_000 });
}

/** On iPhone the library's chrome lives in a drawer; opens it when it is closed. */
export async function openDrawerIfNeeded(page: Page): Promise<void> {
	if (await page.locator('.lv1-app[data-nav-open="true"]').count() > 0) return;
	const drawer = page.getByRole('button', { name: 'Abrir biblioteca' });
	if (await drawer.isVisible()) {
		await drawer.click();
		await expect(page.locator('.lv1-app')).toHaveAttribute('data-nav-open', 'true');
	}
}

/** On iPhone, closes the library drawer when it is open (its scrim, «Cerrar biblioteca», takes the taps). */
export async function closeDrawerIfOpen(page: Page): Promise<void> {
	if (await page.locator('.lv1-app[data-nav-open="true"]').count() === 0) return;
	await page.getByRole('button', { name: 'Cerrar biblioteca' }).click();
	await expect(page.locator('.lv1-app')).toHaveAttribute('data-nav-open', 'false');
}

/** «Nota nueva» with a title and `body` typed into the editor, which is left blurred. */
export async function writeNote(page: Page, title: string, body: string): Promise<void> {
	await closeDrawerIfOpen(page);
	await page.getByRole('button', { name: 'Nota nueva' }).click();
	const field = page.getByLabel('Título de la nota');
	await field.fill(title);
	await field.press('Enter');
	await expect(page.locator('.lv1-editor .cm-content')).toBeFocused();
	await page.keyboard.insertText(body);
	// Out of the editor, so CodeMirror paints a block's widget instead of its source.
	await page.locator('.lv1-editor .cm-content').evaluate((el) => { (el as HTMLElement).blur(); });
}

/**
 * «Dónde se muestra» › «Barra lateral» in Tyrian's settings, reached the way a user does from the main
 * view: the shell's settings button («Ajustes de Tyrian Companion») opens Hebra's Settings on Tyrian's
 * panel, a `tyrian-hebra-surface--settings` frame. Settings are closed afterwards.
 */
export async function chooseSidebarPlacement(page: Page): Promise<void> {
	await openCompanion(page);
	const main = page.locator(`[data-module-main="${MAIN_VIEW}"] iframe`).filter({ visible: true }).first();
	await main.contentFrame().getByRole('button', { name: 'Ajustes de Tyrian Companion' }).click();
	let settings: Frame | undefined;
	await expect.poll(async () => {
		settings = undefined;
		for (const frame of await visibleSurfaces(page)) {
			if (await frame.locator('#hebra-surface-root.tyrian-hebra-surface--settings').count() > 0) settings = frame;
		}
		return settings !== undefined;
	}, { timeout: 30_000, message: 'Tyrian\'s settings panel' }).toBe(true);
	const select = settings!.locator('.setting-item').filter({ hasText: 'Dónde se muestra' }).locator('select');
	await expect(select).toBeVisible({ timeout: 30_000 });
	await select.selectOption('sidebar');
	await expect(select).toHaveValue('sidebar');
	await page.locator('.lv1-settings').getByRole('button', { name: 'Cerrar', exact: true }).first().click();
	await expect(page.locator('.lv1-settings')).toHaveCount(0);
	// The main view goes away with the placement.
	await expect(page.locator(`[data-module-main="${MAIN_VIEW}"]`)).toHaveCount(0, { timeout: 30_000 });
}

/** Tyrian's ribbon button → `entry` of its menu. */
export async function ribbonEntry(page: Page, entry: string): Promise<void> {
	await openDrawerIfNeeded(page);
	await page.locator(`[data-module-ribbon="${PLUGIN_ID}"]`).first().click();
	await page.getByRole('menuitem', { name: entry }).click();
}

/** Settings › Plugins: installs (third-party switch + consent), turns the plugin on and closes Settings. */
export async function installAndEnable(page: Page): Promise<void> {
	await openDrawerIfNeeded(page);
	await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
	// Desktop: a tab; iPhone: a row of the settings list. Settings load lazily: wait for either.
	const entry = page.getByRole('tab', { name: 'Plugins' }).or(page.locator('.lv1-settings-row').filter({ hasText: 'Plugins' })).first();
	await expect(entry).toBeVisible({ timeout: 30_000 });
	await entry.click();
	const trigger = page.locator('button[aria-controls="lv1-plugins-catalog"]');
	if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
	const gate = page.getByRole('switch', { name: 'Plugins de terceros' });
	await gate.click();
	await expect(gate).toBeChecked();
	await page.locator(`[data-catalog-install="${PLUGIN_ID}"]`).click();
	const sheet = page.locator(`[data-plugins-consent="${PLUGIN_ID}"]`);
	await expect(sheet).toBeVisible();
	await sheet.locator('[data-plugins-consent-accept]').click();
	await expect(sheet).toHaveCount(0);
	const row = page.locator(`[data-plugin="${PLUGIN_ID}"]`);
	await expect(row).toHaveAttribute('data-status', 'listo', { timeout: 30_000 });
	await page.getByRole('switch', { name: manifest.name, exact: true }).click();
	await expect(row).toHaveAttribute('data-enabled', 'true');
	await expect.poll(() => runtimeFrame(page) !== undefined, { timeout: 30_000 }).toBe(true);
	await page.locator('.lv1-settings').getByRole('button', { name: 'Cerrar', exact: true }).click();
	await expect(page.locator('.lv1-settings')).toHaveCount(0);
}

export const RIBBON_LABEL = 'Acciones de sesión de Tyrian Companion';
export const MAIN_VIEW = 'tyrian-main-view';

/** Tyrian's ribbon button → «Abrir acompañante»: the main view, open on a section. */
export async function openCompanion(page: Page): Promise<void> {
	await ribbonEntry(page, 'Abrir acompañante');
	await expect(page.locator(`[data-module-main="${MAIN_VIEW}"]`)).toBeVisible({ timeout: 30_000 });
}

/** The hidden frame the plugin runs in. */
export function runtimeFrame(page: Page): Frame | undefined {
	return page.frames().find((frame) => frame.url().startsWith(`${FRAME_ORIGIN}/`) && !frame.url().includes('role=surface'));
}

/** Every surface frame of the plugin (`role=surface`) whose `<iframe>` is visible in Hebra. */
export async function visibleSurfaces(page: Page): Promise<Frame[]> {
	const out: Frame[] = [];
	for (const frame of page.frames()) {
		if (!frame.url().startsWith(`${FRAME_ORIGIN}/`) || !frame.url().includes('role=surface')) continue;
		const owner = await frame.frameElement().catch(() => null);
		if (owner !== null && await owner.isVisible().catch(() => false)) out.push(frame);
	}
	return out;
}
