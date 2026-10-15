/**
 * Where the Hebra surface e2e run: the Hebra checkout, the bundle under test, the ports and the
 * browser. Read by `playwright.hebra-surface.config.ts`, its global setup and the specs, so the
 * three agree without passing anything through the environment.
 *
 * - `HEBRA_REPO`: the Hebra checkout whose dev server hosts the plugin (default `~/code/hebra`).
 *   Without it, or without its `node_modules`, every spec is skipped with `hebraUnavailable()`.
 * - `TYRIAN_HEBRA_BUNDLE_DIR`: a folder with `hebra.json`, `hebra-main.mjs` and `hebra-styles.css`
 *   to measure instead of this tree's build (a published release, say).
 * - `TYRIAN_E2E_BROWSER=webkit`: WebKit instead of Chromium.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This repository's root. */
export const TYRIAN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const HEBRA_REPO = resolve(process.env.HEBRA_REPO ?? join(homedir(), 'code', 'hebra'));

/** Why the specs cannot run against `HEBRA_REPO`, or null when they can. */
export function hebraUnavailable(): string | null {
	if (!existsSync(join(HEBRA_REPO, 'package.json'))) {
		return `no Hebra checkout at ${HEBRA_REPO} (set HEBRA_REPO): Hebra surface e2e skipped`;
	}
	if (!existsSync(join(HEBRA_REPO, 'node_modules', 'vite', 'package.json'))) {
		return `the Hebra checkout at ${HEBRA_REPO} has no node_modules (run npm ci there): Hebra surface e2e skipped`;
	}
	return null;
}

/** True when the bundle comes from `TYRIAN_HEBRA_BUNDLE_DIR` instead of this tree. */
export const EXTERNAL_BUNDLE = (process.env.TYRIAN_HEBRA_BUNDLE_DIR ?? '') !== '';

/** The folder with `hebra.json`, `hebra-main.mjs` and `hebra-styles.css` that gets installed. */
export const BUNDLE_DIR = EXTERNAL_BUNDLE
	? resolve(process.env.TYRIAN_HEBRA_BUNDLE_DIR ?? '')
	: join(TYRIAN_ROOT, 'test-results-hebra-surface-bundle');

export const BROWSER: 'chromium' | 'webkit' = process.env.TYRIAN_E2E_BROWSER === 'webkit' ? 'webkit' : 'chromium';

// Derived from this checkout's path, like Hebra's C1 configs, in a range none of Hebra's configs use
// (theirs stop below 10 700), so a run here never takes a port a Hebra suite is about to bind.
const derived = parseInt(createHash('sha1').update(TYRIAN_ROOT).digest('hex').slice(0, 6), 16) % 300;
export const HEBRA_PORT = Number(process.env.TYRIAN_E2E_HEBRA_PORT ?? 11_300 + derived);
export const FRAME_PORT = Number(process.env.TYRIAN_E2E_FRAME_PORT ?? 11_700 + derived);
export const HEBRA_ORIGIN = `http://localhost:${HEBRA_PORT}`;
/** The plugin origin template Hebra's dev server is started with (`VITE_HEBRA_PLUGINS_V2_ORIGIN`). */
export const FRAME_ORIGIN_TEMPLATE = `http://{id}.localhost:${FRAME_PORT}`;
