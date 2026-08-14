import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('settings migration wiring', () => {
	it('does not turn a load-time legacy migration into a save', () => {
		const source = readFileSync('src/main.ts', 'utf8');
		const method = source.slice(source.indexOf('private async loadSettings'), source.indexOf('private renderViews'));
		expect(method).toContain('migrateSettings(persisted, this.app.vault.configDir)');
		expect(method).toContain('shouldPersistSettingsOnLoad(persisted, this.settings)');
		expect(method.indexOf('shouldPersistSettingsOnLoad')).toBeLessThan(method.indexOf('this.saveData(this.settings)'));
	});

	it('routes explicit updates through the legacy-preserving merger', () => {
		const source = readFileSync('src/main.ts', 'utf8');
		const method = source.slice(source.indexOf('async updateSettings'), source.indexOf('private async loadSettings'));
		expect(method).toContain('mergeSettingsUpdate(this.settings, settings, this.app.vault.configDir)');
		expect(method).toContain('await this.saveData(this.settings)');
	});
});
