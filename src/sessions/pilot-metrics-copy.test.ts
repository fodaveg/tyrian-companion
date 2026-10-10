import { describe, expect, it } from 'vitest';

import { TRANSLATIONS } from '../core/i18n';

// Split out of `pilot-metrics-architecture.test.ts` (GR-04): this one reads the translation table, not
// module source, so it runs in `check` while the architecture file stays in the frozen source-text list.
describe('pilot metrics settings copy', () => {
	it('states that clear resets the review and disable leaves prior Vault exports untouched', () => {
		for (const locale of ['es', 'en'] as const) {
			expect(TRANSLATIONS[locale]['settings.pilot.clear.desc']).toMatch(/revisi|review/iu);
			expect(TRANSLATIONS[locale]['settings.pilot.disable.descExports']).toMatch(/Vault/u);
			expect(TRANSLATIONS[locale]['settings.pilot.disable.descExports']).toMatch(/no se tocan|not touched/iu);
		}
	});
});
