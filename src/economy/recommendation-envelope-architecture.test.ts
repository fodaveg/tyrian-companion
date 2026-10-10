import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { moduleSpecifiers, readModuleSource } from '../test/module-boundary';
import { forbiddenDependency } from '../test/recommendation-boundary';

const ECONOMY_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_FILES = readdirSync(ECONOMY_DIRECTORY)
	.filter((name) => name.includes('recommendation') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
	.sort();

describe('recommendation architecture boundary', () => {
	it('fails when a recommendation module imports an I/O capability', () => {
		for (const name of BOUNDARY_FILES) {
			for (const specifier of moduleSpecifiers(readModuleSource(join(ECONOMY_DIRECTORY, name)))) {
				expect(forbiddenDependency(specifier),
					`${name} imports forbidden recommendation dependency ${specifier}`).toBe(false);
			}
		}
	});
});

// This guard covers static, side-effect and literal dynamic imports/requires; computed specifiers stay
// out of reach. Capability calls and capability-bearing decisions are covered by behavior instead:
// the repository-wide census in src/security-boundary.test.ts, the callback/secret/order rejection in
// recommendation-envelope.test.ts and the loaded runtime surface in recommendation-envelope-surface.test.ts.
