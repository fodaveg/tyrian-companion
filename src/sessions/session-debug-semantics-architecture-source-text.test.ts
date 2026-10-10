import { describe, expect, it } from 'vitest';

import { readModuleSource } from '../test/module-boundary';

// Source-text half of `session-debug-semantics-architecture.test.ts` (GR-04): reads module source as
// text, so it sits in the frozen allowlist and runs only under `vitest.guardrails.config.mts`.
describe('session debug semantics (source text)', () => {
	/**
	 * H14.x. NOT converted in this pass. H14.17 lote L built the reusable composition harness this
	 * needs, `src/test/runtime-harness.ts` (fake Vault, `requestUrl`, `fake-indexeddb`, clock and a
	 * real `LocalDebugActionPort` that records every event) and confirmed a real, observable signal
	 * exists: a `persistenceDiagnostics(...)` probe's events always carry `details: { store,
	 * operation }` (see `createLocalDebugPersistenceSink` in `src/core/local-debug-persistence.ts`),
	 * while `startLocalDebugAction`/`fireAndForgetLocal`'s one-shot events never do. Driving a real
	 * manual-session start and stop through the harness to observe `session_lease`/`session_projection`
	 * probe events against a gesture-shaped `session_start`/`detection_disarm` event, the way
	 * `src/main-alert-wiring.test.ts` drives an alert, is still its own scoped follow-up: no lint
	 * rule or other guardrail inspects diagnostic call sites, so the property is not covered
	 * anywhere else and the text match stays here in the meantime.
	 */
	it('reserves human session actions for gestures and labels internal maintenance explicitly', () => {
		const source = readModuleSource('src/runtime/tyrian-companion-core.ts');

		expect(source).toContain("this.persistenceDiagnostics('session', 'session_lease')");
		expect(source).not.toContain("this.persistenceDiagnostics('session', 'session_start')");
		expect(source).toContain("this.persistenceDiagnostics('session', 'session_projection')");
		expect(source).toContain("action: 'session_projection', state: 'loot_projection'");
		expect(source).toContain("action: 'detection_disarm', state: 'session_stopped'");
	});
});
