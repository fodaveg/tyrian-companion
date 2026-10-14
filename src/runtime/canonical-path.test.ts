import { describe, expect, it } from 'vitest';

import { renderLivePanelEmptyNote } from '../sessions/live-panel-note';
import { liveSessionSummaryRelativePath } from '../sessions/live-session-summary-note';
import { tyrianFamilyOf } from '../host/hebra/seed';
import { canonicalPathFor } from './canonical-path';

const REF = 'ab'.repeat(32);
const STARTED = '2026-10-08T15:30:00.000Z';
const summary = (): string => ['---', 'tyrian_summary_version: 3', `tyrian_summary_of: ${JSON.stringify(REF)}`, 'tyrian_summary_locale: "es"',
	`tyrian_summary_started_at: ${JSON.stringify(STARTED)}`, 'tags: ["gw2/session-summary"]', '---', '', '# Resumen'].join('\n');

describe('canonicalPathFor: live panel', () => {
	it('answers the one fixed path, and only for a note of its own kind', () => {
		expect(canonicalPathFor('Tyrian Companion', renderLivePanelEmptyNote('es'))).toEqual(['Live panel.md']);
		expect(canonicalPathFor('Tyrian Companion', '---\ntc_kind: gw2_live_panel_copy\n---\n')).toEqual([]);
	});
});

describe('canonicalPathFor: live-session summary', () => {
	it('answers the path its writer builds, from the frontmatter alone', () => {
		expect(canonicalPathFor('Tyrian Companion', summary())).toEqual([liveSessionSummaryRelativePath(STARTED, REF)]);
		expect(canonicalPathFor('Tyrian Companion', summary().replace(/\n/gu, '\r\n'))).toEqual([liveSessionSummaryRelativePath(STARTED, REF)]);
	});

	it('is not a session, nor a Tyrian family the seed would list as unadopted', () => {
		expect(tyrianFamilyOf(summary())).toBeNull();
		expect(summary()).not.toMatch(/^tc_/mu);
	});

	it('leaves out a summary with a broken or missing identity', () => {
		expect(canonicalPathFor('Tyrian Companion', summary().replace(REF, 'short'))).toEqual([]);
		expect(canonicalPathFor('Tyrian Companion', summary().replace(STARTED, 'not a date'))).toEqual([]);
		expect(canonicalPathFor('Tyrian Companion', summary().replace(/^tyrian_summary_of:.*\n/mu, ''))).toEqual([]);
		expect(canonicalPathFor('Tyrian Companion', summary().replace(`"${REF}"`, REF))).toEqual([]);
		expect(canonicalPathFor('Tyrian Companion', `# Not frontmatter\n\ntyrian_summary_of: "${REF}"`)).toEqual([]);
		expect(canonicalPathFor('Tyrian Companion', '---\ntyrian_summary_of: "x"\n')).toEqual([]);
	});
});
