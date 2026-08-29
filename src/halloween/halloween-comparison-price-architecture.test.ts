import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('H11.3 and H11.5 architecture contract', () => {
	it('keeps comparison pure, exact, model-pinned, and independent from notes or Vault APIs', () => {
		const source = readFileSync('src/halloween/halloween-loot-comparison.ts', 'utf8');
		expect(source).toContain('halloweenTrickOrTreatBagModel()');
		expect(source).toContain('halloweenTrickOrTreatBagModelAt');
		expect(source).toContain('modelId: model.modelId');
		expect(source).toContain('modelVersion: model.modelVersion');
		expect(source).toContain('BigInt(outcome.sampleUnits) * BigInt(bagsDisappearedNet)');
		expect(source).toContain('HALLOWEEN_COMPARISON_Z_THRESHOLD_MILLI');
		expect(source).toContain('outcome.sampleUnits');
		expect(source).not.toMatch(/obsidian|vault\.|requestDetailed|fetch\(|session-note|scanHalloween/u);
	});

	it('seals only finalized review output and writes comparison in the same IndexedDB transaction', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		expect(main).toContain("result.status === 'finalized'");
		expect(main).toContain("'session_final'");
		const store = readFileSync('src/halloween/halloween-store.ts', 'utf8');
		expect(store).toContain('HALLOWEEN_DB_VERSION = 5');
		expect(store).toContain('HALLOWEEN_COMPARISON_STORE');
		const replacement = store.slice(store.indexOf('\treplaceEpisodeNotice('), store.indexOf('\n\treadLatestComparison'));
		expect(replacement).toContain('HALLOWEEN_COMPARISON_STORE');
		expect(replacement).toContain('comparisons.put(structuredClone(comparison))');
		expect(replacement).toContain('meta.put(');
	});

	it('feeds price evaluation only through the post-compaction H9.1 local read port', () => {
		const history = readFileSync('src/economy/price-history-runtime.ts', 'utf8');
		const halloween = readFileSync('src/halloween/halloween-price-alert-runtime.ts', 'utf8');
		expect(history.indexOf('await store.compactAndPrune')).toBeLessThan(history.indexOf('await this.options.afterCompaction'));
		expect(history).toContain('readDaily: async');
		expect(halloween).not.toMatch(/ApiPollScheduler|setInterval|setTimeout|requestDetailed|fetch\(/u);
		expect(halloween).toContain('port.readDaily(36_038, fromDayUtc)');
	});

	it('keeps the p90 alert opt-in, local, durable, crossing-based, and quantity-free', () => {
		const settings = readFileSync('src/core/settings.ts', 'utf8');
		expect(settings).toContain('SETTINGS_SCHEMA_VERSION = 8');
		expect(settings).toContain('halloweenPriceAlertEnabled: false');
		expect(settings).toContain('halloweenPriceAlertMinimumAboveP90Bps: 0');
		expect(settings).toContain('halloweenPriceAlertCooldownHours: 24');
		const store = readFileSync('src/halloween/halloween-store.ts', 'utf8');
		expect(store).toContain("const crossed = projection.status === 'high' && prior?.armed === true");
		expect(store).toContain('lastNotifiedDayUtc');
		expect(store).toContain('cooldownUntilMs');
		expect(store).toContain('lastValidCapturedAtMs');
		expect(store).toContain('projection.capturedAtMs <= prior.lastValidCapturedAtMs');
		const runtime = readFileSync('src/halloween/halloween-price-alert-runtime.ts', 'utf8');
		expect(runtime).toContain('this.project(notices, result.projection)');
		expect(runtime).toContain('projection: null, notices: [], unreadCount: 0');
		expect(runtime).toContain('private priceHistoryActive = false');
		expect(runtime).toContain('this.evaluationContextCurrent(generation, accountRef, priceHistoryActive)');
		expect(runtime).not.toContain('this.configure(this.settings, true)');
		const notice = readFileSync('src/halloween/halloween-price-alert.ts', 'utf8');
		expect(notice).not.toMatch(/quantity/u);
	});

	it('covers the seven UI axes and does not claim unverified contrast', () => {
		const panel = readFileSync('src/ui/halloween-alert-panel.ts', 'utf8');
		const styles = readFileSync('styles.css', 'utf8');
		const locale = readFileSync('src/core/i18n-runtime-catalog.ts', 'utf8');
		// Tokens.
		expect(styles).toMatch(/var\(--(?:size|background|color|radius)-/u);
		// Components and every state.
		for (const state of ['notFinalized', 'ignored', 'collecting', 'noDeviation', 'deviation', 'insufficient_history']) {
			expect(panel + locale).toContain(state);
		}
		// Responsive 320/480/760 component behavior.
		for (const width of [320, 480, 760]) expect(styles).toContain(`@container (max-width: ${String(width)}px)`);
		expect(styles).not.toMatch(/@media \(max-width: (?:320|480)px\)[^{]*\{[^}]*tyrian-companion-halloween/su);
		expect(styles).toContain('.tyrian-inventory-advisor__recommendation-actions');
		// Accessibility and 44px targets.
		expect(panel).toContain("createEl('caption'");
		expect(panel).toContain("setAttr('scope', 'col')");
		expect(panel).toContain("setAttr('aria-live', 'polite')");
		expect(panel).toContain('heading.focus()');
		expect(styles).toContain('min-block-size: 44px');
		// Real content and feedback; assets are intentionally N/A.
		expect(panel).toContain('comparison.outcomes');
		expect(panel).toContain('halloween.unknownItem');
		expect(panel).toContain("state.status.startsWith('store_') ? 'alert' : 'status'");
		expect(panel + styles).not.toMatch(/contrast (?:passes|verified)|<img|background-image/iu);
		const settingsTab = readFileSync('src/ui/settings-tab.ts', 'utf8');
		expect(settingsTab.match(/this\.refreshForSettingsChange\(\)/gu)?.length).toBeGreaterThanOrEqual(4);
	});
});
