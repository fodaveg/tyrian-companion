import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('session debug semantics', () => {
	it('wires the price-history scheduler to a distinct lifecycle from its capture operation', () => {
		const prices = readFileSync('src/economy/price-history-runtime.ts', 'utf8');

		expect(prices).toMatch(/new ApiPollScheduler\(\{[\s\S]*?diagnosticContext: \{\s*component: 'price_history',\s*action: 'price_history_poll',\s*\},[\s\S]*?\}\);/u);
		expect(prices).toMatch(/startLocalDebugAction\(this\.options\.diagnostics, \{\s*component: 'price_history', action: 'price_history_capture'/u);
	});

	it('reserves human session actions for gestures and labels internal maintenance explicitly', () => {
		const source = readFileSync('src/main.ts', 'utf8');

		expect(source).toContain("this.persistenceDiagnostics('session', 'session_lease')");
		expect(source).not.toContain("this.persistenceDiagnostics('session', 'session_start')");
		expect(source).toContain("this.persistenceDiagnostics('session', 'session_projection')");
		expect(source).toContain("action: 'session_projection', state: 'loot_projection'");
		expect(source).toContain("action: 'detection_disarm', state: 'session_stopped'");
	});
});
