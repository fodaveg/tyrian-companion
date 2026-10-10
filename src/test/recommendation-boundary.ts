import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by `src/economy/recommendation-envelope-architecture.test.ts` (reads the files' import
// specifiers, frozen source-text list) and `recommendation-envelope-surface.test.ts` (checks the
// detector and the loaded exports by behaviour, runs in `check`), GR-04.
const ECONOMY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'economy');

export const RECOMMENDATION_BOUNDARY_FILES: readonly string[] = readdirSync(ECONOMY_DIRECTORY)
	.filter((name) => name.includes('recommendation') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
	.sort();

const FORBIDDEN_MODULE_TOKEN = /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u;

export function forbiddenDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => FORBIDDEN_MODULE_TOKEN.test(token));
}
