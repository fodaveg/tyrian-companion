import { defineConfig, devices } from '@playwright/test';

import {
	BROWSER,
	FRAME_ORIGIN_TEMPLATE,
	HEBRA_ORIGIN,
	HEBRA_PORT,
	HEBRA_REPO,
	hebraUnavailable,
} from './e2e/hebra-surface/harness/entorno';

// Geometry of Tyrian's UI inside the surfaces of Hebra 2.x (David, 15 Oct 2026): Hebra keeps the host's
// contract, Tyrian checks its own interface in Hebra's frames. A Hebra web dev server with the plugin
// API 2.x (`HEBRA_REPO`, default ~/code/hebra) installs this tree's bundle (or `TYRIAN_HEBRA_BUNDLE_DIR`)
// and the specs measure the shell's navigation, the ribbon button on iPhone and the price block.
//   npm run test:e2e:hebra
//   TYRIAN_E2E_BROWSER=webkit npm run test:e2e:hebra
// Not part of `npm run check`, `npm test` or the gate. Without a Hebra checkout every spec is skipped.
// One heavy suite at a time on the machine.
const webkit = BROWSER === 'webkit';
const hebraReady = hebraUnavailable() === null;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export default defineConfig({
	...(hebraReady ? {
		webServer: {
			command: `npm run dev -- --port ${HEBRA_PORT} --strictPort`,
			cwd: HEBRA_REPO,
			env: {
				VITE_HEBRA_LIBRARY_V1: '1',
				VITE_HEBRA_PLUGINS_V2: '1',
				VITE_HEBRA_PLUGINS_V2_ORIGIN: FRAME_ORIGIN_TEMPLATE,
				VITE_HEBRA_PLUGINS_V2_REALM: '0',
			},
			url: HEBRA_ORIGIN,
			reuseExistingServer: false,
			timeout: 120_000,
		},
	} : {}),
	globalSetup: './e2e/hebra-surface/harness/preparar-bundle.ts',
	use: {
		baseURL: HEBRA_ORIGIN,
		trace: 'off',
		screenshot: 'only-on-failure',
		serviceWorkers: 'block',
		// Chromium blocks Vite's reload WebSocket under «Local Network Access»: harness noise.
		...(webkit ? {} : { launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] } }),
	},
	projects: [
		{ name: 'escritorio', use: { ...(webkit ? devices['Desktop Safari'] : devices['Desktop Chrome']), viewport: { width: 1440, height: 900 } } },
		{
			name: 'iphone',
			use: {
				browserName: webkit ? 'webkit' : 'chromium',
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 3,
				isMobile: true,
				hasTouch: true,
				userAgent: IPHONE_UA,
			},
		},
	],
	expect: { timeout: 15_000 },
	timeout: 180_000,
	workers: 1,
	fullyParallel: false,
	reporter: 'list',
	outputDir: 'test-results-hebra-surface',
	testDir: 'e2e/hebra-surface',
	testMatch: '**/*.spec.ts',
});
