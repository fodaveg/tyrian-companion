/**
 * Global setup of `playwright.hebra-surface.config.ts`: the bundle Hebra installs.
 *
 * By default it is THIS tree's: `npm run build:host-esm` (the same build `release:package` runs, with
 * its bundle guard) writes `hebra-main.mjs` and `hebra-styles.css`, and `hebra.json` is generated
 * from them with `createHebraManifest` of `scripts/release-package.mjs`, as the release does, into
 * `test-results-hebra-surface-bundle/` (git-ignored). With `TYRIAN_HEBRA_BUNDLE_DIR` nothing is
 * built: that folder is checked and used as it is.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BUNDLE_DIR, EXTERNAL_BUNDLE, hebraUnavailable, TYRIAN_ROOT } from './entorno';

const BUNDLE_FILES = ['hebra.json', 'hebra-main.mjs', 'hebra-styles.css'] as const;

interface ReleasePackageModule {
	createHebraManifest(input: {
		manifest: unknown;
		packageJson: unknown;
		version: string;
		files: Record<string, Buffer>;
		iconImage?: string;
	}): Record<string, unknown>;
	validateHebraManifest(input: unknown): string[];
	HEBRA_ICON_IMAGE_PREFIX: string;
}

export default async function prepareBundle(): Promise<void> {
	if (hebraUnavailable() !== null) return;
	if (EXTERNAL_BUNDLE) {
		const missing = BUNDLE_FILES.filter((name) => !existsSync(join(BUNDLE_DIR, name)));
		if (missing.length > 0) {
			throw new Error(`TYRIAN_HEBRA_BUNDLE_DIR=${BUNDLE_DIR} lacks ${missing.join(', ')}`);
		}
		return;
	}
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const build = spawnSync(npm, ['run', 'build:host-esm'], { cwd: TYRIAN_ROOT, stdio: 'inherit' });
	if (build.status !== 0) throw new Error(`npm run build:host-esm failed (exit ${String(build.status)})`);

	// eslint-disable-next-line no-unsanitized/method -- a fixed script of this repository, by absolute path.
	const release = (await import(pathToFileURL(join(TYRIAN_ROOT, 'scripts', 'release-package.mjs')).href)) as ReleasePackageModule;
	const readJson = (name: string): unknown => JSON.parse(readFileSync(join(TYRIAN_ROOT, name), 'utf8'));
	const manifest = readJson('manifest.json') as { version: string };
	const files = {
		'hebra-main.mjs': readFileSync(join(TYRIAN_ROOT, 'hebra-main.mjs')),
		'hebra-styles.css': readFileSync(join(TYRIAN_ROOT, 'hebra-styles.css')),
	};
	const hebraManifest = release.createHebraManifest({
		manifest,
		packageJson: readJson('package.json'),
		version: manifest.version,
		files,
		iconImage: `${release.HEBRA_ICON_IMAGE_PREFIX}${readFileSync(join(TYRIAN_ROOT, 'assets', 'hebra-icon.png')).toString('base64')}`,
	});
	const errors = release.validateHebraManifest(hebraManifest);
	if (errors.length > 0) throw new Error(`generated hebra.json is invalid: ${errors.join('; ')}`);

	rmSync(BUNDLE_DIR, { recursive: true, force: true });
	mkdirSync(BUNDLE_DIR, { recursive: true });
	for (const name of Object.keys(files)) copyFileSync(join(TYRIAN_ROOT, name), join(BUNDLE_DIR, name));
	writeFileSync(join(BUNDLE_DIR, 'hebra.json'), `${JSON.stringify(hebraManifest, null, '\t')}\n`);
}
